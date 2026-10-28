#!/usr/bin/env node
// PreToolUse(Bash): Hashsmith's only git write is creating or switching to an ai/* branch, and that
// asks first. Everything else that changes git state is denied (design §9). The check is an
// allowlist of read-only commands, so a git write nobody thought of is denied too. The developer
// reviews, stages, commits and pushes; the index is theirs.
import { commands, decide, isMain, run } from "./lib.mjs";

// Options that come before the subcommand; the ones in TAKES_VALUE consume the next token.
const TAKES_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env"]);

// Read-only subcommands, allowed as-is.
const READ = new Set([
  "status", "diff", "log", "show", "blame", "fetch", "rev-parse", "ls-files", "ls-tree", "ls-remote",
  "describe", "shortlog", "grep", "cat-file", "show-ref", "for-each-ref", "merge-base", "rev-list",
  "reflog", "whatchanged", "name-rev", "check-ignore", "check-attr", "count-objects", "var", "version", "help",
  "difftool", "range-diff", "cherry",
]);
// Read-only only in some forms: returns true when these args are a read.
// branch / tag list when they have no write flag and no name, or when --list makes names patterns.
const listing = (writeFlags, valueFlags) => args => {
  if (args.some(a => writeFlags.test(a))) return false;
  if (args.includes("-l") || args.includes("--list")) return true;
  return !args.some((a, i) => !a.startsWith("-") && !valueFlags.has(args[i - 1]));
};
const READ_IF = {
  branch: listing(
    /^(-d|-D|-m|-M|-c|-C|-f|-u|--delete|--move|--copy|--force|--set-upstream-to(=.*)?|--unset-upstream|--edit-description|--track|--no-track)$/,
    new Set(["--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format"]),
  ),
  tag: listing(/^(-d|-a|-s|-u|-f|-m|-F|--delete|--annotate|--sign|--force|--message.*|--file.*)$/, new Set(["--contains", "--no-contains", "--points-at", "--sort", "--format"])),
  remote: args => args.length === 0 || ["-v", "--verbose", "get-url", "show"].includes(args[0]),
  config: args => args.some(a => /^(--get|--get-all|--get-regexp|--list|-l|--show-origin|--show-scope)$/.test(a)) && !args.some(a => /^(--unset|--unset-all|--add|--replace-all|--rename-section|--remove-section|-e|--edit)$/.test(a)),
  worktree: args => args[0] === "list",
  stash: args => args[0] === "list" || args[0] === "show",
  notes: args => args[0] === "list" || args[0] === "show",
};

/** The subcommand and its arguments, skipping git's global options; null when there is none. */
function parseGit(tokens) {
  let i = 1;
  while (i < tokens.length && tokens[i].startsWith("-")) {
    const t = tokens[i];
    i += TAKES_VALUE.has(t) ? 2 : 1;
  }
  return i < tokens.length ? { sub: tokens[i], args: tokens.slice(i + 1) } : null;
}

const AI_BRANCH = /^ai\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** "allow" (read), "ask" (an ai/* branch), or a deny reason. */
export function judge(tokens) {
  const parsed = parseGit(tokens);
  if (!parsed) return "allow";
  const { sub, args } = parsed;
  if (READ.has(sub)) return "allow";
  if (READ_IF[sub]?.(args)) return "allow";

  if (sub === "switch") {
    const create = args.findIndex(a => a === "-c" || a === "--create");
    const names = args.filter((a, i) => !a.startsWith("-") && (create < 0 || i > create));
    const target = create >= 0 ? args[create + 1] : names[0];
    if (target && AI_BRANCH.test(target) && !args.some(a => /^(-C|--force-create|-f|--force|--discard-changes|--merge|-m)$/.test(a)))
      return "ask";
    return `\`git switch\` is allowed only to create or switch to an ai/* branch (got "${args.join(" ")}").`;
  }
  return `\`git ${sub}\` changes git state, and Hashsmith never does that: the developer reviews, stages, commits and pushes. Leave the change unstaged and tell them what to run, if anything.`;
}

export function evaluate(event) {
  if (event.tool_name !== "Bash") return null;
  let ask = null;
  for (const tokens of commands(event.tool_input?.command)) {
    if (!/(^|\/)git$/.test(tokens[0])) continue;
    const verdict = judge(tokens);
    if (verdict === "allow") continue;
    if (verdict === "ask") ask = tokens.join(" ");
    else return decide("deny", verdict);
  }
  return ask ? decide("ask", `create or switch to the branch with \`${ask}\`. The working tree should be clean first (design §4).`) : null;
}

if (isMain(import.meta.url)) run(evaluate);
