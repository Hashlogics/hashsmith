# Golden scenarios (manual, design §13)

Each folder is one scenario: `input.md` describes the repo state, what the developer types and
what HashOps answers; `expected.md` is the checklist the run must meet. Every line is checkable by
reading the transcript or the files.

Run one:

1. Make a scratch fixture repo as `input.md` describes (`git init`, a fake remote, the files it
   names). Never use a real client repo.
2. Start `claude --plugin-dir ~/Sites/hashlogics/hashsmith` in it and type what `input.md` says.
   Scenarios that need HashOps data use a scratch project you own, never a client's.
3. Tick `expected.md`. Any unticked line fails the scenario; a release with a failing scenario is
   not done.
