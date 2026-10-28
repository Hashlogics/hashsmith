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
  it("code-investigator is read-only: no Bash, so text from a source cannot run commands", () => {
    const fm = frontmatter(readFileSync(join(root, "agents", "code-investigator.md"), "utf8"));
    assert.doesNotMatch(fm.tools ?? "", /Bash/);
  });
  for (const file of agentFiles)
    it(`agents/${file} follows the rules`, () => checkDoc(join(root, "agents", file), file.replace(/\.md$/, ""), { maxLines: 250 }));
});
