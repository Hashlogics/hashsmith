import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluate, isEnvFile } from "../env-guard.mjs";

const decision = event => evaluate(event)?.hookSpecificOutput.permissionDecision ?? null;
const bash = command => decision({ tool_name: "Bash", tool_input: { command } });

describe("env-guard", () => {
  it("knows env files from their templates", () => {
    for (const f of [".env", ".env.local", "/app/.env.production", "config/prod.env"]) assert.equal(isEnvFile(f), true, f);
    for (const f of [".env.example", ".env.local.example", ".env.sample", "env.ts", "src/environment.ts", ""]) assert.equal(isEnvFile(f), false, f);
  });

  it("denies reading or searching an env file", () => {
    assert.equal(decision({ tool_name: "Read", tool_input: { file_path: "/repo/.env" } }), "deny");
    assert.equal(decision({ tool_name: "Read", tool_input: { file_path: "/repo/.env.local" } }), "deny");
    assert.equal(decision({ tool_name: "Grep", tool_input: { pattern: "KEY", path: ".env" } }), "deny");
    assert.equal(decision({ tool_name: "Grep", tool_input: { pattern: "KEY", glob: ".env.production" } }), "deny");
    for (const c of ["cat .env", "grep SUPABASE .env.local", "source .env", "head -5 ./.env", "docker run --env-file .env x"]) assert.equal(bash(c), "deny", c);
  });

  it("allows the templates and ordinary files", () => {
    assert.equal(decision({ tool_name: "Read", tool_input: { file_path: "/repo/.env.example" } }), null);
    assert.equal(decision({ tool_name: "Read", tool_input: { file_path: "/repo/src/env.ts" } }), null);
    assert.equal(bash("cat .env.example"), null);
    assert.equal(bash("npm run dev"), null);
  });

  it("asks before anything that acts on a real environment", () => {
    for (const c of [
      "npx supabase db push",
      "supabase functions deploy mcp",
      "npx supabase secrets set KEY=1",
      "supabase link --project-ref abc",
      "npx prisma migrate deploy",
      "vercel --prod",
      "npx vercel deploy --prod",
      "bash scripts/tenant/50-create-admin.sh acme",
      "./scripts/ops/rotate.sh",
      "npm run tenant:provision",
      "alembic upgrade head",
    ])
      assert.equal(bash(c), "ask", c);
  });

  it("has no opinion on local-only commands", () => {
    for (const c of ["npx supabase start", "npx supabase db reset", "npx prisma migrate dev", "docker compose exec api alembic upgrade head", "vercel dev"])
      assert.equal(bash(c), null, c);
  });
});
