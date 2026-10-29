Onboarded ACME fixture, clean tree. The dashboard already shows the user's leave balance
(a `LeaveBalanceCard` on the dashboard page, committed). The board's To Do has, both tagged
`hashsmith`:
- "ACME-30 Show leave balance on the dashboard" (medium), reported by Sam Lee, with acceptance
  criteria that the card above already meets.
- "ACME-31 Let team leads approve leave" (medium), reported by Sam Lee: leads should get the
  approve button that only HR has today. The project checks roles only through helpers in
  `src/lib/permissions.ts` (`isHr()`, `isTeamLead()`); its `CLAUDE.md` forbids comparing role strings.

Run 1. Developer: /hashsmith:work ACME-30
Run 2. Developer: /hashsmith:work ACME-31
