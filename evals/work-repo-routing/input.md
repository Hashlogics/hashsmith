Fixture: repo folder `acme-web` (origin `git@github.com:acme/acme-web.git`), onboarded onto the ACME project and board. Three To Do tickets: ACME-40 tagged `repo:acme-api`; ACME-41 tagged `repo:acme-web` and `repo:acme-api`; ACME-42 with no `repo:` tag.
Developer: /hashsmith:work ACME-40, then /hashsmith:work ACME-41, then /hashsmith:work ACME-42, answering "no, skip it" to each brief or plan, so no run branches or changes the tree.
This is the per-repository workflow: the session runs in `acme-web`'s own folder, not at a workspace root.
