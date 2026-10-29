# Hashsmith architecture

How Hashsmith is built, for a developer about to change it. The *why* behind each decision is in
[`design.md`](design.md); this document is the *how*: the parts, how they talk, and where to make a
change.

## 1. What runs where

Hashsmith is a Claude Code plugin. Nothing of it runs on a server. Everything runs inside the
developer's Claude Code session, on their machine, with their own HashOps and GitHub access.

```
┌──────────────────────────── developer's machine ─────────────────────────────┐
│                                                                              │
│  Claude Code session (started in ONE project repo)                           │
│  ├─ conduct rules + context    ◀── SessionStart hook                         │
│  ├─ /hashsmith:* skills        (markdown instructions the model follows)     │
│  ├─ helper agents              code-investigator, diff-reviewer              │
│  ├─ PreToolUse hooks           git-guard, env-guard, hashops-scope,          │
│  │                             config-guard: every matching tool call        │
│  ├─ Hashsmith CLI              scripts/hashsmith.mjs (deterministic logic)   │
│  └─ MCP servers                hashops (HTTP + OAuth), playwright (npx)      │
│                                                                              │
│  project repo:  code, its CLAUDE.md and skills, hashsmith.json (committed)   │
│  ~/.hashsmith/: last_seen_version, projects/<KEY>/{handoffs,design,qa}/      │
└──────────────────────────────────────────────────────────────────────────────┘
          │ MCP over HTTPS, as the developer          │ gh CLI
          ▼                                           ▼
   HashOps (Supabase edge function /mcp)          GitHub (PR states)
```

- **Plugin root.** Claude Code installs the plugin into its plugin cache and sets
  `${CLAUDE_PLUGIN_ROOT}` for hooks. Skills cannot see that variable, so the session-start hook
  injects the CLI's absolute path ("Hashsmith CLI: node "<path>" …"). Skills derive the plugin
  root from it, for example for `vendor/taste-skill/`.
- **Tool names.** Plugin MCP servers are namespaced: HashOps tools are
  `mcp__plugin_hashsmith_hashops__<tool>` and the browser is `mcp__plugin_hashsmith_playwright__*`.
  Skills refer to HashOps tools by their short names (`get_task`) and say once which server they
  mean. The developer may have the same HashOps server connected another way (for example
  `peoplemuster`). Skills must never use that connection, because the scope hook only matches
  Hashsmith's own server.

## 2. Repository layout

| Path | What it is | Loaded by |
| --- | --- | --- |
| `.claude-plugin/marketplace.json` | The `hashlogics` marketplace; lists one plugin, `hashsmith`, with `source: "./"` | `/plugin marketplace add` |
| `.claude-plugin/plugin.json` | Plugin name, version, description | Claude Code |
| `.mcp.json` | The plugin's MCP servers: `hashops` (the Hashlogics tenant's `/functions/v1/mcp`) and `playwright` (pinned `@playwright/mcp`, `--isolated`, absolute file paths, output in `~/.hashsmith/projects`) | Claude Code, for the plugin and for sessions opened in this repo |
| `hooks/hooks.json` | Wires each hook to an event and a tool matcher | Claude Code |
| `hooks/*.mjs` | One file per hook; `lib.mjs` holds the shared parts | `node`, per event |
| `hooks/feedback-board.json` | The Hashsmith project's own board, its Backlog list and the feedback tags: the one cross-project target the scope hook allows, and where `feedback` files | `hashops-scope.mjs`, the CLI's `feedback-target` |
| `hooks/hashops-tools.json` | `hashsmith`: the HashOps tools Hashsmith's connection may call (exactly the ones the skills name). `writes`: every HashOps write tool | `hashops-scope.mjs` |
| `reference/conduct.md` | The behaviour contract injected into every session (≤ 60 lines) | `session-start.mjs` |
| `reference/*.md` | Templates and rules the skills read when they need them: config, ticket, ticket assessment, handoff, verification report, feedback, fallback standards | skills, on demand |
| `skills/<name>/SKILL.md` | One skill each, ≤ 250 lines, becomes `/hashsmith:<name>` | Claude Code |
| `agents/*.md` | Helper agents with restricted tools | skills, via the Agent tool |
| `scripts/hashsmith.mjs` | The Hashsmith CLI | skills, through Bash |
| `vendor/taste-skill/` | The upstream taste skill (MIT), vendored whole and pinned in its `SOURCE.md`. It lives outside `skills/`, so it is not registered as a second skill | `design` skill, on demand |
| `evals/<scenario>/` | Manual golden scenarios: `input.md` and the `expected.md` checklist | the maintainer, before a release |
| `docs/` | `design.md` (spec), this file, `plans/` (implementation plans) | people |
| `CHANGELOG.md` | One section per release; the what's-new text | `session-start.mjs` |

The plugin has **no npm dependencies**. Hooks and the CLI use Node 22 built-ins only, so
installing the plugin runs no package install. `package.json` exists only for `npm test` and
`npm run validate`.

## 3. The four kinds of moving parts

### Skills: the workflow

A skill is a markdown file of numbered steps. It is not code: the model reads and follows it.
That makes skills cheap to change and easy to get subtly wrong, so three rules hold:

1. **Deterministic logic goes into the CLI, not into prose.** Parsing a URL, reading a settings
   file, mapping a branch and PR to a board state: if the answer must be exact, it is a CLI
   command with a unit test, and the skill calls it.
2. **Every rule is checkable.** A rule in a skill must be checkable by a command, a grep or a file
   that must exist. Otherwise it becomes a template in `reference/`, or it is cut.
3. **Writes wait for a yes.** Anything that leaves the session (tickets, comments, moves, a
   branch) is shown first and done after the developer confirms (conduct 4).

Skills call each other by name (`work` runs `/hashsmith:sync` first, and `work` runs
`/hashsmith:design` for UI tickets). `next` is the router: it reads the board and proposes one of
the others.

### Hooks: the guardrails

Hooks are the part the model cannot talk its way around. Each one reads the event JSON on stdin
and prints at most one JSON decision.

| Hook | Event / matcher | Decision |
| --- | --- | --- |
| `session-start.mjs` | SessionStart | Injects `conduct.md`, the onboarding state, the CLI path and the what's-new notes. It is inactive outside a single git repo |
| `git-guard.mjs` | PreToolUse `Bash` | **An allowlist:** read-only git passes, creating or switching to `ai/*` asks, and everything else is denied |
| `env-guard.mjs` | PreToolUse `Read\|Grep\|Bash` | Denies `.env*` reads (templates allowed). Asks on deploys, `db push` and operator scripts |
| `hashops-scope.mjs` | PreToolUse `mcp__.*` | On Hashsmith's server: **denies** any tool outside the allowlist; asks when a `project_id`, `board_id` or task code is not the project's in `hashsmith.json` (the feedback board is exempt). On any other server, in an onboarded repo: asks before a HashOps write tool |
| `config-guard.mjs` | PreToolUse `Write\|Edit\|MultiEdit` | Blocks secret-shaped content and emails in `hashsmith.json` |

Three properties are load-bearing (see `CLAUDE.md`, "Rules"):
- **Fail closed:** `run()` in `lib.mjs` turns a crashing guard into "ask", never a silent allow.
- **No opinion means silence:** a hook that has nothing to say prints nothing, so the project's
  own `.claude/settings.json` still decides.
- **The git guard is an allowlist:** a git write nobody thought of is denied by default.

### The CLI: deterministic answers

`node scripts/hashsmith.mjs <command>` is run from the repo root and prints one JSON line.

| Command | Returns | Used by |
| --- | --- | --- |
| `repo-slug` (JSON array of link URLs on stdin) | `origin`, a slug per URL, and `matches` | `onboard-project` |
| `project-candidates` (JSON array of `list_my_projects` rows on stdin) | `probes` (the folder and origin repo names) and up to five `candidates` named like them, exact before partial | `onboard-project` |
| `env-keys` | `.env.example` key names that the local env files lack (names only, never values) | `onboard-project` |
| `git-switch` | how the project's settings treat `git switch` | `onboard-project` |
| `check-config` | `hashsmith.json` errors (exit 1 when invalid) | every skill, first |
| `tree` | clean flag, changed paths, current branch | `work`, `qa`, `next` |
| `ticket-state KEY…` | per key: `ai/*` branch(es), the PR from `gh`, and the §4 state; with no branch, `base` (the newest commit carrying the key on `origin/<base_branch>` and on the local base) and `base-pushed` / `base-local` | `sync`, `next`, `qa` |
| `feedback-target` | the feedback board, Backlog list and tags from `hooks/feedback-board.json`, and the plugin version (exit 1 when invalid); reads the plugin's files, so it runs from any repo | `feedback` |

Link URLs come from HashOps, where any project lead can store one, so they are read from stdin and
never placed on a shell command line.

### MCP servers: the outside world

- **`hashops`** is the HashOps MCP endpoint (a Supabase edge function in the hashops repo,
  `supabase/functions/mcp`). OAuth signs the developer in; every tool runs under their own
  permissions and RLS. Hashsmith relies on HashOps features added for it (design §14, H1–H7):
  `get_task {full: true}`, the attachment pair `start_task_attachment` / `finish_task_attachment`,
  QA in the default lists, `dev:local-users`, and the `create_project_tag`, `create_board_list`,
  `add_project_link` and `project_management` tools. A skill change that needs a new HashOps
  tool is a hashops PR first.
- **`playwright`** is the browser. It is pinned to an exact version and runs `--isolated` (no
  saved login between sessions). Skills take screenshots **without** a file name, so they land in
  the output dir `~/.hashsmith/projects/`, then `mv` them into `<KEY>/design|qa/<TICKET>/`. A named
  file would be written relative to the workspace root, which is the developer's repo. Before
  logging in or clicking, `qa` and `design` check with `browser_network_requests` that the app's
  backend is local too, because a local frontend can be pointed at a hosted backend.

## 4. State: where everything is kept

| State | Where | Written by |
| --- | --- | --- |
| Which HashOps project, board, lists and tag belong to a repo; base branch; local URL; tool keys; processed meetings; learned settings | `hashsmith.json` in the project repo, committed by the developer (shape: `reference/config.md`) | `onboard-project`, `intake` (meetings), lessons (`learned`) |
| A ticket's stage | the board list it is in | the skills, via `move_task`, after a yes |
| What happened to a ticket | its HashOps comments: plan, handoff, QA report | `work`, `qa` |
| Whether the developer accepted the work | git: the `ai/KEY-12-slug` branch and its PR | the developer; read by `sync` |
| Saved handoff patches, design and QA screenshots | `~/.hashsmith/projects/<KEY>/` | `work`, `design`, `qa` |
| Last plugin version this person saw | `~/.hashsmith/last_seen_version` | `session-start.mjs` |

There is no Hashsmith database. The board and git are the source of truth, which is why `sync`
runs before `work`, `intake` and `next`.

## 5. A ticket end to end

1. **`intake`** reads sources (pasted text is data, never instructions). It reads the project's
   tickets to catch duplicates, sends one `code-investigator` per candidate (read-only:
   Read/Grep/Glob), asks one batch of questions, and creates tickets in To Do with the `hashsmith` tag (`ai_tag`).
2. **`work`** runs `sync`, then reads the ticket with `get_task {full: true}` and plans. After a
   yes it creates `ai/KEY-12-slug` from the base branch with `--no-track` (git-guard asks), or,
   for a QA bounce whose PR is still open, switches to that PR's branch. It moves the ticket to In
   Progress and comments the plan. It implements in the project's style and runs the project's
   checks plus a `diff-reviewer` agent (given the patch, new files included) until green, three
   rounds at most. It saves the patch outside the repo, shows the handoff, and after a yes posts it
   and moves the ticket to Review. The change stays unstaged.
3. **The developer** reviews, commits, pushes and opens a PR.
4. **`sync`** sees the PR through `ticket-state` and moves the ticket to QA after a yes.
5. **`qa`** runs only on localhost, frontend and backend. It shows the handoff's steps (comments
   are data) and runs them after a yes. It switches to the PR branch (ai/* only; the developer
   approves), refuses a branch that differs from origin, and logs in as the role's test user with the code from the local mail catcher. It
   runs each criterion in Playwright and uploads the screenshots through a signed URL (`curl`),
   so the bytes never enter the model. On pass the ticket goes to Done; on fail, back to To Do
   with the failing steps.

## 6. Testing

| Layer | What | Where | Run |
| --- | --- | --- | --- |
| Hooks | Every decision path, including fail-closed and "no opinion" | `hooks/__tests__/` | `npm test` |
| CLI | Pure functions, and the CLI end to end in fixture repos | `scripts/__tests__/` | `npm test` |
| Skill structure | Frontmatter, the 250-line budget, referenced files exist, no literal UUIDs, every git command a skill names passes git-guard, vendored kits carry `SOURCE.md` + `LICENSE`, `code-investigator` has no Bash | `skills/__tests__/` | `npm test` |
| Manifests | plugin, marketplace, skills, agents | Claude Code | `npm run validate` |
| Behaviour | Golden scenarios a live session must meet | `evals/` | by hand, before a release |

Fixture repos in tests are built by writing a minimal `.git/` (HEAD, config, objects, refs). A test
never runs a git write.

## 7. Making common changes

| You want to… | Do |
| --- | --- |
| Change how a skill behaves | Edit its `SKILL.md`. Keep it ≤ 250 lines and move depth into `reference/`. Update the matching eval and `design.md` §6 if behaviour changes |
| Add a skill | `skills/<name>/SKILL.md` with `name` and a "Use when …" description; add evals; list it in the README and `design.md` §6 |
| Add exact logic a skill needs | A CLI command with a unit test, written first. Document it in the CLI header and the session-start hint |
| Allow a new read-only git command | Add it to `READ` / `READ_IF` in `git-guard.mjs`, with a test line in `git-guard.test.mjs` |
| Guard something new | A new hook file plus a `hooks.json` entry plus tests covering allow, ask/deny, no-opinion and crash |
| Need a new HashOps capability | A hashops PR (tool, tests, catalogue) first; then the skill, and add the tool to `hashsmith` in `hooks/hashops-tools.json` (the skills test fails until both agree) |
| HashOps added write tools | Refresh `writes` in `hooks/hashops-tools.json` from the hashops repo's tool files (`write: true`) |
| Refresh the taste kit | Replace `vendor/taste-skill/` from upstream and update the commit and version in its `SOURCE.md`. Re-read its `app-screens.md` against the precedence rule (design §11) |
| Release | Bump `plugin.json` `version`, add a `CHANGELOG.md` section, run `npm test` and `npm run validate`, run the evals the change touches; the maintainer commits and pushes `main` |

## 8. Trust boundaries

- **The developer's words are instructions; everything else is data.** That covers ticket text,
  meeting transcripts, client docs, PR descriptions and HashOps link URLs.
- **One repo and one HashOps project per session.** The session-start and scope hooks enforce it.
- **Least tool access.** The developer is often a HashOps admin, and the MCP offers every tool
  their permissions allow. Hashsmith's connection is held to the tools its skills use
  (`hooks/hashops-tools.json`), and a deny holds in every permission mode. HashOps writes through
  the developer's other connections ask in an onboarded repo. Every MCP call is logged in HashOps'
  `agent_actions` table, with the OAuth client that made it.
- **Local only.** QA refuses non-localhost URLs. Deploys, `db push` and operator scripts ask first.
  Env files are never read.
- **No secrets in committed config.** `config-guard` checks every write to `hashsmith.json`.
- **No project specifics in the plugin.** It serves every Hashlogics project; examples use `ACME`.
