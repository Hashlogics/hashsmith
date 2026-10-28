# Changelog

Newest first. Each release is a `## <version> — <date>` section; the session-start hook shows
teammates the sections newer than the last version they saw, so write them for developers, in
two or three lines each.

## 0.1.0 — 2026-10-28

- First version: the plugin skeleton and its guardrails. Hashsmith now loads its conduct rules at
  session start, never runs a git write except creating an `ai/*` branch (it asks), never reads
  `.env` files, asks before anything that touches a real environment, keeps HashOps calls on this
  project, and keeps secrets out of `hashsmith.json`.
- No skills yet: `onboard-project` and `intake` come next.
