---
id: release-protocol
category: protocols
tags: [release, ipk, hbc, sha256, ares-package]
aliases: [Release Protocol, Publish a WebOS Hub release]
related: [hbc-distribution-plan]
version: 1.0
status: active
---

# Release Protocol

## Problem

A release has to produce an IPK whose hash matches the repository document, and a version string
that differs from what the TV already has. Any skipped step produces a silent failure — a phantom
update, or a download that only fails at the end.

## Solution

Run these steps in order from the repository root. Stop at the first failure.

### 1. Bump the version

Edit `version` in `appinfo.json`. It must differ from the version currently advertised in the
repository. HBC compares version strings by equality, so a repeated version shows a permanent
update.

### 2. Build the IPK

```bash
node tools/build.mjs
```

Produces `build/com.admin.weboshub_1.0.0_all.ipk` (architecture-independent). Never run a bare
`ares-package .`; the script stages only shippable files. `ARES_BIN` overrides the binary.

### 3. Hash the IPK

```bash
sha256sum build/com.admin.weboshub_1.0.0_all.ipk
```

Copy the 64 lowercase hex digest.

### 4. Regenerate the repository document

Update `repo.json` (`{"packages":[...]}`) with:

- an embedded `manifest` (not `manifestUrl`);
- `type: "web"` (there is no `type: "service"`);
- `rootRequired: false`;
- `ipkHash: {"sha256": "<64 lowercase hex>"}` from step 3;
- HTTPS `ipkUrl` and `iconUri`.

Until `tools/gen-repo.mjs` exists, this step is manual. See
[hbc-distribution-plan](../context/hbc-distribution-plan.md).

### 5. Publish to the HTTPS static host

Upload the IPK and `repo.json`. **GitHub Pages** is verified to send `access-control-allow-origin: *`;
GitHub **release assets** do not — that is why the manifest is embedded.

### 6. Refresh HBC and update

On the TV, open Homebrew Channel, refresh the repository view and choose **Update**. There is no
auto-update; the view is refreshed by hand.

### Before you declare the release done

- [ ] `appinfo.json` `version` differs from the published version.
- [ ] `node tools/build.mjs` succeeded and the IPK exists in `build/`.
- [ ] `ipkHash.sha256` equals `sha256sum` of that exact IPK (64 lowercase hex).
- [ ] The manifest uses `type: "web"`, embeds the manifest, and sets `rootRequired: false`.
- [ ] `repo.json` and the IPK are reachable over HTTPS.
- [ ] HBC refreshed, Update installed, and the app launches with the new version.

## When to use

- Every time a change must reach the TV.
- Also for a config-only change (for example a new Sunshine origin) — those still require a full
  rebuild and release.

## When not to use

- Local development: run `node tools/build.mjs` and the smoke test without publishing.
- First-time investigation of the distribution format: read
  [hbc-distribution-plan](../context/hbc-distribution-plan.md) first.

## Examples

The full short loop:

```bash
# 1. edit appinfo.json  "version": "1.0.1"
node tools/build.mjs
sha256sum build/com.admin.weboshub_1.0.0_all.ipk
# 3-5. paste the digest into repo.json, publish, then refresh HBC on the TV
```

## Common mistakes

### ares-package packs .git into the IPK

A bare `ares-package .` packs `.git/` and the nested `build/` directory into the IPK, bloating it
from ~42 KB to ~140 KB and shipping the repository to the TV. Always build through
`tools/build.mjs`.

### The version was not bumped before publishing

HBC compares version strings by equality. Publishing the same version again leaves a permanent
"Update" that never changes anything.

### repo.json still points at the previous IPK hash

A stale `ipkHash.sha256` fails **after** the whole download, which reads like a network error.
Recompute the hash every release.

## References

- [HBC distribution plan](../context/hbc-distribution-plan.md)
- [Architecture](../context/architecture.md)
- [Project entry point](../project.md)
