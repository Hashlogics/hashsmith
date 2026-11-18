#!/usr/bin/env node
// PostToolUse(start_health_report | get_checklist_instance on Hashsmith's own HashOps connection):
// remember, per session, which checklist is this project's health report and which items are on
// it (design §10, HSM-24). hashops-scope.mjs lets get_checklist_instance and
// set_checklist_item_status through only for those ids: the tools take only an id, so without
// this they would reach every checklist the developer can see, people's onboarding among them.
// - start_health_report whose project_id is this project's (trusted hashsmith.json): its checklistId.
// - get_checklist_instance on a recorded checklist: the ids of its items.
// It prints nothing. Anything it cannot read records nothing, so the later call asks (fails closed).
import { trustedHashops, scopeConfig } from "./hashops-scope.mjs";
import { isMain, projectDir, readPins, run, writePins } from "./lib.mjs";

const PREFIX = "mcp__plugin_hashsmith_hashops__";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid = v => (typeof v === "string" && UUID.test(v.trim().toLowerCase()) ? v.trim().toLowerCase() : null);
const ITEM_CAP = 500;

const parse = s => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);

/** The `result` data of a tool response. MCP results arrive as text blocks holding
 *  {"result": data}; Claude Code may pass them as a string, as blocks ({content: blocks} too) or
 *  as the object itself. Only those outer layers are parsed: text inside the data (an item's task
 *  or notes, which checklist authors write) is never read as JSON. */
function resultOf(response) {
  const top = typeof response === "string" ? parse(response) : response;
  const blocks = Array.isArray(top) ? top : Array.isArray(top?.content) ? top.content : null;
  const candidates = blocks ? blocks.filter(b => typeof b?.text === "string").map(b => parse(b.text)) : [top];
  return candidates.map(c => (isObj(c) && isObj(c.result) ? c.result : null)).find(Boolean) ?? null;
}

/** The pins after this call, or null when it adds nothing. */
export function record(event, config = scopeConfig(projectDir(event)), current = readPins(event.session_id)) {
  const name = String(event.tool_name ?? "");
  if (!name.startsWith(PREFIX)) return null;
  const tool = name.slice(PREFIX.length);
  const input = event.tool_input ?? {};
  const projectId = trustedHashops(config).project_id;
  if (!projectId) return null;
  const pins =
    current?.project_id === projectId && Array.isArray(current.checklists) && Array.isArray(current.items)
      ? { project_id: projectId, checklists: [...current.checklists], items: [...current.items] }
      : { project_id: projectId, checklists: [], items: [] };
  const result = resultOf(event.tool_response);
  if (!result) return null;

  if (tool === "start_health_report") {
    if (String(input.project_id ?? "").trim().toLowerCase() !== String(projectId).toLowerCase()) return null;
    const id = uuid(result.checklistId);
    if (!id || pins.checklists.includes(id)) return null;
    pins.checklists.push(id);
    return pins;
  }
  if (tool === "get_checklist_instance") {
    const id = uuid(input.instance_id);
    if (!id || !pins.checklists.includes(id)) return null;
    if (uuid(result.id) !== id || !Array.isArray(result.items)) return null;
    const items = result.items.map(i => uuid(i?.id)).filter(i => i && !pins.items.includes(i));
    if (!items.length) return null;
    pins.items = [...pins.items, ...items].slice(-ITEM_CAP);
    return pins;
  }
  return null;
}

if (isMain(import.meta.url))
  run(
    event => {
      const pins = record(event);
      if (pins) writePins(event.session_id, pins);
      return null;
    },
    () => null, // a crash records nothing: the next checklist call asks
  );
