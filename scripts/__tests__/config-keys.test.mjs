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
import { checkConfig, checkWorkspace, closestKey, configHelp, effectiveSettings, jsonProblem } from "../hashsmith.mjs";

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
    assert.deepEqual(checkConfig(c), ['Unknown key "hashops.lists.backlog".']);
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
  it("closes every section the way check-config does (HSM-38)", () => {
    const p = schema.properties;
    for (const section of ["hashops", "repo", "qa", "sonar", "sentry", "changelog", "intake", "preferences"])
      assert.equal(p[section].additionalProperties, false, section);
    // A map of names stays open to any valid name; each entry is closed.
    assert.equal(p.learned.additionalProperties.additionalProperties, false);
    assert.deepEqual(Object.keys(p.learned.additionalProperties.properties), ["value", "why", "source", "added"]);
    assert.equal(p.intake.properties.processed_meetings.items.additionalProperties, false);
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

describe("check-config rejects unknown keys in every section (HSM-38)", () => {
  const withKey = (key, v = "x") => {
    const c = valid();
    c.sentry = { project: "" };
    setAt(c, key, v);
    return checkConfig(c);
  };
  it("names a misspelled key and the key it was meant to be", () => {
    const policy = valid();
    policy.repo = { base_branch: "dev", branch_polcy: "current" };
    assert.deepEqual(checkConfig(policy), ['Unknown key "repo.branch_polcy"; did you mean "repo.branch_policy"?']);
    const c = valid();
    delete c.qa.mode;
    c.qa.mdoe = "code";
    assert.deepEqual(checkConfig(c), ['Unknown key "qa.mdoe"; did you mean "qa.mode"?'], "a transposition is close");
    assert.deepEqual(checkConfig({ ...valid(), sonar: { projectkey: "x" } }), ['Unknown key "sonar.projectkey"; did you mean "sonar.project_key"?']);
  });
  it("covers every section of a repository's file, and no name twice", () => {
    for (const key of ["hashops.extra", "repo.extra", "qa.extra", "sonar.extra", "sentry.extra", "changelog.extra", "intake.extra"])
      assert.deepEqual(withKey(key), [`Unknown key "${key}".`], key);
  });
  it("covers learned entries and processed meetings, whose shape is fixed", () => {
    const c = valid();
    c.learned.qa_login_route.note = "x";
    c.intake.processed_meetings = [{ id: "m", on: "2026-11-19", tickets: [], extra: 1 }];
    assert.deepEqual(checkConfig(c), ['Unknown key "intake.processed_meetings[0].extra".', 'Unknown key "learned.qa_login_route.note".']);
  });
  it("gives one error for a misspelled required key, not a second one saying it is missing", () => {
    const c = valid();
    c.hashops.board_ID = c.hashops.board_id;
    delete c.hashops.board_id;
    assert.deepEqual(checkConfig(c), ['Unknown key "hashops.board_ID"; did you mean "hashops.board_id"?']);
    const log = valid();
    log.changelog = { mdoe: "write", path: "CHANGELOG.md" };
    assert.deepEqual(checkConfig(log), ['Unknown key "changelog.mdoe"; did you mean "changelog.mode"?']);
    const meeting = valid();
    meeting.intake.processed_meetings = [{ id: "m", on: "2026-11-19", tickts: [] }];
    assert.deepEqual(checkConfig(meeting), ['Unknown key "intake.processed_meetings[0].tickts"; did you mean "intake.processed_meetings[0].tickets"?']);
    const learned = valid();
    learned.learned.qa_login_route = { value: 1, wyh: "x", source: "s", added: "2026-11-19" };
    assert.deepEqual(checkConfig(learned), ['Unknown key "learned.qa_login_route.wyh"; did you mean "learned.qa_login_route.why"?']);
  });
  it("treats a misspelled list key like any other: one error, with the list it meant", () => {
    const c = valid();
    c.hashops.lists.in_progres = c.hashops.lists.in_progress;
    delete c.hashops.lists.in_progress;
    assert.deepEqual(checkConfig(c), ['Unknown key "hashops.lists.in_progres"; did you mean "hashops.lists.in_progress"?']);
  });
  it("still names the other problems beside a misspelled key", () => {
    const learned = valid();
    learned.learned = { BadName: learned.learned.qa_login_route, good: { value: 1, wyh: "x", source: "s", added: "2026-11-19" } };
    assert.deepEqual(checkConfig(learned), ['Unknown key "learned.good.wyh"; did you mean "learned.good.why"?', 'learned key "BadName" must be snake_case.']);
    const log = valid();
    log.changelog = { mdoe: "write", path: "docs/CHANGELOG.md" };
    assert.deepEqual(checkConfig(log), [
      'Unknown key "changelog.mdoe"; did you mean "changelog.mode"?',
      'changelog.path must be a .md file at the repo root, like "CHANGELOG.md".',
    ]);
  });
  it("suggests only a key the file does not have yet", () => {
    assert.deepEqual(withKey("repo.base_branc", "main"), ['Unknown key "repo.base_branc".']);
  });
  it("suggests at the top level and in preferences too, only when a name is close", () => {
    assert.deepEqual(checkConfig({ ...valid(), sentyr: {} }), ['Unknown top-level key "sentyr"; did you mean "sentry"?']);
    const c = valid();
    c.hashop = c.hashops;
    delete c.hashops;
    assert.deepEqual(checkConfig(c), ['Unknown top-level key "hashop"; did you mean "hashops"?']);
    assert.deepEqual(checkConfig({ ...valid(), preferences: { questoins: "normal" } }), ['Unknown preference "questoins"; did you mean "questions"?']);
    assert.deepEqual(withKey("preferences.tone", "normal"), ['Unknown preference "tone".']);
  });
  it("checks a workspace file's sections the same way", () => {
    const w = workspace();
    w.hashops.boardid = w.hashops.board_id;
    delete w.hashops.board_id;
    w.learned = { a_fact: { value: 1, why: "w", source: "s", added: "2026-11-19", extra: 1 } };
    assert.deepEqual(checkConfig(w), ['Unknown key "hashops.boardid"; did you mean "hashops.board_id"?', 'Unknown key "learned.a_fact.extra".']);
    const child = { version: 1, hashops: hashops(), repo: { base_branch: "main", polcy: "" } };
    const children = { api: { inside: true, git: true, dir: "/a", config: child }, web: { inside: true, git: true, dir: "/w", config: { version: 1, hashops: hashops() } } };
    assert.deepEqual(checkWorkspace(workspace(), children), ['acme-api/hashsmith.json: Unknown key "repo.polcy".']);
  });
  it("quotes a key name safely and caps its length", () => {
    const name = `a"b\n${"x".repeat(300)}`;
    const [e] = checkConfig({ ...valid(), [name]: 1 });
    assert.ok(e.length < 120, e);
    assert.ok(!e.includes("\n"), "no raw line break");
    assert.match(e, /^Unknown top-level key "a\\"b/);
    const [r] = withKey(`repo.${"y".repeat(300)}`);
    assert.ok(r.length < 120, r);
    const [l] = withKey(`hashops.lists.x"\n${"y".repeat(200)}`);
    assert.ok(l.length < 120 && !l.includes("\n"), l);
    assert.deepEqual(withKey("repo.ab\u202Ec"), ['Unknown key "repo.ab\\u202ec".'], "an invisible character is shown escaped");
    const personal = effectiveSettings(null, { [`k"\n${"z".repeat(200)}`]: 1 }, "P").errors[0];
    assert.ok(personal.length < 120 && !personal.includes("\n"), personal);
  });
});

describe("closestKey", () => {
  const keys = ["base_branch", "branch_policy", "mode", "base_url", "on", "id", "questions"];
  it("finds a typo, a transposition and a change of case", () => {
    assert.equal(closestKey("branch_polcy", keys), "branch_policy");
    assert.equal(closestKey("mdoe", keys), "mode");
    assert.equal(closestKey("Base_Url", keys), "base_url");
    assert.equal(closestKey("base_brnach", keys), "base_branch");
  });
  it("gives nothing for an unrelated or short name", () => {
    assert.equal(closestKey("tone", keys), null);
    assert.equal(closestKey("no", keys), null, "a short name must match exactly, case aside");
    assert.equal(closestKey("ID", keys), "id");
    assert.equal(closestKey("md", keys), null);
    assert.equal(closestKey("anything", []), null);
  });
});

describe("jsonProblem: where a file stops being JSON (HSM-38)", () => {
  it("is null for valid JSON", () => assert.equal(jsonProblem('{"a": 1}'), null));
  it("gives the line and column of the first bad character", () => {
    assert.equal(jsonProblem('{\n  "a": 1\n  "b": 2\n}'), "is not valid JSON at line 3, column 3");
    assert.equal(jsonProblem('{\n  "a": 1,\n}'), "is not valid JSON at line 3, column 1");
    assert.equal(jsonProblem('{"a": 1, "b": x}'), "is not valid JSON at line 1, column 15", "no position in the engine's message");
    assert.equal(jsonProblem('{\n  "a": tru}'), "is not valid JSON at line 2, column 11");
    assert.equal(jsonProblem("{\n  'a': 1\n}"), "is not valid JSON at line 2, column 3");
  });
  it("names merge-conflict markers by line", () => {
    const text = '<<<<<<< HEAD\n{"a": 1}\n=======\n{"a": 2}\n>>>>>>> ai/ACME-1-x\n';
    assert.equal(jsonProblem(text), "has merge-conflict markers at lines 1, 3 and 5: resolve the conflict");
    assert.equal(jsonProblem('{\n"a": 1,\n<<<<<<< HEAD\n}'), "has merge-conflict markers at line 3: resolve the conflict");
  });
  it("says when the file is empty or ends early", () => {
    assert.equal(jsonProblem("  \n"), "is empty");
    assert.equal(jsonProblem('{\n  "a": [1,\n'), "is not valid JSON: it ends early, at line 2 (an unclosed { or [?)");
  });
  it("never quotes the file's text", () => {
    for (const text of ['{"secret": nope}', '{"x": "sk_live_abc', "<<<<<<< sk_live_abc\n"]) {
      const p = jsonProblem(text);
      assert.ok(!/nope|sk_live/.test(p), p);
    }
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
    assert.deepEqual(configHelp({ __invalid: true, problem: "is not valid JSON at line 2, column 1" }, null).errors, ["hashsmith.json is not valid JSON at line 2, column 1."]);
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
