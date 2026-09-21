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

    function ui() {
        return namespace.ui;
    }

    function api() {
        return namespace.api;
    }

    function video() {
        return document.querySelector('#playerVideo');
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

    // First video stream codec, used only for the unsupported-codec error message. The REST
    // API serialises MediaStream.Type as the string 'Video' (MediaStreamType ordinal:
    // Audio=0, Video=1, Subtitle=2), so the string match is primary; the numeric ordinal is
    // deliberately not encoded here.
    function firstVideoCodec(source) {
        var streams = (source && source.MediaStreams) ? source.MediaStreams : [];

        for (var i = 0; i < streams.length; i++) {
            if (streams[i].Type === 'Video') {
                return streams[i].Codec || '';
            }
        }

        return '';
    }

    function positionTicks(v) {
        return Math.floor((v && v.currentTime ? v.currentTime : 0) * TICKS_PER_SECOND);
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
            var v = video();

            if (!v || !currentItem) {
                return;
            }

            api().postSession('/Sessions/Playing/Progress', {
                ItemId: currentItem.Id,
                MediaSourceId: currentMediaSourceId,
                PositionTicks: positionTicks(v),
                IsPaused: !!v.paused,
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

    function clearVideo() {
        var v = video();

        if (!v) {
            return;
        }

        v.onended = null;
        v.onerror = null;

        try {
            v.pause();
        } catch (pauseError) {
            console.warn(pauseError);
        }

        v.src = '';

        try {
            v.load();
        } catch (loadError) {
            console.warn(loadError);
        }
    }

    // Stops playback and returns to the item detail view. The player's own back
    // handler stays on the stack, so a following Back reaches the item's handler.
    function stop() {
        var v = video();
        var ticks = positionTicks(v);

        activeToken++;
        stopProgressTimer();
        clearVideo();
        reportStopped(ticks);
        currentMediaSourceId = null;
    }

    // Playback finished on its own (or failed): remove the player's back entry too.
    function finish() {
        if (ui().hasBackHandler()) {
            ui().popBackHandler();
        }
        stop();
        ui().showView('itemView');
    }

    function toggle() {
        var v = video();

        if (!v) {
            return;
        }

        if (v.paused) {
            v.play();
        } else {
            v.pause();
        }
    }

    function formatTime(value) {
        var total = (!value || !isFinite(value) || value < 0) ? 0 : Math.floor(value);
        var mins = Math.floor(total / 60);
        var secs = total % 60;

        return mins + ':' + (secs < 10 ? '0' + secs : String(secs));
    }

    function updateTime() {
        var v = video();
        var out = document.querySelector('#playerTime');

        if (!v || !out) {
            return;
        }

        out.textContent = formatTime(v.currentTime) + ' / ' + formatTime(v.duration);
    }

    // Progress bar width as a percentage; guarded against NaN/0/Infinity durations.
    function updateProgress() {
        var v = video();
        var fill = document.querySelector('#playerProgressFill');

        if (!v || !fill) {
            return;
        }

        var duration = v.duration;
        var percent = 0;

        if (duration && isFinite(duration) && duration > 0) {
            percent = (v.currentTime / duration) * 100;
        }

        if (!isFinite(percent) || percent < 0) {
            percent = 0;
        }

        if (percent > 100) {
            percent = 100;
        }

        fill.style.width = percent + '%';
    }

    // Keeps the button label in sync with the element's actual paused state.
    function updateToggleLabel() {
        var v = video();
        var button = document.querySelector('#playerToggle');

        if (!button || !v) {
            return;
        }

        button.textContent = v.paused ? 'Play' : 'Pause';
    }

    function focusToggle() {
        var button = document.querySelector('#playerToggle');

        if (button) {
            button.focus();
        }
    }

    // True when focus is on a <button> inside the given view. Such a control handles
    // OK/Space itself through its own click, so the document-level handler must not
    // toggle as well (a focused #playerToggle would otherwise double-toggle to a no-op).
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

    // Bound once: the play/pause/time events keep the label, readout and bar live.
    function bindVideoEvents() {
        var v = video();

        if (eventsBound || !v) {
            return;
        }

        eventsBound = true;

        v.addEventListener('play', function () {
            updateToggleLabel();
        });
        v.addEventListener('pause', function () {
            updateToggleLabel();
        });
        v.addEventListener('timeupdate', function () {
            updateTime();
            updateProgress();
        });
        v.addEventListener('loadedmetadata', function () {
            updateTime();
            updateProgress();
        });
    }

    // Idempotently builds the always-visible, D-pad-operable overlay inside #playerView
    // (a sibling right after #playerVideo so the video keeps its 100% box). It is never
    // hidden with display:none: navigationInit()/navigate() only walk elements with
    // offsetWidth > 0 && offsetHeight > 0, so a hidden overlay would kill D-pad focus.
    function ensureControls() {
        var view = document.querySelector('#playerView');
        var v = video();

        if (!view || !v) {
            return;
        }

        if (document.querySelector('#playerControls')) {
            return;
        }

        var controls = ui().el('div', 'player-controls');
        controls.id = 'playerControls';

        var row = ui().el('div', 'player-controls-row');

        var button = ui().el('button', 'player-toggle', 'Play');
        button.id = 'playerToggle';
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
        row.appendChild(button);

        var time = ui().el('div', 'player-time', '0:00 / 0:00');
        time.id = 'playerTime';
        row.appendChild(time);

        controls.appendChild(row);

        var progress = ui().el('div', 'player-progress');
        var fill = ui().el('div', 'player-progress-fill');
        fill.id = 'playerProgressFill';
        progress.appendChild(fill);
        controls.appendChild(progress);

        controls.appendChild(ui().el('div', 'player-hint', 'OK: Play / Pause    Back: Exit'));

        if (v.nextSibling) {
            view.insertBefore(controls, v.nextSibling);
        } else {
            view.appendChild(controls);
        }

        bindVideoEvents();

        updateToggleLabel();
        updateTime();
        updateProgress();
    }

    function play(item, userId) {
        currentItem = item;
        currentMediaSourceId = null;

        activeToken++;
        var token = activeToken;

        ui().pushBackHandler(function () {
            stop();
            ui().showView('itemView');
        });

        // Build the overlay before showView() so its own navigationInit() can find it.
        ensureControls();

        // ensureControls() is idempotent, so on a replay the overlay still holds the
        // previous item's readout/bar; reset it before the new loadedmetadata arrives.
        updateToggleLabel();
        updateTime();
        updateProgress();

        ui().showView('playerView');
        ui().setError('', '#itemError');

        if (typeof navigationInit === 'function') {
            navigationInit();
        }
        focusToggle();

        api().getPlaybackInfo(item.Id, userId, function (data) {
            if (token !== activeToken) {
                return;
            }

            var source = pickMediaSource(data);
            var v = video();

            if (!source || !v) {
                finish();
                ui().setError('No playable video source was found for this item.', '#itemError');
                return;
            }

            currentMediaSourceId = source.Id;

            // Codec hint for the unsupported-codec error (container as a last resort).
            var codecHint = firstVideoCodec(source) || source.Container || item.Container || '';

            v.src = api().streamUrl(item.Id, source.Id, source.Container || item.Container || '');

            v.onended = function () {
                finish();
            };

            v.onerror = function () {
                // Read the media error before finish() clears the element.
                var code = (v.error && v.error.code) ? v.error.code : 0;

                finish();

                if (code === 4) {
                    // code 4 covers both an unsupported codec and a failed stream
                    // request (401/404/5xx), so do not over-assert the codec.
                    if (codecHint) {
                        ui().setError('This item\'s video codec (' + String(codecHint).toUpperCase() +
                            ') is not supported by the TV, or the stream could not be loaded.', '#itemError');
                    } else {
                        ui().setError('This item cannot be played by the TV (unsupported codec or unavailable stream).', '#itemError');
                    }
                } else {
                    ui().setError('This item cannot be played by the TV.', '#itemError');
                }
            };

            v.play();

            reportPlaying(item, source);
            startProgressTimer();
        }, function (err) {
            if (token !== activeToken) {
                return;
            }

            ui().popBackHandler();
            ui().showView('itemView');
            ui().setError(ui().describeError(err), '#itemError');
        });
    }

    // OK/Enter and Space toggle play/pause while the player view is active. When focus is
    // on a button inside the view the control's own click already handles the key, so the
    // handler returns early; with focus elsewhere (e.g. BODY) the remote still toggles.
    document.addEventListener('keydown', function (evt) {
        evt = evt || window.event;

        var view = document.querySelector('.view.active');

        if (!view || view.id !== 'playerView') {
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

    namespace.player = {
        play: play,
        stop: stop,
        toggle: toggle
    };
})(Michelly);
