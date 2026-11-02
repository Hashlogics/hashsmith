#!/usr/bin/env node
// The Hashsmith CLI: the deterministic parts of the skills, so they never rest on the model's
// reading of a URL, a settings file or a git state. Run from the repo root; prints one JSON line.
// The session-start hook gives skills this file's absolute path.
//
//   repo-slug            origin and the link URLs (a JSON array on stdin) as slugs, and which match
//   project-candidates   the projects (list_my_projects rows, a JSON array on stdin) named like this repo, best first
//   env-keys             .env.example key names that .env / .env.local lack (names only, never values)
//   git-switch           how .claude/settings(.local).json treat `git switch`
//   check-config         validate hashsmith.json (exit 1 when invalid)
//   tree                 working-tree state and current branch
//   ticket-state KEY...  each ticket's ai/* branch (local or on origin) and PR, mapped to the design §4 states;
//                        with no branch, commits carrying the key on repo.base_branch (base-pushed / base-local)
//   feedback-target      the Hashsmith feedback board, list and tags, and the plugin version (exit 1 when invalid)
//   changelog            how this project keeps its changelog: stored in hashsmith.json, else detected (names only)
//   changelog-check TYPE the commit type's changelog heading, and what the patch on stdin does to the changelog
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "../hooks/lib.mjs";

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
const CHANGELOG_MODES = ["write", "commits", "off"];
const LISTS = ["todo", "in_progress", "review", "qa", "done"];
const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = v => typeof v === "string";

/** hashsmith.json shape errors (design §5, reference/config.md); [] means valid. */
export function checkConfig(c) {
  if (!isObj(c)) return ["hashsmith.json must be a JSON object."];
  const e = [];
  for (const k of Object.keys(c)) if (!TOP.includes(k)) e.push(`Unknown top-level key "${k}".`);
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

  if (c.repo !== undefined && !(isObj(c.repo) && isStr(c.repo.base_branch) && c.repo.base_branch.trim()))
    e.push("repo.base_branch must be a non-empty string.");
  // QA and design screenshots run only against a local app (design §6 qa).
  if (c.qa !== undefined && !(isObj(c.qa) && isStr(c.qa.base_url) && (c.qa.base_url === "" || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/\S*)?$/.test(c.qa.base_url))))
    e.push('qa.base_url must be "" or a local URL (http://localhost:<port> or http://127.0.0.1:<port>).');
  if (c.sonar !== undefined && !(isObj(c.sonar) && isStr(c.sonar.project_key))) e.push("sonar.project_key must be a string.");
  if (c.sentry !== undefined && !(isObj(c.sentry) && isStr(c.sentry.project))) e.push("sentry.project must be a string.");
  // A Markdown file at the repo root only: entries are written there, and sync leaves it out of
  // its working-tree match, so it must never be a project file or leave the repo.
  const log = c.changelog;
  if (log !== undefined && !(isObj(log) && CHANGELOG_MODES.includes(log.mode) && isStr(log.path) && /^[^/\\]+\.md$/i.test(log.path)))
    e.push('changelog must be {mode: "write" | "commits" | "off", path: a .md file at the repo root}.');

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
  ["conventional-changelog", /\bconventional-changelog\b/i],
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
      GENERATOR_NAMES.find(([, re]) => re.test(text))?.[0] ?? GENERATOR_KEYS.find(([, key]) => packageJson[key] !== undefined)?.[0] ?? null;
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

/** The lines a unified diff adds to and removes from one root file, hunk bodies only. The file is
 *  read from the ---/+++ lines, with or without a one-letter prefix (a/, b/, c/, w/ or none), so a
 *  developer's diff.noprefix or diff.mnemonicPrefix does not hide it. */
export function patchLines(patch, path) {
  const added = [];
  const removed = [];
  let inFile = false;
  let inHunk = false;
  const isPath = name => name === path || name === `${name[0]}/${path}`;
  for (const line of String(patch ?? "").split("\n")) {
    if (line.startsWith("diff --git ")) inFile = inHunk = false;
    else if (!inHunk && /^(---|\+\+\+) /.test(line)) inFile ||= isPath(line.slice(4).replace(/\t.*$/, ""));
    else if (line.startsWith("@@")) inHunk = true;
    else if (inFile && inHunk && line.startsWith("+")) added.push(line.slice(1));
    else if (inFile && inHunk && line.startsWith("-")) removed.push(line.slice(1));
  }
  return { added, removed };
}

/** Whether a commit type needs a changelog entry, and what a patch does wrong in the changelog:
 *  entries are for end users, and releases (version headings) belong to the project. */
export function changelogCheck(type, patch, path) {
  if (!COMMIT_TYPES.includes(type)) return { error: `commit type must be one of ${COMMIT_TYPES.join(", ")}` };
  const heading = ENTRY_HEADINGS[type] ?? null;
  const { added, removed } = patchLines(patch, path);
  const problems = [];
  for (const line of added) {
    const text = line.replace(/https?:\/\/\S+/g, ""); // a link for users is fine
    const key = [...text.matchAll(/(?<![A-Za-z0-9-])([A-Z][A-Z0-9]*)-\d+(?![\w-])/g)].find(m => !NOT_TICKETS.has(m[1]));
    if (key) problems.push(`an added line carries the ticket key ${key[0]}; entries are for users`);
    const files = text.match(/[\w@.-]+\/[\w@./-]*\.[A-Za-z0-9]{1,8}\b|\b[\w.-]+\.(?:m?[jt]sx?|json|md|css|html|sql|py|rb|go|ya?ml|toml|sh)\b/g) ?? [];
    if (files.some(f => !/^[A-Z][a-z]+\.js$/.test(f))) problems.push("an added line names a file name; describe what the user sees instead");
    if (/`[^`]+`/.test(text)) problems.push("an added line has a code span; entries are plain English");
    // A release heading names a version, a date or a release; Unreleased and "## Added" are fine.
    if (/^#{1,6}\s/.test(line) && !/unreleased/i.test(line) && /\d|\bversion\b|\brelease\b/i.test(line))
      problems.push("an added line is a release heading; releases belong to the project's own process");
  }
  for (const line of removed)
    if (/^#{1,6}\s|^\[[^\]]+\]:\s/.test(line)) problems.push("the patch removes a section heading or its link reference; never rename or drop one");
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
    .map(([sha, at]) => ({ sha, at: at ?? null }));
}

/** A key with no ai/* branch, from commits carrying it on origin/<base> and on the local <base>
 *  (newest first): base-pushed beats base-local; neither stays no-branch (design §4). No base
 *  branch in the config: `base: null`, so nobody reads "not found" into "not searched". */
export function baseStateFor(base, pushed, local) {
  const none = { branch: null, pr: null, state: "no-branch", ambiguous: false };
  if (!base) return { ...none, base: null };
  const state = pushed.length ? "base-pushed" : local.length ? "base-local" : "no-branch";
  return {
    ...none,
    state,
    base: { branch: base, pushed: pushed[0]?.sha ?? null, pushed_at: pushed[0]?.at ?? null, local: local[0]?.sha ?? null, local_at: local[0]?.at ?? null },
  };
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

const COMMANDS = {
  // Link URLs come from HashOps, where any lead can store one: read them from stdin, never argv,
  // so no URL is ever on a shell command line.
  "repo-slug": () => {
    let originUrl = null;
    try {
      originUrl = sh("git", ["config", "--get", "remote.origin.url"]);
    } catch {
      // no origin remote
    }
    const input = process.stdin.isTTY ? "" : readFileSync(0, "utf8").trim();
    const links = input ? JSON.parse(input) : [];
    return { origin: repoSlug(originUrl), matches: repoMatches(originUrl, links), slugs: Object.fromEntries(links.map(u => [u, repoSlug(u)])) };
  },
  // Project names come from HashOps too: stdin only, like the link URLs.
  "project-candidates": () => {
    let originUrl = null;
    try {
      originUrl = sh("git", ["config", "--get", "remote.origin.url"]);
    } catch {
      // no origin remote
    }
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
    const baseLog = ref => {
      try {
        return raw("git", ["log", ref, "-n", "200", "--format=%h%x1f%cI%x1f%s%x1f%b%x1e", "--"]);
      } catch {
        return ""; // no such ref yet (no commits, or never fetched)
      }
    };
    const logs = base ? { pushed: baseLog(`refs/remotes/origin/${base}`), local: baseLog(`refs/heads/${base}`) } : { pushed: "", local: "" };
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
      out[key] =
        entries.length === 0 ? baseStateFor(base, commitsForKey(logs.pushed, key), commitsForKey(logs.local, key)) : ticketStateFor(entries);
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
    return { mode: log.mode, path: log.path, ...changelogCheck(type, patch, log.path) };
  },
  // The plugin's own files, wherever the CLI runs from: feedback is filed from any repo.
  "feedback-target": () =>
    feedbackTarget(
      tryJson(fileURLToPath(new URL("../hooks/feedback-board.json", import.meta.url))),
      tryJson(fileURLToPath(new URL("../.claude-plugin/plugin.json", import.meta.url))),
    ),
};

if (isMain(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  if (!COMMANDS[cmd]) {
    process.stderr.write(`usage: hashsmith.mjs <${Object.keys(COMMANDS).join("|")}> [args]\n`);
    process.exit(2);
  }
  const result = COMMANDS[cmd](args);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if ((cmd === "check-config" || cmd === "feedback-target") && !result.ok) process.exit(1);
  if (result?.error) process.exit(2);
}
