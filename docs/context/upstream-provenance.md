---
last_updated: 2026-09-20
status: active
description: Fork provenance for the Jellyfin webOS client — upstream origin and commit, MPL-2.0/Apache-2.0 licensing, the verbatim-import policy, how to sync with upstream, and the divergence log.
tags: [provenance, fork, upstream, license, mpl-2.0, apache-2.0, sync, divergence]
version: 1.1
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
- MPL headers are present in `frontend/index.html`, `frontend/js/*.js`, `frontend/css/*.css` and
  `services/service.js`.
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

`tools/gen-repo.js` is a **new, fork-only file** (not an upstream file), added under `tools/` for the
same reason; its `ICON_PATH` is now `icons/michelly.png` to match the rebrand. The `docs/` tree is
fork-local and not tracked as a divergence. The rebrand landed in version `1.3.0` and **did** modify
upstream files — every such change is listed in the divergence log above.

Known follow-ups (planned, not yet applied):

| Follow-up | Why | Notes |
| --- | --- | --- |
| Add an `Array.prototype.includes` polyfill | webOS 3.0 / Chromium 38 defect | See [webos-3-compatibility](webos-3-compatibility.md). |
| Resolve `requiredACG` | Packaging/submission warning | Open decision; `[]` is wrong because the app calls Luna. |
| Fix upstream picker/LRU bugs | Newly discovered servers may not persist | See [architecture](architecture.md#common-mistakes). |
| Fix upstream CSS defects | Cosmetic; `main.css:44–45` invalid `flex-wrap`, `:156` stray token | See below. |

The rebrand landed in version **`1.3.0`** with the new app id `com.daverui.michelly`, so the app no
longer collides with the official `org.jellyfin.webos` webosbrew entry — that follow-up is resolved.

The pre-fork repository is preserved on branch **`backup/pre-jellyfin-fork`** (commit `efc4b31`) for
history; it is not part of the current app.

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
