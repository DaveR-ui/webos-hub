---
last_updated: 2026-09-20
status: active
description: webOS 3.0 / Chromium 38 compatibility report for the Jellyfin webOS client fork — what is safe, the concrete defects, and the on-device test needed to close the question.
tags: [webos-3, chromium-38, es5, polyfill, compatibility, legacy, array-includes, disablebackhistoryapi, requiredacg]
version: 1.1
related: [architecture, upstream-provenance, hbc-distribution-plan]
---

# webOS 3.0 Compatibility

## Problem

The target TV runs **webOS 3.0**. The Jellyfin webOS client is a thin shell around the jellyfin-web
that the user's server hosts, so "does this app work on webOS 3.0" is really two questions:

1. Does the **shipped wrapper** (`frontend/`, `services/`) run on the TV's old browser engine?
2. Does the **server-served jellyfin-web** render and play on that engine?

webOS 3.x ships an old Chromium engine and the app declares no minimum OS version, so neither
question is answered by the repository itself. This document records the audit and its verdict.

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
| Arrow functions, `let`, template literals, classes, destructuring/spread, `async`/`await`, `fetch` | **None** in the shipped frontend. |
| `const` | Appears exactly **3×** in `frontend/js/index.js` (lines 60, 63, 66). On Chromium 38 `const` is accepted as a legacy **function-scoped** declaration — not a parse error, but block scoping is degraded. |
| `String.prototype.includes` | Polyfilled at `frontend/js/index.js:25–35`. Covers `data.start_url.includes("/web")` (line 328) and the `String.prototype.includes` use inside `webOSTV.js`. |
| `Array.prototype.includes` | **No polyfill anywhere.** |
| Promises | Deliberately avoided in the wrapper (jellyfin-web's `Promise` usage is server-side). |

> Caveat: the `const` behaviour on Chromium 38 is the one claim that could not be verified against a
> real Chromium 38 binary. Treat it as "degraded block scoping, not a crash", not as a guaranteed
> fact.

### The one real defect for webOS 3.0: `Array.prototype.includes`

The bundled `frontend/webOSTVjs-1.2.11/webOSTV.js` uses **`Array.prototype.includes`** in the
`missingConfigs` check inside the `luna://com.webos.service.tv.systemproperty` `getSystemInfo`
callback.

- `Array.prototype.includes` is **Chrome 47+**; Chromium 38 does not have it.
- The shipped frontend contains **no `Array.prototype.includes` polyfill**.
- On Chromium 38 that path throws `TypeError: t.includes is not a function`, aborting the
  `webOS.deviceInfo` fallback and leaving `deviceInfo` `undefined`.
- It degrades `NativeShell.AppHost.getDeviceProfile` (HDR/Dolby flags become `null`) and `screen`
  (becomes `null`).
- It is reached only when the TV returns a **non-empty `missingConfigs` list**.

This is the highest-value fix candidate for the `compat` slice.

### `disableBackHistoryAPI` is ignored on webOS 3.0

`frontend/appinfo.json` sets `"disableBackHistoryAPI": true`. That property is **post-3.0**, so on
webOS 3.0 it is ignored: the platform keeps managing Back through the HTML history API while
`frontend/js/index.js` also handles keyCode 461 itself. That is a potential **double-handling**
conflict — Back may both navigate history and call `webOS.platformBack()`.

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

### The server-side half: jellyfin-web on Chromium 38

The wrapper hands off to the jellyfin-web the user's server serves. As of jellyfin-web 10.11.x (and
the renamed 12.x/13.x):

- `browserslist` still lists **Chrome 38** (and even Chrome 27).
- The production bundle is still gated to **ES5** via `es-check` (`.escheckrc` → `"ecmaVersion": "es5"`).
- It still ships legacy polyfills (`core-js`, `native-promise-only`, `whatwg-fetch`,
  `abortcontroller-polyfill`, …).
- Its `CONTRIBUTING.md` states the codebase must support "TVs that are stuck on ancient versions of
  browser engines".

**However:**

- Jellyfin's own documentation only *guarantees* the two most recent versions of major browsers.
- jellyfin-web's React 18 / MUI / TanStack Query stack is not formally supported on an engine as old
  as Chromium 38.
- Real-world **rendering and playback on webOS 3.0 is therefore unverified**.

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

1. Missing `Array.prototype.includes` polyfill (the real defect).
2. `disableBackHistoryAPI` ignored on 3.0 (possible double Back handling).
3. Missing `requiredACG` (open decision, not `[]`).
4. jellyfin-web rendering on Chromium 38 cannot be verified from the repository.

The only way to close the question is an **on-device test on the actual webOS 3.0 TV**.

## When to use

- Before/after any change to `frontend/`, `services/`, or the target webOS version.
- When triaging "the app crashes / is blank / Back behaves oddly on the old TV".

## When not to use

- Understanding the wrapper's design: see [architecture](architecture.md).
- Building or publishing an IPK: see [hbc-distribution-plan](hbc-distribution-plan.md) and the
  [release protocol](../protocols/release-protocol.md).

## Examples

Candidate polyfill for the `compat` slice (not yet applied; it modifies an upstream file and must be
recorded in the [divergence log](upstream-provenance.md#divergence-log)):

```js
// Add near the existing String.prototype.includes polyfill in frontend/js/index.js
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
- [ ] Connect reaches `System/Info/Public` and `/web/manifest.json`.
- [ ] jellyfin-web loads inside the iframe and is usable with the remote.
- [ ] Playback starts and audio/video are correct.
- [ ] Back (461) returns to the picker once, without a double action.
- [ ] `webOS.deviceInfo` resolves (check for the `Array.prototype.includes` error in the console).

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

### Assuming the wrapper's ES5 style guarantees jellyfin-web renders

The wrapper and jellyfin-web are separate codebases on separate release trains. The wrapper can be
ES5-clean while jellyfin-web fails on Chromium 38.

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
