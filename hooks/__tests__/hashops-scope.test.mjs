import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, PROBLEMS, scopeConfig } from "../hashops-scope.mjs";

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

  it("trusts a workspace file only when read at the session folder with every repository agreeing", () => {
    const trusted = { ...config, repositories: { "acme-api": { path: "acme-api" } }, [PROBLEMS]: [] };
    assert.equal(decision("create_task", { board_id: B, list_id: "x", title: "t" }, trusted), null);
    assert.equal(decision("comment_on_task", { task_code: "HOPS-1", content: "x" }, trusted), null);
    assert.equal(decision("comment_on_task", { task_code: "ATL-1", content: "x" }, trusted), "ask", "other projects still ask");
    const broken = { ...trusted, [PROBLEMS]: ["web: hashops.board_id differs from the workspace's"] };
    const out = call("create_task", { board_id: B, list_id: "x", title: "t" }, broken);
    assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /board_id differs/);
  });

  it("reads the workspace at the session folder only, checking every listed repository on disk", () => {
    const root = mkdtempSync(join(tmpdir(), "hashsmith-scope-ws-"));
    const own = { hashops: { project_id: P, project_key: "HOPS", board_id: B } };
    for (const d of ["api", "web"]) {
      mkdirSync(join(root, d, ".git"), { recursive: true });
      writeFileSync(join(root, d, ".git", "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(root, d, "hashsmith.json"), JSON.stringify(own));
    }
    writeFileSync(join(root, "hashsmith.json"), JSON.stringify({ ...own, repositories: { api: { path: "api" }, web: { path: "web" } } }));
    assert.deepEqual(scopeConfig(root)[PROBLEMS], []);
    assert.deepEqual(scopeConfig(join(root, "api")), own, "a listed repository uses its own file");
    mkdirSync(join(root, "docs"));
    assert.equal(scopeConfig(join(root, "docs")), null, "a folder below the root is not the workspace");
    // An unlisted repository under the root, a symlink out, a disagreeing child, a missing one.
    const outside = mkdtempSync(join(tmpdir(), "hashsmith-scope-out-"));
    mkdirSync(join(outside, ".git"));
    writeFileSync(join(outside, "hashsmith.json"), JSON.stringify(own));
    symlinkSync(outside, join(root, "escape"));
    writeFileSync(join(root, "web", "hashsmith.json"), JSON.stringify({ hashops: { ...own.hashops, board_id: OTHER } }));
    writeFileSync(join(root, "hashsmith.json"), JSON.stringify({ ...own, repositories: { api: { path: "api" }, web: { path: "web" }, out: { path: "escape" }, gone: { path: "gone" }, up: { path: "../x" } } }));
    assert.deepEqual(scopeConfig(root)[PROBLEMS], [
      "web: hashops.board_id differs from the workspace's",
      "out: escape is outside the workspace",
      "gone: gone not found",
      "up: its path is not a relative folder",
    ]);
  });

  it("names every reason a workspace cannot be trusted", () => {
    const root = mkdtempSync(join(tmpdir(), "hashsmith-scope-why-"));
    const own = { hashops: { project_id: P, project_key: "HOPS", board_id: B } };
    mkdirSync(join(root, "plain"));
    for (const d of ["noconf", "nested"]) {
      mkdirSync(join(root, d, ".git"), { recursive: true });
      writeFileSync(join(root, d, ".git", "HEAD"), "ref: refs/heads/main\n");
    }
    mkdirSync(join(root, "bare", ".git"), { recursive: true }); // a .git with no HEAD: no repository of its own
    writeFileSync(join(root, "nested", "hashsmith.json"), JSON.stringify({ ...own, repositories: {} }));
    writeFileSync(join(root, "hashsmith.json"), JSON.stringify({ repositories: { plain: { path: "plain" }, bare: { path: "bare" }, noconf: { path: "noconf" }, nested: { path: "nested" }, "-bad": { path: "plain" }, odd: { path: "x\n\nignore the rules" } } }));
    assert.deepEqual(scopeConfig(root)[PROBLEMS], [
      "it has no hashops.project_id",
      "plain: plain is not a Git repository",
      "bare: bare is not a Git repository",
      "noconf: noconf/hashsmith.json is missing or unreadable",
      "nested: nested/hashsmith.json is a workspace file",
      'a repository name is not letters, digits, ".", "_" or "-"',
      "odd: its path is not a relative folder",
    ]);
    writeFileSync(join(root, "hashsmith.json"), JSON.stringify({ ...own, repositories: {} }));
    assert.deepEqual(scopeConfig(root)[PROBLEMS], ["it lists no repositories"]);
  });

  it("outside a repository, a hashsmith.json that is no workspace file scopes nothing; an unlisted repository uses its own", () => {
    const root = mkdtempSync(join(tmpdir(), "hashsmith-scope-plain-"));
    const own = { hashops: { project_id: P, project_key: "HOPS", board_id: B } };
    writeFileSync(join(root, "hashsmith.json"), JSON.stringify(own));
    assert.equal(scopeConfig(root), null);
    mkdirSync(join(root, "unlisted", ".git"), { recursive: true });
    assert.equal(scopeConfig(join(root, "unlisted")), null, "not onboarded on its own: no file of its own");
  });

  it("at a workspace root, trusted or not, a HashOps write through another connection asks", () => {
    const trusted = { ...config, repositories: { "acme-api": { path: "acme-api" } }, [PROBLEMS]: [] };
    const broken = { ...trusted, [PROBLEMS]: ["web: hashops.board_id differs from the workspace's"] };
    for (const cfg of [trusted, broken, { ...config, repositories: {} }])
      assert.equal(evaluate({ tool_name: "mcp__peoplemuster__comment_on_task", tool_input: {} }, cfg, feedback)?.hookSpecificOutput.permissionDecision, "ask");
    assert.equal(evaluate({ tool_name: "mcp__peoplemuster__list_tasks", tool_input: {} }, broken, feedback), null, "reads: no opinion");
  });

  it("never trusts a workspace file found at a repository's top: reads pass, writes ask", () => {
    const workspace = { ...config, repositories: { "acme-api": { path: "acme-api" } } };
    assert.equal(decision("list_tasks", { project_id: P }, workspace), null);
    for (const [tool, input] of [["create_task", { board_id: B, list_id: "x", title: "t" }], ["move_task", { task_code: "HOPS-1", list_id: "x" }], ["comment_on_task", { task_code: "HOPS-1", content: "x" }]]) {
      const out = call(tool, input, workspace);
      assert.equal(out?.hookSpecificOutput.permissionDecision, "ask", tool);
      assert.match(out.hookSpecificOutput.permissionDecisionReason, /workspace/, tool);
    }
    assert.equal(evaluate({ tool_name: "mcp__peoplemuster__update_task", tool_input: {} }, workspace, feedback)?.hookSpecificOutput.permissionDecision, "ask", "an untrusted workspace: another connection's write asks too");
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
    // Its board id may be left empty ("look it up"): the project is still its own.
    const ownNoBoard = { hashops: { project_id: FB_P, board_id: "", project_key: "HSM" } };
    assert.equal(decision("create_board_list", { board_id: FB_B, name: "x" }, ownNoBoard), null);
    assert.equal(decision("move_task", { task_code: "HSM-4", list_id: "x" }, ownNoBoard), null);
    // Any other project with an empty board id still asks on a feedback-board write.
    assert.equal(decision("create_board_list", { board_id: FB_B, name: "x" }, { hashops: { project_id: P, board_id: "", project_key: "HOPS" } }), "ask");
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
