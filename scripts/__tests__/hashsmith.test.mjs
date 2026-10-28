import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  branchesForKey,
  checkConfig,
  envKeyNames,
  gitSwitchRule,
  missingEnvKeys,
  repoSlug,
  ticketState,
  treeState,
} from "../hashsmith.mjs";
import * as cli from "../hashsmith.mjs";

const CLI = fileURLToPath(new URL("../hashsmith.mjs", import.meta.url));
// A git repo without running a git write: the minimal .git layout git status accepts.
function fixtureRepo(config = "") {
  const dir = mkdtempSync(join(tmpdir(), "hashsmith-repo-"));
  for (const d of [".git/objects", ".git/refs/heads"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, ".git/HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dir, ".git/config"), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n${config}`);
  return dir;
}
const U = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("repoSlug", () => {
  it("normalises SSH and HTTPS forms of the same repo", () => {
    assert.equal(repoSlug("git@github.com:Hashlogics/hashops.git"), "github.com/hashlogics/hashops");
    assert.equal(repoSlug("https://github.com/hashlogics/hashops/"), "github.com/hashlogics/hashops");
    assert.equal(repoSlug("ssh://git@github.com/Hashlogics/hashops"), "github.com/hashlogics/hashops");
  });
  it("keeps the owner, so a renamed org does not match", () => {
    assert.equal(repoSlug("https://github.com/admin-hashlogics/hashops/blob/dev/README.md"), "github.com/admin-hashlogics/hashops");
  });
  it("drops credentials and returns null for non-URLs", () => {
    assert.equal(repoSlug("https://u:t@gitlab.com/a/b.git"), "gitlab.com/a/b");
    assert.equal(repoSlug("nope"), null);
  });
});

describe("repoSlug: nested paths and odd forms", () => {
  it("keeps the whole path, so subgroup repos stay apart", () => {
    assert.equal(repoSlug("https://gitlab.com/group/sub/repoA.git"), "gitlab.com/group/sub/repoa");
    assert.equal(repoSlug("git@gitlab.com:group/sub/repoA.git"), "gitlab.com/group/sub/repoa");
    assert.notEqual(repoSlug("https://gitlab.com/group/sub/repoB"), repoSlug("https://gitlab.com/group/sub/repoA"));
    assert.equal(repoSlug("https://gitlab.com/group/sub/repoA/-/tree/main"), "gitlab.com/group/sub/repoa");
  });
  it("strips .git in any case and a www. host prefix", () => {
    assert.equal(repoSlug("https://github.com/Org/Repo.GIT"), "github.com/org/repo");
    assert.equal(repoSlug("https://www.github.com/org/repo"), "github.com/org/repo");
  });
  it("returns null for an SSH host alias, which is not a real host", () => {
    assert.equal(repoSlug("git@github-work:Org/repo.git"), null);
  });
});

describe("repoMatches", () => {
  it("returns the links that are the origin's repo", () => {
    assert.deepEqual(
      cli.repoMatches("git@github.com:Org/app.git", ["https://github.com/org/app", "https://github.com/org/other", "nope"]),
      ["https://github.com/org/app"],
    );
  });
  it("never matches when the origin is missing or unparsable", () => {
    assert.deepEqual(cli.repoMatches(null, ["nope", "https://github.com/org/app"]), []);
    assert.deepEqual(cli.repoMatches("nope", ["nope"]), []);
  });
});

describe("env key names", () => {
  it("reads names only, skipping comments and commented-out keys", () => {
    assert.deepEqual(envKeyNames("# A=1\nexport B=2\nC=\n#D=4\n"), ["B", "C"]);
  });
  it("lists example keys no env file defines", () => {
    assert.deepEqual(missingEnvKeys("A=\nB=\n", ["A=1"]), ["B"]);
  });
});

describe("gitSwitchRule", () => {
  it("deny wins, then ask", () => {
    assert.equal(gitSwitchRule({ permissions: { deny: ["Bash(git switch *)"] } }), "deny");
    assert.equal(gitSwitchRule({ permissions: { deny: ["Bash(git switch *)"], ask: ["Bash(git switch *)"] } }), "deny");
    assert.equal(gitSwitchRule({ permissions: { ask: ["Bash(git switch *)"] } }), "ask");
    assert.equal(gitSwitchRule({}), "none");
  });
});

describe("checkConfig", () => {
  const valid = () => ({
    version: 1,
    hashops: {
      project_id: U(1),
      project_key: "ACME",
      board_id: U(2),
      lists: { todo: U(3), in_progress: U(4), review: U(5), qa: "", done: U(6) },
      ai_tag: "ai",
    },
    repo: { base_branch: "dev" },
    qa: { base_url: "http://localhost:8080" },
    sonar: { project_key: "hashlogics_acme" },
    intake: { processed_meetings: [{ id: "m1", on: "2026-10-27", tickets: ["ACME-1"], note: "x" }] },
    learned: { qa_login_route: { value: "/login", why: "w", source: "s", added: "2026-10-28" } },
  });
  const broken = mutate => {
    const c = valid();
    mutate(c);
    return checkConfig(c);
  };

  it("accepts a full config", () => assert.deepEqual(checkConfig(valid()), []));
  it("rejects each malformed key with exactly one error", () => {
    for (const mutate of [
      c => (c.version = 2),
      c => (c.hashops.project_key = "acme"),
      c => delete c.hashops.lists.qa,
      c => (c.qa.base_url = "localhost"),
      c => (c.intake.processed_meetings[0].tickets = ["acme-1"]),
      c => (c.extra = 1),
      c => (c.learned.QaRoute = c.learned.qa_login_route),
    ])
      assert.equal(broken(mutate).length, 1, String(mutate));
  });
  it("accepts only a local qa.base_url, so QA can never point at a hosted app", () => {
    for (const url of ["http://localhost:8080", "http://127.0.0.1:5173/app", "https://localhost", ""]) {
      const c = valid();
      c.qa.base_url = url;
      assert.deepEqual(checkConfig(c), [], url);
    }
    for (const url of ["https://staging.acme.com", "http://localhost.evil.com", "http://10.0.0.5:8080"]) {
      const c = valid();
      c.qa.base_url = url;
      assert.equal(checkConfig(c).length, 1, url);
    }
  });
  it("accepts any key HashOps can generate, including a leading digit", () => {
    const c = valid();
    c.hashops.project_key = "3DS";
    assert.deepEqual(checkConfig(c), []);
  });
  it("rejects a non-object", () => assert.ok(checkConfig(null).length > 0));
});

describe("branches and ticket state", () => {
  const branches = ["ai/ACME-1-a", "ai/ACME-12-b", "ai/ACME-12-ACME-15-c", "main"];
  it("matches a key only when it is not the prefix of a longer number", () => {
    assert.deepEqual(branchesForKey(branches, "ACME-12"), ["ai/ACME-12-b", "ai/ACME-12-ACME-15-c"]);
    assert.deepEqual(branchesForKey(branches, "ACME-1"), ["ai/ACME-1-a"]);
    assert.deepEqual(branchesForKey(branches, "ACME-15"), ["ai/ACME-12-ACME-15-c"]);
  });
  it("matches a key only in the branch's leading key segment, not in the slug", () => {
    assert.deepEqual(branchesForKey(["ai/ACME-3-fix-ACME-12-regression", "ai/ACME-12-x"], "ACME-12"), ["ai/ACME-12-x"]);
  });
  it("across several branches, reports the furthest-along state and flags the ambiguity", () => {
    const r = cli.ticketStateFor([
      { branch: "ai/ACME-12-b", pr: null },
      { branch: "ai/ACME-12-ACME-15-c", pr: { number: 7, state: "OPEN" } },
    ]);
    assert.equal(r.state, "qa");
    assert.equal(r.branch, "ai/ACME-12-ACME-15-c");
    assert.equal(r.ambiguous, true);
    assert.deepEqual(cli.ticketStateFor([]), { branch: null, pr: null, state: "no-branch", ambiguous: false });
    assert.equal(cli.ticketStateFor([{ branch: "ai/ACME-1-a", pr: null }]).ambiguous, false);
  });
  it("lists ai/* branches from local and origin, once each", () => {
    assert.deepEqual(cli.aiBranches(["ai/ACME-1-x", "main"], ["origin/ai/ACME-1-x", "origin/ai/ACME-2-y", "origin/HEAD", "origin/dev"]), [
      "ai/ACME-1-x",
      "ai/ACME-2-y",
    ]);
  });
  it("maps branch and PR to the §4 states", () => {
    assert.equal(ticketState(null, null), "no-branch");
    assert.equal(ticketState(null, "ai/x"), "review");
    assert.equal(ticketState({ state: "OPEN" }, "ai/x"), "qa");
    assert.equal(ticketState({ state: "MERGED" }, "ai/x"), "qa-merged");
    assert.equal(ticketState({ state: "CLOSED" }, "ai/x"), "pr-closed");
  });
  it("parses NUL-separated porcelain status, keeping the first entry's leading space", () => {
    assert.deepEqual(treeState(" M a.ts\0?? src b.ts\0R  new.ts\0old.ts\0"), { clean: false, files: ["a.ts", "src b.ts", "new.ts"] });
    assert.deepEqual(treeState(""), { clean: true, files: [] });
  });
});

describe("CLI", () => {
  it("env-keys prints missing names and never a value", () => {
    const dir = mkdtempSync(join(tmpdir(), "hashsmith-cli-"));
    writeFileSync(join(dir, ".env.example"), "A=\nB=\n");
    writeFileSync(join(dir, ".env"), "A=secret-value\n");
    const r = spawnSync(process.execPath, [CLI, "env-keys"], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '{"example":true,"missing":["B"]}');
    assert.doesNotMatch(r.stdout + r.stderr, /secret-value/);
  });
  it("check-config exits 1 with errors for an invalid file", () => {
    const dir = mkdtempSync(join(tmpdir(), "hashsmith-cli-"));
    writeFileSync(join(dir, "hashsmith.json"), '{"version": 2}');
    const r = spawnSync(process.execPath, [CLI, "check-config"], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stdout).ok, false);
  });
  it("tree lists paths with spaces as they are, unquoted", () => {
    const dir = fixtureRepo();
    writeFileSync(join(dir, "src a.ts"), "x");
    const r = spawnSync(process.execPath, [CLI, "tree"], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { clean: false, files: ["src a.ts"], branch: "main" });
  });
  it("repo-slug reads link URLs as a JSON array on stdin and reports the matches", () => {
    const dir = fixtureRepo('[remote "origin"]\n\turl = git@github.com:Org/app.git\n');
    const links = ["https://github.com/org/app/tree/dev", "https://x.com/a/$(touch pwned)"];
    const r = spawnSync(process.execPath, [CLI, "repo-slug"], { cwd: dir, encoding: "utf8", input: JSON.stringify(links) });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.origin, "github.com/org/app");
    assert.deepEqual(out.matches, ["https://github.com/org/app/tree/dev"]);
  });
  it("an unknown command exits 2 with usage", () => {
    const r = spawnSync(process.execPath, [CLI, "nope"], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage/i);
  });
});
