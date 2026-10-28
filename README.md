# Hashsmith

The Hashlogics AI developer: a Claude Code plugin that turns requirements into HashOps tickets,
implements them in the project's own codebase, checks its own work, and keeps the HashOps board in
step. You review every change; Hashsmith never commits, pushes or deploys.

**Status: 0.1.0, guardrails only.** The plugin installs and its safety hooks run; the skills
(`onboard-project`, `intake`, `work`, …) arrive in the next releases. Design:
[`docs/design.md`](docs/design.md).

## Install

In Claude Code:

```
/plugin marketplace add Hashlogics/hashsmith
/plugin install hashsmith@hashlogics
```

The repo is private: you need read access to `github.com/Hashlogics/hashsmith`, with your GitHub
credentials working for `git clone` (SSH key or `gh auth login`).

Turn on auto-update for the `hashlogics` marketplace, or run `/plugin marketplace update
hashlogics` when a release is announced. After a release, your next session starts with a short
"what's new".

## Connect the tools

Run `/mcp` and sign in to `hashops`, the one server Hashsmith declares: Authenticate, then Approve
on the HashOps page. You act as yourself, with your own access (projects, boards, tickets,
comments, files).

Optional, and your own installs (Hashsmith doesn't declare them, so you never run two copies):

| Tool      | What for                                   | How to get it                             |
| --------- | ------------------------------------------ | ----------------------------------------- |
| SonarQube | Issues on changed files during self-review | Your SonarQube MCP server                 |
| Sentry    | Issue details during bug triage            | The official `sentry` Claude Code plugin  |

A tool you don't have is skipped by the skills that need it, and they tell you so. If you also added
HashOps yourself (for example as `peoplemuster` from the in-app Connect dialog), keep it for your
own use: Hashsmith only uses its own `hashops` server, so that its project-scope guard applies.

## Use it

Start Claude Code **inside one project's folder** (not a folder holding several projects; Hashsmith
stays inactive there):

```
cd ~/Sites/hashlogics/<project>
claude
```

The first line of the session says `Hashsmith <version>` and the project's HashOps key once the
project is onboarded.

## What the guardrails do

These hooks run in every session, in every project:

| Hook                | Does                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| `session-start.mjs` | Loads the conduct rules (`reference/conduct.md`), checks the session is one repo, shows what's new      |
| `git-guard.mjs`     | Allows read-only git. Asks before creating or switching to an `ai/*` branch. Denies every other git write |
| `env-guard.mjs`     | Denies reading `.env*` files (templates like `.env.example` are fine). Asks before deploys, `db push`, operator scripts |
| `hashops-scope.mjs` | Asks when a HashOps call reaches a project, board or ticket other than this project's (`hashsmith.json`) |
| `config-guard.mjs`  | Blocks tokens, keys, emails and credential-named keys from `hashsmith.json`, which is committed          |

A project's own `.claude/settings.json` deny rules still win. If a project denies `git switch *`,
move it to `ask` there (keep `git checkout *` denied) so Hashsmith can create its branches.

## Feedback

Tell the maintainer what Hashsmith got wrong. From 0.3 on, `/hashsmith:feedback` files it for you
from inside the session.
