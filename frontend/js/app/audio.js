/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 */

var Michelly = window.Michelly = window.Michelly || {};

(function (namespace) {
    'use strict';

    var PROGRESS_INTERVAL = 15000;
    var TICKS_PER_SECOND = 10000000;

    var progressTimer = null;
    var currentItem = null;
    var currentMediaSourceId = null;
    var activeToken = 0;
    var eventsBound = false;
    // True once /Sessions/Playing was posted for the current item, so stop() only posts the
    // matching /Sessions/Playing/Stopped when a Playing actually went out.
    var sourceLoaded = false;

    // Queue-overlay UI state. The overlay pushes exactly one back handler while open
    // (same discipline as the item-view slot picker in catalog.js). It exists only while
    // a list session is active: the mode controls are hidden for a single-item play, so
    // the overlay can never be opened there. It never survives a card rebuild — play()
    // rebuilds the now-playing card with the overlay closed by default.
    //
    // OWNERSHIP INVARIANT: this flag survives a WHOLESALE back-stack replacement
    // (setBackHandler -> clearBackHandlers), not just a pop. No reachable surface does
    // that while the overlay could be open today (#audioView's only tabbables are the
    // card buttons and nothing there calls setBackHandler), but the render fold makes a
    // stale true flag destructive: renderNowPlaying() would pop an entry the overlay no
    // longer owns. RULE for any future surface that replaces the back stack (view
    // navigation, a new modal, anything calling setBackHandler) while the overlay could
    // be open: it MUST reset queueOverlayOpen = false WITHOUT popping — the overlay's
    // entry is already gone with the stack it lived on, and popping would steal a live
    // entry belonging to someone else.
    var queueOverlayOpen = false;

    function ui() {
        return namespace.ui;
    }

    function api() {
        return namespace.api;
    }

    // True while an ordered list session is driving this player. In that mode the playlist
    // owns the single back-stack entry and the auto-advance, so the player must not push one.
    function listMode() {
        return !!(namespace.playlist && namespace.playlist.isActive());
    }

    function audio() {
        return document.querySelector('#playerAudio');
    }

    // Prefer a source the TV can stream/play directly; transcoding is a non-goal.
    function pickMediaSource(data) {
        var sources = (data && data.MediaSources) ? data.MediaSources : [];
        var fallback = null;

        for (var i = 0; i < sources.length; i++) {
            if (!fallback) {
                fallback = sources[i];
            }
            if (sources[i].SupportsDirectStream || sources[i].SupportsDirectPlay) {
                return sources[i];
            }
        }

        return fallback;
    }

    // First audio stream in the source; its codec feeds the stream URL. The REST API
    // serialises MediaStream.Type as the string 'Audio' (MediaStreamType ordinal:
    // Audio=0, Video=1, Subtitle=2), so the string match is primary and the numeric 0 is
    // kept only as a legacy fallback.
    function firstAudioCodec(source) {
        var streams = (source && source.MediaStreams) ? source.MediaStreams : [];

        for (var i = 0; i < streams.length; i++) {
            if (streams[i].Type === 'Audio' || streams[i].Type === 0) {
                return streams[i].Codec || '';
            }
        }

        return '';
    }

    function positionTicks(a) {
        return Math.floor((a && a.currentTime ? a.currentTime : 0) * TICKS_PER_SECOND);
    }

    function reportPlaying(item, source) {
        api().postSession('/Sessions/Playing', {
            ItemId: item.Id,
            MediaSourceId: source ? source.Id : null,
            PositionTicks: 0,
            CanSeek: true,
            PlayMethod: 'DirectStream'
        });
    }

    function startProgressTimer() {
        stopProgressTimer();

        progressTimer = setInterval(function () {
            var a = audio();

            if (!a || !currentItem) {
                return;
            }

            api().postSession('/Sessions/Playing/Progress', {
                ItemId: currentItem.Id,
                MediaSourceId: currentMediaSourceId,
                PositionTicks: positionTicks(a),
                IsPaused: !!a.paused,
                CanSeek: true,
                PlayMethod: 'DirectStream'
            });
        }, PROGRESS_INTERVAL);
    }

    function stopProgressTimer() {
        if (progressTimer) {
            clearInterval(progressTimer);
            progressTimer = null;
        }
    }

    function reportStopped(ticks) {
        if (!currentItem) {
            return;
        }

        api().postSession('/Sessions/Playing/Stopped', {
            ItemId: currentItem.Id,
            MediaSourceId: currentMediaSourceId,
            PositionTicks: ticks || 0
        });
    }

    function clearAudio() {
        var a = audio();

        if (!a) {
            return;
        }

        a.onended = null;
        a.onerror = null;

        try {
            a.pause();
        } catch (pauseError) {
            console.warn(pauseError);
        }

        a.src = '';

        try {
            a.load();
        } catch (loadError) {
            console.warn(loadError);
        }
    }

    // Stops playback and returns to the item detail view. The audio player's own back
    // handler stays on the stack, so a following Back reaches the item's handler.
    function stop() {
        var a = audio();
        var ticks = positionTicks(a);

        activeToken++;
        stopProgressTimer();
        clearAudio();

        // If the queue overlay was open, its back entry sits above the playlist's own
        // one. The playlist teardown that reaches this stop pops the session handler
        // right after, so the overlay's entry must go first — otherwise the next Back
        // would consume a dead session entry instead of the item view's handler
        // (the "exactly one pop per Back" invariant). Popping the overlay's own entry
        // here is safe: it was pushed on open and can only still be on the stack while
        // this audio session is the active view.
        if (queueOverlayOpen) {
            closeQueueOverlay(true, false);
        }

        // Only post Stopped for an item whose Playing was actually posted; otherwise this
        // is a phantom stop for something that never started.
        if (sourceLoaded) {
            reportStopped(ticks);
        }
        sourceLoaded = false;

        currentMediaSourceId = null;
    }

    // Playback finished on its own (or failed): remove the audio back entry too.
    function finish() {
        // In list mode the playlist owns the back entry and tears the player down; the
        // same path must never auto-advance into a broken loop.
        if (listMode()) {
            namespace.playlist.stop();
            return;
        }

        if (ui().hasBackHandler()) {
            ui().popBackHandler();
        }
        stop();
        ui().showView('itemView');
    }

    function formatTime(value) {
        var total = (!value || !isFinite(value) || value < 0) ? 0 : Math.floor(value);
        var mins = Math.floor(total / 60);
        var secs = total % 60;

        return mins + ':' + (secs < 10 ? '0' + secs : String(secs));
    }

    function updateTime() {
        var a = audio();
        var out = document.querySelector('#audioTime');

        if (!a || !out) {
            return;
        }

        out.textContent = formatTime(a.currentTime) + ' / ' + formatTime(a.duration);
    }

    // Keeps the button label in sync with the element's actual paused state.
    function updateToggleLabel() {
        var a = audio();
        var button = document.querySelector('#audioToggle');

        if (!button || !a) {
            return;
        }

        button.textContent = a.paused ? 'Play' : 'Pause';
    }

    function focusToggle() {
        var button = document.querySelector('#audioToggle');

        if (button) {
            button.focus();
        }
    }

    // Shows/dims the Prev/Next list controls. They are hidden entirely for a single-item
    // play, so that path behaves exactly as before. Dimming is a CSS attribute change only:
    // the button stays focusable and its onclick simply no-ops at a boundary. Never set the
    // `disabled` attribute — navigate() in index.js includes any element with
    // offsetWidth > 0 && offsetHeight > 0, and .focus() on a disabled button silently
    // fails, which would make the D-pad appear stuck.
    //
    // NOTE (teardown discipline): this function intentionally contains NO overlay fold for
    // an ended session. Every inactive pop is owned by stop() (its queueOverlayOpen branch
    // pops the overlay's entry before the session teardown pops the session entry), so an
    // updateListControls() call after a teardown never pops anything.
    function updateListControls() {
        var playlist = namespace.playlist;
        var active = !!(playlist && playlist.isActive());
        var prev = document.querySelector('#audioPrev');
        var next = document.querySelector('#audioNext');

        if (prev) {
            prev.style.display = active ? '' : 'none';
            prev.className = (active && !playlist.hasPrevious()) ? 'audio-skip is-inert' : 'audio-skip';
        }

        if (next) {
            next.style.display = active ? '' : 'none';
            next.className = (active && !playlist.hasNext()) ? 'audio-skip is-inert' : 'audio-skip';
        }

        // Playback-mode controls share Prev/Next's gate: hidden entirely for a
        // single-item play (that D-pad walk is unchanged), always focusable while a
        // session is active (a mode press is never a no-op). Never disabled.
        var repeat = document.querySelector('#audioRepeat');

        if (repeat) {
            repeat.style.display = active ? '' : 'none';
            repeat.className = 'audio-skip audio-mode';
            repeat.textContent = 'Repeat: ' + repeatLabel(active ? playlist.getRepeat() : 'off');
        }

        var shuffle = document.querySelector('#audioShuffle');

        if (shuffle) {
            shuffle.style.display = active ? '' : 'none';
            shuffle.className = 'audio-skip audio-mode';
            shuffle.textContent = 'Shuffle: ' + (active && playlist.isShuffle() ? 'On' : 'Off');
        }

        // One getQueue() call: it returns a fresh copy each time, so repeating the call
        // would make the label read two different slices. Inactive → 0 (no session, no
        // live queue; the card is a session-driven surface regardless).
        var queueBtn = document.querySelector('#audioQueueBtn');
        var q = active ? playlist.getQueue() : [];

        if (queueBtn) {
            queueBtn.style.display = active ? '' : 'none';
            queueBtn.className = 'audio-skip audio-mode';
            queueBtn.textContent = 'Queue: ' + q.length;
        }

        var queueBox = document.querySelector('#audioQueue');

        if (queueBox && !active) {
            queueBox.style.display = 'none';
        }
    }

    function repeatLabel(mode) {
        if (mode === 'all') {
            return 'All';
        }

        if (mode === 'one') {
            return 'One';
        }

        return 'Off';
    }

    // repeat off -> all -> one -> off, one step per press.
    function cycleRepeat() {
        var playlist = namespace.playlist;

        if (!playlist || !playlist.isActive()) {
            return;
        }

        var mode = playlist.setRepeat(
            playlist.getRepeat() === 'off' ? 'all' : (playlist.getRepeat() === 'all' ? 'one' : 'off')
        );

        var button = document.querySelector('#audioRepeat');

        if (button) {
            button.textContent = 'Repeat: ' + repeatLabel(mode);
        }

        updateListControls();
    }

    function toggleShuffle() {
        var playlist = namespace.playlist;

        if (!playlist || !playlist.isActive()) {
            return;
        }

        playlist.setShuffle(!playlist.isShuffle());

        var button = document.querySelector('#audioShuffle');

        if (button) {
            button.textContent = 'Shuffle: ' + (playlist.isShuffle() ? 'On' : 'Off');
        }

        updateListControls();
    }

    /* Queue overlay (visible surface of the session queue). Rows are non-tabbable divs
     * in play order, head first. Renderer reads the live queue from the playlist owner
     * (catalog.js); called on open and after any UI mutation of the queue. */

    function renderQueueRows() {
        var playlist = namespace.playlist;
        var items = (playlist && playlist.isActive()) ? playlist.getQueue() : [];
        var box = document.querySelector('#audioQueue');

        if (!box) {
            return;
        }

        var rows = box.querySelector('.audio-queue-rows');

        if (!rows) {
            return;
        }

        ui().clear(rows);

        if (!items.length) {
            rows.appendChild(ui().el('div', 'audio-queue-empty', 'Queue is empty'));
        } else {
            for (var i = 0; i < items.length; i++) {
                rows.appendChild(ui().el('div', 'audio-queue-row', items[i].Name || 'Untitled'));
            }
        }

        var clearBtn = box.querySelector('#audioQueueClear');

        if (clearBtn) {
            clearBtn.className = items.length ? 'audio-skip' : 'audio-skip is-inert';
        }
    }

    function openQueueOverlay() {
        var box = document.querySelector('#audioQueue');

        if (!box || queueOverlayOpen) {
            return;
        }

        queueOverlayOpen = true;
        renderQueueRows();
        box.style.display = '';

        // Exactly one back entry while the overlay is open. handleBack() pops before
        // invoking, so the pushed handler must not pop (mirrors the slot-picker
        // convention in catalog.js); on-screen Close/Clear actions own the pop.
        ui().pushBackHandler(function () {
            closeQueueOverlay(false, true);
        });

        var first = box.querySelector('button');

        if (first) {
            first.focus();
        }
    }

    // popHandler: on-screen close buttons pop their own entry; the pushed back handler
    // (hardware Back) does not, because handleBack already popped it. refocus returns
    // the pointer anchor to the Queue toggle so the D-pad walk stays predictable.
    function closeQueueOverlay(popHandler, refocus) {
        queueOverlayOpen = false;

        if (popHandler) {
            ui().popBackHandler();
        }

        var box = document.querySelector('#audioQueue');

        if (box) {
            box.style.display = 'none';
        }

        if (refocus) {
            var queueBtn = document.querySelector('#audioQueueBtn');

            if (queueBtn) {
                queueBtn.focus();
            }
        }
    }

    function toggleQueueOverlay() {
        if (queueOverlayOpen) {
            closeQueueOverlay(true, true);
            return;
        }

        openQueueOverlay();
    }

    function clearQueueFromUi() {
        var playlist = namespace.playlist;

        if (playlist && playlist.isActive()) {
            playlist.clearQueue();
        }

        // Rows re-render and the Queue: n label follows; the overlay stays open and
        // still owns its back entry, so hardware Back keeps closing the overlay first.
        renderQueueRows();
        updateListControls();
    }

    // True when focus is on a <button> inside the given view. Such a control handles
    // OK/Space itself through its own click, so the document-level handler must not
    // toggle as well (a focused #audioToggle would otherwise double-toggle to a no-op).
    function isButtonFocused(view) {
        var active = document.activeElement;

        if (!view || !active || String(active.tagName).toUpperCase() !== 'BUTTON') {
            return false;
        }

        while (active) {
            if (active === view) {
                return true;
            }
            active = active.parentNode;
        }

        return false;
    }

    // Bound once: the play/pause/time events keep the label and time readout live.
    function bindAudioEvents() {
        var a = audio();

        if (eventsBound || !a) {
            return;
        }

        eventsBound = true;

        a.addEventListener('play', function () {
            updateToggleLabel();
        });
        a.addEventListener('pause', function () {
            updateToggleLabel();
        });
        a.addEventListener('timeupdate', function () {
            updateTime();
        });
        a.addEventListener('loadedmetadata', function () {
            updateTime();
        });
    }

    function renderNowPlaying(item) {
        var view = document.querySelector('#audioView');

        if (!view) {
            return;
        }

        // A rebuild replaces the .audio-now node the overlay lives in. If the overlay is
        // still open here (auto-advance or Next started a new play), the old node dies but
        // its pushed back entry would survive it — leaving a live handler whose widget is
        // gone, so the next hardware Back would eat a dead press. Fold the overlay NOW,
        // popping the entry the destroyed node owned (pop=true; no refocus needed — play()
        // seeds focus on the fresh card right after). This also keeps stop()'s own
        // queueOverlayOpen fold idempotent: the flag is false by the time it runs.
        if (queueOverlayOpen) {
            closeQueueOverlay(true, false);
        }

        var existing = view.querySelector('.audio-now');

        if (existing) {
            view.removeChild(existing);
        }

        var card = ui().el('div', 'audio-now');

        var posterWrap = ui().el('div', 'audio-poster');
        var img = document.createElement('img');
        img.alt = item.Name || '';
        posterWrap.appendChild(img);
        card.appendChild(posterWrap);

        var tag = item.ImageTags && item.ImageTags.Primary;
        ui().renderImage(img, tag ? api().imageUrl(item.Id, 'Primary', { maxWidth: 480, tag: tag }) : null, item.Name || '');

        card.appendChild(ui().el('div', 'audio-title', item.Name || 'Untitled'));

        var artist = (item.Artists && item.Artists.length) ? item.Artists.join(', ') : item.AlbumArtist;

        if (artist) {
            card.appendChild(ui().el('div', 'audio-artist', artist));
        }

        if (item.Album) {
            card.appendChild(ui().el('div', 'audio-album', item.Album));
        }

        var time = ui().el('div', 'audio-time', '0:00 / 0:00');
        time.id = 'audioTime';
        card.appendChild(time);

        var prev = ui().el('button', 'audio-skip', 'Prev');
        prev.id = 'audioPrev';
        prev.type = 'button';
        prev.tabIndex = 0;
        // OK/Space while the button is focused acts here, explicitly, so it does not depend
        // on the platform synthesizing a click from the key. preventDefault() + returning
        // false suppress that synthetic click, so the onclick below (pointer use) cannot
        // fire a second time.
        prev.onkeydown = function (keyEvent) {
            var key = keyEvent || window.event;

            if (key.keyCode === 13 || key.keyCode === 32) {
                namespace.playlist.previous();
                if (key.preventDefault) {
                    key.preventDefault();
                }
                return false;
            }
        };
        prev.onclick = function () {
            namespace.playlist.previous();
        };
        card.appendChild(prev);

        var button = ui().el('button', 'audio-toggle', 'Play');
        button.id = 'audioToggle';
        button.type = 'button';
        button.tabIndex = 0;
        // OK/Space while the button is focused toggles here, explicitly, so it does not
        // depend on the platform synthesizing a click from the key. preventDefault() +
        // returning false suppress that synthetic click, so the onclick below (pointer
        // use) cannot toggle a second time. The document-level handler early-returns when
        // a button in this view is focused, so it cannot toggle either.
        button.onkeydown = function (keyEvent) {
            var key = keyEvent || window.event;

            if (key.keyCode === 13 || key.keyCode === 32) {
                toggle();
                if (key.preventDefault) {
                    key.preventDefault();
                }
                return false;
            }
        };
        button.onclick = function () {
            toggle();
        };
        card.appendChild(button);

        var next = ui().el('button', 'audio-skip', 'Next');
        next.id = 'audioNext';
        next.type = 'button';
        next.tabIndex = 0;
        // Same explicit OK/Space handling as the toggle/skip buttons: act on keydown and
        // suppress the synthetic click so a synthesizing platform cannot double-fire.
        next.onkeydown = function (keyEvent) {
            var key = keyEvent || window.event;

            if (key.keyCode === 13 || key.keyCode === 32) {
                namespace.playlist.next();
                if (key.preventDefault) {
                    key.preventDefault();
                }
                return false;
            }
        };
        next.onclick = function () {
            namespace.playlist.next();
        };
        card.appendChild(next);

        var repeatBtn = ui().el('button', 'audio-skip audio-mode', 'Repeat: Off');
        repeatBtn.id = 'audioRepeat';
        repeatBtn.type = 'button';
        repeatBtn.tabIndex = 0;
        // Same explicit OK/Space handling as the toggle/skip buttons: act on keydown and
        // suppress the synthetic click so a synthesizing platform cannot double-fire.
        repeatBtn.onkeydown = function (keyEvent) {
            var key = keyEvent || window.event;

            if (key.keyCode === 13 || key.keyCode === 32) {
                cycleRepeat();
                if (key.preventDefault) {
                    key.preventDefault();
                }
                return false;
            }
        };
        repeatBtn.onclick = function () {
            cycleRepeat();
            return false;
        };
        card.appendChild(repeatBtn);

        var shuffleBtn = ui().el('button', 'audio-skip audio-mode', 'Shuffle: Off');
        shuffleBtn.id = 'audioShuffle';
        shuffleBtn.type = 'button';
        shuffleBtn.tabIndex = 0;
        shuffleBtn.onkeydown = function (keyEvent) {
            var key = keyEvent || window.event;

            if (key.keyCode === 13 || key.keyCode === 32) {
                toggleShuffle();
                if (key.preventDefault) {
                    key.preventDefault();
                }
                return false;
            }
        };
        shuffleBtn.onclick = function () {
            toggleShuffle();
            return false;
        };
        card.appendChild(shuffleBtn);

        var queueBtn = ui().el('button', 'audio-skip audio-mode', 'Queue: 0');
        queueBtn.id = 'audioQueueBtn';
        queueBtn.type = 'button';
        queueBtn.tabIndex = 0;
        queueBtn.onkeydown = function (keyEvent) {
            var key = keyEvent || window.event;

            if (key.keyCode === 13 || key.keyCode === 32) {
                toggleQueueOverlay();
                if (key.preventDefault) {
                    key.preventDefault();
                }
                return false;
            }
        };
        queueBtn.onclick = function () {
            toggleQueueOverlay();
            return false;
        };
        card.appendChild(queueBtn);

        // Queue overlay container: built once per card, hidden by default. Overlay state
        // does not survive a card rebuild — play() always rebuilds with it closed, which
        // is the documented behaviour (rows re-render on open instead of being kept).
        var queueBox = ui().el('div', 'audio-queue');
        queueBox.id = 'audioQueue';
        queueBox.style.display = 'none';

        var queueRows = ui().el('div', 'audio-queue-rows');
        queueBox.appendChild(queueRows);

        var clearBtn = ui().el('button', 'audio-skip', 'Clear queue');
        clearBtn.id = 'audioQueueClear';
        clearBtn.type = 'button';
        clearBtn.tabIndex = 0;
        clearBtn.onkeydown = function (keyEvent) {
            var key = keyEvent || window.event;

            if (key.keyCode === 13 || key.keyCode === 32) {
                clearQueueFromUi();
                if (key.preventDefault) {
                    key.preventDefault();
                }
                return false;
            }
        };
        clearBtn.onclick = function () {
            clearQueueFromUi();
            return false;
        };
        queueBox.appendChild(clearBtn);

        var closeBtn = ui().el('button', 'audio-skip', 'Close');
        closeBtn.type = 'button';
        closeBtn.tabIndex = 0;
        // On-screen close buttons pop the overlay's own back entry (pick off the picker
        // convention in catalog.js: a pushed handler must not pop, an on-screen close pops).
        closeBtn.onkeydown = function (keyEvent) {
            var key = keyEvent || window.event;

            if (key.keyCode === 13 || key.keyCode === 32) {
                closeQueueOverlay(true, true);
                if (key.preventDefault) {
                    key.preventDefault();
                }
                return false;
            }
        };
        closeBtn.onclick = function () {
            closeQueueOverlay(true, true);
            return false;
        };
        queueBox.appendChild(closeBtn);

        card.appendChild(queueBox);

        view.appendChild(card);

        updateToggleLabel();
        updateTime();
    }

    function toggle() {
        var a = audio();

        if (!a) {
            return;
        }

        if (a.paused) {
            a.play();
        } else {
            a.pause();
        }
    }

    function play(item, userId) {
        currentItem = item;
        currentMediaSourceId = null;

        activeToken++;
        var token = activeToken;

        // In list mode the playlist owns the single back entry; a single-item play keeps
        // the player's own entry, exactly as before.
        if (!listMode()) {
            ui().pushBackHandler(function () {
                stop();
                ui().showView('itemView');
            });
        }

        ui().setError('', '#itemError');
        bindAudioEvents();

        // Make #audioView the active view first, then build the card and seed focus, so the
        // card's controls are created inside the visible view and focus lands on them.
        ui().showView('audioView');
        renderNowPlaying(item);
        updateListControls();
        focusToggle();

        api().getPlaybackInfo(item.Id, userId, function (data) {
            if (token !== activeToken) {
                return;
            }

            var source = pickMediaSource(data);
            var a = audio();

            if (!source || !a) {
                finish();
                ui().setError('No playable audio source was found for this item.', '#itemError');
                return;
            }

            currentMediaSourceId = source.Id;

            var codec = firstAudioCodec(source);
            // Codec hint for the unsupported-codec error (container as a last resort).
            var codecHint = codec || source.Container || item.Container || '';

            a.src = api().audioStreamUrl(item.Id, source.Id, source.Container || item.Container, codec);

            a.onended = function () {
                // List mode: hand off to the playlist instead of finishing this item.
                if (listMode()) {
                    namespace.playlist.advance();
                    return;
                }

                finish();
            };

            a.onerror = function () {
                // Read the media error before finish() clears the element.
                var code = (a.error && a.error.code) ? a.error.code : 0;

                finish();

                if (code === 4) {
                    // code 4 covers both an unsupported codec and a failed stream
                    // request (401/404/5xx), so do not over-assert the codec.
                    if (codecHint) {
                        ui().setError('This item\'s audio codec (' + String(codecHint).toUpperCase() +
                            ') is not supported by the TV, or the stream could not be loaded.', '#itemError');
                    } else {
                        ui().setError('This item cannot be played by the TV (unsupported codec or unavailable stream).', '#itemError');
                    }
                } else {
                    ui().setError('This item cannot be played by the TV.', '#itemError');
                }
            };

            a.play();

            reportPlaying(item, source);
            sourceLoaded = true;
            startProgressTimer();
        }, function (err) {
            if (token !== activeToken) {
                return;
            }

            if (listMode()) {
                // A failed PlaybackInfo ends the list (the playlist pops its own handler)
                // rather than auto-advancing into a broken loop.
                namespace.playlist.stop();
            } else {
                ui().popBackHandler();
            }
            ui().showView('itemView');
            ui().setError(ui().describeError(err), '#itemError');
        });
    }

    // OK/Enter and Space toggle play/pause while the audio view is active. When focus is
    // on a button inside the view the control's own click already handles the key, so the
    // handler returns early; with focus elsewhere (e.g. BODY) the remote still toggles.
    document.addEventListener('keydown', function (evt) {
        evt = evt || window.event;

        var view = document.querySelector('.view.active');

        if (!view || view.id !== 'audioView') {
            return;
        }

        if (isButtonFocused(view)) {
            return;
        }

        if (evt.keyCode === 13 || evt.keyCode === 32) {
            toggle();
            if (evt.preventDefault) {
                evt.preventDefault();
            }
        }
    });

    namespace.audio = {
        play: play,
        toggle: toggle,
        stop: stop
    };
})(Michelly);
