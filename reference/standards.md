# Fallback standards

Applied **only where the project has no pattern of its own** (design §11). The project's `CLAUDE.md`,
skills and existing code always win, and Hashsmith never restructures code to match these.
Adopted once from the starter-kit (2026-10-27) and adapted.

**Architecture**
- **One data path:** UI → state → service → data source. Only the service layer touches the data
  source (the Supabase client, the ORM, the HTTP client).
- **No lateral imports:** a store never imports another store, and a service never imports
  another service. Coordination happens in the UI layer, or in the backend's application layer.
- **Access by permission key, never by role name:** `hasPermission("users.manage")` in the UI and
  `has_permission('users.manage')` in SQL. Comparing a role string anywhere is a defect.
- **The server is the boundary.** UI checks change what renders; RLS or the backend guard decides
  what the caller can do. A UI-only gate is a bug.
- **No literals for anything tenant-specific or environment-specific:** product name, tenant
  name, URLs and keys come from config, the environment or the tenant record.
- **Deactivate users, never delete them.**

**Naming and conventions**
- **Files:** kebab-case, carrying the module name (`billing-service.ts`). A file named `utils.ts`
  or `helpers.ts` is drift.
- **Types:** `interface` for entities, `type` for unions and utilities. Props are `readonly`.
  Path alias `@/*`.
- **Dates:** one `formatDate()` helper and one display format, never inline formatting.
- **Shared primitives:** toasts, confirm dialogs, page containers and data tables are shared
  components. A hand-rolled confirm dialog or a page-level max-width is drift.
- **Permission keys:** `module.action`, declared once and seeded from there.
- **Environment variables:** validated at boot by a schema. The app fails loudly on a missing
  variable and never falls back to a literal.

**Database**
- **Names:** plural snake_case tables and snake_case columns. A junction table is named after both
  sides.
- **Keys:** `id uuid primary key default gen_random_uuid()`; composite keys on junction tables.
- **Timestamps:** `created_at` and `updated_at timestamptz not null default now()` with a shared
  `set_updated_at()` trigger. Append-only tables have `created_at` only.
- **Foreign keys:** every one has a deliberate `on delete` rule (`restrict` by default, `cascade`
  only for true children, `set null` for optional actors) and is indexed.
- **Indexes:** on foreign keys, on columns used in RLS predicates, and on columns the app filters
  or sorts on. No speculative indexes.
- **Nullability:** `not null` unless null means something, and the comment says what.
- **Enumerations:** `text` with a `check` constraint, never a Postgres `enum`.
- **Polymorphism and JSON:** no `entity_type`/`entity_id` pairs, and `jsonb` only for genuinely
  open-shaped data.
- **RLS:** on for every public table, no exceptions. Every `security definer` function has a
  comment saying why it needs it.
- **Migrations:** one per concern, named for what it does, append-only once merged.
- **New tables:** explicit grants in the same migration.

**Testing**
- **Location:** tests sit beside the source in `__tests__/`, one `describe` per unit.
- **Services:** tested with the data-source client mocked at the module boundary; assert the query
  shape and the mapping.
- **Stores:** tested through their public actions, with the service mocked.
- **Components:** rendered with providers that set the user and permissions. Assert on roles and
  text, never on class names.
- **Data:** factories with overrides; no shared mutable fixtures.
- **Isolation:** no network, no real timers, no snapshot tests.
- **Coverage:** at least 80% of the changed executable lines in logic layers. UI is exempt, and
  lines that existed before the change do not count.
- **Permissions:** RLS, RPC and permission changes run the permission matrix against the real
  local database, because RLS cannot be unit-tested.

**Verification**
- **The chain:** types, lint, format check, unit tests (run once), build, then the stack's DB or
  backend suite.
- **Evidence:** real output reported; a check that cannot run is reported as blocked.
