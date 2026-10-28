import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluate } from "../config-guard.mjs";

const write = (content, file_path = "/repo/hashsmith.json") => evaluate({ tool_name: "Write", tool_input: { file_path, content } });
const decision = out => out?.hookSpecificOutput.permissionDecision ?? null;

const clean = JSON.stringify(
  {
    version: 1,
    hashops: { project_id: "11111111-1111-4111-8111-111111111111", project_key: "HOPS", ai_tag: "ai" },
    sonar: { project_key: "hashlogics_hashops" },
    learned: { qa_login_route: { value: "/login", why: "QA starts here", source: "src/App.tsx", added: "2026-10-28" } },
  },
  null,
  2,
);

describe("config-guard", () => {
  it("allows ids and settings", () => {
    assert.equal(write(clean), null);
  });

  it("denies secret-shaped or personal content", () => {
    for (const bad of [
      '{"x": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc"}',
      '{"x": "sk_live_abcdefghijkl"}',
      '{"x": "ghp_abcdefghijklmnopqrstuvwx"}',
      '{"x": "xoxb-1234567890-abc"}',
      '{"x": "-----BEGIN PRIVATE KEY-----"}',
      '{"qa_user": "someone@example.com"}',
      '{"learned": {"sentry_api_key": {"value": "x"}}}',
      '{"learned": {"db_password": {"value": "x"}}}',
      '{"learned": {"slack_token": {"value": "x"}}}',
    ])
      assert.equal(decision(write(bad)), "deny", bad);
  });

  it("checks Edit and MultiEdit too", () => {
    assert.equal(decision(evaluate({ tool_name: "Edit", tool_input: { file_path: "hashsmith.json", old_string: "a", new_string: '"ghp_abcdefghijklmnopqrstuvwx"' } })), "deny");
    assert.equal(
      decision(evaluate({ tool_name: "MultiEdit", tool_input: { file_path: "hashsmith.json", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "x@y.io" }] } })),
      "deny",
    );
  });

  it("ignores every other file", () => {
    assert.equal(write('{"email": "someone@example.com"}', "/repo/package.json"), null);
    assert.equal(write("x", "/repo/hashsmith.json.bak"), null);
  });
});
