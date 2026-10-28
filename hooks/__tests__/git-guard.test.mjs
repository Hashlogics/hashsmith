import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluate } from "../git-guard.mjs";

const bash = command => evaluate({ tool_name: "Bash", tool_input: { command } });
const decision = command => bash(command)?.hookSpecificOutput.permissionDecision ?? null;

describe("git-guard", () => {
  it("denies every git write, however it is wrapped", () => {
    for (const c of [
      "git add .",
      "git commit -m 'wip'",
      "git push origin dev",
      "git pull",
      "git stash",
      "git stash pop",
      "git reset --hard HEAD~1",
      "git restore src/a.ts",
      "git checkout main",
      "git merge dev",
      "git rebase dev",
      "git cherry-pick abc123",
      "git revert abc123",
      "git rm a.ts",
      "git mv a.ts b.ts",
      "git clean -fd",
      "git tag v1.0.0",
      "git branch -D old",
      "git branch new-feature",
      "git update-index --assume-unchanged a",
      "git apply --cached x.patch",
      "git config user.name Bot",
      "git worktree add ../x",
      "git -C ../other commit -m x",
      "git -c user.name=x commit -m y",
      "cd src && git add -A",
      "npm test; git commit -m done",
      "FOO=1 git commit -m x",
      'bash -c "git commit -m hi"',
      "sh -c 'git push'",
      "echo $(git stash)",
      "sudo git reset --hard",
      "/usr/bin/git commit -m x",
      "git someAlias",
    ])
      assert.equal(decision(c), "deny", c);
  });

  it("denies git switch except to an ai/* branch", () => {
    for (const c of ["git switch main", "git switch -c feature/login", "git switch -C ai/HOPS-1-x", "git switch -f ai/HOPS-1-x", "git switch -"])
      assert.equal(decision(c), "deny", c);
  });

  it("asks before creating or switching to an ai/* branch", () => {
    for (const c of ["git switch -c ai/HOPS-12-login-redirect", "git switch ai/HOPS-12-login-redirect", "git switch --create ai/HOPS-12-HOPS-15-audience dev"])
      assert.equal(decision(c), "ask", c);
    assert.match(bash("git switch -c ai/HOPS-12-x").hookSpecificOutput.permissionDecisionReason, /^Hashsmith: .*clean/);
  });

  it("has no opinion on read-only git and on anything that only mentions git", () => {
    for (const c of [
      "git status",
      "git status --short",
      "git diff --stat",
      "git log --oneline -5",
      "git show HEAD",
      "git blame src/a.ts",
      "git fetch origin",
      "git rev-parse --show-toplevel",
      "git branch",
      "git branch -a",
      "git branch --show-current",
      "git branch --contains abc123",
      "git branch --list 'ai/*'",
      "git tag",
      "git tag -l 'v*'",
      "git stash list",
      "git config --get user.name",
      "git remote -v",
      "git remote get-url origin",
      "git worktree list",
      "git -C ../other status",
      "git --no-pager log -1",
      'grep -rn "git push" docs/',
      'echo "git commit"',
      "npm test",
      "gh pr list --head ai/HOPS-1-x --state all",
    ])
      assert.equal(decision(c), null, c);
  });

  it("ignores other tools", () => {
    assert.equal(evaluate({ tool_name: "Read", tool_input: { file_path: "git commit" } }), null);
  });
});
