/*
 * WebOS Hub - Sunshine client.
 *
 * CRITICAL: Sunshine is NOT CORS-enabled. It sends no Access-Control-Allow-Origin
 * header and its OPTIONS preflight fails, so a direct browser fetch() from this
 * app is blocked. Every request therefore goes through the bundled webOS Luna
 * service `com.admin.weboshub.service`, whose `http` method proxies the request
 * from Node and relaxes TLS validation for its allow-listed Sunshine origin
 * (Sunshine uses a self-signed certificate).
 *
 * If the webOS global is missing (desktop-browser development) we fall back to a
 * direct fetch. On Sunshine that fallback fails, and we surface an explicit
 * message telling the user the bundled service is required - we never silently
 * render nothing.
 */
(function (global) {
	'use strict';

	var SERVICE_URI = 'luna://com.admin.weboshub.service';
	var BUNDLED_SERVICE_HINT = 'Sunshine is not CORS-enabled. Direct browser fetch is blocked; ' +
		'the bundled webOS service (com.admin.weboshub.service) is required. ' +
		'On a TV this works automatically; in a desktop browser it cannot.';

	function hasWebOS() {
		return !!(global.webOS && global.webOS.service &&
			typeof global.webOS.service.request === 'function');
	}

	function normalizeBase(baseUrl) {
		return String(baseUrl || '').replace(/\/+$/, '');
	}

	function basicAuth(user, pass) {
		var raw = String(user == null ? '' : user) + ':' + String(pass == null ? '' : pass);
		try {
			return 'Basic ' + global.btoa(raw);
		} catch (e) {
			var ascii = '';
			for (var i = 0; i < raw.length; i++) {
				ascii += String.fromCharCode(raw.charCodeAt(i) & 0xff);
			}
			return 'Basic ' + global.btoa(ascii);
		}
	}

	function buildHeaders(settings) {
		return {
			'Authorization': basicAuth(settings.sunshineUser, settings.sunshinePass),
			'Accept': 'application/json'
		};
	}

	/*
	 * Proxies one request through the bundled Luna service.
	 * Returns Promise<{status, headers, body}>.
	 */
	function serviceRequest(url, method, headers, body) {
		return new Promise(function (resolve, reject) {
			if (!hasWebOS()) {
				reject(new Error('webOS Luna service bridge is not available'));
				return;
			}
			global.webOS.service.request(SERVICE_URI, {
				method: 'http',
				parameters: {
					url: url,
					method: method,
					headers: headers,
					body: body || null
					/*
					 * No `insecure` flag: the service relaxes TLS validation
					 * itself, keyed off its ALLOWED_ORIGINS allow-list.
					 */
				},
				onSuccess: function (res) {
					if (res && res.returnValue === false) {
						reject(new Error('bundled service error: ' + (res.errorText || 'unknown error')));
						return;
					}
					resolve({
						status: res.status,
						headers: res.headers || {},
						body: res.body || ''
					});
				},
				onFailure: function (err) {
					reject(new Error('bundled service unavailable: ' +
						(err && (err.errorText || err.message) ? (err.errorText || err.message) : JSON.stringify(err))));
				}
			});
		});
	}

	/* Desktop-browser fallback. Only works against CORS-permissive servers. */
	function directFetch(url, method, headers, body) {
		if (typeof global.fetch !== 'function') {
			return Promise.reject(new Error('fetch is not available in this runtime'));
		}
		return global.fetch(url, { method: method, headers: headers, body: body || undefined })
			.then(function (res) {
				return res.text().then(function (text) {
					return { status: res.status, headers: {}, body: text };
				});
			});
	}

	/*
	 * Fetches a Sunshine path and parses the JSON body.
	 * mode is 'service' whenever the webOS platform is present.
	 */
	function getJson(settings, path, label) {
		var url = normalizeBase(settings.sunshineUrl) + path;
		var headers = buildHeaders(settings);
		var usingService = hasWebOS();

		var promise = usingService
			? serviceRequest(url, 'GET', headers, null)
			: directFetch(url, 'GET', headers, null);

		return promise.then(function (res) {
			if (res.status < 200 || res.status >= 300) {
				throw new Error(label + ' -> HTTP ' + res.status);
			}
			try {
				return JSON.parse(res.body || '{}');
			} catch (e) {
				throw new Error(label + ' -> response was not valid JSON');
			}
		}).catch(function (err) {
			var message = (err && err.message) ? err.message : String(err);
			if (!usingService) {
				throw new Error(label + ' failed: ' + message + '. ' + BUNDLED_SERVICE_HINT);
			}
			throw new Error(label + ' failed: ' + message);
		});
	}

	/* getApps(settings) -> Promise<Array<{name, imagePath}>> */
	function getApps(settings) {
		return getJson(settings, '/api/apps', 'GET /api/apps').then(function (data) {
			var apps = (data && data.apps) ? data.apps : [];
			return apps.map(function (app) {
				return {
					name: app.name,
					imagePath: app['image-path'] || null,
					raw: app
				};
			});
		});
	}

	/* getConfig(settings) -> Promise<Object> */
	function getConfig(settings) {
		return getJson(settings, '/api/config', 'GET /api/config');
	}

	global.HubSunshine = {
		SERVICE_URI: SERVICE_URI,
		getApps: getApps,
		getConfig: getConfig,
		hasWebOS: hasWebOS,
		basicAuth: basicAuth
	};
})(window);
