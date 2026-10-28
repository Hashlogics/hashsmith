# Ticket template

Every ticket Hashsmith writes follows this template (design §7).

**Write plain text, not Markdown.** HashOps stores task descriptions and comments as rich-text HTML.
The MCP takes plain text and turns it into HTML: the text is escaped and each line becomes one
paragraph. So:
- `##`, `**` and backticks would show up as literal characters, and are not used;
- section labels go on their own line;
- bullets are a literal `- `, checkboxes a literal `[ ]`;
- a blank line becomes an empty paragraph.

The same rules apply to every comment Hashsmith posts (plan, handoff, QA report). A table becomes
one line per row: `tsc -b — pass — 0 errors`.

The title is short and imperative ("Show leave balance on the dashboard"), never the source's
wording pasted in. Omit a section that would be empty, except Acceptance criteria, which every
ticket has.

```
Source: meeting "Weekly sync" (Oct 27, 2026, id …) | Slack | doc "<name>" | Sentry <id>
Requested by: <name or role>

Problem
<what is wrong or missing, in the requester's terms>

Acceptance criteria
- [ ] …
- [ ] …

Out of scope
- …

Technical notes (Hashsmith, at <short sha>)
- path/to/file.ts:120 — <what is there and why it matters>

Test approach
<what proves it works: unit, DB, browser steps>

Open questions
- …
```
