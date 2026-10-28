# CLAUDE.md — working on Hashsmith itself

This repo is both the `hashlogics` plugin marketplace and the `hashsmith` plugin it lists. The
design and every decision behind it: `docs/design.md` (read the relevant section before changing
behaviour; update it when a decision changes).

## Commands

| Command                                     | What it does                                             |
| ------------------------------------------- | -------------------------------------------------------- |
| `npm test`                                  | Hook tests (`node --test`, no dependencies)              |
| `npm run validate`                          | `claude plugin validate .`: manifests, skills, agents    |
| `claude --plugin-dir ~/Sites/hashlogics/hashsmith` | Try the working copy in a session, without installing |

## Layout

- `.claude-plugin/` — `plugin.json` (name, version) and `marketplace.json` (source `./`).
- `hooks/` — `hooks.json` plus one `.mjs` per hook; shared code in `hooks/lib.mjs`; tests in
  `hooks/__tests__/`. Node only, no npm dependencies, no bash/jq.
- `reference/` — text the hooks and skills load. `conduct.md` is injected into every session.
- `skills/`, `agents/`, `evals/` — arrive with Phases 1–3 (design §15).

## Rules

- **Budgets:** `reference/conduct.md` at most 60 lines; each `SKILL.md` at most 250. A change that
  breaks one shortens something else.
- **Guards fail closed.** A hook that crashes asks (`run()` in `lib.mjs`); it never silently
  allows. A hook with no opinion prints nothing, so the project's own permissions decide.
- **git-guard is an allowlist.** New read-only git commands go into `READ` / `READ_IF`; anything
  not listed is denied. Every change gets a test line in `git-guard.test.mjs`.
- **Rules are checkable.** A rule in a skill or in conduct must be checkable by a command, a grep
  or a file that must exist; otherwise it becomes a template or is cut.
- **No project or client specifics.** This plugin is shared across every Hashlogics project:
  nothing from one project's code, names or data goes into it.
- **Releases:** bump `plugin.json` `version` and add a `CHANGELOG.md` section (`## x.y.z — date`,
  two or three lines for developers); session-start shows teammates the sections newer than the
  version they last saw.
- **Git:** the maintainer commits. Hashsmith's own guardrails apply in this repo too.
