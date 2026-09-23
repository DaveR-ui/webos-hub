/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 */

var Michelly = window.Michelly = window.Michelly || {};

(function (namespace) {
    'use strict';

    var DEFAULT_LIMIT = 60;

    // Items accumulated per grouped (music) fetch pass. Sized for the Chromium-38
    // first-paint budget (~300 eager 320px thumbnails); 'Show more' pulls the next
    // chunk, so everything stays reachable.
    var GROUPED_CHUNK = 300;

    function api() {
        return namespace.api;
    }

    function ui() {
        return namespace.ui;
    }

    function subtitleFor(item) {
        var bits = [];

        if (item.Type) {
            bits.push(item.Type);
        }
        if (item.ProductionYear) {
            bits.push(String(item.ProductionYear));
        }
        if (item.UserData && typeof item.UserData.PlayedPercentage === 'number' && item.UserData.PlayedPercentage > 0) {
            bits.push(Math.round(item.UserData.PlayedPercentage) + '% watched');
        }

        return bits.join(' - ');
    }

    function cloneOpts(opts) {
        var copy = {};

        for (var key in opts) {
            if (opts.hasOwnProperty(key)) {
                copy[key] = opts[key];
            }
        }

        return copy;
    }

    // Every selectable card is a <button> so the global D-pad selector picks it up.
    function makeCard(item, onSelect) {
        var button = ui().el('button', 'card');
        button.type = 'button';

        var poster = ui().el('div', 'card-poster');
        var img = document.createElement('img');
        img.alt = item.Name || '';
        poster.appendChild(img);
        button.appendChild(poster);

        var tag = item.ImageTags && item.ImageTags.Primary;
        ui().renderImage(img, tag ? api().imageUrl(item.Id, 'Primary', { maxWidth: 320, tag: tag }) : null, item.Name || '');

        button.appendChild(ui().el('div', 'card-title', item.Name || 'Untitled'));

        var subtitle = subtitleFor(item);
        if (subtitle) {
            button.appendChild(ui().el('div', 'card-sub', subtitle));
        }

        button.onclick = function () {
            onSelect(item);
        };

        return button;
    }

    function renderCardList(container, items, onSelect, emptyMsg) {
        if (!items || !items.length) {
            ui().showEmpty(container, emptyMsg);
            return;
        }

        ui().clear(container);

        for (var i = 0; i < items.length; i++) {
            container.appendChild(makeCard(items[i], onSelect));
        }
    }

    function focusFirstCard(container) {
        var target = container.querySelector('.card') || container.querySelector('button');

        if (target) {
            target.focus();
        }
    }

    // Each navigation entry resets the back stack and pushes exactly one handler that
    // recreates its parent, so the stack stays bounded no matter how deep the user goes.
    function setBackHandler(fn) {
        ui().clearBackHandlers();
        ui().pushBackHandler(fn);
    }

    /* Ordered list playback ("list session"). The catalog owns the list it rendered, so it
     * also owns the queue: one owner means the advance logic is not duplicated in the two
     * players and a mixed Audio/Video list cannot leak extra back-stack entries. */

    var listItems = null;
    var listIndex = -1;
    var listUserId = null;
    var listActive = false;
    var listKind = null;

    // Optional end-of-session destination (Scope A: user playlists return to the manage
    // view). A view-id string or a function; null keeps the historical #itemView default.
    var listReturnTarget = null;

    function playlistIsActive() {
        return listActive;
    }

    function stopCurrentPlayer() {
        if (listKind === 'audio') {
            namespace.audio.stop();
        } else if (listKind === 'video') {
            namespace.player.stop();
        }

        listKind = null;
    }

    // Tears the session down. ui.handleBack() pops a handler *before* invoking it, so the
    // handler pushed by playlistStart() must not pop again; the direct callers (finish,
    // auto-advance past the last item) still own the pop.
    function endSession(popHandler) {
        if (!listActive) {
            return;
        }

        listActive = false;
        stopCurrentPlayer();
        listItems = null;
        listIndex = -1;
        listUserId = null;

        if (popHandler) {
            ui().popBackHandler();
        }

        // Read the optional return target before resetting it. Existing item-view callers
        // leave it null, so the default showView('itemView') is byte-identical to before.
        var returnTarget = listReturnTarget;
        listReturnTarget = null;

        if (typeof returnTarget === 'function') {
            returnTarget();
        } else {
            ui().showView(returnTarget || 'itemView');
        }
    }

    // Public teardown (also the playlist's `stop`): ends the session and pops its handler.
    function playlistEnd() {
        endSession(true);
    }

    function playCurrent() {
        var item = listItems ? listItems[listIndex] : null;

        if (!item) {
            playlistEnd();
            return;
        }

        var kind = item.Type === 'Audio' ? 'audio' : 'video';

        // Mixed list: tear the previous player down before routing to the other one, so
        // exactly one player (and its progress timer) is alive at a time.
        if (listKind && listKind !== kind) {
            stopCurrentPlayer();
        }

        listKind = kind;

        if (kind === 'audio') {
            namespace.audio.play(item, listUserId);
        } else {
            namespace.player.play(item, listUserId);
        }
    }

    function playlistStart(items, index, userId, returnTarget) {
        if (listActive) {
            playlistEnd();
        }

        listItems = items || [];
        listIndex = (typeof index === 'number' && index >= 0) ? index : 0;
        listUserId = userId;
        listActive = true;

        // Optional end-of-session destination: a view-id string or a function (user playlists
        // return to the manage view). When omitted (every existing caller) it stays null and
        // endSession() falls back to the historical showView('itemView').
        listReturnTarget = returnTarget || null;

        // Exactly one back entry for the whole session: Back stops playback and returns to
        // the item view (or the session's return target). Auto-advance and next/previous
        // never push or pop a handler.
        ui().pushBackHandler(function () {
            endSession(false);
        });

        playCurrent();
    }

    // Called by the players' onended while list mode is active. Stop at the last item:
    // no wrap, no repeat, no shuffle.
    function playlistAdvance() {
        if (!listActive) {
            return false;
        }

        stopCurrentPlayer();

        if (listIndex + 1 >= listItems.length) {
            playlistEnd();
            return false;
        }

        listIndex++;
        playCurrent();
        return true;
    }

    function playlistHasNext() {
        return !!listActive && listIndex + 1 < listItems.length;
    }

    function playlistHasPrevious() {
        return !!listActive && listIndex > 0;
    }

    function playlistNext() {
        if (!listActive || !playlistHasNext()) {
            return false;
        }

        stopCurrentPlayer();
        listIndex++;
        playCurrent();
        return true;
    }

    function playlistPrevious() {
        if (!listActive || !playlistHasPrevious()) {
            return false;
        }

        stopCurrentPlayer();
        listIndex--;
        playCurrent();
        return true;
    }

    /* In-app user-built playlists (Scope A). Three preset slots, keyed by server id in
     * localStorage (deliberate alignment with michelly_sessions, auth.js:13-18) and played
     * through the session model above. This store is fork-owned and
     * deliberately NOT an api.js call: server-side playlists are out of scope (TV-only, single
     * client). The manage view and the add-from-item picker are built here in catalog.js so a
     * single owner holds the domain and the back-stack discipline; the runtime-built-view and
     * try/catch localStorage patterns are copied from index.js / auth.js. */

    var PLAYLISTS_KEY = 'michelly_playlists';
    var SLOT_COUNT = 3;
    var SLOT_NAMES = ['Playlist 1', 'Playlist 2', 'Playlist 3'];

    // The key for this server's slots inside michelly_playlists, set once per connect by
    // index.js afterConnect -> setServerId(current_server_id). The server's stable Id wins
    // over its baseUrl on purpose (same key michelly_sessions uses): playlists survive
    // address/port changes, and orphaning happens only if the server's own Id changes
    // (reinstall/reset). Null until set: reads behave like absent data, writes fail visibly.
    var plServerId = null;

    function setServerId(id) {
        plServerId = id || null;
    }

    // Manage-view UI state (module-level, reset on every entry into the view).
    var plSlotDetail = null;  // index of the open slot detail, or null for the slot list
    var plClearRow = null;    // index whose 'Clear' is awaiting an inline confirm
    var plStatusText = '';    // transient manage-view status line

    // True between a manage-play session's teardown and its deferred mirror tick (item 1):
    // it lets the tick tell the player's post-stop #itemView hijack from any other state.
    var plManageReturnArmed = false;

    function freshSlots() {
        return [[], [], []];
    }

    // Whole-store read as a plain object, or null when absent/unparseable/not-an-object. The
    // JSON.parse is wrapped because storage.get() would throw on a corrupt blob; a malformed
    // top level counts as an empty store (nothing else is recoverable to preserve).
    function readPlaylistsStore() {
        var raw = null;

        try {
            raw = localStorage.getItem(PLAYLISTS_KEY);
        } catch (err) {
            return null;
        }

        if (!raw) {
            return null;
        }

        var parsed;

        try {
            parsed = JSON.parse(raw);
        } catch (err2) {
            return null;
        }

        if (!parsed || typeof parsed !== 'object' || parsed instanceof Array) {
            // An array blob would pass a plain typeof-'object' test; saveSlots writing expando
            // keys onto an array would then be silently dropped by JSON.stringify — a false
            // 'success' with data loss. Treat it as an empty store.
            return null;
        }

        return parsed;
    }

    // Normalise one server's stored record into exactly three arrays, or null when it is
    // missing/corrupt (the caller then treats it as fresh empty slots). Individual bad entries
    // are dropped, so a partially damaged slot never destroys the sibling servers' keys.
    function normalizeSlots(record) {
        if (!record || typeof record !== 'object' || !(record.slots instanceof Array) ||
                record.slots.length !== SLOT_COUNT) {
            return null;
        }

        var out = freshSlots();

        for (var s = 0; s < SLOT_COUNT; s++) {
            var arr = record.slots[s];

            if (arr instanceof Array) {
                for (var k = 0; k < arr.length; k++) {
                    var entry = arr[k];

                    // Every entry this app writes is Audio by construction (the picker only
                    // appears on audio items); a foreign Type would misroute to the video
                    // player, so only Audio entries survive a read.
                    if (entry && typeof entry === 'object' && entry.Id && entry.Type === 'Audio') {
                        out[s].push(entry);
                    }
                }
            }
        }

        return out;
    }

    // This server's three slots (a fresh, normalised copy; never a live reference into
    // storage). Without a server id (before afterConnect wires one, or a server reporting no
    // Id) reads behave exactly like absent store data: fresh empty slots, no crash.
    function readSlots() {
        var key = plServerId;

        if (!key) {
            return freshSlots();
        }

        var store = readPlaylistsStore();
        var norm = (store && store.hasOwnProperty(key)) ? normalizeSlots(store[key]) : null;

        return norm || freshSlots();
    }

    // Write this server's slots back, preserving every other server's key. A falsy id must
    // never be persisted under a '' key, so it fails like a storage error: callers surface
    // 'Could not save the playlist.' (never-silent holds; auth.js guards its serverId alike).
    function saveSlots(slots) {
        var key = plServerId;

        if (!key) {
            return false;
        }

        var store = readPlaylistsStore();

        if (!store) {
            store = {};
        }

        store[key] = { slots: slots };

        try {
            localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(store));
        } catch (err) {
            return false;
        }

        return true;
    }

    // Persist an item with the minimum the row renderer and the audio player need.
    function playlistEntry(item) {
        var entry = {
            Id: item.Id,
            Type: item.Type || 'Audio',
            Name: item.Name || ''
        };

        if (item.ImageTags && item.ImageTags.Primary) {
            entry.ImageTags = { Primary: item.ImageTags.Primary };
        }

        return entry;
    }

    /* Public store surface (namespace.playlists). */

    function listSlots() {
        var slots = readSlots();
        var out = [];

        for (var i = 0; i < SLOT_COUNT; i++) {
            out.push({ name: SLOT_NAMES[i], count: slots[i] ? slots[i].length : 0 });
        }

        return out;
    }

    function getSlotItems(index) {
        if (index < 0 || index >= SLOT_COUNT) {
            return [];
        }

        return readSlots()[index].slice(0);
    }

    function addToSlot(index, item) {
        if (index < 0 || index >= SLOT_COUNT || !item || !item.Id) {
            return 'error';
        }

        var slots = readSlots();
        var arr = slots[index];

        for (var k = 0; k < arr.length; k++) {
            if (arr[k].Id === item.Id) {
                return 'duplicate';
            }
        }

        arr.push(playlistEntry(item));

        return saveSlots(slots) ? 'added' : 'error';
    }

    function removeAt(index, position) {
        if (index < 0 || index >= SLOT_COUNT) {
            return false;
        }

        var slots = readSlots();

        if (position < 0 || position >= slots[index].length) {
            return false;
        }

        slots[index].splice(position, 1);

        return saveSlots(slots);
    }

    function clearSlot(index) {
        if (index < 0 || index >= SLOT_COUNT) {
            return false;
        }

        var slots = readSlots();
        slots[index] = [];

        return saveSlots(slots);
    }

    function countLabel(count) {
        if (!count) {
            return 'empty';
        }

        return count + (count === 1 ? ' track' : ' tracks');
    }

    /* Add-from-item inline slot picker. It is rendered into a container inside the item view and
     * pushed onto the back stack exactly once; ui.handleBack() pops before invoking, so the
     * pushed handler must not pop, and the on-screen Cancel / slot choice (and a Play press that
     * starts a session over an open picker) pop it themselves. */

    function closePlaylistPicker(pickerEl, anchorEl, popHandler) {
        if (popHandler) {
            ui().popBackHandler();
        }

        ui().clear(pickerEl);

        if (anchorEl) {
            anchorEl.focus();
        }
    }

    function openPlaylistPicker(pickerEl, statusEl, anchorEl, item) {
        ui().clear(pickerEl);

        var slots = listSlots();

        for (var i = 0; i < slots.length; i++) {
            (function (index) {
                var pick = ui().el('button', 'playlist-pick-btn',
                    slots[index].name + ' (' + countLabel(slots[index].count) + ')');
                pick.type = 'button';
                pick.onclick = function () {
                    var result = addToSlot(index, item);
                    showPickerStatus(statusEl, result, index);
                    closePlaylistPicker(pickerEl, anchorEl, true);
                    return false;
                };
                pickerEl.appendChild(pick);
            })(i);
        }

        var cancel = ui().el('button', 'playlist-pick-btn playlist-pick-cancel', 'Cancel');
        cancel.type = 'button';
        cancel.onclick = function () {
            closePlaylistPicker(pickerEl, anchorEl, true);
            return false;
        };
        pickerEl.appendChild(cancel);

        // One back entry for the picker only: hardware Back clears it and nothing else. It does
        // not pop (handleBack already popped), mirroring the playlist-start handler convention.
        ui().pushBackHandler(function () {
            closePlaylistPicker(pickerEl, anchorEl, false);
        });

        var first = pickerEl.querySelector('button');

        if (first) {
            first.focus();
        }
    }

    function showPickerStatus(statusEl, result, index) {
        var name = SLOT_NAMES[index];
        var text;

        if (result === 'added') {
            text = 'Added to ' + name + '.';
        } else if (result === 'duplicate') {
            text = 'Already in ' + name + '.';
        } else {
            text = 'Could not save the playlist.';
        }

        statusEl.textContent = text;
        statusEl.style.display = '';
    }

    /* Manage view (runtime-built, class="view" so ui.showView() switches to it with no
     * index.html change; copied from index.js ensureSettingsView). */

    function ensurePlaylistsView() {
        if (document.querySelector('#playlistsView')) {
            return;
        }

        var view = document.createElement('div');
        view.id = 'playlistsView';
        view.className = 'view';
        document.body.appendChild(view);
    }

    // Entry from the library list: reset the stack (catalog discipline, exactly one handler that
    // recreates Views) then show the freshly-rendered slot list.
    function openPlaylists(userId) {
        plSlotDetail = null;
        plClearRow = null;
        plStatusText = '';

        setBackHandler(function () {
            openViews(userId);
        });

        renderPlaylists(userId);
    }

    // Content renderer + view switcher. Rebuilds on every call so counts are always current.
    // Also used as the session's return target after a manage-play ends.
    function renderPlaylists(userId) {
        ensurePlaylistsView();

        var view = document.querySelector('#playlistsView');

        ui().showView('playlistsView');
        ui().clear(view);

        var header = ui().el('div', 'browse-header');
        header.appendChild(ui().el('h1', 'playlist-title',
            plSlotDetail === null ? 'Playlists' : SLOT_NAMES[plSlotDetail]));
        view.appendChild(header);

        if (plSlotDetail === null) {
            renderSlotList(view, userId);
        } else {
            renderSlotDetail(view, userId, plSlotDetail);
        }

        if (plStatusText) {
            var status = ui().el('p', 'playlist-status', plStatusText);
            status.style.display = '';
            view.appendChild(status);
        }

        var first = view.querySelector('button');

        if (first) {
            first.focus();
        }
    }

    // renderItem() creates #itemError lazily, but a fresh launch can reach Playlists -> Play
    // without ever opening an item, and ui().setError() silently no-ops when its target is
    // missing — the players' failure message would be discarded before the mirror below could
    // see it. Guarantee the node exists (same hidden error-slot pattern renderItem uses, no
    // text beyond the placeholder) before the session teardown hands control back to the
    // player, which writes its message synchronously right after the return target runs.
    function ensureItemErrorSlot() {
        if (document.querySelector('#itemError')) {
            return;
        }

        var itemView = document.querySelector('#itemView');

        if (!itemView) {
            return;
        }

        var slot = ui().el('p', 'error-slot', '\u00a0');
        slot.id = 'itemError';
        slot.style.display = 'none';
        itemView.appendChild(slot);
    }

    // "Failure paths are never silent" for the manage-play flow: the players end a failed
    // session by calling finish()/stop() FIRST — which runs this session's return target and
    // lands the user on the manage view — and write the message to #itemError AFTER. Two
    // shapes follow, both handled one tick later (setTimeout 0 runs after the player's
    // synchronous continuation, so the message is present by then):
    // - finish-based (a.onerror / no-source): the manage view stays active and the message
    //   sits in the hidden #itemView; mirror it into the manage view's own status line.
    // - PlaybackInfo-fail hijack (audio.js/player.js): the player calls showView('itemView')
    //   after stop(), stranding the user on a #itemView shell that renderItem never filled
    //   in this launch (index.html keeps it empty; at worst a blank screen with a dead
    //   D-pad). A manage-session tick finding #itemView active can ONLY be that post-stop
    //   hijack — every legit manage end (Back, normal end, finish-error) leaves the manage
    //   view active, and the item-view 3-arg flow never arms or ticks — so restore the
    //   manage view and surface the message there too.
    // #itemError is a foreign element: never clear or write it. Guards: (a) #itemError holds
    // non-empty text (the placeholder \u00a0 and play()'s per-item clear both trim to empty,
    // so normal-end and Back no-op); (b) the armed/visible test above decides restore vs
    // mirror; (c) the manage view is still in the DOM — required on BOTH paths.
    function mirrorManagePlayError(userId) {
        ensureItemErrorSlot();

        setTimeout(function () {
            // Disarm unconditionally up front: no early-return below may leave a stale-armed
            // flag surviving into the next tick.
            var armed = plManageReturnArmed;
            plManageReturnArmed = false;

            var slot = document.querySelector('#itemError');

            if (!slot) {
                return;
            }

            var msg = String(slot.textContent || '').replace(/^\s+|\s+$/g, '');

            if (!msg) {
                return;
            }

            var itemView = document.querySelector('#itemView');
            var itemViewVisible = !!(itemView && (' ' + itemView.className + ' ').indexOf(' active ') >= 0);

            if (!document.querySelector('#playlistsView')) {
                return;
            }

            if (itemViewVisible) {
                if (!armed) {
                    return;
                }

                ui().showView('playlistsView');
            }

            if (plStatusText === msg) {
                return;
            }

            plStatusText = msg;
            renderPlaylists(userId);
        }, 0);
    }

    function renderSlotList(view, userId) {
        var slots = listSlots();
        var body = ui().el('div', 'playlist-slots');
        view.appendChild(body);

        for (var i = 0; i < slots.length; i++) {
            (function (index) {
                var count = slots[index].count;
                var row = ui().el('div', 'playlist-row');

                var slot = ui().el('button', 'playlist-slot-btn',
                    slots[index].name + ' (' + countLabel(count) + ')');
                slot.type = 'button';
                slot.onclick = function () {
                    openSlotDetail(userId, index);
                    return false;
                };
                row.appendChild(slot);

                if (plClearRow === index) {
                    // Two-step inline confirm: the row swaps to a Yes/No prompt, nothing else changes.
                    row.appendChild(ui().el('div', 'playlist-confirm-text',
                        count === 1 ? 'Remove the track?' : 'Remove all ' + count + ' tracks?'));

                    var yes = ui().el('button', 'playlist-confirm-btn', 'Yes');
                    yes.type = 'button';
                    yes.onclick = function () {
                        // A failed storage write is surfaced, never silent: the re-render below
                        // re-reads the store, so the slot still shows its tracks on failure.
                        plStatusText = clearSlot(index) ? '' : 'Could not save the playlist.';
                        plClearRow = null;
                        renderPlaylists(userId);
                        return false;
                    };
                    row.appendChild(yes);

                    var no = ui().el('button', 'playlist-confirm-btn', 'No');
                    no.type = 'button';
                    no.onclick = function () {
                        plClearRow = null;
                        renderPlaylists(userId);
                        return false;
                    };
                    row.appendChild(no);
                } else {
                    // Never-disabled: an empty slot still plays as a focusable button that no-ops.
                    var play = ui().el('button', 'playlist-play-btn', 'Play');
                    play.type = 'button';
                    play.onclick = function () {
                        var items = getSlotItems(index);

                        if (!items.length) {
                            plStatusText = slots[index].name + ' is empty.';
                            renderPlaylists(userId);
                            return false;
                        }

                        // Start with a clean status line and no inline Clear confirm: a mirrored
                        // failure from a previous session, or a confirm armed on another row,
                        // must not outlive the session into its teardown re-render.
                        plStatusText = '';
                        plClearRow = null;

                        playlistStart(items, 0, userId, function () {
                            renderPlaylists(userId);
                            plManageReturnArmed = true;
                            mirrorManagePlayError(userId);
                        });
                        return false;
                    };
                    row.appendChild(play);

                    var clear = ui().el('button', 'playlist-clear-btn', 'Clear');
                    clear.type = 'button';
                    clear.onclick = function () {
                        if (!count) {
                            plStatusText = slots[index].name + ' is empty.';
                            renderPlaylists(userId);
                            return false;
                        }

                        plClearRow = index;
                        plStatusText = '';
                        renderPlaylists(userId);
                        return false;
                    };
                    row.appendChild(clear);
                }

                body.appendChild(row);
            })(i);
        }
    }

    // Slot detail is a lower level inside the same view. It pushes one back handler so hardware
    // Back exits to the slot list; the on-screen Back simply calls handleBack() (pops + invokes),
    // exactly like the D-pad path.
    function openSlotDetail(userId, index) {
        plSlotDetail = index;
        plClearRow = null;
        plStatusText = '';

        ui().pushBackHandler(function () {
            plSlotDetail = null;
            renderPlaylists(userId);
        });

        renderPlaylists(userId);
    }

    function renderSlotDetail(view, userId, index) {
        var items = getSlotItems(index);
        var body = ui().el('div', 'playlist-tracks');
        view.appendChild(body);

        if (!items.length) {
            body.appendChild(ui().el('div', 'playlist-empty', 'This playlist is empty.'));
        }

        for (var j = 0; j < items.length; j++) {
            (function (position) {
                var row = ui().el('div', 'playlist-track-row');
                row.appendChild(ui().el('div', 'playlist-track-name', items[position].Name || 'Untitled'));

                var remove = ui().el('button', 'playlist-remove-btn', 'Remove');
                remove.type = 'button';
                remove.onclick = function () {
                    // Surface a failed storage write the same way Clear does (the re-render
                    // re-reads the store, so a failed remove leaves the track in place).
                    if (!removeAt(index, position)) {
                        plStatusText = 'Could not save the playlist.';
                    }
                    renderPlaylists(userId);
                    return false;
                };
                row.appendChild(remove);

                body.appendChild(row);
            })(j);
        }

        var back = ui().el('button', 'playlist-back-btn', 'Back');
        back.type = 'button';
        back.onclick = function () {
            // Pop the detail handler and run it (returns to the slot list), same as hardware Back.
            ui().handleBack();
            return false;
        };
        view.appendChild(back);
    }

    function openViews(userId) {
        var browse = document.querySelector('#browseView');

        // Entering the library list invalidates the grouped render cache (fresh data on next
        // open) and supersedes any grouped fetch still in flight.
        lastGrouped = null;
        groupedEpoch++;

        setBackHandler(function () {
            ui().showView('pickerView');
        });

        ui().showView('browseView');
        ui().showLoading(browse);

        api().getViews(userId, function (data) {
            var items = (data && data.Items) ? data.Items : [];

            ui().clear(browse);

            var header = ui().el('div', 'browse-header playlist-lib-header');
            header.appendChild(ui().el('h1', 'browse-title', 'Libraries'));

            var resume = ui().el('button', 'resume-btn', 'Continue Watching');
            resume.type = 'button';
            resume.onclick = function () {
                openResume(userId);
            };
            header.appendChild(resume);

            var playlistsBtn = ui().el('button', 'resume-btn playlist-entry-btn', 'Playlists');
            playlistsBtn.type = 'button';
            playlistsBtn.onclick = function () {
                openPlaylists(userId);
                return false;
            };
            header.appendChild(playlistsBtn);

            browse.appendChild(header);

            var list = ui().el('div', 'card-list');
            browse.appendChild(list);

            renderCardList(list, items, function (view) {
                // Music libraries open the artist-centric music home; every other library
                // keeps the folder-grouped card-grid render mode.
                if (view.CollectionType === 'music') {
                    namespace.music.openHome(view.Id, userId, view.Name);
                    return;
                }

                openItems(view.Id, userId, {
                    title: view.Name,
                    ParentId: view.Id,
                    grouped: view.CollectionType === 'music'
                });
            }, 'No libraries found for this user.');

            focusFirstCard(browse);
        }, function (err) {
            ui().showError(browse, err);
        });
    }

    function renderItemsView(container, title, items, total, startIndex, limit, userId, opts) {
        ui().clear(container);

        var header = ui().el('div', 'browse-header');
        header.appendChild(ui().el('h1', 'browse-title', title || 'Browse'));
        container.appendChild(header);

        var pager = ui().el('div', 'pager');

        if (startIndex > 0) {
            var prev = ui().el('button', 'pager-btn', 'Previous');
            prev.type = 'button';
            prev.onclick = function () {
                var prevOpts = cloneOpts(opts);
                prevOpts.StartIndex = Math.max(0, startIndex - limit);
                openItems(opts.ParentId, userId, prevOpts);
            };
            pager.appendChild(prev);
        }

        if (startIndex + limit < total) {
            var next = ui().el('button', 'pager-btn', 'Next');
            next.type = 'button';
            next.onclick = function () {
                var nextOpts = cloneOpts(opts);
                nextOpts.StartIndex = startIndex + limit;
                openItems(opts.ParentId, userId, nextOpts);
            };
            pager.appendChild(next);
        }

        if (pager.firstChild) {
            container.appendChild(pager);
        }

        var list = ui().el('div', 'card-list');
        container.appendChild(list);

        renderCardList(list, items, function (item) {
            openItem(item.Id, userId, function () {
                var backOpts = cloneOpts(opts);
                backOpts.StartIndex = startIndex;
                openItems(opts.ParentId, userId, backOpts);
            }, items, items.indexOf(item));
        }, 'This folder is empty.');

        focusFirstCard(container);
    }

    /* Folder-grouped browsing (music libraries). Pages are accumulated sequentially in
     * an ES5 callback chain (no Promises), GROUPED_CHUNK items per pass; the render is
     * one section per folder that directly holds media, ordered by a depth-first walk
     * from the opened root. 'Show more' pulls the next chunk when the server reports a
     * bigger total, so everything stays reachable. */

    // Single-entry render cache so the card back handler can re-enter a grouped view
    // synchronously without refetching. Shape: {parentId, userId, title, items, total, startIndex}.
    var lastGrouped = null;

    // Monotonic token bumped by openViews and every grouped fetch start, so a late chunk
    // callback can tell whether it still owns the view (drop silently when it does not).
    var groupedEpoch = 0;

    function compareGrouped(a, b) {
        var an = String((a && (a.SortName || a.Name)) || '');
        var bn = String((b && (b.SortName || b.Name)) || '');

        if (an < bn) {
            return -1;
        }
        if (an > bn) {
            return 1;
        }
        return 0;
    }

    function indexPush(index, key, item) {
        if (!index.hasOwnProperty(key)) {
            index[key] = [];
        }

        index[key].push(item);
    }

    function indexedChildren(index, key) {
        return index.hasOwnProperty(key) ? index[key] : [];
    }

    // Grouped mode treats these types as folder nodes: plain file folders plus the
    // MusicAlbum / MusicArtist library nodes Jellyfin types music folders with.
    function isGroupedFolderType(type) {
        return type === 'Folder' || type === 'MusicAlbum' || type === 'MusicArtist';
    }

    // Build the render model: {rootMedia, sections, orphans}. Folder-typed nodes (Folder,
    // MusicAlbum, MusicArtist) are section containers only; Audio plus any unexpected type
    // render as cards. Note: in grouped mode the fetch filter (Audio,Folder,MusicAlbum,
    // MusicArtist) already excludes non-audio types (MusicVideo, Playlist, ...) from the
    // response, so this media bucket is a defensive net, not a reachability guarantee.
    // The visited set guarantees a malformed ParentId cycle cannot loop the walk; media
    // whose parent is neither the opened root nor a known folder falls into the trailing
    // orphan group, and unreachable folder nodes are picked up by the unvisited sweep.
    function buildGroupedModel(items, parentId) {
        var rootKey = String(parentId || '');
        var foldersById = {};
        var childrenByParent = {};
        var visited = {};
        var sections = [];
        var rootMedia = [];
        var orphans = [];
        var i, item, pid;

        for (i = 0; i < items.length; i++) {
            item = items[i];
            if (item && isGroupedFolderType(item.Type) && item.Id) {
                foldersById[String(item.Id)] = item;
            }
        }

        for (i = 0; i < items.length; i++) {
            item = items[i];
            if (!item || !item.Id) {
                continue;
            }

            pid = String(item.ParentId || '');

            if (pid === rootKey) {
                indexPush(childrenByParent, rootKey, item);
            } else if (foldersById.hasOwnProperty(pid)) {
                indexPush(childrenByParent, pid, item);
            } else if (!isGroupedFolderType(item.Type)) {
                orphans.push(item);
            }
        }

        visited[rootKey] = true;

        function walk(folder, ancestors) {
            var folderKey = String(folder.Id);

            if (visited.hasOwnProperty(folderKey)) {
                return;
            }
            visited[folderKey] = true;

            var children = indexedChildren(childrenByParent, folderKey).slice(0);
            children.sort(compareGrouped);

            var media = [];
            var subFolders = [];
            var j;

            for (j = 0; j < children.length; j++) {
                if (isGroupedFolderType(children[j].Type)) {
                    subFolders.push(children[j]);
                } else {
                    // Audio plus unknown types are media cards.
                    media.push(children[j]);
                }
            }

            // A folder holding only sub-folders renders no section of its own; the
            // descendant media-folders' sections appear in its place.
            if (media.length) {
                sections.push({
                    id: folder.Id,
                    name: folder.Name || 'Untitled',
                    path: ancestors.join(' / '),
                    media: media
                });
            }

            var childAncestors = ancestors.concat([folder.Name || 'Untitled']);

            for (j = 0; j < subFolders.length; j++) {
                walk(subFolders[j], childAncestors);
            }
        }

        var rootChildren = indexedChildren(childrenByParent, rootKey).slice(0);
        rootChildren.sort(compareGrouped);

        for (i = 0; i < rootChildren.length; i++) {
            item = rootChildren[i];

            if (isGroupedFolderType(item.Type)) {
                walk(item, []);
            } else {
                // Audio plus unexpected types card at the root.
                rootMedia.push(item);
            }
        }

        // Last-resort safety net: folder nodes still unvisited after the walk (unknown
        // parent, e.g. an album whose artist fell outside the fetched chunk, or a
        // disconnected ParentId cycle) are walked as trailing section roots. Their media
        // stays reachable, the visited set still breaks any cycle, and folder types are
        // never carded.
        for (i = 0; i < items.length; i++) {
            item = items[i];
            if (item && isGroupedFolderType(item.Type) && item.Id &&
                    !visited.hasOwnProperty(String(item.Id))) {
                walk(item, []);
            }
        }

        orphans.sort(compareGrouped);

        return {
            rootMedia: rootMedia,
            sections: sections,
            orphans: orphans
        };
    }

    // Each card plays its own section's ordered media array (the album), not the whole
    // accumulated flat list; media is captured per call, so the closure is safe in ES5.
    function appendGroupedCards(listEl, media, userId, backFn) {
        for (var i = 0; i < media.length; i++) {
            listEl.appendChild(makeCard(media[i], function (item) {
                openItem(item.Id, userId, backFn, media, media.indexOf(item));
            }));
        }
    }

    function renderGroupedView(container, title, items, total, focusShowMore, userId, parentId, opts, errMsg) {
        ui().clear(container);

        var header = ui().el('div', 'browse-header');
        header.appendChild(ui().el('h1', 'browse-title', title || 'Browse'));
        container.appendChild(header);

        var hasMore = typeof total === 'number' && items.length < total;
        var model = buildGroupedModel(items, parentId);

        function backToGrouped() {
            openItems(parentId, userId, cloneOpts(opts));
        }

        var renderable = model.rootMedia.length || model.sections.length || model.orphans.length || hasMore;

        if (!renderable) {
            var emptyList = ui().el('div', 'card-list');
            container.appendChild(emptyList);
            ui().showEmpty(emptyList, 'This folder is empty.');
            return;
        }

        // Leading untitled grid for media items sitting directly at the opened root.
        if (model.rootMedia.length) {
            var strayList = ui().el('div', 'card-list');
            container.appendChild(strayList);
            appendGroupedCards(strayList, model.rootMedia, userId, backToGrouped);
        }

        // One flat .folder-section per media folder; headers are not tabbable so the
        // D-pad walk only ever lands on cards.
        for (var s = 0; s < model.sections.length; s++) {
            var section = model.sections[s];
            var sectionEl = ui().el('div', 'folder-section');
            var head = ui().el('div', 'folder-section-head');
            head.appendChild(ui().el('h2', 'folder-section-title', section.name));

            if (section.path) {
                head.appendChild(ui().el('div', 'folder-section-path', section.path));
            }

            sectionEl.appendChild(head);

            var grid = ui().el('div', 'card-list');
            sectionEl.appendChild(grid);
            appendGroupedCards(grid, section.media, userId, backToGrouped);

            container.appendChild(sectionEl);
        }

        // Trailing untitled group for media with an unknown parent folder.
        if (model.orphans.length) {
            var orphanList = ui().el('div', 'card-list');
            container.appendChild(orphanList);
            appendGroupedCards(orphanList, model.orphans, userId, backToGrouped);
        }

        // Continuation affordance: the pass stopped at GROUPED_CHUNK items and the server
        // reports more. 'Show more' resumes the same sequential chain (nothing skipped or
        // duplicated) and re-renders in place.
        var moreButton = null;

        if (hasMore) {
            var pager = ui().el('div', 'pager');
            moreButton = ui().el('button', 'pager-btn', 'Show more');
            moreButton.type = 'button';

            var fetching = false;

            moreButton.onclick = function () {
                if (fetching || !lastGrouped) {
                    return;
                }

                fetching = true;
                moreButton.textContent = 'Loading...';

                // Claim the view: any newer navigation or fetch bumps the epoch and
                // supersedes this result.
                groupedEpoch++;
                var moreEpoch = groupedEpoch;

                fetchGroupedChunk(parentId, userId, opts, {
                    items: lastGrouped.items,
                    total: lastGrouped.total,
                    startIndex: lastGrouped.startIndex
                }, function (state, err) {
                    // A newer navigation owns the view now: drop silently, no repaint.
                    if (moreEpoch !== groupedEpoch) {
                        return;
                    }

                    // Cache replaced while fetching (user left the view): drop the result.
                    if (!lastGrouped || lastGrouped.parentId !== String(parentId || '') || lastGrouped.userId !== userId) {
                        return;
                    }

                    if (err) {
                        // Do not destroy the rendered grid: sync the cache with whatever
                        // pages were consumed before the failure (so a retry never
                        // duplicates), then re-render it with an inline note and keep the
                        // D-pad focus on the re-created 'Show more' button.
                        lastGrouped.startIndex = state.startIndex;
                        if (typeof state.total === 'number') {
                            lastGrouped.total = state.total;
                        }

                        renderGroupedView(document.querySelector('#browseView'), lastGrouped.title,
                            lastGrouped.items, lastGrouped.total, true, userId, parentId, opts,
                            'Could not load more items. Try again.');
                        return;
                    }

                    storeAndRenderGrouped(state, parentId, userId, opts, true);
                });
            };

            pager.appendChild(moreButton);
            container.appendChild(pager);
        }

        // Inline show-more failure note (only present on the error re-render). Not tabbable.
        if (errMsg) {
            container.appendChild(ui().el('div', 'grouped-error', errMsg));
        }

        // A 'Show more' re-render keeps the D-pad focus on the (re-created) button when it
        // is still there; everything else seeds the first card as before.
        if (focusShowMore && moreButton) {
            moreButton.focus();
        } else {
            focusFirstCard(container);
        }
    }

    // Sequentially accumulate the next GROUPED_CHUNK items (ES5 callback chain, one page
    // at a time). state carries {items, total, startIndex} so 'Show more' resumes exactly
    // where the last pass stopped; items are consumed one-by-one against the server offset,
    // so a chunk boundary never skips or duplicates entries. onDone(state, err).
    function fetchGroupedChunk(parentId, userId, opts, state, onDone) {
        var target = state.items.length + GROUPED_CHUNK;

        function requestPage() {
            api().getItems({
                ParentId: parentId,
                Recursive: opts.Recursive !== false,
                IncludeItemTypes: 'Audio,Folder,MusicAlbum,MusicArtist',
                StartIndex: state.startIndex,
                Limit: opts.Limit || DEFAULT_LIMIT,
                SortBy: opts.SortBy || 'SortName',
                SortOrder: opts.SortOrder || 'Ascending',
                Fields: 'PrimaryImageAspectRatio,ParentId'
            }, function (data) {
                var items = (data && data.Items) ? data.Items : [];
                var i = 0;

                if (data && typeof data.TotalRecordCount === 'number') {
                    state.total = data.TotalRecordCount;
                }

                while (i < items.length && state.items.length < target) {
                    state.items.push(items[i]);
                    state.startIndex++;
                    i++;
                }

                var exhausted = !items.length ||
                    (typeof state.total === 'number' && state.items.length >= state.total);

                if (exhausted || state.items.length >= target) {
                    onDone(state);
                    return;
                }

                requestPage();
            }, function (err) {
                onDone(state, err);
            });
        }

        requestPage();
    }

    // Publish a finished chunk into the single-entry cache and render it. focusShowMore
    // carries the D-pad focus-continuity flag through to renderGroupedView.
    function storeAndRenderGrouped(state, parentId, userId, opts, focusShowMore) {
        var browse = document.querySelector('#browseView');

        lastGrouped = {
            parentId: String(parentId || ''),
            userId: userId,
            title: opts.title,
            items: state.items,
            total: (typeof state.total === 'number') ? state.total : state.items.length,
            startIndex: state.startIndex
        };

        renderGroupedView(browse, lastGrouped.title, lastGrouped.items, lastGrouped.total,
            focusShowMore, userId, parentId, opts);
    }

    function openItems(parentId, userId, opts) {
        opts = opts || {};

        var startIndex = opts.StartIndex || 0;
        var limit = opts.Limit || DEFAULT_LIMIT;
        var browse = document.querySelector('#browseView');

        // Caller-supplied back target (music screens re-render themselves); every existing
        // caller passes no opts.back, so it keeps the historical openViews(userId) behaviour.
        setBackHandler(function () {
            if (typeof opts.back === 'function') {
                opts.back();
            } else {
                openViews(userId);
            }
        });

        ui().showView('browseView');

        if (opts.grouped === true) {
            // Single-entry cache hit: re-render synchronously (e.g. returning from item view)
            // instead of refetching the accumulated chunk(s).
            if (lastGrouped && lastGrouped.parentId === String(parentId || '') && lastGrouped.userId === userId) {
                renderGroupedView(browse, lastGrouped.title, lastGrouped.items, lastGrouped.total,
                    false, userId, parentId, opts);
                return;
            }

            ui().showLoading(browse);

            // Claim the view: any newer navigation or fetch bumps the epoch and supersedes
            // this result (no repaint, no cache write) when it lands late.
            groupedEpoch++;
            var initialEpoch = groupedEpoch;

            fetchGroupedChunk(parentId, userId, opts, { items: [], total: null, startIndex: 0 }, function (state, err) {
                if (initialEpoch !== groupedEpoch) {
                    return;
                }

                if (err) {
                    ui().showError(browse, err);
                    return;
                }

                storeAndRenderGrouped(state, parentId, userId, opts, false);
            });
            return;
        }

        ui().showLoading(browse);

        api().getItems({
            ParentId: parentId,
            Recursive: opts.Recursive !== false,
            IncludeItemTypes: opts.IncludeItemTypes,
            StartIndex: startIndex,
            Limit: limit,
            SortBy: opts.SortBy || 'SortName',
            SortOrder: opts.SortOrder || 'Ascending',
            Fields: 'PrimaryImageAspectRatio'
        }, function (data) {
            var items = (data && data.Items) ? data.Items : [];
            var total = (data && typeof data.TotalRecordCount === 'number') ? data.TotalRecordCount : items.length;

            renderItemsView(browse, opts.title, items, total, startIndex, limit, userId, opts);
        }, function (err) {
            ui().showError(browse, err);
        });
    }

    function renderItem(container, item, userId, back, list, listIndex) {
        ui().clear(container);

        var wrapper = ui().el('div', 'item-detail');

        var posterWrap = ui().el('div', 'item-poster');
        var img = document.createElement('img');
        img.alt = item.Name || '';
        posterWrap.appendChild(img);
        wrapper.appendChild(posterWrap);

        var tag = item.ImageTags && item.ImageTags.Primary;
        ui().renderImage(img, tag ? api().imageUrl(item.Id, 'Primary', { maxWidth: 480, tag: tag }) : null, item.Name || '');

        var info = ui().el('div', 'item-info');
        info.appendChild(ui().el('h1', 'item-title', item.Name || 'Untitled'));

        var subtitle = subtitleFor(item);
        if (subtitle) {
            info.appendChild(ui().el('div', 'item-sub', subtitle));
        }

        if (item.Overview) {
            info.appendChild(ui().el('p', 'item-overview', item.Overview));
        }

        var actions = ui().el('div', 'item-actions');

        var play = ui().el('button', 'primary', 'Play');
        play.type = 'button';
        play.onclick = function () {
            // An inline slot picker can be open on audio items; close it FIRST (popping its
            // single back handler) so playback starts from a clean stack and no stale picker
            // widgets remain in the D-pad walk behind the player view.
            if (plPicker && plPicker.firstChild) {
                closePlaylistPicker(plPicker, addToPlaylist, true);
            }

            // A list-opened item plays as an ordered session; a list-less item (series
            // detail, fallback) keeps the single-item path.
            if (list && list.length && listIndex >= 0) {
                var queue = list.slice(0);
                queue[listIndex] = item;   // the fetched detail is richer than the /Items entry
                namespace.playlist.start(queue, listIndex, userId);
            } else if (item.Type === 'Audio') {
                namespace.audio.play(item, userId);
            } else {
                namespace.player.play(item, userId);
            }
        };
        actions.appendChild(play);

        if (item.Type === 'Series') {
            var episodes = ui().el('button', 'secondary', 'Episodes');
            episodes.type = 'button';
            episodes.onclick = function () {
                openEpisodes(item.Id, userId, function () {
                    openItem(item.Id, userId, back);
                });
            };
            actions.appendChild(episodes);
        }

        // User playlists: only audio items are addable (Scope A). The button sits after Play and
        // opens an inline slot picker rendered under the actions; both nodes are rebuilt on every
        // renderItem, so a stale picker can never survive into another item.
        var plStatus = null;
        var plPicker = null;

        if (item.Type === 'Audio') {
            plStatus = ui().el('p', 'playlist-status', '');
            plStatus.style.display = 'none';

            plPicker = ui().el('div', 'playlist-picker');

            var addToPlaylist = ui().el('button', 'secondary', 'Add to playlist');
            addToPlaylist.type = 'button';
            addToPlaylist.onclick = function () {
                // Toggle: a second press collapses an open picker and pops its back entry, so
                // the picker can never leave more than one handler on the stack.
                if (plPicker.firstChild) {
                    closePlaylistPicker(plPicker, addToPlaylist, true);
                    return false;
                }

                openPlaylistPicker(plPicker, plStatus, addToPlaylist, item);
                return false;
            };
            actions.appendChild(addToPlaylist);
        }

        info.appendChild(actions);

        var itemError = ui().el('p', 'error-slot', '\u00a0');
        itemError.id = 'itemError';
        itemError.style.display = 'none';
        info.appendChild(itemError);

        // Inline add-to-playlist status + slot picker (only rendered for audio items). Kept as
        // per-render nodes so navigating away tears them down with the rest of the item view.
        if (plStatus && plPicker) {
            info.appendChild(plStatus);
            info.appendChild(plPicker);
        }

        wrapper.appendChild(info);
        container.appendChild(wrapper);

        focusFirstCard(container);
    }

    function openItem(itemId, userId, back, list, listIndex) {
        var itemView = document.querySelector('#itemView');

        setBackHandler(function () {
            if (back) {
                back();
            } else {
                openViews(userId);
            }
        });

        ui().showView('itemView');
        ui().showLoading(itemView);

        api().getItem(itemId, userId, function (item) {
            renderItem(itemView, item || {}, userId, back, list, listIndex);
        }, function (err) {
            ui().showError(itemView, err);
        });
    }

    function openEpisodes(seriesId, userId, back) {
        var browse = document.querySelector('#browseView');

        setBackHandler(function () {
            if (back) {
                back();
            } else {
                openItem(seriesId, userId);
            }
        });

        ui().showView('browseView');
        ui().showLoading(browse);

        api().getEpisodes(seriesId, userId, function (data) {
            var items = (data && data.Items) ? data.Items : [];

            ui().clear(browse);

            var header = ui().el('div', 'browse-header');
            header.appendChild(ui().el('h1', 'browse-title', 'Episodes'));
            browse.appendChild(header);

            var list = ui().el('div', 'card-list');
            browse.appendChild(list);

            renderCardList(list, items, function (item) {
                openItem(item.Id, userId, function () {
                    openEpisodes(seriesId, userId, back);
                }, items, items.indexOf(item));
            }, 'No episodes found.');

            focusFirstCard(browse);
        }, function (err) {
            ui().showError(browse, err);
        });
    }

    function openResume(userId) {
        var browse = document.querySelector('#browseView');

        setBackHandler(function () {
            openViews(userId);
        });

        ui().showView('browseView');
        ui().showLoading(browse);

        api().getResume(userId, function (data) {
            var items = (data && data.Items) ? data.Items : [];

            ui().clear(browse);

            var header = ui().el('div', 'browse-header');
            header.appendChild(ui().el('h1', 'browse-title', 'Continue Watching'));
            browse.appendChild(header);

            var list = ui().el('div', 'card-list');
            browse.appendChild(list);

            renderCardList(list, items, function (item) {
                openItem(item.Id, userId, function () {
                    openResume(userId);
                }, items, items.indexOf(item));
            }, 'Nothing to continue watching.');

            focusFirstCard(browse);
        }, function (err) {
            ui().showError(browse, err);
        });
    }

    /* Artist-centric music browsing (increment 1). A UI layer over the existing catalog
     * plumbing: album rows open through the generic items view, Folders through the
     * folder-grouped browse, playback through the ordered-list session, and failures through
     * the generic #itemError slot. No new endpoint and no new localStorage key. */

    // Single/EP/album thresholds, kept in one place and overridable through musicSetConfig().
    var MUSIC_CONFIG = { epMaxTracks: 6, albumMinMs: 1800000 };

    var MUSIC_CHIPS = ['All', 'A-F', 'G-M', 'N-T', 'U-Z', 'Folders'];

    // Single-entry cache of the rendered music home (the lastGrouped pattern), so Back from an
    // artist or the grouped browse re-renders synchronously without refetching. Shape:
    // {libraryId, userId, libraryName, artists, total, startIndex, chip, shelf}.
    var musicHome = null;

    // The artist detail currently rendered (only one artist view can be open at a time).
    var artistCache = null;

    // One status line shared by the two music screens (only one is visible at a time).
    var musicStatusText = '';

    function isViewActive(id) {
        var view = document.querySelector('#' + id);

        return !!(view && (' ' + view.className + ' ').indexOf(' active ') >= 0);
    }

    /* Config surface. musicGetConfig() returns a copy; musicSetConfig() merges only the known
     * numeric keys and returns the resulting config. */

    function musicGetConfig() {
        return { epMaxTracks: MUSIC_CONFIG.epMaxTracks, albumMinMs: MUSIC_CONFIG.albumMinMs };
    }

    function musicSetConfig(partial) {
        if (partial && typeof partial === 'object') {
            if (typeof partial.epMaxTracks === 'number') {
                MUSIC_CONFIG.epMaxTracks = partial.epMaxTracks;
            }
            if (typeof partial.albumMinMs === 'number') {
                MUSIC_CONFIG.albumMinMs = partial.albumMinMs;
            }
        }

        return musicGetConfig();
    }

    // classify(name, trackCount, totalMs) -> 'single' | 'ep' | 'album'. The name wins over the
    // duration heuristic, one track is a single, a small count is an EP unless it runs long, and
    // an unknown count is an album so nothing is ever hidden in the EP bucket.
    function musicClassify(name, trackCount, totalMs) {
        var lowered = String(name || '').toLowerCase();

        if (/\bsingle\b/.test(lowered)) {
            return 'single';
        }
        if (/\bep\b/.test(lowered)) {
            return 'ep';
        }
        if (trackCount === 1) {
            return 'single';
        }
        if (typeof trackCount !== 'number' || !isFinite(trackCount)) {
            return 'album';
        }
        if (trackCount >= 2 && trackCount <= MUSIC_CONFIG.epMaxTracks) {
            if (typeof totalMs === 'number' && isFinite(totalMs) && totalMs >= MUSIC_CONFIG.albumMinMs) {
                return 'album';
            }
            return 'ep';
        }

        return 'album';
    }

    // Sum of a section's track run times in ms (Jellyfin ticks are 10000 per ms), or null when
    // no track exposes RunTimeTicks (the duration clause is then skipped).
    function sectionTotalMs(media) {
        var total = 0;
        var found = false;

        for (var i = 0; media && i < media.length; i++) {
            var ticks = media[i] && media[i].RunTimeTicks;

            if (typeof ticks === 'number' && isFinite(ticks)) {
                total += ticks / 10000;
                found = true;
            }
        }

        return found ? total : null;
    }

    // Runtime-built views, exactly like ensurePlaylistsView(): the shell index.html is not
    // changed, the view ships in the payload, and ui.showView() overwrites className so all
    // styling must key off the id.
    function ensureMusicView() {
        if (document.querySelector('#musicView')) {
            return;
        }

        var view = document.createElement('div');
        view.id = 'musicView';
        view.className = 'view';
        document.body.appendChild(view);
    }

    function ensureArtistView() {
        if (document.querySelector('#artistView')) {
            return;
        }

        var view = document.createElement('div');
        view.id = 'artistView';
        view.className = 'view';
        document.body.appendChild(view);
    }

    // The side rail is static and must never be tabbable: plain div/span nodes only, so the
    // D-pad walk skips it and lands on real buttons.
    function buildMusicRail() {
        var rail = ui().el('div', 'music-rail');
        rail.appendChild(ui().el('div', 'music-rail-brand', 'MiChelly'));

        var nav = ['Home', 'Search', 'Your Library'];

        for (var i = 0; i < nav.length; i++) {
            rail.appendChild(ui().el('div', 'music-rail-nav-item', nav[i]));
        }

        rail.appendChild(ui().el('div', 'music-rail-note', 'Music'));

        return rail;
    }

    // Back is first in DOM order, so an Up press still reaches it; withSearch adds the static
    // (non-tabbable) search surface, which is visual only in increment 1.
    function buildMusicTopbar(titleText, withSearch) {
        var topbar = ui().el('div', 'music-topbar');

        var back = ui().el('button', 'music-back', 'Back');
        back.type = 'button';
        back.onclick = function () {
            ui().handleBack();
            return false;
        };
        topbar.appendChild(back);

        topbar.appendChild(ui().el('div', 'music-title', titleText));

        if (withSearch) {
            topbar.appendChild(ui().el('div', 'music-search', 'What do you want to play?'));
        }

        return topbar;
    }

    // Seeds the D-pad into the freshly built content; falls back to the Back button when the
    // screen has nothing focusable (an empty grid with no pager), so focus never sticks to a
    // control of a now-hidden view.
    function focusMusicScreen(content, backButton) {
        focusFirstCard(content);

        var active = document.activeElement;

        if (!active || active === document.body || !active.offsetWidth || !active.offsetHeight) {
            if (backButton) {
                backButton.focus();
            }
        }
    }

    /* Music home ---------------------------------------------------------- */

    function openMusicHome(libraryId, userId, libraryName) {
        musicHome = {
            libraryId: libraryId,
            userId: userId,
            libraryName: libraryName || 'Music',
            artists: [],
            total: null,
            startIndex: 0,
            chip: 'All',
            shelf: [],
            artistsRecursive: false
        };
        musicStatusText = '';

        showMusicHome();

        fetchMusicArtists(false, 0, false);
        loadMusicShelf();
    }

    // Re-enters the music home with exactly one back handler (Back -> the library list) and a
    // synchronous re-render from cache. Used on entry and as the Back target from artists and
    // the grouped browse, so re-entry never leaves the stack empty.
    function showMusicHome() {
        if (!musicHome) {
            return;
        }

        musicStatusText = '';

        setBackHandler(function () {
            openViews(musicHome.userId);
        });

        renderMusicHome(false);
    }

    function renderMusicHome(focusPager) {
        if (!musicHome) {
            return;
        }

        ensureMusicView();

        var view = document.querySelector('#musicView');
        ui().showView('musicView');
        ui().clear(view);

        view.appendChild(buildMusicRail());

        var main = ui().el('div', 'music-main');
        view.appendChild(main);

        var topbar = buildMusicTopbar(musicHome.libraryName || 'Music', true);
        main.appendChild(topbar);

        var chips = ui().el('div', 'music-chips');

        for (var c = 0; c < MUSIC_CHIPS.length; c++) {
            (function (label) {
                var active = (label !== 'Folders') && (musicHome.chip === label);
                var chip = ui().el('button', 'music-chip' + (active ? ' is-active' : ''), label);
                chip.type = 'button';
                chip.onclick = function () {
                    // Folders is a navigation action, not a filter: it opens the existing
                    // folder-grouped browse, and Back returns to the music home.
                    if (label === 'Folders') {
                        openItems(musicHome.libraryId, musicHome.userId, {
                            title: musicHome.libraryName,
                            ParentId: musicHome.libraryId,
                            grouped: true,
                            back: function () {
                                showMusicHome();
                            }
                        });
                        return false;
                    }

                    musicHome.chip = label;
                    musicStatusText = '';
                    renderMusicHome(false);
                    return false;
                };
                chips.appendChild(chip);
            })(MUSIC_CHIPS[c]);
        }

        main.appendChild(chips);

        var content = ui().el('div', 'music-content');
        main.appendChild(content);

        // The shelf band is only rendered when it has items (never an empty band).
        if (musicHome.shelf && musicHome.shelf.length) {
            content.appendChild(buildMusicShelf());
        }

        content.appendChild(buildArtistGrid());

        // Continuation: only when the server reports more artists than are loaded.
        var showMore = null;

        if (typeof musicHome.total === 'number' && musicHome.artists.length < musicHome.total) {
            var pager = ui().el('div', 'pager');
            showMore = ui().el('button', 'pager-btn', 'Show more');
            showMore.type = 'button';

            var fetchingMore = false;

            showMore.onclick = function () {
                if (fetchingMore) {
                    return false;
                }

                fetchingMore = true;
                showMore.textContent = 'Loading...';
                fetchMusicArtists(musicHome.artistsRecursive, musicHome.startIndex, true);
                return false;
            };
            pager.appendChild(showMore);
            content.appendChild(pager);
        }

        var status = ui().el('div', 'music-status', musicStatusText || '');
        status.style.display = musicStatusText ? '' : 'none';
        content.appendChild(status);

        if (focusPager && showMore) {
            showMore.focus();
        } else {
            focusMusicScreen(content, topbar.querySelector('.music-back'));
        }
    }

    // One page of artists (Limit 100). An empty first page retries once against the
    // MusicArtist entities (Recursive), then stores into the cache. ES5 callback chain only.
    function fetchMusicArtists(recursive, startIndex, isMore) {
        var home = musicHome;

        if (!home) {
            return;
        }

        api().getItems({
            ParentId: home.libraryId,
            Recursive: recursive,
            IncludeItemTypes: recursive ? 'MusicArtist' : 'Folder,MusicArtist',
            SortBy: 'SortName',
            SortOrder: 'Ascending',
            Fields: 'PrimaryImageAspectRatio,ParentId',
            StartIndex: startIndex,
            Limit: 100
        }, function (data) {
            if (musicHome !== home) {
                return;
            }

            var items = (data && data.Items) ? data.Items : [];

            // A folder-only library can answer with 0 items on the non-recursive pass; retry
            // once against the MusicArtist entities before giving up, and remember the variant so
            // the Show-more button keeps paging the response that actually returned rows.
            if (!recursive && !isMore && startIndex === 0 && !items.length) {
                home.artistsRecursive = true;
                fetchMusicArtists(true, 0, false);
                return;
            }

            for (var i = 0; i < items.length; i++) {
                home.artists.push(items[i]);
            }

            home.startIndex = startIndex + items.length;
            home.total = (data && typeof data.TotalRecordCount === 'number') ? data.TotalRecordCount : home.startIndex;

            if (isViewActive('musicView')) {
                renderMusicHome(isMore);
            }
        }, function (err) {
            if (musicHome !== home) {
                return;
            }

            if (!isViewActive('musicView')) {
                return;
            }

            if (isMore) {
                // Keep the already-rendered grid; surface the failure inline instead.
                musicStatusText = 'Could not load more artists.';
                renderMusicHome(true);
                return;
            }

            // Never show a blank screen.
            ui().showError(document.querySelector('#musicView .music-content'), err);
        });
    }

    function filterMusicArtists(artists, chip) {
        if (!artists) {
            return [];
        }

        if (chip === 'All' || chip === 'Folders') {
            return artists.slice(0);
        }

        var out = [];

        for (var i = 0; i < artists.length; i++) {
            var name = String((artists[i] && (artists[i].SortName || artists[i].Name)) || '');
            var first = name.charAt(0).toUpperCase();
            var match = false;

            if (chip === 'A-F') {
                match = first >= 'A' && first <= 'F';
            } else if (chip === 'G-M') {
                match = first >= 'G' && first <= 'M';
            } else if (chip === 'N-T') {
                match = first >= 'N' && first <= 'T';
            } else if (chip === 'U-Z') {
                match = first >= 'U' && first <= 'Z';
            }

            if (match) {
                out.push(artists[i]);
            }
        }

        return out;
    }

    function buildArtistGrid() {
        var grid = ui().el('div', 'card-list music-grid');
        var artists = filterMusicArtists(musicHome.artists, musicHome.chip);

        if (!artists.length) {
            // Only claim "no artists" once the first load has settled; while the fetch is in
            // flight the grid is simply empty.
            if (musicHome.total !== null) {
                grid.appendChild(ui().el('div', 'music-empty',
                    musicHome.artists.length ? 'No artists in this range.' : 'No artists found.'));
            }
            return grid;
        }

        for (var i = 0; i < artists.length; i++) {
            grid.appendChild(buildArtistCard(artists[i], musicHome.userId));
        }

        return grid;
    }

    function buildArtistCard(artist, userId) {
        var button = ui().el('button', 'card card-artist');
        button.type = 'button';

        var poster = ui().el('div', 'card-poster');
        var img = document.createElement('img');
        img.alt = artist.Name || '';
        poster.appendChild(img);
        button.appendChild(poster);

        var tag = artist.ImageTags && artist.ImageTags.Primary;
        ui().renderImage(img, tag ? api().imageUrl(artist.Id, 'Primary', { maxWidth: 320, tag: tag }) : null,
            artist.Name || '');

        button.appendChild(ui().el('div', 'card-title', artist.Name || 'Untitled'));

        // The album count is shown only when the server exposes it (the home fetch does not
        // request ChildCount); never invent a count.
        var count = null;

        if (typeof artist.ChildCount === 'number') {
            count = artist.ChildCount;
        } else if (typeof artist.RecursiveItemCount === 'number') {
            count = artist.RecursiveItemCount;
        }

        button.appendChild(ui().el('div', 'card-sub',
            count === null ? 'Artist' : 'Artist - ' + count + ' albums'));

        button.onclick = function () {
            openArtist(artist, userId);
            return false;
        };

        return button;
    }

    // "Jump back in" shelf: reuses the Resume endpoint, keeps the playable music entries (max
    // 8), and stays hidden entirely when the list is empty or the call fails.
    function loadMusicShelf() {
        var home = musicHome;

        if (!home) {
            return;
        }

        api().getResume(home.userId, function (data) {
            if (musicHome !== home) {
                return;
            }

            var raw = (data && data.Items) ? data.Items : [];
            var shelf = [];

            for (var i = 0; i < raw.length && shelf.length < 8; i++) {
                if (raw[i] && (raw[i].Type === 'Audio' || raw[i].Type === 'MusicAlbum')) {
                    shelf.push(raw[i]);
                }
            }

            home.shelf = shelf;

            if (shelf.length && isViewActive('musicView')) {
                insertMusicShelf();
            }
        }, function () {
            if (musicHome !== home) {
                return;
            }

            home.shelf = [];
        });
    }

    // Inserts or replaces the shelf in place, before the artist grid, so a late Resume response
    // does not steal D-pad focus through a full re-render.
    function insertMusicShelf() {
        var content = document.querySelector('#musicView .music-content');
        var grid = content ? content.querySelector('.music-grid') : null;

        if (!content || !grid) {
            return;
        }

        var existing = content.querySelector('.music-shelf');

        if (existing) {
            content.removeChild(existing);
        }

        if (musicHome && musicHome.shelf && musicHome.shelf.length) {
            content.insertBefore(buildMusicShelf(), grid);
        }
    }

    function buildMusicShelf() {
        var shelf = ui().el('div', 'music-shelf');

        var head = ui().el('div', 'folder-section-head');
        head.appendChild(ui().el('h2', 'folder-section-title', 'Jump back in'));
        shelf.appendChild(head);

        var list = ui().el('div', 'card-list');

        for (var i = 0; i < musicHome.shelf.length; i++) {
            list.appendChild(makeCard(musicHome.shelf[i], playShelfItem));
        }

        shelf.appendChild(list);

        return shelf;
    }

    // Audio items join an audio-only ordered session. A MusicAlbum would be misrouted by the
    // session to the video player, so it opens its album through the generic items view instead.
    function playShelfItem(item) {
        if (!musicHome) {
            return;
        }

        if (item.Type !== 'Audio') {
            openItems(item.Id, musicHome.userId, {
                title: item.Name,
                ParentId: item.Id,
                Recursive: false,
                IncludeItemTypes: 'Audio',
                Fields: 'PrimaryImageAspectRatio',
                back: function () {
                    showMusicHome();
                }
            });
            return;
        }

        var queue = [];
        var index = -1;
        var i;

        for (i = 0; i < musicHome.shelf.length; i++) {
            if (musicHome.shelf[i].Type === 'Audio') {
                queue.push(musicHome.shelf[i]);
            }
        }

        for (i = 0; i < queue.length; i++) {
            if (queue[i].Id === item.Id) {
                index = i;
                break;
            }
        }

        if (index < 0) {
            return;
        }

        musicStatusText = '';
        ensureItemErrorSlot();
        playlistStart(queue, index, musicHome.userId, function () {
            renderMusicHome(false);
            musicMirrorPlayError(function () {
                renderMusicHome(false);
            }, 'musicView');
        });
    }

    /* Artist detail ------------------------------------------------------- */

    function openArtist(artist, userId) {
        if (!artist || !artist.Id) {
            return;
        }

        artistCache = {
            artistId: artist.Id,
            artistName: artist.Name || 'Artist',
            userId: userId,
            albums: [],
            singles: [],
            favorites: [],
            loaded: false
        };

        showArtist();

        var cache = artistCache;

        // One settled artist response feeds this step. cache.loaded flips true here so the three
        // sections stop showing the loading placeholder.
        function applyArtistItems(items) {
            var split = splitArtistSections(buildGroupedModel(items, artist.Id), artist.Id);

            cache.albums = split.albums;
            cache.singles = split.singles;
            cache.loaded = true;

            if (isViewActive('artistView')) {
                renderArtist();
            }

            loadArtistFavorites(artist.Id, userId);
        }

        function onArtistFailure(err) {
            if (artistCache !== cache) {
                return;
            }

            cache.loaded = true;
            ui().showError(document.querySelector('#artistView .music-content'), err);
        }

        api().getItems({
            ParentId: artist.Id,
            UserId: userId,
            Recursive: true,
            IncludeItemTypes: 'Folder,MusicAlbum,Audio',
            SortBy: 'SortName',
            SortOrder: 'Ascending',
            Fields: 'PrimaryImageAspectRatio,ParentId,ChildCount',
            StartIndex: 0,
            Limit: 300
        }, function (data) {
            if (artistCache !== cache) {
                return;
            }

            var items = (data && data.Items) ? data.Items : [];

            if (items.length) {
                applyArtistItems(items);
                return;
            }

            // A virtual MusicArtist entity (Jellyfin's IsAccessedByName) exposes no children via
            // ParentId, so an empty result retries once against the artist-id filter. A second
            // empty result is accepted as the honest empty state (no third variant, no loop).
            api().getItems({
                AlbumArtistIds: artist.Id,
                UserId: userId,
                Recursive: true,
                IncludeItemTypes: 'Folder,MusicAlbum,Audio',
                SortBy: 'SortName',
                SortOrder: 'Ascending',
                Fields: 'PrimaryImageAspectRatio,ParentId,ChildCount',
                StartIndex: 0,
                Limit: 300
            }, function (fallbackData) {
                if (artistCache !== cache) {
                    return;
                }

                var fallbackItems = (fallbackData && fallbackData.Items) ? fallbackData.Items : [];
                applyArtistItems(fallbackItems);
            }, onArtistFailure);
        }, onArtistFailure);
    }

    // Re-enters the artist view with exactly one back handler (Back -> cached music home) and a
    // synchronous re-render from cache, so the album drill-down's Back never leaves the stack empty.
    function showArtist() {
        if (!artistCache) {
            return;
        }

        musicStatusText = '';

        setBackHandler(function () {
            if (musicHome) {
                showMusicHome();
            } else {
                openViews(artistCache.userId);
            }
        });

        renderArtist();
    }

    function renderArtist() {
        if (!artistCache) {
            return;
        }

        ensureArtistView();

        var view = document.querySelector('#artistView');
        ui().showView('artistView');
        ui().clear(view);

        view.appendChild(buildMusicRail());

        var main = ui().el('div', 'music-main');
        view.appendChild(main);

        var topbar = buildMusicTopbar(artistCache.artistName, false);
        main.appendChild(topbar);

        var content = ui().el('div', 'music-content');
        main.appendChild(content);

        var loading = !artistCache.loaded;
        content.appendChild(buildMusicSection('Albums', artistCache.albums, loading ? 'Loading...' : 'No albums.'));
        content.appendChild(buildMusicSection('Singles and EPs', artistCache.singles, loading ? 'Loading...' : 'No singles or EPs.'));
        content.appendChild(buildMusicSection('Favorites', artistCache.favorites, loading ? 'Loading...' : 'No favorites yet.'));

        var status = ui().el('div', 'music-status', musicStatusText || '');
        status.style.display = musicStatusText ? '' : 'none';
        content.appendChild(status);

        focusMusicScreen(content, topbar.querySelector('.music-back'));
    }

    // One model.sections entry is one album; its media array is the authoritative track list.
    // rootMedia/orphans (Audio sitting directly on the artist) become one implicit '(Singles)'
    // album whose id is the artist folder, so the row still opens the generic items view.
    function splitArtistSections(model, artistId) {
        var albums = [];
        var singles = [];
        var i, section, kind;

        for (i = 0; i < model.sections.length; i++) {
            section = model.sections[i];
            kind = musicClassify(section.name, section.media.length, sectionTotalMs(section.media));

            if (kind === 'album') {
                albums.push(section);
            } else {
                singles.push(section);
            }
        }

        var loose = (model.rootMedia || []).concat(model.orphans || []);

        if (loose.length) {
            singles.push({
                id: artistId,
                name: '(Singles)',
                path: '',
                media: loose,
                loose: true
            });
        }

        return { albums: albums, singles: singles };
    }

    function buildMusicSection(title, sections, emptyMsg) {
        var sectionEl = ui().el('div', 'music-section');

        var head = ui().el('div', 'music-section-head');
        head.appendChild(ui().el('h2', 'music-section-title', title));
        sectionEl.appendChild(head);

        if (!sections || !sections.length) {
            // A non-tabbable line, never a dead button.
            sectionEl.appendChild(ui().el('div', 'music-empty', emptyMsg));
            return sectionEl;
        }

        for (var i = 0; i < sections.length; i++) {
            sectionEl.appendChild(buildMusicRow(sections[i], artistCache.userId));
        }

        return sectionEl;
    }

    function buildMusicRow(section, userId) {
        var row = ui().el('div', 'playlist-row music-row');

        var thumb = ui().el('button', 'music-row-thumb');
        thumb.type = 'button';

        var img = document.createElement('img');
        img.alt = section.name || '';
        thumb.appendChild(img);

        var image = firstMediaImage(section.media);
        ui().renderImage(img, image ? api().imageUrl(image.id, 'Primary', { maxWidth: 320, tag: image.tag }) : null,
            section.name || '');

        thumb.appendChild(ui().el('span', 'music-row-title', section.name || 'Untitled'));

        thumb.onclick = function () {
            // A loose favorited track has no folder to descend into, so open its own detail
            // through the generic path; every other row is an album folder.
            if (section.track === true) {
                openItem(section.media[0].Id, userId, function () {
                    showArtist();
                });
                return false;
            }

            // Reuses the generic items view and its ordered playback; Back returns to the artist.
            openItems(section.id, userId, {
                title: section.name,
                ParentId: section.id,
                Recursive: false,
                IncludeItemTypes: 'Audio',
                Fields: 'PrimaryImageAspectRatio',
                back: function () {
                    showArtist();
                }
            });
            return false;
        };
        row.appendChild(thumb);

        // An album-only favorite carries no in-place tracks in this response, so a Play button
        // would have an empty queue; the thumb opens the album (whose own Play works) instead.
        if (section.albumOnly !== true) {
            var play = ui().el('button', 'music-play-btn', 'Play');
            play.type = 'button';
            play.onclick = function () {
                musicStatusText = '';
                ensureItemErrorSlot();
                playlistStart(section.media.slice(0), 0, userId, function () {
                    renderArtist();
                    musicMirrorPlayError(function () {
                        renderArtist();
                    }, 'artistView');
                });
                return false;
            };
            row.appendChild(play);
        }

        return row;
    }

    // The grouped model exposes album folders without their own image tags; use the first track
    // that carries a Primary image, else null so the text fallback takes over.
    function firstMediaImage(media) {
        for (var i = 0; media && i < media.length; i++) {
            if (media[i] && media[i].Id && media[i].ImageTags && media[i].ImageTags.Primary) {
                return { id: media[i].Id, tag: media[i].ImageTags.Primary };
            }
        }

        return null;
    }

    function loadArtistFavorites(artistId, userId) {
        var cache = artistCache;

        api().getItems({
            ParentId: artistId,
            UserId: userId,
            Recursive: true,
            Filters: 'IsFavorite',
            IncludeItemTypes: 'MusicAlbum,Audio',
            Fields: 'PrimaryImageAspectRatio,ParentId,ChildCount'
        }, function (data) {
            if (artistCache !== cache) {
                return;
            }

            var items = (data && data.Items) ? data.Items : [];
            var model = buildGroupedModel(items, artistId);
            var favorites = [];
            var seen = {};
            var i, item;
            var loose;

            // Favorited albums that directly hold favorited media.
            for (i = 0; i < model.sections.length; i++) {
                favorites.push(model.sections[i]);
                seen[String(model.sections[i].id)] = true;
            }

            // Favorited albums whose tracks are NOT favorited produce no section above (the
            // section is emitted only for a folder that directly holds media in this response),
            // and a folder type is neither rootMedia nor an orphan - so emit one row per returned
            // album to keep it visible.
            for (i = 0; i < items.length; i++) {
                item = items[i];

                if (item && item.Type === 'MusicAlbum' && item.Id && !seen.hasOwnProperty(String(item.Id))) {
                    seen[String(item.Id)] = true;
                    favorites.push({
                        id: item.Id,
                        name: item.Name || 'Untitled',
                        path: '',
                        media: [],
                        albumOnly: true
                    });
                }
            }

            // Favorited tracks whose parent album was not itself returned.
            loose = (model.rootMedia || []).concat(model.orphans || []);

            for (i = 0; i < loose.length; i++) {
                favorites.push({
                    id: loose[i].AlbumId || loose[i].Id,
                    name: loose[i].Name || 'Untitled',
                    path: '',
                    media: [loose[i]],
                    track: true
                });
            }

            cache.favorites = favorites;

            if (isViewActive('artistView')) {
                renderArtist();
            }
        }, function () {
            if (artistCache !== cache) {
                return;
            }

            // A favorites failure must not break the other two sections: show the empty line.
            cache.favorites = [];

            if (isViewActive('artistView')) {
                renderArtist();
            }
        });
    }

    // The players end a failed session by stopping first (which runs our return target back onto
    // the music screen) and write #itemError after; a failed PlaybackInfo additionally re-shows
    // the shell #itemView. One tick later, surface a non-empty #itemError on the music status
    // line, restoring the music screen when the player stranded the user. #itemError is a
    // foreign node: never write or clear it (same reasoning as mirrorManagePlayError).
    function musicMirrorPlayError(rerender, viewId) {
        ensureItemErrorSlot();

        setTimeout(function () {
            var slot = document.querySelector('#itemError');

            if (!slot) {
                return;
            }

            var msg = String(slot.textContent || '').replace(/^\s+|\s+$/g, '');

            if (!msg) {
                return;
            }

            // Nothing to mirror when the user has left the music flow entirely.
            if (!isViewActive(viewId) && !isViewActive('itemView')) {
                return;
            }

            musicStatusText = msg;
            rerender();
        }, 0);
    }

    namespace.catalog = {
        openViews: openViews,
        openItems: openItems,
        openItem: openItem,
        openEpisodes: openEpisodes,
        openResume: openResume
    };

    // Artist-centric music browsing (increment 1). openArtist is exposed for callers that
    // already hold an artist node; the home grid routes through it internally.
    namespace.music = {
        openHome: openMusicHome,
        openArtist: openArtist,
        getConfig: musicGetConfig,
        setConfig: musicSetConfig
    };

    namespace.playlist = {
        isActive: playlistIsActive,
        start: playlistStart,
        advance: playlistAdvance,
        next: playlistNext,
        previous: playlistPrevious,
        hasNext: playlistHasNext,
        hasPrevious: playlistHasPrevious,
        stop: playlistEnd
    };

    // User-built playlist slots (plural). The session API above is untouched; this is the
    // storage surface only (keying + list/read/add/remove/clear), backed by localStorage.
    namespace.playlists = {
        setServerId: setServerId,
        listSlots: listSlots,
        getSlotItems: getSlotItems,
        addToSlot: addToSlot,
        removeAt: removeAt,
        clearSlot: clearSlot
    };
})(Michelly);
