---
name: next
description: Use when the developer starts a Hashsmith session, asks what to do next or what is on the board, or runs /hashsmith:next. The one entry point that reads the board and proposes the next step.
---

# What next

The one command a developer needs to remember. Read the state, bring the board in step, and propose
the most useful next step with a recommendation. Never start work without a yes.

## 1. Onboarded?

Run the CLI's `check-config` (the `Hashsmith CLI` line in your session context). No
`hashsmith.json`, or invalid: say so in one line and propose `/hashsmith:onboard-project`. Stop
there.

## 2. Sync

Run `/hashsmith:sync`. Its moves are confirmed inside it.

## 3. Read the board

`list_tasks` with `limit: 60` for the board's To Do, In Progress, Review and QA lists (list names
from `get_board` for the ids in `hashops.lists`). It returns no tags and sorts by last update, not
priority. Count the tickets per list (sync already told you which in flight are Hashsmith's), and
in To Do note:
- **QA bounces:** run the CLI's `ticket-state` for the To Do keys. A To Do ticket that has an
  `ai/*` branch was handed off before; `get_task` it, and it is a bounce when its last comment
  starts "QA failed (Hashsmith)";
- the top three other To Do tickets by priority, sorted yourself (any tag: humans' tickets can be
  picked up too). Say when a list was cut at 60.

Also note the working tree (CLI `tree`): uncommitted changes mean a handoff is waiting for the
developer, and Hashsmith cannot switch branches until it is committed.

## 4. Propose

Show a short status (`To Do 6 (1 QA bounce) · In Progress 0 · Review 2 · QA 1`), then offer the
choices that apply, in this order; the first one that applies is the recommendation. **When the
tree is not clean, choice 3 comes first**, and choices 1, 2 and 4 are shown as "needs a clean
tree": `work` and `qa` both stop on uncommitted changes.

1. **Fix a QA bounce:** `/hashsmith:work <KEY>`. A failed QA blocks the release of that work.
2. **QA what's waiting:** `/hashsmith:qa` for tickets in QA (their PRs are open). It needs the
   local stack; say so when it is not running.
3. **Finish a handoff:** tickets in Review whose branch has no PR yet. Remind the developer to
   review, commit, push and open a PR; nothing for Hashsmith to do until then.
4. **Work the next ticket:** `/hashsmith:work <KEY>` for the top To Do ticket, naming the next two
   as alternatives.
5. **New requirements:** `/hashsmith:intake`, when the developer has notes, a doc, a Slack thread
   or a meeting to turn into tickets.

Ask in one question with these options and the recommendation's one-line reason. The developer's
free text overrides the menu ("do ACME-9", "intake this: …"). Then run the chosen skill.

When the board is empty and nothing is waiting, say so and offer intake.
