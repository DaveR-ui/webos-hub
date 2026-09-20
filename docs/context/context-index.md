---
last_updated: 2026-09-20
status: active
description: Hub for the docs/context folder — what belongs here, every file it holds, and what lives elsewhere.
tags: [hub, context, index]
version: 1.0
related: [architecture, hbc-distribution-plan, deep-link-findings]
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
- Approved plans and investigations (`hbc-distribution-plan`, `deep-link-findings`).
- The folder hub and the compatibility pointer for this directory.

### Contents

- [architecture.md](architecture.md) — webview SPA plus bundled Luna service, request flow, proxy
  security model, settings and ACG.
- [hbc-distribution-plan.md](hbc-distribution-plan.md) — approved custom Homebrew Channel repository
  distribution plan.
- [deep-link-findings.md](deep-link-findings.md) — Jellyfin and Moonlight deep-link behaviour, with
  evidence.
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
