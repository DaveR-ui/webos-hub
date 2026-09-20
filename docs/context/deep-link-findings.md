---
last_updated: 2026-09-20
status: active
description: What deep-linking into the Jellyfin and Moonlight TV apps actually supports — investigated from their own source, with the exact wire keys.
tags: [deep-link, launch-params, jellyfin, moonlight, webos]
version: 1.0
related: [architecture, hbc-distribution-plan]
---

# Deep-link Findings

## Problem

The hub wants a single press to open the *selected* item: the Jellyfin app on a chosen movie, and
Moonlight streaming a chosen Sunshine app on a chosen host. That only works if the target apps read
launch parameters.

## Solution

Two target apps were inspected directly. They behave very differently.

### Jellyfin opens on its home instead of the selected item

`jellyfin-webos` declares **no** deep-link surface: its `appinfo.json` has no `handles`, no
`launchParams` and no `params` entries, and its `Init()` reads only `connected_servers` before
auto-connecting. `handoff()` simply points a content frame at the `start_url` from
`GET /web/manifest.json` — Jellyfin's web root. There is no launch-parameter handling anywhere.

**Conclusion: item-level deep-linking into Jellyfin is not possible.** `js/launcher.js` therefore
launches `org.jellyfin.webos` with no params, and the hub shows an explanatory message when a poster
is selected.

### Moonlight honours two wire keys

`moonlight-tv` (app id `com.limelight.webos`) parses `argv[1]` as a JSON object inside
`app_handle_launch()` and reads exactly two keys:

| Wire key | Type | Meaning |
| --- | --- | --- |
| `host_uuid` | string UUID | The Sunshine host to pre-select. |
| `host_app_id` | number (or numeric string) | The app to pre-select on that host. |

The payload is:

```json
{ "id": "com.limelight.webos", "params": { "host_uuid": "<uuid>", "host_app_id": 0 } }
```

An empty `host_uuid` is tolerated (Moonlight opens on its host picker), so a plain launch is a valid
fallback.

### Evidence (paths are descriptive)

- `jellyfin-webos` `frontend/appinfo.json` — app descriptor with no `handles` / `launchParams` /
  `params`.
- `jellyfin-webos` `frontend/js/index.js` — `Init()` (auto-connect from `connected_servers`) and
  `handoff()` (content frame pointed at `start_url`).
- `moonlight-tv` `src/app/platform/webos/app_webos.c` — `app_handle_launch()` parses `argv[1]` as
  JSON and reads `host_uuid` / `host_app_id`.
- `moonlight-tv` `src/app/app_launch.h` — the internal struct field names `default_host_uuid` /
  `default_app_id` (see Common mistakes).

### The host UUID is optional

The Sunshine HTTP API does not expose the host UUID, so the hub cannot discover it. It is an
optional setting; when it is unset, Moonlight launches plain and the user picks the host inside
Moonlight. The `host_app_id` used for deep links is the 0-based index of the app in `/api/apps`
(best effort, not a stable identifier).

## When to use

- Before changing `js/launcher.js` or the Quick Launch / Stream buttons.
- When explaining why the hub cannot open a specific Jellyfin item.

## When not to use

- Network reachability and the Luna proxy: see [architecture](architecture.md).
- Distribution questions: see [hbc-distribution-plan](hbc-distribution-plan.md).

## Examples

Launching Moonlight with a deep link:

```js
HubLauncher.openMoonlight({ hostUuid: '<uuid>', appId: 0 });
```

Launching Jellyfin (no params — it would ignore them):

```js
HubLauncher.openJellyfin();
```

## Common mistakes

### Moonlight opens on its host picker instead of the selected app

The optional `moonlightHostUuid` setting is empty. Sunshine's API does not expose the UUID, so it
must be entered manually; without it Moonlight launches plain by design.

### Passing default_host_uuid / default_app_id does nothing

Those are **internal C struct field names**, not wire keys. `app_handle_launch()` reads `host_uuid`
and `host_app_id`; sending the struct names is silently ignored.

### Expecting Jellyfin to open a specific movie

The Jellyfin app has no launch-parameter handling. Any attempt to deep-link lands on its home; the
hub documents this instead of pretending otherwise.

## References

- [Architecture](architecture.md)
- [HBC distribution plan](hbc-distribution-plan.md)
- [Project entry point](../project.md)
