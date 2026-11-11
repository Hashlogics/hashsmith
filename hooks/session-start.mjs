#!/usr/bin/env node
// SessionStart: load the conduct rules, check the session's scope, and show what is new since the
// last version this person saw (design §2, §9, §10). Everything here is context for the model; the
// one systemMessage line is for the developer.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hasOwnGit, isMain, projectDir, readConfig, readWorkspace, relativeFolder, REPO_NAME, repoRoot, run, workspaceProblems } from "./lib.mjs";

const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const SEEN = join(homedir(), ".hashsmith", "last_seen_version");
const CLI = fileURLToPath(new URL("../scripts/hashsmith.mjs", import.meta.url));
const WORKSPACE_GUIDE = fileURLToPath(new URL("../reference/workspace.md", import.meta.url));
const CLI_COMMANDS = "repo-slug, project-candidates, lists-before-todo, repo-match, env-keys, git-switch, check-config, tree, ticket-state, handoff-patch, feedback-target, changelog, changelog-check";

const newer = (a, b) => {
  const [x, y] = [a, b].map(v => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

/** CHANGELOG.md sections ("## 0.2.0 …") newer than `since`, oldest last. */
export function whatsNew(changelog, since) {
  const sections = changelog.split(/^(?=## \d+\.\d+\.\d+)/m).filter(s => s.startsWith("## "));
  return sections.filter(s => newer(s.match(/^## (\d+\.\d+\.\d+)/)[1], since)).join("").trim();
}

/** The child folders of `dir` that are Git repositories (a `.git` folder or file, so worktrees and
 *  submodules count), sorted; hidden folders, names the CLI's --repo would refuse and symlinks
 *  that leave `dir` are skipped. At most 20 names. */
export function childRepos(dir) {
  try {
    const real = realpathSync.native(dir);
    const inside = name => {
      try {
        return realpathSync.native(join(dir, name)).startsWith(real + sep);
      } catch {
        return false;
      }
    };
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => REPO_NAME.test(e.name) && (e.isDirectory() || e.isSymbolicLink()) && inside(e.name) && hasOwnGit(join(dir, e.name)))
      .map(e => e.name)
      .sort()
      .slice(0, 20);
  } catch {
    return [];
  }
}

/** A session at a workspace root: the folder itself holds a hashsmith.json with `repositories`. */
function workspaceStart(dir, ws, version, seenFile) {
  // Like the repository names, the key comes from a file no repository reviews: print it only plain.
  const key = /^[A-Za-z0-9]+$/.test(String(ws.hashops?.project_key ?? "")) ? ws.hashops.project_key : ws.hashops?.project_key ? "(invalid)" : undefined;
  const repos = Object.entries(ws.repositories && typeof ws.repositories === "object" ? ws.repositories : {})
    // The root file sits outside every repository and gets no review: print only well-formed entries.
    .map(([name, entry]) => (REPO_NAME.test(name) && relativeFolder(entry?.path) ? `${name} (${entry.path})` : "(an invalid entry)"))
    .join(", ");
  const problems = workspaceProblems(dir, ws);
  const parts = [read("reference/conduct.md").trim()];
  parts.push(
    `This is a workspace root: hashsmith.json at ${dir} lists the repositories ${repos || "(none)"}, all on HashOps project ${key ?? "(none)"}. Every /hashsmith:* skill runs here in workspace mode: follow ${WORKSPACE_GUIDE} as each skill says. Each repository keeps its own hashsmith.json for its own settings. For Hashsmith's work use only the HashOps tools named mcp__plugin_hashsmith_hashops__*, never another connection to the same server.`,
  );
  if (problems.length)
    parts.push(`This workspace's config does not check out: ${problems.join("; ")}. Every HashOps write asks until it does. Before any other Hashsmith work, run the CLI's check-config here and propose /hashsmith:onboard-project to fix it.`);
  parts.push(`Hashsmith CLI: node "${CLI}" <command> (${CLI_COMMANDS}). Run it from this folder: check-config, repo-match, lists-before-todo, feedback-target and git-switch (this folder's own settings, which this session runs under) run as they are; every other command takes --repo <name>, a key of repositories. Run git as git -C <that repository's path>.`);
  const banner = `Hashsmith ${version}${key ? ` · ${key}` : ""} · workspace${problems.length ? " (config does not check out)" : ""}`;
  return finish(parts, banner, version, seenFile);
}

/** Adds what is new since the last version this person saw, and records this one. */
function finish(parts, banner, version, seenFile) {
  let seen = null;
  try {
    seen = readFileSync(seenFile, "utf8").trim() || null;
  } catch {
    // first session with Hashsmith
  }
  if (seen !== version) {
    const notes = seen ? whatsNew(read("CHANGELOG.md"), seen) : "";
    if (notes) {
      parts.push(`Hashsmith was updated from ${seen} to ${version}. In your first reply, tell the developer what is new, in two or three lines:\n${notes}`);
      banner += ` (updated from ${seen})`;
    }
    try {
      mkdirSync(join(seenFile, ".."), { recursive: true });
      writeFileSync(seenFile, `${version}\n`);
    } catch {
      // best effort: the notes show again next session
    }
  }
  return { systemMessage: banner, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: parts.join("\n\n") } };
}

export function evaluate(event, { seenFile = SEEN } = {}) {
  const version = JSON.parse(read(".claude-plugin/plugin.json")).version;
  const dir = projectDir(event);
  const root = repoRoot(dir);

  if (!root) {
    const ws = readWorkspace(dir);
    if (ws) return workspaceStart(dir, ws, version, seenFile);
    const repos = childRepos(dir);
    if (repos.length) {
      // A folder of repositories, not onboarded as a workspace yet: only onboarding runs here.
      const file = join(dir, "hashsmith.json");
      const stray = !existsSync(file)
        ? ""
        : readConfig(dir) === null
          ? " The hashsmith.json here cannot be read (not valid JSON, perhaps a merge conflict): run the CLI's check-config and fix it by hand; never overwrite it."
          : " A hashsmith.json here has no repositories: onboarding cannot run until the developer moves it aside (it does not make this folder onboarded).";
      const parts = [
        read("reference/conduct.md").trim(),
        `This folder is not a Git repository and has no workspace hashsmith.json.${stray} Git repositories here: ${repos.join(", ")}. Only /hashsmith:onboard-project runs here: it onboards them as one workspace (${WORKSPACE_GUIDE}, "Onboarding"), or explains the per-repository workflow (README "One product, several repositories"). For any other /hashsmith:* skill, propose onboarding first, or starting Claude Code in a repository's own folder. Use only the HashOps tools named mcp__plugin_hashsmith_hashops__*.`,
        `Hashsmith CLI: node "${CLI}" <command> (${CLI_COMMANDS}). Run it from this folder with --repo <folder>, a repository listed above; feedback-target, git-switch (this folder's own settings, which this session runs under) and, once the workspace file is written, check-config need none.`,
      ];
      return finish(parts, `Hashsmith ${version} · workspace not onboarded`, version, seenFile);
    }
    return {
      systemMessage: `Hashsmith ${version} is inactive: this folder is not a git repository.`,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `Hashsmith is INACTIVE in this session: ${dir} is not inside a single git repository (it may be a folder holding several projects). Do not run any other /hashsmith:* skill or use the hashops MCP tools for Hashsmith work here. If the developer asks for Hashsmith, tell them to start Claude Code inside the project's own folder.`,
      },
    };
  }

  const parts = [read("reference/conduct.md").trim()];
  const found = readConfig(root);
  // A workspace file at a repository's top is never a workspace (its root must be a plain folder):
  // the scope hook does not trust it, so this session is not onboarded either.
  const misplaced = found !== null && typeof found === "object" && "repositories" in found;
  const config = misplaced ? null : found;
  if (misplaced)
    parts.push(`hashsmith.json at ${root} is a workspace file, but ${root} is a Git repository: a workspace root must be a plain folder holding repositories. Hashsmith treats this repository as not onboarded and every HashOps write asks; run the CLI's check-config and propose /hashsmith:onboard-project.`);
  const key = config?.hashops?.project_key;
  parts.push(
    config?.hashops?.project_id
      ? `This project is onboarded: hashsmith.json at ${root} (HashOps project ${key ?? config.hashops.project_id}). For Hashsmith's work use only the HashOps tools named mcp__plugin_hashsmith_hashops__*, never another connection to the same server (for example one named "peoplemuster"). The developer's own HashOps tasks (Daily Recaps, to-dos, leave) are not Hashsmith's work: its connection denies them, and the developer does them in the HashOps app or through their own connection, which asks before each write.`
      : `This project is not onboarded yet (no HashOps project in ${join(root, "hashsmith.json")}). When the developer wants Hashsmith work, propose /hashsmith:onboard-project first (/hashsmith:feedback works without it). Use only the HashOps tools named mcp__plugin_hashsmith_hashops__*.`,
  );
  parts.push(`Hashsmith CLI: node "${CLI}" <command> (${CLI_COMMANDS}). Run it from the repo root; it prints one JSON line.`);
  return finish(parts, `Hashsmith ${version}${key ? ` · ${key}` : ""}`, version, seenFile);
}

if (isMain(import.meta.url))
  run(
    event => evaluate(event),
    e => ({ systemMessage: `Hashsmith could not start (${e?.message ?? e}); its conduct rules are not loaded this session.` }),
  );
