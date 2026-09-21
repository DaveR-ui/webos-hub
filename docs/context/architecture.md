---
last_updated: 2026-09-21
status: active
description: Architecture of the MiChelly webOS media client — the app shell and views, the ES5 thin loader and remote bundle, the ES5 REST client and authorization, per-server auth/session, catalog browsing, native playback, and the bundled Luna discovery service.
tags: [architecture, webview, views, thin-loader, remote-bundle, sha256, media-server-rest-api, es5, auth, session, playback, luna, discovery, d-pad, media-server]
version: 2.5
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
| `frontend/js/app/catalog.js` | Views → items → item detail → episodes, Resume and paging; every card is a `<button>`. **Fork-only.** Remote payload. |
| `frontend/js/app/player.js` | PlaybackInfo → direct-stream `<video>` plus an always-visible D-pad-operable control overlay (Play/Pause button, time readout, progress bar), play/pause, codec-aware error reporting, best-effort session reporting. **Fork-only.** Remote payload. |
| `frontend/js/app/audio.js` | Audio direct-stream `<audio>` player: now-playing card, play/pause/stop, session reporting. **Fork-only.** Remote payload. |
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
  Watching** button.
- `openItems(parentId, …)` — `GET /Items` with paging (`DEFAULT_LIMIT` 60) and Previous/Next buttons.
- `openItem(itemId, …)` — `GET /Users/{userId}/Items/{itemId}` renders poster, overview, **Play**, and an
  **Episodes** button when `Type === 'Series'`.
- `openEpisodes(seriesId, …)` and `openResume(userId)` cover series episodes and Continue Watching.

Every selectable card is a `<button class="card">` so the global D-pad selector in `index.js` can reach
it. Each navigation resets the back stack and pushes **exactly one** handler that recreates its parent,
so the stack stays bounded no matter how deep the user goes. Missing or failed images swap to a text
fallback (`Michelly.ui.renderImage`).

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


#### Audio playback

Audio items (`Type === 'Audio'`) use a parallel player in `frontend/js/app/audio.js`:

- `frontend/js/app/catalog.js` routes the item-detail **Play** button: `Type === 'Audio'` →
  `Michelly.audio.play(item, userId)`, everything else → `Michelly.player.play(…)`. This fixes the
  pre-existing bug where an audio item was opened in the video player (`/Videos/{id}/stream`).
- `audio.play()` pushes one back handler, shows `#audioView` and renders the now-playing card
  (`.audio-now`: poster, title, artist, album, `#audioTime` and the `#audioToggle` Play/Pause button),
  then runs `POST /Items/{id}/PlaybackInfo` and picks the first direct-stream/direct-play source.
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

**Deployment status (important).** The audio player and the thin loader are **not yet in the published
IPK or the `gh-pages` bundle** — that work is **uncommitted** in the working tree. A TV running the
published `1.3.3` IPK therefore has **no audio player at all**: audio items cannot be played until the
work is committed, the remote bundle regenerated (`npm run bundle`) and republished (and the IPK
rebuilt for the shell/loader). The video overlay in `frontend/js/app/player.js` ships the same way —
it reaches the TV only through a regenerated and published payload.

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
