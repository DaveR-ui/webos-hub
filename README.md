# WebOS Hub

A webOS TV app (`com.admin.weboshub`) that federates **Jellyfin** and **Sunshine** into a single
D-pad home screen, and deep-links into the two TV apps that are already installed —
`org.jellyfin.webos` (Jellyfin) and `com.limelight.webos` (Moonlight).

- One TV home screen: Continue Watching, Jellyfin libraries with poster grids, and Sunshine apps.
- In-app Settings persisted to the TV's `localStorage`; no credentials live in this repository.
- Launches the installed Jellyfin and Moonlight apps (deep links only where the target supports
  them).

Quick start (repository root):

```bash
node tools/build.mjs        # -> build/com.admin.weboshub_1.0.0_all.ipk
```

The IPK bundles the webview app and its non-elevated Luna proxy service
`com.admin.weboshub.service`.

## Documentation

The canonical, agent-facing entry point is [`docs/project.md`](docs/project.md). Start there; the
table below is a human shortcut into the same corpus.

| Doc | Purpose |
| --- | --- |
| [`docs/project.md`](docs/project.md) | Entry point: stack, slices, commands, domain entities. |
| [`docs/context/architecture.md`](docs/context/architecture.md) | Webview SPA + bundled Luna service, proxy security model. |
| [`docs/context/hbc-distribution-plan.md`](docs/context/hbc-distribution-plan.md) | Custom Homebrew Channel repository distribution plan. |
| [`docs/context/deep-link-findings.md`](docs/context/deep-link-findings.md) | What deep-linking the two target apps actually supports. |
| [`docs/protocols/release-protocol.md`](docs/protocols/release-protocol.md) | Hand-run release checklist. |

## Distribute via a custom Homebrew Channel repository

The app reaches the TV through a **custom Homebrew Channel (HBC) repository**: a single JSON
`{"packages":[...]}` served over HTTPS, where each package embeds its manifest — including the IPK
`sha256` — so HBC never needs a second request to a manifest URL. The approved plan (package and
manifest fields, the bump-and-publish update flow, the watch-outs and the known limitations) lives
in [`docs/context/hbc-distribution-plan.md`](docs/context/hbc-distribution-plan.md). Generating the
repository JSON is still manual: `tools/gen-repo.mjs` is the planned next step.

## No secrets in the repository

This repository contains no credentials. The only values in source are the default service URLs;
usernames and passwords are typed on the TV and persist solely in its `localStorage` (key
`webosHub.settings.v1`). The live smoke test reads its credentials from environment variables.
