---
name: onboard-project
description: Use when the session's repo has no hashsmith.json, when the developer asks to set Hashsmith up for this project, or when ids in hashsmith.json are stale.
---

# Onboard a project

Connect this repo to its HashOps project and board, check that the machine is ready for Hashsmith
work, and write `hashsmith.json` (`reference/config.md`). Follow the conduct rules throughout:
look things up before asking, ask in one batch with a recommendation, and write nothing until the
developer says yes.

Tools: HashOps calls are the `mcp__plugin_hashsmith_hashops__*` tools (`list_my_projects` below
means `mcp__plugin_hashsmith_hashops__list_my_projects`). Never use another connection to the same
server. "The CLI" is the `Hashsmith CLI` line in your session context; run it from the repo root.

## 1. Scope

Run `git rev-parse --show-toplevel`. It must equal the session's working directory. If not, stop:
Hashsmith works in one repo per session (conduct 9); tell the developer to start Claude Code in the
repo's own folder.

If `hashsmith.json` exists, this run is a **refresh**:
- Run the CLI's `check-config`. Not ok (bad JSON, merge-conflict markers, a malformed key): show
  the errors and ask how to fix them. Never overwrite the file to get past them.
- Check the stored values before looking anything up: `get_board` on `hashops.board_id` must exist,
  belong to `hashops.project_id`, be active, and still hold every stored list id. Then skip the
  steps below for the values that pass; never ask about them again (conduct 2). Re-look-up only
  keys that are empty or stale.
- Keep `learned` and `intake` exactly as they are, and keep `sonar` and `sentry` values this
  session cannot check (no tools for them).
- At the end, show each changed key as `key: old → new`.

## 2. HashOps project

1. Call `list_my_projects`. If the call fails for authentication or the tool does not exist, stop:
   "Run `/mcp`, choose `plugin:hashsmith:hashops`, Authenticate, then Approve on the HashOps page.
   Then run `/hashsmith:onboard-project` again." Write nothing.
2. **Candidates first.** Pass the projects (`id`, `name`, `key` of each row) to the CLI's
   `project-candidates` as a JSON array on stdin, through a quoted heredoc so no name is ever on
   the command line: `node "<cli>" project-candidates <<'EOF'` / `[{"id": …}, …]` / `EOF`. It
   prints `candidates`: up to five projects named like this repo's folder or origin, best first.
3. For each candidate, call `list_project_links` with `{project_id, limit: 50}` and keep the
   `repository` links. Pass all their URLs to one CLI call as a JSON array on stdin, in the same
   way: `node "<cli>" repo-slug <<'EOF'` / `["https://…", "https://…"]` / `EOF`. It prints
   `origin` (this repo), a slug per URL, and `matches`: the URLs that are this repo. When no
   candidate's link is in `matches` (or there are no candidates), do the same once more for the
   projects not checked yet. Say which round matched ("checked 2 likely projects, then the other
   39").
4. Exactly one project has a URL in `matches`: say "Matched <name> (<key>) from its repository
   link" and confirm it. Several: ask which, listing them as `Name (KEY)`. None: ask, listing
   `candidates` as `Name (KEY)` with the first recommended, or another project's name or key
   (with no candidates, ask only for that). A CLI `error`: show it, fix the input, run it again.
5. If the chosen project has no link in `matches` and `origin` is not null, offer
   `add_project_link` with `type: "repository"` and `https://<origin>`, so the next onboarding
   matches by itself. When `origin` is null (no remote, or an SSH host alias), ask the developer
   for the repository's web URL instead.

## 3. Board, lists and tag

1. `list_boards` with `{project_id, status: "active"}`. One board: use it and say so. Several:
   ask, listing them in the order returned, with no recommendation unless a name says which is
   current. None: project management may be off for the project (boards are then hidden, and
   boards, lists and tags cannot be created). Propose `update_project` with
   `{project_id, project_management: true}`, then `list_boards` again; if there is still none,
   propose `create_board` (default lists include QA).
2. `get_board`. Map its lists by case-insensitive name: `todo` ← "To Do" or "Todo",
   `in_progress` ← "In Progress", `review` ← "Review", `qa` ← "QA", `done` ← "Done". Ask about
   any key with no clear match, offering the board's actual list names.
3. No QA list: offer `create_board_list` with `{board_id, name: "QA", type: "active",
   color: "cyan", before_list_id: <the Done list's id>}`.
4. `ai_tag` is `hashsmith` (a fresh onboard always proposes it; a refresh keeps the stored name).
   A short, generic tag clashes with a project's own AI feature tag, and sync would then
   manage tickets Hashsmith never touched. `list_project_tags`; when the tag is missing, offer
   `create_project_tag` with `{project_id, name: <ai_tag>}`. Every Hashsmith ticket carries it,
   and `create_task` needs at least one tag. A refresh that finds the old default (ai)
   offers the migration in `reference/config.md`, never runs it unasked; a custom name stays.

The writes in this section need a project lead (or the right HashOps permission). A refusal is not
an error to retry: note it, carry on, and list it under "ask a project lead" in Finish.

## 4. Repo, QA and tool keys

- `repo.base_branch`: the branch the project's `CLAUDE.md` says PRs target. Otherwise
  `git rev-parse --abbrev-ref origin/HEAD` without the `origin/`; when that fails (no
  `origin/HEAD`), ask. Ask too if the two disagree.
- `qa.base_url`: `http://localhost:<port>` from the dev script in `package.json` or the
  dev-server config (for example the Vite `server.port`). Ask if neither names a port.
- `qa.mode`: `browser` with a `base_url`. A project with no web UI (no dev server, nothing to
  open in a browser: a CLI, a library, a plugin) gets `"qa": {"base_url": "", "mode": "code"}`,
  so `qa` checks its code and tests instead; ask when unsure.
- `sonar.project_key`: `sonar.projectKey` from `sonar-project.properties`, else propose
  `hashlogics_<repo folder name>`.
- `sentry.project`: only when the session has Sentry MCP tools; find it with them. Otherwise
  leave the key out and say "Sentry: not installed (optional)".
- `changelog`: the CLI's `changelog` (`reference/changelog.md`). It prints the stored mode, or
  what the repo shows: a tool that builds it from commits → `commits` ("Changelog: built by
  <generator>"), a changelog file → `write` ("Changelog: Hashsmith adds lines to <path>"). On `ask: true`, put the question in this step's
  batch, recommending yes; anything but a clear no records `write` with its `path`, a clear no
  records `off`. On `changed` (a stored `write` now meeting a generator), record it and say so.
  Nothing is created now: the first entry creates the file.

## 5. Readiness report

Run each check and print one line per check: `<check> — pass | fail | blocked — <detail>`.
Blocked means it could not run; it is never a pass (conduct 7).

| Check | How |
| --- | --- |
| Project CLAUDE.md | `test -f CLAUDE.md` |
| Verification chain | a ship-check skill in `.claude/skills/`, or a `test` script in `package.json` |
| Branch creation allowed | CLI `git-switch`: `ask` passes; `deny` fails: "move `Bash(git switch *)` from deny to ask in `.claude/settings.json`; keep `git checkout *` denied" |
| Local stack | only if `supabase/config.toml` exists: `npx supabase status` exits 0; otherwise blocked with "run `npx supabase start`" |
| Env keys | CLI `env-keys`: list missing names as "check these" (never read env files yourself) |
| Test users per role | with `qa.mode` `code`: "not needed (qa.mode code)". Otherwise the project's seeding script (for example `npm run dev:local-users`) is named; blocked until it has been run on the current local database |
| Mail catcher | with `qa.mode` `code`: "not needed (qa.mode code)". Otherwise the mail URL from `npx supabase status` answers `curl -sf` |
| MCPs | hashops: pass. Browser (Playwright tools present): needed by design and by qa in browser mode. SonarQube and Sentry: "installed" or "not installed (optional)" |

If the project has no `CLAUDE.md`, offer to draft one from the code as it is (structure, commands,
patterns you can point at). Never draft it from `reference/standards.md`: a draft describes the
project, it does not restructure it.

## 6. Write the config

1. Show the complete JSON (and, on a refresh, the `old → new` lines).
2. After a yes, write `hashsmith.json` at the repo root, two-space indented, keys in the order of
   `reference/config.md`. Then run the CLI's `check-config`; fix any error before going on.
3. Say that the file is unstaged and the developer commits it with their normal PR (Hashsmith
   never commits).

## 7. Finish

List what the developer still has to do (each failed or blocked check, with its fix), then propose
the next step: `/hashsmith:intake` to turn requirements into tickets, or `/hashsmith:next`.
