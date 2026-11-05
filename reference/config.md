# hashsmith.json

A file at the project root, **committed**, so one person's setup serves the whole team. It is a
**cache**: every value can be looked up again from HashOps, git or the code. It never holds a secret,
a token or an email (`config-guard.mjs` blocks them). Validate after every write:

    node "<Hashsmith CLI>" check-config     → {"ok": true}

## Shape

```jsonc
{
  "version": 1,                          // config shape version; Hashsmith migrates older shapes on read
  "hashops": {
    "project_id": "…",
    "project_key": "HOPS",               // task-code prefix; used by the scope hook
    "board_id": "…",
    "lists": { "todo": "…", "in_progress": "…", "review": "…", "qa": "…", "done": "…" },
    "ai_tag": "hashsmith"
  },
  "repo": { "base_branch": "dev", "branch_policy": "managed" },  // base: what ai/* branches are cut from and PRs target; policy: managed | current | confirm
  "qa": { "base_url": "http://localhost:8080", "mode": "browser" },  // mode: browser | code | "" (ask)
  "sonar": { "project_key": "hashlogics_hashops" },
  "sentry": { "project": "…" },
  "changelog": { "mode": "write", "path": "CHANGELOG.md" },  // write | commits | off (reference/changelog.md)
  "intake": {
    "processed_meetings": [
      { "id": "…", "on": "2026-10-27", "tickets": ["HOPS-120", "HOPS-121"] },
      { "id": "…", "on": "2026-10-28", "tickets": [], "note": "nothing actionable" }
    ]
  },
  "learned": {
    "qa_login_route": {
      "value": "/login",
      "why": "QA starts every session here",
      "source": "the auth route in src/App.tsx",
      "added": "2026-10-28"
    }
  }
}
```

## Core keys

The keys above `learned` are **core**. They are defined in `reference/config.md`, and the skills
depend on them.

- **Empty means look it up.** An empty or missing core key is fetched through the MCP or the
  code. If there is exactly one answer, Hashsmith fills it in and says so. If there are several
  (for example two active boards), it asks.
- **Stale counts as empty.** If HashOps no longer has a stored id (a list was deleted, a board was
  completed), Hashsmith treats the key as empty, looks it up again and says what changed. To
  force a refresh, the developer deletes the key.
- **Processed meetings record what each produced**, including "nothing actionable", so the same
  meeting is not processed twice. Every ticket also names its source (§7), and `intake` checks
  the board for existing tickets from the same source. A teammate whose config is behind still
  does not create duplicates.

## Learned keys

Hashsmith may add its own keys under `learned`, so configs differ between projects while the core
stays the same. A learned key is added only when all of these hold:

1. **Reused.** It will be needed again in a later session, not just in this one.
2. **Expensive.** Getting it again would cost a lookup or a question to the developer.
3. **Stable.** It rarely changes.
4. **Not already in a project file.** Hashsmith does not copy `package.json` scripts, `.env.example`
   names or anything else the repo already records, because the copy would drift.
5. **Not a secret and not personal data.** No tokens, passwords, emails or client-identifying
   values. The file is committed.

Each learned key is an object with `value`, `why`, `source` (how to look it up again) and
`added`. Names are snake_case. Before adding a key, Hashsmith checks the core keys and the
existing learned keys for one that already means the same thing. Every addition is announced
in one line ("Saved `qa_login_route` to hashsmith.json: QA needs it every session.").

If a learned value turns out wrong, Hashsmith removes it and looks it up again from `source`.

**Promotion.** Feedback reports (§12) list the names (never the values) of the learned keys in
that project. When the same learned key appears across projects, the maintainer promotes it to a
core key in the next release, and Hashsmith migrates it out of `learned` when it reads the
config (`version` bump).

## Guard

`config-guard.mjs` blocks a write to `hashsmith.json` that contains secret-shaped content: `eyJ…`
JWTs, `sk_`, `ghp_`, `xox[abp]-` and `-----BEGIN` patterns; learned key names containing
`password`, `secret`, `token` or `api_key`; email addresses.

## How each core key is looked up again

| Key | Source |
| --- | --- |
| `hashops.project_id`, `project_key` | the project whose `repository` link matches `repo-slug`'s origin (`list_project_links`), else the developer's pick from `list_my_projects` |
| `hashops.board_id` | the stored id while `get_board` finds it active in the project; else `list_boards {project_id, status: "active"}`: one → use it, several → ask |
| `hashops.lists.*` | `get_board` list names, case-insensitive: To Do / Todo, In Progress, Review, QA, Done |
| `hashops.ai_tag` | `hashsmith`, created with `create_project_tag` when `list_project_tags` lacks it |
| `repo.base_branch` | the PR target in the project's CLAUDE.md, else `git rev-parse --abbrev-ref origin/HEAD` |
| `repo.branch_policy` | asked once: `managed` (default; `""` or missing means managed), `current` or `confirm` |
| `qa.base_url` | `http://localhost:<port>` from the dev script or dev-server config |
| `qa.mode` | `code` when the project has no web UI (no dev server, nothing to open in a browser; `base_url` stays `""`), else `browser`; asked when unclear |
| `sonar.project_key` | `sonar-project.properties`, else `hashlogics_<repo>` |
| `sentry.project` | the Sentry tools' project list, only when the session has them |
| `changelog.mode`, `path` | the CLI's `changelog`: a tool that builds it from commits → `commits`; else a root `CHANGELOG.md` / `CHANGES.md` / `HISTORY.md` → `write`; else one question, where anything but a clear no is `write` (`reference/changelog.md`). A stored `write` turns stale once a generator appears; `off` always stands |

## Migrating `ai_tag` to `hashsmith`

Projects onboarded before 0.5.2 store the old default, ai, as `ai_tag`; it can clash with a
project's own AI tag. To move one over, with the developer's yes at each write, in this order
(retag before switching, so no ticket in flight drops out of `sync` and `qa` halfway):
1. `create_project_tag` with `{project_id, name: "hashsmith"}` when `list_project_tags` lacks it.
2. For every ticket in In Progress, Review or QA, and every QA bounce in To Do, that Hashsmith
   worked (`get_task {task_code, full: true}` shows a "Plan (Hashsmith)" comment): `update_task`
   with its current tags plus `hashsmith` (`tags` replaces all tags; keep the others). Tickets
   that carry the old tag only because a person put it there for the feature are left alone;
   unworked To Do tickets get the new tag when `work` starts them.
3. Set `hashops.ai_tag` to `hashsmith` in `hashsmith.json`, then run `check-config`.
4. The old tag stays on the project (there is no delete tool); remove it in HashOps if nothing
   else uses it.
