#!/usr/bin/env node
// Every hashsmith.json key, in one table (HSM-30). check-config takes its key names and allowed
// values from here, config-help prints it, and hashsmith.schema.json is generated from it
// (`npm run schema`); tests fail when any of them drifts. A new key gets a row here and its
// description in reference/config.md, in the same change. Run directly, it prints the schema.
import { isMain, REPO_NAME } from "../hooks/lib.mjs";

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const BOTH = ["repository", "workspace"];
const REPO = ["repository"];
const LISTS = [
  ["todo", "To Do"],
  ["in_progress", "In Progress"],
  ["review", "Review"],
  ["qa", "QA"],
  ["done", "Done"],
];

/** One row per key, in the order config-help shows them.
 *  - values: the allowed values (an array) or what a value looks like (a phrase).
 *  - empty: "" is accepted and means unset.
 *  - default: what applies when unset; null when it is looked up or asked instead (`unset` says which).
 *  - essential: every skill needs it (version and hashops); with `required`, missing means onboard
 *    again. Not reference/config.md's "core", which covers every key above `learned`.
 *  - required: must be present whenever its section is.
 *  - scope: team (hashsmith.json), or personal (~/.hashsmith/settings.json may override the team's).
 *  - files: the hashsmith.json files that may hold it (a repository's, a workspace root's).
 *  - names: for a `<name>` segment, the pattern each name follows.
 *  - schema: its JSON Schema, when `values` is a phrase. */
export const CONFIG_KEYS = [
  { key: "version", values: [1], default: null, unset: "written at onboarding", essential: true, required: true, scope: "team", files: BOTH, about: "Config shape version; Hashsmith migrates older shapes on read." },
  { key: "hashops.project_id", values: "a UUID", default: null, unset: "looked up: the HashOps project linked to this repository, else your pick", essential: true, required: true, scope: "team", files: BOTH, about: "The HashOps project this repository's tickets live in.", schema: { type: "string", pattern: `^${UUID}$` } },
  { key: "hashops.project_key", values: "upper-case letters and digits", default: null, unset: "looked up with the project", essential: true, required: true, scope: "team", files: BOTH, about: "The task-code prefix (ACME-12); the scope hook checks every task code against it.", schema: { type: "string", pattern: "^[A-Z0-9]+$" } },
  { key: "hashops.board_id", values: "a UUID", default: null, unset: "looked up: the project's one active board, else asked", essential: true, required: true, scope: "team", files: BOTH, about: "The board Hashsmith reads and moves tickets on.", schema: { type: "string", pattern: `^${UUID}$` } },
  ...LISTS.map(([k, name]) => ({
    key: `hashops.lists.${k}`,
    values: 'a UUID, or ""',
    empty: true,
    default: null,
    unset: `looked up on the board by name (${name})`,
    essential: true,
    required: true,
    scope: "team",
    files: BOTH,
    about: `The board's ${name} list.`,
    schema: { type: "string", pattern: `^$|^${UUID}$` },
  })),
  { key: "hashops.ai_tag", values: "a tag name", default: null, unset: "written at onboarding: hashsmith", essential: true, required: true, scope: "team", files: BOTH, about: "The tag on every ticket Hashsmith works; sync and qa follow only tagged tickets.", schema: { type: "string", pattern: "\\S" } },
  { key: "repo.base_branch", values: "a branch name", default: null, unset: "looked up: the PR target in the project's CLAUDE.md, else origin/HEAD", required: true, scope: "team", files: REPO, about: "What ai/* branches are cut from and PRs target.", schema: { type: "string", pattern: "\\S" } },
  { key: "repo.branch_policy", values: ["managed", "current", "confirm"], empty: true, default: "managed", scope: "team", files: REPO, about: "How work and qa pick a branch: a new ai/* branch, the checked-out one, or ask before each switch." },
  { key: "qa.base_url", values: "http://localhost:<port> or http://127.0.0.1:<port>", empty: true, default: null, unset: "looked up from the dev script, else asked", required: true, scope: "team", files: REPO, about: "The local app QA and design screenshots open; never a hosted one.", schema: { type: "string", pattern: "^$|^https?://(localhost|127\\.0\\.0\\.1)(:\\d+)?(/\\S*)?$" } },
  { key: "qa.mode", values: ["browser", "code"], empty: true, default: null, unset: "asked when qa starts", scope: "team", files: REPO, about: "How qa verifies: in the browser, or by code and tests for a project with no web UI." },
  { key: "sonar.project_key", values: "a SonarQube project key", empty: true, default: null, unset: "looked up from sonar-project.properties, else hashlogics_<repo>", required: true, scope: "team", files: REPO, about: "The Sonar project self-review reads issues from, when Sonar tools are present.", schema: { type: "string" } },
  { key: "sentry.project", values: "a Sentry project", empty: true, default: null, unset: "looked up from the Sentry tools, when the session has them", required: true, scope: "team", files: REPO, about: "The Sentry project for issue details.", schema: { type: "string" } },
  { key: "changelog.mode", values: ["write", "commits", "off"], default: null, unset: "detected by the CLI's changelog, else asked once", required: true, scope: "team", files: REPO, about: "How the changelog is kept: Hashsmith writes entries, a tool builds it from commits, or off." },
  { key: "changelog.path", values: "a .md file at the repository root", default: null, unset: "detected with the mode", required: true, scope: "team", files: REPO, about: "The changelog file Hashsmith writes entries to in write mode.", schema: { type: "string", pattern: "^[^/\\\\]+\\.[mM][dD]$" } },
  {
    key: "intake.processed_meetings",
    values: '[{id, on: YYYY-MM-DD, tickets: ["KEY-12"], note?}]',
    default: [],
    scope: "team",
    files: BOTH,
    about: "Meetings intake already turned into tickets, so none is processed twice.",
    schema: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "on", "tickets"],
        properties: {
          id: { type: "string" },
          on: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          tickets: { type: "array", items: { type: "string", pattern: "^[A-Z0-9]+-\\d+$" } },
          note: { type: "string" },
        },
      },
    },
  },
  { key: "preferences.questions", values: ["normal", "detailed"], empty: true, default: "normal", scope: "personal", files: BOTH, about: "How much Hashsmith asks: normal takes recommended answers and lists them under Assumed; detailed asks every question batch." },
  { key: "repositories.<name>.path", values: "a relative folder inside the workspace", names: REPO_NAME, default: null, unset: "written when the workspace is onboarded", required: true, scope: "team", files: ["workspace"], about: "Each repository of the workspace and its folder; its settings live in its own hashsmith.json.", schema: { type: "string", minLength: 1 } },
  {
    key: "learned.<name>",
    values: "{value, why, source, added: YYYY-MM-DD}",
    names: /^[a-z][a-z0-9_]*$/,
    default: null,
    unset: "added by Hashsmith under reference/config.md's rules",
    scope: "team",
    files: BOTH,
    about: "Project facts Hashsmith saved so it need not ask again, each with why and how to look it up again.",
    schema: {
      type: "object",
      required: ["value", "why", "source", "added"],
      properties: { why: { type: "string" }, source: { type: "string" }, added: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } },
    },
  },
];

// Objects check-config rejects unknown keys in ("" is the file itself).
const CLOSED = new Set(["", "hashops.lists", "preferences", "repositories.<name>"]);

const leafSchema = r => ({
  description: r.about,
  ...(r.schema ?? { enum: r.empty ? [...r.values, ""] : r.values }),
  ...(r.default !== null ? { default: r.default } : {}),
});

/** hashsmith.json's JSON Schema, from the table: one schema for a repository's file and a
 *  workspace root's (check-config tells them apart). */
export function configSchema() {
  const root = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "hashsmith.json",
    description: "Hashsmith's per-project config. Generated from scripts/config-keys.mjs (npm run schema); the CLI's check-config is the full check.",
    type: "object",
    properties: {},
  };
  const node = { "": root };
  for (const r of CONFIG_KEYS) {
    const parts = r.key.split(".");
    parts.forEach((part, i) => {
      const parentPath = parts.slice(0, i).join(".");
      const path = parts.slice(0, i + 1).join(".");
      const parent = node[parentPath];
      const last = i === parts.length - 1;
      const child = node[path] ?? (last ? leafSchema(r) : { type: "object", properties: {} });
      node[path] = child;
      if (part === "<name>") {
        parent.propertyNames = { pattern: r.names.source };
        parent.additionalProperties = child;
      } else {
        parent.properties ??= {};
        parent.properties[part] = child;
      }
      // Required within its section; at the top only the essential sections are.
      const needed = r.required && part !== "<name>" && (i > 0 || r.essential);
      if (needed && !(parent.required ??= []).includes(part)) parent.required.push(part);
    });
  }
  for (const path of CLOSED) node[path].additionalProperties = false;
  return root;
}

if (isMain(import.meta.url)) process.stdout.write(`${JSON.stringify(configSchema(), null, 2)}\n`);
