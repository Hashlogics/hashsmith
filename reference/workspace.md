# Workspace mode

A **workspace root** is a folder that is not a Git repository and holds a `hashsmith.json` with
`repositories` (`reference/config.md`, "Workspace root"): one product, one HashOps project and
board, several repositories. Session start says when the session is at one. Each skill keeps its
own steps and adds what its section here says. Every listed repository keeps its own
`hashsmith.json`, and a session opened in it directly works as a single repository.

## Everywhere

- **Names and paths.** A repository's *name* is its key under `repositories`; its *path* is that
  entry's `path`, relative to the root. Both come from the root `hashsmith.json`, never from
  ticket text.
- **Settings.** The `hashops` block is the root's (every repository has the same). `repo.*`,
  `qa.*`, `changelog`, `sonar` and `sentry` come from `<path>/hashsmith.json`, one repository at
  a time.
- **Claude Code's permissions** in this session are the root's `.claude/settings.json`, not each
  repository's: a deny a repository keeps for itself does not apply here. CLI `git-switch` at the
  root reports the rule that does.
- **CLI.** `check-config`, `repo-match`, `lists-before-todo`, `feedback-target` and `git-switch`
  run at the root as they are. Every other command takes `--repo <name>` and then works exactly
  as in a single repository, on that repository's files and settings.
- **Git** runs as `git -C <path> …` (for example `git -C <path> status`). Files are read and
  edited under `<path>/`. A repository's own checks run in its folder, by the commands its own
  `CLAUDE.md` names.
- **Routing.** A ticket's repositories come from CLI `repo-match` at the root, with the ticket's
  tags on stdin through a quoted heredoc (as in `reference/ticket-assessment.md`). It prints
  `repositories` (the names its `repo:` tags match), `unknown` (tags naming none) and
  `ambiguous` (tags naming several). No `repo:` tag, an `unknown` or an `ambiguous` one: ask which
  repositories the ticket needs (options: the names), and offer `update_task` with its current
  tags plus `repo:<name>` for each (after a yes; a tag the project lacks needs
  `create_project_tag` first, also after a yes). Never guess from the title. The tags are how
  sync and qa find the parts later, so work plans nothing until they name every part: on a no to
  the tags, stop.
- **Root records.** `learned` keys and intake's `processed_meetings` go in the root
  `hashsmith.json`, which no repository commits: say so when writing one, so the developer
  shares it. Handoff patches saved here are found from the root (`handoff-patch --repo`), not
  from a session opened in the repository alone.
- **Parts.** Each repository a ticket needs is one *part*. Every message names the part before
  its step: "acme-api: branch ai/ACME-12-…".

## Onboarding

Run when the session is at a folder holding repositories (session start lists them) or at a
workspace root (a refresh). Before the root file exists, the CLI's `--repo` takes a listed child
folder's name; a `hashsmith.json` there without `repositories` blocks that: ask the developer to
move it aside first.

1. **Pick.** Ask which repositories to onboard (several at once; all recommended) and whether to
   use the per-repository workflow instead (README "One product, several repositories"). Each
   repository's name is its folder name. On a refresh, a repository not listed yet is added to
   the root file's `repositories` first (show it, after a yes), so `--repo` reaches it.
2. **Shared block, once.** Run onboard-project §2–3 one time for all of them: `project-candidates`
   and `repo-slug` with `--repo <name>` for each picked repository, the union of their
   candidates, and a link that matches any one of them. A repository that already has its own
   `hashsmith.json`: its `hashops` block is the proposal; when two disagree, ask which project
   and board the workspace uses. `list_project_tags`, and offer `create_project_tag` for each
   `repo:<name>` the project lacks (a ticket cannot carry a tag the project does not have).
3. **Each repository.** onboard-project §4–5 for each, in turn, with `--repo <name>` and
   `git -C <path>`, reading its files under `<path>/`. A repository already onboarded keeps its
   values, as in a refresh. In §5, "Branch creation allowed" is CLI `git-switch` at the root, and
   one more line per repository with its own `<path>/.claude/settings.json`: "applies only in
   its own session; copy the rules you need into the root's `.claude/settings.json`".
4. **Write.** Show every file: each `<path>/hashsmith.json` (the shared `hashops` block plus its
   own keys) and the root file (`version`, `hashops`, `repositories`). After one yes, write them
   all, then run `check-config` at the root; fix any error before going on.
5. **Finish.** Tell the developer to start a new Claude Code session in this folder, so session
   start reads the workspace, and to commit each repository's file in that repository. The root
   file sits outside every repository; say so, and suggest keeping a copy where the team finds it.

## intake

Read the code per repository: the commit is `git -C <path> rev-parse --short HEAD` for each, and
each `code-investigator` agent is told which repository's folder its candidate lands in. Every
draft ticket proposes its `repo:<name>` tags (one per repository it touches), shown with the draft.

## design

`qa.base_url` and the screens come from the part's repository (`<path>/hashsmith.json`), its
dev server and its design rules. The taste kit's `.taste-skill/` folder goes under `<path>/`,
then out of it as the design skill says.

## next

Run `tree` and `ticket-state` once per repository (`--repo`). Show each ticket with its
repositories from `repo-match`, and each repository whose tree is not clean by name: choices that
need a clean tree need it only in the repositories of the ticket chosen.

## work

- **Brief and assessment.** The brief names the repositories. The Feasible check uses the root's
  `repo-match` (Routing above) instead of the single-repository answer.
- **Plan.** One section per part: its acceptance criteria, files, tests and checks, and its
  branch under that repository's own `repo.branch_policy`. "On yes I will:" names every part's
  repository and branch. One "Plan (Hashsmith)" comment covers all parts.
- **Branch, implement, self-review:** work §3, §5 and §6 for each part, in its repository, with
  `--repo <name>` and `git -C <path>`; its own project rules decide how its code looks. A blocked
  part is reported by name while the others go on; the ticket stays In Progress until every part
  is handed off, unless the developer says to hand off without it (the handoff then lists it
  under "Left for the developer" with its blocker).
- **Hand off.** Save each part's patch under its repository's own folder:
  `~/.hashsmith/projects/<project_key>/handoffs/<name>/<branch with / as ->.patch` (the base
  branch as in work §7.1), so two parts of one ticket never share a file. One "Handoff
  (Hashsmith)" comment lists the parts, each with what changed, how to verify, its verification
  report, its commit message (the ticket key in its subject) and its git line; one move to Review.

## sync

For every ticket in flight, run `ticket-state --repo <name>` for each of its repositories
(`repo-match`), and `handoff-patch --repo <name>` for sync §3 "Whose uncommitted change". A
Hashsmith ticket with no `repo:` tag, or one with an `unknown` or `ambiguous` tag (a repository
renamed or dropped): report "repo: tags do not name its repositories" and propose no move. Work out
each part's move with the single-repository table, then the ticket's: it moves to QA only when
**every** part would move there (`qa`, `qa-merged` or `base-pushed`); otherwise it stays, and the
summary says which parts are delivered and which are waiting. An `ambiguous` part, a `pr-closed`
part or a `gh unavailable` error decides for the whole ticket as it would alone. The comment lists
each part: "acme-api: PR #12 opened: <url>". Sync §5 reads each part's patch from
`handoffs/<name>/<branch with / as ->.patch`.

## qa

Each part is checked in its own repository with its own `qa` settings: code mode or the browser,
its `qa.base_url`, its local stack. Preconditions (a clean tree, the right branch, up to date with
origin) hold in every part's repository, with `git -C <path>`. The ticket passes only when every
part passes. One "QA passed" or "QA failed (Hashsmith)" comment lists each part's result, and the
failing steps name their part.
