#!/usr/bin/env node
// PreToolUse(mcp__.*): keep HashOps calls to what Hashsmith needs, on this project (design §10).
// 1. Hashsmith's own HashOps connection may call only the tools its skills use
//    (hashops-tools.json `hashsmith`); everything else is denied, whatever the permission mode. The
//    developer is often an admin, and the MCP offers every tool their permissions allow.
// 2. The MCP sees every project the developer can see, so a project_id, board_id or task_code that
//    is not the one in hashsmith.json turns the call into an ask that names the mismatch. The
//    Hashsmith feedback board (feedback-board.json) is the one exception, for reads and filing a
//    report (create_task) only; other writes there ask unless it is the session's own project.
//    A call naming only a task_id carries no project: RLS decides it. Before onboarding, reads
//    pass and writes ask.
// 3. In an onboarded repo, a HashOps write through another connection to the same server (for
//    example the developer's own "peoplemuster") asks: Hashsmith's guards do not cover it.
// A call that passes gets no opinion: RLS and the normal permission flow decide.
import { readFileSync } from "node:fs";
import { decide, isMain, projectDir, readConfig, repoRoot, run } from "./lib.mjs";

const PREFIX = "mcp__plugin_hashsmith_hashops__";
const isRead = tool => /^(get|list|search|who)_/.test(tool);
const TASK_KEY = /^\s*([A-Za-z0-9]+)-\d+\s*$/;

function feedbackBoard() {
  try {
    return JSON.parse(readFileSync(new URL("./feedback-board.json", import.meta.url), "utf8"));
  } catch {
    return {};
  }
}
// Read at load: a missing or broken file makes the hook crash, and run() then asks (fail closed).
const TOOLS = JSON.parse(readFileSync(new URL("./hashops-tools.json", import.meta.url), "utf8"));

export function evaluate(event, config = readConfig(repoRoot(projectDir(event)) ?? projectDir(event)), feedback = feedbackBoard()) {
  const name = String(event.tool_name ?? "");
  const input = event.tool_input ?? {};
  const h = config?.hashops ?? {};
  if (!name.startsWith(PREFIX)) {
    const m = /^mcp__(.+?)__([a-z_]+)$/.exec(name);
    if (m && h.project_id && TOOLS.writes.includes(m[2]))
      return decide("ask", `\`${m[2]}\` writes to HashOps through "${m[1]}", not Hashsmith's own connection, so Hashsmith's checks do not cover it. Confirm only if you asked for this write yourself.`);
    return null;
  }
  const tool = name.slice(PREFIX.length);
  if (!TOOLS.hashsmith.includes(tool))
    return decide("deny", `Hashsmith's HashOps connection only allows the tools its skills use (hooks/hashops-tools.json); \`${tool}\` is not one of them. It is for Hashsmith's developer workflow only. The developer's own HashOps tasks (Daily Recaps, to-dos, leave) go through the HashOps app or their own HashOps connection, which asks before each write in an onboarded repo.`);

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
  // The feedback board's exception is for filing a report: create_task and reads. Any other write
  // there (moving, editing or commenting on someone's report) asks, unless it is this project's own.
  // A project whose own project is the feedback one (the Hashsmith repo) is never "on" it, even
  // with its board_id left empty.
  const ownIsFeedback = !!feedback.project_id && h.project_id === feedback.project_id;
  const onFeedback =
    !ownIsFeedback &&
    ((!!feedback.project_id && input.project_id === feedback.project_id) ||
      (!!feedback.board_id && input.board_id === feedback.board_id && input.board_id !== h.board_id) ||
      (!!key && !!fbKey && key === fbKey && key !== ownKey));
  if (onFeedback && !isRead(tool) && tool !== "create_task")
    mismatches.push("it is a write on the Hashsmith feedback board, where only filing a report (create_task) goes through");

  if (!mismatches.length) return null;
  return decide("ask", `\`${tool}\` reaches outside this project: ${mismatches.join("; ")}. Hashsmith works on one project per session. Confirm only if this is deliberate (for example, the board in hashsmith.json is stale).`);
}

if (isMain(import.meta.url)) run(event => evaluate(event));
