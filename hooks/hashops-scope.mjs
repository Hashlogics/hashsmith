#!/usr/bin/env node
// PreToolUse(mcp__plugin_hashsmith_hashops__.*): keep HashOps calls on this project (design §10).
// The MCP sees every project the developer can see, so a project_id, board_id or task_code that is
// not the one in hashsmith.json turns the call into an ask that names the mismatch. The Hashsmith
// feedback board (feedback-board.json) is the one allowed exception. Before onboarding, reads pass
// and writes ask. A call that matches gets no opinion: RLS and the normal permission flow decide.
import { readFileSync } from "node:fs";
import { decide, isMain, projectDir, readConfig, repoRoot, run } from "./lib.mjs";

const PREFIX = "mcp__plugin_hashsmith_hashops__";
const isRead = tool => /^(get|list|search|who)_/.test(tool);
const TASK_KEY = /^\s*([A-Za-z][A-Za-z0-9]*)-\d+\s*$/;

function feedbackBoard() {
  try {
    return JSON.parse(readFileSync(new URL("./feedback-board.json", import.meta.url), "utf8"));
  } catch {
    return {};
  }
}

export function evaluate(event, config = readConfig(repoRoot(projectDir(event)) ?? projectDir(event)), feedback = feedbackBoard()) {
  const name = String(event.tool_name ?? "");
  if (!name.startsWith(PREFIX)) return null;
  const tool = name.slice(PREFIX.length);
  const input = event.tool_input ?? {};
  const h = config?.hashops ?? {};

  if (!h.project_id) {
    if (isRead(tool)) return null;
    return decide("ask", `\`${tool}\` writes to HashOps, and this project has no HashOps project in hashsmith.json yet. Run /hashsmith:onboard-project first, or confirm this one write.`);
  }

  const mismatches = [];
  const allowed = (value, own, fb) => !value || value === own || (!!fb && value === fb);
  if (!allowed(input.project_id, h.project_id, feedback.project_id))
    mismatches.push(`project_id ${input.project_id} is not this project's (${h.project_id})`);
  if (h.board_id && !allowed(input.board_id, h.board_id, feedback.board_id))
    mismatches.push(`board_id ${input.board_id} is not the board in hashsmith.json (${h.board_id})`);
  const key = TASK_KEY.exec(String(input.task_code ?? ""))?.[1]?.toUpperCase();
  const ownKey = String(h.project_key ?? "").toUpperCase();
  const fbKey = String(feedback.project_key ?? "").toUpperCase();
  if (key && ownKey && key !== ownKey && key !== fbKey)
    mismatches.push(`task ${String(input.task_code).trim()} is not on this project (${ownKey}-…)`);

  if (!mismatches.length) return null;
  return decide("ask", `\`${tool}\` reaches outside this project: ${mismatches.join("; ")}. Hashsmith works on one project per session. Confirm only if this is deliberate (for example, the board in hashsmith.json is stale).`);
}

if (isMain(import.meta.url)) run(event => evaluate(event));
