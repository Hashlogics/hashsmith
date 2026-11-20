Onboarded ACME fixture with `preferences: {questions: "normal"}` in hashsmith.json and no
`~/.hashsmith/settings.json`.
Developer types: /hashsmith:onboard, picks "preferences", answers `detailed`, "just for you", then yes.
Run B: `~/.hashsmith/settings.json` holds `{"preferences": {"questions": "normal"}` (a missing brace); same answers.
Run C: `~/.hashsmith/settings.json` holds `{"preferences": {"questions": "normal"}}`; the developer answers `detailed`, "for the team", then yes.
