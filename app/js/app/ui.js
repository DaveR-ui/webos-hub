/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 */

var Michelly = window.Michelly = window.Michelly || {};

(function (namespace) {
    'use strict';

    var backStack = [];

    function el(tag, className, text) {
        var node = document.createElement(tag);

        if (className) {
            node.className = className;
        }

        if (text !== undefined && text !== null) {
            node.textContent = String(text);
        }

        return node;
    }

    function clear(node) {
        if (!node) {
            return;
        }

        while (node.firstChild) {
            node.removeChild(node.firstChild);
        }
    }

    // Toggles the active-view styling and re-seeds focus via the picker's navigationInit().
    function showView(id) {
        var views = document.querySelectorAll('.view');

        for (var i = 0; i < views.length; i++) {
            if (views[i].id === id) {
                views[i].className = 'view active';
            } else {
                views[i].className = 'view';
            }
        }

        if (typeof navigationInit === 'function') {
            navigationInit();
        }
    }

    function setBusy(msg) {
        var busy = document.querySelector('#busy');

        if (!busy) {
            return;
        }

        var heading = busy.querySelector('h1');

        if (msg) {
            if (heading) {
                heading.textContent = msg;
            }
            busy.style.display = '';
        } else {
            busy.style.display = 'none';
        }
    }

    // Empty msg hides the error slot; targetId defaults to the picker's #error.
    function setError(msg, targetId) {
        var target = document.querySelector(targetId || '#error');

        if (!target) {
            return;
        }

        if (msg) {
            target.style.display = '';
            target.textContent = msg;
        } else {
            target.style.display = 'none';
            target.textContent = '';
        }
    }

    function describeError(err) {
        if (!err) {
            return 'Something went wrong.';
        }
        if (err.error === 'timeout' || err.kind === 'timeout') {
            return 'The request timed out.';
        }
        if (err.kind === 'unauthorized' || err.error === 401) {
            return 'Your session has expired. Please sign in again.';
        }
        if (err.kind === 'network' || err.error === 0) {
            return 'Could not reach the server.';
        }
        if (typeof err.error === 'number' && err.error > 0) {
            return 'The server returned HTTP error ' + err.error + '.';
        }
        if (typeof err.error === 'string') {
            return err.error;
        }
        return 'Something went wrong.';
    }

    function showLoading(container) {
        if (!container) {
            return;
        }

        clear(container);
        container.appendChild(el('div', 'state loading', 'Loading...'));
    }

    function showEmpty(container, msg) {
        if (!container) {
            return;
        }

        clear(container);
        container.appendChild(el('div', 'state empty', msg || 'Nothing here yet.'));
    }

    function showError(container, err, msg) {
        if (!container) {
            return;
        }

        clear(container);

        var state = el('div', 'state error', msg || describeError(err));
        var back = el('button', 'state-back', 'Back');
        back.type = 'button';
        back.onclick = function () {
            handleBack();
        };
        state.appendChild(back);
        container.appendChild(state);
    }

    // Sets img.src and swaps to a text fallback when the image is missing or fails to load.
    function renderImage(imgEl, url, fallbackText) {
        if (!imgEl) {
            return;
        }

        var parent = imgEl.parentNode;

        imgEl.onerror = function () {
            imgEl.style.display = 'none';

            if (!parent) {
                return;
            }

            var fallback = parent.querySelector('.img-fallback');

            if (!fallback) {
                fallback = el('div', 'img-fallback', fallbackText || '');
                parent.appendChild(fallback);
            }

            fallback.style.display = '';
        };

        imgEl.onload = function () {
            imgEl.style.display = '';

            if (parent) {
                var fallback = parent.querySelector('.img-fallback');
                if (fallback) {
                    fallback.style.display = 'none';
                }
            }
        };

        if (url) {
            imgEl.src = url;
        } else {
            imgEl.onerror();
        }
    }

    /* Back-handler stack. index.js pops one entry per Back press. */

    function pushBackHandler(fn) {
        if (typeof fn === 'function') {
            backStack.push(fn);
        }
    }

    function popBackHandler() {
        return backStack.length ? backStack.pop() : null;
    }

    function clearBackHandlers() {
        backStack = [];
    }

    function hasBackHandler() {
        return backStack.length > 0;
    }

    function handleBack() {
        if (!backStack.length) {
            return false;
        }

        var fn = backStack.pop();

        try {
            fn();
        } catch (err) {
            console.warn(err);
        }

        return true;
    }

    namespace.ui = {
        el: el,
        clear: clear,
        showView: showView,
        setBusy: setBusy,
        setError: setError,
        describeError: describeError,
        showLoading: showLoading,
        showEmpty: showEmpty,
        showError: showError,
        renderImage: renderImage,
        pushBackHandler: pushBackHandler,
        popBackHandler: popBackHandler,
        clearBackHandlers: clearBackHandlers,
        hasBackHandler: hasBackHandler,
        handleBack: handleBack
    };
})(Michelly);
