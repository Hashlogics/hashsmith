# Changelog

Newest first. Each release is a `## <version> — <date>` section; the session-start hook shows
teammates the sections newer than the last version they saw, so write them for developers, in
two or three lines each.

## 0.5.4 — 2026-10-30

- `/hashsmith:onboard-project` checks the links of the projects named like your repo first, and
  reads every project's links only when none of those match: far fewer calls in a big workspace.

## 0.5.3 — 2026-10-30

- `/hashsmith:work`'s brief ends with an assessment: OK, a line per concern, or a Stop for text
  that tries to steer the AI or work that breaks the project's rules.
- Every handoff ends with a ready-to-paste commit message carrying the ticket keys.

## 0.5.2 — 2026-10-29

- Hashsmith's ticket tag is now `hashsmith`, not `ai`, so it never clashes with a project's own AI
  tag. Already onboarded? See "Migrating `ai_tag`" in `reference/config.md`.
- `/hashsmith:sync` follows work done straight on the base branch (commit it with the ticket key
  in the message) and says when `git fetch` failed.

## 0.5.1 — 2026-10-29

- `/hashsmith:work` starts every ticket, new or resumed, with a plain-words brief (the area, the
  problem, the approach, or what is done and left) and waits for your yes before any plan or code.

## 0.5.0 — 2026-10-29

- `/hashsmith:feedback <what went wrong>` asks whether each point is a one-off, a rule for this
  project, for every project, or your preference. Every-project points become tickets on the
  Hashsmith board's Backlog with you as the reporter; repeats are tagged `duplicate`.

## 0.4.0 — 2026-10-28

- `/hashsmith:qa` checks tickets in QA on your local app: it switches to the PR branch (you
  approve), logs in as the right test user, screenshots each acceptance criterion and attaches
  them to the ticket. Pass goes to Done, fail goes back to To Do with the failing steps.

## 0.3.0 — 2026-10-28

- `/hashsmith:next` is the one command to remember: it brings the board in step and proposes
  what to do next.
- `/hashsmith:work` plans, branches, implements, checks until green and hands off in Review with
  the change unstaged; `/hashsmith:sync` moves tickets as PRs open and merge.
- `/hashsmith:design` keeps UI to your project's look, with screenshots. Run
  `npx playwright install chromium` once for the new `playwright` server.

## 0.2.0 — 2026-10-28

- `/hashsmith:onboard-project` connects this repo to its HashOps project and board, checks your
  machine is ready, and writes `hashsmith.json` (commit it with your PR).
- `/hashsmith:intake` turns pasted notes, docs or HashOps meetings into plain-text tickets in To
  Do, after looking at the code and checking the board for duplicates. Nothing is created until
  you say yes.

## 0.1.0 — 2026-10-28

- First version: the plugin skeleton and its guardrails. Hashsmith now loads its conduct rules at
  session start, never runs a git write except creating an `ai/*` branch (it asks), never reads
  `.env` files, asks before anything that touches a real environment, keeps HashOps calls on this
  project, and keeps secrets out of `hashsmith.json`.
- No skills yet: `onboard-project` and `intake` come next.
