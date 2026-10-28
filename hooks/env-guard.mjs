#!/usr/bin/env node
// PreToolUse(Read|Grep|Bash): never read an env file, and ask before anything that acts on a real
// environment (design §9). Hashsmith works on local dev machines only; secrets and real projects are
// the developer's. To learn which keys exist, skills run `scripts/hashsmith.mjs env-keys`: it compares
// .env.example with the env files and prints missing key NAMES only, never a value.
import { basename } from "node:path";
import { commands, decide, isMain, run } from "./lib.mjs";

/** .env, .env.local, .env.production, prod.env … but not the committed templates. */
export function isEnvFile(path) {
  const name = basename(String(path ?? ""));
  if (/\.(example|sample|template)$/.test(name)) return false;
  return /^\.env(\..+)?$/.test(name) || /\.env$/.test(name);
}

// The program may come through npx / pnpm dlx / a path, so look for it anywhere in the command.
const uses = (t, prog) => t.some(a => a === prog || a.endsWith(`/${prog}`));
// Commands that act on a real (hosted) environment: [test, what it does].
const REAL_ENV = [
  [t => uses(t, "supabase") && t.includes("db") && t.includes("push"), "pushes migrations to a linked Supabase project"],
  [t => uses(t, "supabase") && t.includes("functions") && t.includes("deploy"), "deploys edge functions"],
  [t => uses(t, "supabase") && t.includes("secrets") && t.includes("set"), "sets secrets on a Supabase project"],
  [t => uses(t, "supabase") && t.includes("link"), "links this folder to a Supabase project"],
  [t => uses(t, "prisma") && t.includes("migrate") && t.includes("deploy"), "applies migrations to the configured database"],
  [t => uses(t, "vercel") && t.includes("--prod"), "deploys to Vercel production"],
  [t => t.some(a => /(^|\/)scripts\/(tenant|ops)\//.test(a)), "runs an operator script against a real project"],
  [t => t[0] === "npm" && t[1] === "run" && /^(tenant|ops):/.test(t[2] ?? ""), "runs an operator script against a real project"],
];

export function evaluate(event) {
  const input = event.tool_input ?? {};
  if (event.tool_name === "Read" && isEnvFile(input.file_path))
    return decide("deny", `${basename(input.file_path)} holds secrets, and Hashsmith never reads env files. Use .env.example for variable names, or ask the developer.`);
  if (event.tool_name === "Grep" && (isEnvFile(input.path) || isEnvFile(input.glob)))
    return decide("deny", "env files hold secrets, and Hashsmith never searches them. Use .env.example for variable names.");
  if (event.tool_name !== "Bash") return null;

  const line = String(input.command ?? "");
  for (const tokens of commands(line)) {
    const file = tokens.slice(1).find(isEnvFile);
    if (file) return decide("deny", `\`${tokens[0]}\` would touch ${basename(file)}, which holds secrets. Hashsmith never reads env files; ask the developer.`);
    if (uses(tokens, "alembic") && tokens.includes("upgrade") && !/docker[ -]compose/.test(line))
      return decide("ask", "`alembic upgrade` outside docker compose may migrate a real database. Confirm it targets the local one.");
    for (const [test, what] of REAL_ENV)
      if (test(tokens)) return decide("ask", `\`${tokens.join(" ")}\` ${what}. Hashsmith works locally only; confirm this is intended.`);
  }
  return null;
}

if (isMain(import.meta.url)) run(evaluate);
