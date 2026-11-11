# Workspace mode: one product, several repositories, one session — Plan

**Status:** built in 0.8.0 (2026-11-11). Approved with HSM-18, the deferred half of HSM-11, with
each repository keeping its own `hashsmith.json` (below). Slice 1 (the CLI) shipped with HSM-18;
slices 2–5 with HSM-19 to HSM-22. The evals are written; running them live is open (CLAUDE.md).

**Goal:** a developer starts Claude Code in a folder that holds several Git repositories of one
product (one HashOps project and board) and uses every `/hashsmith:*` skill from there. Opening
any onboarded repository directly keeps working on that repository's own `hashsmith.json`, and
single-repository onboarding stays the simple default.

**Why it ships in slices:** session-start (the active/inactive gate) and the HashOps scope hook
find the config by walking up from the session's directory to the nearest `.git` (`repoRoot` and
`readConfig` in `hooks/lib.mjs`). In a workspace there is no `.git` at the root. Getting that wrong
makes an un-onboarded repository count as onboarded, so its HashOps writes stop asking. git-guard
and env-guard judge each command on its own, whatever the repository, and need no change. Guards
fail closed, so the hook change (slice 2) gets its own design review (conduct 8) and its own
release.

## What exists after 0.7.0

- Each repository is onboarded on its own, onto the same project and board.
- Tickets carry `repo:<name>` tags; the CLI's `repo-match` compares them with the repository's
  folder and origin names; the ticket assessment raises a Concern for another repository's
  ticket, and a ticket for several repositories is planned for this one's part only.
- Onboarding from a parent folder lists the child repositories and writes nothing.

## Design

### Config (decided 2026-11-11, HSM-18)

Each repository keeps its **own, complete** `hashsmith.json` (the single-repository shape:
`hashops`, `repo`, `qa`, `changelog`, …), so a session opened in it works as before. The workspace
root gets a small `hashsmith.json` of its own that lists the repositories and holds the shared
block once:

```jsonc
{
  "version": 1,
  "hashops": { /* the shared block: project, board, lists, ai_tag */ },
  "repositories": {
    "acme-api": { "path": "acme-api" },
    "acme-web": { "path": "apps/web" }
  }
}
```

- `repositories` makes a file a workspace file. Its keys are the names `--repo` takes; each value
  is `{path}` and nothing else. `path` is relative, has no `.` or `..` segment, and appears once.
- `repo`, `qa`, `sonar`, `sentry` and `changelog` are rejected in the workspace file: they belong
  to each repository. `intake` and `learned` may sit at the root (one board, one intake record).
- `check-config` at the root also checks the disk: the root is not inside a Git repository;
  every `path` resolves inside the workspace after following symlinks, is the top folder of a Git
  repository of its own, and names no repository another key names; each repository's own
  `hashsmith.json` exists, is
  valid, is not itself a workspace file (no nesting), and has exactly the workspace's
  `project_id`, `project_key`, `board_id`, `ai_tag` and `lists`.
- Why not one workspace file holding every repository's settings (the first draft): the ticket
  asked that each repository stay usable on its own, and two copies of `base_branch` or `qa`
  would drift. Only the `hashops` block is repeated, and `check-config` fails when it differs.

### Routing

- A ticket's repositories: `repo-match` at the root maps its `repo:<name>` tags to the
  `repositories` keys (each key also answers to its folder and origin repo names), lists the
  tags that match none (`unknown`) and those that match several (`ambiguous`). No tag, an unknown
  or an ambiguous one: ask the developer, and offer to add the tag (`update_task`, after a yes).
- Before any change, every skill names the repository and the branch it will use.

### CLI (slice 1, built)

- At a workspace root, `--repo <name>` (anywhere in the arguments, once) runs any command inside
  that repository, on its own `hashsmith.json`. The name is a `repositories` key copied from the
  workspace file after `repo-match`, never tag text and never a raw path; it resolves only when
  the key exists and its path is a Git repository inside the workspace.
- Without `--repo`, only `check-config`, `repo-match`, `lists-before-todo`, `feedback-target` and
  `git-switch` (the root's own settings, which a session there runs under) run at the root; every
  other command fails with the repository names.
- `--repo` elsewhere fails, except in a plain folder of repositories before onboarding (no
  `hashsmith.json`, not inside a repository), where it names a direct child repository. The CLI
  never walks up to find a workspace file.

### Guard hooks (slice 2, the risky part; built)

- session-start and the scope hook use a workspace file only when the session root **is** the
  workspace root (the folder holding a `hashsmith.json` with `repositories`) or one of its listed
  repositories. No walking up past the session root: a workspace file in some parent folder
  never makes an unrelated repository under it count as onboarded.
- At the root, the scope hook checks HashOps calls against the workspace's `hashops` block; a
  repository that is missing, outside the root or whose own block disagrees makes every write
  ask (hooks never run `check-config`; `workspaceProblems` in `hooks/lib.mjs` checks what they
  rely on). A workspace file found at a repository's top is never trusted.
- git-guard and env-guard do not change: they judge every command the same in any repository.
- Tests: session-start and the scope hook get workspace fixtures (the root, a listed child, an
  unlisted repository under the root, a parent folder above the root, a symlinked child, a child
  whose own config disagrees).

### Skills (slices 3 and 4; built, in `reference/workspace.md`)

- `onboard-project`: from a folder of repositories, let the developer pick which to onboard,
  settle the shared `hashops` block once, onboard each picked repository's own `hashsmith.json`
  (as from its own folder), then write every file after one yes and run `check-config` at the
  root. Before the root file exists, the CLI's `--repo <folder>` reaches a direct child
  repository (a plain folder only: no `hashsmith.json`, not inside a repository).
- `next`: shows each ticket with its repositories.
- `work`: per repository a branch, a patch, a verification run and a handoff; one Plan comment
  that lists the parts. Handoff patches are saved per project key and branch name today, so two
  repositories' parts of one ticket would share a file: the patch path gains the repository name.
- `sync`: reads every repository; a ticket moves to QA only when every part is delivered.
- `qa`: per repository its own QA config; a cross-repository ticket runs every part's stack.

## Slices

1. CLI: workspace config shape, `check-config`, `--repo` routing, workspace `repo-match` (tests
   first), and the scope hook ignoring a workspace file meanwhile. **Done in HSM-18.**
2. session-start and the scope hook: workspace config discovery, limited to the root and its
   listed paths, with fixtures. (HSM-19; shipped with slices 3–5 in 0.8.0, at the developer's
   request to complete the module in one batch.)
3. Onboarding a workspace. (HSM-20)
4. `next`, `work`, `sync`, `qa` across repositories, including per-repository handoff patches.
   (HSM-21)
5. Evals for each, run live before the release. (HSM-22; written for 0.8.0, live runs still
   open: they need a scratch workspace on a scratch HashOps project.)
