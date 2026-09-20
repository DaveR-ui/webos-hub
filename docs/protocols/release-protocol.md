---
id: release-protocol
category: protocols
tags: [release, ipk, hbc, sha256, ares-package, version, jellyfin]
aliases: [Release Protocol, Publish a Jellyfin webOS client release]
related: [hbc-distribution-plan, upstream-provenance]
version: 1.0
status: active
---

# Release Protocol

## Problem

A release has to produce an IPK whose hash matches the repository document, and a version string that
differs from what the TV already has. Any skipped step produces a silent failure — a phantom update,
or a download that only fails at the end. The version must also stay consistent between
`package.json` and `frontend/appinfo.json`.

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

Produces `build/org.jellyfin.webos_<version>_all.ipk` (architecture-independent). Never run a bare
`ares-package .`; that would pack `.git/`, `build/` and `docs/` into the IPK. Naming `services
frontend` explicitly is what keeps the package clean.

### 4. Generate the HBC manifest

```bash
npm run manifest   # node tools/gen-manifest.js build/org.jellyfin.webos.manifest.json
```

This computes `ipkHash.sha256` from the built IPK. Confirm it matches the file:

```bash
sha256sum build/org.jellyfin.webos_<version>_all.ipk
```

The digest must be 64 lowercase hex characters.

### 5. Regenerate the repository document

Update `repo.json` (`{"packages":[...]}`) with:

- an embedded `manifest` (not `manifestUrl`);
- `id: "org.jellyfin.webos"`, `title: "Jellyfin"`;
- `type: "web"` (there is no `type: "service"`);
- `rootRequired: false`;
- `ipkHash: {"sha256": "<64 lowercase hex>"}` from step 4;
- HTTPS `ipkUrl` and `iconUri` on your own host (the generator leaves `ipkUrl` as a bare filename and
  `iconUri` on upstream).

Until `tools/gen-repo.js` exists, this step is manual. See
[hbc-distribution-plan](../context/hbc-distribution-plan.md).

### 6. Publish to the HTTPS static host

Upload the IPK and `repo.json`. **GitHub Pages** is verified to send `access-control-allow-origin: *`;
GitHub **release assets** do not — that is why the manifest is embedded.

### 7. Refresh HBC and update

On the TV, open Homebrew Channel, refresh the repository view and choose **Update**. There is no
auto-update; the view is refreshed by hand.

### Local alternative: install and launch directly

For development, skip publishing and deploy straight to a registered device:

```bash
npm run deploy     # ares-install build/org.jellyfin.webos_<version>_all.ipk
npm run launch     # ares-launch org.jellyfin.webos
```

With Docker, prefix each `ares-*` call with `./dev.sh`.

### Before you declare the release done

- [ ] `package.json` `version` differs from the published version, and `npm run version` was run.
- [ ] `npm run check` reported no problems (only the expected `requiredACG` warning).
- [ ] `npm run package` succeeded and the IPK exists in `build/`.
- [ ] `npm run manifest` succeeded and `ipkHash.sha256` equals `sha256sum` of that exact IPK.
- [ ] The repository document embeds the manifest, uses `type: "web"`, sets `rootRequired: false`, and
      carries HTTPS `ipkUrl` / `iconUri`.
- [ ] `repo.json` and the IPK are reachable over HTTPS.
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
npm run manifest
sha256sum build/org.jellyfin.webos_<version>_all.ipk
# 5-6. paste the digest into repo.json, publish, then refresh HBC on the TV
```

## Common mistakes

### ares-package packs .git into the IPK

A bare `ares-package .` packs `.git/`, `build/` and `docs/` into the IPK, bloating it and shipping
the repository (and its history) to the TV. Always build through `npm run package`, which names
`services frontend` explicitly. The verified build contains only
`usr/palm/applications/org.jellyfin.webos/**`, `usr/palm/packages/org.jellyfin.webos/packageinfo.json`
and `usr/palm/services/org.jellyfin.webos.service/**`.

### appinfo.json version was edited by hand

`frontend/appinfo.json` is generated from `package.json` by `npm run version`. Editing it directly
creates two sources of truth and a likely version mismatch in the manifest.

### The version was not bumped before publishing

HBC compares version strings by equality. Publishing the same version again leaves a permanent
"Update" that never changes anything.

### repo.json still points at the previous IPK hash

A stale `ipkHash.sha256` fails **after** the whole download, which reads like a network error.
Recompute the hash every release via `npm run manifest`.

### The manifest was published instead of the repository document

`build/org.jellyfin.webos.manifest.json` is a single manifest, not `{"packages":[...]}`. Wrap it and
give it real HTTPS `ipkUrl` / `iconUri`.

### Silencing the requiredACG warning with an empty array

The warning suggests `"requiredACG": []` only for apps that call no Luna API. This app calls Luna;
the empty array is wrong. Treat the field as an open decision.

## References

- [HBC distribution plan](../context/hbc-distribution-plan.md)
- [webOS 3.0 compatibility](../context/webos-3-compatibility.md)
- [Upstream provenance](../context/upstream-provenance.md)
- [Architecture](../context/architecture.md)
- [Project entry point](../project.md)
