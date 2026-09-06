-- Row level security for the reply loop's tables, following the split-by-command
-- pattern settled for `sources` in migration 0003 and the v0.6 amendment to
-- ADR-009. The reasoning there applies unchanged: reads stay permissive when the
-- GUC is unset because ordinary reads deliberately do not open a transaction,
-- and are protected by the `tenant_id = $1` predicate the branded TenantId makes
-- a compile error to omit; writes require the GUC, so a write that escapes the
-- predicate fails in Postgres rather than succeeding quietly.
--
-- Two departures from the `sources` policy set, both deliberate.
--
-- First, `messages` and `question_log` get SELECT and INSERT policies only. They
-- are append-only by design: the Durable Object holds the live copy of a
-- conversation, so editing the archive would desynchronise the two, and the
-- question log is the evidence the escalation thresholds are tuned against,
-- which is worth nothing if it can be rewritten. With no UPDATE or DELETE policy,
-- Postgres denies those commands outright for app_user. Nothing in the reply
-- loop issues them. `TenantOffboard` in build step 8 deletes through the
-- ON DELETE CASCADE from `tenants` as the owner role, which RLS does not apply
-- to, so it is unaffected.
--
-- Second, the threshold columns get CHECK constraints. They are compared against
-- scores that are probabilities, so a value outside 0..1 is not a tuning choice
-- but a silently disabled gate: 1.5 escalates everything, -1 escalates nothing.
-- Cheaper to refuse the write than to explain the behaviour later.

ALTER TABLE "tenants"
  ADD CONSTRAINT "tenants_retrieval_threshold_range"
  CHECK ("retrieval_threshold" IS NULL OR ("retrieval_threshold" >= 0 AND "retrieval_threshold" <= 1));
--> statement-breakpoint

ALTER TABLE "tenants"
  ADD CONSTRAINT "tenants_confidence_threshold_range"
  CHECK ("confidence_threshold" IS NULL OR ("confidence_threshold" >= 0 AND "confidence_threshold" <= 1));
--> statement-breakpoint

ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "conversations_read" ON "conversations"
  FOR SELECT TO app_user
  USING (
    NULLIF(current_setting('app.tenant_id', true), '') IS NULL
    OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
--> statement-breakpoint

CREATE POLICY "conversations_insert" ON "conversations"
  FOR INSERT TO app_user
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

-- Conversations do change: open -> escalated -> closed.
CREATE POLICY "conversations_update" ON "conversations"
  FOR UPDATE TO app_user
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "messages_read" ON "messages"
  FOR SELECT TO app_user
  USING (
    NULLIF(current_setting('app.tenant_id', true), '') IS NULL
    OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
--> statement-breakpoint

CREATE POLICY "messages_insert" ON "messages"
  FOR INSERT TO app_user
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "question_log" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "question_log_read" ON "question_log"
  FOR SELECT TO app_user
  USING (
    NULLIF(current_setting('app.tenant_id', true), '') IS NULL
    OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
--> statement-breakpoint

CREATE POLICY "question_log_insert" ON "question_log"
  FOR INSERT TO app_user
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
