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
        reportStopped(ticks);
        currentMediaSourceId = null;
    }

    // Playback finished on its own (or failed): remove the audio back entry too.
    function finish() {
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

        view.appendChild(card);

        updateToggleLabel();
        updateTime();

        if (typeof navigationInit === 'function') {
            navigationInit();
        }
        focusToggle();
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

        ui().pushBackHandler(function () {
            stop();
            ui().showView('itemView');
        });

        ui().showView('audioView');
        ui().setError('', '#itemError');
        bindAudioEvents();
        renderNowPlaying(item);

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
