/*
 * WebOS Hub - bootstrap and UI.
 *
 * Screens: Settings <-> Home. Home renders the Continue Watching row, the
 * Jellyfin libraries (each expands into a poster grid), the Sunshine app list
 * and the two primary launch buttons. Every load error is surfaced inline; the
 * screen is never left blank.
 */
(function (global) {
	'use strict';

	var doc = global.document;

	var state = {
		screen: 'home',
		token: null,
		userId: null,
		serverName: null,
		libraries: [],
		activeLibraryId: null,
		activeLibraryName: '',
		toastTimer: null
	};

	var els = {};

	/* ------------------------------ Utilities ------------------------------ */

	function $(id) {
		return doc.getElementById(id);
	}

	function escapeHtml(value) {
		return String(value == null ? '' : value)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	function clearNode(node) {
		if (!node) {
			return;
		}
		while (node.firstChild) {
			node.removeChild(node.firstChild);
		}
	}

	function messageNode(text, className) {
		var p = doc.createElement('p');
		p.className = className || 'empty-note';
		p.textContent = text;
		return p;
	}

	function settle(promise) {
		return promise.then(function (value) {
			return { ok: true, value: value };
		}, function (error) {
			return { ok: false, error: error };
		});
	}

	function setStatus(text) {
		if (els.statusText) {
			els.statusText.textContent = text;
		}
	}

	function showToast(text, duration) {
		if (!els.toast) {
			return;
		}
		els.toast.textContent = text;
		els.toast.hidden = false;
		if (state.toastTimer) {
			global.clearTimeout(state.toastTimer);
		}
		state.toastTimer = global.setTimeout(function () {
			els.toast.hidden = true;
		}, duration == null ? 4500 : duration);
	}

	function showHomeError(text) {
		if (!els.homeError) {
			return;
		}
		els.homeError.textContent = text;
		els.homeError.hidden = !text;
	}

	function afterRender() {
		if (global.HubFocus && typeof global.HubFocus.refresh === 'function') {
			global.setTimeout(function () {
				global.HubFocus.refresh();
			}, 0);
		}
	}

	/* ------------------------------- Screens ------------------------------- */

	function showScreen(name) {
		state.screen = name;
		if (els.screenHome) {
			els.screenHome.hidden = (name !== 'home');
		}
		if (els.screenSettings) {
			els.screenSettings.hidden = (name !== 'settings');
		}
		if (name === 'settings') {
			populateSettingsForm();
		}
		afterRender();
	}

	function handleBack() {
		if (state.screen === 'settings') {
			if (global.HubConfig.isJellyfinConfigured()) {
				showScreen('home');
				return true;
			}
			return false; /* let the platform exit the app */
		}
		if (state.screen === 'home' && state.activeLibraryId) {
			collapseGrid();
			return true;
		}
		return false; /* exit */
	}

	/* ------------------------------ Settings ------------------------------- */

	function populateSettingsForm() {
		var c = global.HubConfig.get();
		if (els.setJellyfinUrl) { els.setJellyfinUrl.value = c.jellyfinUrl; }
		if (els.setJellyfinUser) { els.setJellyfinUser.value = c.jellyfinUser; }
		if (els.setJellyfinPass) { els.setJellyfinPass.value = c.jellyfinPass; }
		if (els.setSunshineUrl) { els.setSunshineUrl.value = c.sunshineUrl; }
		if (els.setSunshineUser) { els.setSunshineUser.value = c.sunshineUser; }
		if (els.setSunshinePass) { els.setSunshinePass.value = c.sunshinePass; }
		if (els.setMoonlightUuid) { els.setMoonlightUuid.value = c.moonlightHostUuid; }
	}

	function setSettingsNote(text) {
		if (!els.settingsNote) {
			return;
		}
		els.settingsNote.textContent = text || '';
		els.settingsNote.hidden = !text;
	}

	function onSaveSettings(evt) {
		if (evt && evt.preventDefault) {
			evt.preventDefault();
		}
		global.HubConfig.set({
			jellyfinUrl: els.setJellyfinUrl ? els.setJellyfinUrl.value.trim() : '',
			jellyfinUser: els.setJellyfinUser ? els.setJellyfinUser.value : '',
			jellyfinPass: els.setJellyfinPass ? els.setJellyfinPass.value : '',
			sunshineUrl: els.setSunshineUrl ? els.setSunshineUrl.value.trim() : '',
			sunshineUser: els.setSunshineUser ? els.setSunshineUser.value : '',
			sunshinePass: els.setSunshinePass ? els.setSunshinePass.value : '',
			moonlightHostUuid: els.setMoonlightUuid ? els.setMoonlightUuid.value.trim() : ''
		});
		setSettingsNote('Settings saved.');
		if (global.HubConfig.isJellyfinConfigured()) {
			showScreen('home');
			loadHome();
		}
	}

	function onClearSettings() {
		global.HubConfig.clear();
		populateSettingsForm();
		setSettingsNote('Settings cleared.');
	}

	/* -------------------------------- Home --------------------------------- */

	function resetHomePlaceholders() {
		clearNode(els.resumeRow);
		if (els.resumeRow) {
			els.resumeRow.appendChild(messageNode('Loading…'));
		}
		clearNode(els.librariesRow);
		if (els.librariesRow) {
			els.librariesRow.appendChild(messageNode('Loading…'));
		}
		clearNode(els.sunshineRow);
		if (els.sunshineRow) {
			els.sunshineRow.appendChild(messageNode('Loading…'));
		}
		if (els.sunshineError) {
			els.sunshineError.hidden = true;
			els.sunshineError.textContent = '';
		}
		collapseGrid();
		showHomeError('');
	}

	function collapseGrid() {
		state.activeLibraryId = null;
		state.activeLibraryName = '';
		if (els.gridSection) {
			els.gridSection.hidden = true;
		}
		if (els.itemsGrid) {
			clearNode(els.itemsGrid);
		}
		if (els.gridNote) {
			els.gridNote.hidden = true;
			els.gridNote.textContent = '';
		}
	}

	function loadHome() {
		state.token = null;
		state.userId = null;
		resetHomePlaceholders();

		if (!global.HubConfig.isJellyfinConfigured()) {
			showScreen('settings');
			setSettingsNote('Enter your Jellyfin credentials to continue.');
			return;
		}

		setStatus('Connecting to Jellyfin…');
		loadJellyfin().then(function () {
			return loadSunshine();
		}).then(function () {
			afterRender();
		});
	}

	function loadJellyfin() {
		var settings = global.HubConfig.get();
		setStatus('Authenticating with Jellyfin…');

		return global.HubJellyfin.authenticate(settings.jellyfinUrl, settings.jellyfinUser, settings.jellyfinPass)
			.then(function (auth) {
				state.token = auth.token;
				state.userId = auth.userId;
				state.serverName = auth.serverName;
				setStatus('Connected to Jellyfin' + (auth.serverName ? (' (' + auth.serverName + ')') : ''));
				return Promise.all([
					settle(global.HubJellyfin.getResume(settings.jellyfinUrl, auth.token, auth.userId)),
					settle(global.HubJellyfin.getViews(settings.jellyfinUrl, auth.token, auth.userId))
				]);
			})
			.then(function (results) {
				var resume = results[0];
				var views = results[1];

				if (resume.ok) {
					renderResume(resume.value.items);
				} else {
					renderRowError(els.resumeRow, 'Continue Watching: ' + resume.error.message);
				}

				if (views.ok) {
					state.libraries = views.value;
					renderLibraries(views.value);
				} else {
					renderRowError(els.librariesRow, 'Libraries: ' + views.error.message);
				}
			})
			.catch(function (err) {
				var message = (err && err.message) ? err.message : String(err);
				setStatus('Jellyfin error');
				renderRowError(els.resumeRow, 'Continue Watching: ' + message);
				renderRowError(els.librariesRow, 'Libraries: ' + message);
				showHomeError('Could not load Jellyfin: ' + message +
					'\nCheck the server URL and credentials in Settings.');
			});
	}

	function renderRowError(node, text) {
		if (!node) {
			return;
		}
		clearNode(node);
		node.appendChild(messageNode(text, 'error-note'));
	}

	function renderResume(items) {
		if (!els.resumeRow) {
			return;
		}
		clearNode(els.resumeRow);
		if (!items || !items.length) {
			els.resumeRow.appendChild(messageNode(
				'Nothing in progress yet. Resume a title in Jellyfin and it will appear here.'));
			return;
		}
		for (var i = 0; i < items.length; i++) {
			els.resumeRow.appendChild(posterTile(items[i]));
		}
	}

	function posterTile(item) {
		var settings = global.HubConfig.get();
		var button = doc.createElement('button');
		button.type = 'button';
		button.className = 'poster-tile';
		button.setAttribute('data-focusable', 'true');

		var img = doc.createElement('img');
		img.className = 'poster-img';
		img.alt = item.Name || '';
		img.src = global.HubJellyfin.imageUrl(settings.jellyfinUrl, item.Id, {
			maxHeight: 450,
			tag: global.HubJellyfin.primaryImageTag(item)
		});
		img.onerror = function () {
			img.style.visibility = 'hidden';
		};

		var label = doc.createElement('span');
		label.className = 'poster-label';
		label.textContent = item.Name || 'Untitled';

		button.appendChild(img);
		button.appendChild(label);
		button.addEventListener('click', function () {
			showToast('"' + (item.Name || 'Item') +
				'" - Jellyfin on webOS does not support deep-links, so the app cannot open this item directly. ' +
				'Launch Jellyfin and pick it there.');
		});
		return button;
	}

	function renderLibraries(views) {
		if (!els.librariesRow) {
			return;
		}
		clearNode(els.librariesRow);
		if (!views || !views.length) {
			els.librariesRow.appendChild(messageNode(
				'No libraries returned by Jellyfin. Check that the account can see at least one library.'));
			return;
		}
		for (var i = 0; i < views.length; i++) {
			els.librariesRow.appendChild(libraryTile(views[i]));
		}
	}

	function libraryTile(view) {
		var button = doc.createElement('button');
		button.type = 'button';
		button.className = 'library-tile';
		button.setAttribute('data-focusable', 'true');

		var name = doc.createElement('span');
		name.textContent = view.Name || 'Library';

		var type = doc.createElement('span');
		type.className = 'library-type';
		type.textContent = view.CollectionType ? ('Type: ' + view.CollectionType) : 'Library';

		button.appendChild(name);
		button.appendChild(type);
		button.addEventListener('click', function () {
			openLibrary(view);
		});
		return button;
	}

	function typesForCollection(collectionType) {
		if (collectionType === 'movies') { return 'Movie'; }
		if (collectionType === 'tvshows') { return 'Series'; }
		if (collectionType === 'music') { return 'MusicAlbum'; }
		if (collectionType === 'books') { return 'Book'; }
		return 'Movie,Series';
	}

	function openLibrary(view) {
		var settings = global.HubConfig.get();
		if (!state.token) {
			showToast('Not connected to Jellyfin yet.');
			return;
		}
		state.activeLibraryId = view.Id;
		state.activeLibraryName = view.Name || 'Library';

		if (els.gridSection) {
			els.gridSection.hidden = false;
		}
		if (els.gridTitle) {
			els.gridTitle.textContent = view.Name || 'Library';
		}
		if (els.itemsGrid) {
			clearNode(els.itemsGrid);
		}
		if (els.gridNote) {
			els.gridNote.textContent = 'Loading ' + (view.Name || 'library') + '…';
			els.gridNote.hidden = false;
		}
		setStatus('Loading ' + (view.Name || 'library') + '…');
		afterRender();

		global.HubJellyfin.getItems(settings.jellyfinUrl, state.token, state.userId, {
			libraryId: view.Id,
			types: typesForCollection(view.CollectionType),
			limit: 60,
			sortBy: 'SortName'
		}).then(function (result) {
			renderItems(result.items, view);
			setStatus('Connected to Jellyfin' + (state.serverName ? (' (' + state.serverName + ')') : ''));
		}).catch(function (err) {
			if (els.itemsGrid) {
				clearNode(els.itemsGrid);
			}
			if (els.gridNote) {
				els.gridNote.textContent = 'Could not load items: ' + ((err && err.message) ? err.message : String(err));
				els.gridNote.hidden = false;
			}
			setStatus('Jellyfin error');
		});
	}

	function renderItems(items, view) {
		if (els.itemsGrid) {
			clearNode(els.itemsGrid);
		}
		if (els.gridNote) {
			els.gridNote.hidden = true;
			els.gridNote.textContent = '';
		}
		if (!items || !items.length) {
			if (els.gridNote) {
				els.gridNote.textContent = 'No items found in ' + ((view && view.Name) || 'this library') + '.';
				els.gridNote.hidden = false;
			}
			afterRender();
			return;
		}
		for (var i = 0; i < items.length; i++) {
			if (els.itemsGrid) {
				els.itemsGrid.appendChild(posterTile(items[i]));
			}
		}
		afterRender();
	}

	function loadSunshine() {
		var settings = global.HubConfig.get();
		if (!settings.sunshineUrl) {
			renderSunshine([], 'Sunshine is not configured. Add a base URL in Settings.');
			return Promise.resolve();
		}
		return global.HubSunshine.getApps(settings).then(function (apps) {
			renderSunshine(apps, null);
		}).catch(function (err) {
			renderSunshine([], (err && err.message) ? err.message : String(err));
		});
	}

	function renderSunshine(apps, errorMessage) {
		if (els.sunshineRow) {
			clearNode(els.sunshineRow);
		}
		if (els.sunshineError) {
			els.sunshineError.hidden = !errorMessage;
			els.sunshineError.textContent = errorMessage || '';
		}
		if (errorMessage) {
			if (els.sunshineRow) {
				els.sunshineRow.appendChild(messageNode(
					'Sunshine is unavailable over the network right now.'));
			}
			return;
		}
		if (!apps || !apps.length) {
			if (els.sunshineRow) {
				els.sunshineRow.appendChild(messageNode('Sunshine reported no apps.'));
			}
			return;
		}
		for (var i = 0; i < apps.length; i++) {
			if (els.sunshineRow) {
				els.sunshineRow.appendChild(sunshineTile(apps[i], i));
			}
		}
	}

	function sunshineTile(app, index) {
		var tile = doc.createElement('div');
		tile.className = 'sunshine-tile';

		var name = doc.createElement('span');
		name.className = 'sunshine-name';
		name.textContent = app.name || ('App ' + index);

		var button = doc.createElement('button');
		button.type = 'button';
		button.className = 'btn sunshine-stream';
		button.setAttribute('data-focusable', 'true');
		button.textContent = 'Stream';
		button.addEventListener('click', function () {
			streamSunshineApp(app, index);
		});

		tile.appendChild(name);
		tile.appendChild(button);
		return tile;
	}

	function streamSunshineApp(app, index) {
		var settings = global.HubConfig.get();
		if (!global.HubLauncher.hasWebOS()) {
			showToast('Launching ' + (app.name || 'app') +
				' requires a webOS TV (desktop browser cannot launch apps).');
			return;
		}
		global.HubLauncher.openMoonlight({
			hostUuid: settings.moonlightHostUuid,
			appId: index
		}).then(function () {
			showToast('Launching Moonlight' + (settings.moonlightHostUuid ? (' → ' + (app.name || 'app')) : '') + '…');
		}).catch(function (err) {
			showToast('Launch failed: ' + ((err && err.message) ? err.message : String(err)));
		});
	}

	/* ------------------------------ Bootstrap ------------------------------ */

	function cacheElements() {
		els.screenHome = $('screen-home');
		els.screenSettings = $('screen-settings');
		els.statusText = $('status-text');
		els.toast = $('toast');
		els.homeError = $('home-error');
		els.resumeRow = $('resume-row');
		els.librariesRow = $('libraries-row');
		els.sunshineRow = $('sunshine-row');
		els.sunshineError = $('sunshine-error');
		els.gridSection = $('grid-section');
		els.gridTitle = $('grid-title');
		els.itemsGrid = $('items-grid');
		els.gridNote = $('grid-note');

		els.settingsNote = $('settings-note');
		els.setJellyfinUrl = $('set-jellyfin-url');
		els.setJellyfinUser = $('set-jellyfin-user');
		els.setJellyfinPass = $('set-jellyfin-pass');
		els.setSunshineUrl = $('set-sunshine-url');
		els.setSunshineUser = $('set-sunshine-user');
		els.setSunshinePass = $('set-sunshine-pass');
		els.setMoonlightUuid = $('set-moonlight-uuid');
	}

	function bindEvents() {
		var settingsForm = $('settings-form');
		if (settingsForm) {
			settingsForm.addEventListener('submit', onSaveSettings);
		}
		var btnSave = $('btn-save');
		if (btnSave) {
			btnSave.addEventListener('click', onSaveSettings);
		}
		var btnClear = $('btn-clear');
		if (btnClear) {
			btnClear.addEventListener('click', onClearSettings);
		}
		var btnCancel = $('btn-cancel');
		if (btnCancel) {
			btnCancel.addEventListener('click', function () {
				if (global.HubConfig.isJellyfinConfigured()) {
					showScreen('home');
					loadHome();
				} else {
					showToast('Save your Jellyfin credentials first.');
				}
			});
		}
		var btnSettings = $('btn-settings');
		if (btnSettings) {
			btnSettings.addEventListener('click', function () {
				showScreen('settings');
			});
		}
		var btnReload = $('btn-reload');
		if (btnReload) {
			btnReload.addEventListener('click', function () {
				if (global.HubConfig.isJellyfinConfigured()) {
					loadHome();
				} else {
					showScreen('settings');
				}
			});
		}
		var btnJellyfin = $('btn-open-jellyfin');
		if (btnJellyfin) {
			btnJellyfin.addEventListener('click', function () {
				global.HubLauncher.openJellyfin().then(function (res) {
					showToast(res && res.launched === false
						? 'Jellyfin launch requires a webOS TV.'
						: 'Launching Jellyfin…');
				}).catch(function (err) {
					showToast('Launch failed: ' + ((err && err.message) ? err.message : String(err)));
				});
			});
		}
		var btnMoonlight = $('btn-open-moonlight');
		if (btnMoonlight) {
			btnMoonlight.addEventListener('click', function () {
				var settings = global.HubConfig.get();
				global.HubLauncher.openMoonlight({ hostUuid: settings.moonlightHostUuid }).then(function (res) {
					showToast(res && res.launched === false
						? 'Moonlight launch requires a webOS TV.'
						: 'Launching Moonlight…');
				}).catch(function (err) {
					showToast('Launch failed: ' + ((err && err.message) ? err.message : String(err)));
				});
			});
		}
	}

	function init() {
		cacheElements();
		bindEvents();
		populateSettingsForm();

		if (global.HubFocus && typeof global.HubFocus.init === 'function') {
			global.HubFocus.init({ onBack: handleBack });
		}

		if (global.HubConfig.isJellyfinConfigured()) {
			showScreen('home');
			loadHome();
		} else {
			showScreen('settings');
			setSettingsNote('Enter your Jellyfin credentials to continue. ' +
				'Sunshine credentials are optional but enable the Sunshine row.');
			setStatus('Setup required');
		}
	}

	if (doc.readyState === 'loading') {
		doc.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})(window);
