# Verification report

Every handoff carries one (design §8). Each check is one line: `<check> — pass | fail | blocked —
<evidence>`, plain text in the ticket comment; a table is fine in the chat.

Checks, in this order, each only if the project has it:
1. The project's own chain first: its `ship-check` skill or the commands its `CLAUDE.md` names
   (types, lint, unit tests, build, DB/permission suite when the change touches the schema or
   access rules).
2. Otherwise the detected chain: `package.json` scripts for typecheck, lint, test, build.
3. Sonar on the changed files, when SonarQube MCP tools are in the session.
4. The `diff-reviewer` agent: `Criteria: n/m met` and its findings.
5. For UI tickets, the design visual check (`/hashsmith:design`).

Rules:
- **Overall: green or red.** Red when any check fails.
- **Blocked is not green.** A check that cannot run (service down, tool missing) is blocked, with
  what to start. Blocked items are listed as unverified, and the work is never called fully
  verified while any remain.
- **No check is skipped because it "obviously" passes.** Every line comes from a command that ran
  in this session, with its real output summarised (counts, first error).
- **Earlier failures are named, never hidden.** A failure that exists on the base branch too is
  labelled "pre-existing", with the evidence (the failing file is not in the diff, and its error
  is unrelated to the change), not hidden and not silently fixed. Never stash or switch branches
  to prove it.
