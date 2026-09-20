/*
 * WebOS Hub - settings module.
 *
 * Persists every user setting in localStorage under a single key.
 * Credentials are NEVER hard-coded here: the repository must stay secret-free.
 * The default URLs point at the verified home-lab services but contain no
 * credentials, so they are safe to keep in source.
 */
(function (global) {
	'use strict';

	var STORAGE_KEY = 'webosHub.settings.v1';

	var DEFAULTS = {
		jellyfinUrl: 'http://192.168.0.205:8096',
		jellyfinUser: '',
		jellyfinPass: '',
		sunshineUrl: 'https://192.168.0.205:47990',
		sunshineUser: '',
		sunshinePass: '',
		moonlightHostUuid: ''
	};

	var STRING_KEYS = [
		'jellyfinUrl',
		'jellyfinUser',
		'jellyfinPass',
		'sunshineUrl',
		'sunshineUser',
		'sunshinePass',
		'moonlightHostUuid'
	];

	function safeStorage() {
		try {
			return global.localStorage || null;
		} catch (e) {
			return null;
		}
	}

	function readStored() {
		var storage = safeStorage();
		if (!storage) {
			return {};
		}
		try {
			var raw = storage.getItem(STORAGE_KEY);
			if (!raw) {
				return {};
			}
			var parsed = JSON.parse(raw);
			return (parsed && typeof parsed === 'object') ? parsed : {};
		} catch (e) {
			console.warn('[config] could not read settings:', e);
			return {};
		}
	}

	function writeStored(obj) {
		var storage = safeStorage();
		if (!storage) {
			return;
		}
		try {
			storage.setItem(STORAGE_KEY, JSON.stringify(obj));
		} catch (e) {
			console.warn('[config] could not persist settings:', e);
		}
	}

	/* Returns a complete settings object: stored values overlaid on defaults. */
	function get() {
		var stored = readStored();
		var out = {};
		for (var i = 0; i < STRING_KEYS.length; i++) {
			var key = STRING_KEYS[i];
			out[key] = (typeof stored[key] === 'string') ? stored[key] : DEFAULTS[key];
		}
		return out;
	}

	/* Merges `patch` into the current settings and persists the result. */
	function set(patch) {
		var current = get();
		if (patch) {
			for (var key in patch) {
				if (Object.prototype.hasOwnProperty.call(patch, key) && STRING_KEYS.indexOf(key) !== -1) {
					current[key] = (patch[key] == null) ? '' : String(patch[key]);
				}
			}
		}
		writeStored(current);
		return current;
	}

	/* Removes the stored settings entirely, then returns the defaults. */
	function clear() {
		var storage = safeStorage();
		if (storage) {
			try {
				storage.removeItem(STORAGE_KEY);
			} catch (e) {
				console.warn('[config] could not clear settings:', e);
			}
		}
		return get();
	}

	/* Minimal configuration needed to reach Jellyfin. */
	function isJellyfinConfigured() {
		var c = get();
		return !!(c.jellyfinUrl && c.jellyfinUser && c.jellyfinPass);
	}

	global.HubConfig = {
		STORAGE_KEY: STORAGE_KEY,
		DEFAULTS: DEFAULTS,
		get: get,
		set: set,
		clear: clear,
		isJellyfinConfigured: isJellyfinConfigured
	};
})(window);
