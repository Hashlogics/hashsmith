# Hashsmith

> **Internal tool.** Hashsmith is built by Hashlogics for Hashlogics' own use. It is not a product,
> it is not supported outside Hashlogics, and the repository is private. It works only with the
> Hashlogics HashOps workspace.

Hashsmith is the Hashlogics AI developer. It is a [Claude Code](https://claude.com/claude-code)
plugin that takes work from requirements to a reviewed pull request, keeping the HashOps board in
step at every stage:

- **Requirements → tickets.** Paste notes, a client doc or a Slack thread, or name a HashOps
  meeting. Hashsmith reads the code, asks its questions once, and creates clear tickets in To Do.
- **Tickets → code.** It plans a ticket, waits for your yes, implements it in the project's own
  style, runs the project's checks until green, and hands the change to you, unstaged.
- **Code → QA.** Once your PR is open, it runs the ticket's checks in a real browser on your local
  app, attaches screenshots to the ticket, and moves it to Done or back to To Do.
- **The board follows along.** Every ticket it touches moves through To Do → In Progress → Review
  → QA → Done, with a comment at each step.

**You stay in charge.** Hashsmith never commits, pushes, deploys or touches a real environment. You
review every change and do the commit, the push and the PR yourself.

**Status: 0.4.0** (`onboard-project`, `intake`, `next`, `work`, `sync`, `design`, `qa`). Next:
`feedback` and `triage`. Changes: [`CHANGELOG.md`](CHANGELOG.md).

## How it fits together

```
 you ──▶ Claude Code + Hashsmith plugin ──▶ HashOps (MCP: projects, boards, tickets, comments, files)
              │            │
              │            └──▶ your project's repo (code, its CLAUDE.md, its checks, git read-only)
              └──▶ browser (Playwright: design screenshots, QA on localhost)
```

- **The plugin** adds `/hashsmith:*` commands, two helper agents, guardrail hooks and two MCP
  servers to every Claude Code session.
- **This repo is also a marketplace**, named `hashlogics`: a Git repo that lists plugins. Claude
  Code installs from it with your own GitHub access; there is no server and nothing is published.
- **Each project has a `hashsmith.json`**, committed in that project's repo. It links the repo to its
  HashOps project, board and lists, so nobody has to say which board to use.

## Before you start

| You need | Check |
| --- | --- |
| Claude Code | `claude --version` |
| Node.js 22 or newer | `node --version` |
| Read access to `github.com/Hashlogics/hashsmith` (private), and git credentials that can clone it | `git ls-remote git@github.com:Hashlogics/hashsmith.git` |
| The GitHub CLI, signed in (Hashsmith reads PR states with it) | `gh auth status` |
| A HashOps account in the Hashlogics workspace | you can sign in to HashOps |
| For QA and design screenshots: the project's local stack runs on your machine | the project's own setup docs |

## Set it up (once per machine)

1. **Add the marketplace and install the plugin.** In Claude Code:
   ```
   /plugin marketplace add Hashlogics/hashsmith
   /plugin install hashsmith@hashlogics
   ```
   Turn on auto-update for the `hashlogics` marketplace when Claude Code offers it.
2. **Install the browser** that design and QA use:
   ```
   npx playwright install chromium
   ```
3. **Sign in to HashOps for Hashsmith.** Run `/mcp`, choose `plugin:hashsmith:hashops`,
   Authenticate, then Approve on the HashOps page. You act as yourself, with your own HashOps
   access. You need this even if you already connected HashOps another way (for example
   `peoplemuster` from the in-app Connect dialog): Hashsmith has its own connection, so that its
   project guard applies. Keep the other one for your own use.
4. **Restart Claude Code.** The first line of a new session says `Hashsmith 0.4.0`.

Optional tools you install yourself (Hashsmith does not declare them, so you never run two
copies): a SonarQube MCP server (issues on changed files during self-review) and the official
`sentry` plugin (issue details). A skill that wants a tool you don't have skips that check and
says so.

## Set up a project (once per project)

1. Start Claude Code **inside the project's own folder**, not in a folder holding several
   projects (Hashsmith stays inactive there):
   ```
   cd ~/Sites/hashlogics/<project>
   claude
   ```
2. Run `/hashsmith:onboard-project`. It:
   - finds the project's HashOps project from its repository link, and its active board;
   - maps the board's lists, offering to add a **QA** list and an **`ai`** tag if they are missing;
   - fills in the base branch, the local URL and the tool keys;
   - checks your machine and prints a readiness report: pass, fail or blocked for each item, with
     the fix;
   - shows `hashsmith.json` and writes it after your yes.
3. Commit `hashsmith.json` with your next PR. Teammates then skip the lookup.

If the project's `.claude/settings.json` denies `git switch`, move `Bash(git switch *)` from deny to
ask (keep `git checkout *` denied), so Hashsmith can create its `ai/*` branches. Onboarding tells
you when that is needed.

## Use it every day

Start Claude Code in the project and run **`/hashsmith:next`**. That is the one command to
remember: it brings the board in step with git and proposes the most useful next step. You can
always just say what you want instead.

| Command | What it does |
| --- | --- |
| `/hashsmith:next` | Reads the board and proposes, in this order: fix a QA bounce, QA what's waiting, finish a handoff, work the next ticket, or intake |
| `/hashsmith:intake` | Paste notes, a doc or a Slack thread, or name a HashOps meeting. Hashsmith reads the code, checks the board for duplicates, asks its questions once, shows draft tickets, and creates them in To Do after your yes |
| `/hashsmith:work [KEY-12]` | Plans the ticket and waits for your yes. Then it creates `ai/KEY-12-…` (you approve), implements, runs the project's checks and a fresh-eyes review until green, and hands off in Review with the change unstaged |
| `/hashsmith:sync` | Moves tickets to match git, after your yes: Review → QA once the PR is open |
| `/hashsmith:design` | Designs or polishes a screen. Your project's design rules come first, then your own, then Hashsmith's taste kit. It takes screenshots at desktop and mobile widths and does up to three critique rounds. `work` runs it for UI tickets |
| `/hashsmith:qa [KEY-12]` | On your local app only: switches to the PR branch (you approve) and logs in as the right test user. Then it runs each acceptance criterion with screenshots attached to the ticket, and moves the ticket to Done or back to To Do with the failing steps |
| `/hashsmith:onboard-project` | Set up or refresh the project's `hashsmith.json` |

### A ticket's life

```
notes, docs, meetings ──/intake──▶ To Do
To Do ──/work──▶ In Progress ──checks green──▶ Review        (handoff comment, branch ai/KEY-12-slug)
Review ──you commit, push, open a PR──▶ /sync ──▶ QA
QA ──/qa passes──▶ Done
QA ──/qa fails──▶ To Do                                       (the failing steps; /work fixes them first)
```

Hashsmith works on one uncommitted batch at a time. It starts a new branch only on a clean
working tree, because your uncommitted change would otherwise follow it to the new branch.

## What the guardrails do

These hooks run in every session, in every project, whatever you ask:

| Hook | Does |
| --- | --- |
| `session-start.mjs` | Loads the conduct rules, checks the session is one repo, shows what's new since your last version |
| `git-guard.mjs` | Allows read-only git. Asks before creating or switching to an `ai/*` branch. Denies every other git write |
| `env-guard.mjs` | Denies reading `.env*` files (templates such as `.env.example` are fine). Asks before deploys, `db push` and operator scripts |
| `hashops-scope.mjs` | Lets Hashsmith's HashOps connection call only the ~20 tools its skills use: approvals, people, HR records, policies and the rest are denied, even for admins. Asks when a call reaches a project, board or ticket other than this project's, and before a HashOps write through your own connection (for example `peoplemuster`) in an onboarded repo |
| `config-guard.mjs` | Blocks tokens, keys, emails and credential-named keys from `hashsmith.json`, which is committed |

A project's own `.claude/settings.json` deny rules still win.

## Updates

When a release is announced, update with auto-update or `/plugin marketplace update hashlogics`.
Your next session starts with a short "what's new".

## Troubleshooting

| You see | Do |
| --- | --- |
| "Hashsmith … is inactive" | Start Claude Code in the project's own folder |
| "Run `/mcp`, choose `plugin:hashsmith:hashops`…" | Sign in again (step 3 above) |
| A readiness check is **blocked** | It could not run; the report says what to start (for example the local stack) |
| A `git switch` is denied | The project denies it: see "Set up a project" |
| HashOps says a write tool doesn't exist, or writes stop working | Your Connected apps level for this connection is Read only: in HashOps, open your profile → Connected apps and set Claude Code to **Work** |
| A HashOps call asks "reaches outside this project" | Say no unless you meant it. If `hashsmith.json` is stale, run `/hashsmith:onboard-project` |
| Design or QA says the browser is missing | `npx playwright install chromium`, then restart Claude Code |

## Feedback

Tell the maintainer what Hashsmith got wrong. A later release adds `/hashsmith:feedback`, which files
it for you from inside the session.

## Working on Hashsmith itself

Start with [`CLAUDE.md`](CLAUDE.md) (commands, rules, open work), then
[`docs/architecture.md`](docs/architecture.md) (how the pieces fit) and
[`docs/design.md`](docs/design.md) (the spec and every decision behind it).
