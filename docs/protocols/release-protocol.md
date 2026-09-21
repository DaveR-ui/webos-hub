---
id: release-protocol
category: protocols
tags: [release, ipk, hbc, sha256, ares-package, version, media-server]
aliases: [Release Protocol, Publish a MiChelly webOS release]
related: [hbc-distribution-plan, upstream-provenance]
version: 1.7
status: active
---

# Release Protocol

## Problem

A release has to produce an IPK whose hash matches the repository document, and a version string that
differs from what the TV already has. Any skipped step produces a silent failure — a phantom update,
or a download that only fails at the end. The version must also stay consistent between
`package.json` and `frontend/appinfo.json`.

**Published repository:** `https://daver-ui.github.io/webos-hub/repo.json` — paste this exact URL as
the repository source on the TV.

## Solution

Run these steps in order from the repository root. Stop at the first failure.

### 1. Bump the version

Edit `version` in `package.json`, then sync it into the app manifest:

```bash
npm run version    # node tools/sync-version.js && git add frontend/appinfo.json
```

It must differ from the version currently advertised in the repository. HBC compares version strings
by equality, so a repeated version shows a permanent update. Never edit `frontend/appinfo.json`
directly — it is generated from `package.json`.

CI enforces this: the **Build** workflow's `Verify version consistency` step fails the run when
`package.json` and `frontend/appinfo.json` disagree, so a forgotten `npm run version` is caught
before anything is published (step 6).

### 2. Validate the package

```bash
npm run check      # ares-package --check
```

Expect `no problems detected`. A `requiredACG` warning is expected and is an open decision — see
[webos-3-compatibility](../context/webos-3-compatibility.md), not something to silence with `[]`.

### 3. Build the IPK

```bash
npm run package    # ares-package --no-minify --outdir build/ services frontend
```

Produces `build/com.daverui.michelly_<version>_all.ipk` (architecture-independent). Never run a bare
`ares-package .`; that would pack `.git/`, `build/` and `docs/` into the IPK. Naming `services
frontend` explicitly is what keeps the package clean.

### 4. Generate the HBC manifest

```bash
npm run manifest   # node tools/gen-manifest.js build/com.daverui.michelly.manifest.json
```

This computes `ipkHash.sha256` from the built IPK. Confirm it matches the file:

```bash
sha256sum build/com.daverui.michelly_<version>_all.ipk
```

The digest must be 64 lowercase hex characters. `npm run repo` (step 5) recomputes the same digest
independently, so this standalone manifest is optional if you only need `build/repo.json`.

### 5. Regenerate the repository document

```bash
npm run repo       # node tools/gen-repo.js -> build/repo.json
```

This automates the step: it reads `frontend/appinfo.json` plus the built IPK, computes
`ipkHash.sha256`, and writes `build/repo.json` with HTTPS URLs and an embedded `manifest`. `baseUrl`
defaults to `https://daver-ui.github.io/webos-hub` (override via argv or `$HBC_REPO_BASE_URL`).

`npm run repo` also runs in CI as the **Generate repository document** step of the Build workflow
(step 6). Locally it is only for **pre-flight inspection** — the document that gets published is the
one CI regenerates from the same commit.

Confirm the result contains:

- an embedded `manifest` (not `manifestUrl`);
- `id: "com.daverui.michelly"`, `title: "MiChelly"`;
- `type: "web"` (there is no `type: "service"`);
- `rootRequired: false`;
- `ipkHash: {"sha256": "<64 lowercase hex>"}` from step 4;
- HTTPS `ipkUrl` and `iconUri` on your own host.

**Fallback (manual):** without `npm run repo`, edit `repo.json` by hand — the generator replaces that
manual edit. See [hbc-distribution-plan](../context/hbc-distribution-plan.md).

### 6. Publish to the HTTPS static host

Publishing is **automated by the Build workflow** (`.github/workflows/build.yml`). Pushing to
`master` — or running the workflow by hand via **Actions → Build → Run workflow**
(`workflow_dispatch`) — builds the IPK, regenerates `repo.json` and publishes both to the
**`gh-pages`** branch of `DaveR-ui/webos-hub`, which GitHub Pages serves (source = branch `gh-pages`,
path `/`; `https_enforced: true`). As an orphan branch, `gh-pages` keeps `master`'s `.gitignore`
intact — the IPK is gitignored and reaches the TV only through `gh-pages`.

The **Publish to gh-pages** step runs on `push` and `workflow_dispatch` (**not** on `release`). It:

- checks `origin/gh-pages` out into a `git worktree`, preserving the files that exist only on that
  branch — `icons/michelly.png`, `index.html`, `.nojekyll`;
- refreshes `repo.json` and `ipk/com.daverui.michelly_<version>_all.ipk` (removing stale IPKs);
- refreshes the remote app bundle `app/` from `build/app/` (`npm run bundle`);
- commits and pushes `HEAD:gh-pages` with the workflow's default `GITHUB_TOKEN`, and skips the commit
  when nothing changed.

A `GITHUB_TOKEN` push cannot re-trigger the Build workflow; the trigger's `branches: [master]` filter
is belt-and-braces on top of that.

Published layout on `gh-pages`:

- `repo.json` — the generated `{"packages":[...]}` document;
- `ipk/com.daverui.michelly_<version>_all.ipk`;
- `app/` — the remote app bundle (`manifest.json` + the 9 payload files) generated by `npm run bundle`;
  the thin loader fetches it on launch, so code/UI changes auto-update without an IPK refresh (see
  [Code/UI vs IPK](#codeui-vs-ipk-what-a-publish-updates));
- `icons/michelly.png`;
- `index.html` — a small landing page stating the source URL;
- `.nojekyll` — disables Jekyll.

**Manual fallback** — only if a Build run fails or you must publish by hand. Build locally, then copy
the artifacts into the worktree and push directly:

```bash
npm run package                       # -> build/com.daverui.michelly_<version>_all.ipk
npm run repo                          # -> build/repo.json (HTTPS URLs + sha256)
npm run bundle                        # -> build/app/ (manifest.json + payload files)
# in a worktree checked out at the gh-pages orphan branch:
#   copy build/repo.json -> repo.json, build/com.daverui.michelly_<version>_all.ipk -> ipk/,
#   build/app/ -> app/, icon -> icons/
git -C <worktree> add -A
git -C <worktree> commit -m "Publish com.daverui.michelly <version>"
git -C <worktree> push origin gh-pages
# enable Pages once, if not already:
gh api -X POST repos/DaveR-ui/webos-hub/pages -f source[branch]=gh-pages -f source[path]=/
```

**GitHub Pages** is verified to send `access-control-allow-origin: *`; GitHub **release assets** do
not — that is why the manifest is embedded. Pages caches responses for roughly 10 minutes.

### 7. Refresh HBC and update

On the TV, open Homebrew Channel, refresh the repository view and choose **Update**. There is no
auto-update of the **IPK**; the view is refreshed by hand. A payload-only code/UI change needs no HBC
action at all — it is live on the next launch (see below).

### Code/UI vs IPK: what a publish updates

A `master` publish ships two things with different update paths:

- **Remote app bundle** (`app/`) — the 9 payload files (`js/app/*.js`, `js/index.js`, `css/app.css`),
  generated by `npm run bundle` and published alongside `repo.json`. The thin loader fetches and
  verifies it on the TV's **next launch**, so code/UI changes go live with **no HBC interaction and no
  reinstall**. See [architecture](../context/architecture.md#thin-loader--remote-bundle).
- **The IPK** (`ipk/…`) — the shell (`frontend/index.html`, `js/loader.js`, `js/lib/sha256.js`), the bundled
  Luna service, `appinfo.json`, assets and the version string. Reaching the TV still requires the
  manual HBC **Update** (step 7); the IPK version stays frozen across payload-only updates.

`npm run bundle` (`tools/gen-bundle.js`) writes `build/app/manifest.json` + the payload files and is
deterministic; `--check` fails when the manifest is stale. CI runs it as the **Generate remote app
bundle** step.

### Local alternative: install and launch directly

For development, skip publishing and deploy straight to a registered device:

```bash
npm run deploy     # ares-install build/com.daverui.michelly_<version>_all.ipk
npm run launch     # ares-launch com.daverui.michelly
```

With Docker, prefix each `ares-*` call with `./dev.sh`.

### Before you declare the release done

- [ ] `package.json` `version` differs from the published version, and `npm run version` was run.
- [ ] `npm run check` reported no problems (only the expected `requiredACG` warning).
- [ ] `npm run package` succeeded and the IPK exists in `build/`.
- [ ] `npm run repo` succeeded and `ipkHash.sha256` in `build/repo.json` equals `sha256sum` of that
      exact IPK.
- [ ] The repository document embeds the manifest, uses `type: "web"`, sets `rootRequired: false`, and
      carries HTTPS `ipkUrl` / `iconUri`.
- [ ] The Build run for the pushed commit succeeded (the `Verify version consistency` step passed)
      and its **Publish to gh-pages** step pushed to `gh-pages` — check the run log; a
      `No publish changes to commit.` message means nothing was published.
- [ ] `repo.json` is reachable over HTTPS at the published source URL
      (`https://daver-ui.github.io/webos-hub/repo.json`) and advertises the new version and the new
      IPK's `ipkHash.sha256` (Pages caches for ~10 minutes).
- [ ] `npm run bundle` succeeded (or CI's **Generate remote app bundle** step did) and
      `gh-pages/app/manifest.json` is reachable with the new `bundleVersion`.
- [ ] For a payload-only change: the next TV launch activated the new bundle (console shows
      `[michelly-shell] bundle remote <version> active`) with no HBC Update.
- [ ] HBC refreshed, Update installed, and the app launches with the new version.
- [ ] Any change to an upstream file is recorded in the
      [divergence log](../context/upstream-provenance.md#divergence-log).

## When to use

- Every time a change must reach the TV through Homebrew Channel.
- Also for a local-only build/install cycle, using steps 2–3 and the local alternative above.

## When not to use

- First-time investigation of the distribution format: read
  [hbc-distribution-plan](../context/hbc-distribution-plan.md) first.
- Compatibility questions about the target TV: see
  [webos-3-compatibility](../context/webos-3-compatibility.md).

## Examples

The full short loop:

```bash
# 1. bump "version" in package.json, then:
npm run version
npm run check
npm run package
npm run repo
npm run bundle
sha256sum build/com.daverui.michelly_<version>_all.ipk
# 6. commit and push to master — CI builds, regenerates repo.json, bundles app/ and publishes to
#    gh-pages (or run the Build workflow via workflow_dispatch); then refresh HBC on the TV
```

## Common mistakes

### ares-package packs .git into the IPK

A bare `ares-package .` packs `.git/`, `build/` and `docs/` into the IPK, bloating it and shipping
the repository (and its history) to the TV. Always build through `npm run package`, which names
`services frontend` explicitly. The verified build contains only
`usr/palm/applications/com.daverui.michelly/**`, `usr/palm/packages/com.daverui.michelly/packageinfo.json`
and `usr/palm/services/com.daverui.michelly.service/**`.

### appinfo.json version was edited by hand

`frontend/appinfo.json` is generated from `package.json` by `npm run version`. Editing it directly
creates two sources of truth and a likely version mismatch in the manifest.

### The version was not bumped before pushing

HBC compares version strings by equality. Publishing the same version again leaves a permanent
"Update" that never changes anything. Bump `version` and run `npm run version` **before** pushing to
`master` — a same-version republish does not surface as an Update. CI's `Verify version consistency`
step fails the run when `package.json` and `frontend/appinfo.json` drift apart, but it cannot know
that both were left unchanged.

### Expecting a GitHub Release to update the HBC repository

The **Publish to gh-pages** step runs on `push` to `master` and on `workflow_dispatch` only. Publishing
a GitHub **release** builds the package and attaches it to the release, but does **not** refresh
`gh-pages` — the repository document stays at the previous version until the next `master` push.

### repo.json still points at the previous IPK hash

A stale `ipkHash.sha256` fails **after** the whole download, which reads like a network error.
Recompute the hash every release via `npm run repo`.

### The manifest was published instead of the repository document

`build/com.daverui.michelly.manifest.json` is a single manifest, not `{"packages":[...]}`. Wrap it and
give it real HTTPS `ipkUrl` / `iconUri` — `npm run repo` produces the correct document directly.

### Silencing the requiredACG warning with an empty array

The warning suggests `"requiredACG": []` only for apps that call no Luna API. This app calls Luna;
the empty array is wrong. Treat the field as an open decision.

## References

- [HBC distribution plan](../context/hbc-distribution-plan.md)
- [webOS 3.0 compatibility](../context/webos-3-compatibility.md)
- [Upstream provenance](../context/upstream-provenance.md)
- [Architecture](../context/architecture.md)
- [Project entry point](../project.md)
