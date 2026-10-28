// Runs each hook as Claude Code does: a node process with the event JSON on stdin.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const hook = name => fileURLToPath(new URL(`../${name}`, import.meta.url));
const runHook = (name, event, env = {}) => {
  const r = spawnSync(process.execPath, [hook(name)], { input: JSON.stringify(event), encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
};

describe("hooks as processes", () => {
  it("git-guard denies a commit", () => {
    assert.equal(runHook("git-guard.mjs", { tool_name: "Bash", tool_input: { command: "git commit -m x" } }).hookSpecificOutput.permissionDecision, "deny");
  });
  it("env-guard denies reading .env", () => {
    assert.equal(runHook("env-guard.mjs", { tool_name: "Read", tool_input: { file_path: "/x/.env" } }).hookSpecificOutput.permissionDecision, "deny");
  });
  it("hashops-scope asks on a write before onboarding", () => {
    const out = runHook("hashops-scope.mjs", { tool_name: "mcp__plugin_hashsmith_hashops__create_task", tool_input: {}, cwd: "/" }, { CLAUDE_PROJECT_DIR: "/" });
    assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
  });
  it("config-guard denies a token in hashsmith.json", () => {
    const out = runHook("config-guard.mjs", { tool_name: "Write", tool_input: { file_path: "hashsmith.json", content: "ghp_abcdefghijklmnopqrstuvwx" } });
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  });
  it("prints nothing when it has no opinion", () => {
    assert.equal(runHook("git-guard.mjs", { tool_name: "Bash", tool_input: { command: "git status" } }), null);
  });
  it("treats unparsable input as an empty event: no command, no opinion", () => {
    const r = spawnSync(process.execPath, [hook("git-guard.mjs")], { input: "not json", encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  });
  it("session-start emits SessionStart context", () => {
    const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
    const out = runHook("session-start.mjs", { hook_event_name: "SessionStart", cwd: repoRoot }, {
      CLAUDE_PROJECT_DIR: repoRoot,
      HOME: mkdtempSync(join(tmpdir(), "hashsmith-home-")), // the hook writes ~/.hashsmith/last_seen_version
    });
    assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
    assert.ok(out.systemMessage.startsWith("Hashsmith "));
  });
});
