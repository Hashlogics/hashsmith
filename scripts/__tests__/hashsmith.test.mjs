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
  feedbackTarget,
  gitSwitchRule,
  missingEnvKeys,
  repoSlug,
  ticketState,
  treeState,
} from "../hashsmith.mjs";
import * as cli from "../hashsmith.mjs";

const CLI = fileURLToPath(new URL("../hashsmith.mjs", import.meta.url));
// A git repo without running a git write: the minimal .git layout git status accepts.
function fixtureRepo(config = "", dir = mkdtempSync(join(tmpdir(), "hashsmith-repo-"))) {
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

describe("project candidates", () => {
  const P = (n, name, key) => ({ id: U(n), name, key });
  it("probes are the folder name and the origin's repo name, normalised and deduplicated", () => {
    assert.deepEqual(cli.repoProbes("Acme_Web", "git@github.com:Org/acme-web.git"), ["acmeweb"]);
    assert.deepEqual(cli.repoProbes("checkout", "https://gitlab.com/org/sub/Billing.git"), ["checkout", "billing"]);
    assert.deepEqual(cli.repoProbes("app", null), ["app"]);
    assert.deepEqual(cli.repoProbes("", "nope"), ["nope"]);
    assert.deepEqual(cli.repoProbes("x", "github-work:Org/Acme-Web.git"), ["x", "acmeweb"]); // SSH host alias
    assert.deepEqual(cli.repoProbes("", null), []);
  });
  it("ranks exact name or key matches first, ignoring case, -, _, spaces and dots", () => {
    const projects = [P(1, "Acme Portal", "ACP"), P(2, "acme.web", "AW"), P(3, "Billing", "ACMEWEB"), P(4, "Other", "OTH")];
    assert.deepEqual(
      cli.projectCandidates(projects, ["acmeweb"]).map(c => [c.name, c.match]),
      [["acme.web", "exact"], ["Billing", "exact"]],
    );
  });
  it("adds partial matches after the exact ones, closest first, only when the shorter side has 4+ characters", () => {
    const projects = [P(1, "Acme", "ACM"), P(2, "Acme Web Admin", "AWA"), P(3, "Acme Web", "AW"), P(4, "App", "APP")];
    assert.deepEqual(
      cli.projectCandidates(projects, ["acmeweb"]).map(c => [c.name, c.match]),
      [["Acme Web", "exact"], ["Acme", "partial"], ["Acme Web Admin", "partial"]],
    );
    assert.deepEqual(cli.projectCandidates(projects, ["app"]).map(c => c.name), ["App"]); // "app" is in no other name, and too short for partial
    assert.deepEqual(cli.projectCandidates([P(1, "Ops", "OPS"), P(2, "Hashops", "HOPS")], ["hashops"]).map(c => c.name), ["Hashops"]);
  });
  it("returns at most five, and skips rows without an id or a name", () => {
    const many = Array.from({ length: 8 }, (_, i) => P(i + 1, `Acme ${i}`, `A${i}`));
    assert.equal(cli.projectCandidates(many, ["acme"]).length, 5);
    assert.deepEqual(cli.projectCandidates([{ name: "Acme" }, { id: U(1) }, null, "Acme"], ["acme"]), []);
    assert.deepEqual(cli.projectCandidates("not an array", ["acme"]), []);
    assert.deepEqual(cli.projectCandidates([P(1, "Acme", "ACM")], []), []);
  });
  it("keeps id, name and key as given; a missing or non-string key matches nothing", () => {
    assert.deepEqual(cli.projectCandidates([P(7, "Acme Web", "AW")], ["acmeweb"]), [{ id: U(7), name: "Acme Web", key: "AW", match: "exact" }]);
    assert.deepEqual(cli.projectCandidates([{ id: U(8), name: "Acme Web" }], ["acmeweb"]), [{ id: U(8), name: "Acme Web", key: null, match: "exact" }]);
    assert.deepEqual(cli.projectCandidates([P(9, "Other", null), P(10, "Else", 5)], ["5", "other"]).map(c => c.name), ["Other"]);
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

describe("work on the base branch", () => {
  // `git log --format=%h%x1f%s%x1f%b%x1e`: sha, subject, body; records end in \x1e.
  // `git log --format=%h%x1f%cI%x1f%s%x1f%b%x1e`: sha, date, subject, body; records end in \x1e.
  const log = [
    ["a1b2c3d", "2026-10-29T12:00:00+05:00", "feat: brief before planning (HSM-1)", ""],
    ["b2c3d4e", "2026-10-29T11:00:00+05:00", "fix: something else", "Refs HSM-12"],
    ["c3d4e5f", "2026-10-29T10:00:00+05:00", "docs: tidy", "Closes hsm-1."],
    ["d4e5f6a", "2026-10-29T09:00:00+05:00", "chore: XHSM-1 lookalike", ""],
  ]
    .map(r => r.join("\x1f"))
    .join("\x1e\n");
  it("finds the key in subject or body, never as a prefix of a longer number or inside a word", () => {
    assert.deepEqual(cli.commitsForKey(log, "HSM-1"), [
      { sha: "a1b2c3d", at: "2026-10-29T12:00:00+05:00" },
      { sha: "c3d4e5f", at: "2026-10-29T10:00:00+05:00" },
    ]);
    assert.deepEqual(cli.commitsForKey(log, "HSM-12"), [{ sha: "b2c3d4e", at: "2026-10-29T11:00:00+05:00" }]);
    assert.deepEqual(cli.commitsForKey(log, "HSM-2"), []);
    assert.deepEqual(cli.commitsForKey("", "HSM-1"), []);
  });
  it("keeps the key's edges exact: prefixes like ai/ or X- are fine, a longer number never", () => {
    const l = [["1111111", "d", "merge ai/HSM-1-brief", ""], ["2222222", "d", "X-HSM-1 note", ""], ["3333333", "d", "HSM-1a draft", ""], ["4444444", "d", "HSM-10", ""]]
      .map(r => r.join("\x1f"))
      .join("\x1e\n");
    assert.deepEqual(cli.commitsForKey(l, "HSM-1").map(c => c.sha), ["1111111", "2222222", "3333333"]);
  });
  it("never returns message text as a sha, even when a message carries the separators", () => {
    const evil = `aaaaaaa\x1fd\x1ffeat (HSM-1)\x1fbody\x1e\nnot-a-sha; rm -rf /\x1fd\x1fHSM-1\x1f\x1e\n`;
    assert.deepEqual(cli.commitsForKey(evil, "HSM-1").map(c => c.sha), ["aaaaaaa"]);
  });
  it("refuses a key that is not KEY-n, so an empty key cannot match every commit", () => {
    assert.deepEqual(cli.commitsForKey(log, ""), []);
    assert.deepEqual(cli.commitsForKey(log, "HSM"), []);
    assert.deepEqual(cli.commitsForKey(log, ".*"), []);
  });
  it("maps commits to a state: pushed beats local, nothing stays no-branch", () => {
    const c = (sha, at) => ({ sha, at });
    assert.deepEqual(cli.baseStateFor("main", [c("a1b2c3d", "2026-10-29T10:00:00+05:00")], [c("a1b2c3d", "2026-10-29T10:00:00+05:00")]), {
      branch: null,
      pr: null,
      state: "base-pushed",
      ambiguous: false,
      base: { branch: "main", pushed: "a1b2c3d", pushed_at: "2026-10-29T10:00:00+05:00", local: "a1b2c3d", local_at: "2026-10-29T10:00:00+05:00" },
    });
    assert.equal(cli.baseStateFor("main", [], [c("e5f6a7b", "x")]).state, "base-local");
    assert.deepEqual(cli.baseStateFor("main", [], []).base, { branch: "main", pushed: null, pushed_at: null, local: null, local_at: null });
    assert.equal(cli.baseStateFor("main", [], []).state, "no-branch");
  });
  it("says when no base branch was searched", () => {
    assert.deepEqual(cli.baseStateFor(null, [], []), { branch: null, pr: null, state: "no-branch", ambiguous: false, base: null });
  });
});

describe("feedbackTarget", () => {
  const board = { _comment: "x", project_id: U(1), board_id: U(2), project_key: "hsm", list_id: U(3), tags: ["feedback"], duplicate_tag: "duplicate" };
  it("returns the board, list, tags and plugin version, without the comment", () => {
    assert.deepEqual(feedbackTarget(board, { version: "0.5.0" }), {
      ok: true,
      version: "0.5.0",
      project_id: U(1),
      board_id: U(2),
      project_key: "HSM",
      list_id: U(3),
      tags: ["feedback"],
      duplicate_tag: "duplicate",
    });
  });
  it("names every missing or malformed field", () => {
    const r = feedbackTarget({ ...board, board_id: "", list_id: "nope", tags: [] }, {});
    assert.equal(r.ok, false);
    for (const f of ["board_id", "list_id", "tags", "version"]) assert.ok(r.errors.some(e => e.includes(f)), f);
  });
  it("rejects a missing file", () => assert.equal(feedbackTarget(null, { version: "1.0.0" }).ok, false));
});

describe("CLI", () => {
  it("feedback-target reads the plugin's own board file and version", () => {
    const r = spawnSync(process.execPath, [CLI, "feedback-target"], { cwd: tmpdir(), encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true, r.stdout);
    assert.match(out.version, /^\d+\.\d+\.\d+$/);
  });
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
  it("project-candidates reads the projects on stdin and probes the folder and origin names", () => {
    const parent = mkdtempSync(join(tmpdir(), "hashsmith-cand-"));
    const dir = fixtureRepo('[remote "origin"]\n\turl = git@github.com:Org/acme-billing.git\n', join(parent, "acme-web"));
    const projects = [
      { id: U(1), name: "Acme Web", key: "AW" },
      { id: U(2), name: "Acme Billing", key: "AB" },
      { id: U(3), name: "$(touch pwned) Acme", key: "X" },
    ];
    const r = spawnSync(process.execPath, [CLI, "project-candidates"], { cwd: dir, encoding: "utf8", input: JSON.stringify(projects) });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.probes, ["acmeweb", "acmebilling"]);
    assert.deepEqual(out.candidates.map(c => c.key), ["AW", "AB"]);
    mkdirSync(join(dir, "sub"));
    const fromSub = spawnSync(process.execPath, [CLI, "project-candidates"], { cwd: join(dir, "sub"), encoding: "utf8", input: "[]" });
    assert.deepEqual(JSON.parse(fromSub.stdout).probes, ["acmeweb", "acmebilling"], "probes the repo's top folder, not the cwd");
    for (const bad of ["not json", '{"data": []}']) {
      const r2 = spawnSync(process.execPath, [CLI, "project-candidates"], { cwd: dir, encoding: "utf8", input: bad });
      assert.equal(r2.status, 2, bad);
      assert.match(JSON.parse(r2.stdout).error, /JSON array/);
    }
  });
  it("ticket-state reports a key with no branch and no commits as no-branch, with the base it searched", () => {
    const dir = fixtureRepo();
    writeFileSync(join(dir, "hashsmith.json"), JSON.stringify({ repo: { base_branch: "main" } }));
    const r = spawnSync(process.execPath, [CLI, "ticket-state", "ACME-1"], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(JSON.parse(r.stdout)["ACME-1"], {
      branch: null, pr: null, state: "no-branch", ambiguous: false, base: { branch: "main", pushed: null, pushed_at: null, local: null, local_at: null },
    });
  });
  it("an unknown command exits 2 with usage", () => {
    const r = spawnSync(process.execPath, [CLI, "nope"], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage/i);
  });
});
