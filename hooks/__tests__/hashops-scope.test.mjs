import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluate } from "../hashops-scope.mjs";

const P = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const OTHER = "99999999-9999-4999-8999-999999999999";
const FB_P = "33333333-3333-4333-8333-333333333333";
const FB_B = "44444444-4444-4444-8444-444444444444";
const config = { hashops: { project_id: P, project_key: "HOPS", board_id: B } };
const feedback = { project_id: FB_P, board_id: FB_B, project_key: "HSM" };
const call = (tool, input, cfg = config) => evaluate({ tool_name: `mcp__plugin_hashsmith_hashops__${tool}`, tool_input: input }, cfg, feedback);
const decision = (...a) => call(...a)?.hookSpecificOutput.permissionDecision ?? null;

describe("hashops-scope", () => {
  it("has no opinion on calls that stay on this project", () => {
    assert.equal(decision("list_tasks", { project_id: P, board_id: B }), null);
    assert.equal(decision("get_task", { task_code: "hops-12", full: true }), null);
    assert.equal(decision("create_task", { board_id: B, list_id: "x", title: "t", tags: ["ai"] }), null);
    assert.equal(decision("list_my_projects", {}), null);
    assert.equal(decision("move_task", { task_id: OTHER, list_id: "x" }), null); // task_id: RLS decides
  });

  it("asks, naming the mismatch, when a call reaches another project, board or task", () => {
    assert.equal(decision("list_boards", { project_id: OTHER }), "ask");
    assert.equal(decision("get_board", { board_id: OTHER }), "ask");
    assert.equal(decision("comment_on_task", { task_code: "ATL-3", content: "x" }), "ask");
    const reason = call("list_tasks", { project_id: OTHER, board_id: OTHER }).hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, new RegExp(`project_id ${OTHER}`));
    assert.match(reason, /board_id/);
  });

  it("recognises task codes whose project key starts with a digit", () => {
    assert.equal(decision("get_task", { task_code: "3DS-4" }), "ask");
  });

  it("lets the Hashsmith feedback board through", () => {
    assert.equal(decision("create_task", { board_id: FB_B, list_id: "x", title: "t", tags: ["feedback"] }), null);
    assert.equal(decision("list_tasks", { project_id: FB_P }), null);
    assert.equal(decision("get_task", { task_code: "HSM-4" }), null);
  });

  it("on the feedback board, lets only filing a report through: every other write asks", () => {
    assert.equal(decision("update_task", { task_code: "HSM-4", title: "x" }), "ask");
    assert.equal(decision("move_task", { task_code: "HSM-4", list_id: "x" }), "ask");
    assert.equal(decision("comment_on_task", { task_code: "HSM-4", content: "x" }), "ask");
    assert.equal(decision("create_board_list", { board_id: FB_B, name: "x" }), "ask");
    assert.equal(decision("create_project_tag", { project_id: FB_P, name: "x" }), "ask");
    assert.match(call("move_task", { task_code: "HSM-4", list_id: "x" }).hookSpecificOutput.permissionDecisionReason, /feedback board/);
    // The Hashsmith repo itself is onboarded onto that board: there it is the project's own, and nothing asks.
    const own = { hashops: { project_id: FB_P, board_id: FB_B, project_key: "HSM" } };
    assert.equal(decision("move_task", { task_code: "HSM-4", list_id: "x" }, own), null);
    assert.equal(decision("comment_on_task", { task_code: "HSM-4", content: "x" }, own), null);
  });

  it("before onboarding, lets reads through and asks on writes", () => {
    assert.equal(decision("list_my_projects", {}, null), null);
    assert.equal(decision("get_board", { board_id: OTHER }, null), null);
    assert.equal(decision("create_task", { board_id: OTHER }, null), "ask");
    assert.equal(decision("comment_on_task", { task_code: "ATL-1" }, { hashops: { project_id: "" } }), "ask");
  });

  it("denies every HashOps tool Hashsmith's skills do not use, onboarded or not", () => {
    for (const cfg of [config, null]) {
      assert.equal(decision("approve_leave_request", { request_id: OTHER }, cfg), "deny");
      assert.equal(decision("update_person_profile", { user_id: OTHER }, cfg), "deny");
      assert.equal(decision("get_person_profile", { user_id: OTHER }, cfg), "deny");
    }
    assert.match(call("create_employee_event", {}).hookSpecificOutput.permissionDecisionReason, /only allows the tools its skills use/);
  });

  it("denies time logging and to-dos, and says where the developer's own HashOps tasks go", () => {
    for (const tool of ["log_daily_recap", "get_daily_recaps", "submit_daily_recap", "create_todo"]) {
      assert.equal(decision(tool, {}), "deny", tool);
      const reason = call(tool, {}).hookSpecificOutput.permissionDecisionReason;
      assert.match(reason, /Daily Recaps, to-dos/, tool);
      assert.match(reason, /HashOps app or their own HashOps connection/, tool);
    }
  });

  it("in an onboarded repo, asks before a HashOps write through another connection", () => {
    const other = (tool, cfg = config) =>
      evaluate({ tool_name: `mcp__peoplemuster__${tool}`, tool_input: {} }, cfg, feedback)?.hookSpecificOutput.permissionDecision ?? null;
    assert.equal(other("approve_leave_request"), "ask");
    assert.equal(other("create_task"), "ask");
    for (const tool of ["log_daily_recap", "submit_daily_recap", "create_todo"]) assert.equal(other(tool), "ask", tool); // the deny message promises this
    assert.equal(other("list_tasks"), null); // reads pass
    assert.equal(other("approve_leave_request", null), null); // not onboarded: not Hashsmith's business
    assert.equal(evaluate({ tool_name: "mcp__github__create_issue", tool_input: {} }, config, feedback), null);
    assert.equal(evaluate({ tool_name: "Bash", tool_input: {} }, config, feedback), null);
  });
});
