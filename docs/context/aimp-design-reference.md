---
last_updated: 2026-09-23
status: active
description: Design-reference mining AIMP6 (native Linux player) for transferable IA and state models — library, playlist/queue and shell patterns — mapped against MiChelly's surfaces with feasibility verdicts. Tier 1 (modes, queue, item-actions menu) implemented and committed; Tiers 2–3 (browse dimensions/search, dynamic playlists) implemented but uncommitted, pending on-device verification.
tags: [design-reference, aimp, idea-mining, library, playlist, queue, ux, d-pad, feasibility]
version: 1.1
related: [architecture, webos-3-compatibility, hbc-distribution-plan]
---

# AIMP Design Reference

> **Status: reference / analysis; Tiers 1–3 implemented.** Tier 1 (playback modes, queue,
> generalized item-actions menu) is implemented and **committed on `master`** (HEAD `0e86bd7`).
> Tiers 2–3 (library dimension browse + functional search; dynamic named playlists) are implemented
> but **uncommitted** in the working tree. The whole set was validated **statically only** —
> `npm run check` green, reviewer approval and tester gates — and is **pending on-device
> verification**: do not read "implemented" as "proven on the TV". This page captures two completed
> exploration passes over AIMP6 and records which ideas are transferable to MiChelly and which are
> not. Treat any remaining "feasible" verdict as a candidate for discussion, not a spec or a work
> order.

## Problem

MiChelly's music surface is deliberately thin (artist-centric browse, dynamic named playlists, a
strictly in-order audio session). AIMP6 is a mature desktop player with a deep, well-factored
information architecture. Mining it for **ideas** — field models, browse structure, queue/playlist
state, playback-mode enums — can sharpen MiChelly without inventing patterns from scratch. The risk
is importing a mouse-first desktop's gestures and multi-window shell into a D-pad TV client, so the
value here is a disciplined, constraint-filtered inventory of what transfers and what does not.

## Ground rules

### Provenance

| Item | Value |
| --- | --- |
| Source inspected | `/home/admin/Downloads/aimp_6.00.3085~beta6-1_amd64.deb` — AIMP6 Linux public beta |
| What it actually is | **Native x86-64 ELF / GTK3** — verified no Wine in the payload (evidence: `/opt/aimp/AIMP` ELF; `history.txt` "native Linux x86-64 support") |
| Extraction | Read-only, to `/tmp/opencode/aimp-inspect` |
| Key evidence | `opt/aimp/Langs/english.lng` (1,767 strings, 104 sections), `opt/aimp/Help/AIMP-en.chm/*.html`, `opt/aimp/System/*.xml`, `opt/aimp/Plugins/` |

AIMP is **proprietary freeware**: we clone **ideas only** — no code and no asset is copied into
MiChelly.

### AIMP is mouse-first — transfer state, never gestures

AIMP leans on drag-drop, mouse wheel and middle-click. The transferable layer is its **information
architecture and state models**, not its input. Every candidate idea must clear MiChelly's hard
constraints before it is considered:

- **ES5 / Chromium 38** — no framework, no build step (see [webos-3-compatibility](webos-3-compatibility.md)).
- **Flexbox-only CSS** — no grid, no `gap`, no custom properties.
- **Payload-only changes preferred** — the 9 payload files go live without an IPK; **no new files**,
  and no `index.html` / `main.css` edits without shipping a new IPK (see
  [architecture](architecture.md#thin-loader--remote-bundle) and
  [hbc-distribution-plan](hbc-distribution-plan.md#remote-app-bundle-app)).
- **Visible-tabbable D-pad, Left/Right dead** — focus moves only Up/Down through visible tabbables;
  `frontend/js/index.js:88-94` are no-op handlers. Any idea that needs horizontal navigation or a
  hover/pointer affordance is suspect.

## AIMP patterns observed (verified in package)

### Library

1. **Single shared field dictionary** — one ~37-field record (AIMPML section: Artist / Album /
   AlbumArtist / Genre / Composer / Year / TrackNumber / DiskNumber / Bitrate / Duration / Rating /
   PlaybackCount / LastPlayback / BPM …) reused across library, playlist columns, tag editor,
   converter and export templates.
2. **Two-pane browse** — grouping tree + A–Z index strip + table with per-column filter glyphs,
   multi-column sort, and 4 view modes (Table, Table+thumbnails, Album Thumbnails, Group Details).
3. **Labels** — user tags, many-to-many, orthogonal to file tags.
4. **Playback accounting** — a play counts only after ≥4 min; feeds auto-rating and Top-N favorite
   reports (artists / albums / genres / tracks).
5. **"Additional Information" ordered-source resolution** — album art / lyrics resolve tags → folder
   → online providers, with an explicit cache (size + expiry).
6. **Smart playlists** — a 3-stage pipeline Filter (12 operators, AND/OR/NOT groups) → Sort → Limit
   output; sources = library / watched folders / another playlist.
7. **Type-ahead incremental search** + a dedicated advanced-search dialog whose results show which
   playlist each hit belongs to.
8. **Pluggable data sources** — local, CD, podcasts (episode states New/Postponed/Listened), cloud
   storages (with local cache), radio catalogs.

### Playlists & queue

9. **Multi-playlist tab manager** — groups, lock-from-changes, per-playlist personal settings, a
   "Default" auto-playlist.
10. **Queue as a first-class cross-playlist overlay** — add to queue / to beginning / remove / clear /
    manager dialog / persisted on exit.
11. **Per-track named bookmarks** (+ auto-bookmarks).
12. **Large playlist verb set** — remove duplicates/missing/disabled/except-selected, invert
    selection, randomize (+ groups), insert after playing, send to another/new playlist, undo/redo,
    import/export (+ multiple), export settings.
13. **Playback mode as short enums** — on-end-of-playlist = next playlist | repeat playlist | stand by;
    track repeat; shuffle; A-B part repeat.
14. **Per-item enable/disable switch column** — soft exclusion instead of deletion.

### Shell / UX

15. **Every panel is a float / dock / auto-hide / pin / scale object.**
16. **Skins as data archives** — the flagship "Transformer" skin ships 3 density layouts
    (modern/standard/classic) + a first-run layout chooser + Night Mode; layout, palette and
    feature-capability are kept separate.
17. **Macro/template display engine** — `%Artist %Album %Title %Rating %PlayCount …` with
    conditionals, driving playlist rows, OSD lines, filenames and sort/group keys.
18. **Compact 8-verb context menu** — Open with / Play / Add to playlist / Add to queue / Add to
    bookmarks / Edit tags / Convert / New playlist.
19. **Commands in 25 semantic hotkey groups** with Local/Global slots.
20. **Info-bar OSD** as a line or a card.
21. **Tool family** (player + converter + tag editor) sharing one field vocabulary.

## Mapping to MiChelly surfaces

Anchors are `file:line`. `catalog.js` / `api.js` / `audio.js` live under `frontend/js/app/`;
`index.js` under `frontend/js/`; `app.css` under `frontend/css/`. Line numbers reflect the code at
inspection time — re-verify before any implementation. Rows marked **Tier 1 — shipped**, **Tier 2 —
implemented (uncommitted)** or **Tier 3 — implemented (uncommitted)** keep their pre-implementation
surface columns where useful; the shipped behaviour is canonical in
[architecture](architecture.md#ordered-list-playback-michellyplaylist) and
[architecture → Saved playlists](architecture.md#saved-playlists-michellyplaylists).

| AIMP # | Idea | MiChelly surface (verified anchor) | Verdict |
| --- | --- | --- | --- |
| (1)(2) | Field dictionary + browse richness | `#musicView`: `MUSIC_CHIPS` All / A-F / G-M / N-T / U-Z / **Genres / Albums / Songs** / Folders (`catalog.js:2967`, chips render ~`3278`, dimensions fetched lazily ~`3544-3640`). Genres are derived **client-side** from the union of audio items' `Genres` — no server-side genre param (`api.getItems` has none). Jellyfin `/Items` accepts `IncludeItemTypes` / `SortBy` / `ArtistIds` / `SearchTerm` / `Filters`. | **Tier 2 — implemented (uncommitted)** — dimension chips reuse the `.music-grid` card pattern, D-pad-safe as wrapped buttons; pending on-device verification. |
| (4) | Playback accounting / stats | Shelves on `#musicView`: **Jump back in** uses `/Items/Resume` (max 8), **Recently added** `SortBy=DateCreated`, **Most played** `SortBy=PlayCount` + `Filters=IsPlayed` (all max 8; each hidden when empty, a failure hides only its band) (`catalog.js:4064-4176`). | **Tier 2 — implemented (uncommitted)** — pending on-device verification. |
| (5) | Art / lyrics source-chain + cache | Art comes only from `/Items/{id}/Images` (`api.js:264`); the provider-chain + cache is largely server-side (Jellyfin already does it). | **N/A** — mostly not needed in-app; log as server-side. |
| (6)(7) | Smart playlists / advanced search | The search topbar is now a **real** inline `<input>` + Search button (`catalog.js:3126-3155`); a term goes to `/Items` as `SearchTerm` and the results replace the content area until cleared (`catalog.js:3911-4033`). | **Tier 2 — search implemented (uncommitted)** — pending on-device verification. The rule-builder for smart playlists is a big lift, **not near-term**. |
| (9) | Multi-playlist manager | `michelly_playlists_v2` maps server id → `{playlists:[{id, name, items}]}` (`catalog.js:779-786`); create / rename / delete / reorder / soft-disable (`catalog.js:1191-1285`) in the `#playlistsView` manage view. The legacy `michelly_playlists` 3-slot store is **read-only** and lazily migrated losslessly (`pl-legacy-N`, `catalog.js:1009-1055`); audio-only, per-server keyed by Jellyfin `System/Info` Id. | **Tier 3 — implemented (uncommitted)** — dynamic named playlists with a lossless lazy migration and **reorder (no longer deferred)**; pending on-device verification. Groups / lock / personal-settings = **not near-term**. |
| (10) | Queue as overlay | `Michelly.playlist` session is strictly in-order — no wrap / repeat / shuffle / queue (`catalog.js:116-124`, `227-242`); `audio.js` has no queue view. | **Tier 1 — shipped** — in-memory session + pending queue with queue-first advance, plus the audio-card queue overlay. |
| (13) | Playback-mode enums | `#audioView` now-playing card (`audio.js:297-412`) has only Prev / Toggle / Next + text time; no shuffle / repeat / seek. | **Tier 1 — shipped** — repeat off/all/one and shuffle on/off buttons on the now-playing card, on the existing focus / dim (`.is-inert`) discipline. A-B repeat, crossfade = TV-marginal, **skipped**. |
| (12) | Playlist verbs | Dedupe-on-add exists (`addItemToPlaylist` `Id` guard, `catalog.js:1144-1167`). | **Tier 3 (partial) — implemented (uncommitted)** — per-item enable/disable switches (`setItemDisabled`, skipped by Play) and Move up/down reorder shipped; remove-missing = **later**. Pending on-device verification. |
| (11) | Per-track bookmarks | — | **Not cloned** — low value for TV audio. |
| (18) | Action sheet | `openPlaylistPicker` two-step inline picker already implements this shape (`catalog.js:525-564`, `749-773`). | **Tier 1 — shipped** — generalized into the per-item two-step actions menu (Play next / Add to queue / Add to playlist / Open album / Cancel) with one back handler. |
| (17) | Macro / template engine | — | **Static idea only** — not worth a template language; adopt consistent "second line" row formatting (artist · album · year). |
| (15)(16) | Panel docking + skin archives | Fullscreen single-active-view shell (`app.css:12-24`); no runtime theme switching, fixed-literal palette. | **Not feasible** — except density layouts (compact list vs big cards) as the transferable subset. |
| (19) | Hotkey command groups | Conceptual match with the D-pad registry in `index.js`. | **Note only** — no work. |

## Recommended tiers

**Tiers 1–3 implemented.** Tier 1 is **committed on `master`** (HEAD `0e86bd7`); Tiers 2–3 are
**implemented but uncommitted** in the working tree. The whole set was validated **statically only**
(`npm run check`, reviewer approval, tester gates) and is **pending on-device verification** — do not
read it as proven on the TV.

- **Tier 1 (small, high value) — implemented & committed** — repeat / shuffle enums in now-playing; a
  "Play next" queue; generalize the item-action picker.
- **Tier 2 — implemented (uncommitted)** — library dimension browse (Genres / Albums / Songs +
  Recently-added / Most-played shelves); functional search in the topbar. **Deltas from the original
  plan:** search is now a **real** inline `<input>` + Search button (was "planned, increment-2"); the
  **Genres** dimension is derived **client-side** from the union of audio items' `Genres` arrays
  (Jellyfin `/Items` has no genre query param, and `api.js` was off-limits). **Known follow-up:** the
  dimension fetch window is bounded (~500 items) with **no `Show more` pager yet**.
- **Tier 3 — implemented (uncommitted)** — dynamic renameable playlists with a **lossless, lazy,
  additive** migration of the legacy 3-slot records (the legacy key is left read-only) and a reorder
  UI; per-item soft-disable switches. **Delta:** reorder is **no longer deferred** — the playlist
  detail now ships Move up / Move down. **Known follow-up (pending human confirmation):** a server
  with no legacy record now shows an empty playlist list with a **New playlist** button instead of
  three empty `Playlist 1/2/3` slots.
- **Also landed — not an AIMP tier** — the audio now-playing card is now **two-column** (dominant
  album art + an info/controls column) with a **display-only** `.audio-progress` bar mirroring the
  video player's `.player-progress`. Interactive scrubbing stays out of scope because Left/Right are
  intentional D-pad no-ops.
- **Explicitly not cloned** — skins / engine, bookmarks, A-B repeat, drag-drop gestures,
  multi-window docking, tag editing.

## When to use

- Scoping a future music-surface enhancement and asking "has AIMP already solved this IA well?"
- Sanity-checking a proposed feature against the payload-only / D-pad / flexbox constraints.

## When not to use

- As a build spec or task list — the tiers are candidates, not commitments.
- When copying: AIMP is proprietary; only ideas transfer, never code, assets, or gestures.

## Examples

The constraint filter, applied to AIMP (2) "two-pane browse with A–Z index strip + table":

```
Source gesture: horizontal split + column-header sort clicks + wheel scroll.
D-pad check:    Left/Right dead (index.js:88-94) -> no horizontal split; column sort by focus is awkward.
Payload check:  table + index strip is many new nodes/panes -> risks index.html / main.css (needs IPK).
Verdict:        do NOT clone the pane layout; clone the IDEA as dimension chips + wrapped grid cards
                (the (1)(2) row above), which stays payload-only and D-pad-safe.
```

A row-formatting idea, statically (from AIMP (17), no template engine):

```
second line = artist + ' · ' + album + ' · ' + year   // plain ES5 concat, reused across rows
```

## Common mistakes

### Cloning gestures, not state

Drag-drop, wheel and middle-click are how AIMP exposes otherwise-sound state models. Re-express the
state as visible-tabbable, Up/Down-navigable controls or the idea will not survive on the TV.

### Treating a tier as a work order

Every "Feasible" above was contingent on human approval and on the payload-only / new-file rules, and
all three tiers are now implemented. The dynamic-playlist item in particular was a **data-shape change
requiring migration** of existing 3-slot records — not a UI-only tweak; the migration is additive and
lossless (the legacy key is never written or deleted). Remember that implemented ≠ verified: the
Tier 2–3 work is **uncommitted and pending on-device verification**.

### Copying AIMP code or assets

AIMP is proprietary freeware. The value here is the inventory of ideas; the implementation must be
original ES5/CSS.

### Assuming a field dictionary exists

MiChelly has no server-side genre query field. The **Genres** dimension is derived **client-side** by
unioning the `Genres` arrays of the fetched audio items; the **Albums** / **Songs** dimensions reuse
`MusicAlbum` / `Audio` `IncludeItemTypes`. Browse-dimension ideas that assume a richer server query
are net-new client work, even where Jellyfin `/Items` can supply the fields.

## References

- [Architecture](architecture.md) — the current music browse, dynamic playlists, audio session and thin-loader constraints.
- [WebOS 3 compatibility](webos-3-compatibility.md) — the ES5 / Chromium 38 / flexbox-only floor.
- [HBC distribution plan](hbc-distribution-plan.md#remote-app-bundle-app) — why payload-only beats shell edits.
- [Project entry point](../project.md) — slices, commands and conventions.
- [Context index](context-index.md) — folder hub.
