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

    function openViews(userId) {
        var browse = document.querySelector('#browseView');

        setBackHandler(function () {
            ui().showView('pickerView');
        });

        ui().showView('browseView');
        ui().showLoading(browse);

        api().getViews(userId, function (data) {
            var items = (data && data.Items) ? data.Items : [];

            ui().clear(browse);

            var header = ui().el('div', 'browse-header');
            header.appendChild(ui().el('h1', 'browse-title', 'Libraries'));

            var resume = ui().el('button', 'resume-btn', 'Continue Watching');
            resume.type = 'button';
            resume.onclick = function () {
                openResume(userId);
            };
            header.appendChild(resume);
            browse.appendChild(header);

            var list = ui().el('div', 'card-list');
            browse.appendChild(list);

            renderCardList(list, items, function (view) {
                openItems(view.Id, userId, { title: view.Name, ParentId: view.Id });
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
            });
        }, 'This folder is empty.');

        focusFirstCard(container);
    }

    function openItems(parentId, userId, opts) {
        opts = opts || {};

        var startIndex = opts.StartIndex || 0;
        var limit = opts.Limit || DEFAULT_LIMIT;
        var browse = document.querySelector('#browseView');

        setBackHandler(function () {
            openViews(userId);
        });

        ui().showView('browseView');
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

    function renderItem(container, item, userId, back) {
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
            if (item.Type === 'Audio') {
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

        info.appendChild(actions);

        var itemError = ui().el('p', 'error-slot', '\u00a0');
        itemError.id = 'itemError';
        itemError.style.display = 'none';
        info.appendChild(itemError);

        wrapper.appendChild(info);
        container.appendChild(wrapper);

        focusFirstCard(container);
    }

    function openItem(itemId, userId, back) {
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
            renderItem(itemView, item || {}, userId, back);
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
                });
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
                });
            }, 'Nothing to continue watching.');

            focusFirstCard(browse);
        }, function (err) {
            ui().showError(browse, err);
        });
    }

    namespace.catalog = {
        openViews: openViews,
        openItems: openItems,
        openItem: openItem,
        openEpisodes: openEpisodes,
        openResume: openResume
    };
})(Michelly);
