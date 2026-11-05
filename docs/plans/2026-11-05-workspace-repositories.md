# Workspace mode: one product, several repositories, one session — Plan

**Status:** proposed (2026-11-05, from HSM-11). Not built. 0.7.0 ships the per-repository workflow
instead (README "One product, several repositories"; design §10 item 2).

**Goal:** a developer starts Claude Code in a folder that holds several Git repositories of one
product (one HashOps project and board) and uses every `/hashsmith:*` skill from there. Single
repository onboarding stays the simple default and does not change.

**Why it is a plan, not a change:** session-start (the active/inactive gate) and the HashOps scope
hook find the config by walking up from the session's directory to the nearest `.git`
(`repoRoot` and `readConfig` in `hooks/lib.mjs`). In a workspace there is no `.git` at the root.
Getting that wrong makes an un-onboarded repository count as onboarded, so its HashOps writes stop
asking. git-guard and env-guard judge each command on its own, whatever the repository, and need
no change. Guards fail closed, so this needs its own design review (conduct 8) and its own
release.

## What exists after 0.7.0

- Each repository is onboarded on its own, onto the same project and board.
- Tickets carry `repo:<name>` tags; the CLI's `repo-match` compares them with the repository's
  folder and origin names; the ticket assessment raises a Concern for another repository's
  ticket, and a ticket for several repositories is planned for this one's part only.
- Onboarding from a parent folder lists the child repositories and writes nothing.

## Proposed design

### Config

A workspace `hashsmith.json` at the workspace root:

```jsonc
{
  "hashops": { /* the one shared block: project, board, lists, ai_tag */ },
  "repositories": {
    "acme-api": { "path": "acme-api", "base_branch": "dev", "branch_policy": "managed", "qa": { "base_url": "http://localhost:54321", "mode": "code" } },
    "acme-web": { "path": "acme-web", "base_branch": "dev", "qa": { "base_url": "http://localhost:5173" } }
  }
}
```

- `path` is relative, must resolve (after `realpath`) inside the workspace and hold a `.git`.
- A child repository may keep its own `hashsmith.json`; the workspace file's `hashops` block must
  then match it, or `check-config` fails, and the scope hook asks on every write while they
  disagree (hooks never run `check-config`).
- `repo` (single repository) and `repositories` are mutually exclusive.

### Routing

- A ticket's repositories: its `repo:<name>` tags, matched against the `repositories` keys. No
  tag, or a name that is not a key: ask the developer, and offer to add the tag (`update_task`,
  after a yes).
- Before any change, every skill names the repository and the branch it will use.

### CLI

- Every command that reads git or the tree takes `--repo <name>`, resolved through
  `repositories`. The name on the command line is the `repositories` key copied from
  `hashsmith.json` after matching the ticket's tags (via `repo-match` on stdin), never the tag
  text and never a raw path. Without it, in a workspace, the command fails.
- `ticket-state` and `tree` run once per repository; `sync` merges the results per ticket.

### Guard hooks (the risky part)

- session-start and the scope hook use a workspace config only when the session root **is** the
  workspace root (the folder holding that `hashsmith.json` with `repositories`) or one of its
  listed `path`s. No walking up past the session root: a workspace file in some parent folder
  never makes an unrelated repository under it count as onboarded.
- git-guard and env-guard do not change: they judge every command the same in any repository.
- Tests: session-start and the scope hook get workspace fixtures (the root, a listed child, an
  unlisted repository under the root, a parent folder above the root, a symlinked child, a child
  whose own config disagrees).

### Skills

- `onboard-project`: from a workspace root, onboard the shared `hashops` block once, then each
  repository's `repo` values, writing one workspace file.
- `next`: shows each ticket with its repositories.
- `work`: per repository a branch, a patch, a verification run and a handoff; one Plan comment
  that lists the parts.
- `sync`: reads every repository; a ticket moves to QA only when every part is delivered.
- `qa`: per repository its own QA config; a cross-repository ticket runs every part's stack.

## Follow-up tickets (to file when this plan is approved)

1. CLI: workspace config shape, `check-config`, `--repo` routing (tests first).
2. session-start and the scope hook: workspace config discovery, limited to the root and its
   listed paths, with fixtures.
3. Onboarding a workspace.
4. `next`, `work`, `sync`, `qa` across repositories.
5. Evals for each, run live before the release.
