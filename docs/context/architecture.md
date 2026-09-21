---
last_updated: 2026-09-21
status: active
description: Architecture of the MiChelly webOS media client — the app shell and views, the ES5 REST client and authorization, per-server auth/session, catalog browsing, native playback, and the bundled Luna discovery service.
tags: [architecture, webview, views, media-server-rest-api, es5, auth, session, playback, luna, discovery, d-pad, media-server]
version: 2.1
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
step, no bundler:

| File | Role |
| --- | --- |
| `frontend/index.html` | App shell: five view panes — `#pickerView` (logo, `#octet3`/`#octet4`/`#port`, `#auto_connect`, `#serverlist`, `#busy`), `#loginView`, `#browseView`, `#itemView`, `#playerView` (`<video id="playerVideo">`). |
| `frontend/webOSTVjs-1.2.11/webOSTV.js` | webOS platform JS (device info, app info, Luna bus, `platformBack`). |
| `frontend/webOSTVjs-1.2.11/webOSTV-dev.js` | Developer-mode companion bundle. |
| `frontend/js/ajax.js` | `XMLHttpRequest` wrapper (JSON parse, 5 s timeouts, abort/timeout/error callbacks). |
| `frontend/js/storage.js` | `localStorage` JSON wrapper. |
| `frontend/js/app/platform.js` | Device/app identity, device profile, screen size and exit; owns `_deviceId2` and the `Authorization` header parts. **Fork-only.** |
| `frontend/js/app/api.js` | ES5 XHR media-server REST client: builds the `MediaBrowser` authorization header, exposes the endpoints, the image/stream URLs and the unauthorized hook. **Fork-only.** |
| `frontend/js/app/auth.js` | Per-server session store keyed by server id in `michelly_sessions`; login via `/Users/AuthenticateByName`; a 401 clears the session. **Fork-only.** |
| `frontend/js/app/ui.js` | View switcher, back-handler stack and the loading/empty/error state renderers. **Fork-only.** |
| `frontend/js/app/catalog.js` | Views → items → item detail → episodes, Resume and paging; every card is a `<button>`. **Fork-only.** |
| `frontend/js/app/player.js` | PlaybackInfo → direct-stream `<video>`, play/pause, best-effort session reporting. **Fork-only.** |
| `frontend/js/index.js` | Server picker, auto-discovery subscription, connect flow, main key/Back handling. |
| `frontend/css/main.css` | Picker and shared control styling. |
| `frontend/css/app.css` | Native view / catalog / player styling (flexbox only). **Fork-only.** |

The `js/app/*` files each extend the shared `window.Michelly` namespace
(`var Michelly = window.Michelly = window.Michelly || {};`); `index.js` wires the picker to them.

### Server picker and connect flow

`Init()` (on `<body onload>`) shows `#pickerView`, initialises the platform layer, then reads
`connected_servers` from `localStorage`, pre-fills the three picker fields (`#octet3`/`#octet4`/`#port`)
and the auto-connect checkbox from the most recent server, and honours the auto-connect flag unless the
page was reached via Back/Forward. The pre-fill only happens when the saved host is `192.168.x.x`;
otherwise the fields keep their defaults (`0`/`0`/`8096`) and auto-connect is skipped, so a stale or
different-host entry never fires a bogus request — and its server-list **Connect** button shows an error
instead of connecting.

Connecting (`handleServerSelect`) validates the two octets (`0-255` each) and the port (`1-65535`) and
composes `http://192.168.<octet3>.<octet4>:<port>` (scheme fixed to `http`). If any field is invalid,
no request is issued and an error is shown. On success it follows:

1. `GET {baseurl}/System/Info/Public` → server identity (`Id`, `ServerName`) and record in the LRU map
   (`lruStrategy`, capped at **4** servers).
2. `afterConnect(baseurl, data)`:
   - `Michelly.api.setBaseUrl(baseurl)`;
   - if `michelly_sessions[server.Id]` holds an `accessToken`, reuse it (`setToken`) and open the views;
   - otherwise show `#loginView`.

There is **no** `/web/manifest.json` fetch and **no** `start_url`: the app no longer loads a
server-served web client, so none of the old `handoff()` machinery remains.

### Auth and per-server sessions

`frontend/js/app/auth.js` keeps one session per server in the `michelly_sessions` `localStorage` key,
keyed by the server id, storing `{userId, accessToken, userName}`. The **password is never stored**.
Sign-in posts `POST /Users/AuthenticateByName` with `{Username, Pw}`; on success the returned
`AccessToken` and `User.Id` are persisted. Any browsing call that returns 401/403 fires the
`Michelly.api.onUnauthorized` hook, which clears the saved session and returns to `#loginView`.
`auth.logout(serverId)` exists but is not yet exposed in the UI — see the
[deferred security note](#security-debt-deferred).

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
| `/Videos/{itemId}/stream` | GET | Direct-stream media (opened by `<video>`). |
| `/Sessions/Playing`, `/Sessions/Playing/Progress`, `/Sessions/Playing/Stopped` | POST | Best-effort playback reporting (errors swallowed). |
| `/Items/{itemId}/Images/{type}` | GET | Posters and thumbnails. |

An image or `<video>` element **cannot** send an `Authorization` header, so the token travels in the
query string as both `ApiKey` (current) and `api_key` (legacy alias).

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
3. OK/Space toggle play/pause while `#playerView` is active; Back stops playback and returns to item
   detail.
4. Best-effort `POST /Sessions/Playing*` reporting starts on play, repeats every 15 s and stops on
   stop/end. These pings run with `suppressAuth`, so a transient failure cannot log the user out
   mid-playback.

The `<video>` element plays natively: there is no transcode negotiation, no subtitle UI and no custom
seek bar beyond the platform player's own controls.

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
`ProductName == "Jellyfin Server"`.

### D-pad and Back

`document.onkeydown` in `frontend/js/index.js`:

| Key | keyCode | Behaviour |
| --- | --- | --- |
| Up / Down | 38 / 40 | `navigate(∓1)` — move focus linearly through **visible** tabbable elements only (`input, button, a, area, object, select, textarea, [contenteditable]`; elements inside hidden views are excluded). |
| Left / Right | 37 / 39 | No-ops. |
| Back | 461 | `backPressed()` — pop **one** in-app back-stack handler via `Michelly.ui.handleBack()`; only when the stack is empty call `webOS.platformBack()`. |

OK (13) and Space (32) toggle the auto-connect checkbox in the picker (`handleCheckbox`); while
`#playerView` is active, `frontend/js/app/player.js` uses the same keys to toggle play/pause.

### Persistence

| `localStorage` key | Contents |
| --- | --- |
| `_deviceId2` | Device id, generated jellyfin-web style: `btoa([navigator.userAgent, Date.now()].join('|'))` with `=` replaced by `1`. |
| `connected_servers` | LRU map (max 4) of `{baseurl, Address, auto_connect, id, Name}` keyed by server id. |
| `michelly_sessions` | Per-server auth session `{userId, accessToken, userName}` keyed by server id. |

The LRU map is written only on a successful connect (`handleSuccessServerInfo`). A failed connect
leaves it untouched — `handleFailure` no longer clears it (`1.3.2`, divergence log
[#14](upstream-provenance.md#divergence-log)).

### Security debt (deferred)

The native client now stores a real **access token** in `localStorage` (`michelly_sessions`) —
credentials that the old iframe wrapper never persisted. This is an **accepted, deliberate** trade-off
for a **LAN-only personal client**: the token is scoped to the user's own server and the password
itself is never stored. Hardening is explicitly **deferred / out of scope** for now:

- token encryption at rest;
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
- Changing path: editing `frontend/js/` requires a divergence entry (see
  [upstream-provenance](upstream-provenance.md)) plus a rebuild.

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
