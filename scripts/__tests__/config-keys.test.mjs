// The hashsmith.json key table (HSM-30): check-config, config-help and hashsmith.schema.json all
// come from scripts/config-keys.mjs, and these tests fail when any of them drifts from it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CONFIG_KEYS, configSchema } from "../config-keys.mjs";
import { checkConfig, configHelp, effectiveSettings } from "../hashsmith.mjs";

const CLI = fileURLToPath(new URL("../hashsmith.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const U = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hashops = () => ({
  project_id: U(1),
  project_key: "ACME",
  board_id: U(2),
  lists: { todo: U(3), in_progress: U(4), review: U(5), qa: "", done: U(6) },
  ai_tag: "hashsmith",
});
const valid = () => ({
  version: 1,
  hashops: hashops(),
  repo: { base_branch: "dev", branch_policy: "" },
  qa: { base_url: "http://localhost:8080", mode: "code" },
  sonar: { project_key: "hashlogics_acme" },
  changelog: { mode: "write", path: "CHANGELOG.md" },
  intake: { processed_meetings: [] },
  learned: { qa_login_route: { value: "/login", why: "QA starts here", source: "the auth route", added: "2026-10-28" } },
  preferences: { questions: "detailed" },
});
const workspace = () => ({ version: 1, hashops: hashops(), repositories: { api: { path: "acme-api" }, web: { path: "apps/web" } } });
const setAt = (obj, key, v) => {
  const parts = key.split(".");
  const parent = parts.slice(0, -1).reduce((o, p) => (o[p] ??= {}), obj);
  parent[parts.at(-1)] = v;
};
const plain = CONFIG_KEYS.filter(r => !r.key.includes("<name>"));
const top = file => [...new Set(CONFIG_KEYS.filter(r => r.files.includes(file)).map(r => r.key.split(".")[0]))];
// A fixture repository without running a git write.
function fixtureRepo(dir = mkdtempSync(join(tmpdir(), "hashsmith-repo-"))) {
  for (const d of [".git/objects", ".git/refs/heads"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, ".git/HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dir, ".git/config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n");
  return dir;
}

describe("the key table", () => {
  it("every row is complete: one line on what it does, a scope, the files that hold it", () => {
    for (const r of CONFIG_KEYS) {
      assert.match(r.key, /^[a-z_]+(\.([a-z_]+|<name>))*$/, r.key);
      assert.match(r.about, /^[A-Z][^\n]*\.$/, `${r.key}: about must be one sentence`);
      assert.ok(["team", "personal"].includes(r.scope), `${r.key}: scope`);
      assert.ok(r.files.length && r.files.every(f => ["repository", "workspace"].includes(f)), `${r.key}: files`);
      assert.ok(Array.isArray(r.values) ? r.values.length > 0 : typeof r.values === "string" && r.values, `${r.key}: values`);
      if (r.default === null) assert.ok(typeof r.unset === "string" && r.unset, `${r.key}: says what happens when unset`);
      else if (Array.isArray(r.values)) assert.ok(r.values.includes(r.default), `${r.key}: default is an allowed value`);
      if (r.key.includes("<name>")) assert.ok(r.names instanceof RegExp, `${r.key}: names pattern`);
    }
    assert.equal(new Set(CONFIG_KEYS.map(r => r.key)).size, CONFIG_KEYS.length, "no key twice");
  });
  it("only preferences take a personal value, and their default is effectiveSettings'", () => {
    for (const r of CONFIG_KEYS) assert.equal(r.scope === "personal", r.key.startsWith("preferences."), r.key);
    for (const r of CONFIG_KEYS.filter(r => r.scope === "personal"))
      assert.equal(effectiveSettings(null, null)[r.key.split(".")[1]].value, r.default, r.key);
  });
});

describe("check-config agrees with the table", () => {
  it("accepts every allowed value of every enum key, \"\" where it means unset, and rejects any other", () => {
    for (const r of plain.filter(r => Array.isArray(r.values))) {
      for (const v of r.empty ? [...r.values, ""] : r.values) {
        const c = valid();
        setAt(c, r.key, v);
        assert.deepEqual(checkConfig(c), [], `${r.key} = ${JSON.stringify(v)}`);
      }
      const c = valid();
      setAt(c, r.key, "not-a-value");
      assert.equal(checkConfig(c).length, 1, `${r.key} rejects an unlisted value`);
    }
  });
  it("accepts \"\" exactly where the table says empty means unset", () => {
    for (const r of plain.filter(r => r.files.includes("repository") && r.key !== "version")) {
      const c = valid();
      setAt(c, r.key, "");
      const errors = checkConfig(c);
      assert.equal(errors.length === 0, !!r.empty, `${r.key}: ${errors.join(" ")}`);
    }
  });
  it("knows the table's top-level keys in each file, and no others", () => {
    for (const k of top("repository")) assert.ok(!checkConfig({ ...valid(), [k]: {} }).some(e => e.includes("top-level")), k);
    for (const k of top("workspace")) assert.ok(!checkConfig({ ...workspace(), [k]: workspace()[k] ?? {} }).some(e => e.includes("top-level")), k);
    for (const k of top("repository").filter(k => !top("workspace").includes(k)))
      assert.ok(checkConfig({ ...workspace(), [k]: {} }).some(e => e.startsWith(`${k} belongs in each repository's own`)), k);
    assert.deepEqual(checkConfig({ ...valid(), extra: 1 }), ['Unknown top-level key "extra".']);
  });
  it("requires exactly the keys the table marks required, within their section", () => {
    for (const r of plain.filter(r => r.files.includes("repository") && r.key.includes("."))) {
      const c = valid();
      const parts = r.key.split(".");
      const section = parts.slice(0, -1).reduce((o, p) => (o[p] ??= {}), c); // sentry: an empty section
      delete section[parts.at(-1)];
      assert.equal(checkConfig(c).length > 0, !!r.required, `${r.key}: ${checkConfig(c).join(" ")}`);
    }
    assert.equal(checkConfig({ ...valid(), version: undefined }).length, 1, "version is required");
    const c = valid();
    c.hashops.lists.backlog = "";
    assert.deepEqual(checkConfig(c), ["hashops.lists.backlog is not a list key (todo, in_progress, review, qa, done)."]);
  });
});

describe("hashsmith.schema.json", () => {
  const schema = configSchema();
  it("the shipped file is the one the table generates (npm run schema)", () => {
    assert.deepEqual(JSON.parse(readFileSync(join(ROOT, "hashsmith.schema.json"), "utf8")), schema);
  });
  it("lists an enum key's values, with \"\" where empty means unset, and its default", () => {
    assert.deepEqual(schema.properties.repo.properties.branch_policy.enum, ["managed", "current", "confirm", ""]);
    assert.equal(schema.properties.repo.properties.branch_policy.default, "managed");
    assert.deepEqual(schema.properties.changelog.properties.mode.enum, ["write", "commits", "off"]);
    assert.deepEqual(schema.properties.preferences.properties.questions.enum, ["normal", "detailed", ""]);
  });
  it("requires and closes what check-config does", () => {
    assert.deepEqual(schema.required, ["version", "hashops"]);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.properties.hashops.properties.lists.required, ["todo", "in_progress", "review", "qa", "done"]);
    assert.equal(schema.properties.hashops.properties.lists.additionalProperties, false);
    assert.deepEqual(schema.properties.changelog.required, ["mode", "path"]);
    assert.equal(schema.properties.repo.required.includes("branch_policy"), false);
    assert.deepEqual(schema.properties.learned.additionalProperties.required, ["value", "why", "source", "added"]);
    assert.deepEqual(schema.properties.repositories.additionalProperties.required, ["path"]);
    assert.equal(schema.properties.repositories.additionalProperties.additionalProperties, false);
    assert.equal(schema.properties.learned.propertyNames.pattern, "^[a-z][a-z0-9_]*$");
  });
  it("each pattern accepts what check-config accepts", () => {
    const p = schema.properties;
    for (const [pattern, ok, bad] of [
      [p.hashops.properties.project_id.pattern, U(1), "1234"],
      [p.hashops.properties.lists.properties.todo.pattern, "", "x"],
      [p.hashops.properties.project_key.pattern, "ACME", "acme"],
      [p.qa.properties.base_url.pattern, "http://127.0.0.1:5173/app", "https://acme.com"],
      [p.changelog.properties.path.pattern, "CHANGES.MD", "docs/CHANGELOG.md"],
    ]) {
      assert.match(ok, new RegExp(pattern), pattern);
      assert.doesNotMatch(bad, new RegExp(pattern), pattern);
    }
  });
  it("check-config accepts and rejects the same values as each pattern", () => {
    for (const [key, ok, bad] of [
      ["hashops.project_id", U(7).toUpperCase(), "1234"],
      ["hashops.board_id", U(7), `${U(7)}x`],
      ["hashops.lists.todo", "", "x"],
      ["hashops.project_key", "ACME2", "acme"],
      ["qa.base_url", "http://127.0.0.1:5173/app", "http://0.0.0.0:3000"],
      ["changelog.path", "CHANGES.MD", "docs/CHANGELOG.md"],
      ["intake.processed_meetings", [{ id: "m", on: "2026-11-19", tickets: ["ACME-1"] }], [{ id: "m", on: "19-11-2026", tickets: ["acme-1"] }]],
    ]) {
      const [good, wrong] = [valid(), valid()];
      setAt(good, key, ok);
      setAt(wrong, key, bad);
      assert.deepEqual(checkConfig(good), [], `${key} accepts ${JSON.stringify(ok)}`);
      assert.equal(checkConfig(wrong).length, 1, `${key} rejects ${JSON.stringify(bad)}`);
      const leaf = key.split(".").reduce((n, p) => n.properties[p], schema);
      if (leaf.pattern) {
        assert.match(ok, new RegExp(leaf.pattern), key);
        assert.doesNotMatch(bad, new RegExp(leaf.pattern), key);
      }
    }
    const learned = valid();
    learned.learned["Bad-Name"] = learned.learned.qa_login_route;
    assert.equal(checkConfig(learned).length, 1);
    assert.doesNotMatch("Bad-Name", new RegExp(schema.properties.learned.propertyNames.pattern));
  });
});

describe("configHelp", () => {
  const row = (help, key) => help.keys.find(k => k.key === key);
  it("gives each key's value and source: team, personal, default or unset", () => {
    const help = configHelp(valid(), { preferences: { questions: "normal" } }, "~/.hashsmith/settings.json");
    assert.equal(help.found, true);
    assert.equal(help.file, "repository");
    assert.deepEqual([help.ok, help.errors, help.missing], [true, [], []]);
    const pick = key => ({ value: row(help, key).value, source: row(help, key).source });
    assert.deepEqual(pick("hashops.project_key"), { value: "ACME", source: "team" });
    assert.deepEqual(pick("repo.branch_policy"), { value: "managed", source: "default" });
    assert.deepEqual(pick("hashops.lists.qa"), { value: "", source: "unset" });
    assert.deepEqual(pick("sentry.project"), { value: null, source: "unset" });
    assert.deepEqual(pick("preferences.questions"), { value: "normal", source: "personal" });
    assert.deepEqual(pick("learned.<name>"), { value: ["qa_login_route"], source: "team" });
    assert.deepEqual(help.learned, [{ key: "qa_login_route", value: "/login", why: "QA starts here", source: "the auth route", added: "2026-10-28" }]);
    const named = valid();
    named.learned.qa_login_route.key = "other";
    assert.equal(configHelp(named, null).learned[0].key, "qa_login_route", "an entry's own fields never rename it");
  });
  it("carries the table's description of every key, in table order", () => {
    const help = configHelp(valid(), null);
    assert.deepEqual(help.keys.map(k => k.key), CONFIG_KEYS.filter(r => r.files.includes("repository")).map(r => r.key));
    const r = row(help, "repo.branch_policy");
    assert.deepEqual(
      { section: r.section, values: r.values, empty: r.empty, default: r.default, scope: r.scope },
      { section: "repo", values: ["managed", "current", "confirm"], empty: true, default: "managed", scope: "team" },
    );
    assert.match(r.about, /\.$/);
    assert.equal(typeof row(help, "repo.base_branch").when_unset, "string");
  });
  it("names the core keys that are missing, so the skill can propose onboarding", () => {
    const c = valid();
    delete c.hashops.project_id;
    c.hashops.board_id = "";
    const help = configHelp(c, null);
    assert.equal(help.ok, false);
    assert.deepEqual(help.missing, ["hashops.project_id", "hashops.board_id"]);
    const none = configHelp(null, null);
    assert.equal(none.found, false);
    assert.deepEqual(none.errors, ["hashsmith.json not found."]);
    assert.deepEqual(none.missing, plain.filter(r => r.essential && r.required).map(r => r.key));
    assert.deepEqual(configHelp({ __invalid: true }, null).errors, ["hashsmith.json is not valid JSON."]);
  });
  it("shows a workspace file's own keys, its repositories included", () => {
    const help = configHelp(workspace(), null);
    assert.equal(help.file, "workspace");
    assert.equal(row(help, "repo.base_branch"), undefined);
    assert.deepEqual(row(help, "repositories.<name>.path").value, { api: "acme-api", web: "apps/web" });
    assert.deepEqual(help.keys.map(k => k.key), CONFIG_KEYS.filter(r => r.files.includes("workspace")).map(r => r.key));
  });
  it("names a broken personal value and keeps the team's", () => {
    const help = configHelp(valid(), { preferences: { questions: "quiet" } }, "P");
    assert.deepEqual(row(help, "preferences.questions").value, "detailed");
    assert.deepEqual(help.settings_errors, ['P: preferences.questions must be "normal", "detailed" or "".']);
  });
});

describe("CLI config-help", () => {
  const run = (cwd, args, home) => {
    const r = spawnSync(process.execPath, [CLI, "config-help", ...args], { cwd, encoding: "utf8", env: { ...process.env, HOME: home } });
    return { status: r.status, out: JSON.parse(r.stdout), raw: r.stdout + r.stderr };
  };
  it("reads hashsmith.json and the personal file, read-only", () => {
    const dir = fixtureRepo();
    const home = mkdtempSync(join(tmpdir(), "hashsmith-home-"));
    writeFileSync(join(dir, "hashsmith.json"), JSON.stringify(valid()));
    mkdirSync(join(home, ".hashsmith"));
    writeFileSync(join(home, ".hashsmith", "settings.json"), JSON.stringify({ preferences: { questions: "normal" } }));
    const r = run(dir, [], home);
    assert.equal(r.status, 0, r.raw);
    assert.equal(r.out.personal_file, join(home, ".hashsmith", "settings.json"));
    assert.deepEqual(r.out.keys.find(k => k.key === "preferences.questions").source, "personal");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "hashsmith.json"), "utf8")), valid());
  });
  it("exits 0 without a hashsmith.json, naming what is missing", () => {
    const r = run(fixtureRepo(), [], mkdtempSync(join(tmpdir(), "hashsmith-home-")));
    assert.equal(r.status, 0, r.raw);
    assert.equal(r.out.found, false);
    assert.ok(r.out.missing.includes("hashops.project_id"));
  });
  it("--schema prints the schema, from any folder", () => {
    const r = run(tmpdir(), ["--schema"], tmpdir());
    assert.equal(r.status, 0, r.raw);
    assert.deepEqual(r.out, configSchema());
  });
  it("runs at a workspace root on the root's file, and in a repository with --repo", () => {
    const root = mkdtempSync(join(tmpdir(), "hashsmith-ws-"));
    const api = fixtureRepo(join(root, "acme-api"));
    mkdirSync(join(root, "apps"));
    const web = fixtureRepo(join(root, "apps", "web"));
    for (const d of [api, web]) writeFileSync(join(d, "hashsmith.json"), JSON.stringify({ version: 1, hashops: hashops(), repo: { base_branch: "main" } }));
    writeFileSync(join(root, "hashsmith.json"), JSON.stringify(workspace()));
    const home = mkdtempSync(join(tmpdir(), "hashsmith-home-"));
    const at = run(root, [], home);
    assert.equal(at.status, 0, at.raw);
    assert.equal(at.out.file, "workspace");
    const inWeb = run(root, ["--repo", "web"], home);
    assert.equal(inWeb.out.file, "repository", inWeb.raw);
    assert.equal(inWeb.out.keys.find(k => k.key === "repo.base_branch").value, "main");
  });
});
