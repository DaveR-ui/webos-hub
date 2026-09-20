---
last_updated: 2026-09-20
status: active
description: Architecture of the Jellyfin webOS client fork — the webview shell, server picker and LAN discovery, the iframe handoff, the NativeShell bridge and the bundled Luna service.
tags: [architecture, webview, luna, iframe, handoff, discovery, nativeshell, postmessage, jellyfin]
version: 1.1
related: [webos-3-compatibility, upstream-provenance, hbc-distribution-plan]
---

# Architecture

## Problem

A webOS web app cannot render Jellyfin by itself. jellyfin-web is **served by the user's Jellyfin
server**, so the client must host it inside a frame, bridge it to the webOS platform (device info,
exit, device profile), and let the user find and pick a server on the local network — while a webview
cannot open raw sockets for UDP discovery.

## Solution

### Thin native shell

`frontend/index.html` loads plain scripts in a fixed order — there is no framework and no build step:

| File | Role |
| --- | --- |
| `frontend/index.html` | App shell: logo, server-picker form (`#baseurl`, `#auto_connect`), `#serverlist`, `#busy`, hidden `#contentFrame` iframe. |
| `frontend/webOSTVjs-1.2.11/webOSTV.js` | webOS platform JS (device info, Luna bus, `platformBack`). |
| `frontend/webOSTVjs-1.2.11/webOSTV-dev.js` | Developer-mode companion bundle. |
| `frontend/js/ajax.js` | `XMLHttpRequest` wrapper (JSON parse, 5 s timeouts, abort/timeout/error callbacks). |
| `frontend/js/storage.js` | `localStorage` JSON wrapper. |
| `frontend/js/index.js` | Server picker, auto-discovery subscription, connect flow, iframe handoff, D-pad handling. |
| `frontend/js/webOS.js` | The `NativeShell` adapter injected into the jellyfin-web iframe. |
| `frontend/css/main.css`, `frontend/css/webOS.css` | Picker styling, and the styles injected into jellyfin-web. |

The app is a **wrapper**: it never renders library or playback UI itself.

### Server picker and connect flow

`Init()` (on `<body onload>`) reads `connected_servers` from `localStorage`, pre-fills the URL field
and auto-connect checkbox from the most recent server, and honours the auto-connect flag unless the
page was reached via Back/Forward.

Connecting (`handleServerSelect`) normalizes the URL, then:

1. `GET {baseurl}/System/Info/Public` → server identity (`Id`, `ServerName`) and record in the LRU map.
2. `GET {baseurl}/web/manifest.json` → `start_url` and `shortname`.
3. `handoff(hosturl, bundle)`.

The LRU map is capped at **4** servers (`lruStrategy`). The host URL is built from `start_url`
(`"/web"` is added unless already present).

### Iframe handoff

`handoff()` hides the picker, points `#contentFrame` at the server's `start_url`, and on load
injects into that frame:

- `window.AppInfo` — `{deviceId, deviceName, appName, appVersion}`
- `window.DeviceInfo` — the result of `webOS.deviceInfo(...)`
- the text of `frontend/js/webOS.js`, which installs `window.NativeShell`
- the text of `frontend/css/webOS.css`

`getTextToInject()` fetches those two assets over XHR and imitates promises (Promises are avoided
deliberately — see the comments in `frontend/js/index.js` about older webOS).

### The `NativeShell` bridge

`frontend/js/webOS.js` defines `window.NativeShell.AppHost` and friends. It communicates with the
wrapper only through `window.top.postMessage({type, data}, '*')`.

| `AppHost` method | Behaviour |
| --- | --- |
| `init`, `appName`, `appVersion`, `deviceId`, `deviceName` | Return the value from `AppInfo` and post it to the wrapper. |
| `exit` | Posts `AppHost.exit`; the wrapper then calls `webOS.platformBack()`. |
| `getDefaultLayout` | Returns `'tv'`. |
| `getDeviceProfile(profileBuilder)` | Builds a device profile from `DeviceInfo` (`dolbyAtmos`, `dolbyVision`, `hdr10`, MKV progressive off, SSA render on). |
| `getSyncProfile(profileBuilder)` | Minimal profile (`enableMkvProgressive: false`). |
| `supports(command)` | Matches against a fixed feature list (see below). |
| `screen` | Returns `{width, height}` from `DeviceInfo`, or `null`. |

Additional `NativeShell` methods: `selectServer`, `downloadFile`, `enableFullscreen`,
`disableFullscreen`, `getPlugins` (returns `[]`), `openUrl`, `updateMediaSession`,
`hideMediaSession`.

The wrapper's `message` listener handles exactly two types:

| `type` | Wrapper behaviour |
| --- | --- |
| `selectServer` | Restart discovery, show the picker, clear and hide the iframe. |
| `AppHost.exit` | `webOS.platformBack()`. |

Declared `supports()` features: `exit`, `externallinkdisplay`, `htmlaudioautoplay`,
`htmlvideoautoplay`, `imageanalysis`, `physicalvolumecontrol`, `displaylanguage`,
`otherapppromotions`, `targetblank`, `screensaver`, `subtitleappearancesettings`,
`subtitleburnsettings`, `chromecast`, `multiserver`.

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

The wrapper treats discovery results as hints only: `verifyThenAdd()` calls
`GET {Address}/System/Info/Public` and accepts the server only when
`ProductName == "Jellyfin Server"`.

### D-pad and Back

`document.onkeydown` in `frontend/js/index.js`:

| Key | keyCode | Behaviour |
| --- | --- | --- |
| Up / Down | 38 / 40 | `navigate(∓1)` — move focus linearly through tabbable elements (`input, button, a, area, object, select, textarea, [contenteditable]`). |
| Left / Right | 37 / 39 | No-ops in the wrapper. |
| Back | 461 | `webOS.platformBack()`. |

OK (13) and Space (32) toggle the auto-connect checkbox via `handleCheckbox`.

### Persistence

| `localStorage` key | Contents |
| --- | --- |
| `_deviceId2` | Device id, generated jellyfin-web style: `btoa([navigator.userAgent, Date.now()].join('|'))` with `=` replaced by `1`. |
| `connected_servers` | LRU map (max 4) of `{baseurl, auto_connect, id, Name, hosturl}` keyed by server id. |

No credentials are stored by the wrapper; sign-in happens inside jellyfin-web.

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

- Reading path: any question about how the picker, discovery, the iframe handoff or the bridge work.
- Changing path: editing `frontend/js/` requires a divergence entry (see
  [upstream-provenance](upstream-provenance.md)) plus a rebuild.

## When not to use

- Compatibility with the target webOS version: see
  [webos-3-compatibility](webos-3-compatibility.md).
- Packaging and releases: see [hbc-distribution-plan](hbc-distribution-plan.md) and the
  [release protocol](../protocols/release-protocol.md).
- Licensing and upstream sync: see [upstream-provenance](upstream-provenance.md).

## Examples

Connecting to a server (the wrapper's own flow, from `frontend/js/index.js`):

```js
ajax.request(normalizeUrl(baseurl + '/System/Info/Public'), {
    method: 'GET',
    success: function (data) { handleSuccessServerInfo(data, baseurl, auto_connect); },
    error: handleFailure,
    abort: handleAbort,
    timeout: 5000
});
```

Implementing a `NativeShell` call inside jellyfin-web, and answering it in the wrapper:

```js
// injected into the iframe by js/webOS.js
window.NativeShell = { selectServer: function () { postMessage('selectServer'); } /* … */ };

// handled by the wrapper's window 'message' listener
case 'selectServer':
    startDiscovery();
    document.querySelector('.container').style.display = '';
    contentFrame.style.display = 'none';
    contentFrame.src = '';
    break;
```

## Common mistakes

### Editing an upstream file without recording a divergence

`frontend/js/*.js`, `frontend/css/*.css`, `frontend/index.html` and `services/service.js` come from
upstream. Any edit must be logged in [upstream-provenance](upstream-provenance.md#divergence-log),
otherwise the next upstream merge silently conflicts.

### Expecting the wrapper to render Jellyfin UI itself

The wrapper contains no library or player code. If the iframe is blank, the server's jellyfin-web did
not load — check the server URL and `/web/manifest.json`, not the wrapper's CSS.

### A newly discovered server is not persisted

**Upstream defect present in v1.2.2** (not a fork change): `frontend/js/index.js:359` calls
`.unshift()` on the plain object `connected_servers`; `:365` writes the wrong key
(`connected_server`) using an undefined variable `servers`; `:367` logs `info` out of scope; and
`:297`/`:392` also use the wrong key, so the `remove` is a no-op. Net effect: a newly discovered
server may never be saved. Tracked as a follow-up in
[upstream-provenance](upstream-provenance.md#divergence-log).

### Assuming Left/Right moves focus

In the wrapper, 37/39 are intentional no-ops. Only Up/Down traverse the tab order. (Inside
jellyfin-web, jellyfin-web owns its own focus handling.)

### Assuming `data.start_url.includes(...)` is safe on old engines

`String.prototype.includes` is polyfilled at the top of `frontend/js/index.js`; `Array.prototype.includes`
is **not** polyfilled anywhere. See [webos-3-compatibility](webos-3-compatibility.md).

## References

- [webos-3-compatibility](webos-3-compatibility.md)
- [upstream-provenance](upstream-provenance.md)
- [HBC distribution plan](hbc-distribution-plan.md)
- [Release protocol](../protocols/release-protocol.md)
- [Project entry point](../project.md)
