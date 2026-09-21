---
last_updated: 2026-09-21
status: active
description: webOS 3.0 / Chromium 38 compatibility report for the MiChelly media client — what is safe in the shipped ES5 app, the concrete defects, the deferred security debt and the on-device test needed to close the question.
tags: [webos-3, chromium-38, es5, polyfill, compatibility, legacy, array-includes, disablebackhistoryapi, requiredacg, security-debt]
version: 2.1
related: [architecture, upstream-provenance, hbc-distribution-plan]
---

# webOS 3.0 Compatibility

## Problem

The target TV runs **webOS 3.0**. The client is now a **self-contained media app**: it renders its
own views and plays media in its own `<video>` element, talking to the media-server REST API directly
(see [architecture](architecture.md)). So "does this app work on webOS 3.0" is essentially one
question:

1. Does the **whole shipped app** (`frontend/`, including the fork-only `frontend/js/app/*.js` and
   `frontend/css/app.css`, plus `services/`) run on the TV's old browser engine?

There is no server-served web client in a frame to fall back on any more, so the app's own ES5
discipline and its own rendering/playback are the entire compatibility surface. webOS 3.x ships an old
Chromium engine and the app declares no minimum OS version, so the question is not answered by the
repository itself. This document records the audit and its verdict.

## Solution

### Platform baseline

| webOS TV release | Years | Chromium engine |
| --- | --- | --- |
| 3.x | 2016–2017 | **38** (2014) |
| 4.x | 2018–2019 | 53 |
| 5.x | 2020 | 68 |
| 6.x | 2021+ | 79 |

The concrete target is **Chromium 38**.

### Shipped-frontend audit (read-only, every shipped asset inspected)

| Feature | Finding |
| --- | --- |
| Arrow functions, `let`, template literals, classes, destructuring/spread, `async`/`await`, `fetch`, `Promise` | **None** in the app's own JS — `frontend/js/index.js`, `frontend/js/ajax.js`, `frontend/js/storage.js` and every `frontend/js/app/*.js` file are ES5-only. The vendored `webOSTVjs-1.2.11/` bundle is a pre-built upstream artifact; its one problematic call (`Array.prototype.includes`) is polyfilled below. |
| `const` | The 3 pre-existing declarations in `frontend/js/index.js` are now `var`; the app's own JS no longer uses `const` anywhere. |
| `Object.assign`, `Array.from` / `Array.prototype.find`, `Element.closest`, `classList` | Not used in the shipped frontend; `index.js` implements its own index lookup instead of `Array.from(...).findIndex(...)`. |
| `String.prototype.includes` | Polyfilled at the top of `frontend/js/index.js` (String polyfill lines 21–31; the `Array.prototype.includes` polyfill is at lines 9–15). Covers the `String.prototype.includes` use inside `webOSTV.js`. |
| `Array.prototype.includes` | **Polyfilled at the top of `frontend/js/index.js`** (ES5, installed before the `webOS.deviceInfo(...)` call). Covers the `webOSTV.js` `getSystemInfo` `missingConfigs` path. |
| CSS | `frontend/css/app.css` and `frontend/css/main.css` are **flexbox-only** with `-webkit-` prefixes. **No CSS grid** (Chrome 57+) is used anywhere. |

> Caveat: the `const` behaviour on Chromium 38 is the one claim that could not be verified against a
> real Chromium 38 binary. Treat it as "degraded block scoping, not a crash", not as a guaranteed
> fact — though as of this rewrite the shipped frontend uses no `const` at all.

### The one real defect for webOS 3.0: `Array.prototype.includes` (fixed in `1.3.1`)

The bundled `frontend/webOSTVjs-1.2.11/webOSTV.js` uses **`Array.prototype.includes`** in the
`missingConfigs` check inside the `luna://com.webos.service.tv.systemproperty` `getSystemInfo`
callback.

- `Array.prototype.includes` is **Chrome 47+**; Chromium 38 does not have it.
- Since `1.3.1` the shipped frontend **does** polyfill it at the top of `frontend/js/index.js`
  (ES5, installed before the `webOS.deviceInfo` call).
- Before that, on Chromium 38 that path threw `TypeError: t.includes is not a function`, aborting the
  `webOS.deviceInfo` fallback and leaving `deviceInfo` `undefined`.
- It degrades the device profile (`frontend/js/app/platform.js` → HDR/Dolby flags become `null`) and
  `getScreen` (becomes `null`).
- It is reached only when the TV returns a **non-empty `missingConfigs` list**.

This was the highest-value fix for the `compat` slice; it shipped in `1.3.1` (divergence log `#12`).

### `disableBackHistoryAPI` is ignored on webOS 3.0

`frontend/appinfo.json` sets `"disableBackHistoryAPI": true`. That property is **post-3.0**, so on
webOS 3.0 it is ignored: the platform keeps managing Back through the HTML history API while
`frontend/js/index.js` also handles keyCode 461 itself. That is a potential **double-handling**
conflict — Back may both navigate history and run the in-app back handler / `webOS.platformBack()`.

### `requiredACG` is missing

`frontend/appinfo.json` defines no `requiredACG`, and `ares-package` warns that the field can be
required to pass submission eligibility checks on some webOS versions, suggesting `"requiredACG": []`
"if the app calls no Luna APIs".

**This app does call Luna** — its own bundled `com.daverui.michelly.service` and, through
`webOSTV.js`, several `com.webos.*` services (see [architecture](architecture.md#luna-endpoints-reached)).
An empty array would therefore be wrong.

- webOS 3.0 predates ACG enforcement, so it is not a runtime blocker for the target TV.
- Newer webOS versions require the field for store submission, so the same IPK is **not
  future-proof**.
- The correct group set is an **open decision**. Do not prescribe `"requiredACG": []`.

### The app itself is the compatibility surface

The previous version of this document asked whether the **server-served web client** would render on
Chromium 38. That question no longer applies: the app does not load a server-served web client at all.
What must run on Chromium 38 is the app itself, and it does so with a small, fixed feature set:

- `XMLHttpRequest` (via `frontend/js/ajax.js`) — not `fetch`;
- DOM building with `document.createElement` / `textContent` (no innerHTML templating in the app
  views);
- `<video>` with a direct `/Videos/{id}/stream` source;
- flexbox layouts with `-webkit-` prefixes.

The residual risk is therefore **codec/container and `<video>` playback behaviour on the TV**, not
JavaScript syntax or a third-party UI framework. That can only be confirmed on the device.

### Security debt (deferred)

The native client stores a real **access token** in `localStorage` (`michelly_sessions`) instead of
storing no credentials, as the old iframe wrapper did. This is an **accepted, deliberate** trade-off
for a **LAN-only personal client**; the password is never stored. Token encryption/refresh, a
revocation UI and a logout affordance are explicitly **deferred / non-goal** — the canonical note and
the full list live in
[architecture.md → Security debt (deferred)](architecture.md#security-debt-deferred).

### Minimum webOS version — what Jellyfin actually says

- `frontend/appinfo.json` declares **no** minimum-OS field, and the README states none.
- The `webOS >= 5.0` figure shown by `repo.webosbrew.org` is a **2026 auto-derived Homebrew
  heuristic** (`requirements.webosRelease: '>=5.0'`), derived from ES2017 detection by the webosbrew
  apps-repo tooling. It is **not** a Jellyfin or LG requirement.
- Jellyfin's own stated floor is **webOS 3.x** (2022 blog post: "We'll try our best to get as far
  back as webOS 3.x").
- webOS 3 **scrolling** was explicitly fixed upstream in jellyfin-web PR #14 (2020).

### Bottom line

Running this fork on **webOS 3.0 is plausible but unverified**. It is **not a proven hard blocker**,
and it is **not a supported configuration**.

Concrete, fixable items:

1. ~~Missing `Array.prototype.includes` polyfill (the real defect).~~ **FIXED in `1.3.1`** — polyfilled at the top of `frontend/js/index.js`.
2. `disableBackHistoryAPI` ignored on 3.0 (possible double Back handling).
3. Missing `requiredACG` (open decision, not `[]`).
4. The app's own rendering and native `<video>` playback on Chromium 38 cannot be verified from the repository.
5. Deferred security debt (session token in `localStorage`) — see the canonical note in [architecture](architecture.md#security-debt-deferred).

The only way to close the question is an **on-device test on the actual webOS 3.0 TV**.

## When to use

- Before/after any change to `frontend/`, `services/`, or the target webOS version.
- When triaging "the app crashes / is blank / Back behaves oddly / playback fails on the old TV".

## When not to use

- Understanding the app's design: see [architecture](architecture.md).
- Building or publishing an IPK: see [hbc-distribution-plan](hbc-distribution-plan.md) and the
  [release protocol](../protocols/release-protocol.md).

## Examples

**APPLIED in `1.3.1`** at the top of `frontend/js/index.js`; the divergence is recorded in the
[divergence log](upstream-provenance.md#divergence-log) (`#12`):

```js
// Placed at the very top of frontend/js/index.js, before the webOS.deviceInfo(...) call
if (!Array.prototype.includes) {
    Array.prototype.includes = function (search, start) {
        'use strict';
        if (start === undefined) { start = 0; }
        return this.indexOf(search, start) !== -1;
    };
}
```

On-device test checklist for the target webOS 3.0 TV:

- [ ] App launches from the home screen / launcher.
- [ ] Server picker renders; U2/D-pad moves focus between field, checkbox and Connect.
- [ ] LAN auto-discovery lists the server (bundled service runs).
- [ ] Connect reaches `System/Info/Public`.
- [ ] Login view accepts credentials and reaches the Views screen.
- [ ] D-pad moves focus **within the active view** (Up/Down only).
- [ ] Back pops the in-app view stack **once**; a Back at the picker exits the app.
- [ ] Posters load (image URLs carry `ApiKey`).
- [ ] Playback starts, OK/Space pauses/resumes, Back stops and returns to the item detail.
- [ ] `webOS.deviceInfo` resolves — the `Array.prototype.includes` `TypeError` is expected to be gone after `1.3.1` (check the console).

## Common mistakes

### Treating `repo.webosbrew.org` `>=5.0` as a Jellyfin requirement

That figure is generated by Homebrew Channel tooling, not declared by Jellyfin. The app declares no
minimum webOS version.

### Assuming `disableBackHistoryAPI` works on webOS 3.0

It is a post-3.0 property and is ignored there. Back handling is shared with the platform history
API.

### Adding `"requiredACG": []`

The empty array is only correct for apps that call no Luna API. This app calls Luna; the correct
group set is an open decision.

### Assuming ES5-clean JavaScript guarantees playback

The app can be ES5-clean and still fail if the TV's `<video>` cannot decode the container or codec
(the app direct-streams and performs **no** transcoding). Compatibility is about both syntax and
codecs.

### Treating the stored session token as audited

`michelly_sessions` holds a real access token in `localStorage`. That is a known, deliberate
trade-off — not a hardened design. See
[architecture.md → Security debt (deferred)](architecture.md#security-debt-deferred).

### Fixing an upstream file silently

Any compatibility fix to `frontend/js/index.js` or `frontend/webOSTVjs-1.2.11/webOSTV.js` is a
divergence and must be logged in [upstream-provenance](upstream-provenance.md#divergence-log).

## References

- [Architecture](architecture.md) — the shipped frontend and the Luna endpoints.
- [Upstream provenance](upstream-provenance.md) — verbatim-import policy and divergence log.
- [HBC distribution plan](hbc-distribution-plan.md) — packaging warnings (`requiredACG`).
- LG official webOS TV platform documentation (webOS 3.x = Chromium 38; 4.x = 53; 5.x = 68;
  6.x = 79).
- jellyfin-web `browserslist`, `.escheckrc` and `CONTRIBUTING.md` (ES5 target, legacy-browser
  support policy).
- jellyfin-web PR #14 — webOS 3 scrolling fix.
- Jellyfin blog (2022) — webOS 3.x support intent.
- `repo.webosbrew.org` tooling — auto-derived `webosRelease` heuristic (not a Jellyfin requirement).
- Upstream repository: <https://github.com/jellyfin/jellyfin-webos>
- [Project entry point](../project.md)
