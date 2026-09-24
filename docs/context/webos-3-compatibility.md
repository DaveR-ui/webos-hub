---
last_updated: 2026-09-23
status: active
description: webOS 3.0 / Chromium 38 compatibility report for the MiChelly media client — what is safe in the shipped ES5 app and thin loader, the concrete defects, the deferred security debt and the on-device test needed to close the question.
tags: [webos-3, chromium-38, es5, polyfill, compatibility, legacy, thin-loader, sha256, array-includes, disablebackhistoryapi, requiredacg, security-debt, playlist, search, browse-dimensions, audio-progress]
version: 2.7
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
| `fetch`, `Promise`, `crypto.subtle`, ESM, Service Worker | Not used anywhere — the thin loader hashes with a synchronous pure-JS SHA-256 and fetches with `XMLHttpRequest` (see [Thin loader on Chromium 38](#thin-loader-on-chromium-38)). |
| `String.prototype.includes` | Polyfilled at the top of `frontend/js/index.js` (String polyfill lines 21–31; the `Array.prototype.includes` polyfill is at lines 9–15). Covers the `String.prototype.includes` use inside `webOSTV.js`. |
| `Array.prototype.includes` | **Polyfilled at the top of `frontend/js/index.js`** (ES5, installed before the `webOS.deviceInfo(...)` call). Covers the `webOSTV.js` `getSystemInfo` `missingConfigs` path. |
| CSS | `frontend/css/app.css` and `frontend/css/main.css` are **flexbox-only** with `-webkit-` prefixes. **No CSS grid** (Chrome 57+) is used anywhere. |
| Inline music search (`<input>`) | A real `<input type="text">` + Search `<button>` in the music topbar (`catalog.js:3126-3155`), built with `document.createElement` and DOM0 `onkeydown`/`onclick`. Native form control on Chromium 38; the `placeholder` attribute is supported (Chrome 4+). No new engine feature. |
| Audio progress bar (`.audio-progress`) | Plain `<div>`s whose `#audioProgressFill` width is set as a `%` string (`audio.js:243`, `610-614`), driven by the same `timeupdate`/`loadedmetadata` listeners as `#audioTime`. No `<progress>` element and no new engine feature; **display-only** (Left/Right are D-pad no-ops, so there is no scrub). |
| Playlist editor controls | `#playlistsView` create/rename text editor, Move up/down, Disable/Enable and Delete controls (`catalog.js:1850-2068`) are `document.createElement`'d `<button>`s / `<input>`s with DOM0 handlers; boundary buttons dim (`is-inert`) and are **never** `disabled`. No new engine feature. |

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
- `<video>` with a direct `/Videos/{id}/stream` source, and `<audio>` with a direct
  `/Audio/{id}/stream` source;
- the artist-centric music views (`#musicView`/`#artistView`) — runtime-built with
  `document.createElement`, flexbox-only, every control a `<button>`; the browse-dimension chips,
  shelves and the **real inline search `<input>`** are all native controls with **no new engine
  feature**;
- the two-column audio now-playing card with its **display-only** `.audio-progress` bar — plain
  `<div>` width percentages, no `<progress>` element, no new engine feature;
- the `#playlistsView` editor (create/rename input, reorder and soft-disable buttons) — runtime-built
  DOM with DOM0 handlers, no new engine feature;
- the thin loader: synchronous pure-JS SHA-256, `XMLHttpRequest` `arraybuffer` fetches and inline
  classic-script injection (no `crypto.subtle`, no `fetch`, no Service Worker);
- flexbox layouts with `-webkit-` prefixes.

The residual risk is therefore **codec/container and `<video>`/`<audio>` playback behaviour on the
TV**, not JavaScript syntax or a third-party UI framework. That can only be confirmed on the device.

### Thin loader on Chromium 38

The thin loader (`frontend/js/loader.js` + `frontend/js/lib/sha256.js`, see
[architecture](architecture.md#thin-loader--remote-bundle)) is written for the same engine floor as the
rest of the app:

| Concern | Choice | Why |
| --- | --- | --- |
| Hashing | Pure-JS **synchronous** SHA-256 | `crypto.subtle` is asynchronous, **secure-context-only** and unreliable on the packaged app's `file://`/null origin under Chromium 38. A few-hundred-KB bundle hashes fast enough synchronously. |
| Transport | `XMLHttpRequest` with `responseType = 'arraybuffer'` | No `fetch` (Chrome 42+), no Promises. |
| Cross-origin fetch | XHR straight to GitHub Pages from the packaged app's **null origin** | GitHub Pages sends `Access-Control-Allow-Origin: *`; the loader depends on that CORS header, since a `file://` page has no usable origin. |
| Text decode | `TextDecoder` **feature-detected**, with a manual `Uint8Array` → `String.fromCharCode` chunk fallback | `TextDecoder` is present in Chromium 38 but is guarded so an absent/limited implementation cannot break the boot. |
| Activation | Inline **classic** `<script>.textContent` + one `<style>` | No `fetch`/ESM/`import`/Service Worker on Chromium 38; a classic inline script is the injection mechanism that is guaranteed to work. |
| Boot guard | `window.onerror` + one `sessionStorage`-flagged reload | Best-effort rollback to the packaged copies without a Promise chain. |
| Bundle generation | `tools/gen-bundle.js` (`npm run bundle`), Node, CI-side | Runs off-device; ships no new engine requirement to the TV. |

The remote payload is decoded and executed as **text in the app's own origin**, so the boot path is
still the packaged `XMLHttpRequest` + DOM path — no new engine features are needed on the TV.

**On-device checklist (thin loader):**

- [ ] Launch **with network access** → console logs `[michelly-shell] bundle remote <version> active`,
      or `window.MichellyShell.bundleSource === 'remote'`.
- [ ] Launch **offline** (or with the Pages host unreachable) → the console logs the fallback and the
      app still works from the packaged copies (`window.MichellyShell.bundleSource === 'packaged'`).
- [ ] A **bad hash / invalid manifest** falls back to the packaged build instead of running bytes that
      failed verification (temporarily publish a wrong `sha256` and confirm the packaged app boots).

### Audio codec reality on Chromium 38

The audio player direct-streams (no transcode), so an audio item plays only if the **TV's own
Chromium 38 `<audio>` decoder** supports its codec:

| Codec / container | Chromium 38 `<audio>` | Notes |
| --- | --- | --- |
| MP3 | **Safe** | Universally supported. |
| WAV (PCM) | **Safe** | Uncompressed — large over the LAN. |
| Ogg Vorbis | **Safe** | |
| AAC / M4A | Conditional | Depends on the TV's licensed codecs; not guaranteed. |
| FLAC | **Unsupported** | Native `<audio>` FLAC landed in Chrome 56; a flac item will fail to play. |

An unsupported codec no longer fails silently: both players surface `MEDIA_ERR_SRC_NOT_SUPPORTED`
(`error.code === 4`) as a codec-aware message in `#itemError` (e.g. `This item's audio codec (FLAC) is
not supported by the TV, or the stream could not be loaded.`) — code 4 also covers a failed stream
request (401/404/5xx), so the wording does not over-assert the codec. The on-device check below records
the failure instead of showing a blank screen. The audio stream URL's `audioCodec` fallback now resolves
the first audio stream via `MediaStream.Type === 'Audio'` (the REST API serialises the enum as a string;
the old `=== 0` test never matched).

The server-side `DirectPlayProfiles` should be narrowed to the safe codecs so the server does not
offer unplayable sources — that is **deferred** (A5, pending device logs) and is **not** part of this
change. The same applies to the reported **video black-screen** defect, which is likewise **deferred /
pending device logs** and must not be assumed fixed.

### Security debt (deferred)

The native client stores a real **access token** in `localStorage` (`michelly_sessions`) instead of
storing no credentials, as the old iframe wrapper did. It may also persist a **plaintext default
credential** in `michelly_default_user` for automatic sign-in. Both are an **accepted, deliberate**
trade-off for a **LAN-only personal client**. Token encryption/refresh, credential hardening, a
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
4. The app's own rendering and native `<video>`/`<audio>` playback on Chromium 38 cannot be verified from the repository; the reported **video black-screen** and the `DirectPlayProfiles` narrowing (A5) remain **deferred / pending device logs**.
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

> **Deployment prerequisite.** All of this work lives in **payload** files (`frontend/js/app/*.js`,
> `css/app.css`); it reaches the TV only after `npm run bundle` + a publish. Tier 1 (modes, queue,
> item-actions menu) is **committed on `master`** (HEAD `0e86bd7`); Tier 2 (browse dimensions,
> shelves, functional search), Tier 3 (dynamic named playlists) and the audio visual identity
> (two-column card + progress bar) are **uncommitted** in the working tree and were validated
> **statically only** (`npm run check`, reviewer, tester gates) — **not run on a device/emulator**.
> Verify the deployed bundle version (`window.MichellyShell`) before judging any item below.

- [ ] App launches from the home screen / launcher.
- [ ] Server picker renders; U2/D-pad moves focus between field, checkbox and Connect.
- [ ] LAN auto-discovery lists the server (bundled service runs).
- [ ] Connect reaches `System/Info/Public`.
- [ ] Login view accepts credentials and reaches the Views screen.
- [ ] D-pad moves focus **within the active view** (Up/Down only).
- [ ] Back pops the in-app view stack **once**; a Back at the picker exits the app.
- [ ] Posters load (image URLs carry `ApiKey`).
- [ ] Video playback shows the on-screen controls (`#playerControls`): Play/Pause button, `m:ss / m:ss`
      readout and progress bar — **always visible** while `#playerView` is active (no auto-hide).
- [ ] D-pad Up/Down reaches `#playerToggle` (focus ring visible); OK/Space toggles playback **exactly
      once** (the button's own `onkeydown` toggles and suppresses the synthetic click; it must not
      double-toggle to a no-op, and must work even if the remote's OK produces no click); Back stops and
      returns to the item detail.
- [ ] Playback starts, OK/Space pauses/resumes, Back stops and returns to the item detail.
- [ ] Ordered list playback: open an album / season / folder / Continue Watching, press **Play** →
      the item starts and playback auto-advances to the **next** item when it ends.
- [ ] D-pad Up/Down reaches **Prev**/**Next** in the player overlay (`#playerPrev`/`#playerNext`) and
      the audio card (`#audioPrev`/`#audioNext`); OK on either moves the list; at the first/last item
      the control stays focusable but is **dimmed** (`is-inert`) and does nothing — it is never
      `disabled`, and focus must not appear stuck.
- [ ] Playback of the **last** item ends the session and returns to `#itemView` **with modes at
      default** (repeat off, shuffle off).
- [ ] Repeat **All** wraps at the pass end into a fresh pass; **Next** stays bright (not dimmed) at
      the last item because the wrap is a real action.
- [ ] Repeat **One** replays the current track on auto-advance only; a manual **Next** still
      advances; while repeat-one is on the queue is **not** consumed (starved queue — documented
      limitation).
- [ ] Shuffle plays only not-yet-heard tracks of the pass (already-heard ones rejoin at the wrap);
      toggling it **Off** resumes natural order at the current track followed by the pass's
      ascending not-yet-played remainder — never replays a heard track, never strands an unheard
      one; the Prev-then-Next walk-back is unchanged.
- [ ] Shuffle **On → Off after a wrap**: the wrap reset the visited set, so pass-1-heard tracks
      are eligible again — the pass-2 Off rebuild must not strand them.
- [ ] With the queue overlay open, an auto-advance folds it (its back handler pops on the card
      rebuild) and the next **single** Back reaches the session — never a dead press; teardown order
      stays LIFO (overlay entry pops before the session entry).
- [ ] Pre-session queue: the **More** menu's 'Play next'/'Add to queue' fill the pending queue, and
      it is adopted **only** by the next all-audio session start — a video/mixed list must **not**
      adopt it, a server switch clears it, and a session end leaves it intact.
- [ ] The **More** menu (actions step / slot-picker step) owns exactly **one** back handler — one
      Back closes it from either step; a **Play** press closes an open menu first.
- [ ] A **single item** with no list context still plays exactly as before: every session-scoped
      control (Prev/Next, Repeat, Shuffle, Queue) is hidden and Back behaves normally.
- [ ] Back during a list session stops playback and returns to `#itemView` on **one** press (the
      playlist owns a single back entry); a subsequent Back leaves the item view as before.
- [ ] A list item whose stream errors **ends the list** after the failed item (it must not
      auto-advance into a broken loop); the error stays visible in `#itemError`.
- [ ] A **mixed Audio/Video** list plays each item with its own player and still uses exactly one back
      entry per session.
- [ ] Audio item **Play** opens `#audioView` and shows the now-playing card (poster/title/artist/album).
- [ ] Audio playback starts for an MP3/WAV/Ogg item; OK/Space toggles play/pause, Back stops and returns to item detail.
- [ ] A FLAC item is expected to **fail** on Chromium 38 (native `<audio>` FLAC is Chrome 56+) — record the error text.
- [ ] An unsupported codec surfaces a **codec-aware** message in `#itemError` (e.g.
      `This item's audio codec (FLAC) is not supported by the TV, or the stream could not be loaded.`
      for audio, or the video equivalent on `MEDIA_ERR_SRC_NOT_SUPPORTED`) instead of failing silently
      or leaving a blank screen.
- [ ] Music home: the search field is a **real, focusable `<input>`**; Up/Down reaches it and the
      Search button; a term returns results that replace the content area, and **Clear search**
      restores the artist grid; Enter inside the field submits (Tier 2, uncommitted).
- [ ] Music home: the **Genres / Albums / Songs** chips fetch and render their dimension grids;
      selecting a genre drills into its songs and Back returns to the Genres list; a failed fetch
      offers **Retry** (Tier 2, uncommitted).
- [ ] Music home: the **Recently added** and **Most played** shelves render when the server returns
      items and each is hidden when empty (Tier 2, uncommitted).
- [ ] Audio now-playing card is **two-column** (album art + info/controls column) and the
      `.audio-progress` bar advances with `timeupdate`/`loadedmetadata`; it is **display-only**
      (Left/Right do nothing) (audio visual identity, uncommitted).
- [ ] `#playlistsView`: **New playlist** creates one, **Rename** edits the name, **Delete** arms an
      inline Yes/No confirm; the detail offers **Move up/down** (reorder), **Disable/Enable** (Play
      skips disabled tracks) and **Remove**; hardware Back returns to the playlist list on one press
      (Tier 3, uncommitted).
- [ ] A server with **no legacy 3-slot record** shows an **empty playlist list** with a New playlist
      button instead of three empty `Playlist 1/2/3` slots (behaviour change — confirm it is intended).
- [ ] `webOS.deviceInfo` resolves — the `Array.prototype.includes` `TypeError` is expected to be gone after `1.3.1` (check the console).
- [ ] Thin loader: online / offline / bad-hash checks — see the dedicated checklist in
      [Thin loader on Chromium 38](#thin-loader-on-chromium-38).

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

### Assuming `crypto.subtle` or `fetch` can verify the remote bundle

Neither is safe on Chromium 38: `crypto.subtle` is asynchronous and secure-context-only (the packaged app runs from `file://`/null origin), and `fetch` is Chrome 42+. The loader therefore hashes with synchronous pure-JS SHA-256 and downloads with `XMLHttpRequest`. Do not "modernize" it back to the WebCrypto/`fetch` APIs.

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
