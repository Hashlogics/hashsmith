import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { evaluate, whatsNew } from "../session-start.mjs";

const version = JSON.parse(readFileSync(new URL("../../.claude-plugin/plugin.json", import.meta.url), "utf8")).version;
const tmp = () => mkdtempSync(join(tmpdir(), "hashsmith-test-"));
const repo = (config = null) => {
  const dir = tmp();
  mkdirSync(join(dir, ".git"));
  if (config) writeFileSync(join(dir, "hashsmith.json"), JSON.stringify(config));
  return dir;
};
const start = (cwd, seenFile = join(tmp(), "seen")) => {
  delete process.env.CLAUDE_PROJECT_DIR;
  return evaluate({ hook_event_name: "SessionStart", cwd }, { seenFile });
};

describe("session-start", () => {
  it("is inactive outside a git repository", () => {
    const out = start(tmp());
    assert.match(out.hookSpecificOutput.additionalContext, /INACTIVE/);
    assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /Hashsmith conduct/);
  });

  it("loads the conduct rules and proposes onboarding when there is no config", () => {
    const ctx = start(repo()).hookSpecificOutput.additionalContext;
    assert.match(ctx, /# Hashsmith conduct/);
    assert.match(ctx, /not onboarded/);
    assert.match(ctx, /mcp__plugin_hashsmith_hashops__/);
  });

  it("names the project when onboarded, also from a subfolder", () => {
    const dir = repo({ hashops: { project_id: "p1", project_key: "HOPS" } });
    mkdirSync(join(dir, "src"));
    const out = start(join(dir, "src"));
    assert.match(out.hookSpecificOutput.additionalContext, /onboarded: hashsmith.json .*HOPS/);
    assert.equal(out.systemMessage, `Hashsmith ${version} · HOPS`);
  });

  it("gives skills the CLI's absolute path when active, never when inactive", () => {
    assert.match(start(repo()).hookSpecificOutput.additionalContext, /Hashsmith CLI: node "\/.*\/scripts\/hashsmith\.mjs"/);
    assert.doesNotMatch(start(tmp()).hookSpecificOutput.additionalContext, /Hashsmith CLI/);
  });

  it("records the version, and shows notes only after an update", () => {
    const seen = join(tmp(), "nested", "last_seen_version");
    const first = start(repo(), seen);
    assert.equal(readFileSync(seen, "utf8").trim(), version);
    assert.doesNotMatch(first.hookSpecificOutput.additionalContext, /was updated/);

    writeFileSync(seen, "0.0.1\n");
    const updated = start(repo(), seen);
    assert.match(updated.hookSpecificOutput.additionalContext, new RegExp(`updated from 0.0.1 to ${version.replace(/\./g, "\\.")}`));
    assert.match(updated.systemMessage, /updated from 0\.0\.1/);
    assert.equal(readFileSync(seen, "utf8").trim(), version);
  });

  it("whatsNew returns only the sections newer than the given version", () => {
    const log = "# Changelog\n\nintro\n\n## 0.3.0 — c\n- three\n\n## 0.2.10 — b\n- two\n\n## 0.2.9 — a\n- one\n";
    assert.equal(whatsNew(log, "0.2.9"), "## 0.3.0 — c\n- three\n\n## 0.2.10 — b\n- two");
    assert.equal(whatsNew(log, "0.3.0"), "");
  });
});
