---
last_updated: 2026-09-20
status: active
description: Approved plan for distributing WebOS Hub through a custom Homebrew Channel repository — package and manifest fields, the release flow, watch-outs and known limits.
tags: [distribution, homebrew-channel, hbc, release, manifest, ipk]
version: 1.0
related: [architecture, deep-link-findings]
---

# HBC Distribution Plan

## Problem

WebOS Hub is not in the LG Content Store, and there is no sideload-by-hand workflow that scales to
updates. The target TV already runs **Homebrew Channel (HBC)**, which installs only what a
repository document advertises. Without such a document the app can be installed once but never
updated.

## Solution

WebOS Hub is distributed through a **custom HBC repository**: a single JSON document,
`{"packages":[...]}`, served over **HTTPS**. HBC fetches it, reads the `data.packages` array — never
`pkgList` — and offers each package for install or update.

### Repository document

- Served over **HTTPS** only; HBC will not read a plain-HTTP repository.
- Root shape is exactly `{"packages":[...]}`.
- HBC reads **`data.packages`**; a `pkgList` key is ignored (a common copy-paste failure).

### Package entry

| Field | Value |
| --- | --- |
| `id` | `com.admin.weboshub` |
| `title` | `WebOS Hub` |
| `iconUri` | HTTPS URL of a PNG icon |
| `manifest` | Embedded manifest object (preferred over `manifestUrl`) |
| `rootRequired` | `false` |

Embed the `manifest` rather than pointing at a `manifestUrl`: GitHub *release assets* do not send
`access-control-allow-origin`, so a separate manifest fetch fails from HBC's webview.

### Manifest

| Field | Value |
| --- | --- |
| `id` | `com.admin.weboshub` |
| `version` | must equal `version` in `appinfo.json` (for example `1.0.0`) |
| `type` | `"web"` — there is **no** `type: "service"` |
| `title` | `WebOS Hub` |
| `iconUri` | HTTPS URL of a PNG icon |
| `ipkUrl` | HTTPS URL of the `.ipk` |
| `ipkHash` | `{"sha256":"<64 lowercase hex>"}` of that exact IPK |

### One IPK for app and service

The bundled Luna service ships **inside the same IPK** as the web app. `tools/build.mjs` stages both
and calls `ares-package <app> <service>`, producing `com.admin.weboshub_1.0.0_all.ipk`
(architecture-independent).

`rootRequired: false` is correct: registering a bundled service is not an elevation. The service
runs non-elevated, binds no privileged resource, and only performs allow-listed HTTP requests. Only
a service that needed privilege escalation would require root.

### Update flow

1. Bump `version` in `appinfo.json` (mandatory — see Common mistakes).
2. `node tools/build.mjs` → `build/com.admin.weboshub_1.0.0_all.ipk`.
3. `sha256sum build/com.admin.weboshub_1.0.0_all.ipk` → the 64 lowercase hex digest.
4. Regenerate the repository document: embedded `manifest`, `type: "web"`, `rootRequired: false`,
   the correct `ipkHash.sha256`, and HTTPS `ipkUrl` / `iconUri`.
5. Publish the document and the IPK to an **HTTPS static host**. GitHub **Pages** is verified to
   send `access-control-allow-origin: *`; GitHub **release assets** do not — hence the embedded
   manifest.
6. On the TV, refresh the repository view in HBC and choose **Update**.

HBC has **no auto-update**: the view must be refreshed manually, and GitHub Pages caches responses
for roughly 10 minutes.

### Known limitation: Jellyfin deep links

`jellyfin-webos` does not support content deep links, so the hub always lands on Jellyfin's home.
Moonlight deep links do work, using the wire keys `host_uuid` / `host_app_id` (never
`default_host_uuid` / `default_app_id`). See [deep-link-findings](deep-link-findings.md).

### Missing tooling — next steps

- **`tools/gen-repo.mjs`** — generate the `{"packages":[...]}` document from `appinfo.json` plus the
  built IPK, computing `ipkHash.sha256` automatically.
- **An npm script** (for example `npm run repo`) that runs `build.mjs` and `gen-repo.mjs` end to end.
- Until both exist, steps 3–4 above are performed by hand; see the
  [release protocol](../protocols/release-protocol.md).

## When to use

- Shipping or updating WebOS Hub to TVs that already run Homebrew Channel.
- Preparing a release artifact (`repo.json` plus the IPK) for an HTTPS static host.

## When not to use

- TVs without Homebrew Channel — this path does not sideload without it.
- When item-level deep-linking into Jellyfin is required: no distribution channel can provide it,
  because the app itself ignores launch parameters.
- Distribution through the LG Content Store, which is out of scope for this project.

## Examples

A minimal repository document:

```json
{
  "packages": [
    {
      "id": "com.admin.weboshub",
      "title": "WebOS Hub",
      "iconUri": "https://<host>/icons/webos-hub.png",
      "rootRequired": false,
      "manifest": {
        "id": "com.admin.weboshub",
        "version": "1.0.0",
        "type": "web",
        "title": "WebOS Hub",
        "iconUri": "https://<host>/icons/webos-hub.png",
        "ipkUrl": "https://<host>/ipk/com.admin.weboshub_1.0.0_all.ipk",
        "ipkHash": { "sha256": "<64 lowercase hex>" }
      }
    }
  ]
}
```

Computing the hash by hand:

```bash
sha256sum build/com.admin.weboshub_1.0.0_all.ipk
```

## Common mistakes

### Homebrew Channel shows an Update that never goes away

HBC compares version **strings by equality**, not by semver. If `appinfo.json` still says `1.0.0`
while the manifest advertises `1.0`, HBC believes the installed version differs from the published
one and offers an update forever. Always bump `version` before building.

### HBC update fails after downloading the whole package

A wrong `ipkHash.sha256` is detected only **after** the full IPK download, so the failure looks like
a network problem. Recompute `sha256sum` after every build and never reuse a previous hash. The
digest must be 64 lowercase hex characters.

### Changing the Sunshine host requires a full release

`ALLOWED_ORIGINS` is **hardcoded** in `services/service.js` and ships inside the IPK. Changing the
Sunshine host is therefore not a setting — it is a source edit followed by a complete
bump-build-publish release. See [architecture](architecture.md).

### sha256 proves integrity, not authenticity

HBC verifies the IPK against `ipkHash.sha256`. That guarantees the file matches the repository
document; it does **not** sign or authenticate the package. Control of the HTTPS host is the real
trust boundary.

### There is no auto-update

HBC re-reads the repository only when its view is refreshed, and GitHub Pages caches responses for
roughly 10 minutes. Plan communication around a manual refresh, not a push notification.

## References

- [Architecture](architecture.md) — the service allow-list that this plan ships.
- [Deep-link findings](deep-link-findings.md) — Jellyfin and Moonlight launch behaviour.
- [Release protocol](../protocols/release-protocol.md) — the hand-run checklist.
- [Project entry point](../project.md) — slices, commands and conventions.
