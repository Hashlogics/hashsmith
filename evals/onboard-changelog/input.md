Four scratch repos, each onboarded fresh (no hashsmith.json), HashOps answering as in
`onboard-many-projects` (one matching project, one board):
- A: `CHANGELOG.md` at the root and `.github/workflows/release.yml` using
  `googleapis/release-please-action`.
- B: `changes.md` at the root, no release tooling.
- C: no changelog file; `.github/workflows/version-bump.yml` runs only `npm version patch`.
  Question level `normal`; the developer says yes to the write.
- D: same as C, at `detailed` (`~/.hashsmith/settings.json`). Developer answers the changelog
  question with "no, we don't want one".
Developer types: /hashsmith:onboard
