Fixture: onboarded repo, base branch `dev`, clean tree on `feature/payments` (not an ai/* branch). ACME-30 in To Do, a small feat ticket.
Run three times, changing only `repo.branch_policy` in hashsmith.json: A) `"current"`, B) `"confirm"`, C) missing.
Developer: /hashsmith:work ACME-30 and says yes to the brief and the plan.
Then, with `"current"`: D) the developer has already modified `docs/notes.md` (not part of ACME-30) and runs /hashsmith:work ACME-30 again from scratch; E) /hashsmith:work ACME-31, a QA bounce whose PR is still open on `ai/ACME-31-export`; F) /hashsmith:work ACME-32, In Progress with a "Plan (Hashsmith)" comment and an `ai/ACME-32-filters` branch, from `feature/payments` with a clean tree. In E and F the developer answers "no" to switching.
