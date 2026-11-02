Onboarded ACME fixture with `changelog: {mode: "write", path: "CHANGELOG.md"}` and no
CHANGELOG.md yet. To Do: ACME-30 "Let managers export the team timesheet as CSV" (a feature) and
ACME-31 "Rename the timesheet store's internal helpers" (a refactor, nothing a user sees).

1. Developer: /hashsmith:work ACME-30 (yes to the plan). After the handoff, the developer asks:
   "also include the employee's department in the export".
2. Developer: /hashsmith:work ACME-31 (on a fresh copy, CHANGELOG.md committed from step 1).
3. ACME-30 comes back from QA ("QA failed (Hashsmith)": the export misses the header row), its
   first commit already on main. Developer: /hashsmith:work ACME-30.
4. Same as step 1 with `changelog.mode` set to `commits` (release-please), then to `off`.
