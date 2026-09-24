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

    // Playback-mode state (repeat / shuffle). The defaults below reproduce the historical
    // in-order behaviour exactly: no repeat, no shuffle, an identity play order.
    var listRepeatMode = 'off';   // 'off' | 'all' | 'one'
    var listShuffle = false;
    var playOrder = null;         // array of indices into listItems defining visit sequence
    var orderPos = -1;            // pointer into playOrder of the current item

    // Indices heard so far in the current pass, through ANY route (the order walk, or a
    // queue entry matched by Id): passVisited[index] === true. A lazily created boolean
    // array sized to listItems.length (all false at creation); every pass reset sets the
    // variable to null and the next mark rebuilds it. Unlike a scalar high-water mark it
    // can express holes: the shuffle-off rebuild resumes the pass's ascending
    // not-yet-played remainder — never replays a heard track, never strands an unheard
    // one.
    var passVisited = null;

    // Mark one ORIGINAL list index as heard in the current pass. The boolean array is
    // created (all false) on the first mark; a negative index marks nothing (a queue
    // entry that matches no list member). Re-marks are idempotent (repeat-one replays).
    function markVisited(index) {
        if (!listItems || index < 0) {
            return;
        }

        if (!passVisited || passVisited.length !== listItems.length) {
            var fresh = [];

            for (var i = 0; i < listItems.length; i++) {
                fresh.push(false);
            }

            passVisited = fresh;
        }

        if (index < passVisited.length) {
            passVisited[index] = true;
        }
    }

    // Session queue (head first = next to play), in-memory only: it never touches
    // localStorage and is cleared on every session teardown.
    var listQueue = [];

    // Pre-session pending queue: "Play next"/"Add to queue" recorded from the item view
    // while NO session is active (a session queue cannot exist yet). Head-first order is
    // preserved. Pending lifetime: it survives browsing AND session teardowns and is
    // adopted (moved into listQueue) ONLY by a start whose items are all Audio — a video
    // or mixed start skips adoption so the queue stays intact for the next audio session.
    // It is cleared by playlistClearQueue() pre-session, cleared on every server switch
    // (setServerId: stale Ids would fail PlaybackInfo on the new server), and dies with
    // nothing else. In-memory only, never persisted.
    var pendingQueue = [];

    // The item actually playing right now. listIndex stays authoritative for list items,
    // but a queue item may not live in listItems at all, so repeat-one replays this.
    var currentItem = null;

    // Optional end-of-session destination (Scope A: user playlists return to the manage
    // view). A view-id string or a function; null keeps the historical #itemView default.
    var listReturnTarget = null;

    function playlistIsActive() {
        return listActive;
    }

    // True when the array is non-empty and EVERY item carries Type === 'Audio'. Used to
    // gate pending-queue adoption (an all-Audio start) — video/mixed lists must not
    // swallow the pre-session queue.
    function allAudioItems(items) {
        if (!items || !items.length) {
            return false;
        }

        for (var i = 0; i < items.length; i++) {
            if (!items[i] || items[i].Type !== 'Audio') {
                return false;
            }
        }

        return true;
    }

    // Index of the first list entry with the given Id, or -1. An adopted queue entry is
    // the fetched DETAIL object, not the same reference as the list entry, so identity
    // comparison (indexOf) cannot be used for Id-based "was this heard?" checks.
    function findIndexById(items, id) {
        if (!items || !items.length || !id) {
            return -1;
        }

        for (var i = 0; i < items.length; i++) {
            if (items[i] && items[i].Id && String(items[i].Id) === String(id)) {
                return i;
            }
        }

        return -1;
    }

    // Identity visit order [0..n-1] over the captured list page.
    function buildInOrder() {
        var n = listItems ? listItems.length : 0;
        var order = [];

        for (var i = 0; i < n; i++) {
            order.push(i);
        }

        return order;
    }

    // Fisher-Yates shuffle, in place (Math.random is the only randomness used).
    function shuffleArray(arr) {
        for (var i = arr.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var tmp = arr[i];
            arr[i] = arr[j];
            arr[j] = tmp;
        }
    }

    // A fresh full permutation for a repeat-all wrap. When the track that just played is
    // excluded from the FIRST slot, the same track never repeats back-to-back.
    function shuffledOrder(excludeFirst) {
        var order = buildInOrder();

        shuffleArray(order);

        if (excludeFirst !== null && excludeFirst !== undefined &&
                order.length > 1 && order[0] === excludeFirst) {
            for (var i = 1; i < order.length; i++) {
                if (order[i] !== excludeFirst) {
                    order[0] = order[i];
                    order[i] = excludeFirst;
                    break;
                }
            }
        }

        return order;
    }

    // Shuffle toggle ON, mid-session: the current item leads, then a random permutation
    // of ONLY the not-yet-visited tail of the current pass (playOrder past the walk
    // pointer). The tail's not-yet-heard guarantee is the walk's: a track heard through a
    // QUEUE entry (matched by Id, not the walk) may still sit in the tail, and
    // shuffledFromWalk does not consult passVisited — the visited set guards only the
    // reverse toggle (the shuffle-off rebuild in playlistSetShuffle). Toggling ON can
    // never re-queue a walk-visited track: already-visited indices rejoin only on the
    // next wrap (rebuildOrderForWrap), which starts the fresh pass. The anchor is the
    // walk position playOrder[orderPos] — NOT listIndex — because the walk does not
    // move while a queue item plays, so it is the honest current index even then.
    function shuffledFromWalk() {
        var current = (playOrder && orderPos >= 0 && orderPos < playOrder.length)
            ? playOrder[orderPos]
            : listIndex;
        var tail = (playOrder && orderPos >= 0) ? playOrder.slice(orderPos + 1) : [];
        var order = [];
        var i;

        shuffleArray(tail);

        if (typeof current === 'number' && current >= 0) {
            order.push(current);
        }

        for (i = 0; i < tail.length; i++) {
            order.push(tail[i]);
        }

        return order;
    }

    // The list index last visited through the order walk (null when none applies, e.g.
    // while a queue item is the only thing that ever played).
    function lastOrderIndex() {
        if (!playOrder || orderPos < 0 || orderPos >= playOrder.length) {
            return null;
        }

        return playOrder[orderPos];
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

        // Playback-mode / queue teardown: the next session always starts in-order with
        // fresh defaults. listQueue dies with the session; pendingQueue deliberately
        // SURVIVES it — it was queued for future sessions and stays until adopted by a
        // start or explicitly cleared (that is the feature, not a leak).
        listRepeatMode = 'off';
        listShuffle = false;
        listQueue = [];
        currentItem = null;
        playOrder = null;
        orderPos = -1;

        // The pass dies with the session; a new session starts a new pass.
        passVisited = null;

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

    // Plays the item the session should be on right now. Queue consumption is OPT-IN per
    // caller: only advance()/next() pass true. previous() and playlistStart() play the
    // queue-free walk item, so Prev can never pull the queue forward.
    function playCurrent(consumeQueue) {
        var item;

        if (consumeQueue && listQueue.length) {
            // A queued item becomes the current item: listItems[listIndex] is NOT updated
            // (the queue entry may not be in listItems at all) and the order walk stays
            // where it was, so Prev always walks and never plays the queue head
            // (documented limitation: consumed queue entries are not revisited).
            item = listQueue.shift();

            // Same pass, same list: a queue entry that matches a list member by Id counts
            // as heard, so it leaves the shuffle-off not-yet-played remainder exactly as
            // the order walk does (an adopted entry is a detail copy, hence the Id
            // search; no match = not a list member = mark nothing).
            if (item && item.Id) {
                var qIdx = findIndexById(listItems, item.Id);

                if (qIdx >= 0) {
                    markVisited(qIdx);
                }
            }
        } else if (playOrder && orderPos >= 0 && orderPos < playOrder.length &&
                listItems && listItems.length) {
            // listIndex stays authoritative for the item currently playing: existing
            // callers keep reading listItems[listIndex], so keep the two in sync.
            listIndex = playOrder[orderPos];

            markVisited(listIndex);

            item = listItems[listIndex];
        } else {
            item = listItems ? listItems[listIndex] : null;
        }

        playItem(item);
    }

    // Routes the session to a concrete item object. The only difference from the old
    // playCurrent() body is that the item may now be a queue entry rather than a list
    // member; the routing and mixed-kind teardown are byte-identical.
    function playItem(item) {
        currentItem = item || null;

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

        // Playback modes reset per session; the visit order starts as the identity walk
        // over the captured page positioned at the tapped index. This reproduces the
        // historical in-order behaviour exactly (prev may still walk above the start
        // index). orderPos = listIndex makes playOrder[orderPos] === listIndex there.
        listRepeatMode = 'off';
        listShuffle = false;

        // A fresh pass: the visited set starts empty (the start item marks itself when
        // playCurrent() runs below). That also covers "shuffle toggled OFF before
        // anything advanced": the set holds only the start item's mark, so the
        // shuffle-off rebuild anchors on the start walk position and the ascending
        // remainder covers every other index — no skip of the untouched surround.
        passVisited = null;

        // Adopt the pre-session pending queue ONLY for an all-Audio start. The pending
        // queue is Audio-only by construction (the item menu renders only Audio entries),
        // asserted defensively below; the START list decides: an all-Audio session
        // (albums, artist tracks, saved-slot plays) adopts head-first, then drops every
        // adopted entry whose Id matches the just-started track (the tapped item is
        // playing now, so re-queuing it would double-play it). A video or mixed start
        // SKIPS adoption — a queued audio track routed into a video walk would kind-flip
        // to the audio player mid-list and leave hasNext() lit for a foreign entry — and
        // the pending queue stays intact for the next audio session. Adoption is a move,
        // not a copy: an adopted pending queue is empty afterwards.
        listQueue = [];

        if (pendingQueue.length && listItems.length && allAudioItems(listItems)) {
            listQueue = pendingQueue.slice(0);
            pendingQueue = [];

            if (listQueue.length && listItems[listIndex] && listItems[listIndex].Id) {
                var startId = listItems[listIndex].Id;
                var adopted = [];

                for (var aq = 0; aq < listQueue.length; aq++) {
                    if (listQueue[aq].Id !== startId) {
                        adopted.push(listQueue[aq]);
                    }
                }

                listQueue = adopted;
            }
        }
        // Mixed/video start: pendingQueue deliberately untouched.

        currentItem = null;
        playOrder = buildInOrder();
        orderPos = listIndex;

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

    // Repeat-all wrap: a fresh pass over the list. In-order rebuilds the identity walk
    // from the top; shuffle builds a fresh permutation with the just-played track
    // excluded from the FIRST slot, so the same track never repeats back-to-back.
    // (At order length 1 the exclusion is skipped and the same track replays —
    // acceptable, "keep playing forever".)
    function rebuildOrderForWrap() {
        // Either wrap (in-order or shuffled) starts a NEW pass: the visited set resets so
        // the fresh pass replays what the last pass already heard (expected wrap
        // behaviour) and the shuffle-off rebuild anchors on nothing heard before the
        // wrap. playCurrent() re-marks from the first played index of the new pass.
        passVisited = null;

        if (listShuffle) {
            // The exclusion anchor is the item that JUST played. A queue item may have
            // played last (the walk itself did not move), so prefer the current item's
            // own identity in listItems, then its Id (an adopted queue entry is the
            // fetched detail object, NOT the same reference as the list entry), and fall
            // back to the last order-walk position only for a queue entry that matches
            // no list member at all.
            var excludeFirst = (listItems && currentItem) ? listItems.indexOf(currentItem) : -1;

            if (excludeFirst < 0 && listItems && currentItem && currentItem.Id) {
                for (var ex = 0; ex < listItems.length; ex++) {
                    if (listItems[ex] && listItems[ex].Id === currentItem.Id) {
                        excludeFirst = ex;
                        break;
                    }
                }
            }

            playOrder = shuffledOrder(excludeFirst >= 0 ? excludeFirst : lastOrderIndex());
        } else {
            // In-order repeat-all: standard album restart from the top (the fresh-pass
            // visited-set reset already ran at the top of this function).
            playOrder = buildInOrder();
        }

        orderPos = 0;
    }

    // Called by the players' onended while list mode is active. With the modes at their
    // defaults (repeat 'off', no shuffle, empty queue) this is byte-identical to the
    // historical in-order advance: next index, and the session ends at the last item.
    function playlistAdvance() {
        if (!listActive) {
            return false;
        }

        // Repeat-one: replay the current item without consuming the queue or the order
        // walk. Manual Next must NOT replay (see playlistNext), so this branch lives in
        // the auto-advance path only.
        if (listRepeatMode === 'one' && currentItem) {
            stopCurrentPlayer();
            playItem(currentItem);
            return true;
        }

        stopCurrentPlayer();

        // Queue first: the head becomes the current item (playCurrent(true) shifts it).
        if (listQueue.length) {
            playCurrent(true);
            return true;
        }

        if (playOrder && orderPos + 1 < playOrder.length) {
            orderPos++;
            playCurrent();
            return true;
        }

        // End of the order walk: repeat-all wraps into a fresh pass; repeat-off ends
        // the session (the historical behaviour).
        if (listRepeatMode === 'all' && playOrder && playOrder.length > 0) {
            rebuildOrderForWrap();
            playCurrent();
            return true;
        }

        playlistEnd();
        return false;
    }

    // True while there is anything left to play: queue head, a later order position, or
    // (with repeat-all) the wrap itself. At order length 1 + repeat-all the wrap replays
    // the same track — acceptable ("keep playing forever").
    function playlistHasNext() {
        if (!listActive) {
            return false;
        }

        if (listQueue.length) {
            return true;
        }

        if (playOrder && orderPos + 1 < playOrder.length) {
            return true;
        }

        return listRepeatMode === 'all' && !!playOrder && playOrder.length > 0;
    }

    function playlistHasPrevious() {
        return !!listActive && orderPos > 0;
    }

    function playlistNext() {
        if (!listActive || !playlistHasNext()) {
            return false;
        }

        stopCurrentPlayer();

        // Queue first; a queue item becomes the current item and the order walk is left
        // untouched. Manual Next never replays the current item, even under repeat-one.
        if (listQueue.length) {
            playCurrent(true);
            return true;
        }

        if (playOrder && orderPos + 1 < playOrder.length) {
            orderPos++;
            playCurrent();
            return true;
        }

        // At the walk's end with repeat-all, hasNext() was true because of the wrap:
        // manual Next honours it instead of running orderPos past the array.
        if (listRepeatMode === 'all' && playOrder && playOrder.length > 0) {
            rebuildOrderForWrap();
            playCurrent();
            return true;
        }

        return false;
    }

    function playlistPrevious() {
        if (!listActive || !playlistHasPrevious()) {
            return false;
        }

        stopCurrentPlayer();
        orderPos--;
        playCurrent();
        return true;
    }

    /* Playback-mode and session-queue public API. The queues are in-memory only: the
     * session queue is dropped by endSession(); the pre-session pending queue survives
     * until playlistStart() adopts it (or it is explicitly cleared). */

    function playlistGetRepeat() {
        return listRepeatMode;
    }

    // Accepts only the three enum values; anything else leaves the mode unchanged.
    function playlistSetRepeat(mode) {
        if (mode !== 'off' && mode !== 'all' && mode !== 'one') {
            return listRepeatMode;
        }

        listRepeatMode = mode;
        return mode;
    }

    function playlistIsShuffle() {
        return listShuffle;
    }

    // Shuffle ON keeps the current pass (no reset); the shuffle-off rebuild resumes the
    // pass's ascending not-yet-played remainder: never replays a heard track, never
    // strands an unheard one. The OFF anchor is the last ORDER-walk position
    // (lastOrderIndex()), not listIndex — the walk does not move while a queue item
    // plays, so it is the honest basis even then; it leads the rebuilt order only as the
    // item already playing (its slot is walked past, never replayed) and it is itself
    // marked, so the ascending remainder excludes it and everything heard through any
    // route (walk or queue entry matched by Id). When nothing has been heard yet the
    // visited set is null and the remainder is every index in ascending order; the
    // anchor falls back to the current listIndex (or 0) if the walk has not moved at all.
    function playlistSetShuffle(on) {
        listShuffle = !!on;

        if (!listActive || !listItems || !listItems.length) {
            return listShuffle;
        }

        if (listShuffle) {
            // Shuffle ON keeps the pass: the visited set is NOT reset (same pass
            // continues; and per shuffledFromWalk the tail may still hold Id-heard
            // entries the walk has not reached).
            playOrder = shuffledFromWalk();
            orderPos = 0;
        } else {
            // Shuffle OFF: anchor first, then the not-yet-played indices ascending.
            var anchor = lastOrderIndex();

            if (anchor === null || anchor < 0) {
                anchor = (listIndex >= 0) ? listIndex : 0;
            }

            playOrder = [anchor];

            for (var ov = 0; ov < listItems.length; ov++) {
                if (ov !== anchor && (!passVisited || !passVisited[ov])) {
                    playOrder.push(ov);
                }
            }

            orderPos = 0;
        }

        return listShuffle;
    }

    // Returns a copy: callers can never mutate the live queue through the returned array.
    // With no active session the PENDING queue is the visible one — it is what the next
    // start adopts, so the audio card's Queue: n label is always meaningful.
    function playlistGetQueue() {
        return (listActive ? listQueue : pendingQueue).slice();
    }

    // Head-insert (plays before everything else already queued). A session active: into
    // listQueue (as before). No session: into the pending queue, which the next start
    // adopts head-first. Returns the resulting combined queue depth so a caller can show
    // it (0 also reads as falsy for anything still expecting the old boolean contract).
    function playlistPlayNext(item) {
        if (!item) {
            return 0;
        }

        if (listActive) {
            listQueue.unshift(item);
        } else {
            pendingQueue.unshift(item);
        }

        return listQueue.length + pendingQueue.length;
    }

    function playlistAppendQueue(item) {
        if (!item) {
            return 0;
        }

        if (listActive) {
            listQueue.push(item);
        } else {
            pendingQueue.push(item);
        }

        return listQueue.length + pendingQueue.length;
    }

    // Active session: clear the session queue (as before). No session: clear the pending
    // queue. Never touches the queue the other state owns.
    function playlistClearQueue() {
        if (listActive) {
            listQueue = [];
            return;
        }

        pendingQueue = [];
    }

    /* In-app user-built playlists (Tier 3: dynamic named playlists), keyed by server id in
     * localStorage (deliberate alignment with michelly_sessions, auth.js:13-18) and played
     * through the session model above. This store is fork-owned and
     * deliberately NOT an api.js call: server-side playlists are out of scope (TV-only, single
     * client). The manage view and the add-from-item picker are built here in catalog.js so a
     * single owner holds the domain and the back-stack discipline; the runtime-built-view and
     * try/catch localStorage patterns are copied from index.js / auth.js.
     *
     * Store shape: 'michelly_playlists_v2' = { "<serverId>": { playlists: [ {id, name, items:[entry…]} ] } }.
     * The pre-Tier-3 'michelly_playlists' 3-slot store is now READ-ONLY — it is never written or
     * deleted again, so a downgrade to an older build cannot lose TV-side playlists. A v2 record
     * missing for a server is lazily migrated in memory from that legacy store on every read until
     * the first mutation persists it. */

    var PLAYLISTS_KEY = 'michelly_playlists';       // legacy 3-slot store, read-only from now on
    var PLAYLISTS_V2_KEY = 'michelly_playlists_v2'; // dynamic named-playlist store
    var SLOT_COUNT = 3;                             // legacy slot count (migration source only)
    var SLOT_NAMES = ['Playlist 1', 'Playlist 2', 'Playlist 3']; // legacy slot names (migration only)
    var PL_DEFAULT_NAME = 'New playlist';
    var plIdSeq = 0;                                // module counter for stable-ish created ids

    // The key for this server's playlists inside both stores, set once per connect by
    // index.js afterConnect -> setServerId(current_server_id). The server's stable Id wins
    // over its baseUrl on purpose (same key michelly_sessions uses): playlists survive
    // address/port changes, and orphaning happens only if the server's own Id changes
    // (reinstall/reset). Null until set: reads behave like absent data, writes fail visibly.
    var plServerId = null;

    function setServerId(id) {
        var next = id || null;
        var changed = !!(next && plServerId && next !== plServerId);

        plServerId = next;

        // A server switch invalidates the pending queue: its entries carry the OLD
        // server's Ids, and adopting them on the new server would fail PlaybackInfo and
        // kill the user's session with an error. Only a real identity change clears it
        // (re-connecting the same server, or a null/absent id, must not lose the queue).
        // An ACTIVE session across a switch is already impossible: the connect flow
        // resets the views before afterConnect runs. listQueue needs no clearing here —
        // it dies with endSession anyway.
        if (changed) {
            pendingQueue = [];
        }
    }

    // Manage-view UI state (module-level, reset on every entry into the view).
    var plDetailId = null;   // id of the open playlist detail, or null for the playlist list
    var plConfirmId = null;  // playlist id whose 'Delete' is awaiting an inline confirm
    var plEditor = null;     // null, or {mode:'create'|'rename', id:string|null, draft:string|null} while editing
    var plStatusText = '';   // transient manage-view status line

    // Focus anchor for the playlist detail (F1): a detail-row action (Move up/down,
    // Disable/Enable, Remove) records which row should keep focus, and renderPlaylists()
    // consumes it so the D-pad stays on that row's Move up button instead of snapping back
    // to the first button in the whole view. Shape: {playlistId, position} or null.
    var plFocus = null;

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
            // An array blob would pass a plain typeof-'object' test; savePlaylists writing expando
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

    // Whole v2-store read as a plain object, or null when absent/unparseable/not-an-object.
    // Same corruption convention as readPlaylistsStore: a malformed top level counts as an
    // empty store (the per-server record is then simply absent and migration applies).
    function readPlaylistsV2Store() {
        var raw = null;

        try {
            raw = localStorage.getItem(PLAYLISTS_V2_KEY);
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
            // An array blob would pass a plain typeof-'object' test; writing expando keys onto
            // it would then be silently dropped by JSON.stringify. Treat it as an empty store.
            return null;
        }

        return parsed;
    }

    // A stable id for a playlist migrated from legacy slot index. It is deterministic (not
    // counter/clock based) on purpose: migration is recomputed in memory on every read until the
    // first mutation persists it, so a reader that renders ids and a later click that resolves one
    // MUST see the same id. A 'pl-legacy-N' id is unique because created ids always start 'pl'.
    function legacyPlaylistId(index) {
        return 'pl-legacy-' + (index + 1);
    }

    // A fresh id for a user-created playlist. The WebCrypto UUID helper is Chrome 92+, far above
    // the Chromium 38 floor, so Date.now + a module counter keeps ids unique without it.
    function newPlaylistId() {
        plIdSeq = plIdSeq + 1;
        return 'pl' + Date.now() + '-' + plIdSeq;
    }

    // Normalise one playlist record into {id, name, items}, or null when it is unusable (a
    // malformed playlist is dropped by the caller without destroying its siblings). id must be
    // a non-empty string; name falls back to 'Playlist'; items must be an Array and only
    // Audio entries survive (the same per-entry filter normalizeSlots applies). An entry's
    // optional Disabled === true flag is preserved as-is.
    function normalizePlaylist(record) {
        if (!record || typeof record !== 'object') {
            return null;
        }

        if (typeof record.id !== 'string' || !record.id) {
            return null;
        }

        if (!(record.items instanceof Array)) {
            return null;
        }

        var name = 'Playlist';

        if (typeof record.name === 'string' && record.name.replace(/^\s+|\s+$/g, '')) {
            name = record.name;
        }

        var items = [];

        for (var k = 0; k < record.items.length; k++) {
            var entry = record.items[k];

            if (entry && typeof entry === 'object' && entry.Id && entry.Type === 'Audio') {
                items.push(entry);
            }
        }

        return { id: record.id, name: name, items: items };
    }

    // Normalise one server's v2 record into a playlists array, or null when the record is
    // missing/malformed. An empty playlists array is VALID (a user who deleted every playlist
    // must not be re-migrated); only a non-object record or a non-Array playlists field falls
    // through to migration.
    function normalizePlaylistsRecord(record) {
        if (!record || typeof record !== 'object' || !(record.playlists instanceof Array)) {
            return null;
        }

        var out = [];

        for (var i = 0; i < record.playlists.length; i++) {
            var pl = normalizePlaylist(record.playlists[i]);

            if (pl) {
                out.push(pl);
            }
        }

        return out;
    }

    // Lazy, in-memory migration from the read-only legacy 3-slot store, recomputed on every read
    // until the first mutation persists it. A valid legacy record always becomes three playlists
    // named 'Playlist 1/2/3' carrying each slot's items (copied; normalizeSlots already dropped
    // foreign entries). No valid legacy record at all (fresh install, or a corrupt/missing one)
    // yields no playlists — the user then creates their own.
    function migrateLegacyPlaylists() {
        var key = plServerId;
        var legacyStore = readPlaylistsStore();
        var slots = (legacyStore && legacyStore.hasOwnProperty(key)) ? normalizeSlots(legacyStore[key]) : null;

        if (!slots) {
            return [];
        }

        var out = [];

        for (var i = 0; i < SLOT_COUNT; i++) {
            out.push({
                id: legacyPlaylistId(i),
                name: SLOT_NAMES[i],
                items: slots[i].slice(0)
            });
        }

        return out;
    }

    // This server's playlists (a fresh, normalised copy; never a live reference into storage).
    // A valid v2 record — including an empty playlists array — wins and is returned verbatim; a
    // missing or malformed per-server record (or a corrupt top-level v2 blob) falls through to
    // the in-memory legacy migration above. Without a server id reads behave like absent data.
    function readPlaylists() {
        var key = plServerId;

        if (!key) {
            return [];
        }

        var store = readPlaylistsV2Store();
        var norm = (store && store.hasOwnProperty(key)) ? normalizePlaylistsRecord(store[key]) : null;

        if (norm) {
            return norm;
        }

        return migrateLegacyPlaylists();
    }

    // Write this server's playlists back, preserving every other server's v2 key
    // (read-modify-write). The legacy key is never touched. A falsy id must never be persisted
    // under a '' key, so it fails like a storage error: callers surface 'Could not save the
    // playlist.' (never-silent holds; auth.js guards its serverId alike).
    function savePlaylists(playlists) {
        var key = plServerId;

        if (!key) {
            return false;
        }

        var store = readPlaylistsV2Store();

        if (!store) {
            store = {};
        }

        store[key] = { playlists: playlists };

        try {
            localStorage.setItem(PLAYLISTS_V2_KEY, JSON.stringify(store));
        } catch (err) {
            return false;
        }

        return true;
    }

    // Index of the playlist with this id in a normalised array, or -1.
    function findPlaylist(playlists, id) {
        for (var i = 0; i < playlists.length; i++) {
            if (playlists[i].id === id) {
                return i;
            }
        }

        return -1;
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

    /* Public store surface (namespace.playlists): dynamic named playlists plus the legacy
     * index-based aliases kept as thin wrappers over the same model. */

    // [{id, name, count}] for this server's playlists, in stored order.
    function listPlaylists() {
        var playlists = readPlaylists();
        var out = [];

        for (var i = 0; i < playlists.length; i++) {
            out.push({
                id: playlists[i].id,
                name: playlists[i].name,
                count: playlists[i].items.length
            });
        }

        return out;
    }

    // A copy of one playlist's items (never a live reference into storage); [] for an unknown id.
    function getPlaylistItems(id) {
        var playlists = readPlaylists();
        var index = findPlaylist(playlists, id);

        if (index < 0) {
            return [];
        }

        return playlists[index].items.slice(0);
    }

    // Append an item. Same 'added'/'duplicate'/'error' contract and Id duplicate guard as the
    // legacy addToSlot; a blank/unknown playlist id is an error like a storage failure.
    function addItemToPlaylist(id, item) {
        if (!item || !item.Id) {
            return 'error';
        }

        var playlists = readPlaylists();
        var index = findPlaylist(playlists, id);

        if (index < 0) {
            return 'error';
        }

        var items = playlists[index].items;

        for (var k = 0; k < items.length; k++) {
            if (items[k].Id === item.Id) {
                return 'duplicate';
            }
        }

        items.push(playlistEntry(item));

        return savePlaylists(playlists) ? 'added' : 'error';
    }

    // Remove the item at position. Bounds-checked; a failed write returns false (never silent).
    function removePlaylistItem(id, position) {
        var playlists = readPlaylists();
        var index = findPlaylist(playlists, id);

        if (index < 0) {
            return false;
        }

        var items = playlists[index].items;

        if (position < 0 || position >= items.length) {
            return false;
        }

        items.splice(position, 1);

        return savePlaylists(playlists);
    }

    // Move one item to a new index. Bounds-checked; a no-op (out of range or same index) returns
    // false without a write.
    function movePlaylistItem(id, from, to) {
        var playlists = readPlaylists();
        var index = findPlaylist(playlists, id);

        if (index < 0) {
            return false;
        }

        var items = playlists[index].items;

        if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) {
            return false;
        }

        var moved = items.splice(from, 1)[0];
        items.splice(to, 0, moved);

        return savePlaylists(playlists);
    }

    // Set/clear the per-item soft-disable flag. Bounds-checked; persists.
    function setItemDisabled(id, position, disabled) {
        var playlists = readPlaylists();
        var index = findPlaylist(playlists, id);

        if (index < 0) {
            return false;
        }

        var items = playlists[index].items;

        if (position < 0 || position >= items.length) {
            return false;
        }

        if (disabled) {
            items[position].Disabled = true;
        } else {
            // "Clears" the flag: normalizePlaylist only preserves Disabled === true, so deleting
            // the property is equivalent to setting it false and keeps the stored entry minimal.
            delete items[position].Disabled;
        }

        return savePlaylists(playlists);
    }

    // Create a playlist (name trimmed; blank falls back to 'New playlist') and return its id, or
    // false on a storage-write failure.
    function createPlaylist(name) {
        var trimmed = (typeof name === 'string') ? name.replace(/^\s+|\s+$/g, '') : '';
        var playlists = readPlaylists();
        var id = newPlaylistId();

        playlists.push({ id: id, name: trimmed || PL_DEFAULT_NAME, items: [] });

        if (!savePlaylists(playlists)) {
            return false;
        }

        return id;
    }

    // Rename a playlist. Trimmed; a blank name or an unknown id is rejected (false, no write).
    function renamePlaylist(id, name) {
        var trimmed = (typeof name === 'string') ? name.replace(/^\s+|\s+$/g, '') : '';

        if (!trimmed) {
            return false;
        }

        var playlists = readPlaylists();
        var index = findPlaylist(playlists, id);

        if (index < 0) {
            return false;
        }

        playlists[index].name = trimmed;

        return savePlaylists(playlists);
    }

    // Delete a playlist (items and all). Unknown id returns false, no write.
    function deletePlaylist(id) {
        var playlists = readPlaylists();
        var index = findPlaylist(playlists, id);

        if (index < 0) {
            return false;
        }

        playlists.splice(index, 1);

        return savePlaylists(playlists);
    }

    /* Legacy index-based aliases over the dynamic model. Kept so documented contracts (including
     * the Id duplicate guard and outcome strings) survive unchanged; they address playlists by
     * their position in listPlaylists(). */

    function listSlots() {
        var playlists = listPlaylists();
        var out = [];

        for (var i = 0; i < playlists.length; i++) {
            out.push({ name: playlists[i].name, count: playlists[i].count });
        }

        return out;
    }

    function getSlotItems(index) {
        var playlists = listPlaylists();

        if (index < 0 || index >= playlists.length) {
            return [];
        }

        return getPlaylistItems(playlists[index].id);
    }

    function addToSlot(index, item) {
        var playlists = listPlaylists();

        if (index < 0 || index >= playlists.length) {
            return 'error';
        }

        return addItemToPlaylist(playlists[index].id, item);
    }

    function removeAt(index, position) {
        var playlists = listPlaylists();

        if (index < 0 || index >= playlists.length) {
            return false;
        }

        return removePlaylistItem(playlists[index].id, position);
    }

    function clearSlot(index) {
        var playlists = readPlaylists();

        if (index < 0 || index >= playlists.length) {
            return false;
        }

        playlists[index].items = [];

        return savePlaylists(playlists);
    }

    function countLabel(count) {
        if (!count) {
            return 'empty';
        }

        return count + (count === 1 ? ' track' : ' tracks');
    }

    /* Add-from-item inline actions menu (the slot picker generalized into a per-item action
     * sheet). It is rendered into a container inside the item view and pushed onto the back
     * stack exactly once; ui.handleBack() pops before invoking, so the pushed handler must not
     * pop, and the on-screen Cancel / choices (and a Play press that starts a session over an
     * open menu) pop it themselves. The menu has two steps in the SAME container — step 1
     * (Play next / Add to queue / Add to playlist / [Open album] / Cancel) and step 2 (slot
     * rows) — and
     * deliberately pushes NO second handler on the step transition: step-2 rows hand the
     * container back to step 1 or pop the one entry themselves. */

    function closePlaylistPicker(pickerEl, anchorEl, popHandler) {
        if (popHandler) {
            ui().popBackHandler();
        }

        ui().clear(pickerEl);

        if (anchorEl) {
            anchorEl.focus();
        }
    }

    // Step 2 of the actions menu: the dynamic playlist rows (name + live count) plus a
    // New playlist row. Renders into the container WITHOUT pushing a back handler and without
    // seeding focus (both stay with the stack owner). The Id duplicate guard and the outcome
    // texts are preserved from the former slot picker. reopenMenu (actions menu only) adds the
    // Back-to-actions row that re-renders step 1 into the same container while the one menu
    // entry stays on the stack.
    function renderPlaylistSlotRows(pickerEl, statusEl, anchorEl, item, reopenMenu) {
        ui().clear(pickerEl);

        var playlists = listPlaylists();

        for (var i = 0; i < playlists.length; i++) {
            (function (pl) {
                var pick = ui().el('button', 'playlist-pick-btn',
                    pl.name + ' (' + countLabel(pl.count) + ')');
                pick.type = 'button';
                pick.onclick = function () {
                    var result = addItemToPlaylist(pl.id, item);
                    showPickerStatus(statusEl, result, pl.name);
                    closePlaylistPicker(pickerEl, anchorEl, true);
                    return false;
                };
                pickerEl.appendChild(pick);
            })(playlists[i]);
        }

        // Create-and-add in one press: the new playlist gets the auto name, the item is added,
        // and the outcome is reported exactly like a normal add before the menu closes.
        var create = ui().el('button', 'playlist-pick-btn playlist-new-btn', 'New playlist');
        create.type = 'button';
        create.onclick = function () {
            var id = createPlaylist(PL_DEFAULT_NAME);

            if (id === false) {
                showPickerStatus(statusEl, 'error', PL_DEFAULT_NAME);
            } else {
                var added = addItemToPlaylist(id, item);

                if (added === 'error') {
                    showPickerStatus(statusEl, 'error', PL_DEFAULT_NAME);
                } else {
                    statusEl.textContent = 'Created "' + PL_DEFAULT_NAME + '".';
                    statusEl.style.display = '';
                }
            }

            closePlaylistPicker(pickerEl, anchorEl, true);
            return false;
        };
        pickerEl.appendChild(create);

        // Step-transition row: hands the container back to step 1 without a pop or a push.
        if (reopenMenu) {
            var backRow = ui().el('button', 'playlist-pick-btn', 'Actions');
            backRow.type = 'button';
            backRow.onclick = function () {
                reopenMenu();
                return false;
            };
            pickerEl.appendChild(backRow);
        }

        var cancel = ui().el('button', 'playlist-pick-btn playlist-pick-cancel', 'Cancel');
        cancel.type = 'button';
        cancel.onclick = function () {
            closePlaylistPicker(pickerEl, anchorEl, true);
            return false;
        };
        pickerEl.appendChild(cancel);
    }

    // Step 1 of the actions menu, RENDER-ONLY: clears the container, builds the step-1 rows
    // (Play next / Add to queue / [Clear queue (n)] / Add to playlist / [Open album] /
    // Cancel) and seeds focus on the first button. It owns NO back-stack state, so both
    // the opener below and step 2's Back-to-actions row (reopenMenu) re-render through it
    // without ever re-pushing. The Clear queue row pre-session is the review/undo surface
    // for the pending queue (row order: before "Add to playlist" so Cancel stays last).
    // opt.openAlbum — the album track-list opener (playShelfItem pattern) or null, so the
    // row only exists when the fetched detail carries AlbumId (visible-only: never a dead
    // button).
    function renderItemActionsRows(pickerEl, statusEl, anchorEl, item, opt) {
        ui().clear(pickerEl);

        var reopenMenu = function () {
            renderItemActionsRows(pickerEl, statusEl, anchorEl, item, opt);
        };

        // Play next ALWAYS enqueues: while no session is active the pending queue collects
        // it, and the next all-Audio playlistStart() adopts it into the live session queue
        // (FIFO head). This replaces the old "play now" fallback.
        var playNext = ui().el('button', 'playlist-pick-btn', 'Play next');
        playNext.type = 'button';
        playNext.onclick = function () {
            // Close (pop) the menu's single entry FIRST — the same Play-closes-first rule
            // the Play button enforces over an open menu.
            closePlaylistPicker(pickerEl, anchorEl, true);

            var depth = playlistPlayNext(item);

            statusEl.textContent = 'Queued to play next: ' + (item.Name || 'track') +
                '. (' + depth + ' queued)';
            statusEl.style.display = '';
            return false;
        };
        pickerEl.appendChild(playNext);

        var addToQueue = ui().el('button', 'playlist-pick-btn', 'Add to queue');
        addToQueue.type = 'button';
        addToQueue.onclick = function () {
            closePlaylistPicker(pickerEl, anchorEl, true);

            var depth = playlistAppendQueue(item);

            statusEl.textContent = 'Added to queue: ' + (item.Name || 'track') +
                '. (' + depth + ' queued)';
            statusEl.style.display = '';
            return false;
        };
        pickerEl.appendChild(addToQueue);

        // Pre-session review/undo for the pending queue (write-only before this row):
        // only rendered when it exists AND no session owns a queue — during an active
        // session the audio card's overlay owns queue visibility, so this row would only
        // be a second surface for the same state. Render-only like every step-1 row: the
        // click re-renders step 1 through the same helper, so the stack delta is +0 and
        // the menu's single back entry stays untouched.
        var visibleQueue = playlistIsActive() ? [] : playlistGetQueue();

        if (visibleQueue.length > 0) {
            var clearQueueRow = ui().el('button', 'playlist-pick-btn',
                'Clear queue (' + visibleQueue.length + ')');

            clearQueueRow.type = 'button';
            clearQueueRow.onclick = function () {
                playlistClearQueue();

                // No stack change: the menu stays open and re-renders step 1 in place
                // (this helper owns no back-stack state; the opener's single entry lives
                // on). The anchor keeps its position for the D-pad walk.
                renderItemActionsRows(pickerEl, statusEl, anchorEl, item, opt);
                statusEl.textContent = 'Queue cleared.';
                statusEl.style.display = '';
                return false;
            };
            pickerEl.appendChild(clearQueueRow);
        }

        var addToPlaylist = ui().el('button', 'playlist-pick-btn', 'Add to playlist');
        addToPlaylist.type = 'button';
        addToPlaylist.onclick = function () {
            // Step transition within the same single back entry: the slot rows replace step 1
            // in the container; the one menu handler stays untouched on the stack.
            renderPlaylistSlotRows(pickerEl, statusEl, anchorEl, item, reopenMenu);

            var first = pickerEl.querySelector('button');

            if (first) {
                first.focus();
            }
            return false;
        };
        pickerEl.appendChild(addToPlaylist);

        if (opt.openAlbum) {
            var openAlbum = ui().el('button', 'playlist-pick-btn', 'Open album');
            openAlbum.type = 'button';
            openAlbum.onclick = function () {
                // Same discipline as Play next: leave the menu (pop its single entry) before
                // the navigation changes the view.
                closePlaylistPicker(pickerEl, anchorEl, true);
                opt.openAlbum();
                return false;
            };
            pickerEl.appendChild(openAlbum);
        }

        var cancel = ui().el('button', 'playlist-pick-btn playlist-pick-cancel', 'Cancel');
        cancel.type = 'button';
        cancel.onclick = function () {
            closePlaylistPicker(pickerEl, anchorEl, true);
            return false;
        };
        pickerEl.appendChild(cancel);

        // Render-only: focus belongs with the rows that were just built.
        var first = pickerEl.querySelector('button');

        if (first) {
            first.focus();
        }
    }

    // Step-1 opener: the ONLY push site in the whole menu lifecycle. It delegates the
    // rendering to renderItemActionsRows() and pushes the menu's single back entry exactly
    // once; step transitions re-render through the render-only helper and never touch the
    // stack, so every close path pops exactly one entry.
    function openItemActionsMenu(pickerEl, statusEl, anchorEl, item, opt) {
        renderItemActionsRows(pickerEl, statusEl, anchorEl, item, opt);

        // One back entry for the WHOLE two-step menu: hardware Back clears it and nothing
        // else. It does not pop (handleBack already popped), mirroring the playlist-start
        // handler convention.
        ui().pushBackHandler(function () {
            closePlaylistPicker(pickerEl, anchorEl, false);
        });
    }

    function showPickerStatus(statusEl, result, name) {
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
    // recreates Views) then show the freshly-rendered playlist list.
    function openPlaylists(userId) {
        plDetailId = null;
        plConfirmId = null;
        plEditor = null;
        plStatusText = '';
        plFocus = null;

        setBackHandler(function () {
            openViews(userId);
        });

        renderPlaylists(userId);
    }

    // Content renderer + view switcher. Rebuilds on every call so counts are always current.
    // Also used as the session's return target after a manage-play ends. It owns NO back-stack
    // state: the editor and detail levels each push exactly ONE handler when they open (see
    // below), and this renderer only reads the module state, so a re-render never changes the
    // stack. That is what keeps every close path popping exactly one entry.
    function renderPlaylists(userId) {
        ensurePlaylistsView();

        var view = document.querySelector('#playlistsView');

        ui().showView('playlistsView');
        ui().clear(view);

        var title = 'Playlists';
        var editorOpen = plEditor !== null;
        var detailId = plDetailId;

        if (editorOpen) {
            title = (plEditor.mode === 'rename') ? 'Rename playlist' : 'New playlist';
        } else if (detailId !== null) {
            var openName = null;
            var playlists = listPlaylists();

            for (var i = 0; i < playlists.length; i++) {
                if (playlists[i].id === detailId) {
                    openName = playlists[i].name;
                    break;
                }
            }

            if (openName === null) {
                // The open playlist vanished (defensive: Delete lives one level up) — fall back.
                plDetailId = null;
                detailId = null;
            } else {
                title = openName;
            }
        }

        var header = ui().el('div', 'browse-header');
        header.appendChild(ui().el('h1', 'playlist-title', title));
        view.appendChild(header);

        if (editorOpen) {
            renderPlaylistEditor(view, userId);
        } else if (detailId === null) {
            renderPlaylistList(view, userId);
        } else {
            renderPlaylistDetail(view, userId, detailId);
        }

        if (plStatusText) {
            var status = ui().el('p', 'playlist-status', plStatusText);
            status.style.display = '';
            view.appendChild(status);
        }

        // Focus seeding: while the editor is open its text input outranks the first button.
        if (editorOpen) {
            var input = view.querySelector('.playlist-name-input');

            if (input) {
                input.focus();
                return;
            }
        }

        // Reorder anchor (F1): a detail-row action recorded the row that must keep focus,
        // so the D-pad stays on its Move up button instead of snapping to the top of the
        // view. The anchor is consumed exactly once; a vanished position (Remove at the
        // last index) clamps to the last surviving row.
        if (plFocus !== null) {
            var anchor = plFocus;

            plFocus = null;

            if (!editorOpen && detailId !== null && anchor.playlistId === detailId) {
                var rows = view.querySelectorAll('.playlist-track-row');
                var pos = anchor.position;

                if (rows.length) {
                    if (pos < 0) {
                        pos = 0;
                    }
                    if (pos > rows.length - 1) {
                        pos = rows.length - 1;
                    }

                    var target = rows[pos].querySelector('button');

                    if (target) {
                        target.focus();
                        return;
                    }
                }
            }
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

    // Start a manage-play session for one playlist. The queue is built from ENABLED items only
    // (Disabled === true tracks are skipped); with nothing enabled the status line explains it
    // and no session starts. The return target re-renders this view and arms the deferred mirror,
    // exactly like the historical slot Play path.
    function playPlaylist(userId, pl) {
        var items = getPlaylistItems(pl.id);
        var enabled = [];

        for (var i = 0; i < items.length; i++) {
            if (items[i].Disabled !== true) {
                enabled.push(items[i]);
            }
        }

        if (!enabled.length) {
            plStatusText = pl.name + ' has no enabled tracks.';
            renderPlaylists(userId);
            return;
        }

        // Start with a clean status line and no inline confirm: a mirrored failure from a
        // previous session, or a confirm armed on another row, must not outlive the session
        // into its teardown re-render.
        plStatusText = '';
        plConfirmId = null;

        playlistStart(enabled, 0, userId, function () {
            renderPlaylists(userId);
            plManageReturnArmed = true;
            mirrorManagePlayError(userId);
        });
    }

    // Playlist list level: one row per playlist (name opens the detail; Play/Rename/Delete) plus
    // a New playlist button. Delete arms an inline two-step Yes/No confirm in the same row. Every
    // control is a real button; an empty playlist's Play is a focusable no-op.
    function renderPlaylistList(view, userId) {
        var playlists = listPlaylists();
        var body = ui().el('div', 'playlist-slots');
        view.appendChild(body);

        if (!playlists.length) {
            body.appendChild(ui().el('div', 'playlist-empty', 'No playlists yet.'));
        }

        for (var i = 0; i < playlists.length; i++) {
            (function (pl) {
                var row = ui().el('div', 'playlist-row');

                var nameBtn = ui().el('button', 'playlist-slot-btn',
                    pl.name + ' (' + countLabel(pl.count) + ')');
                nameBtn.type = 'button';
                nameBtn.onclick = function () {
                    openPlaylistDetail(userId, pl.id);
                    return false;
                };
                row.appendChild(nameBtn);

                if (plConfirmId === pl.id) {
                    // Two-step inline confirm: the row swaps to a delete prompt, nothing else.
                    row.appendChild(ui().el('div', 'playlist-confirm-text',
                        pl.count === 0 ? 'Delete this playlist?' :
                            (pl.count === 1 ? 'Delete this playlist and its 1 track?' :
                                'Delete this playlist and its ' + pl.count + ' tracks?')));

                    var yes = ui().el('button', 'playlist-confirm-btn', 'Yes');
                    yes.type = 'button';
                    yes.onclick = function () {
                        // A failed storage write is surfaced, never silent: the re-render below
                        // re-reads the store, so the playlist is still there on failure.
                        plStatusText = deletePlaylist(pl.id) ? '' : 'Could not save the playlist.';
                        plConfirmId = null;
                        renderPlaylists(userId);
                        return false;
                    };
                    row.appendChild(yes);

                    var no = ui().el('button', 'playlist-confirm-btn', 'No');
                    no.type = 'button';
                    no.onclick = function () {
                        plConfirmId = null;
                        renderPlaylists(userId);
                        return false;
                    };
                    row.appendChild(no);
                } else {
                    // Never-disabled: an all-disabled/empty playlist still plays as a focusable
                    // button that explains itself on the status line.
                    var play = ui().el('button', 'playlist-play-btn', 'Play');
                    play.type = 'button';
                    play.onclick = function () {
                        playPlaylist(userId, pl);
                        return false;
                    };
                    row.appendChild(play);

                    var rename = ui().el('button', 'playlist-rename-btn', 'Rename');
                    rename.type = 'button';
                    rename.onclick = function () {
                        openPlaylistEditor(userId, 'rename', pl.id);
                        return false;
                    };
                    row.appendChild(rename);

                    var del = ui().el('button', 'playlist-delete-btn', 'Delete');
                    del.type = 'button';
                    del.onclick = function () {
                        plConfirmId = pl.id;
                        plStatusText = '';
                        renderPlaylists(userId);
                        return false;
                    };
                    row.appendChild(del);
                }

                body.appendChild(row);
            })(playlists[i]);
        }

        var newBtn = ui().el('button', 'playlist-new-btn', 'New playlist');
        newBtn.type = 'button';
        newBtn.onclick = function () {
            openPlaylistEditor(userId, 'create', null);
            return false;
        };
        body.appendChild(newBtn);
    }

    // Playlist detail is a lower level inside the same view. It pushes ONE back handler so
    // hardware Back exits to the playlist list; the on-screen Back simply calls handleBack()
    // (pops + invokes), exactly like the D-pad path.
    function openPlaylistDetail(userId, id) {
        plDetailId = id;
        plConfirmId = null;
        plStatusText = '';
        plFocus = null;

        ui().pushBackHandler(function () {
            plDetailId = null;
            renderPlaylists(userId);
        });

        renderPlaylists(userId);
    }

    function renderPlaylistDetail(view, userId, id) {
        var items = getPlaylistItems(id);
        var body = ui().el('div', 'playlist-tracks');
        view.appendChild(body);

        if (!items.length) {
            body.appendChild(ui().el('div', 'playlist-empty', 'This playlist is empty.'));
        }

        for (var j = 0; j < items.length; j++) {
            (function (position) {
                var item = items[position];
                var disabled = item.Disabled === true;
                var isFirst = position === 0;
                var isLast = position === items.length - 1;
                var row = ui().el('div', disabled ? 'playlist-track-row is-disabled' : 'playlist-track-row');

                row.appendChild(ui().el('div', 'playlist-track-name', item.Name || 'Untitled'));

                // Boundary rows dim (is-inert) but stay focusable no-ops, exactly like Prev/Next:
                // a real <button>, never disabled, so the D-pad can never appear stuck.
                var up = ui().el('button', 'playlist-move-btn' + (isFirst ? ' is-inert' : ''), 'Move up');
                up.type = 'button';
                up.onclick = function () {
                    if (isFirst) {
                        return false;
                    }

                    var moved = movePlaylistItem(id, position, position - 1);

                    if (!moved) {
                        plStatusText = 'Could not save the playlist.';
                    }

                    // Keep the D-pad on the moved row (F1); a failed write left the row in
                    // place, so it stays anchored where it was.
                    plFocus = { playlistId: id, position: moved ? position - 1 : position };
                    renderPlaylists(userId);
                    return false;
                };
                row.appendChild(up);

                var down = ui().el('button', 'playlist-move-btn' + (isLast ? ' is-inert' : ''), 'Move down');
                down.type = 'button';
                down.onclick = function () {
                    if (isLast) {
                        return false;
                    }

                    var moved = movePlaylistItem(id, position, position + 1);

                    if (!moved) {
                        plStatusText = 'Could not save the playlist.';
                    }

                    plFocus = { playlistId: id, position: moved ? position + 1 : position };
                    renderPlaylists(userId);
                    return false;
                };
                row.appendChild(down);

                // Soft-disable toggle: the label names the action, the dim classes name the state.
                // Never disabled — a Dimmed Enable still re-enables the track.
                var toggle = ui().el('button',
                    'playlist-toggle-btn' + (disabled ? ' is-inert' : ''),
                    disabled ? 'Enable' : 'Disable');
                toggle.type = 'button';
                toggle.onclick = function () {
                    if (!setItemDisabled(id, position, !disabled)) {
                        plStatusText = 'Could not save the playlist.';
                    }

                    plFocus = { playlistId: id, position: position };
                    renderPlaylists(userId);
                    return false;
                };
                row.appendChild(toggle);

                var remove = ui().el('button', 'playlist-remove-btn', 'Remove');
                remove.type = 'button';
                remove.onclick = function () {
                    // Surface a failed storage write the same way Clear does (the re-render
                    // re-reads the store, so a failed remove leaves the track in place).
                    if (!removePlaylistItem(id, position)) {
                        plStatusText = 'Could not save the playlist.';
                    }

                    // The row may be gone; renderPlaylists() clamps to the last row (F1).
                    plFocus = { playlistId: id, position: position };
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
            // Pop the detail handler and run it (returns to the playlist list), same as hardware Back.
            ui().handleBack();
            return false;
        };
        view.appendChild(back);
    }

    // Inline create/rename editor, rendered INTO #playlistsView (no new view). Opening pushes
    // exactly ONE back handler; renderPlaylists() only reads plEditor, so a re-render never
    // re-pushes. Every close path pops exactly once: the pushed handler passes pop=false
    // (handleBack already popped) while on-screen Save/Cancel pass pop=true.
    function openPlaylistEditor(userId, mode, id) {
        plEditor = { mode: mode, id: id || null, draft: null };
        plConfirmId = null;
        plStatusText = '';
        plFocus = null;

        ui().pushBackHandler(function () {
            closePlaylistEditor(userId, false);
        });

        renderPlaylists(userId);
    }

    function closePlaylistEditor(userId, pop) {
        if (pop) {
            ui().popBackHandler();
        }

        plEditor = null;
        plFocus = null;
        renderPlaylists(userId);
    }

    function renderPlaylistEditor(view, userId) {
        var initial = '';
        var playlists = listPlaylists();

        if (plEditor.mode === 'rename') {
            for (var i = 0; i < playlists.length; i++) {
                if (playlists[i].id === plEditor.id) {
                    initial = playlists[i].name;
                    break;
                }
            }
        }

        // A draft typed before a failed save (or a validation error) outranks the stored
        // name, so the re-created input never discards the user's text (F5).
        if (typeof plEditor.draft === 'string') {
            initial = plEditor.draft;
        }

        var editor = ui().el('div', 'playlist-editor');

        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'playlist-name-input';
        input.value = initial;
        editor.appendChild(input);

        var save = ui().el('button', 'playlist-save-btn', 'Save');
        save.type = 'button';
        save.onclick = function () {
            var name = input.value;
            var ok;

            // Stash the typed text before any re-render so a failed save keeps it (F5).
            plEditor.draft = name;

            if (plEditor.mode === 'rename') {
                // A blank rename is a validation error, not a storage failure — keep the editor
                // open and say so rather than surfacing the write-error text.
                if (!(typeof name === 'string' && name.replace(/^\s+|\s+$/g, ''))) {
                    plStatusText = 'Enter a playlist name.';
                    renderPlaylists(userId);
                    return false;
                }

                ok = renamePlaylist(plEditor.id, name);
            } else {
                ok = (createPlaylist(name) !== false);
            }

            if (!ok) {
                // Write failure (quota/disabled storage): keep the editor open so the name is
                // not lost, and surface the standard message.
                plStatusText = 'Could not save the playlist.';
                renderPlaylists(userId);
                return false;
            }

            // Success: the draft dies with the editor (closePlaylistEditor nulls plEditor).
            plEditor.draft = null;
            closePlaylistEditor(userId, true);
            return false;
        };
        editor.appendChild(save);

        var cancel = ui().el('button', 'playlist-cancel-btn', 'Cancel');
        cancel.type = 'button';
        cancel.onclick = function () {
            closePlaylistEditor(userId, true);
            return false;
        };
        editor.appendChild(cancel);

        view.appendChild(editor);
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
            // An inline actions menu can be open on audio items; close it FIRST (popping its
            // single back handler) so playback starts from a clean stack and no stale menu
            // widgets remain in the D-pad walk behind the player view.
            if (plPicker && plPicker.firstChild) {
                closePlaylistPicker(plPicker, moreActions, true);
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

        // User playlists: only audio items are addable (Scope A). The More button sits after
        // Play and opens an inline two-step actions menu (Play next / Add to queue / Add to
        // playlist / [Open album] / Cancel) rendered under the actions; both nodes are
        // rebuilt on every renderItem, so a stale menu can never survive into another item.
        var plStatus = null;
        var plPicker = null;

        if (item.Type === 'Audio') {
            plStatus = ui().el('p', 'playlist-status', '');
            plStatus.style.display = 'none';

            plPicker = ui().el('div', 'playlist-picker');

            var moreActions = ui().el('button', 'secondary', 'More');
            moreActions.type = 'button';
            moreActions.onclick = function () {
                // Toggle: a second press collapses an open menu and pops its back entry, so
                // the menu can never leave more than one handler on the stack.
                if (plPicker.firstChild) {
                    closePlaylistPicker(plPicker, moreActions, true);
                    return false;
                }

                openItemActionsMenu(plPicker, plStatus, moreActions, item, {
                    // Open album reuses the playShelfItem pattern for a MusicAlbum's track
                    // list; offered only when the fetched detail carries AlbumId.
                    openAlbum: item.AlbumId ? function () {
                        openItems(item.AlbumId, userId, {
                            title: item.Album || 'Album',
                            ParentId: item.AlbumId,
                            Recursive: false,
                            IncludeItemTypes: 'Audio',
                            Fields: 'PrimaryImageAspectRatio',
                            back: function () {
                                openItem(item.Id, userId, back);
                            }
                        });
                        return false;
                    } : null
                });
                return false;
            };
            actions.appendChild(moreActions);
        }

        info.appendChild(actions);

        var itemError = ui().el('p', 'error-slot', '\u00a0');
        itemError.id = 'itemError';
        itemError.style.display = 'none';
        info.appendChild(itemError);

        // Inline actions-menu status + menu container (only rendered for audio items). Kept as
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

    // Filter chips narrow the artist grid; the four dimension chips switch the content area to
    // another browse surface. Only filter chips ever take the .is-active treatment.
    var MUSIC_CHIPS = ['All', 'A-F', 'G-M', 'N-T', 'U-Z', 'Genres', 'Albums', 'Songs', 'Folders'];

    function isFilterChip(label) {
        return label === 'All' || label === 'A-F' || label === 'G-M' || label === 'N-T' || label === 'U-Z';
    }

    function isDimensionChip(label) {
        return label === 'Genres' || label === 'Albums' || label === 'Songs';
    }

    // Single-entry cache of the rendered music home (the lastGrouped pattern), so Back from an
    // artist or the grouped browse re-renders synchronously without refetching. Shape:
    // {libraryId, userId, libraryName, artists, total, startIndex, chip, artistsRecursive,
    //  shelves:[{key,title,items,loaded}], dimension:'artists'|'Albums'|'Songs'|'Genres'|'genre',
    //  dimensionCache:{Albums|Songs|Genres:{loading,loaded,error,items,genres}}, genre, search}.
    var musicHome = null;

    // The artist detail currently rendered (only one artist view can be open at a time).
    var artistCache = null;

    // One status line shared by the two music screens (only one is visible at a time).
    var musicStatusText = '';

    // True while the genre drill-down's single back entry is on the stack (F3). Back pops
    // it before invoking backToGenres(), which clears this flag; leaving the drill-down by
    // any OTHER route (a chip or a new search) releases it explicitly so no stale entry
    // survives.
    var genreHandlerOpen = false;

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

    // Back is first in DOM order, so an Up press still reaches it; withSearch adds a real,
    // tabbable search field plus its Search button (Workstream A3).
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
            var input = ui().el('input', 'music-search-input');
            input.id = 'musicSearchInput';
            input.type = 'text';
            input.placeholder = 'What do you want to play?';

            if (musicHome && musicHome.search && musicHome.search.term) {
                input.value = musicHome.search.term;
            }

            // Enter inside the field submits, mirroring the Search button (the global document
            // key handler ignores keyCode 13, so the event reaches this handler).
            input.onkeydown = function (evt) {
                evt = evt || window.event;
                if (evt.keyCode === 13) {
                    runMusicSearch(input.value);
                    if (evt.preventDefault) {
                        evt.preventDefault();
                    }
                    return false;
                }
            };
            topbar.appendChild(input);

            var submit = ui().el('button', 'music-search-btn', 'Search');
            submit.type = 'button';
            submit.onclick = function () {
                runMusicSearch(input.value);
                return false;
            };
            topbar.appendChild(submit);
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
        genreHandlerOpen = false;
        musicHome = {
            libraryId: libraryId,
            userId: userId,
            libraryName: libraryName || 'Music',
            artists: [],
            total: null,
            startIndex: 0,
            chip: 'All',
            artistsRecursive: false,
            dimension: 'artists',
            dimensionCache: {},
            dimensionFailed: null,
            genre: null,
            search: null,
            shelves: buildShelfDefs()
        };
        musicStatusText = '';

        showMusicHome();

        fetchMusicArtists(false, 0, false);
        loadMusicShelves();
    }

    // Re-enters the music home with exactly one back handler (Back -> the library list) and a
    // synchronous re-render from cache. Used on entry and as the Back target from artists and
    // the grouped browse, so re-entry never leaves the stack empty.
    function showMusicHome() {
        if (!musicHome) {
            return;
        }

        musicStatusText = '';

        // setBackHandler() resets the whole stack, so any pushed genre entry is gone.
        genreHandlerOpen = false;

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

        var searching = !!(musicHome.search && musicHome.search.term);

        // Search owns the content area, so the browse chips step aside while it is active.
        if (!searching) {
            main.appendChild(buildMusicChips());
        }

        var content = ui().el('div', 'music-content');
        main.appendChild(content);

        var showMore = null;

        if (searching) {
            renderMusicSearchResults(content);
        } else if (musicHome.dimension && musicHome.dimension !== 'artists') {
            renderMusicDimension(content);
        } else {
            showMore = renderMusicArtists(content);
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

    function buildMusicChips() {
        var chips = ui().el('div', 'music-chips');
        var artistMode = !musicHome.search && musicHome.dimension === 'artists';

        for (var c = 0; c < MUSIC_CHIPS.length; c++) {
            (function (label) {
                var active = artistMode && isFilterChip(label) && musicHome.chip === label;
                var chip = ui().el('button', 'music-chip' + (active ? ' is-active' : ''), label);
                chip.type = 'button';
                chip.onclick = function () {
                    selectMusicChip(label);
                    return false;
                };
                chips.appendChild(chip);
            })(MUSIC_CHIPS[c]);
        }

        return chips;
    }

    // Folders opens the existing folder-grouped browse; a dimension chip switches the content
    // area to that dimension's grid; a filter chip restores the artist grid.
    function selectMusicChip(label) {
        if (!musicHome) {
            return;
        }

        // Leaving the genre drill-down by any chip (Folders included) releases its single
        // back entry first, so no stale handler survives the navigation (F3).
        releaseGenreHandler();

        if (label === 'Folders') {
            openItems(musicHome.libraryId, musicHome.userId, {
                title: musicHome.libraryName,
                ParentId: musicHome.libraryId,
                grouped: true,
                back: function () {
                    showMusicHome();
                }
            });
            return;
        }

        musicStatusText = '';
        musicHome.search = null;
        musicHome.genre = null;

        if (isDimensionChip(label)) {
            musicHome.dimension = label;
        } else {
            musicHome.dimension = 'artists';
            musicHome.chip = label;
        }

        // A failed dimension was dropped from the cache (F4); clear the transient failure
        // marker so the next selection of that chip refetches instead of replaying the error.
        musicHome.dimensionFailed = null;

        renderMusicHome(false);
    }

    // The artist home: 0..3 shelves (each only when non-empty), the filtered artist grid, and
    // the continuation pager. Returns the Show-more button when there is more to page.
    function renderMusicArtists(content) {
        if (hasShelfItems(musicHome.shelves)) {
            content.appendChild(buildMusicShelves());
        }

        content.appendChild(buildArtistGrid());

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

        return showMore;
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

            // A late artist page must not repaint (and re-seed focus to the first card) while a
            // dimension grid or an active search owns the content area; the cache above is
            // already updated, so the appended artists stay available for later. Mirrors the
            // error path's guard (F2).
            if (isViewActive('musicView') && !home.search && home.dimension === 'artists') {
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
                // A late 'Show more' failure must not repaint (and re-seed focus to the
                // first card) once a dimension chip or a search owns the content area; the
                // failure is moot there. Mirrors the success path's guard (F2).
                if (!home.search && home.dimension === 'artists') {
                    // Keep the already-rendered grid; surface the failure inline instead.
                    musicStatusText = 'Could not load more artists.';
                    renderMusicHome(true);
                }
                return;
            }

            // A dimension grid or an active search owns the content area now; surface the
            // failure on the status line instead of wiping that view with a full error state.
            if (musicHome.dimension !== 'artists' || musicHome.search) {
                musicStatusText = 'Could not load artists.';
                renderMusicHome(false);
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

    /* Browse dimensions (Albums / Songs / Genres). Fetched lazily the first time a chip is
     * selected and cached on musicHome.dimensionCache, then re-rendered in place. */

    function ensureMusicDimension(key) {
        var home = musicHome;

        if (!home) {
            return null;
        }

        if (!home.dimensionCache) {
            home.dimensionCache = {};
        }

        var entry = home.dimensionCache[key];

        if (entry) {
            return entry;
        }

        entry = { key: key, loading: true, loaded: false, error: false, items: [], genres: null };
        home.dimensionCache[key] = entry;

        function onSuccess(data) {
            if (musicHome !== home) {
                return;
            }

            entry.items = (data && data.Items) ? data.Items : [];

            if (key === 'Genres') {
                entry.genres = collectGenres(entry.items);
            }

            entry.loading = false;
            entry.loaded = true;

            // A successful reload clears any lingering failure marker for this key (F4).
            if (home.dimensionFailed === key) {
                home.dimensionFailed = null;
            }

            if (isViewActive('musicView')) {
                renderMusicHome(false);
            }
        }

        function onFailure() {
            if (musicHome !== home) {
                return;
            }

            entry.loading = false;
            entry.error = true;

            // Drop the failed dimension from the cache so the next chip selection (or the
            // Retry button) refetches instead of replaying the cached error (F4). The visible
            // error is carried by home.dimensionFailed until then, which also stops this
            // failure re-render from immediately retrying in a loop.
            if (home.dimensionCache) {
                home.dimensionCache[key] = null;
            }
            home.dimensionFailed = key;

            if (isViewActive('musicView')) {
                renderMusicHome(false);
            }
        }

        // Dimensions are windowed (no pager yet): 500 items is the first-paint budget for
        // this pass; a continuation/pager is a deliberate follow-up (F6).
        if (key === 'Genres') {
            // /Items has no Genres query param, so the genres are derived client-side from the
            // fetched audio items' own Genres arrays (see collectGenres below).
            api().getItems({
                ParentId: home.libraryId,
                Recursive: true,
                IncludeItemTypes: 'Audio',
                SortBy: 'SortName',
                SortOrder: 'Ascending',
                Fields: 'Genres,PrimaryImageAspectRatio',
                Limit: 500
            }, onSuccess, onFailure);
        } else {
            api().getItems({
                ParentId: home.libraryId,
                Recursive: true,
                IncludeItemTypes: key === 'Albums' ? 'MusicAlbum' : 'Audio',
                SortBy: 'SortName',
                SortOrder: 'Ascending',
                Fields: 'PrimaryImageAspectRatio',
                Limit: 500
            }, onSuccess, onFailure);
        }

        return entry;
    }

    // Unique, sorted genre names across the audio items' Genres arrays.
    function collectGenres(items) {
        var seen = {};
        var out = [];
        var i, j, names, name;

        for (i = 0; i < items.length; i++) {
            names = items[i] && items[i].Genres;

            if (!names || !names.length) {
                continue;
            }

            for (j = 0; j < names.length; j++) {
                name = String(names[j] || '');

                if (name && !seen.hasOwnProperty(name)) {
                    seen[name] = true;
                    out.push(name);
                }
            }
        }

        out.sort(function (a, b) {
            return a < b ? -1 : (a > b ? 1 : 0);
        });

        return out;
    }

    function renderMusicDimension(content) {
        var key = musicHome.dimension;
        var label;

        if (key === 'genre') {
            renderMusicGenreSongs(content);
            return;
        }

        // A failed dimension was dropped from the cache (F4) and is remembered on the home
        // until the user reselects the chip or presses Retry. Check it BEFORE
        // ensureMusicDimension so the failure re-render does not immediately refetch in a
        // loop; the error line stays visible meanwhile.
        if (musicHome.dimensionFailed === key) {
            label = (key === 'Albums' ? 'albums' : (key === 'Songs' ? 'songs' : 'genres'));
            musicStatusText = 'Could not load ' + label + '.';
            content.appendChild(ui().el('div', 'music-empty', 'Could not load this view.'));

            // Focusable retry (never disabled): clears the failure and re-renders, which
            // lets ensureMusicDimension load again.
            var retry = ui().el('button', 'music-retry-btn', 'Retry');
            retry.type = 'button';
            retry.onclick = function () {
                if (musicHome && musicHome.dimensionFailed === key) {
                    musicHome.dimensionFailed = null;

                    if (musicHome.dimensionCache) {
                        musicHome.dimensionCache[key] = null;
                    }

                    musicStatusText = '';
                    renderMusicHome(false);
                }
                return false;
            };
            content.appendChild(retry);
            return;
        }

        var entry = ensureMusicDimension(key);

        if (!entry || (!entry.loaded && !entry.error)) {
            content.appendChild(ui().el('div', 'music-empty', 'Loading...'));
            return;
        }

        if (entry.error) {
            // Never a blank screen: keep the chips and surface the failure on the status line.
            musicStatusText = 'Could not load ' +
                (key === 'Albums' ? 'albums' : (key === 'Songs' ? 'songs' : 'genres')) + '.';
            content.appendChild(ui().el('div', 'music-empty', 'Could not load this view.'));
            return;
        }

        if (key === 'Genres') {
            renderGenreGrid(content, entry);
            return;
        }

        var items = entry.items || [];
        var emptyMsg = key === 'Albums' ? 'No albums found.' : 'No songs found.';

        if (!items.length) {
            content.appendChild(ui().el('div', 'music-empty', emptyMsg));
            return;
        }

        var grid = ui().el('div', 'card-list music-grid');

        for (var i = 0; i < items.length; i++) {
            grid.appendChild(makeCard(items[i], key === 'Albums' ? openDimensionAlbum : openDimensionSong));
        }

        content.appendChild(grid);
    }

    function openDimensionAlbum(item) {
        if (!musicHome) {
            return;
        }

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
    }

    function openDimensionSong(item) {
        var entry = musicHome && musicHome.dimensionCache ? musicHome.dimensionCache.Songs : null;

        if (!entry) {
            return;
        }

        startAudioSession(entry.items, item.Id);
    }

    function renderGenreGrid(content, entry) {
        var genres = entry.genres || [];

        if (!genres.length) {
            content.appendChild(ui().el('div', 'music-empty', 'No genres found.'));
            return;
        }

        var grid = ui().el('div', 'music-genre-grid');

        for (var i = 0; i < genres.length; i++) {
            (function (name) {
                var button = ui().el('button', 'music-genre-btn', name);
                button.type = 'button';
                button.onclick = function () {
                    openGenre(name);
                    return false;
                };
                grid.appendChild(button);
            })(genres[i]);
        }

        content.appendChild(grid);
    }

    // Releases the genre drill-down's single back entry when the user leaves it by a route
    // other than Back (a chip or a new search), so no stale handler survives (F3).
    function releaseGenreHandler() {
        if (genreHandlerOpen) {
            genreHandlerOpen = false;
            ui().popBackHandler();
        }
    }

    function openGenre(name) {
        if (!musicHome) {
            return;
        }

        musicHome.dimension = 'genre';
        musicHome.genre = name;
        musicStatusText = '';

        // One back entry for the drill-down (F3): hardware Back returns to the genre grid.
        // handleBack() pops before invoking, so backToGenres() must not pop; the on-screen
        // affordance routes through handleBack() too. The flag keeps exactly one entry even
        // if openGenre were ever re-entered.
        if (!genreHandlerOpen) {
            genreHandlerOpen = true;
            ui().pushBackHandler(function () {
                backToGenres();
            });
        }

        renderMusicHome(false);
    }

    function backToGenres() {
        if (!musicHome) {
            return;
        }

        // The handler was already popped by handleBack(); just clear the flag and render.
        genreHandlerOpen = false;
        musicHome.dimension = 'Genres';
        musicHome.genre = null;
        musicStatusText = '';
        renderMusicHome(false);
    }

    function filterSongsByGenre(items, genre) {
        var out = [];

        for (var i = 0; items && i < items.length; i++) {
            if (items[i] && items[i].Genres && items[i].Genres.indexOf(genre) >= 0) {
                out.push(items[i]);
            }
        }

        return out;
    }

    // Genre drill-down: songs filtered client-side from the already-fetched audio items, shown
    // as cards under a small header with a Back-to-genres affordance; a tap starts an audio-only
    // session over the filtered list.
    function renderMusicGenreSongs(content) {
        var entry = musicHome.dimensionCache ? musicHome.dimensionCache.Genres : null;

        var head = ui().el('div', 'music-results-head');
        head.appendChild(ui().el('h2', 'music-results-title', 'Genre: ' + (musicHome.genre || '')));

        var back = ui().el('button', 'music-genre-back-btn', 'Back to genres');
        back.type = 'button';
        back.onclick = function () {
            // Pop the drill-down's single entry and invoke backToGenres() when this screen
            // owns one; otherwise (e.g. the entry was already released by another route)
            // render the genre grid directly, so this button never pops a handler it does
            // not own (F3).
            if (genreHandlerOpen) {
                ui().handleBack();
            } else {
                backToGenres();
            }
            return false;
        };
        head.appendChild(back);
        content.appendChild(head);

        if (!entry || !entry.loaded) {
            content.appendChild(ui().el('div', 'music-empty', 'Loading...'));
            return;
        }

        var songs = filterSongsByGenre(entry.items, musicHome.genre);

        if (!songs.length) {
            content.appendChild(ui().el('div', 'music-empty', 'No songs found.'));
            return;
        }

        var grid = ui().el('div', 'card-list music-grid');

        for (var i = 0; i < songs.length; i++) {
            (function (song, list) {
                grid.appendChild(makeCard(song, function () {
                    startAudioSession(list, song.Id);
                }));
            })(songs[i], songs);
        }

        content.appendChild(grid);
    }

    /* Functional search (Workstream A3): the topbar field is real now. A term is sent to /Items
     * as SearchTerm and the results replace the whole content area until cleared. */

    function runMusicSearch(rawTerm) {
        if (!musicHome) {
            return;
        }

        var term = String(rawTerm || '').replace(/^\s+|\s+$/g, '');

        // Blank/whitespace term is a no-op.
        if (!term) {
            return;
        }

        // A search replaces the content area, so leaving the genre drill-down releases its
        // single back entry first (F3).
        releaseGenreHandler();

        musicHome.search = { term: term, loading: true, loaded: false, error: false, items: [] };

        // A search replaces the content area, so it also resets the browse dimension: a
        // cleared search must never fall back into a stale genre drill-down (an empty
        // 'Genre: ' screen whose Back affordance would pop the base handler and exit
        // Music). Clear search always returns to the normal artist grid.
        musicHome.dimension = 'artists';
        musicHome.genre = null;
        musicStatusText = '';

        renderMusicHome(false);

        var home = musicHome;

        api().getItems({
            ParentId: home.libraryId,
            Recursive: true,
            IncludeItemTypes: 'Audio,MusicAlbum,MusicArtist',
            SearchTerm: term,
            SortBy: 'SortName',
            SortOrder: 'Ascending',
            Fields: 'PrimaryImageAspectRatio',
            Limit: 100
        }, function (data) {
            if (musicHome !== home || !home.search || home.search.term !== term) {
                return;
            }

            home.search.items = (data && data.Items) ? data.Items : [];
            home.search.loading = false;
            home.search.loaded = true;

            if (isViewActive('musicView')) {
                renderMusicHome(false);
            }
        }, function () {
            if (musicHome !== home || !home.search || home.search.term !== term) {
                return;
            }

            home.search.loading = false;
            home.search.error = true;

            if (isViewActive('musicView')) {
                renderMusicHome(false);
            }
        });
    }

    function clearMusicSearch() {
        if (!musicHome) {
            return;
        }

        musicHome.search = null;

        // Belt-and-braces with runMusicSearch: clearing a search always returns to the
        // normal artist grid, never a stale genre drill-down whose Back affordance would
        // pop the base handler and exit Music.
        musicHome.dimension = 'artists';
        musicHome.genre = null;
        musicStatusText = '';
        renderMusicHome(false);
    }

    function renderMusicSearchResults(content) {
        var search = musicHome.search;

        var head = ui().el('div', 'music-results-head');
        head.appendChild(ui().el('h2', 'music-results-title', 'Results for "' + search.term + '"'));

        var clear = ui().el('button', 'music-clear-btn', 'Clear search');
        clear.type = 'button';
        clear.onclick = function () {
            clearMusicSearch();
            return false;
        };
        head.appendChild(clear);
        content.appendChild(head);

        if (search.loading) {
            content.appendChild(ui().el('div', 'music-empty', 'Loading...'));
            return;
        }

        if (search.error) {
            // ui().showError clears the box it is given, so it goes into its own sub-container
            // to keep the header and Clear search reachable above the error.
            var errBox = ui().el('div', 'music-results-error');
            content.appendChild(errBox);
            ui().showError(errBox, null, 'Could not run the search.');
            return;
        }

        if (!search.items.length) {
            content.appendChild(ui().el('div', 'music-empty', 'No results.'));
            return;
        }

        var grid = ui().el('div', 'card-list music-grid');

        for (var i = 0; i < search.items.length; i++) {
            grid.appendChild(makeCard(search.items[i], openMusicSearchResult));
        }

        content.appendChild(grid);
    }

    // Audio -> an audio-only session over the audio results; MusicAlbum -> its tracks; a
    // MusicArtist -> the artist view.
    function openMusicSearchResult(item) {
        if (!musicHome || !musicHome.search) {
            return;
        }

        if (item.Type === 'MusicArtist') {
            openArtist(item, musicHome.userId);
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

        startAudioSession(musicHome.search.items, item.Id);
    }

    /* Shelves: "Jump back in" (Resume), "Recently added" (DateCreated) and "Most played"
     * (PlayCount). Each renders only when non-empty; a failure hides only its own band. */

    function buildShelfDefs() {
        return [
            { key: 'jump', title: 'Jump back in', items: [], loaded: false },
            { key: 'recent', title: 'Recently added', items: [], loaded: false },
            { key: 'played', title: 'Most played', items: [], loaded: false }
        ];
    }

    function hasShelfItems(shelves) {
        for (var i = 0; shelves && i < shelves.length; i++) {
            if (shelves[i].items && shelves[i].items.length) {
                return true;
            }
        }

        return false;
    }

    function setShelfItems(home, key, items) {
        for (var i = 0; i < home.shelves.length; i++) {
            if (home.shelves[i].key === key) {
                home.shelves[i].items = items || [];
                home.shelves[i].loaded = true;
                break;
            }
        }

        // Only the artist home carries shelves; a late response must never disturb a dimension
        // grid or an active search.
        if (isViewActive('musicView') && !home.search && home.dimension === 'artists') {
            insertMusicShelves();
        }
    }

    function loadMusicShelves() {
        var home = musicHome;

        if (!home) {
            return;
        }

        // "Jump back in" keeps the Resume endpoint and the playable music entries (max 8).
        api().getResume(home.userId, function (data) {
            if (musicHome !== home) {
                return;
            }

            var raw = (data && data.Items) ? data.Items : [];
            var items = [];

            for (var i = 0; i < raw.length && items.length < 8; i++) {
                if (raw[i] && (raw[i].Type === 'Audio' || raw[i].Type === 'MusicAlbum')) {
                    items.push(raw[i]);
                }
            }

            setShelfItems(home, 'jump', items);
        }, function () {
            if (musicHome !== home) {
                return;
            }

            setShelfItems(home, 'jump', []);
        });

        api().getItems({
            ParentId: home.libraryId,
            Recursive: true,
            IncludeItemTypes: 'MusicAlbum,Audio',
            SortBy: 'DateCreated',
            SortOrder: 'Descending',
            Fields: 'PrimaryImageAspectRatio',
            Limit: 8
        }, function (data) {
            if (musicHome !== home) {
                return;
            }

            setShelfItems(home, 'recent', (data && data.Items) ? data.Items : []);
        }, function () {
            if (musicHome !== home) {
                return;
            }

            setShelfItems(home, 'recent', []);
        });

        api().getItems({
            ParentId: home.libraryId,
            Recursive: true,
            IncludeItemTypes: 'MusicAlbum,Audio',
            SortBy: 'PlayCount',
            SortOrder: 'Descending',
            Filters: 'IsPlayed',
            Fields: 'PrimaryImageAspectRatio',
            Limit: 8
        }, function (data) {
            if (musicHome !== home) {
                return;
            }

            setShelfItems(home, 'played', (data && data.Items) ? data.Items : []);
        }, function () {
            if (musicHome !== home) {
                return;
            }

            setShelfItems(home, 'played', []);
        });
    }

    // Rebuilds the whole shelf region in place (before the artist grid) so a late shelf
    // response never triggers a full re-render that would steal D-pad focus.
    function insertMusicShelves() {
        var content = document.querySelector('#musicView .music-content');
        var grid = content ? content.querySelector('.music-grid') : null;

        if (!content || !grid || !musicHome) {
            return;
        }

        var existing = content.querySelector('.music-shelves');
        var hadFocus = !!(existing && document.activeElement && existing.contains &&
            existing.contains(document.activeElement));

        if (existing) {
            content.removeChild(existing);
        }

        if (!hasShelfItems(musicHome.shelves)) {
            return;
        }

        var wrap = buildMusicShelves();
        content.insertBefore(wrap, grid);

        if (hadFocus) {
            var card = wrap.querySelector('.card');

            if (card) {
                card.focus();
            }
        }
    }

    function buildMusicShelves() {
        var wrap = ui().el('div', 'music-shelves');

        for (var i = 0; i < musicHome.shelves.length; i++) {
            if (musicHome.shelves[i].items && musicHome.shelves[i].items.length) {
                wrap.appendChild(buildMusicShelf(musicHome.shelves[i]));
            }
        }

        return wrap;
    }

    function buildMusicShelf(shelf) {
        var shelfEl = ui().el('div', 'music-shelf');

        var head = ui().el('div', 'folder-section-head');
        head.appendChild(ui().el('h2', 'folder-section-title', shelf.title));
        shelfEl.appendChild(head);

        var list = ui().el('div', 'card-list');

        for (var i = 0; i < shelf.items.length; i++) {
            (function (shelfRef, item) {
                list.appendChild(makeCard(item, function () {
                    playShelfItem(item, shelfRef);
                }));
            })(shelf, shelf.items[i]);
        }

        shelfEl.appendChild(list);

        return shelfEl;
    }

    // Audio items join their shelf's audio-only ordered session. A MusicAlbum would be
    // misrouted by the session to the video player, so it opens its album through the generic
    // items view instead.
    function playShelfItem(item, shelf) {
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

        startAudioSession(shelf.items, item.Id);
    }

    // One shared audio-session starter for every music surface: build an Audio-only queue from
    // the supplied items, find the tapped track, and play it as an ordered session whose end
    // returns to the music home and mirrors a playback failure onto the status line.
    function startAudioSession(items, itemId) {
        if (!musicHome) {
            return;
        }

        var queue = [];
        var index = -1;
        var i;

        for (i = 0; items && i < items.length; i++) {
            if (items[i] && items[i].Type === 'Audio') {
                if (items[i].Id === itemId) {
                    index = queue.length;
                }
                queue.push(items[i]);
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

    // Numeric returns on the queue calls: playNext / appendQueue / clearQueue return the
    // resulting COMBINED queue depth (session + pending; clearQueue itself returns
    // nothing meaningful), and getQueue returns a COPY of whichever queue is visible
    // (active session → listQueue, otherwise pendingQueue). Pre-session rows ("Play
    // next" / "Add to queue", labels locked by the acceptance criteria) fill the pending
    // queue that the next all-Audio session adopts.
    namespace.playlist = {
        isActive: playlistIsActive,
        start: playlistStart,
        advance: playlistAdvance,
        next: playlistNext,
        previous: playlistPrevious,
        hasNext: playlistHasNext,
        hasPrevious: playlistHasPrevious,
        stop: playlistEnd,
        getRepeat: playlistGetRepeat,
        setRepeat: playlistSetRepeat,
        isShuffle: playlistIsShuffle,
        setShuffle: playlistSetShuffle,
        getQueue: playlistGetQueue,
        playNext: playlistPlayNext,
        appendQueue: playlistAppendQueue,
        clearQueue: playlistClearQueue
    };

    // User-built playlists (plural). The session API above is untouched; this is the dynamic
    // storage surface (keying + list/read/create/rename/delete/reorder/disable/add/remove),
    // backed by localStorage, plus the legacy index-based aliases over the same model.
    namespace.playlists = {
        setServerId: setServerId,

        // Dynamic named playlists (Tier 3).
        listPlaylists: listPlaylists,
        getPlaylistItems: getPlaylistItems,
        createPlaylist: createPlaylist,
        renamePlaylist: renamePlaylist,
        deletePlaylist: deletePlaylist,
        movePlaylistItem: movePlaylistItem,
        setItemDisabled: setItemDisabled,
        addItemToPlaylist: addItemToPlaylist,
        removePlaylistItem: removePlaylistItem,

        // Legacy index-based aliases (kept for documented behavior contracts).
        listSlots: listSlots,
        getSlotItems: getSlotItems,
        addToSlot: addToSlot,
        removeAt: removeAt,
        clearSlot: clearSlot
    };
})(Michelly);
