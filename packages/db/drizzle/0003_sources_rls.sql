-- Row level security on the first genuinely tenant-owned table.
--
-- ADR-009 settled the strategy (tenant predicate in the SQL, RLS as defence in
-- depth, set_config only inside transactions we were opening anyway) but left
-- the DDL open, because a naive policy breaks the app: if `app.tenant_id` is
-- never set on ordinary reads, `USING (tenant_id = current_setting(...))`
-- evaluates against NULL and returns zero rows for every read, correct ones
-- included.
--
-- Settled here by splitting the policy by command.
--
-- Reads are permissive when the GUC is unset, because ordinary reads
-- deliberately do not open a transaction: Hyperdrive pools in transaction mode
-- and holding one pins a connection. Those reads are protected by the
-- `tenant_id = $1` predicate that the branded TenantId makes a compile error to
-- omit. Inside `withTenant` the policy does constrain them.
--
-- Writes get no such escape. Every write path runs inside `withTenant`, so a
-- write that somehow escapes the predicate fails loudly in Postgres rather than
-- relying on a code reviewer to catch it. The cost is that a single-statement
-- write now opens a transaction: roughly two extra round trips and brief
-- connection pinning. That is the price of the policy having teeth.
--
-- NULLIF guards the cast: current_setting returns '' rather than NULL in some
-- paths, and ''::uuid throws rather than returning no rows.
--
-- Policies are granted TO app_user specifically. RLS never applies to a table's
-- owner, which is the migration role, so the owner keeps full access for
-- migrations and backfills.

ALTER TABLE "sources" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "sources_read" ON "sources"
  FOR SELECT TO app_user
  USING (
    NULLIF(current_setting('app.tenant_id', true), '') IS NULL
    OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
--> statement-breakpoint

CREATE POLICY "sources_insert" ON "sources"
  FOR INSERT TO app_user
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

CREATE POLICY "sources_update" ON "sources"
  FOR UPDATE TO app_user
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

CREATE POLICY "sources_delete" ON "sources"
  FOR DELETE TO app_user
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
