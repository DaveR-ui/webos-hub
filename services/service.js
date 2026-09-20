/*
 * WebOS Hub - bundled webOS JS service.
 *
 * SECURITY MODEL - restricted proxy, not an open one.
 *
 * Any app on the TV can call the Luna method `http`, so the service validates
 * every request target against a hard-coded allow-list before issuing it from
 * Node's http/https modules:
 *
 *   - ALLOWED_ORIGINS       only these scheme://host[:port] origins are reachable.
 *   - ALLOWED_PATH_PREFIXES only these path prefixes are reachable.
 *   - loopback / link-local / unspecified hostnames (localhost, 127.*, ::1,
 *     0.0.0.0, 169.254.*) are always rejected, so the TV's own local services
 *     can never be reached through this proxy.
 *   - responses are capped at MAX_BODY_BYTES.
 *
 * TLS validation is relaxed ONLY for allow-listed `https:` origins (Sunshine
 * uses a self-signed certificate). There is deliberately NO caller-controlled
 * `insecure` flag, so no caller can disable certificate validation for an
 * arbitrary host.
 *
 * To point the app at a different Sunshine host, edit ALLOWED_ORIGINS below and
 * rebuild.
 *
 * Luna call (from the webview):
 *   webOS.service.request('luna://com.admin.weboshub.service', {
 *     method: 'http',
 *     parameters: { url, method, headers, body },
 *     onSuccess, onFailure
 *   })
 * Response payload: { returnValue, status, headers, body }
 */
/* eslint-disable no-var */
var pkgInfo = require('./package.json');
var Service = require('webos-service');
var http = require('http');
var https = require('https');
var urlParse = require('url').parse;

var service = new Service(pkgInfo.name);

var DEFAULT_TIMEOUT_MS = 15000;
var MAX_BODY_BYTES = 5 * 1024 * 1024;

/* The only origin this proxy may reach (the Sunshine host). Edit + rebuild to
 * target a different host. */
var ALLOWED_ORIGINS = ['https://192.168.0.205:47990'];
/* The only path prefixes this proxy may reach. */
var ALLOWED_PATH_PREFIXES = ['/api/'];

/* Default ports for origin comparison. */
function normalizedPort(protocol, port) {
	if (port) {
		return String(port);
	}
	if (protocol === 'https:') {
		return '443';
	}
	if (protocol === 'http:') {
		return '80';
	}
	return '';
}

/* Normalizes scheme://host[:port], filling in the protocol default port. */
function normalizeOrigin(protocol, hostname, port) {
	var proto = String(protocol || '').toLowerCase();
	var host = String(hostname || '').toLowerCase();
	var p = normalizedPort(proto, port);
	return proto + '//' + host + (p ? ':' + p : '');
}

var ALLOWED_ORIGINS_NORMALIZED = ALLOWED_ORIGINS.map(function (origin) {
	var p = urlParse(origin);
	if (!p || !p.protocol || !p.hostname) {
		return '';
	}
	return normalizeOrigin(p.protocol, p.hostname, p.port);
});

/* Loopback / link-local / unspecified hosts are never reachable. */
function isBlockedHostname(hostname) {
	var host = String(hostname || '').toLowerCase();
	if (!host) {
		return true;
	}
	/* url.parse() keeps the brackets on IPv6 literals. */
	if (host === '[::1]' || host === '::1') {
		return true;
	}
	if (host === 'localhost' || host === '0.0.0.0') {
		return true;
	}
	if (host.indexOf('127.') === 0) {
		return true;
	}
	if (host.indexOf('169.254.') === 0) {
		return true;
	}
	return false;
}

/*
 * Validates a parsed URL against the allow-list.
 * Returns { allowed: true, origin, path } or { allowed: false, reason }.
 */
function validateTarget(parsed) {
	var origin = normalizeOrigin(parsed.protocol, parsed.hostname, parsed.port);
	if (ALLOWED_ORIGINS_NORMALIZED.indexOf(origin) === -1) {
		return { allowed: false, reason: 'origin not allowed: ' + origin };
	}
	if (isBlockedHostname(parsed.hostname)) {
		return { allowed: false, reason: 'host not allowed (loopback/link-local/unspecified): ' + String(parsed.hostname) };
	}
	var targetPath = parsed.path || '/';
	for (var i = 0; i < ALLOWED_PATH_PREFIXES.length; i++) {
		if (targetPath.indexOf(ALLOWED_PATH_PREFIXES[i]) === 0) {
			return { allowed: true, origin: origin, path: targetPath };
		}
	}
	return { allowed: false, reason: 'path not allowed: ' + targetPath };
}

function respondError(message, errorText, errorCode) {
	message.respond({
		returnValue: false,
		errorText: errorText,
		errorCode: errorCode
	});
}

function doRequest(payload, callback) {
	var target = payload.url;
	var parsed = urlParse(target);
	if (!parsed || !parsed.protocol || !parsed.hostname) {
		callback(new Error('invalid url: ' + target));
		return;
	}

	var validation = validateTarget(parsed);
	if (!validation.allowed) {
		var rejection = new Error(validation.reason);
		/* errorCode 3 marks an allow-list violation (see the `http` handler). */
		rejection.errorCode = 3;
		callback(rejection);
		return;
	}

	var isHttps = (parsed.protocol === 'https:');
	var transport = isHttps ? https : http;

	var options = {
		protocol: parsed.protocol,
		hostname: parsed.hostname,
		port: parsed.port || (isHttps ? 443 : 80),
		path: parsed.path || '/',
		method: (payload.method || 'GET').toUpperCase(),
		headers: payload.headers || {},
		/*
		 * TLS validation is relaxed ONLY for allow-listed https: origins
		 * (Sunshine's self-signed certificate). It is keyed off the validated
		 * origin - never off caller input - so a caller cannot disable
		 * certificate validation for an arbitrary host.
		 */
		rejectUnauthorized: isHttps ? false : true
	};

	var settled = false;
	function finish(err, result) {
		if (settled) {
			return;
		}
		settled = true;
		if (err) {
			callback(err);
		} else {
			callback(null, result);
		}
	}

	var req = transport.request(options, function (res) {
		var chunks = [];
		var bytes = 0;
		var exceeded = false;
		res.on('data', function (chunk) {
			if (exceeded) {
				return;
			}
			bytes += chunk.length;
			if (bytes > MAX_BODY_BYTES) {
				exceeded = true;
				req.destroy(new Error('response body exceeded ' + MAX_BODY_BYTES + ' bytes'));
				return;
			}
			chunks.push(chunk);
		});
		res.on('end', function () {
			finish(null, {
				status: res.statusCode,
				headers: res.headers,
				body: Buffer.concat(chunks).toString('utf8')
			});
		});
		res.on('error', function (err) {
			finish(err);
		});
	});

	req.setTimeout(DEFAULT_TIMEOUT_MS, function () {
		req.destroy(new Error('request timed out after ' + DEFAULT_TIMEOUT_MS + 'ms'));
	});

	req.on('error', function (err) {
		finish(err);
	});

	if (payload.body) {
		req.write(payload.body);
	}
	req.end();
}

service.register('http', function (message) {
	var payload = message.payload || {};

	if (!payload.url) {
		respondError(message, "argument 'url' is required", 1);
		return;
	}

	doRequest(payload, function (err, result) {
		if (err) {
			if (err.errorCode === 3) {
				/* Allow-list violation: surface the precise reason. */
				respondError(message, err.message || String(err), 3);
				return;
			}
			respondError(message, 'request failed: ' + (err.message || String(err)), 2);
			return;
		}
		message.respond({
			returnValue: true,
			status: result.status,
			headers: result.headers,
			body: result.body
		});
	});
});
