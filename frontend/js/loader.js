/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 */

// Thin ES5 boot shell for MiChelly.
//
// On launch it fetches a remote bundle manifest, verifies every file against
// its declared size and SHA-256 digest, and only then activates the verified
// bytes. On any failure it falls back to the packaged local copies. This lets
// code/UI updates ship without reinstalling the IPK.
//
// ES5 only (webOS 3.0 / Chromium 38): XMLHttpRequest, no Promises, no fetch.

// Adds .includes to Array for webOS 3.0 / Chromium < 47
// (Array.prototype.includes is Chrome 47+). Copied from frontend/js/index.js
// so that webOSTV.js and the remote platform.js may rely on it during boot.
if (!Array.prototype.includes) {
    Array.prototype.includes = function (search, start) {
        'use strict';
        if (start === undefined) { start = 0; }
        return this.indexOf(search, start) !== -1;
    };
}

// Adds .includes to String for webOS 3.0 / Chromium < 47.
// Copied from frontend/js/index.js.
if (!String.prototype.includes) {
    String.prototype.includes = function (search, start) {
        'use strict';

        if (search instanceof RegExp) {
            throw TypeError('first argument must not be a RegExp');
        }
        if (start === undefined) { start = 0; }
        return this.indexOf(search, start) !== -1;
    };
}

(function () {
    'use strict';

    var BUNDLE_BASE_URL = 'https://daver-ui.github.io/webos-hub/app/';

    // Canonical injection order, which is also the packaged fallback order.
    var CANONICAL_PATHS = [
        'js/app/platform.js',
        'js/app/api.js',
        'js/app/auth.js',
        'js/app/ui.js',
        'js/app/catalog.js',
        'js/app/player.js',
        'js/app/audio.js',
        'js/index.js',
        'css/app.css'
    ];

    var MANIFEST_TIMEOUT = 5000;
    var FILE_TIMEOUT = 8000;
    var MAX_FILES = 32;
    var MAX_TOTAL_BYTES = 4 * 1024 * 1024;
    var SKIP_KEY = 'michelly_remote_skip';
    var CSS_STYLE_ID = 'michellyRemoteCss';
    var CHUNK_SIZE = 8192;

    var HEX16_RE = /^[0-9a-f]{16}$/;
    var HEX64_RE = /^[0-9a-f]{64}$/;
    var PATH_RE = /^[A-Za-z0-9_./-]+\.(js|css)$/;

    var guardActive = false;
    var fallbackStarted = false;
    var reloadRequested = false;
    // Set as soon as any remote JS has been executed. Once that happens the
    // packaged scripts must never be injected on top of the remote generation.
    var remoteActivated = false;
    var previousOnError = window.onerror;

    function log(message) {
        if (window.console && window.console.log) {
            window.console.log(message);
        }
    }

    function warn(message) {
        if (window.console && window.console.warn) {
            window.console.warn(message);
        } else {
            log(message);
        }
    }

    // --- validation -------------------------------------------------------

    function validPath(path) {
        var i, parts;
        if (typeof path !== 'string' || !PATH_RE.test(path)) {
            return false;
        }
        if (path.charAt(0) === '/') {
            return false;
        }
        if (path.indexOf('://') !== -1) {
            return false;
        }
        parts = path.split('/');
        for (i = 0; i < parts.length; i++) {
            if (parts[i] === '..') {
                return false;
            }
        }
        return true;
    }

    function isPositiveInteger(value) {
        return typeof value === 'number' &&
            isFinite(value) &&
            value > 0 &&
            Math.floor(value) === value;
    }

    // Returns a normalized { bundleVersion, files } or null when invalid.
    // The file list must match CANONICAL_PATHS exactly (same length, same
    // paths, same order, no duplicates) so a compromised manifest cannot
    // reorder, truncate or append entries.
    function validateManifest(manifest) {
        var i, file, files, normalized, seen, totalBytes, expectedType;

        if (!manifest || typeof manifest !== 'object') {
            return null;
        }
        if (manifest.schema !== 1) {
            return null;
        }
        if (typeof manifest.bundleVersion !== 'string' || !HEX16_RE.test(manifest.bundleVersion)) {
            return null;
        }
        if (!Array.isArray(manifest.files)) {
            return null;
        }
        if (manifest.files.length === 0 || manifest.files.length > MAX_FILES) {
            return null;
        }

        files = [];
        seen = {};
        totalBytes = 0;
        for (i = 0; i < manifest.files.length; i++) {
            file = manifest.files[i];
            if (!file || typeof file !== 'object') {
                return null;
            }
            if (!validPath(file.path)) {
                return null;
            }
            if (file.type !== 'js' && file.type !== 'css') {
                return null;
            }
            if (typeof file.sha256 !== 'string' || !HEX64_RE.test(file.sha256)) {
                return null;
            }
            if (!isPositiveInteger(file.size)) {
                return null;
            }
            if (Object.prototype.hasOwnProperty.call(seen, file.path)) {
                return null;
            }
            seen[file.path] = true;
            totalBytes += file.size;
            if (totalBytes > MAX_TOTAL_BYTES) {
                return null;
            }
            files.push({
                path: file.path,
                type: file.type,
                size: file.size,
                sha256: file.sha256
            });
        }

        // Exact canonical match: count, paths, order and js/css placement.
        if (files.length !== CANONICAL_PATHS.length) {
            return null;
        }
        for (i = 0; i < CANONICAL_PATHS.length; i++) {
            if (files[i].path !== CANONICAL_PATHS[i]) {
                return null;
            }
            expectedType = /\.css$/.test(CANONICAL_PATHS[i]) ? 'css' : 'js';
            if (files[i].type !== expectedType) {
                return null;
            }
        }

        normalized = {
            bundleVersion: manifest.bundleVersion,
            files: files
        };
        return normalized;
    }

    // --- transport --------------------------------------------------------

    function fetchText(url, timeout, onDone, onFail) {
        var xhr = new XMLHttpRequest();
        var settled = false;

        function fail(reason) {
            if (settled) { return; }
            settled = true;
            onFail(reason);
        }

        xhr.open('GET', url, true);
        xhr.timeout = timeout;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) { return; }
            if (settled) { return; }
            if (xhr.status === 200 && typeof xhr.responseText === 'string') {
                settled = true;
                onDone(xhr.responseText);
            } else {
                fail('http ' + xhr.status + ' for ' + url);
            }
        };
        xhr.ontimeout = function () { fail('timeout for ' + url); };
        xhr.onerror = function () { fail('network error for ' + url); };
        try {
            xhr.send();
        } catch (e) {
            fail('send failed for ' + url);
        }
    }

    function fetchBinary(url, timeout, onDone, onFail) {
        var xhr = new XMLHttpRequest();
        var settled = false;

        function fail(reason) {
            if (settled) { return; }
            settled = true;
            onFail(reason);
        }

        xhr.open('GET', url, true);
        xhr.responseType = 'arraybuffer';
        xhr.timeout = timeout;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) { return; }
            if (settled) { return; }
            if (xhr.status === 200 && xhr.response) {
                settled = true;
                onDone(xhr.response);
            } else {
                fail('http ' + xhr.status + ' for ' + url);
            }
        };
        xhr.ontimeout = function () { fail('timeout for ' + url); };
        xhr.onerror = function () { fail('network error for ' + url); };
        try {
            xhr.send();
        } catch (e) {
            fail('send failed for ' + url);
        }
    }

    // --- decoding ---------------------------------------------------------

    function decodeBytes(buffer) {
        var bytes, out, i, chunk;

        if (typeof window.TextDecoder === 'function') {
            try {
                return new window.TextDecoder('utf-8').decode(new Uint8Array(buffer));
            } catch (e) {
                // Fall through to the manual decoder below.
            }
        }

        // String.fromCharCode is Latin-1, not UTF-8. The verified payload is
        // UTF-8, so without TextDecoder only ASCII can be reproduced exactly;
        // refuse anything else rather than activating mojibake that would
        // still pass the hash check.
        bytes = new Uint8Array(buffer);
        for (i = 0; i < bytes.length; i++) {
            if (bytes[i] > 0x7f) {
                throw new Error('decodeBytes: non-ASCII byte without TextDecoder');
            }
        }

        out = '';
        for (i = 0; i < bytes.length; i += CHUNK_SIZE) {
            chunk = bytes.subarray(i, i + CHUNK_SIZE);
            out += String.fromCharCode.apply(null, chunk);
        }
        return out;
    }

    // --- remote verification ---------------------------------------------

    // Fetches every file sequentially, verifying byte length and SHA-256
    // before accepting it. Callbacks fire exactly once.
    function verifyAll(bundleVersion, files, onSuccess, onFailure) {
        var collected = [];

        function step(index) {
            var file, url;

            if (index >= files.length) {
                onSuccess(collected);
                return;
            }

            file = files[index];
            url = BUNDLE_BASE_URL + file.path + '?v=' + bundleVersion;

            fetchBinary(url, FILE_TIMEOUT, function (buffer) {
                var digest, text;

                if (buffer.byteLength !== file.size) {
                    onFailure('size mismatch for ' + file.path);
                    return;
                }

                try {
                    digest = sha256Hex(buffer);
                } catch (e) {
                    onFailure('hash error for ' + file.path);
                    return;
                }

                if (digest !== file.sha256) {
                    onFailure('sha256 mismatch for ' + file.path);
                    return;
                }

                try {
                    text = decodeBytes(buffer);
                } catch (e2) {
                    onFailure('decode error for ' + file.path);
                    return;
                }

                collected.push({ path: file.path, type: file.type, text: text });
                step(index + 1);
            }, function (reason) {
                onFailure(reason);
            });
        }

        step(0);
    }

    // --- activation -------------------------------------------------------

    function injectInlineScript(text) {
        var script = document.createElement('script');
        script.textContent = text;
        document.head.appendChild(script);
    }

    function activateRemote(bundleVersion, entries) {
        var i, cssText = null, style, packagedCss;

        // JS entries first, in canonical order (validateManifest guarantees
        // the order). The verified bytes are exactly what executes, so inline
        // textContent is used deliberately.
        for (i = 0; i < entries.length; i++) {
            if (entries[i].type === 'js') {
                remoteActivated = true;
                injectInlineScript(entries[i].text);
            }
        }

        for (i = 0; i < entries.length; i++) {
            if (entries[i].type === 'css') {
                cssText = entries[i].text;
                break;
            }
        }
        if (cssText !== null) {
            style = document.createElement('style');
            style.id = CSS_STYLE_ID;
            style.textContent = cssText;
            document.head.appendChild(style);
        }

        packagedCss = document.getElementById('appCss');
        if (packagedCss) {
            packagedCss.disabled = true;
        }

        window.MichellyShell.bundleSource = 'remote';
        window.MichellyShell.bundleVersion = bundleVersion;

        try {
            if (window.storage && window.storage.set) {
                window.storage.set('michelly_bundle_version', bundleVersion, false);
            }
        } catch (e) {
            // Persisting is best-effort; a failure must not abort the boot.
        }

        log('[michelly-shell] bundle remote ' + bundleVersion + ' active');
    }

    // Injects the packaged JS copies sequentially, chaining on both load and
    // error so that a single missing file cannot hang the boot. The packaged
    // stylesheet is already linked as #appCss and stays enabled.
    function injectPackaged(onComplete) {
        var queue = [];
        var i;

        for (i = 0; i < CANONICAL_PATHS.length; i++) {
            if (/\.js$/.test(CANONICAL_PATHS[i])) {
                queue.push(CANONICAL_PATHS[i]);
            }
        }

        function next() {
            var path, script, advanced;

            if (queue.length === 0) {
                onComplete();
                return;
            }

            path = queue.shift();
            advanced = false;

            function advance() {
                if (advanced) { return; }
                advanced = true;
                next();
            }

            script = document.createElement('script');
            script.src = path;
            script.async = false;
            script.charset = 'utf-8';
            script.onload = advance;
            script.onerror = advance;
            document.head.appendChild(script);
        }

        next();
    }

    // --- boot orchestration ----------------------------------------------

    function clearSkipFlag() {
        try {
            window.sessionStorage.removeItem(SKIP_KEY);
        } catch (e) {
            // sessionStorage may be unavailable; ignore.
        }
    }

    function disarmGuard() {
        guardActive = false;
        if (window.onerror === bootGuard) {
            window.onerror = previousOnError;
        }
    }

    function finishBoot(source) {
        // A completed boot invalidates any pending remote rollback.
        disarmGuard();
        clearSkipFlag();
    }

    function rollbackAndReload(reason) {
        warn('[michelly-shell] remote boot failed, rolling back: ' + reason);
        if (reloadRequested) { return; }
        reloadRequested = true;
        guardActive = false;
        try {
            window.sessionStorage.setItem(SKIP_KEY, '1');
        } catch (e) {
            // Without sessionStorage the reload would loop, so skip it.
            return;
        }
        try {
            window.location.reload();
        } catch (e2) {
            // Ignore: nothing more we can do.
        }
    }

    function bootGuard(message) {
        if (!guardActive) {
            if (typeof previousOnError === 'function') {
                return previousOnError.apply(this, arguments);
            }
            return false;
        }
        guardActive = false;
        rollbackAndReload('window.onerror: ' + message);
        if (typeof previousOnError === 'function') {
            return previousOnError.apply(this, arguments);
        }
        return false;
    }

    function armGuard() {
        guardActive = true;
        window.onerror = bootGuard;
    }

    function afterLoad(source) {
        if (typeof window.Init === 'function') {
            try {
                window.Init();
            } catch (e) {
                if (source === 'remote') {
                    rollbackAndReload('Init() threw: ' + e);
                    return;
                }
                warn('[michelly-shell] Init() error: ' + e);
                finishBoot(source);
                return;
            }
            finishBoot(source);
            return;
        }

        if (source === 'remote') {
            rollbackAndReload('Init missing after remote activation');
            return;
        }
        warn('[michelly-shell] Init is not defined after packaged boot');
        finishBoot(source);
    }

    function bootPackaged(reason) {
        // Once remote code has executed, injecting packaged scripts on top of
        // it would mix generations. The only safe fallback is a clean reload
        // into a packaged boot.
        if (remoteActivated) {
            rollbackAndReload('packaged fallback after remote activation: ' + reason);
            return;
        }

        if (fallbackStarted) { return; }
        fallbackStarted = true;

        log('[michelly-shell] fallback: ' + reason);
        window.MichellyShell.bundleSource = 'packaged';

        injectPackaged(function () {
            afterLoad('packaged');
        });
    }

    function tryRemote() {
        var manifestUrl = BUNDLE_BASE_URL + 'manifest.json?v=' + Date.now();

        fetchText(manifestUrl, MANIFEST_TIMEOUT, function (text) {
            var manifest;

            try {
                manifest = validateManifest(JSON.parse(text));
            } catch (e) {
                bootPackaged('manifest JSON parse failed');
                return;
            }

            if (!manifest) {
                bootPackaged('manifest validation failed');
                return;
            }

            verifyAll(manifest.bundleVersion, manifest.files, function (entries) {
                try {
                    activateRemote(manifest.bundleVersion, entries);
                } catch (e2) {
                    bootPackaged('remote activation failed: ' + e2);
                    return;
                }
                afterLoad('remote');
            }, function (failureReason) {
                bootPackaged(failureReason);
            });
        }, function (reason) {
            bootPackaged(reason);
        });
    }

    function boot() {
        var skip = null;

        try {
            skip = window.sessionStorage.getItem(SKIP_KEY);
        } catch (e) {
            skip = null;
        }

        if (skip === '1') {
            clearSkipFlag();
            bootPackaged('sessionStorage skip flag set');
            return;
        }

        fallbackStarted = false;
        armGuard();
        tryRemote();
    }

    window.MichellyShell = {
        bundleSource: 'packaged',
        bundleVersion: null,
        boot: boot
    };

    boot();
})();
