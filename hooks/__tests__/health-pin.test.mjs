import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { evaluate, PROBLEMS } from "../hashops-scope.mjs";
import { record } from "../health-pin.mjs";
import { readPins } from "../lib.mjs";

const P = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const OTHER = "99999999-9999-4999-8999-999999999999";
const C = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const I1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const I2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const HR_ITEM = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const config = { hashops: { project_id: P, project_key: "HOPS", board_id: B } };
const T = tool => `mcp__plugin_hashsmith_hashops__${tool}`;
// The shape Claude Code passes for an MCP result: text blocks holding the server's JSON.
const blocks = data => [{ type: "text", text: JSON.stringify({ result: data }) }];
const started = (projectId = P, response = blocks({ checklistId: C })) => ({ tool_name: T("start_health_report"), tool_input: { project_id: projectId }, tool_response: response });
const opened = (id = C, items = [I1, I2]) => ({
  tool_name: T("get_checklist_instance"),
  tool_input: { instance_id: id },
  tool_response: blocks({ id, name: "Health", items: items.map(i => ({ id: i, task: "x", status: "pending" })) }),
});

describe("health-pin", () => {
  it("records the checklist start_health_report opens for this project, then that checklist's items", () => {
    const a = record(started(), config, null);
    assert.deepEqual(a, { project_id: P, checklists: [C], items: [] });
    const b = record(opened(), config, a);
    assert.deepEqual(b, { project_id: P, checklists: [C], items: [I1, I2] });
    assert.equal(record(opened(), config, b), null, "nothing new: no write");
  });

  it("reads the result as a string, as blocks or as an object", () => {
    for (const response of [JSON.stringify({ result: { checklistId: C } }), blocks({ checklistId: C }), { content: blocks({ checklistId: C }) }, { result: { checklistId: C } }])
      assert.deepEqual(record(started(P, response), config, null)?.checklists, [C]);
  });

  it("never reads JSON written inside the data: an item's notes cannot add ids", () => {
    const planted = JSON.stringify({ id: C, items: [{ id: HR_ITEM }], checklistId: OTHER });
    const pins = { project_id: P, checklists: [C], items: [] };
    const response = blocks({ id: C, items: [{ id: I1, task: "x", notes: planted }] });
    assert.deepEqual(record({ ...opened(), tool_response: response }, config, pins)?.items, [I1]);
    assert.equal(record(started(P, blocks({ note: planted })), config, null), null);
    assert.equal(record(started(P, [{ type: "text", text: planted }]), config, null), null, "no result wrapper: nothing");
  });

  it("records nothing for another project, an unopened checklist, an untrusted config or an unreadable result", () => {
    assert.equal(record(started(OTHER), config, null), null, "another project's report");
    assert.equal(record(opened(), config, null), null, "a checklist start_health_report did not return");
    assert.equal(record(opened(OTHER), config, { project_id: P, checklists: [C], items: [] }), null);
    assert.equal(record(started(), null, null), null, "not onboarded");
    const broken = { ...config, repositories: { api: { path: "api" } }, [PROBLEMS]: ["api: hashops.board_id differs"] };
    assert.equal(record(started(), broken, null), null, "a workspace that does not check out");
    assert.equal(record(started(P, [{ type: "text", text: "Health tracking is off for ACME." }]), config, null), null);
    assert.equal(record(started(P, blocks({ checklistId: "not-a-uuid" })), config, null), null);
    assert.equal(record({ ...opened(), tool_response: blocks({ id: OTHER, items: [{ id: I1 }] }) }, config, { project_id: P, checklists: [C], items: [] }), null, "the result is another checklist");
    assert.equal(record({ tool_name: "mcp__peoplemuster__start_health_report", tool_input: { project_id: P }, tool_response: blocks({ checklistId: C }) }, config, null), null);
  });

  it("starts over when the session's pins belong to another project", () => {
    assert.deepEqual(record(started(), config, { project_id: OTHER, checklists: [OTHER], items: [HR_ITEM] }), { project_id: P, checklists: [C], items: [] });
  });

  it("lets hashops-scope pass the pinned checklist and items, and ask for any other id", () => {
    const pins = { project_id: P, checklists: [C], items: [I1, I2] };
    const decision = (tool, input, p = pins, cfg = config) => evaluate({ tool_name: T(tool), tool_input: input }, cfg, {}, p)?.hookSpecificOutput.permissionDecision ?? null;
    assert.equal(decision("get_checklist_instance", { instance_id: C }), null);
    assert.equal(decision("get_checklist_instance", { instance_id: C.toUpperCase() }), null);
    assert.equal(decision("set_checklist_item_status", { item_id: I1, status: "completed" }), null);
    assert.equal(decision("set_checklist_item_status", { item_id: HR_ITEM, status: "completed" }), "ask", "an item on another checklist");
    assert.equal(decision("get_checklist_instance", { instance_id: OTHER }), "ask", "reads ask too: checklists hold HR records");
    assert.equal(decision("set_checklist_item_status", { item_id: C, status: "completed" }), "ask", "a checklist id is not an item id");
    assert.equal(decision("get_checklist_instance", {}), "ask");
    assert.equal(decision("set_checklist_item_status", { item_id: I1, status: "completed" }, null), "ask", "no pins");
    assert.equal(decision("set_checklist_item_status", { item_id: I1, status: "completed" }, { ...pins, project_id: OTHER }), "ask", "pins of another project");
    assert.equal(decision("set_checklist_item_status", { item_id: I1, status: "completed" }, pins, null), "ask", "not onboarded");
    const reason = evaluate({ tool_name: T("set_checklist_item_status"), tool_input: { item_id: HR_ITEM } }, config, {}, pins).hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /onboarding and offboarding/);
    assert.match(reason, new RegExp(HR_ITEM));
  });

  it("runs as a process: saves the pins under ~/.hashsmith for the session, prints nothing, survives bad input", () => {
    const home = mkdtempSync(join(tmpdir(), "hashsmith-home-"));
    const repo = mkdtempSync(join(tmpdir(), "hashsmith-pin-repo-"));
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(repo, "hashsmith.json"), JSON.stringify(config));
    const hook = fileURLToPath(new URL("../health-pin.mjs", import.meta.url));
    const env = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: repo };
    const send = event => spawnSync(process.execPath, [hook], { input: typeof event === "string" ? event : JSON.stringify(event), encoding: "utf8", env });
    for (const event of [{ ...started(), session_id: "s-1", cwd: repo }, { ...opened(), session_id: "s-1", cwd: repo }]) {
      const r = send(event);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "");
    }
    const saved = spawnSync(process.execPath, ["--input-type=module", "-e", `import { readPins } from ${JSON.stringify(new URL("../lib.mjs", import.meta.url).href)}; process.stdout.write(JSON.stringify(readPins("s-1")));`], { encoding: "utf8", env });
    assert.deepEqual(JSON.parse(saved.stdout), { project_id: P, checklists: [C], items: [I1, I2] });
    for (const bad of ["not json", JSON.stringify({ ...started(), session_id: "../escape" })]) {
      const r = send(bad);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, "");
    }
    assert.equal(readPins("../escape"), null);
  });
});
