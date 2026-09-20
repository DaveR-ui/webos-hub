/*
 * WebOS Hub - Jellyfin REST client.
 *
 * Plain functions on top of fetch(), no framework. The device id mimics the
 * jellyfin-web convention (a base64 blob of userAgent + timestamp) and is
 * persisted so the server sees a stable device.
 *
 * Auth flow (verified against Jellyfin 10.11.11):
 *   POST /Users/AuthenticateByName
 *     X-Emby-Authorization: MediaBrowser Client=..., Device=..., DeviceId=..., Version=...
 *     body {"Username": "...", "Pw": "..."}
 *   -> { AccessToken, User: { Id }, ... }
 *
 * Subsequent calls use:
 *   Authorization: MediaBrowser Token="<token>", Client=..., Device=..., DeviceId=..., Version=...
 */
(function (global) {
	'use strict';

	var CLIENT_NAME = 'WebOS Hub';
	var DEVICE_NAME = 'webOS TV';
	var APP_VERSION = '1.0.0';
	var DEVICE_ID_KEY = 'webosHub.deviceId.v1';

	function safeGetItem(key) {
		try {
			return global.localStorage ? global.localStorage.getItem(key) : null;
		} catch (e) {
			return null;
		}
	}

	function safeSetItem(key, value) {
		try {
			if (global.localStorage) {
				global.localStorage.setItem(key, value);
			}
		} catch (e) { /* storage may be unavailable */ }
	}

	function base64(value) {
		try {
			return global.btoa(value);
		} catch (e) {
			var ascii = '';
			for (var i = 0; i < value.length; i++) {
				ascii += String.fromCharCode(value.charCodeAt(i) & 0xff);
			}
			return global.btoa(ascii);
		}
	}

	/* Stable per-install device id, created once and persisted. */
	function getDeviceId() {
		var id = safeGetItem(DEVICE_ID_KEY);
		if (!id) {
			id = base64([global.navigator ? global.navigator.userAgent : 'webos', Date.now()].join('|'));
			safeSetItem(DEVICE_ID_KEY, id);
		}
		return id;
	}

	function authHeader(token) {
		var parts = [];
		if (token) {
			parts.push('Token="' + token + '"');
		}
		parts.push('Client="' + CLIENT_NAME + '"');
		parts.push('Device="' + DEVICE_NAME + '"');
		parts.push('DeviceId="' + getDeviceId() + '"');
		parts.push('Version="' + APP_VERSION + '"');
		return 'MediaBrowser ' + parts.join(', ');
	}

	function normalizeBase(baseUrl) {
		return String(baseUrl || '').replace(/\/+$/, '');
	}

	function joinUrl(baseUrl, path, query) {
		var url = normalizeBase(baseUrl) + path;
		if (query) {
			var parts = [];
			for (var key in query) {
				if (Object.prototype.hasOwnProperty.call(query, key) && query[key] != null && query[key] !== '') {
					parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(query[key]));
				}
			}
			if (parts.length) {
				url += (url.indexOf('?') === -1 ? '?' : '&') + parts.join('&');
			}
		}
		return url;
	}

	function parseJson(response) {
		return response.text().then(function (text) {
			if (!response.ok) {
				var detail = '';
				try {
					var parsed = JSON.parse(text);
					detail = parsed && (parsed.Message || parsed.message || parsed.error) ? (parsed.Message || parsed.message || parsed.error) : '';
				} catch (e) { /* body was not JSON */ }
				throw new Error('Jellyfin HTTP ' + response.status + ' ' + response.statusText + (detail ? (' - ' + detail) : ''));
			}
			try {
				return JSON.parse(text || '{}');
			} catch (e) {
				throw new Error('Jellyfin returned invalid JSON');
			}
		});
	}

	function fetchJson(url, opts) {
		if (typeof global.fetch !== 'function') {
			return Promise.reject(new Error('fetch is not available in this runtime'));
		}
		return global.fetch(url, opts).then(parseJson);
	}

	/*
	 * authenticate(baseUrl, user, pass) -> Promise<{token, userId, serverName}>
	 */
	function authenticate(baseUrl, username, password) {
		var url = joinUrl(baseUrl, '/Users/AuthenticateByName');
		return fetchJson(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Emby-Authorization': authHeader(null)
			},
			body: JSON.stringify({ Username: username, Pw: password })
		}).then(function (data) {
			if (!data || !data.AccessToken || !data.User || !data.User.Id) {
				throw new Error('Jellyfin auth response missing AccessToken/User.Id');
			}
			return {
				token: data.AccessToken,
				userId: data.User.Id,
				serverName: data.ServerName || null
			};
		});
	}

	/* Public server information, no auth required. */
	function getPublicInfo(baseUrl) {
		return fetchJson(joinUrl(baseUrl, '/System/Info/Public'), { method: 'GET' });
	}

	/*
	 * getViews(baseUrl, token, userId) -> Promise<Array<view>>
	 */
	function getViews(baseUrl, token, userId) {
		var url = joinUrl(baseUrl, '/Users/' + encodeURIComponent(userId) + '/Views');
		return fetchJson(url, {
			method: 'GET',
			headers: { 'Authorization': authHeader(token) }
		}).then(function (data) {
			return (data && data.Items) ? data.Items : [];
		});
	}

	/*
	 * getItems(baseUrl, token, userId, options)
	 * options: { libraryId, types, limit, startIndex, sortBy }
	 */
	function getItems(baseUrl, token, userId, opts) {
		opts = opts || {};
		var query = {
			Recursive: 'true',
			IncludeItemTypes: opts.types || 'Movie',
			Limit: (opts.limit == null) ? 60 : opts.limit,
			StartIndex: (opts.startIndex == null) ? 0 : opts.startIndex,
			SortBy: opts.sortBy || 'SortName',
			Fields: 'PrimaryImageAspectRatio,ImageTags'
		};
		if (opts.libraryId) {
			query.ParentId = opts.libraryId;
		}
		var url = joinUrl(baseUrl, '/Users/' + encodeURIComponent(userId) + '/Items', query);
		return fetchJson(url, {
			method: 'GET',
			headers: { 'Authorization': authHeader(token) }
		}).then(function (data) {
			return {
				items: (data && data.Items) ? data.Items : [],
				total: (data && data.TotalRecordCount) ? data.TotalRecordCount : 0
			};
		});
	}

	/*
	 * getResume(baseUrl, token, userId) -> Promise<{items, total}>
	 * Returns an empty list when the server has no in-progress items.
	 */
	function getResume(baseUrl, token, userId, limit) {
		var url = joinUrl(baseUrl, '/Users/' + encodeURIComponent(userId) + '/Items/Resume', {
			Limit: (limit == null) ? 6 : limit,
			Fields: 'PrimaryImageAspectRatio,ImageTags'
		});
		return fetchJson(url, {
			method: 'GET',
			headers: { 'Authorization': authHeader(token) }
		}).then(function (data) {
			return {
				items: (data && data.Items) ? data.Items : [],
				total: (data && data.TotalRecordCount) ? data.TotalRecordCount : 0
			};
		});
	}

	/*
	 * imageUrl(baseUrl, itemId, { maxHeight, tag }) -> string
	 * The `tag` avoids stale image caching. Jellyfin serves primary images
	 * without authentication, so no token is embedded in the URL.
	 */
	function imageUrl(baseUrl, itemId, opts) {
		opts = opts || {};
		var query = { maxHeight: opts.maxHeight || 450 };
		if (opts.tag) {
			query.tag = opts.tag;
		}
		return joinUrl(baseUrl, '/Items/' + encodeURIComponent(itemId) + '/Images/Primary', query);
	}

	/* Extracts the primary image tag from an item, if present. */
	function primaryImageTag(item) {
		if (!item) {
			return null;
		}
		if (item.ImageTags && item.ImageTags.Primary) {
			return item.ImageTags.Primary;
		}
		if (typeof item.PrimaryImageTag === 'string') {
			return item.PrimaryImageTag;
		}
		return null;
	}

	global.HubJellyfin = {
		authenticate: authenticate,
		getPublicInfo: getPublicInfo,
		getViews: getViews,
		getItems: getItems,
		getResume: getResume,
		imageUrl: imageUrl,
		primaryImageTag: primaryImageTag,
		getDeviceId: getDeviceId,
		joinUrl: joinUrl
	};
})(window);
