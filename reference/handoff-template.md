# Handoff comment

Posted on the ticket when `work` moves it to Review (design §8). Plain text, following
`reference/ticket-template.md`'s rules: no Markdown symbols, labels on their own line, `- `
bullets, one line per table row.

```
Handoff (Hashsmith) — branch ai/ACME-12-leave-balance-card, at <short sha of the base>

What changed
- src/path/file.tsx — one line on what and why
- src/path/other.ts — …

How to verify
1. Log in as <role> (<role_key>@example.com on the local stack).
2. Open <route>.
3. <action> → expect <observable result>.
(one numbered step per acceptance criterion; qa runs these)

Screenshots
- ~/.hashsmith/projects/ACME/design/ACME-12/round-2-1440.png (desktop), …-390.png (mobile)
(only for UI tickets; local paths on the implementer's machine, for their review; qa attaches its
own screenshots to the ticket)

Verification: green | red
- tsc -b — pass — 0 errors
- eslint — pass — 0 errors
- unit tests — pass — 412 passed
- diff review — pass — Criteria: 3/3 met
- Sonar, changed files — blocked — Sonar tools not installed
(see reference/verification-report.md for the rules)

Left for the developer
- migrations to apply, env values to set, follow-ups noted but not done

Draft PR description
<title>
<two or three lines on what and why>
Closes ACME-12. Verification: <the lines above, pasted>.

Commit message
feat: leave balance card on the dashboard (ACME-12)
<one to four lines: what changed and why, for git log>

Git
Hashsmith created the branch ai/ACME-12-… from origin/<base> (no upstream set: push it with
git push -u origin HEAD) and ran no other git write. The
change is unstaged: review, commit, push and open a PR into <base>. /hashsmith:next then moves
this ticket to QA.
```

**Commit message**, ready to paste: a conventional commit subject (`feat`, `fix`, `docs`,
`refactor`, `test`, `chore`) ending in every ticket key of the handoff, `(ACME-12, ACME-13)`, then
a short body. The key is not decoration: sync finds base-branch work only by it, and a PR's
squash commit keeps it. A "Handoff updated" comment always carries it again, rewritten to cover
the whole change.

When the developer asked for the work on the base branch itself (no `ai/*` branch), the Git
section says so instead (`ticket-state`'s `base`):

```
Git
Hashsmith created no branch and ran no git write; the developer asked for this on <base>. The
change is unstaged: review it, then commit with the commit message above (keep ACME-12 in it)
and push. /hashsmith:next then moves this ticket to QA.
```
