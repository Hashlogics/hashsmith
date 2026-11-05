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

**Lists before To Do.** Teams keep unready tickets in lists before To Do, under any name (Backlog,
Icebox, Ideas). Pass `get_board`'s `lists` to the CLI's `lists-before-todo` as JSON on stdin,
through a quoted heredoc so no name is on the command line: `node "<cli>" lists-before-todo
<<'EOF'` / `[{"id": …, "name": …, "type": …}, …]` / `EOF`. It prints the active ones that come
before To Do and are not in `hashops.lists`. An `error` that To Do is not on this board means
stale ids: say so and propose `/hashsmith:onboard-project`; any other `error` means the input was
wrong: run it again with `get_board`'s `lists`.

`list_tasks` with `{board_id, status: <list name>, limit: 60}` for those lists and for To Do, In
Progress, Review and QA (list names from `get_board` for the ids in `hashops.lists`; without
`board_id` a name matches lists on every project). It returns no tags and sorts by last update,
not priority. Count the tickets per list (sync already told you which in flight are Hashsmith's),
and say when any list was cut at 60. When To Do is empty, note the top three tickets across the
lists before To Do by priority, each with its list's name. In To Do note:
- **QA bounces:** run the CLI's `ticket-state` for the To Do keys. A To Do ticket that has an
  `ai/*` branch was handed off before; `get_task` it, and it is a bounce when its last comment
  starts "QA failed (Hashsmith)";
- the top three other To Do tickets by priority, sorted yourself (any tag: humans' tickets can be
  picked up too).

Also note the working tree (CLI `tree`): uncommitted changes mean a handoff is waiting for the
developer, and Hashsmith cannot switch branches until it is committed. Under
`repo.branch_policy` `current`, `work` never switches and runs on a dirty tree.

## 4. Propose

Show a short status, the lists before To Do first under their own names (`Backlog 3 · To Do 6
(1 QA bounce) · In Progress 0 · Review 2 · QA 1`), then offer the choices that apply, in this
order; the first one that applies is the recommendation. **When the tree is not clean, choice 3
comes first**, and choices 1, 2 and 4 are shown as "needs a clean tree": `work` and `qa` both
stop on uncommitted changes. Under `current`, choices 1 and 4 need no clean tree.

1. **Fix a QA bounce:** `/hashsmith:work <KEY>`. A failed QA blocks the release of that work.
2. **QA what's waiting:** `/hashsmith:qa` for tickets in QA (an open PR, or a pushed commit on
   the base branch). It needs the
   local stack; say so when it is not running.
3. **Finish a handoff:** tickets in Review whose branch has no PR yet. Remind the developer to
   review, commit, push and open a PR; nothing for Hashsmith to do until then.
4. **Work the next ticket:** `/hashsmith:work <KEY>` for the top To Do ticket, naming the next two
   as alternatives. When To Do is empty, the top ticket from the lists before To Do instead,
   naming its list and the next two: choosing any of them is the yes to `move_task` that ticket
   to `lists.todo` (say so in one line), then run `work`. Only on a clean tree: otherwise nothing
   moves.
5. **New requirements:** `/hashsmith:intake`, when the developer has notes, a doc, a Slack thread
   or a meeting to turn into tickets.

Ask in one question with these options and the recommendation's one-line reason. The developer's
free text overrides the menu ("do ACME-9", "intake this: …"). Then run the chosen skill.

When the board is empty (the lists before To Do too) and nothing is waiting, say so and offer
intake.
