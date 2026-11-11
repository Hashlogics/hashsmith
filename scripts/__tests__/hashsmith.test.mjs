import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
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

describe("repo match", () => {
  it("is null when the ticket names no repository, so an untagged ticket is anyone's", () => {
    assert.deepEqual(cli.repoMatch(["feedback", "ai"], ["acmeweb"]), { repos: [], match: null, others: [] });
    assert.equal(cli.repoMatch(undefined, ["acmeweb"]).match, null);
  });
  it("matches repo:<name> tags against this repo's probes, ignoring case and punctuation", () => {
    assert.deepEqual(cli.repoMatch(["repo:Acme-Web", "ui"], ["acmeweb"]), { repos: ["Acme-Web"], match: true, others: [] });
    assert.deepEqual(cli.repoMatch(["REPO: acme_api"], ["acmeweb"]), { repos: ["acme_api"], match: false, others: ["acme_api"] });
  });
  it("names the other repositories of a ticket that spans several", () => {
    assert.deepEqual(cli.repoMatch(["repo:acme-web", "repo:acme-api"], ["acmeweb", "web"]), { repos: ["acme-web", "acme-api"], match: true, others: ["acme-api"] });
  });
  it("ignores tags that only look like one, and non-strings", () => {
    assert.deepEqual(cli.repoMatch(["repo:", "repository:x", "my-repo:x", 7, null], ["x"]), { repos: [], match: null, others: [] });
  });
  it("takes the tags array, or get_task's result around it", () => {
    assert.deepEqual(cli.tagsFrom({ result: { tags: ["repo:x"] } }), ["repo:x"]);
    assert.deepEqual(cli.tagsFrom({ tags: ["repo:x"] }), ["repo:x"]);
    assert.deepEqual(cli.tagsFrom(["repo:x"]), ["repo:x"]);
    assert.equal(cli.tagsFrom({ result: {} }), null);
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

describe("lists before To Do", () => {
  const L = (n, name, type = "active") => ({ id: U(n), name, type });
  const mapped = { todo: U(3), in_progress: U(4), review: U(6), qa: U(7), done: U(8) };
  const board = [L(1, "Icebox"), L(2, "Backlog"), L(3, "To Do"), L(4, "In Progress"), L(5, "Blocked"), L(6, "Review"), L(7, "QA"), L(8, "Done", "closed")];
  it("returns the active lists that come before To Do, in board order, whatever their names", () => {
    assert.deepEqual(cli.listsBeforeTodo(board, mapped), { lists: [{ id: U(1), name: "Icebox" }, { id: U(2), name: "Backlog" }] });
    const renamed = [L(1, "Ideas"), L(2, "Parking lot"), L(3, "Ready")];
    assert.deepEqual(cli.listsBeforeTodo(renamed, mapped).lists.map(l => l.name), ["Ideas", "Parking lot"]);
  });
  it("leaves out lists after To Do, done and closed lists, and lists hashsmith.json maps", () => {
    const odd = [L(1, "Archive", "closed"), L(9, "Shipped", "done"), L(7, "QA"), L(2, "Backlog", null), L(3, "To Do"), L(5, "Blocked")];
    assert.deepEqual(cli.listsBeforeTodo(odd, mapped).lists.map(l => l.name), ["Backlog"], "a list without a type counts as active");
    assert.deepEqual(cli.listsBeforeTodo([L(3, "To Do"), L(2, "Backlog")], mapped), { lists: [] });
  });
  it("errors when To Do is not on the board, or the input has the wrong shape", () => {
    assert.match(cli.listsBeforeTodo([L(1, "Backlog"), L(2, "Todo")], mapped).error, /To Do list .* not on this board/);
    assert.match(cli.listsBeforeTodo(board, {}).error, /hashops\.lists\.todo/);
    assert.match(cli.listsBeforeTodo(board, null).error, /hashops\.lists\.todo/);
    assert.match(cli.listsBeforeTodo("not an array", mapped).error, /lists/);
  });
  it("skips rows without an id or a name, and keeps names as given", () => {
    const rows = [null, { name: "No id" }, { id: U(9) }, "Backlog", L(1, "$(touch pwned)"), L(3, "To Do")];
    assert.deepEqual(cli.listsBeforeTodo(rows, mapped), { lists: [{ id: U(1), name: "$(touch pwned)" }] });
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
    changelog: { mode: "write", path: "CHANGELOG.md" },
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
      c => (c.changelog.mode = "auto"),
      c => (c.changelog.path = "docs/CHANGELOG.md"),
      c => (c.changelog.path = ".."),
      c => delete c.changelog.path,
      c => (c.changelog.path = "package.json"),
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
  it("accepts qa.mode browser, code, \"\" or absent, and nothing else", () => {
    for (const mode of ["browser", "code", "", undefined]) {
      const c = valid();
      if (mode !== undefined) c.qa.mode = mode;
      assert.deepEqual(checkConfig(c), [], String(mode));
    }
    for (const mode of ["Code", "api", 1, null]) {
      const c = valid();
      c.qa.mode = mode;
      assert.equal(checkConfig(c).length, 1, String(mode));
    }
  });
  it("accepts repo.branch_policy managed, current, confirm, \"\" or absent, and nothing else", () => {
    for (const policy of ["managed", "current", "confirm", "", undefined]) {
      const c = valid();
      if (policy !== undefined) c.repo.branch_policy = policy;
      assert.deepEqual(checkConfig(c), [], String(policy));
    }
    for (const policy of ["Current", "manual", 1, null]) {
      const c = valid();
      c.repo.branch_policy = policy;
      assert.deepEqual(checkConfig(c), ['repo.branch_policy must be "managed", "current", "confirm" or "" (managed).'], String(policy));
    }
  });
  it("reports a bad qa.base_url and a bad qa.mode together", () => {
    const c = valid();
    c.qa = { base_url: "https://staging.acme.com", mode: "api" };
    assert.equal(checkConfig(c).length, 2);
  });
  it("accepts code mode with an empty base_url", () => {
    const c = valid();
    c.qa = { base_url: "", mode: "code" };
    assert.deepEqual(checkConfig(c), []);
  });
  it("accepts any key HashOps can generate, including a leading digit", () => {
    const c = valid();
    c.hashops.project_key = "3DS";
    assert.deepEqual(checkConfig(c), []);
  });
  it("rejects a non-object", () => assert.ok(checkConfig(null).length > 0));
  it("accepts every changelog mode, and no changelog key at all", () => {
    for (const mode of ["write", "commits", "off"]) {
      const c = valid();
      c.changelog.mode = mode;
      assert.deepEqual(checkConfig(c), [], mode);
    }
    const c = valid();
    delete c.changelog;
    assert.deepEqual(checkConfig(c), []);
  });
});

describe("workspace config", () => {
  const hashops = () => ({
    project_id: U(1),
    project_key: "ACME",
    board_id: U(2),
    lists: { todo: U(3), in_progress: U(4), review: U(5), qa: U(6), done: U(7) },
    ai_tag: "hashsmith",
  });
  const workspace = () => ({ version: 1, hashops: hashops(), repositories: { "acme-api": { path: "acme-api" }, web: { path: "apps/web" } } });
  const child = () => ({ version: 1, hashops: hashops(), repo: { base_branch: "dev" }, qa: { base_url: "", mode: "code" } });
  const children = () => ({ "acme-api": { inside: true, git: true, config: child() }, web: { inside: true, git: true, config: child() } });

  it("accepts a workspace file: the shared hashops block and the repositories map", () => {
    assert.deepEqual(checkConfig(workspace()), []);
    const c = workspace();
    c.intake = { processed_meetings: [] };
    c.learned = { qa_note: { value: 1, why: "w", source: "s", added: "2026-11-11" } };
    assert.deepEqual(checkConfig(c), []);
  });
  it("rejects repository settings in the workspace file: they live in each repository's own file", () => {
    for (const key of ["repo", "qa", "sonar", "sentry", "changelog"]) {
      const c = workspace();
      c[key] = {};
      assert.deepEqual(checkConfig(c), [`${key} belongs in each repository's own hashsmith.json, not the workspace file.`], key);
    }
  });
  it("rejects each malformed repositories entry with exactly one error", () => {
    for (const mutate of [
      c => (c.repositories = {}),
      c => (c.repositories = []),
      c => (c.repositories["-x"] = { path: "x" }),
      c => (c.repositories["a b"] = { path: "x" }),
      c => (c.repositories.x = "x"),
      c => (c.repositories.x = { path: "x", base_branch: "dev" }),
      c => (c.repositories.x = { path: "" }),
      c => (c.repositories.x = { path: "/abs/x" }),
      c => (c.repositories.x = { path: "../x" }),
      c => (c.repositories.x = { path: "a/../x" }),
      c => (c.repositories.x = { path: "." }),
      c => (c.repositories.x = { path: "x/" }),
      c => (c.repositories.x = { path: "a\\x" }),
      c => (c.repositories.x = { path: "apps/web" }),
    ]) {
      const c = workspace();
      mutate(c);
      assert.equal(checkConfig(c).length, 1, `${String(mutate)} → ${JSON.stringify(checkConfig(c))}`);
    }
  });
  it("passes when every repository is inside, a Git repository, and agrees on hashops", () => {
    assert.deepEqual(cli.checkWorkspace(workspace(), children()), []);
  });
  it("names a path that leaves the workspace, a folder that is no Git repository, and a missing or broken config", () => {
    const ch = children();
    ch["acme-api"] = { inside: false, git: true, config: child() };
    ch.web = { inside: true, git: false, config: null };
    assert.deepEqual(cli.checkWorkspace(workspace(), ch), [
      "repositories.acme-api.path must stay inside the workspace (symlinks followed).",
      "repositories.web: apps/web is not a Git repository.",
    ]);
    const missing = children();
    missing.web.config = null;
    assert.deepEqual(cli.checkWorkspace(workspace(), missing), ["apps/web/hashsmith.json not found: onboard that repository first."]);
    const invalid = children();
    invalid.web.config = { __invalid: true };
    assert.deepEqual(cli.checkWorkspace(workspace(), invalid), ["apps/web/hashsmith.json is not valid JSON."]);
  });
  it("passes on a repository's own config errors, prefixed with its path", () => {
    const ch = children();
    ch.web.config.repo.branch_policy = "manual";
    assert.deepEqual(cli.checkWorkspace(workspace(), ch), ['apps/web/hashsmith.json: repo.branch_policy must be "managed", "current", "confirm" or "" (managed).']);
  });
  it("fails when a repository's hashops block disagrees with the workspace's, one line per field", () => {
    const ch = children();
    ch.web.config.hashops.board_id = U(9);
    ch.web.config.hashops.lists.qa = "";
    ch["acme-api"].config.hashops.ai_tag = "ai";
    assert.deepEqual(cli.checkWorkspace(workspace(), ch), [
      "acme-api/hashsmith.json: hashops.ai_tag differs from the workspace's.",
      "apps/web/hashsmith.json: hashops.board_id differs from the workspace's.",
      "apps/web/hashsmith.json: hashops.lists.qa differs from the workspace's.",
    ]);
  });
  it("rejects two names for one repository (a symlink, or another spelling on a case-insensitive disk)", () => {
    const ch = children();
    ch["acme-api"].dir = "/ws/acme-api";
    ch.web.dir = "/ws/acme-api";
    assert.deepEqual(cli.checkWorkspace(workspace(), ch), ["repositories.web.path is the same repository as acme-api's."]);
  });
  it("rejects a repository whose own file is a workspace: workspaces do not nest", () => {
    const ch = children();
    ch.web.config = workspace();
    assert.deepEqual(cli.checkWorkspace(workspace(), ch), ["apps/web/hashsmith.json is a workspace file; workspaces do not nest."]);
  });
});

describe("workspace routing", () => {
  const probes = { "acme-api": ["acmeapi", "backend"], web: ["web", "acmeweb"] };
  it("maps a ticket's repo: tags to the repositories they name, ignoring case and punctuation", () => {
    assert.deepEqual(cli.workspaceRoute(["ui", "repo:Acme_API"], probes), { repos: ["Acme_API"], repositories: ["acme-api"], unknown: [], ambiguous: [] });
    assert.deepEqual(cli.workspaceRoute(["repo:acme-web", "repo:backend"], probes), { repos: ["acme-web", "backend"], repositories: ["acme-api", "web"], unknown: [], ambiguous: [] });
  });
  it("lists tags that name no repository, and gives none for an untagged ticket", () => {
    assert.deepEqual(cli.workspaceRoute(["repo:mobile", "repo:web"], probes), { repos: ["mobile", "web"], repositories: ["web"], unknown: ["mobile"], ambiguous: [] });
    assert.deepEqual(cli.workspaceRoute(["feedback"], probes), { repos: [], repositories: [], unknown: [], ambiguous: [] });
  });
  it("flags a tag that names several repositories (one's key is another's folder or origin name)", () => {
    const overlap = { api: ["api", "acmeapi"], "acme-api": ["acmeapi", "legacy"] };
    assert.deepEqual(cli.workspaceRoute(["repo:acme-api"], overlap), { repos: ["acme-api"], repositories: ["api", "acme-api"], unknown: [], ambiguous: ["acme-api"] });
  });
  it("reads --repo <name> anywhere in the arguments, once", () => {
    assert.deepEqual(cli.parseRepoFlag(["ACME-1", "--repo", "web", "ACME-2"]), { repo: "web", args: ["ACME-1", "ACME-2"] });
    assert.deepEqual(cli.parseRepoFlag(["ACME-1"]), { repo: null, args: ["ACME-1"] });
    assert.match(cli.parseRepoFlag(["--repo"]).error, /--repo needs/);
    assert.match(cli.parseRepoFlag(["--repo", "--x"]).error, /--repo needs/);
    assert.match(cli.parseRepoFlag(["--repo", "a", "--repo", "b"]).error, /once/);
  });
});

describe("changelog mode", () => {
  const detect = (names, packageJson = null, workflows = []) => cli.changelogDetect({ names, packageJson, workflows });
  it("finds a changelog file at the root in any case, CHANGELOG before CHANGES before HISTORY", () => {
    assert.deepEqual(detect(["src", "changelog.md"]), { generator: null, file: "changelog.md" });
    assert.deepEqual(detect(["HISTORY.md", "Changes.md"]), { generator: null, file: "Changes.md" });
    assert.deepEqual(detect(["src", "README.md", "CHANGELOG.txt"]), { generator: null, file: null });
  });
  it("finds a generator from its root files", () => {
    for (const [name, generator] of [
      ["release-please-config.json", "release-please"],
      [".release-please-manifest.json", "release-please"],
      [".changeset", "changesets"],
      [".releaserc.yml", "semantic-release"],
      ["release.config.cjs", "semantic-release"],
      [".versionrc.json", "standard-version"],
      ["cliff.toml", "git-cliff"],
      [".auto-changelog", "auto-changelog"],
    ])
      assert.equal(detect(["CHANGELOG.md", name]).generator, generator, name);
  });
  it("finds a generator in package.json dependencies, scripts or its release key", () => {
    assert.equal(detect([], { devDependencies: { "@changesets/cli": "2" } }).generator, "changesets");
    assert.equal(detect([], { scripts: { release: "commit-and-tag-version" } }).generator, "commit-and-tag-version");
    assert.equal(detect([], { release: { branches: ["main"] } }).generator, "semantic-release");
    assert.equal(detect([], { release: "2026.11" }).generator, null, "a release key that is not a config object is not semantic-release");
    assert.equal(detect([], { devDependencies: { "conventional-changelog-conventionalcommits": "8" } }).generator, null, "a commitlint preset is not the tool");
    assert.equal(detect([], { devDependencies: { "conventional-changelog-cli": "5" } }).generator, "conventional-changelog");
    assert.equal(detect([], { scripts: { changelog: "conventional-changelog -p angular -i CHANGELOG.md -s" } }).generator, "conventional-changelog");
    assert.equal(detect([], { scripts: { build: "vite build" }, dependencies: { react: "18" } }).generator, null);
    assert.equal(detect([], { __invalid: true }).generator, null);
    assert.equal(detect([".release-it.json"], { "release-it": { git: {} } }).generator, null, "release-it alone writes no changelog");
    assert.equal(detect([], { devDependencies: { "@release-it/conventional-changelog": "8" } }).generator, "conventional-changelog");
    assert.equal(detect([".versionrc"], { devDependencies: { "commit-and-tag-version": "12" } }).generator, "commit-and-tag-version", "package.json names the tool more exactly than .versionrc");
  });
  it("finds a generator in a workflow, and not in a workflow that only bumps the version", () => {
    assert.equal(detect([], null, ["steps:\n  - uses: googleapis/release-please-action@v4\n"]).generator, "release-please");
    assert.equal(detect([], null, ["steps:\n  - uses: TriPSs/conventional-changelog-action@v5\n"]).generator, "conventional-changelog");
    assert.equal(detect([], null, ["run: npm version patch --no-git-tag-version\n# once per release, items\n"]).generator, null);
  });

  const found = { generator: null, file: "CHANGES.md" };
  const generated = { generator: "release-please", file: "CHANGELOG.md" };
  const none = { generator: null, file: null };
  it("with nothing stored: a generator gives commits, a file gives write, neither asks", () => {
    assert.deepEqual(cli.changelogDecision(null, generated), { mode: "commits", path: "CHANGELOG.md", generator: "release-please", ask: false, changed: true });
    assert.deepEqual(cli.changelogDecision(null, found), { mode: "write", path: "CHANGES.md", generator: null, ask: false, changed: true });
    assert.deepEqual(cli.changelogDecision(null, none), { mode: null, path: "CHANGELOG.md", generator: null, ask: true, changed: false });
  });
  it("a stored value stands, except write meeting a generator, which turns stale", () => {
    const off = { mode: "off", path: "CHANGELOG.md" };
    assert.deepEqual(cli.changelogDecision(off, generated), { mode: "off", path: "CHANGELOG.md", generator: null, ask: false, changed: false });
    const write = { mode: "write", path: "CHANGELOG.md" };
    assert.deepEqual(cli.changelogDecision(write, none), { mode: "write", path: "CHANGELOG.md", generator: null, ask: false, changed: false });
    assert.deepEqual(cli.changelogDecision(write, generated), { mode: "commits", path: "CHANGELOG.md", generator: "release-please", ask: false, changed: true });
    const commits = { mode: "commits", path: "CHANGELOG.md" };
    assert.deepEqual(cli.changelogDecision(commits, none), { mode: "commits", path: "CHANGELOG.md", generator: null, ask: false, changed: false });
  });
});

describe("changelog check", () => {
  const patch = (path, body, header = "") => `diff --git a/${path} b/${path}\n${header}--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,4 @@\n${body}`;
  const code = patch("src/a.ts", "+export const a = 1;\n-export const a = 0;\n");
  const check = (type, p) => cli.changelogCheck(type, p, "CHANGELOG.md");
  it("calls a heading a release heading only for a version, a date, or the words version or release", () => {
    const heading = h => check("feat", code + patch("CHANGELOG.md", `+${h}\n+- You can now export a report.\n`)).problems.some(p => /release heading/.test(p));
    assert.equal(heading("### 2FA fixes"), false);
    assert.equal(heading("### Added"), false);
    for (const h of ["## 1.2.0", "## [1.2.0] - 2026-11-05", "## v2.0", "## 2026-11-05", "## Release candidate", "## Version 3"]) assert.equal(heading(h), true, h);
    for (const h of ["## 5 November 2026", "## Nov 2026", "## November 5, 2026", "## Sept. 2026"]) assert.equal(heading(h), true, `a written date: ${h}`);
    for (const h of ["### March fixes", "### May the exports work", "### Separate 2048-bit keys", "### Marketing 2026 campaign", "### Decimal 1000 support"])
      assert.equal(heading(h), false, `not a written date: ${h}`);
  });
  it("with the project key known, flags only that key, so product names like USB-3 pass", () => {
    const line = l => code + patch("CHANGELOG.md", ` ## Unreleased\n+- ${l}\n`);
    const keyed = (l, key) => cli.changelogCheck("feat", line(l), "CHANGELOG.md", { key }).problems.some(p => /ticket key/.test(p));
    assert.equal(keyed("Charging over USB-3 works again.", "ACME"), false);
    assert.equal(keyed("Faster exports (ACME-12).", "ACME"), true);
    assert.equal(keyed("Faster exports (acme-12).", "ACME"), true);
    assert.equal(keyed("Charging over USB-3 works again.", null), true, "without a key, any KEY-n still counts");
  });
  it("with the file on disk, reports an added entry outside ## Unreleased", () => {
    const file = "# Changelog\n\n## Unreleased\n\n### Added\n- You can now export a report.\n\n## 1.0.0\n\n### Added\n- Reports open faster.\n";
    const at = l => cli.changelogCheck("feat", code + patch("CHANGELOG.md", `+${l}\n`), "CHANGELOG.md", { fileText: file }).problems.some(p => /outside the Unreleased section/.test(p));
    assert.equal(at("- You can now export a report."), false);
    assert.equal(at("- Reports open faster."), true);
    const noSection = cli.changelogCheck("feat", code + patch("CHANGELOG.md", "+- Reports open faster.\n"), "CHANGELOG.md", { fileText: "# Changelog\n\n- Reports open faster.\n" });
    assert.ok(noSection.problems.some(p => /outside the Unreleased section/.test(p)), "no Unreleased section at all");
    assert.equal(cli.changelogCheck("feat", code + patch("CHANGELOG.md", "+- Reports open faster.\n"), "CHANGELOG.md", {}).problems.length, 0, "no file text: no placement check");
  });
  it("places an added line by its hunk line number, so the same text under a release is caught", () => {
    const file = "# Changelog\n\n## Unreleased\n\n- Fixed a crash.\n\n## 1.0.0\n\n- Fixed a crash.\n";
    const hunk = (n, body) => `diff --git a/CHANGELOG.md b/CHANGELOG.md\n--- a/CHANGELOG.md\n+++ b/CHANGELOG.md\n@@ -${n},2 +${n},3 @@\n${body}`;
    const outside = p => cli.changelogCheck("fix", code + p, "CHANGELOG.md", { fileText: file }).problems.some(x => /outside the Unreleased section/.test(x));
    assert.equal(outside(hunk(7, " ## 1.0.0\n \n+- Fixed a crash.\n")), true, "line 9 is under 1.0.0");
    assert.equal(outside(hunk(3, " ## Unreleased\n \n+- Fixed a crash.\n")), false, "line 5 is under Unreleased");
  });
  it("finds Unreleased at heading levels # to ###, ending at the next heading of its level", () => {
    for (const h of ["#", "##", "###"]) {
      const file = `# Changelog\n\n${h} Unreleased\n\n#### Added\n- Faster exports.\n\n${h} 1.0.0\n- Old.\n`;
      const at = l => cli.changelogCheck("feat", code + patch("CHANGELOG.md", `+${l}\n`), "CHANGELOG.md", { fileText: file }).problems.some(p => /outside the Unreleased section/.test(p));
      assert.equal(at("- Faster exports."), false, h);
      assert.equal(at("- Old."), true, h);
    }
  });
  it("maps the commit type to a heading; only feat, fix and perf need an entry", () => {
    assert.deepEqual([check("feat", code).heading, check("fix", code).heading, check("perf", code).heading], ["Added", "Fixed", "Improved"]);
    for (const type of ["chore", "refactor", "test", "docs", "build", "ci", "style", "revert"]) {
      const r = check(type, code);
      assert.equal(r.needs_entry, false, type);
      assert.equal(r.missing_entry, false, type);
    }
  });
  it("reports a missing entry when a user-visible change leaves the changelog untouched", () => {
    assert.deepEqual(check("feat", code), { needs_entry: true, heading: "Added", missing_entry: true, problems: [] });
    const withEntry = code + patch("CHANGELOG.md", " ## Unreleased\n+### Added\n+- You can now see your leave balance on the dashboard.\n");
    assert.deepEqual(check("feat", withEntry), { needs_entry: true, heading: "Added", missing_entry: false, problems: [] });
  });
  it("counts only an added entry line: not a blank, a heading or a link reference", () => {
    assert.equal(check("feat", code + patch("CHANGELOG.md", "+\n")).missing_entry, true);
    assert.equal(check("feat", code + patch("CHANGELOG.md", "+## Unreleased\n+### Added\n")).missing_entry, true);
    assert.equal(check("feat", code + patch("CHANGELOG.md", "+[Unreleased]: https://github.com/acme/app/compare/v1.0.0...HEAD\n")).missing_entry, true);
    assert.equal(check("feat", code + patch("CHANGELOG.md", "-- An old line.\n")).missing_entry, true);
  });
  it("reads a new changelog file from a /dev/null diff", () => {
    const created = code + patch("CHANGELOG.md", "+# Changelog\n+\n+## Unreleased\n+\n+### Fixed\n+- Saving a form twice no longer creates two records.\n", "new file mode 100644\n").replace("--- a/CHANGELOG.md", "--- /dev/null");
    assert.deepEqual(check("fix", created).problems, []);
    assert.equal(check("fix", created).missing_entry, false);
  });
  it("flags technical text in added lines: ticket keys, file names, code spans", () => {
    const p = patch("CHANGELOG.md", [
      "+- Leave balance card (ACME-12).",
      "+- Fixed a crash in src/pages/Dashboard.tsx.",
      "+- The `useLeaveStore` hook caches results.",
      "+- Read more at https://acme.example.com/help/leave.html.",
      "+- Works with UTF-8 names.",
      "",
    ].join("\n"));
    const problems = check("feat", p).problems;
    assert.equal(problems.length, 3, problems.join("\n"));
    assert.match(problems[0], /ticket key ACME-12/);
    assert.match(problems[1], /file name/);
    assert.match(problems[2], /code/);
  });
  it("flags a removed heading and an added version heading: releases belong to the project", () => {
    const p = patch("CHANGELOG.md", "-## Unreleased\n+## 1.4.0 — 2026-11-03\n ### Added\n");
    const problems = check("feat", p).problems;
    assert.equal(problems.length, 2, problems.join("\n"));
    assert.match(problems.join("\n"), /removes a section heading/);
    assert.match(problems.join("\n"), /release heading/);
  });
  it("ignores other files' lines and hunk headers that look like +/- lines", () => {
    const p = patch("README.md", "+- See ACME-12 in src/a.ts\n") + patch("CHANGELOG.md", " ## Unreleased\n+- Exports now include the team name.\n");
    assert.deepEqual(check("feat", p).problems, []);
  });
  it("refuses an unknown commit type", () => assert.match(check("feature", code).error, /commit type/));
  it("finds the changelog whatever prefixes the patch uses (diff.noprefix, diff.mnemonicPrefix)", () => {
    const entry = "@@ -1 +1,2 @@\n ## Unreleased\n+- Exports now include the team name.\n";
    for (const [from, to] of [["c/", "w/"], ["", ""]]) {
      const p = `diff --git ${from}CHANGELOG.md ${to}CHANGELOG.md\n--- ${from}CHANGELOG.md\n+++ ${to}CHANGELOG.md\n${entry}`;
      assert.equal(check("feat", p).missing_entry, false, from || "no prefix");
    }
    const elsewhere = "diff --git a/docs/CHANGELOG.md b/docs/CHANGELOG.md\n--- a/docs/CHANGELOG.md\n+++ b/docs/CHANGELOG.md\n" + entry;
    assert.equal(check("feat", elsewhere).missing_entry, true, "a changelog in a subfolder is not the root one");
  });
  it("flags any added release heading and a removed link reference", () => {
    for (const heading of ["## Version 2.0", "## 2026-11-03", "## [1.2.0] - 2026-11-03", "# 3.0.0"])
      assert.equal(check("feat", patch("CHANGELOG.md", `+${heading}\n`)).problems.length, 1, heading);
    for (const ok of ["# Changelog", "## Unreleased", "## [Unreleased]", "### Added", "## Added"])
      assert.deepEqual(check("feat", patch("CHANGELOG.md", `+${ok}\n`)).problems, [], ok);
    assert.equal(check("feat", patch("CHANGELOG.md", "-[Unreleased]: https://github.com/acme/app/compare/v1.0.0...HEAD\n")).problems.length, 1);
  });
  it("flags any ticket key, not only this project's, but not standards like UTF-8 or ISO-8601", () => {
    assert.match(check("fix", patch("CHANGELOG.md", "+- Fixed the HOPS-12 crash.\n")).problems.join(), /ticket key HOPS-12/);
    assert.deepEqual(check("fix", patch("CHANGELOG.md", "+- Names in UTF-8 and ISO-8601 dates now import correctly.\n")).problems, []);
  });
  it("flags a changed version field in the root package.json: versions belong to the project", () => {
    const bump = patch("package.json", '-  "version": "1.4.0",\n+  "version": "1.5.0",\n');
    assert.match(check("feat", code + bump).problems.join(), /version field in package.json/);
    assert.deepEqual(check("feat", code + patch("packages/ui/package.json", '+  "version": "2.0.0",\n')).problems, []);
    assert.deepEqual(check("feat", code + patch("package.json", '+    "react": "18.3.1",\n')).problems, []);
  });
  it("does not take product names like GPT-4 for ticket keys", () => {
    assert.deepEqual(check("feat", patch("CHANGELOG.md", "+- Summaries now use GPT-4.\n")).problems, []);
  });
  it("does not take product names like Next.js or Node.js for file names", () => {
    assert.deepEqual(check("feat", patch("CHANGELOG.md", "+- The app now runs on Node.js 22 and Next.js 15.\n")).problems, []);
    assert.equal(check("feat", patch("CHANGELOG.md", "+- Updated next.config.js.\n")).problems.length, 1);
  });
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
  it("flags revert commits, so a revert never counts as delivering the ticket", () => {
    const l = [
      ["6666666", "d", 'Revert "Revert "Revert "feat: balance card (HSM-1)"""', ""],
      ["5555555", "d", 'Revert "Revert "feat: balance card (HSM-1)""', ""],
      ["1111111", "d", 'Revert "feat: balance card (HSM-1)" (#45)', "This reverts commit abc."],
      ["2222222", "d", "revert: balance card (HSM-1)", ""],
      ["7777777", "d", "revert(card)!: balance card (HSM-1)", ""],
      ["9999999", "d", 'Revert "revert: balance card (HSM-1)"', ""],
      ["4444444", "d", "Revert button colours to the brand palette (HSM-1)", ""],
      ["8888888", "d", "Reverts HSM-1 card", ""],
      ["3333333", "d", "fix: follow-up to HSM-1", ""],
    ]
      .map(r => r.join("\x1f"))
      .join("\x1e\n");
    assert.deepEqual(
      cli.commitsForKey(l, "HSM-1").map(c => [c.sha, !!c.revert]),
      [["6666666", true], ["5555555", false], ["1111111", true], ["2222222", true], ["7777777", true], ["9999999", false], ["4444444", false], ["8888888", false], ["3333333", false]],
      'git\'s Revert "…" form (an odd number of them) and a conventional revert: type are reverts; a revert of a revert delivers; a plain word "Revert" in a subject is a change',
    );
  });
  it("lets a revert newer than the ticket's commits cancel them, and a newer commit deliver again", () => {
    const c = (sha, revert) => ({ sha, at: "t", ...(revert ? { revert } : {}) });
    const undone = cli.baseStateFor("main", [c("bbbbbbb", true), c("aaaaaaa")], [c("bbbbbbb", true), c("aaaaaaa")]);
    assert.equal(undone.state, "no-branch");
    assert.equal(undone.base.reverted, "pushed");
    assert.deepEqual(undone.base.pushed_commits, []);
    const again = cli.baseStateFor("main", [c("ccccccc"), c("bbbbbbb", true), c("aaaaaaa")], []);
    assert.equal(again.state, "base-pushed");
    assert.deepEqual(again.base.pushed_commits, ["ccccccc"], "only the commits after the revert deliver");
    assert.equal("reverted" in again.base, false);
    const localRevert = cli.baseStateFor("main", [c("aaaaaaa")], [c("bbbbbbb", true), c("aaaaaaa")]);
    assert.equal(localRevert.state, "base-pushed", "origin still delivers it");
    assert.equal(localRevert.base.reverted, "local", "the revert is only local: sync reports it");
    const redo = cli.baseStateFor("main", [c("bbbbbbb", true), c("aaaaaaa")], [c("ccccccc"), c("bbbbbbb", true), c("aaaaaaa")]);
    assert.deepEqual([redo.state, redo.base.reverted], ["base-local", "pushed"], "reverted on origin, delivered again locally");
    const behind = cli.baseStateFor("main", [c("ccccccc"), c("bbbbbbb", true), c("aaaaaaa")], [c("bbbbbbb", true), c("aaaaaaa")]);
    assert.deepEqual([behind.state, "reverted" in behind.base], ["base-pushed", false], "a local base behind origin is no local revert");
    const stale = cli.baseStateFor("main", [c("bbbbbbb", true), c("aaaaaaa")], [c("aaaaaaa")]);
    assert.deepEqual([stale.state, stale.base.reverted], ["no-branch", "pushed"], "a local base behind a pushed revert: pushed, then reverted, not 'not pushed yet'");
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
      base: { branch: "main", pushed: "a1b2c3d", pushed_at: "2026-10-29T10:00:00+05:00", local: "a1b2c3d", local_at: "2026-10-29T10:00:00+05:00", pushed_commits: ["a1b2c3d"] },
    });
    const two = cli.baseStateFor("main", [c("f00d123", "2026-10-30T10:00:00+05:00"), c("a1b2c3d", "2026-10-29T10:00:00+05:00")], []);
    assert.equal(two.base.pushed, "f00d123", "pushed is still the newest");
    assert.deepEqual(two.base.pushed_commits, ["a1b2c3d", "f00d123"], "every pushed commit, oldest first, for qa's code review");
    assert.equal(cli.baseStateFor("main", [], [c("e5f6a7b", "x")]).state, "base-local");
    assert.deepEqual(cli.baseStateFor("main", [], []).base, { branch: "main", pushed: null, pushed_at: null, local: null, local_at: null, pushed_commits: [] });
    assert.equal(cli.baseStateFor("main", [], []).state, "no-branch");
    const newer = cli.baseStateFor("main", [c("a1b2c3d", "2026-10-29T10:00:00+05:00")], [c("b9b9b9b", "2026-10-30T10:00:00+05:00"), c("a1b2c3d", "2026-10-29T10:00:00+05:00")]);
    assert.equal(newer.state, "base-local", "a newer fix that is only local decides: it is not pushed yet");
    const behind = cli.baseStateFor("main", [c("f00d123", "x"), c("a1b2c3d", "y")], [c("a1b2c3d", "y")]);
    assert.equal(behind.state, "base-pushed", "a local branch that is only behind origin is still delivered");
  });
  it("lets a pushed base-branch commit win over an ai/* branch with no PR only when that branch holds no work of its own", () => {
    const review = { branch: "ai/HSM-1-x", pr: null, state: "review", ambiguous: false, local: true };
    const pushed = cli.baseStateFor("main", [{ sha: "a1b2c3d", at: "2026-11-05T10:00:00+05:00" }], []);
    const empty = { ahead: 0, dirty: false };
    assert.deepEqual(cli.withBase(review, pushed, empty), { ...pushed, stale_branch: "ai/HSM-1-x" }, "nothing on the branch: the work went to the base branch");
    assert.equal(cli.withBase(review, pushed, empty).branch, null);
    assert.deepEqual(cli.withBase(review, pushed, { ahead: 2, dirty: false }), review, "the branch has its own commits: a teammate's mention on the base never replaces it");
    assert.deepEqual(cli.withBase(review, pushed, { ahead: 0, dirty: true }), review, "checked out with uncommitted work (a handoff waiting for its commit): keep it");
    assert.deepEqual(cli.withBase(review, pushed, null), review, "unknown: keep the branch");
    assert.deepEqual(cli.withBase(review, pushed, { ahead: "x", dirty: false }), review);
    const local = cli.baseStateFor("main", [], [{ sha: "a1b2c3d", at: "2026-11-05T10:00:00+05:00" }]);
    assert.deepEqual(cli.withBase(review, local, empty), review, "only a pushed commit counts");
    const qa = { ...review, state: "qa", pr: { number: 4 } };
    assert.deepEqual(cli.withBase(qa, pushed, empty), qa, "an open PR is followed through its PR");
    assert.deepEqual(cli.withBase({ ...review, ambiguous: true }, pushed, empty), { ...review, ambiguous: true }, "several branches: sync asks which is current");
    assert.deepEqual(cli.withBase(review, cli.baseStateFor(null, [], []), empty), review);
  });
  it("finds a ticket's newest saved base- or other-branch patch, never an ai/* branch's", () => {
    const f = (name, mtimeMs) => ({ name, mtimeMs });
    const names = [f("main-HSM-1.patch", 1), f("feature-payments-HSM-1.patch", 3), f("ai-HSM-3-follow-up-HSM-1.patch", 9), f("main-HSM-12.patch", 9), f("main-HSM-1-r2.patch", 9)];
    assert.deepEqual(cli.handoffPatch(names, "HSM-1", "feature/payments"), { file: "feature-payments-HSM-1.patch", branch: "feature-payments", current: true });
    assert.deepEqual(cli.handoffPatch(names, "HSM-1", "main"), { file: "feature-payments-HSM-1.patch", branch: "feature-payments", current: false }, "the newest, whatever branch is checked out");
    assert.equal(cli.handoffPatch(names, "HSM-2", "main"), null);
    assert.equal(cli.handoffPatch([...names, f("ai-search-HSM-1.patch", 5)], "HSM-1", "ai-search").file, "ai-search-HSM-1.patch", "a branch merely starting with ai- is another branch");
    assert.equal(cli.handoffPatch(names, "../x", "main"), null, "a key that is not KEY-n finds nothing");
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
  it("repo-match reads the tags on stdin and probes the repo's top folder and origin names", () => {
    const parent = mkdtempSync(join(tmpdir(), "hashsmith-rm-"));
    const dir = fixtureRepo('[remote "origin"]\n\turl = git@github.com:Org/acme-web.git\n', join(parent, "web"));
    mkdirSync(join(dir, "sub"));
    const task = { result: { code: "ACME-1", tags: ["ui", "repo:acme-web", "repo:$(touch pwned)"] } };
    const r = spawnSync(process.execPath, [CLI, "repo-match"], { cwd: join(dir, "sub"), encoding: "utf8", input: JSON.stringify(task) });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { probes: ["web", "acmeweb"], repos: ["acme-web", "$(touch pwned)"], match: true, others: ["$(touch pwned)"] });
    assert.equal(existsSync(join(dir, "sub", "pwned")), false);
    for (const bad of ["not json", '{"result": {}}']) {
      const r2 = spawnSync(process.execPath, [CLI, "repo-match"], { cwd: dir, encoding: "utf8", input: bad });
      assert.equal(r2.status, 2, bad);
      assert.match(JSON.parse(r2.stdout).error, /ticket's tags/);
    }
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
      branch: null, pr: null, state: "no-branch", ambiguous: false, base: { branch: "main", pushed: null, pushed_at: null, local: null, local_at: null, pushed_commits: [] },
    });
  });
  it("handoff-patch prints the ticket's newest saved patch under ~/.hashsmith for this project", () => {
    const dir = fixtureRepo();
    writeFileSync(join(dir, "hashsmith.json"), JSON.stringify({ hashops: { project_key: "ACME" } }));
    const home = mkdtempSync(join(tmpdir(), "hashsmith-home-"));
    const handoffs = join(home, ".hashsmith", "projects", "ACME", "handoffs");
    mkdirSync(handoffs, { recursive: true });
    writeFileSync(join(handoffs, "dev-ACME-1.patch"), "diff\n");
    const r = spawnSync(process.execPath, [CLI, "handoff-patch", "ACME-1", "ACME-2"], { cwd: dir, encoding: "utf8", env: { ...process.env, HOME: home } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out["ACME-1"].path, join(handoffs, "dev-ACME-1.patch"));
    assert.equal(out["ACME-1"].branch, "dev");
    assert.equal(out["ACME-2"], null);
  });
  it("changelog reads the repo's top level and prints names only, never file text", () => {
    const dir = fixtureRepo();
    mkdirSync(join(dir, ".github/workflows"), { recursive: true });
    writeFileSync(join(dir, ".github/workflows/release.yml"), "# SECRET-WORKFLOW-TEXT\n- uses: changesets/action@v1\n");
    writeFileSync(join(dir, "Changelog.md"), "# SECRET-CHANGELOG-TEXT\n");
    mkdirSync(join(dir, "sub"));
    const r = spawnSync(process.execPath, [CLI, "changelog"], { cwd: join(dir, "sub"), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { mode: "commits", path: "Changelog.md", generator: "changesets", ask: false, changed: true });
    assert.doesNotMatch(r.stdout, /SECRET/);
    writeFileSync(join(dir, "hashsmith.json"), JSON.stringify({ changelog: { mode: "off", path: "CHANGELOG.md" } }));
    const stored = spawnSync(process.execPath, [CLI, "changelog"], { cwd: dir, encoding: "utf8" });
    assert.equal(JSON.parse(stored.stdout).mode, "off");
  });
  it("changelog-check reads the patch on stdin and the mode, path and key from hashsmith.json", () => {
    const dir = fixtureRepo();
    const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n+x\n";
    const run = (args, config) => {
      if (config) writeFileSync(join(dir, "hashsmith.json"), JSON.stringify(config));
      return spawnSync(process.execPath, [CLI, "changelog-check", ...args], { cwd: dir, encoding: "utf8", input: patch });
    };
    const hashops = { project_key: "ACME" };
    const write = run(["feat"], { hashops, changelog: { mode: "write", path: "CHANGELOG.md" } });
    assert.equal(write.status, 0, write.stderr);
    assert.deepEqual(JSON.parse(write.stdout), { mode: "write", path: "CHANGELOG.md", needs_entry: true, heading: "Added", missing_entry: true, problems: [] });
    const commits = run(["feat"], { hashops, changelog: { mode: "commits", path: "CHANGELOG.md" } });
    assert.deepEqual(JSON.parse(commits.stdout), { mode: "commits", path: "CHANGELOG.md", needs_entry: false });
    const missing = run(["feat"], { hashops });
    assert.equal(missing.status, 2);
    assert.match(JSON.parse(missing.stdout).error, /changelog/);
    const badType = run(["feature"], { hashops, changelog: { mode: "write", path: "CHANGELOG.md" } });
    assert.equal(badType.status, 2);
  });
  it("lists-before-todo reads get_board's lists on stdin and the To Do id from hashsmith.json at the repo top", () => {
    const dir = fixtureRepo();
    writeFileSync(join(dir, "hashsmith.json"), JSON.stringify({ hashops: { lists: { todo: U(2), done: U(3) } } }));
    mkdirSync(join(dir, "sub"));
    const lists = [{ id: U(1), name: "Backlog", type: "active" }, { id: U(2), name: "To Do", type: "active" }, { id: U(3), name: "Done", type: "closed" }];
    const run = input => spawnSync(process.execPath, [CLI, "lists-before-todo"], { cwd: join(dir, "sub"), encoding: "utf8", input });
    for (const input of [JSON.stringify(lists), JSON.stringify({ lists }), JSON.stringify({ result: { id: U(9), name: "Board", lists } })]) {
      const r = run(input);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), { lists: [{ id: U(1), name: "Backlog" }] }, input);
    }
    for (const bad of ["not json", "", '{"data": []}']) {
      const r = run(bad);
      assert.equal(r.status, 2, bad);
      assert.ok(JSON.parse(r.stdout).error, bad);
    }
  });
  it("every command runs from the repo's top level, so a subfolder reads the root's hashsmith.json", () => {
    const dir = fixtureRepo();
    writeFileSync(join(dir, "hashsmith.json"), JSON.stringify({ repo: { base_branch: "main" } }));
    mkdirSync(join(dir, "sub"));
    const state = spawnSync(process.execPath, [CLI, "ticket-state", "ACME-1"], { cwd: join(dir, "sub"), encoding: "utf8" });
    assert.equal(JSON.parse(state.stdout)["ACME-1"].base.branch, "main", state.stdout + state.stderr);
    const conf = spawnSync(process.execPath, [CLI, "check-config"], { cwd: join(dir, "sub"), encoding: "utf8" });
    assert.doesNotMatch(conf.stdout, /not found/, conf.stdout);
  });
  it("an unknown command exits 2 with usage", () => {
    const r = spawnSync(process.execPath, [CLI, "nope"], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage/i);
  });
});

describe("CLI in a workspace", () => {
  const hashops = { project_id: U(1), project_key: "ACME", board_id: U(2), lists: { todo: U(3), in_progress: U(4), review: U(5), qa: U(6), done: U(7) }, ai_tag: "hashsmith" };
  // A workspace root (no .git) holding two repositories, each with its own hashsmith.json.
  function fixtureWorkspace() {
    const root = mkdtempSync(join(tmpdir(), "hashsmith-ws-"));
    const api = fixtureRepo('[remote "origin"]\n\turl = git@github.com:Org/acme-backend.git\n', join(root, "acme-api"));
    mkdirSync(join(root, "apps"));
    const web = fixtureRepo("", join(root, "apps", "web"));
    for (const [dir, base] of [[api, "dev"], [web, "main"]])
      writeFileSync(join(dir, "hashsmith.json"), JSON.stringify({ version: 1, hashops, repo: { base_branch: base } }));
    writeFileSync(join(root, "hashsmith.json"), JSON.stringify({ version: 1, hashops, repositories: { "acme-api": { path: "acme-api" }, web: { path: "apps/web" } } }));
    return { root, api, web };
  }
  const run = (cwd, args, input) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", input });
    return { status: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, raw: r.stdout + r.stderr };
  };

  it("check-config at the root checks the workspace file and every repository's own file", () => {
    const { root, web } = fixtureWorkspace();
    const ok = run(root, ["check-config"]);
    assert.deepEqual(ok.out, { ok: true }, ok.raw);
    writeFileSync(join(web, "hashsmith.json"), JSON.stringify({ version: 1, hashops: { ...hashops, board_id: U(9) }, repo: { base_branch: "main" } }));
    const bad = run(root, ["check-config"]);
    assert.equal(bad.status, 1, bad.raw);
    assert.deepEqual(bad.out.errors, ["apps/web/hashsmith.json: hashops.board_id differs from the workspace's."]);
  });
  it("check-config rejects a listed folder that is not a Git repository, or a symlink out of the workspace", () => {
    const { root } = fixtureWorkspace();
    const outside = fixtureRepo();
    writeFileSync(join(outside, "hashsmith.json"), JSON.stringify({ version: 1, hashops }));
    symlinkSync(outside, join(root, "escape"));
    mkdirSync(join(root, "plain"));
    writeFileSync(join(root, "hashsmith.json"), JSON.stringify({ version: 1, hashops, repositories: { out: { path: "escape" }, plain: { path: "plain" }, gone: { path: "gone" } } }));
    const r = run(root, ["check-config"]);
    assert.equal(r.status, 1, r.raw);
    assert.deepEqual(r.out.errors, [
      "repositories.out.path must stay inside the workspace (symlinks followed).",
      "repositories.plain: plain is not a Git repository.",
      "repositories.gone: gone is not a Git repository.",
    ]);
  });
  it("--repo runs a command inside that repository, with its own hashsmith.json", () => {
    const { root } = fixtureWorkspace();
    const api = run(root, ["ticket-state", "ACME-1", "--repo", "acme-api"]);
    assert.equal(api.status, 0, api.raw);
    assert.equal(api.out["ACME-1"].base.branch, "dev");
    const web = run(root, ["ticket-state", "--repo", "web", "ACME-1"]);
    assert.equal(web.out["ACME-1"].base.branch, "main", web.raw);
    const tree = run(root, ["tree", "--repo", "web"]);
    assert.deepEqual(tree.out, { clean: false, files: ["hashsmith.json"], branch: "main" }, tree.raw);
    const conf = run(root, ["check-config", "--repo", "acme-api"]);
    assert.deepEqual(conf.out, { ok: true }, conf.raw);
  });
  it("a per-repository command at the root without --repo fails and lists the names", () => {
    const { root } = fixtureWorkspace();
    for (const args of [["tree"], ["ticket-state", "ACME-1"], ["changelog"], ["env-keys"], ["handoff-patch", "ACME-1"]]) {
      const r = run(root, args);
      assert.equal(r.status, 2, `${args} ${r.raw}`);
      assert.deepEqual(r.out, { error: "This is a workspace root: pass --repo <name>.", repositories: ["acme-api", "web"] }, String(args));
    }
  });
  it("--repo with an unknown name, a listed path that escapes, or outside a workspace fails", () => {
    const { root, api } = fixtureWorkspace();
    for (const name of ["mobile", "__proto__", "constructor", "../acme-api"]) {
      const r = run(root, ["tree", "--repo", name]);
      assert.equal(r.status, 2, `${name} ${r.raw}`);
      assert.deepEqual(r.out, { error: `No repository "${name}" in the workspace's hashsmith.json.`, repositories: ["acme-api", "web"] }, name);
    }
    const outside = run(api, ["tree", "--repo", "web"]);
    assert.equal(outside.status, 2, outside.raw);
    assert.match(outside.out.error, /only at a workspace root/);
    writeFileSync(join(root, "hashsmith.json"), JSON.stringify({ version: 1, hashops, repositories: { up: { path: "../x" } } }));
    const bad = run(root, ["tree", "--repo", "up"]);
    assert.equal(bad.status, 2, bad.raw);
    assert.match(bad.out.error, /check-config/);
  });
  it("repo-match at the root maps the tags on stdin to repositories by key, folder and origin names", () => {
    const { root } = fixtureWorkspace();
    const task = { result: { tags: ["repo:acme-backend", "repo:Web", "repo:$(touch pwned)"] } };
    const r = run(root, ["repo-match"], JSON.stringify(task));
    assert.equal(r.status, 0, r.raw);
    assert.deepEqual(r.out, { workspace: true, repos: ["acme-backend", "Web", "$(touch pwned)"], repositories: ["acme-api", "web"], unknown: ["$(touch pwned)"], ambiguous: [] });
    assert.equal(existsSync(join(root, "pwned")), false);
    const one = run(root, ["repo-match", "--repo", "web"], JSON.stringify(["repo:web"]));
    assert.deepEqual(one.out, { probes: ["web"], repos: ["web"], match: true, others: [] }, one.raw);
  });
  it("--repo follows a symlink that stays inside the workspace, and refuses one that leaves it", () => {
    const { root, web } = fixtureWorkspace();
    const outside = fixtureRepo();
    symlinkSync(outside, join(root, "escape"));
    symlinkSync(web, join(root, "web-link"));
    writeFileSync(join(root, "hashsmith.json"), JSON.stringify({ version: 1, hashops, repositories: { out: { path: "escape" }, link: { path: "web-link" } } }));
    const out = run(root, ["tree", "--repo", "out"]);
    assert.equal(out.status, 2, out.raw);
    assert.match(out.out.error, /not a Git repository inside the workspace/);
    const link = run(root, ["tree", "--repo", "link"]);
    assert.equal(link.status, 0, link.raw);
    assert.equal(link.out.branch, "main");
    const route = run(root, ["repo-match"], JSON.stringify(["repo:web-link"]));
    assert.deepEqual(route.out.repositories, ["link"], "a symlinked key answers to its listed folder name");
  });
  it("a listed folder with a .git that is no repository of its own never sends git up to an outer one", () => {
    const { root } = fixtureWorkspace();
    mkdirSync(join(root, "fake", ".git"), { recursive: true });
    writeFileSync(join(root, "hashsmith.json"), JSON.stringify({ version: 1, hashops, repositories: { fake: { path: "fake" } } }));
    const r = run(root, ["tree", "--repo", "fake"]);
    assert.equal(r.status, 2, r.raw);
    assert.deepEqual(run(root, ["check-config"]).out.errors, ["repositories.fake: fake is not a Git repository."]);
  });
  it("check-config at the root rejects two names for one repository on disk, and a repository's own workspace file", () => {
    const { root, web } = fixtureWorkspace();
    symlinkSync(web, join(root, "web-link"));
    writeFileSync(join(root, "hashsmith.json"), JSON.stringify({ version: 1, hashops, repositories: { web: { path: "apps/web" }, link: { path: "web-link" } } }));
    assert.deepEqual(run(root, ["check-config"]).out.errors, ["repositories.link.path is the same repository as web's."]);
    writeFileSync(join(web, "hashsmith.json"), JSON.stringify({ version: 1, hashops, repositories: { x: { path: "x" } } }));
    writeFileSync(join(root, "hashsmith.json"), JSON.stringify({ version: 1, hashops, repositories: { web: { path: "apps/web" } } }));
    assert.deepEqual(run(root, ["check-config"]).out.errors, ["apps/web/hashsmith.json is a workspace file; workspaces do not nest."]);
  });
  it("check-config in a repository, from a subfolder or through --repo, never passes a workspace file", () => {
    const { root, web } = fixtureWorkspace();
    writeFileSync(join(web, "hashsmith.json"), JSON.stringify({ version: 1, hashops, repositories: { x: { path: "x" } } }));
    mkdirSync(join(web, "src"));
    for (const [cwd, args] of [[join(web, "src"), ["check-config"]], [root, ["check-config", "--repo", "web"]]]) {
      const r = run(cwd, args);
      assert.equal(r.status, 1, r.raw);
      assert.match(r.out.errors[0], /workspace file: run check-config at the workspace root/, cwd);
    }
  });
  it("check-config rejects a workspace root that is itself inside a Git repository", () => {
    const outer = fixtureRepo();
    mkdirSync(join(outer, "ws"));
    const api = fixtureRepo("", join(outer, "ws", "acme-api"));
    writeFileSync(join(api, "hashsmith.json"), JSON.stringify({ version: 1, hashops, repo: { base_branch: "dev" } }));
    writeFileSync(join(outer, "ws", "hashsmith.json"), JSON.stringify({ version: 1, hashops, repositories: { "acme-api": { path: "acme-api" } } }));
    const r = run(join(outer, "ws"), ["check-config"]);
    assert.equal(r.status, 1, r.raw);
    assert.deepEqual(r.out.errors, ["A workspace root must not be inside a Git repository; it is a plain folder holding them."]);
  });
  it("lists-before-todo and feedback-target run at the root; --repo in a plain folder fails", () => {
    const { root } = fixtureWorkspace();
    const lists = [{ id: U(8), name: "Backlog", type: "active" }, { id: U(3), name: "To Do", type: "active" }];
    assert.deepEqual(run(root, ["lists-before-todo"], JSON.stringify(lists)).out, { lists: [{ id: U(8), name: "Backlog" }] });
    assert.equal(run(root, ["feedback-target"]).out.ok, true);
    const plain = mkdtempSync(join(tmpdir(), "hashsmith-plain-"));
    const r = run(plain, ["tree", "--repo", "web"]);
    assert.equal(r.status, 2, r.raw);
    assert.match(r.out.error, /only at a workspace root/);
  });
  it("a repository opened directly keeps working on its own file", () => {
    const { api } = fixtureWorkspace();
    const r = run(api, ["check-config"]);
    assert.deepEqual(r.out, { ok: true }, r.raw);
    assert.equal(run(api, ["ticket-state", "ACME-1"]).out["ACME-1"].base.branch, "dev");
  });
});
