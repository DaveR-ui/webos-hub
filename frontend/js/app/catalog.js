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

        ui().showView('itemView');
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

    function playlistStart(items, index, userId) {
        if (listActive) {
            playlistEnd();
        }

        listItems = items || [];
        listIndex = (typeof index === 'number' && index >= 0) ? index : 0;
        listUserId = userId;
        listActive = true;

        // Exactly one back entry for the whole session: Back stops playback and returns to
        // #itemView. Auto-advance and next/previous never push or pop a handler.
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
                // Music libraries get the folder-grouped card-grid render mode.
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

        setBackHandler(function () {
            openViews(userId);
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

        info.appendChild(actions);

        var itemError = ui().el('p', 'error-slot', '\u00a0');
        itemError.id = 'itemError';
        itemError.style.display = 'none';
        info.appendChild(itemError);

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

    namespace.catalog = {
        openViews: openViews,
        openItems: openItems,
        openItem: openItem,
        openEpisodes: openEpisodes,
        openResume: openResume
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
})(Michelly);
