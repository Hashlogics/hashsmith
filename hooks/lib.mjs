// Shared by every Hashsmith hook. No dependencies: hooks run with the Node that every project
// already requires (22+). Each hook reads the event JSON on stdin and prints at most one JSON
// object on stdout. Printing nothing means "no opinion": Claude Code's normal permission flow,
// including the project's own deny rules, decides.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import { pathToFileURL } from "node:url";

export async function readEvent() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

/** A PreToolUse decision: "deny" or "ask", with the reason shown to the model and the developer. */
export function decide(permissionDecision, reason) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason: `Hashsmith: ${reason}` } };
}

/**
 * Runs a hook body: evaluate(event) returns an output object or null. Never throws to the caller.
 * By default a crashing guard does not silently allow: it asks, and says why.
 */
export async function run(evaluate, onError = e => decide("ask", `a guard hook failed (${e?.message ?? e}); confirm this call yourself.`)) {
  let out;
  try {
    out = await evaluate(await readEvent());
  } catch (e) {
    out = onError(e);
  }
  if (out) process.stdout.write(JSON.stringify(out));
}

/** True when the module is the script node was started with (so tests can import it without running it). */
export const isMain = url => !!process.argv[1] && url === pathToFileURL(process.argv[1]).href;

export const projectDir = event => process.env.CLAUDE_PROJECT_DIR || event.cwd || process.cwd();

/** The nearest folder at or above dir holding a .git entry (a repo or a worktree), or null. */
export function repoRoot(dir) {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return d;
    if (dirname(d) === d) return null;
  }
}

/** The project's hashsmith.json, or null when the project is not onboarded or the file is unreadable. */
export function readConfig(dir) {
  const file = join(dir, "hashsmith.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);

/** A repository name in a workspace file: also what the CLI's --repo takes. */
export const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;


/** A relative folder path that stays below its parent on paper: "/"-separated segments, each a
 *  plain name (letters, digits, ".", "_", "-", not starting with "."), so no absolute path, no "."
 *  or ".." segment and no text beyond a folder name ever comes out of it. Symlinks are checked on disk. */
export const relativeFolder = p => typeof p === "string" && !isAbsolute(p) && p.split("/").every(seg => REPO_NAME.test(seg));

/** Whether `dir` holds a Git repository of its own without spawning git: a .git folder with a HEAD,
 *  or a .git file ("gitdir: …", a worktree or submodule) whose target has one. */
export function hasOwnGit(dir) {
  const git = join(dir, ".git");
  try {
    if (statSync(git).isDirectory()) return existsSync(join(git, "HEAD"));
    const target = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(git, "utf8"))?.[1];
    return !!target && existsSync(join(isAbsolute(target) ? target : join(dir, target), "HEAD"));
  } catch {
    return false;
  }
}

/** A workspace file (one with `repositories`) in `dir` itself, or null. Never a parent folder's:
 *  a workspace file above the session folder must not make anything under it count as onboarded. */
export function readWorkspace(dir) {
  const c = readConfig(dir);
  return isObj(c) && "repositories" in c ? c : null;
}

/** Why a workspace file at `root` cannot be trusted by the guards ([] when it can): every listed
 *  path is a folder inside the root after following symlinks, holds a .git, and has its own
 *  hashsmith.json with the workspace's project_id, project_key and board_id. The CLI's
 *  check-config checks more (for example that the .git is a repository of its own, which needs
 *  git); the hooks spawn no git and never run it, so they check what they rely on. */
export function workspaceProblems(root, ws) {
  const problems = [];
  const h = isObj(ws?.hashops) ? ws.hashops : {};
  if (!h.project_id) problems.push("it has no hashops.project_id");
  const repos = isObj(ws?.repositories) ? Object.entries(ws.repositories) : [];
  if (!repos.length) return [...problems, "it lists no repositories"];
  let rootReal;
  try {
    rootReal = realpathSync.native(root);
  } catch {
    return [...problems, "the workspace folder cannot be read"];
  }
  for (const [name, entry] of repos) {
    const path = entry?.path;
    if (!REPO_NAME.test(name)) {
      problems.push("a repository name is not letters, digits, \".\", \"_\" or \"-\"");
      continue;
    }
    if (!relativeFolder(path)) {
      problems.push(`${name}: its path is not a relative folder`);
      continue;
    }
    let real;
    try {
      real = realpathSync.native(join(root, path));
    } catch {
      problems.push(`${name}: ${path} not found`);
      continue;
    }
    if (!real.startsWith(rootReal + sep)) problems.push(`${name}: ${path} is outside the workspace`);
    else if (!hasOwnGit(real)) problems.push(`${name}: ${path} is not a Git repository`);
    else {
      const own = readConfig(real);
      if (!isObj(own?.hashops)) problems.push(`${name}: ${path}/hashsmith.json is missing or unreadable`);
      else if ("repositories" in own) problems.push(`${name}: ${path}/hashsmith.json is a workspace file`);
      else for (const k of ["project_id", "project_key", "board_id"]) if (own.hashops[k] !== h[k]) problems.push(`${name}: hashops.${k} differs from the workspace's`);
    }
  }
  return problems;
}

/**
 * Every command a shell line runs, as token lists. Splits on ; && || | & newlines, $( ) and
 * backticks, and unwraps `bash -c "…"` / `sh -c` / `zsh -c` / `eval "…"` so a quoted inner
 * command is checked too. Leading VAR=value assignments and wrappers (sudo, env, command, exec,
 * time, nice, xargs) are dropped, so tokens[0] is the program. Quotes are respected; this is a
 * guard against mistakes, not a full shell parser.
 */
export function commands(line) {
  const out = [];
  for (const segment of splitSegments(String(line ?? ""))) {
    let tokens = tokenize(segment);
    while (tokens.length) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1);
      else if (WRAPPERS.has(tokens[0])) tokens = tokens.slice(1).filter((t, i) => !(i === 0 && t.startsWith("-")));
      else break;
    }
    if (!tokens.length) continue;
    const shell = /(^|\/)(bash|sh|zsh)$/.test(tokens[0]);
    const inner = shell ? tokens.indexOf("-c") : tokens[0] === "eval" ? 0 : -1;
    if (inner >= 0 && tokens[inner + 1] !== undefined) out.push(...commands(tokens.slice(inner + 1).join(" ")));
    else out.push(tokens);
  }
  return out;
}
const WRAPPERS = new Set(["sudo", "env", "command", "exec", "time", "nice", "xargs", "nohup"]);

function splitSegments(line) {
  const segments = [];
  let cur = "",
    quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    // Inside quotes nothing splits; the quotes stay in the segment for tokenize() to strip.
    if (quote) {
      cur += c;
      if (c === "\\" && quote === '"' && i + 1 < line.length) cur += line[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "`" || c === "\n" || c === ";" || c === "|" || c === "&" || c === "(" || c === ")") {
      segments.push(cur);
      cur = "";
      continue;
    }
    if (c === "$" && line[i + 1] === "(") {
      segments.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += c;
  }
  segments.push(cur);
  return segments.map(s => s.trim()).filter(Boolean);
}

function tokenize(segment) {
  const tokens = [];
  let cur = "",
    quote = null,
    has = false;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < segment.length) cur += segment[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < segment.length) {
      cur += segment[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) tokens.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has || cur) tokens.push(cur);
  return tokens;
}
