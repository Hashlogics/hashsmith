#!/usr/bin/env node
// The Hashsmith CLI: the deterministic parts of the skills, so they never rest on the model's
// reading of a URL, a settings file or a git state. Runs at the repo's top level from any subfolder;
// prints one JSON line.
// The session-start hook gives skills this file's absolute path.
//
//   repo-slug            origin and the link URLs (a JSON array on stdin) as slugs, and which match
//   project-candidates   the projects (list_my_projects rows, a JSON array on stdin) named like this repo, best first
//   lists-before-todo    the board's active lists before To Do (get_board's lists on stdin), not mapped in hashsmith.json
//   repo-match           a ticket's repo:<name> tags (its tags on stdin) against this repo's names
//   env-keys             .env.example key names that .env / .env.local lack (names only, never values)
//   git-switch           how .claude/settings(.local).json treat `git switch`
//   check-config         validate hashsmith.json (exit 1 when invalid)
//   tree                 working-tree state and current branch
//   ticket-state KEY...  each ticket's ai/* branch (local or on origin) and PR, mapped to the design §4 states;
//                        with no branch, commits carrying the key on repo.base_branch (base-pushed / base-local)
//   handoff-patch KEY... each ticket's newest saved base- or other-branch patch under ~/.hashsmith, and its branch
//   feedback-target      the Hashsmith feedback board, list and tags, and the plugin version (exit 1 when invalid)
//   changelog            how this project keeps its changelog: stored in hashsmith.json, else detected (names only)
//   changelog-check TYPE the commit type's changelog heading, and what the patch on stdin does to the changelog
//
// At a workspace root (a hashsmith.json with `repositories`, docs/plans/2026-11-05-workspace-repositories.md),
// `--repo <name>` runs any command inside that listed repository, on its own hashsmith.json. Without it
// only check-config (the whole workspace), repo-match (a ticket's tags → repository names),
// lists-before-todo, feedback-target and git-switch (the root's own settings) run there; the rest
// fail and list the names. Before onboarding, in a plain folder, --repo names a child repository.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain, relativeFolder, REPO_NAME } from "../hooks/lib.mjs";

// Hosts whose repos are always owner/repo, so anything after that is a web page within the repo.
const TWO_SEGMENT = new Set(["github.com", "bitbucket.org"]);

/** host/path/to/repo, lowercased, from any git or web URL of a repository; null when unparsable or
 *  when the host is an SSH alias (no dot), which names no real host. */
export function repoSlug(url) {
  const s = String(url ?? "").trim();
  const m =
    /^[\w.-]+@([\w.-]+):\/?(\S+)$/.exec(s) ?? // git@host:owner/repo.git
    /^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?([\w.-]+)(?::\d+)?\/([^\s?#]+)/.exec(s);
  if (!m) return null;
  const host = m[1].toLowerCase().replace(/^www\./, "");
  if (!host.includes(".")) return null;
  let parts = m[2].split("/-/")[0].split("/").filter(Boolean); // GitLab web pages sit after /-/
  if (TWO_SEGMENT.has(host)) parts = parts.slice(0, 2);
  if (parts.length < 2) return null;
  parts[parts.length - 1] = parts.at(-1).replace(/\.git$/i, "");
  return `${host}/${parts.join("/")}`.toLowerCase();
}

/** The links that point at the same repo as the origin; never a match on an unparsable origin. */
export function repoMatches(originUrl, links) {
  const origin = repoSlug(originUrl);
  return origin ? links.filter(l => repoSlug(l) === origin) : [];
}

const plainName = s => (typeof s === "string" ? s.toLowerCase().replace(/[^a-z0-9]/g, "") : "");

/** What a project of this repo would be called: the folder name and the origin's repo name,
 *  lowercased with everything but letters and digits removed, without duplicates. */
export function repoProbes(dirName, originUrl) {
  // An SSH host alias (github-work:org/repo.git) has no usable host, but still names the repo.
  const repo = repoSlug(originUrl)?.split("/").at(-1) ?? String(originUrl ?? "").split(/[/:]/).at(-1).replace(/\.git$/i, "");
  return [...new Set([plainName(dirName), plainName(repo)])].filter(Boolean);
}

/** A ticket's repo:<name> tags against this repo's probes (design §10, one product in several
 *  repositories). match: true when one names this repo, false when they all name others, null
 *  when the ticket names no repository. others: the names that are not this repo. */
export function repoMatch(tags, probes) {
  const repos = repoTags(tags);
  const mine = name => probes.includes(plainName(name));
  return { repos, match: repos.length === 0 ? null : repos.some(mine), others: repos.filter(r => !mine(r)) };
}

/** The names in a ticket's repo:<name> tags, as written. */
const repoTags = tags =>
  (Array.isArray(tags) ? tags : [])
    .map(t => (typeof t === "string" ? /^\s*repo\s*:\s*(\S.*?)\s*$/i.exec(t)?.[1] : null))
    .filter(Boolean);

/** A ticket's repo:<name> tags against a workspace's repositories ({name: probes}): the
 *  repositories they name, in the workspace file's order, the tag names that match none, and those
 *  that match several (one repository's key is another's folder or origin name: ask). */
export function workspaceRoute(tags, probes) {
  const repos = repoTags(tags);
  const names = Object.keys(probes);
  const hits = r => names.filter(name => probes[name].includes(plainName(r)));
  return {
    repos,
    repositories: names.filter(name => repos.some(r => hits(r).includes(name))),
    unknown: repos.filter(r => hits(r).length === 0),
    ambiguous: repos.filter(r => hits(r).length > 1),
  };
}

/** `--repo <name>` anywhere in the arguments, at most once; the rest stay in order. */
export function parseRepoFlag(args) {
  const rest = [];
  let repo = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--repo") {
      rest.push(args[i]);
      continue;
    }
    if (repo !== null) return { error: "Pass --repo once." };
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) return { error: "--repo needs a repository name from the workspace's hashsmith.json." };
    repo = value;
    i++;
  }
  return { repo, args: rest };
}

/** The tags array from stdin: the array itself, or get_task's result around it; null otherwise. */
export function tagsFrom(input) {
  const tags = Array.isArray(input) ? input : (input?.result?.tags ?? input?.tags);
  return Array.isArray(tags) ? tags : null;
}

const CANDIDATE_MAX = 5;
const PARTIAL_MIN = 4; // "app" or "ops" would sit inside half the workspace's names

/** The projects (list_my_projects rows) whose name or key is a probe, then those whose name
 *  contains a probe or sits inside one (the shorter side 4+ characters), closest first; at most 5. */
export function projectCandidates(projects, probes) {
  if (!Array.isArray(projects)) return [];
  const ranked = [];
  for (const p of projects) {
    if (!p || typeof p.id !== "string" || typeof p.name !== "string") continue;
    const name = plainName(p.name);
    const key = plainName(p.key);
    let best = null;
    for (const probe of probes) {
      if (name === probe || (key && key === probe)) best = 0;
      else if (name && Math.min(name.length, probe.length) >= PARTIAL_MIN && (name.includes(probe) || probe.includes(name)))
        best = Math.min(best ?? Infinity, Math.abs(name.length - probe.length));
    }
    if (best !== null) ranked.push({ row: { id: p.id, name: p.name, key: p.key ?? null, match: best === 0 ? "exact" : "partial" }, best });
  }
  return ranked
    .sort((a, b) => a.best - b.best) // stable: equals keep list_my_projects order
    .slice(0, CANDIDATE_MAX)
    .map(r => r.row);
}

// The lists a team keeps tickets in before they are ready (Backlog, Icebox, Ideas: any name): the
// active lists that come before To Do in board order (get_board sorts by position), leaving out
// the ones hashsmith.json maps. next reads them, so an empty To Do is not mistaken for no work.
// HashOps list types are active, done and closed; a list without a type counts as active.
export function listsBeforeTodo(lists, mapped) {
  const todo = mapped?.todo;
  if (typeof todo !== "string" || !todo) return { error: "hashops.lists.todo is missing from hashsmith.json" };
  if (!Array.isArray(lists)) return { error: "stdin must be get_board's lists: a JSON array, or the board with its lists" };
  const rows = lists.filter(l => typeof l?.id === "string" && typeof l?.name === "string");
  const at = rows.findIndex(l => l.id === todo);
  if (at === -1) return { error: "The To Do list in hashsmith.json is not on this board: run /hashsmith:onboard-project to refresh the ids" };
  const known = new Set(Object.values(mapped));
  const active = l => l.type == null || l.type === "active";
  return { lists: rows.slice(0, at).filter(l => active(l) && !known.has(l.id)).map(({ id, name }) => ({ id, name })) };
}

/** Names of the KEY= lines in an env file. Comments, blank lines and `# KEY=` are skipped. */
export function envKeyNames(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map(l => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1])
    .filter(Boolean);
}

/** Keys the example names that none of the env files define, sorted. */
export function missingEnvKeys(example, envs) {
  const defined = new Set(envs.flatMap(envKeyNames));
  return [...new Set(envKeyNames(example))].filter(k => !defined.has(k)).sort();
}

/** How a settings object treats `git switch`: deny wins over ask, ask over allow. */
export function gitSwitchRule(settings) {
  const p = settings?.permissions ?? {};
  const has = list => Array.isArray(list) && list.some(r => String(r).startsWith("Bash(git switch"));
  for (const rule of ["deny", "ask", "allow"]) if (has(p[rule])) return rule;
  return "none";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TICKET = /^[A-Z0-9]+-\d+$/;
const TOP = ["version", "hashops", "repo", "qa", "sonar", "sentry", "changelog", "intake", "learned"];
// A workspace file holds what its repositories share; each repository's own file holds the rest.
const WORKSPACE_TOP = ["version", "hashops", "repositories", "intake", "learned"];
const REPO_ONLY = ["repo", "qa", "sonar", "sentry", "changelog"];
const CHANGELOG_MODES = ["write", "commits", "off"];
const QA_MODES = ["browser", "code", ""];
const BRANCH_POLICIES = ["managed", "current", "confirm", ""];
const LISTS = ["todo", "in_progress", "review", "qa", "done"];
const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = v => typeof v === "string";

/** hashsmith.json shape errors (design §5, reference/config.md); [] means valid. */
export function checkConfig(c) {
  if (!isObj(c)) return ["hashsmith.json must be a JSON object."];
  const workspace = "repositories" in c;
  const e = [];
  for (const k of Object.keys(c))
    if (workspace && REPO_ONLY.includes(k)) e.push(`${k} belongs in each repository's own hashsmith.json, not the workspace file.`);
    else if (!(workspace ? WORKSPACE_TOP : TOP).includes(k)) e.push(`Unknown top-level key "${k}".`);
  if (c.version !== 1) e.push("version must be 1.");

  const h = c.hashops;
  if (!isObj(h)) e.push("hashops is required.");
  else {
    if (!UUID.test(h.project_id ?? "")) e.push("hashops.project_id must be a UUID.");
    if (!UUID.test(h.board_id ?? "")) e.push("hashops.board_id must be a UUID.");
    if (!/^[A-Z0-9]+$/.test(h.project_key ?? "")) e.push("hashops.project_key must be upper-case letters and digits (e.g. HOPS).");
    if (!isObj(h.lists)) e.push("hashops.lists is required.");
    else {
      const keys = Object.keys(h.lists);
      for (const k of LISTS) if (!keys.includes(k)) e.push(`hashops.lists.${k} is missing (use "" to look it up).`);
      for (const k of keys)
        if (!LISTS.includes(k)) e.push(`hashops.lists.${k} is not a list key (${LISTS.join(", ")}).`);
        else if (!(h.lists[k] === "" || UUID.test(h.lists[k]))) e.push(`hashops.lists.${k} must be a UUID or "".`);
    }
    if (!isStr(h.ai_tag) || !h.ai_tag.trim()) e.push("hashops.ai_tag must be a non-empty string.");
  }

  if (workspace) e.push(...repositoriesErrors(c.repositories));
  else e.push(...repoSettingsErrors(c));
  e.push(...sharedErrors(c));
  return e;
}

// A relative folder inside the workspace on paper (hooks/lib.mjs); symlinks are checked on disk.
const relativePath = relativeFolder;

/** The workspace file's repositories map: name → {path}, nothing else, no path twice. */
function repositoriesErrors(r) {
  if (!isObj(r) || !Object.keys(r).length) return ["repositories must be an object of name → {path}, with at least one repository."];
  const e = [];
  const seen = new Map();
  for (const [name, v] of Object.entries(r)) {
    if (!REPO_NAME.test(name)) e.push(`repositories key "${name}" must be letters, digits, ".", "_" or "-", starting with a letter or digit.`);
    else if (!isObj(v) || Object.keys(v).some(k => k !== "path")) e.push(`repositories.${name} must be {path}; its settings live in its own hashsmith.json.`);
    else if (!relativePath(v.path)) e.push(`repositories.${name}.path must be a relative folder inside the workspace, like "acme-api".`);
    else if (seen.has(v.path)) e.push(`repositories.${name}.path is also ${seen.get(v.path)}'s.`);
    else seen.set(v.path, name);
  }
  return e;
}

/** The keys only a single repository's file holds. */
function repoSettingsErrors(c) {
  const e = [];
  if (c.repo !== undefined && !(isObj(c.repo) && isStr(c.repo.base_branch) && c.repo.base_branch.trim()))
    e.push("repo.base_branch must be a non-empty string.");
  // How work and qa pick a branch (design §6 work): managed ai/* branches, the checked-out one, or ask.
  if (isObj(c.repo) && "branch_policy" in c.repo && !BRANCH_POLICIES.includes(c.repo.branch_policy))
    e.push('repo.branch_policy must be "managed", "current", "confirm" or "" (managed).');
  // QA and design screenshots run only against a local app (design §6 qa).
  if (c.qa !== undefined && !(isObj(c.qa) && isStr(c.qa.base_url) && (c.qa.base_url === "" || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/\S*)?$/.test(c.qa.base_url))))
    e.push('qa.base_url must be "" or a local URL (http://localhost:<port> or http://127.0.0.1:<port>).');
  // How qa verifies: in the browser, or by code and tests for a project with no web UI; "" asks.
  if (isObj(c.qa) && "mode" in c.qa && !QA_MODES.includes(c.qa.mode))
    e.push('qa.mode must be "browser", "code" or "".');
  if (c.sonar !== undefined && !(isObj(c.sonar) && isStr(c.sonar.project_key))) e.push("sonar.project_key must be a string.");
  if (c.sentry !== undefined && !(isObj(c.sentry) && isStr(c.sentry.project))) e.push("sentry.project must be a string.");
  // A Markdown file at the repo root only: entries are written there, and sync leaves it out of
  // its working-tree match, so it must never be a project file or leave the repo.
  const log = c.changelog;
  if (log !== undefined && !(isObj(log) && CHANGELOG_MODES.includes(log.mode) && isStr(log.path) && /^[^/\\]+\.md$/i.test(log.path)))
    e.push('changelog must be {mode: "write" | "commits" | "off", path: a .md file at the repo root}.');
  return e;
}

/** The keys both a repository's file and a workspace file may hold. */
function sharedErrors(c) {
  const e = [];
  if (c.intake !== undefined) {
    const meetings = c.intake?.processed_meetings;
    if (!isObj(c.intake) || (meetings !== undefined && !Array.isArray(meetings))) e.push("intake.processed_meetings must be an array.");
    else
      (meetings ?? []).forEach((m, i) => {
        const ok =
          isObj(m) &&
          isStr(m.id) &&
          DAY.test(m.on ?? "") &&
          Array.isArray(m.tickets) &&
          m.tickets.every(t => TICKET.test(t)) &&
          (m.note === undefined || isStr(m.note));
        if (!ok) e.push(`intake.processed_meetings[${i}] must be {id, on: YYYY-MM-DD, tickets: ["KEY-12"], note?}.`);
      });
  }

  if (c.learned !== undefined) {
    if (!isObj(c.learned)) e.push("learned must be an object.");
    else
      for (const [k, v] of Object.entries(c.learned)) {
        if (!/^[a-z][a-z0-9_]*$/.test(k)) e.push(`learned key "${k}" must be snake_case.`);
        else if (!(isObj(v) && "value" in v && isStr(v.why) && isStr(v.source) && DAY.test(v.added ?? "")))
          e.push(`learned.${k} must be {value, why, source, added: YYYY-MM-DD}.`);
      }
  }
  return e;
}

/** A valid workspace file against what is on disk for each repository (children: name →
 *  {inside, git, dir, config}): each path stays inside the workspace and holds its own Git
 *  repository (no two names for one folder) whose hashsmith.json is valid, is not a workspace,
 *  and has the workspace's hashops block. */
export function checkWorkspace(c, children) {
  const e = [];
  const seen = new Map();
  for (const [name, { path }] of Object.entries(c.repositories)) {
    const child = children[name];
    const file = `${path}/hashsmith.json`;
    const twin = child?.dir ? seen.get(child.dir) : undefined;
    if (child?.dir && !twin) seen.set(child.dir, name);
    if (!child?.inside) e.push(`repositories.${name}.path must stay inside the workspace (symlinks followed).`);
    else if (twin) e.push(`repositories.${name}.path is the same repository as ${twin}'s.`);
    else if (!child.git) e.push(`repositories.${name}: ${path} is not a Git repository.`);
    else if (child.config === null || child.config === undefined) e.push(`${file} not found: onboard that repository first.`);
    else if (child.config.__invalid) e.push(`${file} is not valid JSON.`);
    else if (isObj(child.config) && "repositories" in child.config) e.push(`${file} is a workspace file; workspaces do not nest.`);
    else {
      const own = checkConfig(child.config);
      if (own.length) {
        e.push(...own.map(m => `${file}: ${m}`));
        continue;
      }
      const [mine, shared] = [child.config.hashops, c.hashops];
      for (const k of ["project_id", "project_key", "board_id", "ai_tag"])
        if (mine[k] !== shared[k]) e.push(`${file}: hashops.${k} differs from the workspace's.`);
      for (const k of LISTS) if (mine.lists[k] !== shared.lists[k]) e.push(`${file}: hashops.lists.${k} differs from the workspace's.`);
    }
  }
  return e;
}

/** Where /hashsmith:feedback files its tickets (hooks/feedback-board.json) and the plugin version
 *  the report names (design §12). Upper-cases the key; errors name each bad field. */
export function feedbackTarget(board, plugin) {
  if (!isObj(board)) return { ok: false, errors: ["hooks/feedback-board.json is missing or not a JSON object."] };
  const e = [];
  for (const k of ["project_id", "board_id", "list_id"]) if (!UUID.test(board[k] ?? "")) e.push(`feedback-board.json ${k} must be a UUID.`);
  if (!/^[A-Za-z0-9]+$/.test(board.project_key ?? "")) e.push("feedback-board.json project_key must be letters and digits.");
  if (!Array.isArray(board.tags) || !board.tags.length || !board.tags.every(t => isStr(t) && t.trim()))
    e.push("feedback-board.json tags must be a non-empty array of tag names.");
  if (!isStr(board.duplicate_tag) || !board.duplicate_tag.trim()) e.push("feedback-board.json duplicate_tag must be a tag name.");
  if (!/^\d+\.\d+\.\d+$/.test(plugin?.version ?? "")) e.push("plugin.json version must be x.y.z.");
  if (e.length) return { ok: false, errors: e };
  const { project_id, board_id, list_id, tags, duplicate_tag } = board;
  return { ok: true, version: plugin.version, project_id, board_id, project_key: board.project_key.toUpperCase(), list_id, tags, duplicate_tag };
}

// Tools that own the changelog: built from commits, or from changeset files (the handoff then gives
// the developer the line for their changeset). Hashsmith writes no line (reference/changelog.md).
// release-it alone writes none: its changelog plugins show up as conventional-changelog, or as a
// kept file (keep-a-changelog), which is write mode.
const GENERATOR_FILES = [
  ["release-please", /^(release-please-config\.json|\.release-please-manifest\.json)$/i],
  ["changesets", /^\.changeset$/],
  ["semantic-release", /^(\.releaserc(\.(json|ya?ml|js|cjs|mjs))?|release\.config\.(js|cjs|mjs))$/i],
  ["standard-version", /^\.versionrc(\.(json|js|cjs))?$/i],
  ["git-cliff", /^cliff\.toml$/i],
  ["auto-changelog", /^\.auto-changelog$/i],
];
// Their package and action names, in package.json dependencies and scripts or in a workflow.
const GENERATOR_NAMES = [
  ["release-please", /\brelease-please\b/i],
  ["changesets", /@changesets\/cli|changesets\/action|\bchangeset (?:version|publish)\b/i],
  ["semantic-release", /\bsemantic-release\b/i],
  ["commit-and-tag-version", /\bcommit-and-tag-version\b/i],
  ["standard-version", /\bstandard-version\b/i],
  // The tool itself, not packages named after it (a commitlint preset such as conventional-changelog-conventionalcommits).
  ["conventional-changelog", /(?<![\w-])(?:conventional-changelog(?:-cli|-action)?|@release-it\/conventional-changelog)(?![\w-])/i],
  ["git-cliff", /\bgit-cliff\b/i],
  ["auto-changelog", /\bauto-changelog\b/i],
];
// package.json keys these tools read their config from ("release" is semantic-release's).
const GENERATOR_KEYS = [
  ["semantic-release", "release"],
  ["commit-and-tag-version", "commit-and-tag-version"],
  ["standard-version", "standard-version"],
  ["auto-changelog", "auto-changelog"],
];
const CHANGELOG_FILES = ["changelog.md", "changes.md", "history.md"];

/** The changelog tooling in a repo, from package.json (it names the tool most exactly), its root
 *  listing and workflow texts: the first generator found, and the root changelog file as it is
 *  spelled on disk. Names only. */
export function changelogDetect({ names = [], packageJson = null, workflows = [] }) {
  let generator = null;
  if (isObj(packageJson) && !packageJson.__invalid) {
    const deps = [packageJson.dependencies, packageJson.devDependencies].flatMap(d => (isObj(d) ? Object.keys(d) : []));
    const scripts = isObj(packageJson.scripts) ? Object.values(packageJson.scripts).filter(isStr) : [];
    const text = [...deps, ...scripts].join("\n");
    generator =
      GENERATOR_NAMES.find(([, re]) => re.test(text))?.[0] ?? GENERATOR_KEYS.find(([, key]) => isObj(packageJson[key]))?.[0] ?? null; // a config object, not any value
  }
  if (!generator) generator = GENERATOR_FILES.find(([, re]) => names.some(n => re.test(n)))?.[0] ?? null;
  if (!generator) generator = GENERATOR_NAMES.find(([, re]) => workflows.some(w => re.test(String(w))))?.[0] ?? null;
  const file = CHANGELOG_FILES.map(f => names.find(n => n.toLowerCase() === f)).find(Boolean) ?? null;
  return { generator, file };
}

/** The changelog mode to use from the stored key and what the repo shows (design §5): off and
 *  every stored value stand, except write once a generator appears (stale counts as empty).
 *  `changed` means "write this to hashsmith.json"; `ask` means nothing is stored or found. */
export function changelogDecision(stored, detected) {
  const generator = detected?.generator ?? null;
  if (stored?.mode === "off") return { mode: "off", path: stored.path, generator: null, ask: false, changed: false };
  if (stored?.mode === "write" && generator) return { mode: "commits", path: stored.path, generator, ask: false, changed: true };
  if (stored?.mode === "write" || stored?.mode === "commits") return { mode: stored.mode, path: stored.path, generator, ask: false, changed: false };
  const path = detected?.file ?? "CHANGELOG.md";
  if (generator) return { mode: "commits", path, generator, ask: false, changed: true };
  if (detected?.file) return { mode: "write", path, generator: null, ask: false, changed: true };
  return { mode: null, path, generator: null, ask: true, changed: false };
}

const COMMIT_TYPES = ["feat", "fix", "perf", "refactor", "docs", "test", "chore", "build", "ci", "style", "revert"];
const ENTRY_HEADINGS = { feat: "Added", fix: "Fixed", perf: "Improved" };

// Standards and names that look like ticket keys but belong in a user's sentence.
const NOT_TICKETS = new Set(["UTF", "ISO", "SHA", "RFC", "COVID", "ES", "IPV", "MP", "WCAG", "GPT", "PS", "HTTP", "TLS"]);
// A date written out with a year ("5 November 2026", "Nov 2026", "November 5, 2026"); a month word
// with no year ("March fixes") is not one.
const MONTH =
  "(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\\b\\.?";
const WRITTEN_DATE = new RegExp(`\\b${MONTH}\\s+(?:\\d{1,2},?\\s+)?\\d{4}\\b|\\b\\d{1,2}\\s+${MONTH}\\s+\\d{4}\\b`, "i");

/** The lines a unified diff adds to and removes from one root file, hunk bodies only. The file is
 *  read from the ---/+++ lines, with or without a one-letter prefix (a/, b/, c/, w/ or none), so a
 *  developer's diff.noprefix or diff.mnemonicPrefix does not hide it. */
export function patchLines(patch, path) {
  const added = [];
  const addedAt = []; // each added line's 1-based line number in the new file, from the @@ headers
  const removed = [];
  let inFile = false;
  let inHunk = false;
  let at = null;
  const isPath = name => name === path || name === `${name[0]}/${path}`;
  for (const line of String(patch ?? "").split("\n")) {
    if (line.startsWith("diff --git ")) inFile = inHunk = false;
    else if (!inHunk && /^(---|\+\+\+) /.test(line)) inFile ||= isPath(line.slice(4).replace(/\t.*$/, ""));
    else if (line.startsWith("@@")) {
      inHunk = true;
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
      at = m ? Number(m[1]) : null;
    } else if (inFile && inHunk && line.startsWith("+")) {
      added.push(line.slice(1));
      addedAt.push(at);
      if (at !== null) at++;
    } else if (inFile && inHunk && line.startsWith("-")) removed.push(line.slice(1));
    else if (inHunk && line.startsWith(" ") && at !== null) at++;
  }
  return { added, addedAt, removed };
}

// The Unreleased section of the changelog on disk, as [start, end) line indexes, or null. Its
// heading may be #, ## or ###; it ends at the next heading of the same level or higher.
function unreleasedRange(lines) {
  const start = lines.findIndex(l => /^#{1,3}\s+\[?unreleased\b/i.test(l));
  if (start === -1) return null;
  const level = /^#+/.exec(lines[start])[0].length;
  const next = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}}\\s`).test(l));
  return [start, next === -1 ? lines.length : next];
}

/** Whether a commit type needs a changelog entry, and what a patch does wrong in the changelog:
 *  entries are for end users, and releases (version headings) belong to the project.
 *  key: the project's ticket key (flag only it when known); fileText: the changelog on disk, to
 *  check that new entries sit under Unreleased. */
export function changelogCheck(type, patch, path, { key = null, fileText = null } = {}) {
  if (!COMMIT_TYPES.includes(type)) return { error: `commit type must be one of ${COMMIT_TYPES.join(", ")}` };
  const heading = ENTRY_HEADINGS[type] ?? null;
  const { added, addedAt, removed } = patchLines(patch, path);
  const problems = [];
  for (const line of added) {
    const text = line.replace(/https?:\/\/\S+/g, ""); // a link for users is fine
    const own = typeof key === "string" && /^[A-Za-z0-9]+$/.test(key) ? key.toUpperCase() : null;
    const keys = [...text.matchAll(/(?<![A-Za-z0-9-])([A-Za-z][A-Za-z0-9]*)-\d+(?![\w-])/g)];
    const found = own ? keys.find(m => m[1].toUpperCase() === own) : keys.find(m => /^[A-Z][A-Z0-9]*$/.test(m[1]) && !NOT_TICKETS.has(m[1]));
    if (found) problems.push(`an added line carries the ticket key ${found[0]}; entries are for users`);
    const files = text.match(/[\w@.-]+\/[\w@./-]*\.[A-Za-z0-9]{1,8}\b|\b[\w.-]+\.(?:m?[jt]sx?|json|md|css|html|sql|py|rb|go|ya?ml|toml|sh)\b/g) ?? [];
    if (files.some(f => !/^[A-Z][a-z]+\.js$/.test(f))) problems.push("an added line names a file name; describe what the user sees instead");
    if (/`[^`]+`/.test(text)) problems.push("an added line has a code span; entries are plain English");
    // A release heading names a version, a date or a release; Unreleased and "## Added" are fine.
    if (/^#{1,6}\s/.test(line) && !/unreleased/i.test(line) && (/\bv?\d+\.\d+|\b\d{4}-\d{2}-\d{2}\b|\bversion\b|\brelease\b/i.test(line) || WRITTEN_DATE.test(line)))
      problems.push("an added line is a release heading; releases belong to the project's own process");
  }
  for (const line of removed)
    if (/^#{1,6}\s|^\[[^\]]+\]:\s/.test(line)) problems.push("the patch removes a section heading or its link reference; never rename or drop one");
  // Placement: every added entry line must sit under Unreleased in the file as it is now.
  if (typeof fileText === "string") {
    const lines = fileText.split("\n");
    const range = unreleasedRange(lines);
    const isEntry = l => l.trim() && !/^#{1,6}\s|^\[[^\]]+\]:\s/.test(l);
    const within = i => range && i > range[0] && i < range[1];
    // By the hunk's line number when the file on disk still has that line there; else by its text.
    const inside = (l, n) => (n !== null && lines[n - 1] === l ? within(n - 1) : lines.some((f, i) => f === l && within(i)));
    if (added.some((l, k) => isEntry(l) && !inside(l, addedAt[k])))
      problems.push("an added changelog line sits outside the Unreleased section; entries go under Unreleased");
  }
  const pkg = patchLines(patch, "package.json");
  if ([...pkg.added, ...pkg.removed].some(l => /^\s*"version"\s*:/.test(l)))
    problems.push("the patch changes the version field in package.json; versions belong to the project's own process");
  return { needs_entry: heading !== null, heading, missing_entry: heading !== null && !added.some(l => l.trim() && !/^#{1,6}\s|^\[[^\]]+\]:\s/.test(l)), problems };
}

/** The ai/* branches carrying this ticket key in their leading key segment: ai/KEY-12-KEY-15-slug
 *  carries KEY-12 and KEY-15; ai/KEY-3-fix-KEY-12-x carries only KEY-3; KEY-1 never matches KEY-12. */
export function branchesForKey(branches, key) {
  return branches.filter(b => {
    const lead = /^ai\/((?:[A-Z0-9]+-\d+(?:-|$))+)/.exec(b)?.[1] ?? "";
    return [...lead.matchAll(/([A-Z0-9]+-\d+)/g)].some(m => m[1] === key);
  });
}

/** Design §4: a ticket's state from its branch and PR. */
export function ticketState(pr, branch) {
  if (pr?.state === "OPEN") return "qa";
  if (pr?.state === "MERGED") return "qa-merged";
  if (pr?.state === "CLOSED") return "pr-closed";
  return branch ? "review" : "no-branch";
}

/** ai/* branch names from local branches and origin's remote-tracking ones, once each. */
export function aiBranches(local, remote) {
  const names = [...local, ...remote.filter(r => r.startsWith("origin/")).map(r => r.slice("origin/".length))];
  return [...new Set(names.filter(n => n.startsWith("ai/")))];
}

// Furthest along first: a merged or open PR beats a branch without one, which beats a closed PR.
const RANK = { "qa-merged": 4, qa: 3, review: 2, "pr-closed": 1 };

/** One ticket's state from all its branches ({branch, pr}); several branches are flagged ambiguous. */
export function ticketStateFor(entries) {
  if (entries.length === 0) return { branch: null, pr: null, state: "no-branch", ambiguous: false };
  const ranked = entries.map(e => ({ branch: e.branch, pr: e.pr ?? null, state: ticketState(e.pr, e.branch), ...("local" in e ? { local: e.local } : {}) }));
  const best = ranked.reduce((a, b) => (RANK[b.state] > RANK[a.state] ? b : a));
  return entries.length > 1 ? { ...best, ambiguous: true, branches: ranked } : { ...best, ambiguous: false };
}

/** {sha, at} of the commits whose subject or body carries the key, newest first, from
 *  `git log --format=%h%x1f%cI%x1f%s%x1f%b%x1e`. HSM-1 never matches HSM-12 or XHSM-1; case is
 *  ignored. Commit text is untrusted: a record whose sha is not hex is dropped, so a message
 *  carrying the separators can never put its own text where a sha goes. */
export function commitsForKey(log, key) {
  if (!/^[A-Za-z0-9]+-\d+$/.test(String(key ?? ""))) return [];
  const re = new RegExp(`(?<![A-Za-z0-9])${key}(?!\\d)`, "i");
  return String(log ?? "")
    .split("\x1e")
    .map(r => r.replace(/^\s+/, "").split("\x1f"))
    .filter(([sha, , subject = "", body = ""]) => /^[0-9a-f]{4,40}$/.test(sha ?? "") && re.test(`${subject}\n${body}`))
    // A revert undoes the ticket's work: it is kept, flagged, so a newer revert can cancel delivery.
    // A revert is git's `Revert "…"` subject (GitHub's revert PRs use it too) or a conventional
    // `revert:` type; a plain "Revert button colours" is a change. A revert of a revert (older
    // git's name for a reapply) delivers it again: an odd number of nested `Revert "` reverts.
    .map(([sha, at, subject = ""]) => {
      const s = subject.trim();
      const lead = /^(?:revert\s+")*/i.exec(s)[0];
      // A conventional `revert:` inside the quotes is one more level: git's revert of it reapplies.
      const levels = (lead.match(/revert/gi) ?? []).length + (/^revert(?:\([^)]*\))?!?:/i.test(s.slice(lead.length)) ? 1 : 0);
      const revert = levels % 2 === 1;
      return { sha, at: at ?? null, ...(revert ? { revert: true } : {}) };
    });
}

// The commits that still deliver the ticket, newest first: those newer than its newest revert.
// A revert newer than all of them leaves none, and `reverted` says why.
function delivering(commits) {
  const i = commits.findIndex(c => c.revert);
  return { live: (i === -1 ? commits : commits.slice(0, i)).map(({ sha, at }) => ({ sha, at })), reverted: i === 0 };
}

/** A key with no ai/* branch, from commits carrying it on origin/<base> and on the local <base>
 *  (newest first): base-pushed when origin has the newest one, base-local when only the local base
 *  has it, otherwise no-branch (design §4). A revert newer than the ticket's commits cancels them;
 *  `base.reverted` says where: "pushed" (on origin) or "local" (only on the local base, unpushed). `pushed_commits` lists every pushed one still delivering, oldest first. No base
 *  branch in the config: `base: null`, so nobody reads "not found" into "not searched". */
export function baseStateFor(base, pushedAll, localAll) {
  const none = { branch: null, pr: null, state: "no-branch", ambiguous: false };
  if (!base) return { ...none, base: null };
  const p = delivering(pushedAll);
  const l = delivering(localAll);
  const pushed = p.live;
  const local = l.live;
  // The newest commit decides: a local fix newer than anything pushed is not delivered yet. A local
  // commit origin already has (then reverted there) is not unpushed: the local base is only behind.
  const unpushed = local.length && !pushedAll.some(p => p.sha === local[0].sha);
  const state = unpushed ? "base-local" : pushed.length ? "base-pushed" : "no-branch";
  return {
    ...none,
    state,
    base: {
      branch: base,
      pushed: pushed[0]?.sha ?? null,
      pushed_at: pushed[0]?.at ?? null,
      local: local[0]?.sha ?? null,
      local_at: local[0]?.at ?? null,
      pushed_commits: pushed.map(c => c.sha).reverse(), // oldest first: the ticket's code, for qa's code mode
      ...(p.reverted ? { reverted: "pushed" } : l.reverted && !pushedAll.some(c => c.sha === localAll[0].sha) ? { reverted: "local" } : {}),
    },
  };
}

/** An ai/* branch with no PR hides no base-branch work: when the branch holds no work of its own
 *  (`tip.ahead`: its commits not on origin/<base>, local or origin copy, is 0; and it is not checked
 *  out with uncommitted changes, `tip.dirty`), a pushed base-branch commit carrying the key wins.
 *  The work is then base-branch work: `branch` is null, and the leftover branch is `stale_branch`.
 *  A branch with its own commits, a waiting uncommitted handoff on it, or an unknown tip stays, so
 *  a teammate's "fix seen while testing ACME-22" on the base never replaces live work. */
export function withBase(branchState, baseState, tip) {
  if (branchState?.state !== "review" || branchState.ambiguous || baseState?.state !== "base-pushed") return branchState;
  if (tip?.ahead !== 0 || tip.dirty !== false) return branchState;
  return { ...baseState, stale_branch: branchState.branch };
}

/** The ticket's newest saved patch from base- or other-branch work, `<branch with / as ->-<KEY>.patch`
 *  in the handoffs folder (`names`: [{name, mtimeMs}]), whatever branch is checked out; ai/* branch
 *  patches (named after the branch, `ai-<KEY-n>-…`) are not this kind. `current`: made on `branch`. */
export function handoffPatch(names, key, branch) {
  if (!/^[A-Za-z0-9]+-\d+$/.test(String(key ?? ""))) return null;
  const suffix = `-${key}.patch`;
  const hit = names
    .filter(f => f.name.endsWith(suffix) && f.name.length > suffix.length && !/^ai-[A-Za-z0-9]+-\d+-/.test(f.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (!hit) return null;
  const prefix = hit.name.slice(0, -suffix.length);
  return { file: hit.name, branch: prefix, current: String(branch ?? "").replaceAll("/", "-") === prefix };
}

/** `git status --porcelain -z` → clean flag and the changed paths, exactly as on disk. */
export function treeState(porcelainZ) {
  const entries = String(porcelainZ ?? "").split("\0");
  const files = [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].length < 4) continue;
    files.push(entries[i].slice(3));
    if (/^[RC]/.test(entries[i])) i++; // a rename or copy is followed by its old path
  }
  return { clean: files.length === 0, files };
}

// ---- CLI -----------------------------------------------------------------------------------------

const raw = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const sh = (cmd, args) => raw(cmd, args).trim();
const tryRead = path => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};
const tryJson = path => {
  const text = tryRead(path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { __invalid: true };
  }
};
// The repo's top folder, so a command run from a subfolder still reads the root's files.
const repoTop = () => {
  try {
    return sh("git", ["rev-parse", "--show-toplevel"]);
  } catch {
    return process.cwd(); // not a git repo: the folder it runs in
  }
};
const tryList = dir => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};
const originOf = dir => {
  try {
    return sh("git", ["-C", dir, "config", "--get", "remote.origin.url"]);
  } catch {
    return null; // no origin remote
  }
};

// ---- Workspace roots -----------------------------------------------------------------------------

/** The workspace file in `dir` itself (never a parent's: no walking up), or null. */
const workspaceAt = dir => {
  const c = tryJson(join(dir, "hashsmith.json"));
  return isObj(c) && !c.__invalid && "repositories" in c ? c : null;
};

/** The top folder of the Git repository holding `dir` (git walks up), or null. */
const gitTop = dir => {
  try {
    return realpathSync.native(sh("git", ["-C", dir, "rev-parse", "--show-toplevel"]));
  } catch {
    return null;
  }
};

/** A listed path on disk: inside the workspace after following symlinks, and the top of a Git
 *  repository of its own (a bare or broken .git would let git walk up into an outer repository).
 *  A path that does not exist is inside on paper and not a repository. */
const workspaceChild = (root, path) => {
  const rootReal = realpathSync.native(root);
  let real;
  try {
    real = realpathSync.native(join(root, path));
  } catch {
    return { inside: true, git: false, dir: null };
  }
  const inside = real.startsWith(rootReal + sep);
  return { inside, git: inside && existsSync(join(real, ".git")) && gitTop(real) === real, dir: real };
};

/** The folder `--repo <name>` names: a listed key with a valid path to a repository inside. */
const resolveRepository = (root, c, name) => {
  const repos = isObj(c.repositories) ? c.repositories : {};
  const names = Object.keys(repos);
  if (!REPO_NAME.test(name) || !Object.hasOwn(repos, name))
    return { error: `No repository "${name}" in the workspace's hashsmith.json.`, repositories: names };
  const path = repos[name]?.path;
  const child = relativePath(path) ? workspaceChild(root, path) : null;
  if (!child?.inside || !child.git) return { error: `repositories.${name} is not a Git repository inside the workspace: run check-config.` };
  return { dir: child.dir };
};

const stdinJson = () => {
  const input = process.stdin.isTTY ? "" : readFileSync(0, "utf8").trim();
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
};

/** Before a workspace is onboarded: `--repo <folder>` names a direct child folder (no "/") that is a
 *  Git repository of its own, inside the folder after following symlinks. */
const bootstrapRepository = (root, name) => {
  const child = REPO_NAME.test(name) && !name.includes("/") ? workspaceChild(root, name) : null;
  if (!child?.inside || !child.git) return { error: `No repository "${name}" here: before onboarding, --repo takes a child folder that is a Git repository of its own.` };
  return { dir: child.dir };
};

/** The repository --repo routed this run to, so per-repository files (handoff patches) stay apart. */
let routedRepo = null;

/** What runs at a workspace root without --repo; everything else needs a repository. */
const WORKSPACE_COMMANDS = {
  "check-config": (_args, root, c) => {
    let errors = checkConfig(c);
    // Inside a repository, session-start would take the session for that one repository.
    if (gitTop(root)) errors.push("A workspace root must not be inside a Git repository; it is a plain folder holding them.");
    if (!errors.length) {
      const children = {};
      for (const [name, { path }] of Object.entries(c.repositories)) {
        const child = workspaceChild(root, path);
        children[name] = { ...child, config: child.git ? tryJson(join(child.dir, "hashsmith.json")) : null };
      }
      errors = checkWorkspace(c, children);
    }
    return errors.length ? { ok: false, errors } : { ok: true };
  },
  // Tags come from HashOps: stdin only. Each repository answers to its key and to its folder and
  // origin names, as repo-match does in a single repository.
  "repo-match": (_args, root, c) => {
    const tags = tagsFrom(stdinJson());
    if (!tags) return { error: "stdin must be the ticket's tags: a JSON array, or get_task's result" };
    const probes = {};
    for (const [name, entry] of Object.entries(isObj(c.repositories) ? c.repositories : {})) {
      const child = relativePath(entry?.path) ? workspaceChild(root, entry.path) : null;
      const own = child?.git ? repoProbes(basename(child.dir), originOf(child.dir)) : [];
      // The listed folder's name too, when it is a symlink to a folder named otherwise.
      probes[name] = [...new Set([plainName(name), plainName(basename(entry?.path ?? "")), ...own])].filter(Boolean);
    }
    return { workspace: true, ...workspaceRoute(tags, probes) };
  },
};

const COMMANDS = {
  // Link URLs come from HashOps, where any lead can store one: read them from stdin, never argv,
  // so no URL is ever on a shell command line.
  "repo-slug": () => {
    const originUrl = originOf(".");
    const input = process.stdin.isTTY ? "" : readFileSync(0, "utf8").trim();
    const links = input ? JSON.parse(input) : [];
    return { origin: repoSlug(originUrl), matches: repoMatches(originUrl, links), slugs: Object.fromEntries(links.map(u => [u, repoSlug(u)])) };
  },
  // Project names come from HashOps too: stdin only, like the link URLs.
  "project-candidates": () => {
    const originUrl = originOf(".");
    const top = repoTop();
    const input = process.stdin.isTTY ? "" : readFileSync(0, "utf8").trim();
    let projects;
    try {
      projects = JSON.parse(input || "[]");
    } catch {
      projects = null;
    }
    // A wrong shape would quietly give no candidates, and onboarding would read every project.
    if (!Array.isArray(projects)) return { error: "stdin must be a JSON array of list_my_projects rows" };
    const probes = repoProbes(basename(top), originUrl);
    return { probes, candidates: projectCandidates(projects, probes) };
  },
  // Tags come from HashOps too (anyone on the board can add one): stdin only.
  "repo-match": () => {
    const originUrl = originOf(".");
    const tags = tagsFrom(stdinJson());
    if (!tags) return { error: "stdin must be the ticket's tags: a JSON array, or get_task's result" };
    const probes = repoProbes(basename(repoTop()), originUrl);
    return { probes, ...repoMatch(tags, probes) };
  },
  // List names come from HashOps too: stdin only. Takes the lists array, or the board around it.
  "lists-before-todo": () => {
    const input = process.stdin.isTTY ? "" : readFileSync(0, "utf8").trim();
    let board;
    try {
      board = JSON.parse(input);
    } catch {
      return { error: "stdin must be get_board's lists: a JSON array, or the board with its lists" };
    }
    const lists = Array.isArray(board) ? board : (board?.result?.lists ?? board?.lists);
    return listsBeforeTodo(lists, tryJson("hashsmith.json")?.hashops?.lists); // run at the repo top, or the workspace root
  },
  "env-keys": () => {
    const example = tryRead(".env.example");
    const envs = [".env", ".env.local"].map(tryRead).filter(t => t !== null);
    return { example: example !== null, missing: example === null ? [] : missingEnvKeys(example, envs) };
  },
  "git-switch": () => {
    const rules = [".claude/settings.json", ".claude/settings.local.json"].map(p => gitSwitchRule(tryJson(p)));
    return { rule: ["deny", "ask", "allow"].find(r => rules.includes(r)) ?? "none" };
  },
  "check-config": () => {
    const c = tryJson("hashsmith.json");
    if (c === null) return { ok: false, errors: ["hashsmith.json not found at the repo root."] };
    if (c.__invalid) return { ok: false, errors: ["hashsmith.json is not valid JSON."] };
    // A workspace file is checked only at its own root (WORKSPACE_COMMANDS); in a repository the
    // hooks treat it as broken, so it must not pass here.
    if (isObj(c) && "repositories" in c)
      return { ok: false, errors: ["hashsmith.json here is a workspace file: run check-config at the workspace root; a repository's own file has no repositories."] };
    const errors = checkConfig(c);
    return errors.length ? { ok: false, errors } : { ok: true };
  },
  tree: () => ({ ...treeState(raw("git", ["status", "--porcelain", "-z"])), branch: sh("git", ["branch", "--show-current"]) }),
  "ticket-state": keys => {
    // Remote branches count too: a teammate's handoff branch exists here only as origin/ai/… .
    const refs = prefix => sh("git", ["for-each-ref", "--format=%(refname:short)", prefix]).split("\n").filter(Boolean);
    const local = refs("refs/heads/ai");
    const branches = aiBranches(local, refs("refs/remotes/origin/ai"));
    // Work done straight on the base branch has no ai/* branch: look for the key in its commits.
    const config = tryJson("hashsmith.json");
    const base = isStr(config?.repo?.base_branch) && config.repo.base_branch.trim() ? config.repo.base_branch.trim() : null;
    // Only the commits that mention the key, however old: git's --grep narrows, commitsForKey matches
    // exactly. The key is a checked KEY-n before it reaches the command line.
    const baseLog = (ref, key) => {
      if (!/^[A-Za-z0-9]+-\d+$/.test(key)) return "";
      try {
        return raw("git", ["log", ref, "-i", "-F", `--grep=${key}`, "--format=%h%x1f%cI%x1f%s%x1f%b%x1e", "--"]);
      } catch {
        return ""; // no such ref yet (no commits, or never fetched)
      }
    };
    // Does an ai/* branch hold work of its own (withBase)? Its commits not on origin/<base>, in its
    // local and origin copies, and uncommitted changes when it is checked out. Unknown: null.
    const tipOf = branch => {
      try {
        const current = sh("git", ["branch", "--show-current"]);
        const dirty = current === branch && raw("git", ["status", "--porcelain", "-z"]).length > 0;
        let ahead = 0;
        for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
          if (!refs(ref).length) continue;
          ahead = Math.max(ahead, Number(sh("git", ["rev-list", "--count", `refs/remotes/origin/${base}..${ref}`, "--"])));
        }
        return base && Number.isFinite(ahead) ? { ahead, dirty } : null;
      } catch {
        return null;
      }
    };
    const logsFor = key =>
      base ? { pushed: baseLog(`refs/remotes/origin/${base}`, key), local: baseLog(`refs/heads/${base}`, key) } : { pushed: "", local: "" };
    const out = {};
    for (const key of keys) {
      const entries = [];
      for (const branch of branchesForKey(branches, key)) {
        try {
          const list = JSON.parse(
            sh("gh", ["pr", "list", "--head", branch, "--state", "all", "--json", "number,state,url,mergedAt", "--limit", "1"]),
          );
          entries.push({ branch, pr: list[0] ?? null, local: local.includes(branch) });
        } catch {
          return { error: "gh unavailable", hint: "Install gh and run `gh auth login`, or use /hashsmith:sync KEY-12 reviewed." };
        }
      }
      const logs = logsFor(key);
      const baseState = baseStateFor(base, commitsForKey(logs.pushed, key), commitsForKey(logs.local, key));
      const branchState = entries.length === 0 ? null : ticketStateFor(entries);
      out[key] = branchState ? withBase(branchState, baseState, branchState.state === "review" ? tipOf(branchState.branch) : null) : baseState;
    }
    return out;
  },
  // A ticket's saved base- or other-branch patch, so sync never globs or guesses (work §7.1).
  "handoff-patch": keys => {
    const projectKey = tryJson("hashsmith.json")?.hashops?.project_key;
    if (!isStr(projectKey) || !/^[A-Za-z0-9]+$/.test(projectKey)) return { error: "no hashops.project_key in hashsmith.json" };
    // At a workspace root, each repository keeps its patches in its own folder (work, workspace mode).
    const dir = join(homedir(), ".hashsmith", "projects", projectKey, "handoffs", ...(routedRepo ? [routedRepo] : []));
    let names = [];
    try {
      names = readdirSync(dir).map(name => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }));
    } catch {
      // no handoffs yet
    }
    const branch = sh("git", ["branch", "--show-current"]);
    const out = {};
    for (const key of keys) {
      const hit = handoffPatch(names, key, branch);
      out[key] = hit ? { path: join(dir, hit.file), branch: hit.branch, current: hit.current } : null;
    }
    return out;
  },
  // Workflow and package.json text is anyone's with push access: only tool and file names come out.
  changelog: () => {
    const top = repoTop();
    const workflows = join(top, ".github", "workflows");
    const detected = changelogDetect({
      names: tryList(top),
      packageJson: tryJson(join(top, "package.json")),
      workflows: tryList(workflows).filter(f => /\.ya?ml$/i.test(f)).map(f => tryRead(join(workflows, f)) ?? ""),
    });
    const stored = tryJson(join(top, "hashsmith.json"))?.changelog;
    return changelogDecision(isObj(stored) ? stored : null, detected);
  },
  "changelog-check": ([type]) => {
    const config = tryJson(join(repoTop(), "hashsmith.json"));
    const log = config?.changelog;
    if (!isObj(log) || !CHANGELOG_MODES.includes(log.mode)) return { error: "hashsmith.json has no changelog key: run the CLI's changelog first" };
    if (!COMMIT_TYPES.includes(type)) return { error: `commit type must be one of ${COMMIT_TYPES.join(", ")}` };
    if (log.mode !== "write") return { mode: log.mode, path: log.path, needs_entry: false };
    const patch = process.stdin.isTTY ? "" : readFileSync(0, "utf8");
    const fileText = tryRead(join(repoTop(), log.path));
    return { mode: log.mode, path: log.path, ...changelogCheck(type, patch, log.path, { key: config?.hashops?.project_key ?? null, fileText }) };
  },
  // The plugin's own files, wherever the CLI runs from: feedback is filed from any repo.
  "feedback-target": () =>
    feedbackTarget(
      tryJson(fileURLToPath(new URL("../hooks/feedback-board.json", import.meta.url))),
      tryJson(fileURLToPath(new URL("../.claude-plugin/plugin.json", import.meta.url))),
    ),
};

/** Where a command runs. At a workspace root: in the repository `--repo` names, or at the root for a
 *  workspace command, or not at all. `--repo` anywhere else fails. Returns `{result}` when the
 *  command already ran (or cannot), else `{args}` to run COMMANDS[cmd] at the repo's top level. */
function route(cmd, argv) {
  const flag = parseRepoFlag(argv);
  if (flag.error) return { result: { error: flag.error } };
  const root = process.cwd();
  const workspace = workspaceAt(root);
  if (flag.repo !== null) {
    let target;
    if (workspace) target = resolveRepository(root, workspace, flag.repo);
    // Onboarding a workspace runs the per-repository commands before the root file exists: in a
    // plain folder (no hashsmith.json, not inside a repository), a direct child repository.
    else if (tryRead(join(root, "hashsmith.json")) === null && !gitTop(root)) target = bootstrapRepository(root, flag.repo);
    else return { result: { error: "--repo works only at a workspace root (a hashsmith.json with repositories)." } };
    if (target.error) return { result: target };
    process.chdir(target.dir); // checked: a repository's own top folder inside the root
    routedRepo = flag.repo;
  } else if (workspace) {
    if (WORKSPACE_COMMANDS[cmd]) return { result: WORKSPACE_COMMANDS[cmd](flag.args, root, workspace) };
    // git-switch reads the root's own .claude settings: the ones a session here runs under.
    if (cmd === "lists-before-todo" || cmd === "feedback-target" || cmd === "git-switch") return { result: COMMANDS[cmd](flag.args) };
    return { result: { error: "This is a workspace root: pass --repo <name>.", repositories: Object.keys(workspace.repositories ?? {}) } };
  }
  return { args: flag.args };
}

if (isMain(import.meta.url)) {
  const [cmd, ...argv] = process.argv.slice(2);
  if (!COMMANDS[cmd]) {
    process.stderr.write(`usage: hashsmith.mjs <${Object.keys(COMMANDS).join("|")}> [args] [--repo <name> at a workspace root]\n`);
    process.exit(2);
  }
  let { result, args } = route(cmd, argv);
  if (result === undefined) {
    // Every command reads the repo's root files (hashsmith.json, .env.example, …), even from a subfolder.
    const top = repoTop();
    if (top !== process.cwd()) process.chdir(top);
    result = COMMANDS[cmd](args);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result?.error) process.exit(2);
  if ((cmd === "check-config" || cmd === "feedback-target") && !result.ok) process.exit(1);
}
