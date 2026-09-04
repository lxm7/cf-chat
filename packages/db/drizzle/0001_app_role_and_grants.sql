-- Least-privilege application role.
--
-- The Worker connects through Hyperdrive as `app_user`, never as the migration
-- owner. This matters for row level security: RLS policies do not apply to a
-- table's owner, so an app that connects as the owner has RLS in name only.
--
-- The password is deliberately NOT set here. Migrations are committed; the
-- credential is not. Set it once, out of band:
--   ALTER ROLE app_user WITH LOGIN PASSWORD '<secret>';
-- then build the Hyperdrive config from a connection string using that role.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO app_user;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
--> statement-breakpoint

-- Applies to tables created later by the same owner, which is always the role
-- that runs these migrations.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
--> statement-breakpoint

-- Row level security is NOT enabled on tenants, users or memberships.
--
-- Those three are the identity directory, not tenant-owned data: every access
-- path is keyed by user id or by slug (the tenant picker deliberately spans
-- every tenant a user belongs to, and signup checks slug availability before
-- any tenant context exists). A policy of
-- `tenant_id = current_setting('app.tenant_id')` would return zero rows on all
-- of those paths and break signup and the picker.
--
-- RLS lands with the first tenant-owned table (conversations, build step 4),
-- where the tenant is genuinely the isolation boundary. The pattern and the
-- reason the SQL predicate comes first are in
-- docs/decisions/009-tenant-isolation-under-hyperdrive-caching.md.
