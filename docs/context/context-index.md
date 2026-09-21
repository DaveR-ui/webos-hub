---
last_updated: 2026-09-20
status: active
description: Hub for the docs/context folder of the Jellyfin webOS client fork — what belongs here, every file it holds, and what lives elsewhere.
tags: [hub, context, index]
version: 1.2
related: [architecture, webos-3-compatibility, upstream-provenance, hbc-distribution-plan]
---

# Context Index

## Problem

Readers and agents need one place that lists this project's strategic documents and states where
everything else lives, without guessing paths.

## Solution

This folder holds the project's **strategic context docs**: one topic per file, each following the
context-doc frontmatter contract. Every change should route through one of these documents before it
touches source.

### What belongs here

- Architecture and design that outlives a single change.
- Approved plans and investigations (`hbc-distribution-plan`, `webos-3-compatibility`,
  `upstream-provenance`).
- The folder hub and the compatibility pointer for this directory.

### Contents

- [architecture.md](architecture.md) — the app shell and views, the ES5 Jellyfin REST client,
  auth/session, catalog browsing, native playback and the bundled Luna discovery service.
- [webos-3-compatibility.md](webos-3-compatibility.md) — webOS 3.0 / Chromium 38 compatibility report:
  what is safe, the concrete defects and the on-device test plan.
- [upstream-provenance.md](upstream-provenance.md) — fork origin, licensing, the verbatim-import
  policy, upstream sync and the divergence log.
- [hbc-distribution-plan.md](hbc-distribution-plan.md) — approved custom Homebrew Channel repository
  distribution plan.
- [README.md](README.md) — compatibility pointer; the operating agent system resolves this path as
  the folder index.
- [context-index.md](context-index.md) — this hub.

### What lives elsewhere

- Hand-run procedures (releases, packaging) live in [`../protocols/`](../protocols/).
- The agent-facing entry point — stack, slices, commands — is [`../project.md`](../project.md).
- No ADR folder exists in this corpus; decisions are recorded in the relevant context doc.

## When to use

- Onboarding to the project's design and plans.
- Deciding whether a new document belongs in `context/` or `protocols/`.

## When not to use

- Running a release: go straight to [release-protocol](../protocols/release-protocol.md).
- Finding a command: go to [project.md](../project.md#commands).

## Examples

Registering a new context doc: add the file under `### Contents` here, then add a row to the Context
Index in [`../project.md`](../project.md).

## Common mistakes

### Adding a procedure to context/

Procedures that are run by hand belong in `docs/protocols/`. Context docs explain *what and why*;
protocols prescribe *the ordered steps*.

### Forgetting to register a new file

A context doc is not done until it appears in `### Contents` here and in the Context Index of
`../project.md`.

## References

- [Project entry point](../project.md)
- [Release protocol](../protocols/release-protocol.md)
