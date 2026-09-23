---
last_updated: 2026-09-23
status: active
description: Architecture of the MiChelly webOS media client — the app shell and views, the ES5 thin loader and remote bundle, the ES5 REST client and authorization, per-server auth/session, catalog browsing (including the artist-centric music browse), native playback (ordered-list sessions with playback modes and an in-memory queue, and user-built saved playlists), and the bundled Luna discovery service.
tags: [architecture, webview, views, thin-loader, remote-bundle, sha256, media-server-rest-api, es5, auth, session, playback, playlist, playlists, music, artist, luna, discovery, d-pad, media-server]
version: 2.7
related: [webos-3-compatibility, upstream-provenance, hbc-distribution-plan]
---

# Architecture

## Problem

A webOS web app must render the media UI and play its media itself. A server-served web client is
**not** shipped with this app, and a webview cannot open raw sockets for UDP discovery. The client
therefore has to talk to the **media-server REST API directly**, draw its own views, play media in the
TV's own `<video>` element, and still let the user find and pick a server on the local network.

## Solution

### App shell and views

`frontend/index.html` is a single-page app made of sibling `<div class="view">` panes; exactly one
carries the `active` class at a time. It loads plain scripts in a fixed order — no framework, no build
step, no bundler. Since the [thin loader](#thin-loader--remote-bundle) below, the shell statically
loads only the vendored platform JS, `js/ajax.js`, `js/storage.js`, `js/lib/sha256.js` and
`js/loader.js`; the app modules (`js/app/*.js`, `js/index.js`) and `css/app.css` are injected by the
loader — the verified remote payload when reachable, the packaged copies otherwise:

| File | Role |
| --- | --- |
| `frontend/index.html` | App shell: six view panes — `#pickerView` (logo, `#octet3`/`#octet4`/`#port`, `#auto_connect`, `#serverlist`, `#busy`), `#loginView`, `#browseView`, `#itemView`, `#playerView` (`<video id="playerVideo">`), `#audioView` (`<audio id="playerAudio">`). |
| `frontend/webOSTVjs-1.2.11/webOSTV.js` | webOS platform JS (device info, app info, Luna bus, `platformBack`). |
| `frontend/webOSTVjs-1.2.11/webOSTV-dev.js` | Developer-mode companion bundle. |
| `frontend/js/ajax.js` | `XMLHttpRequest` wrapper (JSON parse, 5 s timeouts, abort/timeout/error callbacks). |
| `frontend/js/storage.js` | `localStorage` JSON wrapper. |
| `frontend/js/lib/sha256.js` | Dependency-free, synchronous pure-JS SHA-256 (`sha256Hex(ArrayBuffer/Uint8Array/string)`); verifies the remote bundle on the TV. **Fork-only.** |
| `frontend/js/loader.js` | ES5 thin loader: fetches and validates the remote manifest, verifies and activates the payload, falls back to the packaged copies and guards the boot; exposes `window.MichellyShell`. **Fork-only.** |
| `frontend/js/app/platform.js` | Device/app identity, device profile, screen size and exit; owns `_deviceId2` and the `Authorization` header parts. **Fork-only.** Remote payload. |
| `frontend/js/app/api.js` | ES5 XHR media-server REST client: builds the `MediaBrowser` authorization header, exposes the endpoints, the image/stream URLs and the unauthorized hook. **Fork-only.** Remote payload. |
| `frontend/js/app/auth.js` | Per-server session store keyed by server id in `michelly_sessions`; the tri-state default user (`michelly_default_user`) for automatic sign-in; login via `/Users/AuthenticateByName`; a 401 clears the session. **Fork-only.** Remote payload. |
| `frontend/js/app/ui.js` | View switcher, back-handler stack and the loading/empty/error state renderers. **Fork-only.** Remote payload. |
| `frontend/js/app/catalog.js` | Views → items → item detail → episodes, Resume and paging; every card is a `<button>`; owns the ordered list session (`Michelly.playlist`), the saved-playlist store (`michelly_playlists`) and its manage view (`Michelly.playlists`). **Fork-only.** Remote payload. |
| `frontend/js/app/player.js` | PlaybackInfo → direct-stream `<video>` plus an always-visible D-pad-operable control overlay (Prev / Play/Pause / Next buttons, time readout, progress bar), play/pause, list-aware auto-advance, codec-aware error reporting, best-effort session reporting. **Fork-only.** Remote payload. |
| `frontend/js/app/audio.js` | Audio direct-stream `<audio>` player: now-playing card (Prev / Play/Pause / Next + session-scoped Repeat / Shuffle / Queue controls with the inline queue overlay), play/pause/stop, list-aware auto-advance, session reporting. **Fork-only.** Remote payload. |
| `frontend/js/index.js` | Server picker, auto-discovery subscription, connect flow (auto-connect from the stored `baseurl`, session-first + default-user auto-login), the runtime-built default-user settings view, main key/Back handling. Remote payload. |
| `frontend/css/main.css` | Picker and shared control styling. |
| `frontend/css/app.css` | Native view / catalog / player / audio now-playing styling (flexbox only). **Fork-only.** Remote payload. |

The `js/app/*` files each extend the shared `window.Michelly` namespace
(`var Michelly = window.Michelly = window.Michelly || {};`); `index.js` wires the picker to them.
Together with `frontend/js/index.js` and `frontend/css/app.css` these are the **remote payload**: the
loader injects them at boot (verified remote text, or the packaged copies), so they are not hard-linked
in the shell.

### Thin loader / remote bundle

The IPK ships a **stable local shell** that can update its own code and UI without a reinstall. The 8
app script tags and `js/index.js` are no longer hard-linked in `frontend/index.html`; the last two
elements before `</body>` are `js/lib/sha256.js` + `js/loader.js`, and `<body onload="Init();">` is now
a plain `<body>`. The payload files **remain on disk** under `frontend/` as the packaged fallback.

**Local shell vs remote payload**

| Layer | Contents | Changes when |
| --- | --- | --- |
| Local shell (in the IPK) | `frontend/index.html`, `webOSTVjs-1.2.11/`, `js/ajax.js`, `js/storage.js`, `js/lib/sha256.js`, `js/loader.js` | Only through an IPK reinstall (manual HBC refresh) |
| Remote payload (`app/` on `gh-pages`) | `js/app/{platform,api,auth,ui,catalog,player,audio}.js`, `js/index.js`, `css/app.css` — 9 files | Live on the TV's **next launch** |

**Remote layout** — `https://daver-ui.github.io/webos-hub/app/`:

| Path | Contents |
| --- | --- |
| `app/manifest.json` | `{schema:1, bundleVersion, appVersion, files:[{path,type,size,sha256}]}` |
| `app/js/app/*.js`, `app/js/index.js`, `app/css/app.css` | The 9 payload files, byte-for-byte copies of `frontend/` |

`bundleVersion` is **content-derived**: the first 16 hex characters of the sha256 over the
`` `${path}:${sha256}\n` `` lines of every file in canonical order. Editing any payload file changes the
digest, which doubles as the `?v=` cache-buster. `tools/gen-bundle.js` (`npm run bundle`) writes the
tree deterministically and idempotently, with a `--check` mode. The manifest is fetched as
`manifest.json?v=<Date.now()>`; each file as `<path>?v=<bundleVersion>`.

**Two-phase verify-then-activate**

1. `validateManifest` — `schema === 1`; `bundleVersion` 16 lowercase hex; 1–32 files; each a safe
   relative `*.js`/`*.css` path (no `..`, no scheme), a known `type`, a 64-hex `sha256` and a positive
   integer `size`.
2. Fetch every file as an `arraybuffer` (sequentially), then verify **size**, then **sha256**, then
   decode the bytes.
3. Only after every file verifies, activate: inject the verified text as inline classic
   `<script>.textContent` in canonical order, then one `<style id="michellyRemoteCss">`, and disable
   the packaged `#appCss` link. The payload runs **in the app's own origin**, so Luna keeps working.
4. Call `Init()`.

On **any** failure — manifest fetch/parse/validation, size/hash/decode mismatch, activation error — the
loader injects the packaged JS copies sequentially and calls `Init()`, leaving the packaged stylesheet
enabled. A best-effort `window.onerror` boot guard rolls a throwing remote boot back to the packaged
build: it sets `sessionStorage.michelly_remote_skip`, reloads once, and the fallback path consumes the
flag. `window.MichellyShell` exposes `bundleSource` (`'remote'`/`'packaged'`), `bundleVersion` and
`boot`; the active version is also stored best-effort in `localStorage.michelly_bundle_version`.

**Integrity, not authenticity.** sha256 proves the fetched bytes match the manifest; it does **not**
sign or authenticate them. The manifest itself is served over HTTPS and is neither pinned nor signed,
so **control of the GitHub Pages host is the trust boundary** — the same position as the IPK's
`ipkHash.sha256` (see
[hbc-distribution-plan](hbc-distribution-plan.md#sha256-proves-integrity-not-authenticity)).

**The IPK version stays frozen.** Only code/UI in the payload auto-updates. `frontend/appinfo.json`,
the bundled Luna service and the shell itself still change only through a new IPK installed via the
manual Homebrew Channel refresh (see [hbc-distribution-plan](hbc-distribution-plan.md)).

**Deferred:** a rooted boot-hook poller (`luna://org.webosbrew.hbchannel.service/install`) is **not
implemented** — the TV fetches the manifest only at launch, and nothing pushes a new bundle to it.

### Server picker and connect flow

`Init()` (on `<body onload>`) shows `#pickerView`, builds the default-user settings affordance/view in
JS (see [Auth and per-server sessions](#auth-and-per-server-sessions)), initialises the platform layer,
then reads `connected_servers` from `localStorage`, pre-fills the three picker fields
(`#octet3`/`#octet4`/`#port`) and the auto-connect checkbox from the most recent server, and honours the
auto-connect flag unless the page was reached via Back/Forward. The **pre-fill** only happens when the
saved host is `192.168.x.x`; otherwise the fields keep their defaults (`0`/`0`/`8096`), so a stale or
different-host entry never populates the picker — and its server-list **Connect** button shows an error
instead of connecting.

**Auto-connect is no longer gated on `192.168.x.x`.** When the flag is set, `autoConnectSavedServer(server)`
issues `GET {server.baseurl}/System/Info/Public` with the **stored `baseurl` as-is** (scheme and port
preserved) instead of composing a picker URL, so a saved server on any host — or a verified discovered
server — auto-connects. The **manual** picker path (`handleServerSelect`) is unchanged: it validates the
two octets (`0-255` each) and the port (`1-65535`) and composes
`http://192.168.<octet3>.<octet4>:<port>` (scheme fixed to `http`). If any field is invalid, no request
is issued and an error is shown.

Either path then follows:

1. `GET {baseurl}/System/Info/Public` → server identity (`Id`, `ServerName`) and record in the LRU map
   (`lruStrategy`, capped at **4** servers).
2. `afterConnect(baseurl, data)` — **session-first, then default-user auto-login**:
   - `Michelly.api.setBaseUrl(baseurl)`;
   - if `michelly_sessions[server.Id]` holds an `accessToken`, reuse it (`setToken`) and open the views
     — the saved **credential is not read**;
   - otherwise read the [default user](#auth-and-per-server-sessions) and, when auto-login is enabled,
     make **exactly one** `POST /Users/AuthenticateByName` attempt; on success the session is persisted
     and the views open;
   - on **any** error — or when auto-login is disabled — clear the session + token and fall back to
     `#loginView` with a notice (for a failed default-user attempt, naming the user).

There is **no** `/web/manifest.json` fetch and **no** `start_url`: the app no longer loads a
server-served web client, so none of the old `handoff()` machinery remains.

### Auth and per-server sessions

`frontend/js/app/auth.js` keeps one session per server in the `michelly_sessions` `localStorage` key,
keyed by the server id, storing `{userId, accessToken, userName}`. The session **never contains the
password**; a **separate** key may hold a plaintext default credential (below). Sign-in posts
`POST /Users/AuthenticateByName` with `{Username, Pw}`; on success the returned `AccessToken` and
`User.Id` are persisted. Any browsing call that returns 401/403 fires the `Michelly.api.onUnauthorized`
hook, which clears the saved session and returns to `#loginView`. `auth.logout(serverId)` exists but is
not yet exposed in the UI — see the [deferred security note](#security-debt-deferred).

**Default user (`michelly_default_user`, tri-state).** A second fork-owned key drives automatic
sign-in:

| Stored value | Meaning |
| --- | --- |
| key **absent** (or malformed) | Built-in default `{username: 'pepe', password: 'pepe'}` — auto-login **on** |
| `{username, password}` | The user's own account — auto-login on with those credentials |
| `{disabled: true}` | Auto-login **off** — the login screen is always shown |

`getDefaultUser()` returns a fresh `{username, password}` (or `null` when disabled);
`setDefaultUser(username, password)` requires a non-empty username and allows an empty password;
`disableDefaultUser()` writes `{disabled: true}`; `resetDefaultUser()` removes the key, restoring the
built-in `pepe`. The stored password is **plaintext** — deliberately, with **no** obfuscation (see
[security debt](#security-debt-deferred)).

Auto-login is consumed only by `afterConnect` in `frontend/js/index.js` (one attempt, then the login
screen on any failure). The default user is edited through a **settings view built at runtime**:
`ensureSettingsAffordance()` adds an `#openSettings` button to the picker and `ensureSettingsView()`
appends a `#settingsView` pane to `<body>` in JS, so **`index.html` — the shell — is not changed**; the
view ships inside the payload. It offers Save (set/replace), *Turn off automatic sign-in* (disable) and
*Restore built-in default (pepe)* (reset).

`frontend/js/app/api.js` identifies the client on every request with the modern header
(`X-Emby-Authorization` is the older, deprecated alias and is intentionally not used):

```
Authorization: MediaBrowser Client="MiChelly", Device="LG Smart TV", DeviceId="<id>", Version="<app version>"[, Token="<access token>"]
```

### Media-server REST endpoints

| Endpoint | Method | Used for |
| --- | --- | --- |
| `/System/Info/Public` | GET | Server identity (`Id`, `ServerName`, `ProductName`) during connect and discovery. |
| `/Users/AuthenticateByName` | POST | Sign-in; returns `AccessToken` + `User`. |
| `/Users/Public` | GET | Public user list (exposed by the API layer; the UI signs in by name). |
| `/Users/{userId}/Views` | GET | Top-level libraries. |
| `/Items` | GET | Item listing (`ParentId`, paging, sort, image aspect). |
| `/Users/{userId}/Items/{itemId}` | GET | Item detail. |
| `/Shows/{seriesId}/Episodes` | GET | Series episodes. |
| `/Users/{userId}/Items/Resume` | GET | Continue Watching. |
| `/Items/{itemId}/PlaybackInfo` | POST | Direct-play/stream decision (device profile sent in the body). |
| `/Videos/{itemId}/stream` | GET | Direct-stream video (opened by `<video>`). |
| `/Audio/{itemId}/stream` | GET | Direct-stream audio (opened by `<audio>`; `static=true`, no transcode). |
| `/Sessions/Playing`, `/Sessions/Playing/Progress`, `/Sessions/Playing/Stopped` | POST | Best-effort playback reporting (errors swallowed). |
| `/Items/{itemId}/Images/{type}` | GET | Posters and thumbnails. |

A `<video>`, `<audio>` or image element **cannot** send an `Authorization` header, so the token travels
in the query string as both `ApiKey` (current) and `api_key` (legacy alias).

Identity is decided by `GET /System/Info/Public` alone: the centralized `isJellyfinServer(data)` helper
in `frontend/js/index.js` accepts a server only when `ProductName === "Jellyfin Server"`. Jellyfin also
exposes `GET /System/Ping` (plain text `Jellyfin Server`) and, since 10.7, `GET /health` (plain text
`Healthy`/`Unhealthy`, a database check with **no** identity) — both are **available but unused**.

### Catalog browsing

`frontend/js/app/catalog.js` drives the single `#browseView` and `#itemView`:

- `openViews(userId)` — `GET /Users/{userId}/Views` renders one card per library plus a **Continue
  Watching** and a **Playlists** button (the latter opens the saved-playlist manage view — see
  [Saved playlists](#saved-playlists-michellyplaylists)).
- `openItems(parentId, …)` — `GET /Items` with paging (`DEFAULT_LIMIT` 60) and Previous/Next buttons.
- `openItem(itemId, …)` — `GET /Users/{userId}/Items/{itemId}` renders poster, overview, **Play**, and an
  **Episodes** button when `Type === 'Series'`.
- `openEpisodes(seriesId, …)` and `openResume(userId)` cover series episodes and Continue Watching.

The list views also hand the rendered page and the tapped index to `openItem`/`renderItem`, so the
**Play** button can start an ordered list session (`Michelly.playlist`) — see
[Ordered list playback](#ordered-list-playback-michellyplaylist).

Every selectable card is a `<button class="card">` so the global D-pad selector in `index.js` can reach
it. Each navigation resets the back stack and pushes **exactly one** handler that recreates its parent,
so the stack stays bounded no matter how deep the user goes. Missing or failed images swap to a text
fallback (`Michelly.ui.renderImage`).

A library whose `CollectionType` is `music` instead opens the [artist-centric music
browse](#artist-centric-music-browse-increment-1) below; every other library keeps this folder-grouped
card-grid render mode.

#### Artist-centric music browse (increment 1)

A music library opens an artist-centric browse rather than the folder-grouped card grid. It is a **UI
layer over the existing catalog plumbing** — album rows open through the generic items view, `Folders`
through the [folder-grouped browse](#catalog-browsing), playback through [ordered list
playback](#ordered-list-playback-michellyplaylist), and failures through the generic `#itemError` slot.
**No new endpoint, no new `localStorage` key and no new payload file.**

**Namespace and routing.** The feature lives in `frontend/js/app/catalog.js` as `Michelly.music`
(`openHome(libraryId, userId, libraryName)`, `openArtist(artist, userId)`, `getConfig()`,
`setConfig(partial)`). It is **not** a new payload file: the [thin loader](#thin-loader--remote-bundle)
validates an exact ordered **9-file** payload list, so a new file would force an IPK reinstall — keeping
it in `catalog.js` ships the whole change in the payload (`npm run bundle` + publish, **no IPK**). In
`openViews`, a library with `CollectionType === 'music'` calls `music.openHome(...)`; every other
library keeps the folder-grouped card grid above.

**Music home (`#musicView`, runtime-built).** Built in JS on the `ensurePlaylistsView` pattern (the
shell `index.html` is untouched), it is a static, non-tabbable left rail plus a top bar (**Back** +
library title + a static, visual-only search field), six filter chips (`All`, `A-F`, `G-M`, `N-T`,
`U-Z`, `Folders`), a **Jump back in** shelf and a wrapped artist card grid.

- The **shelf** reuses the existing Resume endpoint (`Michelly.api.getResume`), keeps the playable
  music entries (`Audio`/`MusicAlbum`, max 8) and is hidden entirely when empty or on failure.
- The **`Folders` chip is navigation, not a filter**: it opens the **existing** folder-grouped browse
  unchanged, with Back returning to the music home.
- The letter chips filter the loaded page client-side by `SortName`/`Name` first letter; **Show more**
  pages the artist list (100 per page) when the server reports more, reusing the artists-fetch variant
  that actually returned rows (see the data model below).

**Artist detail (`#artistView`, runtime-built).** Three sections, in this order: **Albums**, **Singles
and EPs**, **Favorites**. An album row opens the album through the generic items view (so its tracks
play as an ordered list session) and carries its own **Play**.

**Data model.**

| Step | Query |
| --- | --- |
| Artists (folder-faithful) | `GET /Items?ParentId={library}&Recursive=false&IncludeItemTypes=Folder,MusicArtist&SortBy=SortName` — one page of 100 |
| Artists (fallback) | A one-shot retry against `MusicArtist` entities (`Recursive=true`) when the folder-faithful query returns nothing; the home **remembers which variant succeeded** and reuses it for **Show more**, so paging does not silently return nothing on a library that only exposes `MusicArtist` entities |
| Artist items | One recursive `ParentId={artistId}` fetch (with `UserId={userId}`) fed through the existing `buildGroupedModel` — **each returned section is one album, its `media` array is the authoritative track list** |
| Artist items (fallback) | A one-shot `AlbumArtistIds={artistId}` query (with `UserId={userId}`) when the recursive folder-faithful query returns nothing (a virtual `MusicArtist` entity exposes no `ParentId` children); a second empty result is accepted as the honest empty state |
| Favorites | `GET /Items?ParentId={artistId}&UserId={userId}&Recursive=true&Filters=IsFavorite&IncludeItemTypes=MusicAlbum,Audio` |

The three user-scoped queries above (the artist-items fetch, its `AlbumArtistIds` fallback and the
favorites query) send `UserId` explicitly alongside `Filters=IsFavorite`, so the favorite state is
unambiguously evaluated against the signed-in user.

**Singles/EPs taxonomy (documented, overridable heuristic).** Jellyfin exposes no album-type field and
the on-disk folder naming is heterogeneous, so **no folder-name parsing** is used beyond explicit
markers. `musicClassify(name, trackCount, totalMs)`:

| Condition | Result |
| --- | --- |
| name matches `\bsingle\b` | single |
| name matches `\bep\b` | EP |
| 1 track | single |
| 2–6 tracks and summed run time < 30 min | EP |
| 2–6 tracks and summed run time ≥ 30 min | album |
| > 6 tracks | album |
| unknown track count | album (so nothing is hidden) |

The name marker wins over the duration heuristic; the thresholds live in **one place** and are
overridable at runtime through `Michelly.music.setConfig({epMaxTracks, albumMinMs})` (`getConfig()`
returns a copy).

**Favorites are Jellyfin user favorites** (`Filters=IsFavorite`), **not** an app-local store — **no new
`localStorage` key**. `Filters=IsFavorite` returns only the favorited nodes, so the section is built
from the response itself:

- **Favorited albums are always listed**, including an album whose tracks are not themselves favorited.
  Such an album has no favorited media to file under it, so it produces no grouped section and is
  emitted as its own row with **no in-place Play button** — its row button opens the album, where Play
  works.
- **Favorited tracks whose parent album was not itself returned** are listed as **single-track rows**:
  the row button opens the track's own item view, and **Play** starts a one-track session.

**`api.getItems` pass-through.** `frontend/js/app/api.js` `getItems` gained optional query pass-through
params — `UserId`, `Filters`, `IsFavorite`, `SearchTerm`, `ArtistIds`, `AlbumArtistIds`,
`ExcludeItemTypes` — with the `Fields` default unchanged.

**Reuse.** `Michelly.audio`, `Michelly.playlist` and `Michelly.playlists` are untouched and remain the
playback/store path.

**D-pad.** Every interactive element is a real `<button>` and nothing uses the `disabled` attribute (the
same rule as Prev/Next — `.focus()` on a disabled button fails). The rail is
static and non-tabbable; the shelf is a **wrapped card row, not a horizontal scroller**, because
Left/Right are [no-ops](#assuming-leftright-moves-focus). Focus is seeded into the content grid after
each render.

**Increment 2 (planned, not implemented).** A bottom now-playing bar, an app-global persistent rail, a
right contextual panel, a hero gradient band, "Recommended Stations", functional server search and
genre chips are **not** part of this change.

### Native playback

`frontend/js/app/player.js`:

1. `POST /Items/{id}/PlaybackInfo` with a direct-play device profile (`TranscodingProfiles: []`) —
   **transcoding is a non-goal**.
2. Picks the first media source that `SupportsDirectStream`/`SupportsDirectPlay` (falling back to the
   first source) and sets `#playerVideo.src = api.streamUrl(itemId, source.Id, container)`.
3. Builds an **always-visible, D-pad-operable control overlay** inside `#playerView` (a sibling right
   after `#playerVideo`, so the video keeps its `width/height: 100%` box). `ensureControls()` is
   **idempotent** — it creates the overlay once and reuses it on replay. The overlay is a real
   `<button id="playerToggle">` (label `Play`/`Pause`), a `#playerTime` readout (`m:ss / m:ss`), a
   `#playerProgressFill` bar (percentage width, guarded against `NaN`/`0`/`Infinity` durations) and an
   `OK: Play / Pause    Back: Exit` hint. It is **never** hidden with `display:none`: `navigate()` /
   `navigationInit()` in `frontend/js/index.js` only walk elements with
   `offsetWidth > 0 && offsetHeight > 0`, so a hidden overlay would remove the button from D-pad
   navigation. There is **no auto-hide** in this iteration.
4. Entering `#playerView` builds the overlay **before** `ui().showView('playerView')` (so `showView`'s
   own `navigationInit()` finds it), then seeds focus on `#playerToggle` and calls `navigationInit()`.
   On a replay `ensureControls()` early-returns, so `play()` resets the overlay (`updateToggleLabel()`,
   `updateTime()`, `updateProgress()`) rather than showing the previous item's readout/bar until the new
   `loadedmetadata` arrives. `play`/`pause`/`timeupdate`/`loadedmetadata` on `#playerVideo` (bound
   once) update the label, the readout and the bar.
5. `#playerToggle` carries its **own** DOM0 `onkeydown`: Enter (13) / Space (32) call `toggle()`
   explicitly, then `preventDefault()` + `return false` suppress the platform's synthetic click. This is
   deliberate — focus is left on the button, and the handler must not depend on Chromium synthesizing a
   click from the remote's OK. `onclick` still calls `toggle()` for pointer use. The document-level
   handler early-returns when a `<button>` inside `#playerView` is focused (`isButtonFocused`), so the
   two paths cannot both fire; the button's keydown path always toggles, so they cannot both no-op.
   Back stops playback and returns to item detail.
6. Best-effort `POST /Sessions/Playing*` reporting starts on play, repeats every 15 s and stops on
   stop/end. These pings run with `suppressAuth`, so a transient failure cannot log the user out
   mid-playback.

**Failure paths are never silent.** If no media source resolves, or the element fires an error, the
player returns to `#itemView` and writes a visible message into `#itemError` (the established pattern).
`MEDIA_ERR_SRC_NOT_SUPPORTED` (`error.code === 4`) gets a codec-aware, non-over-asserting message —
code 4 also covers a failed stream request (401/404/5xx) — e.g.
`This item's video codec (HEVC) is not supported by the TV, or the stream could not be loaded.`
(or, with no codec known, `This item cannot be played by the TV (unsupported codec or unavailable
stream).`); any other error keeps the generic `This item cannot be played by the TV.` The media error is
read **before** `finish()` clears the element.

The `<video>` element plays natively: there is no transcode negotiation and no subtitle UI, and the
overlay is a play/pause + progress **indicator** (no seek handling). Native `controls` is deliberately
**not** set on `#playerVideo` — the stable shell `frontend/index.html` is not edited; the D-pad drives
the overlay button instead.

#### Ordered list playback (`Michelly.playlist`)

Playing the list the user just opened plays it **in order**: the item auto-advances on `ended`, the
D-pad reaches **Prev**/**Next**, and the session **stops after the last item**. Playback **modes**
(repeat / shuffle) and a **queue** sit on top of that walk as session state; at their defaults
(repeat `'off'`, shuffle off, empty queues) the behaviour is byte-identical to the historical
strictly-in-order walk — stop at the last item, boundary no-ops, and Prev walking back past the tapped
start. A single item opened with **no** list context behaves exactly as before.

**The catalog owns the session.** `frontend/js/app/catalog.js` already renders the list and already
routes `Type === 'Audio'` to the audio player, so it also owns the queue: it exposes
`Michelly.playlist` (`isActive`, `start`, `advance`, `next`, `previous`, `hasNext`, `hasPrevious`,
`stop`, `getRepeat`, `setRepeat`, `isShuffle`, `setShuffle`, `getQueue`, `playNext`, `appendQueue`,
`clearQueue`) next to `Michelly.catalog`. `getQueue()` returns a **copy** of whichever queue is
visible (live session → session queue, otherwise the pending queue) — callers can never mutate the
live queue through it. `playNext`/`appendQueue` enqueue and return the resulting **combined** depth
(session + pending; a falsy-0 also reads falsy for old boolean-expecting callers); `clearQueue`
returns nothing meaningful. One owner means the advance logic is **not** duplicated in the two
players and a mixed Audio/Video list cannot leak extra back-stack entries. The session state lives in
the module-level `listItems`, `listIndex`, `listUserId`, `listActive` and `listKind`
(`'video'`/`'audio'`/`null`) variables, plus the mode/queue state: `playOrder`/`orderPos` (the visit
order and walk pointer), `listRepeatMode`/`listShuffle`, `currentItem` (the item actually playing —
a queue entry may not live in `listItems`), `passVisited` (the current pass's visited set — which
original indices were heard, via the walk or an Id-matched queue entry),
`listQueue` (session) and `pendingQueue` (pre-session).

**The list is captured at list-render time.** `renderItemsView`, `openEpisodes` and `openResume` pass
the items array and the tapped index (`items.indexOf(item)`) through `openItem(itemId, userId, back,
list, listIndex)` into `renderItem(…, list, listIndex)`. The **Play** button then starts the session:

```js
if (list && list.length && listIndex >= 0) {
    var queue = list.slice(0);
    queue[listIndex] = item;   // the fetched detail is richer than the /Items entry
    namespace.playlist.start(queue, listIndex, userId);
}
```

The captured list is a copy of the rendered page with the fetched item detail substituted at the
tapped index (a distinct concept from the in-memory playback queues below).
The Series-detail **Episodes** button and the `openItem(seriesId, userId)` fallback keep the
**no-list** path, so they remain single-item.

**Single-owner back-stack invariant.** `playlist.start()` pushes **exactly one** handler, which calls
the internal `endSession(false)` — **not** a public `end()`, and with **no** pop. While a session is
active, `player.play()` / `audio.play()` push **no** handler (`listMode()` →
`!!(namespace.playlist && namespace.playlist.isActive())`), and `finish()` defers to
`namespace.playlist.stop()`. **Auto-advance and next/previous never push or pop a handler.** The one
subtlety: `Michelly.ui.handleBack()` pops the handler **before** invoking it, so the handler pushed by
`start()` must not pop again (`endSession(false)`); only the direct teardown paths — `finish()`,
`advance()` past the last item, and a failed `PlaybackInfo` — call `playlist.stop()` →
`endSession(true)`, which pops that single entry. Either way, exactly **one** handler is popped per Back
press in every flow (list active, list ended, single item).

**Routing and handoff.** `playCurrent()` picks `kind = item.Type === 'Audio' ? 'audio' : 'video'` and
routes to `namespace.audio.play(item, userId)` or `namespace.player.play(item, userId)`. If the kind
changed, it calls `stopCurrentPlayer()` first (which calls `audio.stop()`/`player.stop()` and clears
`listKind`), so a mixed list keeps exactly one player and one progress timer alive. Note that
`startProgressTimer()` only clears/starts the 15 s progress timer; it does **not** post `Stopped`. The
players do **not** call `stop()` themselves between items — the playlist's `stopCurrentPlayer()` does,
which clears the previous timer and posts the finished item's `/Sessions/Playing/Stopped` through the
player's `stop()` → `reportStopped()`.

**Exactly one Stopped per started item.** Each player keeps a module-level `sourceLoaded` flag, set to
`true` at the exact point `reportPlaying()` (i.e. `POST /Sessions/Playing`) is sent in the
PlaybackInfo-success path, and reset to `false` in `stop()`. `stop()` posts
`/Sessions/Playing/Stopped` **only when `sourceLoaded` is true**, so an item for which `Playing` was
never sent — Back pressed while `PlaybackInfo` is pending, a failed `PlaybackInfo`, or a list teardown
of a not-yet-started item — cannot emit a phantom Stopped. A normally completed (`ended`) or
interrupted (`Back`) item still posts exactly one Stopped, because its `Playing` was sent and
`sourceLoaded` is cleared with it. (This also fixes the pre-existing single-item case, whose back
handler is `function () { stop(); ui().showView('itemView'); }` and hits the same path.)

**Playback modes are session state, applied centrally.** The modes live only in the catalog and are
honoured by **both** players, because each player's `onended` hands off to `playlist.advance()` while
a session is active. `advance()` order of operations: repeat-one replay → queue head → order walk →
wrap/end.

- **Repeat one** replays `currentItem` on the **auto-advance path only**; a manual **Next** still
  advances (never replays). While repeat-one is on the auto-advance branch fires before the queue is
  consulted, so the queue is **starved** until repeat drops to `off` (documented limitation).
- **Repeat all** wraps at the pass end: `rebuildOrderForWrap()` starts a fresh pass — the identity
  order from the top, or a fresh full shuffle permutation with the just-played track excluded from the
  **first** slot (shuffle wrap never immediately replays the track that just played; at order length 1
  the exclusion is skipped). A manual **Next** at the walk end honours the wrap.
- **Shuffle ON** mid-pass keeps the current item leading and permutes (Fisher-Yates) only the
  remaining-unplayed **tail** of the current pass; the toggle ON keeps the pass (`passVisited`
  survives it). Toggling **OFF** rebuilds natural order as the current walk anchor followed by
  the pass's **ascending not-yet-played remainder** (`passVisited` marks every original index
  heard so far — through the walk or an Id-matched queue entry): the forward walk never replays
  a heard track and never strands an unheard one; the Prev-then-Next walk-back is unchanged.
  Already-heard tracks rejoin only when a wrap — **either** wrap, in-order or shuffled — starts
  a fresh pass by resetting the visited set at the top of `rebuildOrderForWrap()`.
- With modes at their defaults and an empty queue, `advance()` at the last position ends the session
  (`playlist.stop()` → pops the handler → `#itemView`) and returns `false`; `next()`/`previous()`
  stay boundary **no-ops** (return `false`) that never wrap.

Modes are **per session**: `start()` resets them and rebuilds the identity `playOrder` at the tapped
index; `endSession()` clears them with the teardown.

**Queues are in-memory only — never `localStorage`, `michelly_playlists` untouched.**

- The **session queue `listQueue`** (head first): `playNext()` head-inserts ('Play next'),
  `appendQueue()` appends ('Add to queue'). `advance()`/`next()` consume the head **before** the mode
  walk; a consumed entry becomes `currentItem` while the walk pointer stays put — so **Prev never
  pulls the queue** (consumed entries are not revisited; documented limitation). The queue is emptied
  at every `start()` and destroyed by `endSession()`.
- The **pre-session `pendingQueue`** is produced by the item-view actions menu while no session is
  active (a session queue cannot exist yet). It is **adopted** — moved head-first into `listQueue`,
  with the started track's `Id` deduped — only by the next **all-Audio** start; a video or mixed
  start leaves it intact for the next audio session. It is cleared pre-session by the menu's
  'Clear queue (n)' row and on a real server switch (`setServerId` — stale-`Id` entries would fail
  `PlaybackInfo` on the new server), and it deliberately **survives `endSession()`**. It is
  audio-only by construction: the menu renders only for `Type === 'Audio'` items.

**Page boundary.** `openItems` fetches a single page (`DEFAULT_LIMIT = 60`), and the captured list is
**exactly that page**. Reaching its end ends the session cleanly at the mode defaults (under
repeat-all the wrap restarts this same page); the next page is **explicitly not** fetched
mid-playback. Auto-playing items the user never saw — plus a mid-playback network failure mode
— is worse than stopping, and one page covers the common album/season case. `total`/`StartIndex` are
deliberately not threaded into playback.

**Error mid-list ends the list.** `onerror` and the no-source paths call `finish()`, which in list mode
calls `playlist.stop()`: the session ends after a **single** failed item. It must never auto-advance
into a broken loop. The same holds for a failed `PlaybackInfo` (the player's error callback ends the
list instead of popping its own handler).

**Prev/Next and mode controls.** `player.js` builds `#playerPrev`/`#playerNext` (attribute-class `player-skip`)
into the existing `.player-controls-row`, ordered `Prev, Play/Pause, Next`; `audio.js` builds
`#audioPrev`/`#audioNext` (`audio-skip`) around `#audioToggle`, plus the session-scoped `#audioRepeat`
(label cycles `Repeat: Off → All → One` per press), `#audioShuffle` (`Shuffle: Off ↔ On`) and
`#audioQueueBtn` (`Queue: n`) on the now-playing card. `updateListControls()` is called after
the overlay/card exists, immediately around `ui().showView(...)` — before it in `player.js` (so the
overlay is in place for the view's own `navigationInit()`) and after it in `audio.js` (once the card has
been rebuilt inside the active view). With no active list it sets **all** the session-scoped controls to
`display: none` (so a single-item play is unchanged and the D-pad walk is identical); with an active
session it shows them and adds a **dimming** class (`is-inert`, `opacity: 0.45`) to Prev/Next when the
boundary makes them a no-op. `hasNext()` is true only when the queue is non-empty, a later order
position exists, or repeat-all makes the wrap reachable, and `hasPrevious()` only while the walk
pointer is above 0 (Prev never pulls the queue) — the dim state mirrors the actual action. The mode
buttons are always actionable while a session is active (a mode press is never a no-op) and never
dim; the is-inert/never-`disabled` discipline is otherwise unchanged (`navigate()` in
`frontend/js/index.js` includes any element with `offsetWidth > 0 && offsetHeight > 0`, and `.focus()`
on a disabled button silently fails, which would make the D-pad appear stuck). The buttons stay
focusable and simply no-op at a boundary. The overlay/card itself stays **always visible**.

**Queue overlay.** `#audioQueueBtn` toggles the inline `#audioQueue` overlay in the card: rows are
**non-tabbable** `<div>`s in play order (head first), with **Clear queue** (`is-inert` while empty)
and **Close**. Opening pushes **exactly one** back handler while open (the pushed handler does not
pop; the on-screen buttons do); `Clear queue` re-renders the rows in place with no stack change and
the overlay stays open. The overlay never survives a card rebuild — `renderNowPlaying()` (every new
item, including auto-advance) folds it and **pops** its handler — and `audio.stop()` folds it
**before** the session teardown pops the session entry: teardown order stays LIFO, so one Back after
an auto-advance reaches the session, never a dead press.


#### Saved playlists (`Michelly.playlists`)

Users build up to **three preset playlist slots** on the TV ("Playlist 1/2/3" — fixed names, no
rename, no user typing) and replay them through the session model above. `frontend/js/app/catalog.js`
owns the store, the add-from-item actions menu and the manage view; there is **no** `api.js` call —
server-side playlists are out of scope, the store is fork-owned and TV-only.

**Store (`michelly_playlists`, per-server).** The `localStorage` key maps the server **id** (wired
per connect — see **Keying** below) to `{ slots: [ [entry…], [], [] ] }` — exactly three arrays. An
entry carries
only what the row renderer and the audio player need: `{Id, Type, Name, ImageTags?{Primary}}`. Only
`Type === 'Audio'` items are addable — the picker is rendered on audio items only, and
`normalizeSlots` drops any non-Audio entry on read, so a foreign entry can never misroute to the
video player. Duplicate adds are guarded by `Id` (`addToSlot` returns `'added'` / `'duplicate'` /
`'error'`). Corruption is isolated **per key**: a missing/corrupt record for one server resets only
that server's slots (a malformed top-level blob counts as an empty store). A failed write (quota /
disabled storage) returns `false` and every caller surfaces `Could not save the playlist.` — never
silent. **Keying:** identical to `michelly_sessions` — the `System/Info/Public` `Id`, set once per
connect by `afterConnect` in `frontend/js/index.js` through `Michelly.playlists.setServerId(id)`.
The stable server Id wins over the address: **address/port changes no longer orphan the slots**;
orphaning needs the server's own Id to change (reinstall/reset) — the same lifetime as the session
store. This replaced the original baseUrl keying **pre-publish**, so no migration shim is needed or
shipped — no device ever held baseUrl-keyed data. Without a wired id (before `afterConnect`, or a
server reporting no Id), reads behave like absent data (fresh empty slots) and writes fail like a
storage error — a falsy `''` key is never persisted.

**Public surface.** `Michelly.playlists` — `setServerId(id)` (the store key, wired once per
connect), `listSlots()` (`[{name, count}]` for this server),
`getSlotItems(i)` (a copy, never a live reference into storage), `addToSlot(i, item)`,
`removeAt(i, position)`, `clearSlot(i)` — is the storage surface only, distinct from
`Michelly.playlist` (the session API above, still catalog-owned). The manage view reads through
`playlists` and plays through `playlist.start`.

**Add from the item view (the "More" actions menu).** For `Type === 'Audio'` items only, `renderItem`
renders a **More** button right after Play; grouped music browse reaches it because those cards route
through the same `openItem(…, list, listIndex)` → `renderItem` path. It toggles an inline **two-step
actions menu** rendered into a container under the actions. Step 1 rows, in order: **Play next**
(head-insert), **Add to queue** (append), **Clear queue (n)** (shown only pre-session while the
pending queue is non-empty — the review/undo surface; it clears and re-renders step 1 in place), **Add
to playlist**, **Open album** (only when the fetched detail carries `AlbumId` — visible-only, never a
dead button) and **Cancel**. **Add to playlist** moves to step 2 — the existing 3-slot picker
(slot buttons with live counts, an **Actions** row back to step 1, **Cancel**), rendered inline by the
push-free `renderPlaylistSlotRows`. The WHOLE interaction owns **exactly one** back handler:
`openItemActionsMenu` is the sole push site, step transitions are render-only, and every close path
pops that one entry (same convention as the session handler — `ui.handleBack()` pops before invoking,
so the pushed handler must not pop). A **Play** press closes an open menu first, so a session never
starts over a stacked handler. Queue rows fill the in-memory queue per
[Ordered list playback](#ordered-list-playback-michellyplaylist) and report depth in the item view's
inline `.playlist-status` line — `Queued to play next: <name>. (N queued)` / `Added to queue: <name>.
(N queued)` / `Queue cleared.`; slot adds keep the existing outcomes (`Added to …` / `Already in …` /
`Could not save the playlist.`), the `Id` duplicate guard and the write-error semantics **unchanged**.
Menu buttons are real `<button>`s and are **never disabled**.

**Manage view (`#playlistsView`).** Runtime-built on the `ensureSettingsView` pattern —
`ensurePlaylistsView()` appends a `<div class="view">` to `<body>`, so the shell `index.html` is
untouched and the view ships in the payload. Entry point: the **Playlists** button in the Views
header, beside Continue Watching. The slot list shows the three slots with counts; per slot **Play**
and **Clear** (Clear arms a two-step inline Yes/No confirm), and a slot detail (per-track **Remove**
+ on-screen **Back**) is a lower level of the same view with one pushed back handler, so hardware
Back returns to the slot list. Empty-slot Play/Clear no-op with a status line — the buttons stay
focusable and are never `disabled` (the same D-pad rule as Prev/Next). **Reorder is deferred** — not
in v1.

**Session-core change (the one load-bearing edit).** `Michelly.playlist.start(items, index, userId,
returnTarget)` gained an optional 4th argument — a view-id string **or** a function; when omitted
(every existing caller) `endSession()` keeps the historical `showView('itemView')`, byte-identical.
`endSession()` honours the target and clears it on teardown. The single-owner back-stack invariant,
the at-defaults stop-at-last walk and the stop-on-failure policy above are **unchanged**. Manage-play
passes a function — re-render the manage view, then arm the mirror below — as the target, so a
playlist that ends (naturally, on Back, or on a failed item) returns to the manage view.

**Never-silent for manage-play.** The players end a failing session by calling `stop()` /
`finish()` **first** (which runs the return target and lands on the manage view) and write their
message to `#itemError` **after**, so the failure would otherwise sit on the hidden `#itemView`. The
return target arms a deferred **one-tick** check (`setTimeout(0)`, after the player's synchronous
continuation): a non-empty `#itemError` text is mirrored into the manage view's status line; if the
player instead re-showed `#itemView` after the stop (the failed-`PlaybackInfo` path, which strands
the user on a shell `renderItem` never filled this launch), the tick restores the manage view and
surfaces the message there. Guards: the armed flag distinguishes the post-stop hijack from any legit
manage end, the placeholder `\u00a0` trims to empty so normal-end/Back no-op, and `#itemError` is a
foreign node — the mirror never writes or clears it. Because `renderItem` creates `#itemError`
lazily, `ensureItemErrorSlot()` pre-creates it, so a fresh launch (Playlists → Play without ever
opening an item) cannot silently discard the message.

#### Audio playback

Audio items (`Type === 'Audio'`) use a parallel player in `frontend/js/app/audio.js`:

- `frontend/js/app/catalog.js` routes the item-detail **Play** button: `Type === 'Audio'` →
  `Michelly.audio.play(item, userId)`, everything else → `Michelly.player.play(…)`. This fixes the
  pre-existing bug where an audio item was opened in the video player (`/Videos/{id}/stream`).
- `audio.play()` pushes one back handler **unless a list session is active** (`listMode()`; the playlist
  already owns the entry), shows `#audioView` and renders the now-playing card
  (`.audio-now`: poster, title, artist, album, `#audioTime`, the Prev/Next `audio-skip` buttons and the
  `#audioToggle` Play/Pause button), then runs `POST /Items/{id}/PlaybackInfo` and picks the first
  direct-stream/direct-play source.
- `#playerAudio.src = api.audioStreamUrl(itemId, source.Id, container, audioCodec)` →
  `/Audio/{itemId}/stream?static=true&container=…|audioCodec=…&MediaSourceId=…` — a **direct stream,
  no transcode**. Jellyfin 10.10+ rejects a bare `/stream`, so the first container token is always
  sent (falling back to the first `audioCodec` token when no container is known). The token travels in
  the query string as `ApiKey` **and** `api_key`.
- The `audioCodec` argument comes from `firstAudioCodec(source)`, which matches
  `MediaStream.Type === 'Audio'` — the REST API serialises the enum as the **string** `"Audio"`
  (`MediaStreamType` ordinal: Audio=0, Video=1, Subtitle=2), so the previous `Type === 0` comparison
  never matched and the `audioCodec` fallback in `api.audioStreamUrl()` was dead code. The string match
  is primary; the numeric `0` is kept only as a legacy fallback.
- `#audioToggle` carries its **own** DOM0 `onkeydown`: OK (13) / Space (32) call `toggle()` explicitly,
  then `preventDefault()` + `return false` suppress the platform's synthetic click, so it does not
  depend on the remote's OK producing a click; `onclick` still serves pointer use. The document-level
  handler early-returns when a `<button>` inside `#audioView` is focused, so the two paths cannot both
  fire. With focus elsewhere (e.g. `BODY`) the document-level handler still toggles. Back (461) stops
  playback, reports `/Sessions/Playing/Stopped` and returns to item detail. Progress is reported every
  15 s.
- **Failure paths are never silent:** no media source, and an element error, both return to
  `#itemView` with a visible `#itemError` message. `MEDIA_ERR_SRC_NOT_SUPPORTED` (`error.code === 4`)
  gets a codec-aware, non-over-asserting message (code 4 also covers a failed stream request, e.g.
  401/404/5xx): `This item's audio codec (FLAC) is not supported by the TV, or the stream could not be
  loaded.` — or, with no codec known, `This item cannot be played by the TV (unsupported codec or
  unavailable stream).` Any other error keeps the generic `This item cannot be played by the TV.`
- **Known limitation:** **FLAC is not playable on the target Chromium 38 TV** — native `<audio>` FLAC
  support is Chrome 56+, and the app direct-streams, so a flac item fails to play. See
  [webos-3-compatibility](webos-3-compatibility.md#audio-codec-reality-on-chromium-38).

**Deployment status (important).** The audio player, the video overlay, the ordered-list session and
the thin loader are all **committed on `master`**. Payload files reach the TV only through the
regenerated bundle — CI runs `npm run bundle` and publishes `app/` to `gh-pages` on every `master`
push (see [thin loader / remote bundle](#thin-loader--remote-bundle)); local-shell changes reach it
only through a new IPK via the manual HBC refresh. The saved-playlists feature (`Michelly.playlists`,
`#playlistsView`) **ships with this change**: it touches payload files only
(`js/app/catalog.js`, `js/index.js`, `css/app.css`), so it goes live on the TV's next launch after
this commit's CI publish — **no IPK rebuild**.

**Deferred / pending device logs:** narrowing `DirectPlayProfiles` (A5 — make the server-side profile
match the TV's real codecs) and the reported **video black-screen** defect are **not** part of this
change and remain unresolved; do not read this section as saying either is fixed.

### LAN auto-discovery (bundled Luna service)

`frontend/js/index.js` starts a subscription on load:

```js
webOS.service.request('luna://com.daverui.michelly.service', {
    method: 'discover',
    parameters: { uniqueToken: 'fooo' },
    subscribe: true,
    resubscribe: true,
    onSuccess: function (args) { /* args.results */ },
    onFailure: function (args) { /* … */ }
});
```

The bundled **non-elevated** Luna JS service `com.daverui.michelly.service`
(`services/service.js`, registered by `services/services.json`) implements `discover`:

- Sends the UDP broadcast `who is JellyfinServer?` to port **7359** (`255.255.255.255`), on start, on
  each `discover` request, and every **15 s** while subscriptions exist.
- Parses replies requiring `Id`, `Name` and `Address` (all strings), keyed by `Id`, and pushes them
  to subscribers as `{results: {...}}`.
- Tracks subscriptions by `uniqueToken` and cancels the interval when the last one is removed.

The app treats discovery results as hints only: `verifyThenAdd()` calls
`GET {Address}/System/Info/Public` and accepts the server only when
`ProductName == "Jellyfin Server"`. The check is centralized in `isJellyfinServer()`, and a **port scan
is deliberately not used**: an HTTP 200 on `8096` does not prove the host is Jellyfin, so UDP discovery
plus `Info/Public` is the identity signal. When nothing is saved, the user has not touched the UI and
**exactly one** verified `Jellyfin Server` exists, `maybeAutoSelectDiscoveredServer()` auto-connects to
it through `autoConnectSavedServer`; otherwise the picker stays authoritative and nothing happens.

### D-pad and Back

`document.onkeydown` in `frontend/js/index.js`:

| Key | keyCode | Behaviour |
| --- | --- | --- |
| Up / Down | 38 / 40 | `navigate(∓1)` — move focus linearly through **visible** tabbable elements only (`input, button, a, area, object, select, textarea, [contenteditable]`; elements inside hidden views are excluded). |
| Left / Right | 37 / 39 | No-ops. |
| Back | 461 | `backPressed()` — pop **one** in-app back-stack handler via `Michelly.ui.handleBack()`; only when the stack is empty call `webOS.platformBack()`. |

While a list session plays, the **Prev**/**Next** buttons and the audio card's mode controls
(**Repeat** / **Shuffle** / **Queue**) are part of the same visible tabbable set, so Up/Down reaches
them like any other control. All of them are hidden (`display: none`) for a single-item play,
which keeps the D-pad walk unchanged there; at a list boundary the button stays visible and focusable
but dimmed (`is-inert`) — it is never `disabled`, because `.focus()` on a disabled button fails.

OK (13) and Space (32) toggle the auto-connect checkbox in the picker (`handleCheckbox`); while
`#playerView` (`player.js`) or `#audioView` (`audio.js`) is active, the same keys toggle play/pause.
The toggle button in each view has its own `onkeydown` that calls `toggle()` explicitly and suppresses
the synthetic click (`preventDefault()` + `return false`), so OK/Space does not depend on the platform
synthesizing a click; the document-level handler returns early when a `<button>` inside that view is
focused (`isButtonFocused`), so the two paths cannot both fire.

### Persistence

| `localStorage` key | Contents |
| --- | --- |
| `_deviceId2` | Device id, generated jellyfin-web style: `btoa([navigator.userAgent, Date.now()].join('|'))` with `=` replaced by `1`. |
| `connected_servers` | LRU map (max 4) of `{baseurl, Address, auto_connect, id, Name}` keyed by server id. |
| `michelly_sessions` | Per-server auth session `{userId, accessToken, userName}` keyed by server id. |
| `michelly_default_user` | Default credential for automatic sign-in: **absent** = built-in `pepe`/`pepe`; `{username, password}` = custom (**plaintext**); `{disabled: true}` = auto-login off. |
| `michelly_playlists` | Per-server saved-playlist slots `{slots:[[…],[…],[…]]}` keyed by server id (like `michelly_sessions`): exactly three preset slots, Audio-only entries `{Id, Type, Name, ImageTags?}` (see [Saved playlists](#saved-playlists-michellyplaylists)). |

The LRU map is written only on a successful connect (`handleSuccessServerInfo`). A failed connect
leaves it untouched — `handleFailure` no longer clears it (`1.3.2`, divergence log
[#14](upstream-provenance.md#divergence-log)).

### Security debt (deferred)

The native client stores a real **access token** in `localStorage` (`michelly_sessions`) — credentials
that the old iframe wrapper never persisted. It can **also** persist a **plaintext default credential**
in `michelly_default_user` (the built-in `pepe`/`pepe` while the key is absent, or the user's own account
after a Save). Both are **accepted, deliberate** trade-offs for a **LAN-only personal client**: the token
and credential are scoped to the user's own server on a single-user home TV. The default credential is
stored **without any obfuscation on purpose** — `localStorage` is readable by anything running in the
app's origin, so encoding it would only create a false sense of safety; **no meaningful protection is
claimed**. The per-server session itself still never contains the password.

Hardening is explicitly **deferred / out of scope** for now:

- encryption of the token and the default credential at rest;
- token refresh / expiry handling;
- a revocation UI and a user-facing **logout** affordance (`auth.logout()` exists but is unused).

Do not treat any of the above as a current guarantee. Cross-referenced from the
[project.md technology stack](../project.md#technology-stack) and
[webos-3-compatibility](webos-3-compatibility.md#security-debt-deferred).

### Luna endpoints reached

| Endpoint | Method | Used for |
| --- | --- | --- |
| `luna://com.daverui.michelly.service` | `discover` | LAN server discovery (bundled service). |
| `luna://com.webos.service.tv.systemproperty` | `getSystemInfo` | Device info via `webOSTV.js` (HDR/Dolby flags, screen size). |
| `luna://com.webos.service.config` | `getConfigs` | Device info via `webOSTV.js`. |
| `luna://com.webos.settingsservice` | `getSystemSettings` | Device info via `webOSTV.js`. |
| `luna://com.webos.service.arccontroller` | `getARCState` | Device info via `webOSTV.js`. |
| `luna://com.webos.service.eim` | `getAllInputStatus` | Device info via `webOSTV.js`. |

### No launch-parameter / deep-link surface

`frontend/appinfo.json` declares **no** `handles`, `launchParams` or `params` entries, and the app
reads no launch arguments. It has no deep-link surface of its own; a launch always starts on the
server picker (or auto-connects to the last server).

### ACG declaration (open decision)

`frontend/appinfo.json` does **not** define `requiredACG`. `ares-package` warns that the field can be
required for submission eligibility on some webOS versions and suggests `"requiredACG": []` when the
app calls no Luna APIs. This app **does** call Luna (its own bundled service, plus `webOSTV.js`), so
an empty array would be wrong. The correct group set is unresolved — see
[webos-3-compatibility](webos-3-compatibility.md).

## When to use

- Reading path: any question about how the picker, discovery, REST client, auth/session, catalog or
  playback work.
- Changing path: editing an upstream `frontend/` file requires a divergence entry (see
  [upstream-provenance](upstream-provenance.md)). A change inside the 9-file payload
  (`js/app/*.js`, `js/index.js`, `css/app.css`) needs `npm run bundle` + a publish to reach the TV —
  no reinstall; anything in the local shell still needs an IPK rebuild and reinstall.

## When not to use

- Compatibility with the target webOS version: see
  [webos-3-compatibility](webos-3-compatibility.md).
- Packaging and releases: see [hbc-distribution-plan](hbc-distribution-plan.md) and the
  [release protocol](../protocols/release-protocol.md).
- Licensing and upstream sync: see [upstream-provenance](upstream-provenance.md).

## Examples

Connecting to a server (the picker's own flow, from `frontend/js/index.js`):

```js
ajax.request(normalizeUrl(baseurl + '/System/Info/Public'), {
    method: 'GET',
    success: function (data) { handleSuccessServerInfo(data, baseurl, auto_connect); },
    error: handleFailure,
    abort: handleAbort,
    timeout: 5000
});
```

Calling the REST API with the client identity header (from `frontend/js/app/api.js`):

```js
var settings = {
    method: 'GET',
    headers: {
        'Accept': 'application/json',
        'Authorization': 'MediaBrowser Client="MiChelly", Device="LG Smart TV", ' +
            'DeviceId="' + parts.deviceId + '", Version="' + parts.version + '"'
    }
};
return ajax.request(baseUrl + '/Users/' + userId + '/Views', settings);
```

Starting native playback (from `frontend/js/app/player.js`):

```js
api().getPlaybackInfo(item.Id, userId, function (data) {
    var source = pickMediaSource(data);
    var v = document.querySelector('#playerVideo');
    v.src = api().streamUrl(item.Id, source.Id, source.Container || item.Container || '');
    v.play();
});
```

## Common mistakes

### Editing an upstream file without recording a divergence

`frontend/js/*.js`, `frontend/css/*.css`, `frontend/index.html` and `services/service.js` come from
upstream. Any edit must be logged in [upstream-provenance](upstream-provenance.md#divergence-log),
otherwise the next upstream merge silently conflicts. The `frontend/js/app/*` files and
`frontend/css/app.css` are new **fork-only** files, not upstream.

### Expecting a payload code/UI change to need a new IPK

The 9 payload files (`js/app/*.js`, `js/index.js`, `css/app.css`) are fetched, verified and injected by
the [thin loader](#thin-loader--remote-bundle) on every launch; a `npm run bundle` + `master` push makes
them live on the TV's next launch, with **no HBC Update and no reinstall**. Only shell/service/assets/
`appinfo.json` changes need an IPK, and the IPK version string stays frozen across payload-only updates.

### Expecting `/web/manifest.json` to be read

The app no longer fetches `{baseurl}/web/manifest.json` (`start_url` / `shortname`) and never loads a
server-served web client. If a library or poster is blank, the failure is in the REST API call or the
token, not in a missing manifest.

### Looking for the old `NativeShell` bridge

`frontend/js/webOS.js`, `window.NativeShell` / `AppHost` and the `window.postMessage` handoff to an
iframe no longer exist. The equivalent functionality (device info, device profile, exit) lives in
`frontend/js/app/platform.js`, which runs **in the app itself**.

### A newly discovered server is not persisted

**Fixed in `1.3.1`.** Upstream v1.2.2 had a persistence defect (not a fork change):
`frontend/js/index.js:359` called `.unshift()` on the plain object `connected_servers`; `:365` wrote
the wrong key (`connected_server`) using an undefined variable `servers`; `:367` logged `info` out of
scope; and `:297`/`:392` also used the wrong key, so the `remove` was a no-op. Net effect: a newly
discovered server could never be saved.

The `1.3.1` fix (divergence log
[#13](upstream-provenance.md#divergence-log)) stores the new entry through the keyed `lruStrategy`
helper (max **4**, keyed by server id) and every write/remove uses the `connected_servers` key.

> Behaviour note: correcting that key briefly activated upstream's `handleFailure` intent in `1.3.1` —
> a failed request cleared the whole `connected_servers` map. `1.3.2` removed that call (divergence log
> [#14](upstream-provenance.md#divergence-log)): `handleFailure` receives only `{error}`, so it has no
> server identity in scope, and a transient failed connect (server off, timeout) must not forget the
> other saved servers. The map now changes only through the success paths.

### Assuming Left/Right moves focus

37/39 are intentional no-ops. Only Up/Down traverse the tab order, and only across elements in the
**visible** view. (The upstream web client's own focus handling is no longer involved.)

### Assuming `data.start_url.includes(...)` is safe on old engines

`String.prototype.includes` is polyfilled at the top of `frontend/js/index.js`; since `1.3.1`
`Array.prototype.includes` is polyfilled there too (ES5 — divergence log `#12`). See
[webos-3-compatibility](webos-3-compatibility.md).

## References

- [webos-3-compatibility](webos-3-compatibility.md)
- [upstream-provenance](upstream-provenance.md)
- [HBC distribution plan](hbc-distribution-plan.md)
- [Release protocol](../protocols/release-protocol.md)
- [Project entry point](../project.md)
