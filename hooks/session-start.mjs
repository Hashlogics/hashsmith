#!/usr/bin/env node
// SessionStart: load the conduct rules, check the session's scope, and show what is new since the
// last version this person saw (design §2, §9, §10). Everything here is context for the model; the
// one systemMessage line is for the developer.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain, projectDir, readConfig, repoRoot, run } from "./lib.mjs";

const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const SEEN = join(homedir(), ".hashsmith", "last_seen_version");
const CLI = fileURLToPath(new URL("../scripts/hashsmith.mjs", import.meta.url));

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
 *  submodules count), sorted; hidden folders are skipped. At most 20 names. */
export function childRepos(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => !e.name.startsWith(".") && (e.isDirectory() || e.isSymbolicLink()) && existsSync(join(dir, e.name, ".git")))
      .map(e => e.name)
      .sort()
      .slice(0, 20);
  } catch {
    return [];
  }
}

export function evaluate(event, { seenFile = SEEN } = {}) {
  const version = JSON.parse(read(".claude-plugin/plugin.json")).version;
  const dir = projectDir(event);
  const root = repoRoot(dir);

  if (!root) {
    const repos = childRepos(dir);
    const workspace = repos.length
      ? ` Git repositories here: ${repos.join(", ")}. /hashsmith:onboard-project may run here only to list them and explain the per-repository workflow (README "One product, several repositories"): it writes nothing and calls no HashOps tool.`
      : "";
    return {
      systemMessage: `Hashsmith ${version} is inactive: this folder is not a git repository.`,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `Hashsmith is INACTIVE in this session: ${dir} is not inside a single git repository (it may be a folder holding several projects). Do not run any other /hashsmith:* skill or use the hashops MCP tools for Hashsmith work here. If the developer asks for Hashsmith, tell them to start Claude Code inside the project's own folder.${workspace}`,
      },
    };
  }

  const parts = [read("reference/conduct.md").trim()];
  const config = readConfig(root);
  const key = config?.hashops?.project_key;
  parts.push(
    config?.hashops?.project_id
      ? `This project is onboarded: hashsmith.json at ${root} (HashOps project ${key ?? config.hashops.project_id}). For Hashsmith's work use only the HashOps tools named mcp__plugin_hashsmith_hashops__*, never another connection to the same server (for example one named "peoplemuster"). The developer's own HashOps tasks (Daily Recaps, to-dos, leave) are not Hashsmith's work: its connection denies them, and the developer does them in the HashOps app or through their own connection, which asks before each write.`
      : `This project is not onboarded yet (no HashOps project in ${join(root, "hashsmith.json")}). When the developer wants Hashsmith work, propose /hashsmith:onboard-project first (/hashsmith:feedback works without it). Use only the HashOps tools named mcp__plugin_hashsmith_hashops__*.`,
  );
  parts.push(`Hashsmith CLI: node "${CLI}" <command> (repo-slug, project-candidates, lists-before-todo, repo-match, env-keys, git-switch, check-config, tree, ticket-state, handoff-patch, feedback-target, changelog, changelog-check). Run it from the repo root; it prints one JSON line.`);

  let seen = null;
  try {
    seen = readFileSync(seenFile, "utf8").trim() || null;
  } catch {
    // first session with Hashsmith
  }
  let banner = `Hashsmith ${version}${key ? ` · ${key}` : ""}`;
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

if (isMain(import.meta.url))
  run(
    event => evaluate(event),
    e => ({ systemMessage: `Hashsmith could not start (${e?.message ?? e}); its conduct rules are not loaded this session.` }),
  );
