/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 */

// Minimal, dependency-free, synchronous SHA-256 (FIPS 180-4).
// ES5 only: no crypto.subtle, no Promises, no build step. Safe for
// webOS 3.0 / Chromium 38.
//
// API: sha256Hex(input) where input is an ArrayBuffer, Uint8Array or string
// (strings are UTF-8 encoded first). Returns a lowercase 64-char hex string.
var sha256Hex = (function () {
    'use strict';

    // First 32 bits of the fractional parts of the cube roots of the first
    // 64 primes (FIPS 180-4 section 4.2.2).
    var K = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
        0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
        0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
        0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
        0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
        0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
        0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];

    // Initial hash values: first 32 bits of the fractional parts of the
    // square roots of the first 8 primes (FIPS 180-4 section 5.3.3).
    var H0 = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ];

    function rotr(x, n) {
        return (x >>> n) | (x << (32 - n));
    }

    // Normalizes an ArrayBuffer / Uint8Array / string into a Uint8Array.
    function toBytes(input) {
        var i, len, bytes, out;

        if (typeof input === 'string') {
            out = [];
            for (i = 0; i < input.length; i++) {
                var c = input.charCodeAt(i);
                if (c < 0x80) {
                    out.push(c);
                } else if (c < 0x800) {
                    out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
                } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < input.length) {
                    var c2 = input.charCodeAt(i + 1);
                    if (c2 >= 0xdc00 && c2 <= 0xdfff) {
                        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
                        out.push(
                            0xf0 | (cp >> 18),
                            0x80 | ((cp >> 12) & 0x3f),
                            0x80 | ((cp >> 6) & 0x3f),
                            0x80 | (cp & 0x3f)
                        );
                        i++;
                    } else {
                        // Unpaired high surrogate: emit U+FFFD.
                        out.push(0xef, 0xbf, 0xbd);
                    }
                } else if (c >= 0xd800 && c <= 0xdfff) {
                    // Lone surrogate: emit U+FFFD.
                    out.push(0xef, 0xbf, 0xbd);
                } else {
                    out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
                }
            }
            len = out.length;
            bytes = new Uint8Array(len);
            for (i = 0; i < len; i++) {
                bytes[i] = out[i];
            }
            return bytes;
        }

        if (input instanceof Uint8Array) {
            return input;
        }

        if (input && typeof input.byteLength === 'number') {
            return new Uint8Array(input);
        }

        throw new TypeError('sha256Hex: input must be an ArrayBuffer, Uint8Array or string');
    }

    function hash(bytes) {
        var len = bytes.length;

        // Pre-processing: append 0x80, then zero-pad until the message length
        // is 56 mod 64, then append the 64-bit big-endian bit length.
        var padded = ((len + 9 + 63) >> 6) << 6;
        var msg = new Uint8Array(padded);
        msg.set(bytes);
        msg[len] = 0x80;

        var bitLen = len * 8;
        var hi = Math.floor(bitLen / 0x100000000);
        var lo = bitLen >>> 0;
        msg[padded - 8] = (hi >>> 24) & 0xff;
        msg[padded - 7] = (hi >>> 16) & 0xff;
        msg[padded - 6] = (hi >>> 8) & 0xff;
        msg[padded - 5] = hi & 0xff;
        msg[padded - 4] = (lo >>> 24) & 0xff;
        msg[padded - 3] = (lo >>> 16) & 0xff;
        msg[padded - 2] = (lo >>> 8) & 0xff;
        msg[padded - 1] = lo & 0xff;

        var H = H0.slice(0);
        var w = new Array(64);
        var i, off;

        for (off = 0; off < padded; off += 64) {
            for (i = 0; i < 16; i++) {
                w[i] = (
                    (msg[off + i * 4] << 24) |
                    (msg[off + i * 4 + 1] << 16) |
                    (msg[off + i * 4 + 2] << 8) |
                    msg[off + i * 4 + 3]
                ) >>> 0;
            }
            for (i = 16; i < 64; i++) {
                var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
                var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
                w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
            }

            var a = H[0], b = H[1], c = H[2], d = H[3];
            var e = H[4], f = H[5], g = H[6], h = H[7];

            for (i = 0; i < 64; i++) {
                var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
                var ch = (e & f) ^ ((~e) & g);
                var temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
                var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
                var maj = (a & b) ^ (a & c) ^ (b & c);
                var temp2 = (S0 + maj) >>> 0;

                h = g;
                g = f;
                f = e;
                e = (d + temp1) >>> 0;
                d = c;
                c = b;
                b = a;
                a = (temp1 + temp2) >>> 0;
            }

            H[0] = (H[0] + a) >>> 0;
            H[1] = (H[1] + b) >>> 0;
            H[2] = (H[2] + c) >>> 0;
            H[3] = (H[3] + d) >>> 0;
            H[4] = (H[4] + e) >>> 0;
            H[5] = (H[5] + f) >>> 0;
            H[6] = (H[6] + g) >>> 0;
            H[7] = (H[7] + h) >>> 0;
        }

        var hex = '';
        for (i = 0; i < 8; i++) {
            hex += ('00000000' + H[i].toString(16)).slice(-8);
        }
        return hex;
    }

    return function sha256Hex(input) {
        return hash(toBytes(input));
    };
})();

// CommonJS export so the digest can be exercised by Node-based tests.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = sha256Hex;
}
