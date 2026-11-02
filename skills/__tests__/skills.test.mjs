// Structure rules for every shipped skill and agent (CLAUDE.md "Budgets", design §6): frontmatter,
// the 250-line budget, references that exist, and no literal ids from any one project.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { judge } from "../../hooks/git-guard.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const skillDirs = readdirSync(join(root, "skills"), { withFileTypes: true })
  .filter(d => d.isDirectory() && d.name !== "__tests__")
  .map(d => d.name);
const agentFiles = existsSync(join(root, "agents")) ? readdirSync(join(root, "agents")).filter(f => f.endsWith(".md")) : [];

function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return null;
  return Object.fromEntries(
    m[1]
      .split("\n")
      .map(l => /^([a-z-]+):\s*(.*)$/.exec(l))
      .filter(Boolean)
      .map(([, k, v]) => [k, v.trim()]),
  );
}

function checkDoc(path, name, { maxLines }) {
  const text = readFileSync(path, "utf8");
  const fm = frontmatter(text);
  assert.ok(fm, `${path}: frontmatter missing`);
  assert.equal(fm.name, name, `${path}: name must be "${name}"`);
  assert.match(fm.description ?? "", /^Use when /, `${path}: description must start with "Use when"`);
  if (maxLines) assert.ok(text.split("\n").length <= maxLines, `${path}: over ${maxLines} lines`);
  assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, `${path}: literal UUID`);
  // `references/…` resolves against the skill's own folder, or a vendored kit the doc names.
  const vendors = [...text.matchAll(/vendor\/([\w.-]+)\//g)].map(m => join(root, "vendor", m[1]));
  for (const [, ref] of text.matchAll(/`((?:reference|agents)\/[\w./-]+\.md|references\/[\w./-]+\.md)`/g)) {
    const bases = ref.startsWith("references/") ? [join(path, ".."), ...vendors] : [root];
    assert.ok(bases.some(b => existsSync(join(b, ref))), `${path}: mentions ${ref}, which does not exist`);
  }
  // Every git command a skill tells the model to run must get past Hashsmith's own git guard.
  for (const [, cmd] of text.matchAll(/`(git [^`]+)`/g)) {
    const tokens = cmd.split(/\s+/).filter(t => !/^[>|]/.test(t));
    if (tokens[1] === "switch") continue; // ai/* switching asks; checked by the git-guard tests
    if (tokens.includes("*")) continue; // a settings pattern ("keep `git checkout *` denied"), not a command
    assert.equal(judge(tokens), "allow", `${path}: \`${cmd}\` is denied by git-guard`);
  }
  for (const [, agent] of text.matchAll(/`([a-z-]+)` (?:sub)?agent/g))
    assert.ok(existsSync(join(root, "agents", `${agent}.md`)), `${path}: agent ${agent} does not exist`);
}

describe("skills and agents", () => {
  it("ships at least one skill", () => assert.ok(skillDirs.length > 0, "no skills/*/SKILL.md yet"));
  for (const dir of skillDirs)
    it(`skills/${dir}/SKILL.md follows the rules`, () => {
      checkDoc(join(root, "skills", dir, "SKILL.md"), dir, { maxLines: 250 });
      if (existsSync(join(root, "skills", dir, "references")))
        assert.ok(existsSync(join(root, "skills", dir, "references", "SOURCE.md")), `skills/${dir}/references needs SOURCE.md`);
    });
  it("every vendored kit carries its SOURCE.md and LICENSE", () => {
    const vendor = join(root, "vendor");
    for (const d of existsSync(vendor) ? readdirSync(vendor) : [])
      for (const f of ["SOURCE.md", "LICENSE"]) assert.ok(existsSync(join(vendor, d, f)), `vendor/${d} needs ${f}`);
  });
  it("the HashOps allowlist is exactly the tools the skills name", () => {
    const { hashsmith, writes } = JSON.parse(readFileSync(join(root, "hooks", "hashops-tools.json"), "utf8"));
    const docs = [
      ...skillDirs.map(d => join(root, "skills", d, "SKILL.md")),
      ...readdirSync(join(root, "reference")).map(f => join(root, "reference", f)),
      ...agentFiles.map(f => join(root, "agents", f)),
    ].map(f => readFileSync(f, "utf8"));
    const named = new Set(
      docs.flatMap(t => [...t.matchAll(/`([a-z]+_[a-z_]+)`/g)].map(m => m[1])).filter(w => writes.includes(w) || hashsmith.includes(w) || /^(get|list|search)_/.test(w)),
    );
    for (const tool of named) assert.ok(hashsmith.includes(tool), `a skill uses ${tool}, which hooks/hashops-tools.json does not allow`);
    for (const tool of hashsmith) assert.ok(named.has(tool), `hooks/hashops-tools.json allows ${tool}, which no skill uses`);
  });
  it("no skill or reference names Hashsmith's tag literally: they read hashops.ai_tag", () => {
    const files = [
      ...skillDirs.map(d => join("skills", d, "SKILL.md")),
      ...readdirSync(join(root, "reference")).map(f => join("reference", f)),
      ...agentFiles.map(f => join("agents", f)),
    ];
    // Quoted, listed or "ai tag" / "ai-tagged" forms; `ai/*` branch names are fine.
    const literal = /`ai`|"ai"|\[ai\b|\bai[- ]tag/; // lower case: "a project's own AI tag" is fine
    for (const f of files) assert.doesNotMatch(readFileSync(join(root, f), "utf8"), literal, `${f} names the "ai" tag; use hashops.ai_tag`);
  });
  it("the handoff ends with a commit message whose subject carries the ticket key (sync finds base-branch work by it)", () => {
    const text = readFileSync(join(root, "reference", "handoff-template.md"), "utf8");
    const block = text.split(/^Commit message$/m)[1];
    assert.ok(block, "reference/handoff-template.md needs a \"Commit message\" section");
    const subject = block.trim().split("\n")[0];
    assert.match(subject, /^[a-z]+(\([a-z-]+\))?: .+\(ACME-\d+(, ACME-\d+)*\)$/, "its subject must be a conventional commit ending in (ACME-12)");
    const handoff = readFileSync(join(root, "skills", "work", "SKILL.md"), "utf8").split(/^## 7\./m)[1] ?? "";
    assert.match(handoff, /commit message in a code block/, "work's hand-off step must show the commit message in chat");
  });
  it("work writes the changelog entry before self-review, checks it, and reports it at handoff", () => {
    const work = readFileSync(join(root, "skills", "work", "SKILL.md"), "utf8");
    const [implement, review, handoff] = [/^## 5\./m, /^## 6\./m, /^## 7\./m].map(re => work.split(re)[1]?.split(/^## \d/m)[0] ?? "");
    assert.match(implement, /reference\/changelog\.md/, "§5 must write the entry (reference/changelog.md) before self-review");
    assert.match(review, /changelog-check <type> < "\$P"/, "§6 must run changelog-check on the patch");
    assert.match(handoff, /`Changelog:` line/, "§7 must carry the Changelog line");
    const template = readFileSync(join(root, "reference", "handoff-template.md"), "utf8");
    assert.match(template, /^Changelog: added under Unreleased — "/m, "the handoff template needs the Changelog line");
    assert.match(readFileSync(join(root, "skills", "onboard-project", "SKILL.md"), "utf8"), /CLI's `changelog`/);
  });
  it("Hashsmith never touches a project's versions or releases", () => {
    const text = readFileSync(join(root, "reference", "changelog.md"), "utf8");
    assert.match(text, /\*\*Never\*\* edit a version field, add or rename a version heading, rename `Unreleased`/);
  });
  it("the ticket assessment defines every check and level work's brief uses", () => {
    const text = readFileSync(join(root, "reference", "ticket-assessment.md"), "utf8");
    for (const word of ["Clear", "Valid", "Feasible", "Allowed", "Legitimate", "OK", "Concern", "Stop"])
      assert.match(text, new RegExp(`\\*\\*${word}\\b`), `reference/ticket-assessment.md must define ${word}`);
    assert.match(readFileSync(join(root, "skills", "work", "SKILL.md"), "utf8"), /reference\/ticket-assessment\.md/);
  });
  it("code-investigator is read-only: no Bash, so text from a source cannot run commands", () => {
    const fm = frontmatter(readFileSync(join(root, "agents", "code-investigator.md"), "utf8"));
    assert.doesNotMatch(fm.tools ?? "", /Bash/);
  });
  for (const file of agentFiles)
    it(`agents/${file} follows the rules`, () => checkDoc(join(root, "agents", file), file.replace(/\.md$/, ""), { maxLines: 250 }));
});
