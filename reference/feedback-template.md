# Feedback report template

Every feedback ticket `/hashsmith:feedback` files follows this template (design §12). The rules of
`reference/ticket-template.md` apply: **plain text, not Markdown**, one paragraph per line, section
labels on their own line, bullets as a literal `- `.

**General terms only** (design §10): no client, company, project or person names, no code from the
project, no ids, URLs or data. Write "a React project's service layer", not the project's name and
file. Hashsmith's own files (`skills/work/SKILL.md`) are fine to name: they are the plugin's.

The reporter is set by HashOps (the developer who files it), so the body carries no name.

The title is `[<skill> · <step>] <what should change>`, imperative and short:
`[work · self-review] Rethrow service errors instead of returning null`. Use `[general]` when no
skill applies. Omit a section that would be empty, except What happened and What should have
happened. Add the Duplicate of line only for a duplicate.

```
Hashsmith version: <x.y.z> · Skill: <name or general> · Step: <section or none>
Duplicate of: <KEY-12> — <one line: how this report overlaps it, and what it adds>

What happened
<generalised: what Hashsmith did, or what was missing>

What the developer said
<their words, names and project specifics removed>

What should have happened
<the corrected behaviour>

Proposed change
File: skills/<name>/SKILL.md, section "<heading>"
Before: <the current lines, quoted from the plugin's file>
After: <the replacement>

Why it applies to every project
<one or two lines>

Learned keys in this project (names only)
<key>, <key>
```
