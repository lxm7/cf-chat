-- `deleting` is a tombstone: the row that says a source exists is also the row
-- that says it is on its way out, so a delete is one committed write here and
-- the index item and the R2 object are cleaned up afterwards. See ADR-013.
--
-- This migration adds the value and nothing else, deliberately. Postgres allows
-- ALTER TYPE ... ADD VALUE inside a transaction but forbids using the new value
-- in that same transaction, and drizzle-kit wraps each migration file in one, so
-- any statement referencing 'deleting' has to wait for a later file.
ALTER TYPE "public"."source_status" ADD VALUE 'deleting';
