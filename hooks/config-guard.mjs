#!/usr/bin/env node
// PreToolUse(Write|Edit|MultiEdit): hashsmith.json is committed, so nothing secret-shaped or personal
// may go into it (design §5). It is a cache of ids that can always be looked up again.
import { basename } from "node:path";
import { decide, isMain, run } from "./lib.mjs";

const SECRET = [
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, "a JWT"],
  [/\bsk_(live|test)?_?[A-Za-z0-9]{8,}/, "an API secret key (sk_…)"],
  [/\bghp_[A-Za-z0-9]{20,}/, "a GitHub token"],
  [/\bxox[abp]-[A-Za-z0-9-]{8,}/, "a Slack token"],
  [/-----BEGIN [A-Z ]+-----/, "a private key or certificate"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, "an email address"],
  [/"[^"]*(password|passwd|secret|token|api_key|apikey)[^"]*"\s*:/i, "a key named like a credential"],
];

/** The text this call would put into the file. */
function incoming(input) {
  if (typeof input.content === "string") return input.content;
  if (typeof input.new_string === "string") return input.new_string;
  if (Array.isArray(input.edits)) return input.edits.map(e => e?.new_string ?? "").join("\n");
  return "";
}

export function evaluate(event) {
  if (!["Write", "Edit", "MultiEdit"].includes(event.tool_name)) return null;
  const input = event.tool_input ?? {};
  if (basename(String(input.file_path ?? "")) !== "hashsmith.json") return null;
  const text = incoming(input);
  for (const [pattern, what] of SECRET)
    if (pattern.test(text))
      return decide("deny", `this write would put ${what} into hashsmith.json, which is committed. It holds only ids and settings that can be looked up again; never secrets or personal data.`);
  return null;
}

if (isMain(import.meta.url)) run(evaluate);
