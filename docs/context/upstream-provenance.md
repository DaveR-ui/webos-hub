---
last_updated: 2026-09-22
status: active
description: Fork provenance for the Jellyfin webOS client — upstream origin and commit, MPL-2.0/Apache-2.0 licensing, the verbatim-import policy, how to sync with upstream, and the divergence log.
tags: [provenance, fork, upstream, license, mpl-2.0, apache-2.0, sync, divergence, thin-loader]
version: 2.3
related: [architecture, webos-3-compatibility, hbc-distribution-plan]
---

# Upstream Provenance

## Problem

This repository is a **personal fork**. To change it safely we must know exactly which upstream code
it contains, under which licence, what (if anything) has been modified, and how to pull future
upstream releases without silently losing local work. Licensing especially must not be guessed: the
Jellyfin *server* is GPL-2.0, but the webOS *client* is not.

## Solution

### Origin

| Field | Value |
| --- | --- |
| Upstream repository | `https://github.com/jellyfin/jellyfin-webos` |
| Imported commit | `ab4794046467cdb88212ccc29212300cf9112a43` (2025-11-03) |
| Upstream version | `1.2.2` |
| Import mode | Verbatim (see below) |
| Fork purpose | Personal webOS 3.0 TV (see [webos-3-compatibility](webos-3-compatibility.md)) |

### Licensing

- The webOS client is licensed under **MPL-2.0**, with incorporated **Apache-2.0** parts.
- MPL headers are present in `frontend/index.html`, `frontend/js/**/*.js` (including the fork-only
  `frontend/js/app/*.js`), `frontend/css/*.css` and `services/service.js`.
- `frontend/js/ajax.js` and `frontend/js/storage.js` additionally carry a
  "Copyright 2019 Simon J. Hogan — Apache-2.0" notice.
- Upstream images came from `jellyfin-ux` under the same licence; the fork replaced them with a
  generated monogram mark (see the [divergence log](#divergence-log)).
- `LICENSE` and `CONTRIBUTORS.md` are kept **verbatim**.
- **The client is MPL-2.0, not GPL.** The Jellyfin **server** is GPL-2.0; the webOS **client** is not.

### Verbatim-import policy

- Upstream files were imported **byte-identical** at the **same relative path**; the rebrand (version
  `1.3.0`) is the first set of intentional changes to them — see the [divergence log](#divergence-log).
- The only merged file is `.gitignore`: the previous repository's credential-safety patterns
  (`.env`, `.env.*`, `*.local`, `*.log`, editor junk) were added to upstream's `.gitignore`.
- Any change to an upstream file must be recorded in the [divergence log](#divergence-log) — ideally
  in the same commit that introduces it.
- New, fork-only files are welcome under `docs/` (and, if ever needed, in clearly separate paths).

### How to sync with upstream

Add upstream once, then fetch and integrate:

```bash
git remote add upstream https://github.com/jellyfin/jellyfin-webos.git
git fetch upstream
git merge upstream/master        # or: git rebase upstream/master
```

After the merge/rebase:

1. Re-apply the `docs/` tree (it is fork-local and not touched by upstream).
2. Re-apply the `.gitignore` credential patterns if upstream changed `.gitignore`.
3. Re-check the divergence log — any local code change may now conflict.

### Divergence log

Changes to upstream files made by this fork.

| # | File(s) | Change | Reason | Status |
| --- | --- | --- | --- | --- |
| 1 | `package.json` | Add `"repo": "node tools/gen-repo.js"` to `scripts` | Generate the custom HBC repository document (`build/repo.json`) reproducibly — see [hbc-distribution-plan](hbc-distribution-plan.md) | Applied |
| 2 | `frontend/appinfo.json` | Rebrand: `id` → `com.daverui.michelly`, `title` → `MiChelly`, `vendor` → `DaveR-ui`, new `appDescription`, `bgColor`/`iconColor` → `#180C33`, `version` → `1.3.0` | Full re-identification away from the upstream/official id | Applied |
| 3 | `services/services.json`, `services/package.json` | Service `id`/`name`/`description` → `com.daverui.michelly.service` | Match the new identity | Applied |
| 4 | `frontend/js/index.js` | Luna URI → `luna://com.daverui.michelly.service`; `appName` → `MiChelly` | Match the renamed service + rebrand | Applied |
| 5 | `frontend/index.html` | `<title>` → `MiChelly` | Rebrand | Applied |
| 6 | `frontend/.project` | Project name → `com.daverui.michelly` | Rebrand | Applied |
| 7 | `package.json`, `package-lock.json` | Name → `com.daverui.michelly`, version `1.3.0`, description, author, `deploy`/`launch`/`manifest` scripts | Rebrand + new IPK name | Applied |
| 8 | `tools/gen-manifest.js` | `iconUri`/`sourceUrl` → fork host/repo | Stop pointing the standalone manifest at upstream | Applied |
| 9 | `.github/workflows/build.yml` | Manifest path + artifact name | Rebrand | Applied |
| 10 | `README.md` | Heading + command references to the new id/IPK | Rebrand | Applied |
| 11 | `frontend/assets/*.png`, `frontend/submission-icon.png` | Replaced the upstream Jellyfin artwork with a generated "MC" monogram mark | Full rebrand; no Jellyfin artwork reused | Applied |
| 12 | `frontend/js/index.js` | Add an ES5 `Array.prototype.includes` polyfill at the top of the file | webOS 3.0 / Chromium 38 compatibility: `webOSTV.js` uses `Array.prototype.includes` (Chrome 47+) in the `getSystemInfo` `missingConfigs` path, which throws on Chromium 38 and leaves `deviceInfo` undefined | Applied |
| 13 | `frontend/js/index.js` | Fix the server-persistence defects: store the new entry through the keyed `lruStrategy` helper and use the correct `connected_servers` localStorage key (lines 297, 359–367, 392) | Upstream defect: `.unshift()` on a plain object threw, the wrong key `connected_server` was written with an undefined `servers` variable, and the id-changed/failure paths used the wrong key | Applied |
| 14 | `frontend/js/index.js` | Remove the `storage.remove('connected_servers')` call from `handleFailure` | `#13` restored the correct `connected_servers` key, which activated upstream's intent: any single failed request wiped the whole saved-server LRU. `handleFailure` receives only `{error}` — it has no server identity in scope — and a failed connect is usually transient (server off, timeout), so forgetting every server is worse UX than keeping it; the app self-heals on the next successful connect | Applied |
| 15 | `frontend/index.html`, `frontend/js/index.js`, `frontend/css/main.css` | Replace the free-text URL field (`baseurl`) with a fixed `192.168.` prefix plus `#octet3`/`#octet4`/`#port` inputs (defaults `0`/`0`/`8096`); Connect composes `http://192.168.<octet3>.<octet4>:<port>` and normalizes each part to its parsed integer form (a typed `010` connects to `.10`, never to the URL parser's octal `.8`); saved/discovered servers prefill the fields from their stored `baseurl`/`Address`; a server outside `192.168.x.x` — saved or discovered — keeps the defaults, does not auto-connect, and shows an error when its server-list Connect button is used (instead of connecting to a wrong host); a newly saved server stores the full hostname in `Address` instead of a truncated `192.168.` | Personal fork on a `192.168.x.x` LAN — the picker cannot mistype the scheme or host, and no private IP is hardcoded in the public repository. **Known limitation:** a legacy/different-host saved server cannot be represented by the picker (its fields fall back to `0`/`0`/`8096`). **Not tied to a version bump** — it landed after the `1.3.2` release and is not yet part of a published IPK | Applied |
| 16 | `frontend/index.html` | Removed the hidden `#contentFrame` iframe; the picker markup is now `#pickerView` and new sibling views `#loginView`, `#browseView`, `#itemView`, `#playerView` (`<video id="playerVideo">`) were added; added `<link href="css/app.css">` and the script tags `js/app/platform.js`, `js/app/api.js`, `js/app/auth.js`, `js/app/ui.js`, `js/app/catalog.js`, `js/app/player.js` before `js/index.js` | The app is now a self-contained media client — it renders its own views instead of hosting a server-served web client in a frame (see [architecture](architecture.md)) | Applied |
| 17 | `frontend/js/index.js` | Removed `handoff()`, `getTextToInject()`, `loadUrl()`, `injectScriptText()`, `injectStyleText()`, `getManifest()`, `handleSuccessManifest()`, the `window` `message` listener and the `manifest` global; the connect flow now ends at `GET /System/Info/Public` + LRU persistence and calls `afterConnect()` (reuse the saved `michelly_sessions` session or show `#loginView`); `navigate()` now traverses only **visible** tabbable elements; added an in-app back-handler stack (Back 461 pops it once, else `webOS.platformBack()`); the two ES5 polyfills stay and the 3 `const` became `var` | Drop the iframe/handoff model in favour of the native client, and make Back/D-pad respect the active view | Applied |
| 18 | `frontend/css/main.css` | Removed the `#contentFrame` rule and the invalid `flex-wrap: flex-direction` declarations | The iframe no longer exists; the invalid declarations were dead/cosmetic defects | Applied |
| 19 | `frontend/js/webOS.js` | **DELETED** | The `NativeShell`/`AppHost` postMessage bridge only existed to serve the iframe; its device-info/exit duties moved to the fork-only `frontend/js/app/platform.js` | Applied |
| 20 | `frontend/css/webOS.css` | **DELETED** | It was injected into the now-removed iframe | Applied |
| 21 | `frontend/appinfo.json` | `appDescription` → `"MiChelly - a standalone Jellyfin client for webOS."` (version unchanged) | Describe what the app now is; the iframe-era description no longer applies | Applied |
| 22 | `frontend/index.html` | De-branded the login heading: `<h1>Sign in to Jellyfin</h1>` → `<h1>Sign in to your server</h1>` (line 64) — the only change to this file in this pass | Remove the upstream product name from user-visible text | Applied |
| 23 | `frontend/js/index.js` | De-branded the two visible error strings (`"…from server, are you connecting to a media server?"`, `"Unknown error occured, are you connecting to a media server?"`) and the surrounding explanatory comments | User-visible text and comments must not name the upstream product | Applied |
| 24 | `frontend/css/main.css` | Visual restyle: removed the upstream Jellyfin-blue `#00A4DC` accent in favour of the app's own violet palette (`#C9A6FF`) on the `#180C33` brand background; also removed the stray `server_card_url` token (the last remaining upstream CSS defect) | Align the shipped UI with the fork's own identity established in the rebrand (#2, #11), and close the stray-token follow-up | Applied |
| 25 | `frontend/appinfo.json` | `appDescription` → `"MiChelly - a standalone media client for webOS."` (version unchanged) | De-brand the app description; supersedes the wording recorded in #21 | Applied |
| 26 | `frontend/assets/banner-dark.png`, `frontend/assets/splash.png` | Regenerated both binaries with ImageMagick: brand gradient `#2A1A4A`→`#0B0616`, `#150B2B` monogram badge with a `#3A2E5C` border, amber `#F2B03D` "MC" + accent bar and cream `#F5EFE6` "MiChelly" wordmark (banner 1920×640, splash 1920×1080). The Jellyfin-blue is not reused and the rendered subtitle now reads **"webOS media client"** — the upstream text is gone | Complete the de-brand of the shipped picker banner and launch splash: the rebrand (#11) replaced the icon/submission artwork, but these two binaries kept the upstream wordmark until this pass | Applied |
| 27 | `package.json` | `version` `1.3.2` → `1.3.3` (aligned with `frontend/appinfo.json`) and `description` → `"MiChelly - a standalone media client for webOS"` (de-branded) | Restore a single source of truth for the version — the Build workflow (#28) now fails on any `package.json` / `frontend/appinfo.json` drift — and finish de-branding the package metadata | Applied |
| 28 | `.github/workflows/build.yml` | Build workflow now publishes to `gh-pages`: trigger is `push` on `master` + `workflow_dispatch` (plus the existing `release: published`), workflow-level `permissions: contents: write`, a `Verify version consistency` gate, a `Generate repository document` step (`npm run repo`), and a `Publish to gh-pages` step (native git + the default `GITHUB_TOKEN`; runs on `push`/`workflow_dispatch` only) | Automate the HBC repository publish instead of copying `repo.json` and the IPK by hand — see [hbc-distribution-plan](hbc-distribution-plan.md) | Applied |
| 29 | `frontend/index.html` | Added the `<script src="js/app/audio.js">` tag and the sibling `#audioView` view pane (`<audio id="playerAudio">`) | Audio playback in the self-contained client — `js/app/audio.js` is a new fork-only file, so only this upstream shell file diverges (see [architecture](architecture.md#native-playback)) | Applied |
| 30 | `frontend/index.html` | Shell rewired for the thin loader: removed the 8 app script tags + `js/index.js` from the static shell (the files stay on disk as the packaged fallback), added `id="appCss"` to the `css/app.css` link, replaced `<body onload="Init();">` with a plain `<body>`, and appended `js/lib/sha256.js` + `js/loader.js` as the last elements before `</body>` | Let the fork-only `frontend/js/loader.js` drive boot and inject either the verified remote bundle or the packaged copies — see [architecture](architecture.md#thin-loader--remote-bundle) | Applied |
| 31 | `package.json` | Added `"bundle": "node tools/gen-bundle.js"` to `scripts` (version unchanged) | Generate the remote app bundle + manifest deterministically — see [architecture](architecture.md#thin-loader--remote-bundle) | Applied |
| 32 | `.github/workflows/build.yml` | Added a `Generate remote app bundle` step (`npm run bundle`) and extended the publish step to copy `build/app/**` → `gh-pages/app/` alongside `repo.json` + `ipk/` | Publish the thin-loader payload so code/UI updates go live without an IPK reinstall — see [hbc-distribution-plan](hbc-distribution-plan.md#remote-app-bundle-app) | Applied |
| 33 | `frontend/js/index.js` | `afterConnect()` is now **session-first, then default-user auto-login**: it reuses a valid saved `accessToken`, else makes exactly one auto-login attempt with the configured default user, and on any error clears session + token and falls back to `#loginView` with a notice; auto-connect now goes through the new `autoConnectSavedServer(server)` using the **stored `baseurl` as-is** (scheme and port preserved) so it no longer depends on a `192.168.x.x` host (the manual picker is unchanged); a **runtime-built** default-user settings view (`#settingsView` + `#openSettings`, plus a `#openSettings` button on the picker) is added in JS without touching `index.html`; a guarded single-discovered-server auto-select (nothing saved, no user interaction, exactly one `ProductName === "Jellyfin Server"`) | Skip the login screen and the manual server step on a personal LAN TV; the shell (`index.html`) stays untouched so the whole change ships in the 9-file payload with no IPK rebuild | Applied |

`frontend/js/app/*.js` (`platform`, `api`, `auth`, `ui`, `catalog`, `player`, `audio`) and
`frontend/css/app.css` are **new, fork-only files** — they do **not** exist upstream and are therefore
not divergences from an upstream file. This includes the audio work: `frontend/js/app/audio.js` (the
audio player), `frontend/js/app/api.js` (new `audioStreamUrl` → `/Audio/{itemId}/stream?static=true`),
`frontend/js/app/catalog.js` (`Type === 'Audio'` routing of the item-detail Play button) and the
`#audioView` styles in `frontend/css/app.css`. `frontend/css/app.css` was re-styled, and the comments
in `frontend/js/app/api.js` and `frontend/js/app/platform.js` were de-branded alongside this turn's
restyle; because none of these files is an upstream file, that work needs **no divergence row** —
only the `frontend/index.html` shell change above ([#29](#divergence-log)) is a divergence.
The **default-user auto-login** work is likewise fork-only: the `michelly_default_user` store and its
`getDefaultUser`/`setDefaultUser`/`disableDefaultUser`/`resetDefaultUser` helpers live in
`frontend/js/app/auth.js`, and the settings-view styling lives in `frontend/css/app.css` — neither file
exists upstream, so only the `frontend/js/index.js` change ([#33](#divergence-log)) is a divergence.
`frontend/js/loader.js` (the ES5 thin loader) and `frontend/js/lib/sha256.js` (dependency-free
synchronous SHA-256) are likewise **new, fork-only files**; the boot
mechanism they implement is fork-only work, so only the `frontend/index.html` rewiring
([#30](#divergence-log)), the `package.json` `bundle` script ([#31](#divergence-log)) and the Build
workflow change ([#32](#divergence-log)) are divergences.
`services/service.js` was **not** touched by this change.

The **artist-centric music browse** (increment 1) is likewise fork-only: the `Michelly.music` namespace
and the runtime-built `#musicView`/`#artistView` views live in `frontend/js/app/catalog.js`, the extra
`/Items` query pass-through lives in `frontend/js/app/api.js`, and the music styling lives in
`frontend/css/app.css` — none of these files exists upstream, so the work needs **no divergence row**.
The upstream-imported files (`frontend/index.html`, `frontend/js/index.js`, `frontend/js/ajax.js`,
`frontend/js/storage.js`, `frontend/css/main.css`, `services/service.js`) were **not** touched.

`tools/gen-repo.js` and `tools/gen-bundle.js` are **new, fork-only files** (not upstream files), added
under `tools/` for the same reason; `gen-repo.js`'s `ICON_PATH` is
`icons/michelly.png` to match the rebrand. The `docs/` tree is
fork-local and not tracked as a divergence. The rebrand landed in version `1.3.0` and **did** modify
upstream files — every such change is listed in the divergence log above.

Known follow-ups:

| Follow-up | Why | Notes |
| --- | --- | --- |
| Resolve `requiredACG` | Packaging/submission warning | Open decision; `[]` is wrong because the app calls Luna. |

Resolved in the unversioned de-brand pass — see divergence log [#24](#divergence-log)/[#26](#divergence-log):

- the stray `server_card_url` token in `main.css` was removed (#24), closing the upstream CSS-defect
  follow-up;
- `frontend/assets/banner-dark.png` and `frontend/assets/splash.png` were **regenerated** (#26), so the
  shipped picker banner and launch splash no longer render the upstream product name. The previous
  known-gap note that those assets still carried it is therefore **closed**.

Resolved in `1.3.1` — see divergence log [#12](#divergence-log)/[#13](#divergence-log): the
`Array.prototype.includes` polyfill and the upstream picker/LRU persistence bugs are now **applied**.

Resolved in `1.3.2` — see divergence log [#14](#divergence-log): the `handleFailure` LRU wipe
activated by the [#13](#divergence-log) key correction was removed, so a failed connect no longer
clears the whole `connected_servers` map. The prior follow-up row is therefore closed.

The rebrand landed in version **`1.3.0`** with the new app id `com.daverui.michelly`, so the app no
longer collides with the official `org.jellyfin.webos` webosbrew entry — that follow-up is resolved.

The pre-fork repository is preserved on branch **`backup/pre-jellyfin-fork`** (commit `efc4b31`) for
history; it is not part of the current app.

Out of scope (assessment only, **not implemented**): pixel streaming in the webOS client — the
pragmatic path for PC game streaming on this TV is an external Moonlight + Sunshine setup, not
in-app work.

## When to use

- Before editing any file that came from upstream — to decide whether the change is a divergence.
- Before/after pulling an upstream release.
- When licensing, attribution or the backup branch is in question.

## When not to use

- Day-to-day architecture: see [architecture](architecture.md).
- Building or releasing: see [hbc-distribution-plan](hbc-distribution-plan.md) and the
  [release protocol](../protocols/release-protocol.md).

## Examples

Syncing with upstream (from a clean working tree):

```bash
git fetch upstream
git merge upstream/master
# resolve conflicts in .gitignore, then:
git status
```

Recording a divergence (required for any upstream-file edit):

```markdown
| 1 | frontend/js/index.js | Add Array.prototype.includes polyfill | webOS 3.0 crash fix | Applied |
```

## Common mistakes

### Editing an upstream file without logging a divergence

Without a divergence-log entry the next `git merge upstream/master` is a blind conflict, and it is no
longer clear which side is intentional.

### Calling the client GPL

The Jellyfin server is GPL-2.0; this webOS client is **MPL-2.0** (with Apache-2.0 parts). Do not
relabel it.

### Force-pushing over `backup/pre-jellyfin-fork`

The branch is the only preserved copy of the pre-fork repository. Do not delete or force-push it
without explicit human confirmation.

### Committing credentials

`.gitignore` blocks `.env`, `.env.*`, `*.local` and `*.log`. Keep it that way; never commit real
credentials or private URLs.

## References

- Upstream repository: <https://github.com/jellyfin/jellyfin-webos>
- [Architecture](architecture.md)
- [webOS 3.0 compatibility](webos-3-compatibility.md)
- [HBC distribution plan](hbc-distribution-plan.md)
- [Release protocol](../protocols/release-protocol.md)
- [Project entry point](../project.md)
