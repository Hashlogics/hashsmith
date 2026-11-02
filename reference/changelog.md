# Changelog

How Hashsmith keeps a project's changelog (design §6, decided 2026-11-03, HSM-8, HSM-9). The
changelog is for the project's **end users**: what changed for them, in plain English. The
project's own release process owns versions and releases; Hashsmith only adds lines.

## Modes

`hashsmith.json` `changelog.mode`, worked out by the CLI's `changelog` (stored value first, else
the repo's tooling):

| Mode | When | Hashsmith |
| --- | --- | --- |
| `write` | a hand-kept `CHANGELOG.md` / `CHANGES.md` / `HISTORY.md` at the root, or the developer said yes | adds lines under `## Unreleased` in `changelog.path` |
| `commits` | a tool builds the changelog (release-please, semantic-release, conventional-changelog, git-cliff, changesets, …), even next to a file | writes nothing in the changelog; the commit message is the entry. With changesets, which builds it from `.changeset/*.md` files the developer writes, the handoff gives the plain-English line for their changeset (the bump level is theirs to choose) |
| `off` | the developer said no | nothing, and never asks again |

`changelog` prints `ask: true` when nothing is stored and nothing is found. Ask once, recommending
yes: "Keep a plain-English changelog for your users? Hashsmith adds a line for each change they
would notice." Anything but a clear no records `write` with `CHANGELOG.md`; a clear no records
`off`. `changed: true` means write the printed `mode` and `path` to `hashsmith.json` (then
`check-config`) and say so in one line, for example "Changelog: release-please builds it from
commits now; switched to commits".

## Where an entry goes

- One line per change a user would notice; a group can add several. Commit type decides:
  `feat` → Added, `fix` → Fixed, `perf` → Improved (`changelog-check` prints the heading).
  `chore`, `refactor`, `test`, `docs`, `build`, `ci`, `style` and `revert` get none unless the
  developer asks.
- Under `## Unreleased` at the top, below the file's title and intro, in a `### <heading>`
  subsection. Follow the file's own format when it has one (its heading names, bullet style,
  `[Unreleased]`).
- No file yet: create it as `# Changelog`, a blank line, `## Unreleased`, then the subsection.
  No Unreleased section: add one above the newest release.
- One line per change, ever. On a resume, a QA bounce or a change after handoff, read the
  Unreleased section first and rewrite this change's line; a fix to something still under
  Unreleased adds nothing (the handoff says "skipped (already under Unreleased)").

**Never** edit a version field, add or rename a version heading, rename `Unreleased`, or touch
the project's release tooling. Releases belong to the project.

## Wording

Write for someone who uses the product and has never seen the code:

- what they can now do, or what works now that did not; present tense, one sentence;
- no ticket keys, file names, function or table names, code spans, library names or internal
  team names;
- no client names or data.

```
## Unreleased

### Added
- You can now see your remaining leave days on the dashboard.

### Fixed
- Saving a timesheet twice no longer creates two entries.

### Improved
- The team report opens faster for large teams.
```

Not: "Added `LeaveBalanceCard` to Dashboard.tsx (ACME-12)", "Fixed race in useTimesheetStore".

## Checks

`changelog-check <type>` with the patch on stdin (`< "$P"`) prints `needs_entry`, `heading`,
`missing_entry` (a feat, fix or perf that adds no line to the changelog) and `problems`: ticket
keys, file names or code spans in added lines, an added release heading (a version, a date), a
removed section heading or link reference, a changed `version` in the root `package.json`. Other
release tooling (workflows, release configs) is the diff reviewer's to catch. Fix every problem;
write a missing entry unless the line is already under Unreleased. In `commits` or `off` mode it
prints `needs_entry: false`. It reads the whole patch: on the base
branch with other uncommitted work, judge only this change's line.
