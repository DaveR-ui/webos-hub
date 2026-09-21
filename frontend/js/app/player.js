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

    function play(item, userId) {
        currentItem = item;
        currentMediaSourceId = null;

        activeToken++;
        var token = activeToken;

        ui().pushBackHandler(function () {
            stop();
            ui().showView('itemView');
        });

        ui().showView('playerView');
        ui().setError('', '#itemError');

        api().getPlaybackInfo(item.Id, userId, function (data) {
            if (token !== activeToken) {
                return;
            }

            var source = pickMediaSource(data);
            var v = video();

            if (!source || !v) {
                finish();
                return;
            }

            currentMediaSourceId = source.Id;

            v.src = api().streamUrl(item.Id, source.Id, source.Container || item.Container || '');

            v.onended = function () {
                finish();
            };

            v.onerror = function () {
                finish();
                ui().setError('This item cannot be played by the TV.', '#itemError');
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

    // OK/Enter and Space toggle play/pause while the player view is active.
    document.addEventListener('keydown', function (evt) {
        evt = evt || window.event;

        var view = document.querySelector('.view.active');

        if (!view || view.id !== 'playerView') {
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
