/*
 * WebOS Hub - app launcher wrapper.
 *
 * Launches installed webOS apps through
 *   luna://com.webos.service.applicationmanager -> method `launch`
 *
 * Deep-link capability of the two target apps (researched, see README):
 *   - org.jellyfin.webos  : NO deep-link support. Always lands on its home.
 *   - com.limelight.webos : supports launch params {"host_uuid","host_app_id"}.
 *
 * The wire keys are `host_uuid` / `host_app_id` (parsed from argv[1] as JSON in
 * moonlight-tv src/app/platform/webos/app_webos.c), NOT the internal C struct
 * field names `default_host_uuid` / `default_app_id`.
 */
(function (global) {
	'use strict';

	var APP_MANAGER_URI = 'luna://com.webos.service.applicationmanager';
	var JELLYFIN_APP_ID = 'org.jellyfin.webos';
	var MOONLIGHT_APP_ID = 'com.limelight.webos';

	function hasWebOS() {
		return !!(global.webOS && global.webOS.service &&
			typeof global.webOS.service.request === 'function');
	}

	function hasKeys(obj) {
		if (!obj) {
			return false;
		}
		for (var key in obj) {
			if (Object.prototype.hasOwnProperty.call(obj, key)) {
				return true;
			}
		}
		return false;
	}

	/*
	 * launchApp(id, params) -> Promise
	 * params is added to the Luna payload only when non-empty, so apps without
	 * deep-link support receive a clean launch request.
	 */
	function launchApp(id, params) {
		return new Promise(function (resolve, reject) {
			var payload = { id: id };
			if (hasKeys(params)) {
				payload.params = params;
			}

			if (!hasWebOS()) {
				console.log('[launcher] webOS global missing (desktop dev?). Would launch:', id, JSON.stringify(payload.params || {}));
				resolve({ launched: false, reason: 'no-webos', id: id, params: payload.params || {} });
				return;
			}

			global.webOS.service.request(APP_MANAGER_URI, {
				method: 'launch',
				parameters: payload,
				onSuccess: function (res) {
					resolve(res || { launched: true, id: id });
				},
				onFailure: function (err) {
					reject(new Error('launch failed for ' + id + ': ' +
						(err && (err.errorText || err.message) ? (err.errorText || err.message) : JSON.stringify(err))));
				}
			});
		});
	}

	/*
	 * Jellyfin has no launch-parameter handling, so we intentionally send no
	 * params. Item-level deep-linking is not possible (see README).
	 */
	function openJellyfin() {
		return launchApp(JELLYFIN_APP_ID, {});
	}

	/*
	 * openMoonlight({hostUuid, appId})
	 * Sends {host_uuid, host_app_id} only when both are known; otherwise launches
	 * Moonlight plain so the user can pick the host/app inside the app.
	 */
	function openMoonlight(opts) {
		opts = opts || {};
		var params = {};
		if (opts.hostUuid && opts.appId != null && opts.appId !== '') {
			params.host_uuid = String(opts.hostUuid);
			params.host_app_id = Number(opts.appId);
		}
		return launchApp(MOONLIGHT_APP_ID, params);
	}

	global.HubLauncher = {
		APP_MANAGER_URI: APP_MANAGER_URI,
		JELLYFIN_APP_ID: JELLYFIN_APP_ID,
		MOONLIGHT_APP_ID: MOONLIGHT_APP_ID,
		hasWebOS: hasWebOS,
		launchApp: launchApp,
		openJellyfin: openJellyfin,
		openMoonlight: openMoonlight
	};
})(window);
