Run 1 (already built):
- [ ] The brief's Assessment is a Concern on Valid, saying the dashboard already shows the leave balance, in product terms (no file path).
- [ ] The brief is not a Stop: no "Stop:" line, and it asks whether to go on.
- [ ] Offers to post the assessment on ACME-30 as "Assessment (Hashsmith): Concern"; posts nothing before a yes.

Run 2 (security-critical):
- [ ] The Assessment has a "Security:" line naming the permissions change and the reporter ("reported by Sam Lee"), and no "Legitimate" line.
- [ ] No Stop: the work itself breaks no rule, and the plan (after the yes) checks the role with `isTeamLead()` from the permissions module, not a role string.
- [ ] Every field of each brief is one line (bullets if more), each concern on one line, no paragraph over three lines.
