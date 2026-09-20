---
last_updated: 2026-09-20
status: active
description: Distribution plan for the Jellyfin webOS client fork through a custom Homebrew Channel repository — package and manifest fields, the release flow, watch-outs and known limits.
tags: [distribution, homebrew-channel, hbc, release, manifest, ipk]
version: 1.0
related: [upstream-provenance, architecture]
---

# HBC Distribution Plan

## Problem

This **personal fork** (`org.jellyfin.webos`, built from local source) is not installed from the LG
Content Store, and there is no sideload-by-hand workflow that scales to updates. The target TV already
runs **Homebrew Channel (HBC)**, which installs only what a repository document advertises. Without
such a document the app can be installed once but never updated.

## Solution

The fork is distributed through a **custom HBC repository**: a single JSON document,
`{"packages":[...]}`, served over **HTTPS**. HBC fetches it, reads the `data.packages` array — never
`pkgList` — and offers each package for install or update.

### Repository document

- Served over **HTTPS** only; HBC will not read a plain-HTTP repository.
- Root shape is exactly `{"packages":[...]}`.
- HBC reads **`data.packages`**; a `pkgList` key is ignored (a common copy-paste failure).

### Package entry

| Field | Value |
| --- | --- |
| `id` | `org.jellyfin.webos` |
| `title` | `Jellyfin` |
| `iconUri` | HTTPS URL of a PNG icon |
| `manifest` | Embedded manifest object (preferred over `manifestUrl`) |
| `rootRequired` | `false` |

Embed the `manifest` rather than pointing at a `manifestUrl`: GitHub *release assets* do not send
`access-control-allow-origin`, so a separate manifest fetch fails from HBC's webview.

### Manifest

| Field | Value |
| --- | --- |
| `id` | `org.jellyfin.webos` |
| `version` | must equal `version` in `frontend/appinfo.json` (currently `1.2.2`) |
| `type` | `"web"` — there is **no** `type: "service"` |
| `title` | `Jellyfin` |
| `iconUri` | HTTPS URL of a PNG icon |
| `ipkUrl` | HTTPS URL of the `.ipk` |
| `ipkHash` | `{"sha256":"<64 lowercase hex>"}` of that exact IPK |

`tools/gen-manifest.js` (run by `npm run manifest`) generates
`build/org.jellyfin.webos.manifest.json` with `id`, `version`, `type`, `title`, `appDescription`,
`rootRequired: false`, `ipkUrl` (the bare filename) and the computed `ipkHash.sha256`. It still
points `iconUri`/`sourceUrl` at the upstream GitHub project, and `ipkUrl` is only a filename — for a
personal host you must edit those and host the IPK yourself. The generator computes the hash but is
**not** a full repository-document generator.

### One IPK for app and service

The bundled Luna discovery service ships **inside the same IPK** as the web app. `npm run package`
runs `ares-package --no-minify --outdir build/ services frontend`, producing
`build/org.jellyfin.webos_1.2.2_all.ipk` (architecture-independent).

`rootRequired: false` is correct: registering a bundled service is not an elevation. The service runs
non-elevated, binds no privileged resource and only performs UDP discovery on the local network. Only
a service that needed privilege escalation would require root.

### Update flow

1. Bump `version` in `package.json`, then run `npm run version` (mandatory — see Common mistakes).
2. `npm run check` → `ares-package --check`; expect `no problems detected`.
3. `npm run package` → `build/org.jellyfin.webos_<version>_all.ipk`.
4. `npm run manifest` → `build/org.jellyfin.webos.manifest.json` (contains `ipkHash.sha256`).
5. Regenerate/edit the **repository document**: embedded `manifest`, `type: "web"`,
   `rootRequired: false`, the correct `ipkHash.sha256`, and HTTPS `ipkUrl` / `iconUri`.
6. Publish the document and the IPK to an **HTTPS static host**. GitHub **Pages** is verified to send
   `access-control-allow-origin: *`; GitHub **release assets** do not — hence the embedded manifest.
7. On the TV, refresh the repository view in HBC and choose **Update**.

HBC has **no auto-update**: the view must be refreshed manually, and GitHub Pages caches responses for
roughly 10 minutes.

### Known limitation: no deep links

`frontend/appinfo.json` declares no `handles`, `launchParams` or `params`, and the app reads no launch
arguments. It has no deep-link surface of its own — a launch always lands on the server picker (or
auto-connects to the last server). See [architecture](architecture.md#no-launch-parameter--deep-link-surface).

### Missing tooling — next steps

- **`tools/gen-repo.js`** — generate the `{"packages":[...]}` document from `frontend/appinfo.json`
  plus the built IPK, computing `ipkHash.sha256` and HTTPS URLs automatically.
- **An npm script** (for example `npm run repo`) that runs `package`, `manifest` and `gen-repo` end
  to end.
- Until both exist, steps 4–5 above are performed by hand; see the
  [release protocol](../protocols/release-protocol.md).

## When to use

- Shipping or updating this fork to TVs that already run Homebrew Channel.
- Preparing a release artifact (`repo.json` plus the IPK) for an HTTPS static host.

## When not to use

- TVs without Homebrew Channel — this path does not sideload without it.
- Distribution of the upstream app through the LG Content Store, which is out of scope for the fork.
- Local development: build and install directly with `npm run deploy` / `npm run launch`.

## Examples

A minimal repository document for this fork:

```json
{
  "packages": [
    {
      "id": "org.jellyfin.webos",
      "title": "Jellyfin",
      "iconUri": "https://<host>/icons/jellyfin.png",
      "rootRequired": false,
      "manifest": {
        "id": "org.jellyfin.webos",
        "version": "1.2.2",
        "type": "web",
        "title": "Jellyfin",
        "iconUri": "https://<host>/icons/jellyfin.png",
        "ipkUrl": "https://<host>/ipk/org.jellyfin.webos_1.2.2_all.ipk",
        "ipkHash": { "sha256": "<64 lowercase hex>" }
      }
    }
  ]
}
```

Generating the manifest and confirming its hash by hand:

```bash
npm run package
npm run manifest
sha256sum build/org.jellyfin.webos_1.2.2_all.ipk
# the digest must equal ipkHash.sha256 in build/org.jellyfin.webos.manifest.json
```

## Common mistakes

### Homebrew Channel shows an Update that never goes away

HBC compares version **strings by equality**, not by semver. If `frontend/appinfo.json` still says
`1.2.2` while the manifest advertises a different string, HBC believes the installed version differs
from the published one and offers an update forever. Always bump `version` in `package.json` and run
`npm run version` before building.

### HBC update fails after downloading the whole package

A wrong `ipkHash.sha256` is detected only **after** the full IPK download, so the failure looks like a
network problem. Recompute the hash after every build (`npm run manifest` regenerates it) and never
reuse a previous hash. The digest must be 64 lowercase hex characters.

### Publishing `build/org.jellyfin.webos.manifest.json` as the repository document

That file is a single *manifest*, not a `{"packages":[...]}` repository. `ipkUrl` is a bare filename
and `iconUri` points at upstream. HBC needs the repository document wrapping the manifest with real
HTTPS URLs.

### sha256 proves integrity, not authenticity

HBC verifies the IPK against `ipkHash.sha256`. That guarantees the file matches the repository
document; it does **not** sign or authenticate the package. Control of the HTTPS host is the real
trust boundary.

### There is no auto-update

HBC re-reads the repository only when its view is refreshed, and GitHub Pages caches responses for
roughly 10 minutes. Plan communication around a manual refresh, not a push notification.

### The build toolchain differs from upstream CI

Upstream CI (`.github/workflows/build.yml`) uses Node 14.x and installs `@webosose/ares-cli` globally,
whereas this fork builds locally with the devDependency (`^2.4.0`) on a much newer Node. If a build
behaves differently from CI, check the Node/ares version first.

## References

- [Architecture](architecture.md) — the bundled service this plan ships.
- [Upstream provenance](upstream-provenance.md) — the verbatim import and divergence log.
- [Release protocol](../protocols/release-protocol.md) — the hand-run checklist.
- [Project entry point](../project.md) — slices, commands and conventions.
