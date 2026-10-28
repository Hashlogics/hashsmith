---
name: design
description: Use when a Hashsmith ticket adds or changes UI (a page, screen, component, dialog or layout), or the developer asks Hashsmith to design, redesign or polish a screen.
---

# Design UI to a high bar

Build UI that looks decided, not generated, and prove it with screenshots. The `work` skill calls
this for every ticket that touches UI; the developer can also call it directly.

## 1. Find the design sources, in precedence order

Collect them before writing any UI, and print one line: `Design sources: …` naming each one used.

1. **The codebase (always wins).** Its UI rules in `CLAUDE.md`, the docs it points to (page
   layout, conventions) and the UI or design skills **it names** (read those whole). Its existing
   primitives and tokens (`src/components/ui/`, the Tailwind config or theme file, shared layout
   components). Read two or three existing screens near the one you are changing and note their
   card, header, spacing, colour and icon treatment. **Existing screens win any conflict**: they
   are what the project actually looks like. Other design skills under `.claude/skills/` that
   `CLAUDE.md` does not name are style kits, not rules: consult one only for a gap the above
   leaves, and never let one restyle the project's look.
2. **The developer's own skills.** Design skills in `~/.claude/skills/` count as the developer's
   notes (conduct 6): they override Hashsmith's defaults, never the project's rules.
3. **Hashsmith's bundled taste kit** (fallback): the vendored skill at `<plugin root>/vendor/taste-skill/`,
   where `<plugin root>` is the `Hashsmith CLI` path from your session context without
   `/scripts/hashsmith.mjs`. Its `SKILL.md` is the method; `references/app-screens.md` is for screens
   people work in (dashboards, admin, settings, lists, forms); `references/critique.md` and
   `references/tells.md` are how you judge.

**When they disagree, the higher source wins, point by point.** Example: the taste kit says no icons
in tinted squares and no card shadows, but a project whose conventions use icon-chip headers and
soft-shadow cards keeps them. The taste kit still governs what the project leaves open:
hierarchy, what the first screen shows, density, alignment, copy, empty, loading and error states,
honest data. Say which points came from where when it matters.

**Scope.** Change only what the ticket asks. Never restyle screens or components it does not
touch, even when the taste kit would; note such issues as a follow-up instead.

## 2. Decide the approach

- **The project has a design system** (skills, conventions or a primitive library): no new
  direction. Compose from its primitives first; build a new component only when none fits, in the
  same style. Use the taste kit's app-screen and critique rules for the decisions the system leaves
  open.
- **The project has no design system** (a new app or page): follow the taste kit's run in its
  `SKILL.md` ("Page or app screen", then "The run" or `references/app-screens.md`). Its scripts need
  Node 22 and an installed Chrome; run them from the repo root as `node <plugin root>/vendor/taste-skill/scripts/<script> …`.
  Its working files go to `.taste-skill/` in the repo; when you finish, move that folder to
  `~/.hashsmith/projects/<project_key>/design/<TICKET>/` (plain `mv`) so nothing lands in the
  developer's diff. State the direction in one line in your report; `work` puts it in the handoff.

Before building, state the screen's one question (what the user comes to answer or do) and what
the first viewport must show. Use real-looking data that adds up; never lorem or vanity numbers.

## 3. Build, then look

1. Make the change, following the project's component, state and access rules (its `ui-conventions`
   style skill if it has one: dialogs, toasts, dates, readonly props, permission checks).
2. Start the dev server in the background if it is not running (the project's dev script; the URL
   is `qa.base_url` from `hashsmith.json`, always local). Check the backend is local the way the
   `qa` skill's step 2.6 does, before logging in or clicking anything.
3. Open the screen with the Playwright tools (`mcp__plugin_hashsmith_playwright__*`):
   `browser_navigate` to `qa.base_url` plus the route. If it needs a login, follow the `qa`
   skill's "Log in as the right role" steps; if those are blocked, ask the developer to log in once
   in the Playwright browser window, then continue.
4. Screenshot at 1440 and 390 wide: `browser_resize`, then `browser_take_screenshot` **without** a
   `filename` (a named file would land in the repo). It is saved under `~/.hashsmith/projects/` and
   the result gives its absolute path; `mkdir -p` and `mv` it to
   `~/.hashsmith/projects/<project_key>/design/<TICKET>/round-<n>-<width>.png`. Also capture the
   empty, loading and error states the change can show, when reachable.
5. For a public page with no login, also run the taste kit's gate:
   `node <plugin root>/vendor/taste-skill/scripts/inspect.mjs <url>` (add `--app` for an app
   screen) and fix every FAIL. It writes `.taste-skill/` into the repo: move that folder out as in
   step 2 when you finish, on every path.

If Playwright tools are missing, report the visual check as **blocked** (conduct 7) with "add the
Playwright MCP (`/mcp`) and run `npx playwright install chromium`", and do not call the UI verified.

## 4. Critique and fix

Read your screenshots (the Read tool shows images) and critique them with the taste kit's
`references/critique.md` passes, plus one more pass: **does it match the project?** Compare with the
two or three neighbouring screens you read in step 1: same cards, headers, spacing, colours, icon
style, type scale.

Write the critique in a few lines: the top three problems, each with the screenshot it shows in.
Fix them, screenshot again (round 2), look again. **Three rounds at most.** Stop earlier when a
round finds nothing that matters.

## 5. Report

Return to the caller (or the developer):
- `Design sources:` the line from step 1;
- the final screenshots' paths, desktop and mobile;
- what was fixed in each round, one line each;
- remaining gaps you saw but did not fix, and why (out of scope, needs a product decision);
- the visual check's status: pass, or blocked with the reason.

`work` puts the screenshot paths and the remaining gaps in the handoff, so the reviewer sees the
UI before reading the diff.
