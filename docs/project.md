---
last_updated: 2026-09-20
status: active
description: Agent-facing entry point for WebOS Hub — stack, slices, commands, conventions and the context index.
tags: [entry-point, project, webos, jellyfin, sunshine]
version: 1.0
doc_language: english
---

# WebOS Hub

## Overview

WebOS Hub (`com.admin.weboshub`) is a webOS TV app that puts one D-pad home screen over two
self-hosted services and two already-installed TV apps:

- **Jellyfin** (`org.jellyfin.webos`) — Continue Watching, libraries and posters are read from the
  Jellyfin REST API and rendered by the hub; launching the app opens Jellyfin itself.
- **Sunshine** (`com.limelight.webos` / Moonlight) — the hub lists Sunshine's apps and launches
  Moonlight to stream them.

It is an **aggregator launcher, not a media player**. It does not decode, transcode or proxy
Jellyfin media: Jellyfin is CORS-permissive, so the webview fetches its API directly. Sunshine has
no CORS, so those calls go through a bundled, non-elevated Luna service (see
[architecture](context/architecture.md)).

## Technology Stack

| Layer | Choice |
| --- | --- |
| Webview app | Vanilla JavaScript, ES5-style IIFEs, no framework, no build step (`index.html`, `js/`, `css/`) |
| Tooling | Node **ESM** scripts under `tools/*.mjs` |
| Bundled service | webOS Luna JS service in `services/service.js`, using `webos-service` and Node `http`/`https` |
| Packaging | `ares-package` (ares-cli 3.2.6), invoked only through `tools/build.mjs` |
| Platform bundle | `webOSTVjs-1.2.13/` — the production `webOSTV.js` only (the unused dev bundle was removed) |
| Storage | Browser `localStorage` (key `webosHub.settings.v1`) |

**Secrets posture:** no credentials are ever committed. Credentials exist only in the TV's
`localStorage` and, for the smoke test, in environment variables. Source contains default URLs only.

**Architecture pattern:** webview SPA + restricted Luna proxy service. The webview owns the UI and
the Jellyfin calls; the bundled service owns the only path that needs to bypass browser origin rules
(Sunshine).

## Slices

| Slice | Description | Keywords | Entry points | Primary agents |
| --- | --- | --- | --- | --- |
| `app` | TV webview UI: home rows, D-pad spatial navigation, settings screen | d-pad, focus, jellyfin, sunshine, settings, localStorage, poster, resume | `index.html`, `js/`, `css/` | coder, tester, reviewer |
| `service` | Bundled non-elevated Luna HTTP proxy with an origin/path allow-list | luna, proxy, allow-list, cors, allowlist, acg, http, rejectUnauthorized | `services/`, `js/sunshine.js` | coder, reviewer |
| `packaging` | IPK build, HBC repository distribution and release flow | ipk, ares-package, build, sha256, ipkHash, version bump, repo.json, hbc, homebrew | `tools/`, `appinfo.json`, `docs/protocols/release-protocol.md` | coder, tester, documenter |
| `docs` | This documentation corpus | frontmatter, hub, plan, protocol, context, adr | `docs/`, `docs/context/`, `docs/protocols/` | documenter, explorer |

## Commands

Working directory is the repository root for every command.

| Task | Command | Output |
| --- | --- | --- |
| Build the IPK | `node tools/build.mjs` | `build/com.admin.weboshub_1.0.0_all.ipk` |
| npm alias for the build | `npm run build` | same as above |
| Syntax-check JS + tooling | `npm run check` | `syntax OK` |
| Live end-to-end smoke test | `JELLYFIN_USER=… JELLYFIN_PASS=… SUNSHINE_USER=… SUNSHINE_PASS=… node tools/smoke-test.mjs` | PASS/FAIL summary |
| npm alias for the smoke test | `npm run smoke` | same as above |

The smoke test's URLs are overridable with `JELLYFIN_URL` and `SUNSHINE_URL`; it exits non-zero on
any failure.

## Repository Structure

```
webos-hub/
├── appinfo.json          # web app manifest (id, version 1.0.0, type web, requiredACG)
├── index.html            # single-page app shell; loads webOSTVjs-1.2.13/webOSTV.js
├── icon.png · largeIcon.png   # app icons referenced by appinfo.json
├── css/style.css         # dark TV theme and the focus ring
├── js/                   # webview SPA, no build step
│   ├── config.js         # settings module (localStorage key webosHub.settings.v1)
│   ├── focus.js          # D-pad spatial navigation (37/38/39/40, 13, 461/10009)
│   ├── jellyfin.js       # Jellyfin REST client (direct fetch — CORS-permissive)
│   ├── sunshine.js       # Sunshine client (through the bundled Luna service)
│   ├── launcher.js       # applicationmanager `launch` wrapper
│   └── app.js            # bootstrap, Home ⇄ Settings, rendering
├── services/             # bundled non-elevated Luna service (com.admin.weboshub.service)
│   ├── services.json     # service registration
│   ├── package.json      # main: service.js
│   └── service.js        # `http` method: allow-listed Node http/https proxy
├── tools/
│   ├── build.mjs         # stages shippable files, then runs ares-package
│   └── smoke-test.mjs    # live end-to-end smoke test (Node ESM)
├── webOSTVjs-1.2.13/     # webOS platform JS bundle (required at runtime)
├── package.json          # npm aliases: build, smoke, check
├── build/                # output only, git-ignored: the generated .ipk
└── docs/                 # this documentation corpus
```

## Key Conventions

- **No secrets in the tree.** Only default service URLs are allowed in source; credentials belong
  to `localStorage` or the environment.
- **Docs are lowercase kebab-case** (`hbc-distribution-plan.md`, `context/`, `protocols/`); the one
  exemption is the root `README.md`.
- **Two frontmatter contracts, never mixed:** context-doc (`last_updated`, `status`, `description`,
  `tags`, `version`, optional `related`) and note (`id`, `category`, `tags`, `aliases`, `related`,
  `version`, `status`).
- **`doc_language: english`** — documentation is written in English.
- **The bundled service never opens a socket to a non-allow-listed origin.** Origin and path are
  validated before any connection; loopback and link-local hosts are always rejected.
- **Bump `version` in `appinfo.json` before every release.** HBC compares version strings by
  equality — a repeated version produces a permanent phantom update. See
  [hbc-distribution-plan](context/hbc-distribution-plan.md).
- **Never run a bare `ares-package .`** — it packs `.git/` and `build/` into the IPK. Always use
  `node tools/build.mjs`, which stages only shippable files.

## Domain Entities

| Entity | Definition |
| --- | --- |
| Hub app | The webOS web app `com.admin.weboshub` (`appinfo.json`), installed on the TV. |
| Bundled service | The non-elevated Luna JS service `com.admin.weboshub.service` shipped inside the same IPK. |
| Settings | The single `localStorage` object `webosHub.settings.v1` holding URLs and credentials on the TV. |
| Deep-link | A `launch` request carrying `params` into an installed app; only Moonlight honours them. |
| IPK | The architecture-independent package `com.admin.weboshub_1.0.0_all.ipk` built in `build/`. |
| HBC repository | An HTTPS-served `{"packages":[...]}` document (conventionally `repo.json`) consumed by Homebrew Channel. |
| Package manifest | The `manifest` object embedded in a repository package entry: `type`, `ipkUrl`, `ipkHash`, … |

## Context Index

- [`context/architecture.md`](context/architecture.md) — app and service architecture, request flow,
  proxy security model, settings and ACG.
- [`context/hbc-distribution-plan.md`](context/hbc-distribution-plan.md) — approved custom Homebrew
  Channel repository distribution plan.
- [`context/deep-link-findings.md`](context/deep-link-findings.md) — what deep-linking into Jellyfin
  and Moonlight actually supports, with evidence.
- [`context/context-index.md`](context/context-index.md) — the hub for the `docs/context/` folder.
- [`protocols/release-protocol.md`](protocols/release-protocol.md) — the hand-run release checklist.

## Common Lookups

| Symptom | Where |
| --- | --- |
| `"Homebrew Channel shows an Update that never goes away"` | [hbc-distribution-plan.md#common-mistakes](context/hbc-distribution-plan.md#common-mistakes) |
| `"HBC update fails after downloading the whole package"` | [hbc-distribution-plan.md#common-mistakes](context/hbc-distribution-plan.md#common-mistakes) |
| `"Changing the Sunshine host requires a full release"` | [hbc-distribution-plan.md#common-mistakes](context/hbc-distribution-plan.md#common-mistakes) |
| `"Jellyfin opens on its home instead of the selected item"` | [deep-link-findings.md#solution](context/deep-link-findings.md#solution) |
| `"ares-package packs .git into the IPK"` | [release-protocol.md#common-mistakes](protocols/release-protocol.md#common-mistakes) |
| `"Sunshine row is empty / bundled service required"` | [architecture.md#common-mistakes](context/architecture.md#common-mistakes) |
| `"Moonlight opens on its host picker instead of the selected app"` | [deep-link-findings.md#common-mistakes](context/deep-link-findings.md#common-mistakes) |
