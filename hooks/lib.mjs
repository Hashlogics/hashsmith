// Shared by every Hashsmith hook. No dependencies: hooks run with the Node that every project
// already requires (22+). Each hook reads the event JSON on stdin and prints at most one JSON
// object on stdout. Printing nothing means "no opinion": Claude Code's normal permission flow,
// including the project's own deny rules, decides.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
