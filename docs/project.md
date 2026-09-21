---
last_updated: 2026-09-20
status: active
description: Agent-facing entry point for MiChelly, the Jellyfin webOS client fork — stack, slices, commands, conventions, domain entities and the context index.
tags: [entry-point, project, webos, jellyfin, fork, client]
version: 2.6
doc_language: english
---

# MiChelly — Jellyfin for webOS (personal fork)

## Overview

This repository is **MiChelly**, a **standalone Jellyfin client for webOS**
(`com.daverui.michelly`, version `1.3.2`). It began as a
**verbatim import of [`jellyfin/jellyfin-webos`](https://github.com/jellyfin/jellyfin-webos)**
(v1.2.2, upstream commit `ab4794046467cdb88212ccc29212300cf9112a43`), forked for a personal
**webOS 3.0** TV, and was rebranded to its own identity in version `1.3.0` (app id, service id,
metadata and artwork). See [upstream-provenance](context/upstream-provenance.md) and
[webos-3-compatibility](context/webos-3-compatibility.md).

The app is a **self-contained Jellyfin client** — it renders its own UI and plays media itself; it is
not a wrapper around server-served jellyfin-web:

1. `frontend/` shows a server picker and auto-discovers Jellyfin servers on the LAN via a bundled
   Luna service.
2. On connect it reads `GET {baseurl}/System/Info/Public`, then reuses a saved per-server session or
   shows a login view, and talks to the **Jellyfin REST API directly** (ES5 `XMLHttpRequest`).
3. It browses libraries and items, and plays media in a native `<video>` from a direct-stream URL —
   transcoding is a non-goal.

The app owns the picker, discovery, auth/session, catalog browsing, playback, D-pad/Back handling and
the device profile. Native-shell duties (device info, app identity, exit) live in
`frontend/js/app/platform.js`.

> This is a **standalone Jellyfin client**: it federates no other app, service or media server, and
> none is planned.

## Technology Stack

| Layer | Choice |
| --- | --- |
| Webview app | Vanilla ES5 JavaScript, no framework, no build step; a single-page app of views (`frontend/index.html`, `frontend/js/`) |
| REST client / auth | `frontend/js/app/api.js` (ES5 XHR Jellyfin REST client, `Authorization: MediaBrowser …` header) + `frontend/js/app/auth.js` (per-server session in `michelly_sessions`) |
| Bundled service | webOS Luna JS service `com.daverui.michelly.service` (`services/service.js`), Node `dgram` UDP discovery |
| Packaging | `ares-package` via `npm run package` (devDependency `@webosose/ares-cli` ^2.4.0) |
| Tooling | Node CommonJS scripts under `tools/` (`gen-repo.js`, `gen-manifest.js`, `sync-version.js`) |
| Platform bundle | `frontend/webOSTVjs-1.2.11/` (`webOSTV.js`, `webOSTV-dev.js`, Apache-2.0) |
| Storage | Browser `localStorage` (keys `_deviceId2`, `connected_servers`, `michelly_sessions`) |
| Styling | Hand-written CSS, flexbox only (no CSS grid), no preprocessor or build step (`frontend/css/`) |
| Upstream | Imported from `jellyfin/jellyfin-webos` v1.2.2; rebranded in `1.3.0` (see [divergence log](context/upstream-provenance.md#divergence-log)) |
| Distribution | Custom Homebrew Channel (HBC) repository — IPK plus manifest |
| License | MPL-2.0, with incorporated Apache-2.0 parts |

**Architecture pattern:** self-contained native client (app-shell views + ES5 REST client + native
`<video>`) with a bundled non-elevated Luna discovery service. The webview owns the picker, auth,
catalog and playback; the bundled service owns the only path that needs raw sockets (UDP discovery).

**Secrets posture:** no credentials are ever committed. The app stores server URLs, a generated device
id, an auto-connect flag and a per-server Jellyfin **access token** in `localStorage`
(`michelly_sessions`) on the TV; the **password is never stored**. Storing the token is an accepted,
deliberate trade-off for a LAN-only personal client — hardening (encryption, refresh, revocation UI,
logout) is deferred. See the canonical
[security-debt note](context/architecture.md#security-debt-deferred).

## Slices

| Slice | Description | Keywords | Entry points | Primary agents |
| --- | --- | --- | --- | --- |
| `frontend` | The self-contained webOS Jellyfin client: server picker, UDP auto-discovery subscription, ES5 Jellyfin REST client, per-server auth/session, catalog browsing, native `<video>` playback, D-pad/Back handling | webview, views, jellyfin-rest-api, es5, auth, session, playback, catalog, d-pad, discovery | `frontend/`, `frontend/js/`, `frontend/js/app/`, `frontend/css/app.css` | coder, tester, reviewer |
| `service` | The bundled non-elevated Luna discovery service (`com.daverui.michelly.service`, UDP 7359 broadcast) | luna, service, discovery, udp, dgram, 7359, subscription | `services/` | coder, reviewer |
| `packaging` | IPK build, version sync, manifest generation and HBC repository-document generation | ares-package, ipk, gen-manifest, gen-repo, sync-version, sha256, version bump | `package.json`, `tools/`, `frontend/appinfo.json` | coder, tester, documenter |
| `compat` | webOS 3.0 / Chromium 38 compatibility work | webos-3, chromium-38, es5, polyfill, legacy, compatibility | `docs/context/webos-3-compatibility.md` | explorer, architect, documenter |
| `docs` | This documentation corpus | frontmatter, context, protocol, adr | `docs/` | documenter, explorer |

## Commands

Working directory is the repository root for every command. Everything runs through npm scripts
defined in `package.json`; the Docker wrapper (`./dev.sh`) runs the same `ares-*` binaries.

| Task | Command |
| --- | --- |
| Install the webOS toolkit | `npm install` (devDependency `@webosose/ares-cli` ^2.4.0) |
| Validate the package | `npm run check` → `ares-package --check` |
| Build the IPK | `npm run package` → `ares-package --no-minify --outdir build/ services frontend` → `build/com.daverui.michelly_1.3.2_all.ipk` |
| Generate the HBC manifest | `npm run manifest` → `node tools/gen-manifest.js build/com.daverui.michelly.manifest.json` |
| Generate the HBC repository document | `npm run repo` → `node tools/gen-repo.js` → `build/repo.json` (`{"packages":[...]}`, HTTPS URLs + `ipkHash.sha256`) |
| Sync the version | `npm run version` → `node tools/sync-version.js && git add frontend/appinfo.json` |
| Remove build output | `npm run clean` → `rm -rf build/` |
| Install on a TV | `npm run deploy` → `ares-install build/com.daverui.michelly_${version}_all.ipk` |
| Launch on a TV | `npm run launch` → `ares-launch com.daverui.michelly` |
| Same, via Docker | `./dev.sh ares-package --no-minify services frontend`, `./dev.sh ares-install …`, `./dev.sh ares-launch com.daverui.michelly` |

**Verified in this environment (2026-09-20):** `ares-package --check` → `no problems detected`;
`ares-package --no-minify --outdir build/ services frontend` → `Success`, producing a 117064-byte
`build/com.daverui.michelly_1.3.2_all.ipk`. The toolchain present was `ares-package` 3.2.6
(`@webos-tools/cli`) on Node v26.8.2. Upstream CI (`.github/workflows/build.yml`) uses Node 14.x and
installs `@webosose/ares-cli` globally — note the Node-version difference. There is no automated
test suite (`npm test` is a stub).

## Repository Structure

```
webos-hub/
├── frontend/                      # the web app (packaged as the app root)
│   ├── appinfo.json               # id com.daverui.michelly, v1.3.2, type web, disableBackHistoryAPI true
│   ├── index.html                 # app shell: picker/login/browse/item/player views; loads webOSTV.js, webOSTV-dev.js, js/ajax.js, js/storage.js, js/app/*.js, js/index.js
│   ├── js/index.js                # server picker, auto-discovery, connect flow, visible-only D-pad + in-app back stack
│   ├── js/ajax.js                 # XMLHttpRequest wrapper
│   ├── js/storage.js              # localStorage wrapper
│   ├── js/app/platform.js         # device/app identity, device profile, screen, exit
│   ├── js/app/api.js              # ES5 XHR Jellyfin REST client (Authorization: MediaBrowser …)
│   ├── js/app/auth.js             # per-server session store (michelly_sessions)
│   ├── js/app/ui.js               # view switcher, back stack, state renderers
│   ├── js/app/catalog.js          # Views -> items -> detail -> episodes, Resume, paging
│   ├── js/app/player.js           # PlaybackInfo -> direct-stream <video>
│   ├── css/main.css, css/app.css
│   ├── assets/*.png               # banner-dark, icon-80, icon-130, icon-transparent80/130, splash
│   ├── submission-icon.png, .project
│   └── webOSTVjs-1.2.11/          # webOSTV.js + webOSTV-dev.js + LICENSE-2.0.txt
├── services/                      # bundled Luna JS service com.daverui.michelly.service (UDP discovery)
│   └── services.json, package.json, service.js
├── tools/
│   ├── gen-repo.js                # writes build/repo.json ({"packages":[...]}, HTTPS URLs + IPK sha256)
│   ├── gen-manifest.js            # writes a HBC-style manifest with the IPK's sha256
│   └── sync-version.js            # copies package.json version into frontend/appinfo.json
├── .github/workflows/build.yml, .github/workflows/codeql-analysis.yml
├── dev.sh                         # Docker wrapper around ares-* (ghcr.io/oddstr13/docker-tizen-webos-sdk)
├── package.json                   # name com.daverui.michelly, version 1.3.2, license MPL-2.0
├── package-lock.json, LICENSE (MPL-2.0), CONTRIBUTORS.md, renovate.json, .editorconfig, .gitignore
└── docs/                          # this corpus
```

The pre-fork repository is preserved on branch `backup/pre-jellyfin-fork` (commit `efc4b31`); it is
not part of the current app. See [upstream-provenance](context/upstream-provenance.md).

## Key Conventions

- **Upstream import + recorded divergences.** Upstream files were imported byte-identical at the same
  relative path; the rebrand is the first set of intentional changes to them. Any change to an upstream
  file must be recorded in the divergence log of
  [upstream-provenance](context/upstream-provenance.md) before it lands.
- **Docs are lowercase kebab-case** (`webos-3-compatibility.md`, `context/`, `protocols/`); the one
  exemption is the root `README.md`.
- **Two frontmatter contracts, never mixed:** context-doc (`last_updated`, `status`, `description`,
  `tags`, `version`, optional `related`) and note (`id`, `category`, `tags`, `aliases`, `related`,
  `version`, `status`).
- **`doc_language: english`** — documentation is written in English.
- **No build step for the app.** `frontend/` is packaged as-is; there is no bundler or transpile step.
  The shipped frontend must stay ES5-friendly for old webOS engines — see
  [webos-3-compatibility](context/webos-3-compatibility.md).
- **Never run a bare `ares-package .`** — it would pack `.git/`, `build/` and `docs/` into the IPK.
  Always use `npm run package`, which names `services frontend` explicitly.
- **Version is single-sourced.** Bump `version` in `package.json` and run `npm run version` to copy it
  into `frontend/appinfo.json`. HBC compares version strings by equality — a repeated version
  produces a permanent phantom update. See
  [hbc-distribution-plan](context/hbc-distribution-plan.md).
- **`frontend/appinfo.json` caveats for webOS 3.0.** `disableBackHistoryAPI` is a post-3.0 property
  (ignored on 3.0) and `requiredACG` is absent. Both are open compatibility decisions — see
  [webos-3-compatibility](context/webos-3-compatibility.md).
- **D-pad handling lives in the app.** Up/Down (38/40) move focus linearly through **visible**
  tabbable elements (elements inside hidden views are skipped); Left/Right (37/39) are no-ops; Back
  (461) pops one in-app back-stack handler, and only calls `webOS.platformBack()` when the stack is
  empty.

## Domain Entities

| Entity | Definition |
| --- | --- |
| Jellyfin webOS client | The webOS web app `com.daverui.michelly` (`MiChelly`, `frontend/appinfo.json`), installed on the TV. |
| Bundled service | The non-elevated Luna JS service `com.daverui.michelly.service` shipped inside the same IPK. |
| Jellyfin REST API | The server's HTTP API (`/System/Info/Public`, `/Users/AuthenticateByName`, `/Users/{id}/Views`, `/Items`, `/Videos/{id}/stream`, …) the app calls directly via `frontend/js/app/api.js`. |
| `michelly_sessions` | The `localStorage` map of per-server auth sessions `{userId, accessToken, userName}`, keyed by server id. |
| `window.Michelly` | The app's shared JS namespace (`platform`, `api`, `auth`, `ui`, `catalog`, `player`) built by `frontend/js/app/*`. |
| `connected_servers` | The `localStorage` LRU map (max 4) of servers: `{baseurl, Address, auto_connect, id, Name}`. |
| `_deviceId2` | The generated device id, built jellyfin-web style from `navigator.userAgent` plus a timestamp. |
| IPK | The architecture-independent package `build/com.daverui.michelly_1.3.2_all.ipk`. |
| HBC repository | An HTTPS-served `{"packages":[...]}` document (conventionally `repo.json`) consumed by Homebrew Channel; this fork's is `https://daver-ui.github.io/webos-hub/repo.json`. |
| Package manifest | The `manifest` object embedded in a repository package entry: `type`, `ipkUrl`, `ipkHash`, … |

## Context Index

- [`context/architecture.md`](context/architecture.md) — the app shell and views, the ES5 Jellyfin
  REST client, auth/session (`michelly_sessions`), catalog browsing, native playback and the bundled
  Luna service.
- [`context/webos-3-compatibility.md`](context/webos-3-compatibility.md) — webOS 3.0 / Chromium 38
  compatibility report: what is safe, the concrete defects and the on-device test plan.
- [`context/upstream-provenance.md`](context/upstream-provenance.md) — fork origin, licensing, the
  verbatim-import policy, upstream sync and the divergence log.
- [`context/hbc-distribution-plan.md`](context/hbc-distribution-plan.md) — approved custom Homebrew
  Channel repository distribution plan; live at `https://daver-ui.github.io/webos-hub/repo.json`.
- [`context/context-index.md`](context/context-index.md) — the hub for the `docs/context/` folder.
- [`protocols/release-protocol.md`](protocols/release-protocol.md) — the hand-run release checklist.

## Common Lookups

| Symptom | Where |
| --- | --- |
| `"The TV cannot discover my Jellyfin server"` | [architecture.md#solution](context/architecture.md#solution) |
| `"Homebrew Channel shows an Update that never goes away"` | [hbc-distribution-plan.md#common-mistakes](context/hbc-distribution-plan.md#common-mistakes) |
| `"HBC update fails after downloading the whole package"` | [hbc-distribution-plan.md#common-mistakes](context/hbc-distribution-plan.md#common-mistakes) |
| `"App misbehaves on webOS 3.0 / old Chromium"` | [webos-3-compatibility.md](context/webos-3-compatibility.md) |
| `"Is a compatibility fix a divergence from upstream?"` | [upstream-provenance.md#divergence-log](context/upstream-provenance.md#divergence-log) |
| `"appinfo.json version is out of sync with package.json"` | [release-protocol.md](protocols/release-protocol.md) |
| `"`ares-package` packs .git into the IPK"` | [release-protocol.md#common-mistakes](protocols/release-protocol.md#common-mistakes) |
| `"A newly discovered server is not saved"` | [architecture.md#common-mistakes](context/architecture.md#common-mistakes) |
| `"The app stores an access token on the TV — is that safe?"` | [architecture.md#security-debt-deferred](context/architecture.md#security-debt-deferred) |
