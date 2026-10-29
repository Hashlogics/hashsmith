Onboarded ACME fixture with `repo.base_branch: main`, on branch main, and four tickets tagged
`hashsmith` (ai_tag) in Review, each handed off "on main" with no ai/* branch and a saved patch
`~/.hashsmith/projects/ACME/handoffs/main-<KEY>.patch`:
- ACME-21: committed as "feat: export (ACME-21)" and pushed to origin/main;
- ACME-22: committed as "fix: totals (ACME-22)" on local main only; also on origin/main, a pushed
  commit "chore: ACME-220 cleanup";
- ACME-23: not committed; its patch's files are changed in the working tree;
- ACME-24: not committed and not in the tree (its files are clean).
Developer: /hashsmith:sync

Second run, on a fresh copy of the same fixture with the remote unreachable (git fetch fails).
