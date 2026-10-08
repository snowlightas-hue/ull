-- 0002_query_indexes_integrity_maintenance.sql — Ultra Link (Role 5, database)
--
-- Every change is motivated by a plan or a measurement on the 1,000,000-intent benchmark database
-- (bench/generate.ts → bench/run.ts, baseline = schema 0001 only) or by a concrete statement in src/**.
-- Before/after numbers: docs/DATABASE.md ("0002 — measured effect"); plans: bench/results/{baseline-0001,after-0002}.
-- Backward compatible: no column is added, removed or retyped; index names keep their meaning; no query changes.
-- Runs in ONE transaction (src/db/migrate.ts); lock_timeout makes it fail fast (and roll back) instead of queueing
-- behind the live app.
--
--  1. intents_point_idx → covering for the engine's RANGE / outside-count / null-point / BROAD statements
--     (src/matching/engine.ts#retrieveCandidates). Those statements filter on vertical_id and user_id and sort by
--     created_at, none of which was in the index, so every in-range row cost a heap visit (baseline plans:
--     "Index Scan … Filter: (user_id <> …) AND (vertical_id = …)"). Now INCLUDE (created_at, user_id, id,
--     vertical_id) → Index Only Scan. The old INCLUDE (price_lo, currency, price_unit) is dropped: no statement
--     reads them from this index (prices are evaluated in memory after the candidate fetch).
--     vertical_id must be stored: the planner keeps "vertical_id = $1" as a filter on the pruned partition.
--  2. intents_owner_idx → + INCLUDE (status). listIntents() and counts() filter on status for the exact total and
--     rangeStart counts; with status in the index those counts are index-only. Same key, same name.
--  3. notifications_unread_idx → (recipient_id, created_at DESC, id DESC) WHERE read_at IS NULL. Still serves the
--     unread badge count; now also the "unread only" page and its rangeStart count in index order.
--  4. Indexes for foreign keys whose referencing side had none. Every ON DELETE CASCADE / SET NULL from users,
--     intents, matches, conversations and conversation_messages seq-scanned the referencing table, per row.
--     Baseline (bench/results/baseline-0001): deleting one user with 11 intents p50 1.1 s, p95 2.0 s — the EXPLAIN shows
--     the time in "Trigger for constraint intent_refs_vertical_id_intent_id_fkey*" (a seq scan of ~1M intent_refs per
--     deleted intent) and match_refs_vertical_id_match_id_fkey*; POST /api/contact-requests/:id/respond hash-joined a
--     Seq Scan of all ~290k match_refs per response (p50 27.5 ms).
--       intent_refs  UNIQUE (vertical_id, intent_id)   one ref per intent — also a real invariant (createIntent)
--       match_refs   UNIQUE (vertical_id, match_id)    one ref per match  — also a real invariant (registerNewMatches)
--       intent_refs (user_id), contact_requests (requester_id), conversations (user_id),
--       extraction_runs (message_id), intents (conversation_id) WHERE conversation_id IS NOT NULL
--  5. CHECK constraints mirroring src/domain/validate.ts and the status machine of src/repo/intents.ts, so a bug or
--     a manual edit cannot store a row the matcher would misread (all rows of ultralink / ultralink_test / bench
--     satisfy them; ADD CONSTRAINT validates existing rows and aborts the migration otherwise):
--       intents_price_shape_chk  eq ⇒ lo = hi; lte ⇒ hi; gte ⇒ lo; between ⇒ lo and hi; approx ⇒ lo or hi;
--                                no op ⇒ no amount, currency, unit or strength
--       intents_when_shape_chk   when_range and when_strength together; range non-empty and bounded (from < to)
--       intents_closed_at_chk    closed_at set exactly for fulfilled / closed / expired (setIntentStatus does this)
--       intent_scopes_values_chk the denormalised side / realm copies use the same domains as intents
--       match_runs_counts_chk    non-negative counters and duration
--  6. categories UNIQUE (id, vertical_id) + intents FOREIGN KEY (category_id, vertical_id): an intent can no longer
--     sit in a partition that disagrees with its category's vertical (the matcher, which always filters by the
--     category's vertical, would silently never see it). Replaces the single-column FK; same cost per insert.
--     Consequence: syncReference() can no longer move a category that has intents to another vertical (it fails
--     loudly instead of orphaning those intents in the wrong partition).
--  7. Partitions intents_help / matches_help for vertical 7 ('help', seeded but routed to the DEFAULT partitions).
--     Rows already in the DEFAULT partitions for vertical 7 are moved together with their dependants
--     (intent_refs, intent_scopes, match_runs, matches, match_refs, contact_requests keep ids and public ids).
--  8. Autovacuum / storage settings (per leaf partition; a partitioned parent cannot hold them):
--       intents_*      insert-triggered vacuum at 5 % (default 20 %) keeps the visibility map fresh — the
--                      index-only scans of (1) and (2) depend on it; analyze at 2 % (status changes shift the
--                      active fraction that the partial indexes cover).
--       intent_scopes  rewritten on every edit / status change → vacuum and analyze at 2 %.
--       matches_*, notifications  update-heavy (upserts, read_at) → vacuum 5 %, insert-vacuum 5 %.
--       jobs           queue: each row is updated 2–3 times then retired → vacuum at 1 % + 500 rows.
--       sessions       last_seen_at is rewritten on EVERY authenticated request and is not indexed →
--                      fillfactor 70 keeps those updates HOT (no index writes); vacuum at 5 %.
--
-- Not done here: data retention is a batched job (src/db/retention.ts), not DDL; the GIN index on intents.attrs and
-- the GiST index on intents.when_range are unused by today's SQL but are left for the advisor to judge with
-- pg_stat_user_indexes evidence from real traffic; time-partitioning notifications would break the global
-- UNIQUE (recipient_id, dedupe_key) that makes duplicate notifications impossible.
-- Locks: brief ACCESS EXCLUSIVE locks while indexes are rebuilt (milliseconds on the app DB). On a large table, build
-- the per-partition indexes CONCURRENTLY first and ATTACH them (docs/DATABASE.md, "large-table playbook").
-- Rollback: forward-only; the inverse statements are listed in docs/DATABASE.md ("0002 rollback").
-- Tests: test/integration/db-migrations.test.ts (fresh DB, constraints, cascades, help move, index-only plans).

SET LOCAL lock_timeout = '10s';

-- ───────────── 1–3. query-shape indexes ─────────────
DROP INDEX intents_point_idx;
CREATE INDEX intents_point_idx ON intents (realm, side, deal_type_id, category_id, point_lft)
  INCLUDE (created_at, user_id, id, vertical_id) WHERE status = 'active';

DROP INDEX intents_owner_idx;
CREATE INDEX intents_owner_idx ON intents (user_id, side, created_at DESC, id DESC) INCLUDE (status);

DROP INDEX notifications_unread_idx;
CREATE INDEX notifications_unread_idx ON notifications (recipient_id, created_at DESC, id DESC) WHERE read_at IS NULL;

-- ───────────── 4. foreign-key supporting indexes ─────────────
ALTER TABLE intent_refs ADD CONSTRAINT intent_refs_intent_key UNIQUE (vertical_id, intent_id);
ALTER TABLE match_refs ADD CONSTRAINT match_refs_match_key UNIQUE (vertical_id, match_id);
CREATE INDEX intent_refs_user_idx ON intent_refs (user_id);
CREATE INDEX contact_requests_requester_idx ON contact_requests (requester_id);
CREATE INDEX conversations_user_idx ON conversations (user_id);
CREATE INDEX extraction_runs_message_idx ON extraction_runs (message_id);
CREATE INDEX intents_conversation_idx ON intents (conversation_id) WHERE conversation_id IS NOT NULL;

-- ───────────── 5. integrity checks ─────────────
ALTER TABLE intents ADD CONSTRAINT intents_price_shape_chk CHECK (
  CASE price_op
    WHEN 'eq'      THEN price_lo IS NOT NULL AND price_lo = price_hi
    WHEN 'lte'     THEN price_hi IS NOT NULL
    WHEN 'gte'     THEN price_lo IS NOT NULL
    WHEN 'between' THEN price_lo IS NOT NULL AND price_hi IS NOT NULL
    WHEN 'approx'  THEN price_lo IS NOT NULL OR price_hi IS NOT NULL
    ELSE price_lo IS NULL AND price_hi IS NULL AND currency IS NULL AND price_unit IS NULL AND price_strength IS NULL
  END);
ALTER TABLE intents ADD CONSTRAINT intents_when_shape_chk CHECK (
  (when_range IS NULL) = (when_strength IS NULL)
  AND (when_range IS NULL OR NOT (isempty(when_range) OR lower_inf(when_range) OR upper_inf(when_range))));
ALTER TABLE intents ADD CONSTRAINT intents_closed_at_chk CHECK (
  (status IN ('fulfilled', 'closed', 'expired')) = (closed_at IS NOT NULL));
ALTER TABLE intent_scopes ADD CONSTRAINT intent_scopes_values_chk CHECK (
  side IN ('seek', 'provide', 'join') AND realm IN ('real', 'synthetic'));
ALTER TABLE match_runs ADD CONSTRAINT match_runs_counts_chk CHECK (
  candidates >= 0 AND confirmed >= 0 AND possible >= 0 AND excluded >= 0 AND (duration_ms IS NULL OR duration_ms >= 0));

-- ───────────── 6. category ↔ vertical (partition key) consistency ─────────────
ALTER TABLE categories ADD CONSTRAINT categories_id_vertical_key UNIQUE (id, vertical_id);
ALTER TABLE intents ADD CONSTRAINT intents_category_vertical_fkey FOREIGN KEY (category_id, vertical_id) REFERENCES categories (id, vertical_id);
ALTER TABLE intents DROP CONSTRAINT intents_category_id_fkey;

-- ───────────── 7. partitions for vertical 7 (help), moving rows that already sit in the DEFAULT partitions ─────────────
-- A new partition cannot be created while the DEFAULT partition holds rows for its value, and those rows cannot be
-- moved in place (UPDATE of an unchanged key does not re-route). So: copy vertical-7 rows and every dependant into
-- transaction-local temp tables, delete them (FK cascades remove the dependants), create the partitions, re-insert
-- everything with the same ids / public ids. Order respects the foreign keys. No-op when there are no such rows.
CREATE TEMP TABLE ul_mv_intents ON COMMIT DROP AS SELECT * FROM intents_other WHERE vertical_id = 7;
CREATE TEMP TABLE ul_mv_intent_refs ON COMMIT DROP AS SELECT * FROM intent_refs WHERE vertical_id = 7;
CREATE TEMP TABLE ul_mv_intent_scopes ON COMMIT DROP AS SELECT * FROM intent_scopes WHERE vertical_id = 7;
CREATE TEMP TABLE ul_mv_match_runs ON COMMIT DROP AS SELECT * FROM match_runs WHERE vertical_id = 7;
CREATE TEMP TABLE ul_mv_matches ON COMMIT DROP AS SELECT * FROM matches_other WHERE vertical_id = 7;
CREATE TEMP TABLE ul_mv_match_refs ON COMMIT DROP AS SELECT * FROM match_refs WHERE vertical_id = 7;
CREATE TEMP TABLE ul_mv_contact_requests ON COMMIT DROP AS SELECT * FROM contact_requests WHERE vertical_id = 7;
DELETE FROM matches_other WHERE vertical_id = 7;  -- cascades: match_refs, contact_requests
DELETE FROM intents_other WHERE vertical_id = 7;  -- cascades: intent_refs, intent_scopes, match_runs (matches already gone)
CREATE TABLE intents_help PARTITION OF intents FOR VALUES IN (7);
CREATE TABLE matches_help PARTITION OF matches FOR VALUES IN (7);
INSERT INTO intents SELECT * FROM ul_mv_intents;
INSERT INTO intent_refs SELECT * FROM ul_mv_intent_refs;
INSERT INTO intent_scopes SELECT * FROM ul_mv_intent_scopes;
INSERT INTO match_runs OVERRIDING SYSTEM VALUE SELECT * FROM ul_mv_match_runs;
INSERT INTO matches SELECT * FROM ul_mv_matches;
INSERT INTO match_refs SELECT * FROM ul_mv_match_refs;
INSERT INTO contact_requests OVERRIDING SYSTEM VALUE SELECT * FROM ul_mv_contact_requests;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM intents_other WHERE vertical_id = 7) OR EXISTS (SELECT 1 FROM matches_other WHERE vertical_id = 7)
     OR (SELECT count(*) FROM intents_help) <> (SELECT count(*) FROM ul_mv_intents)
     OR (SELECT count(*) FROM matches_help) <> (SELECT count(*) FROM ul_mv_matches) THEN
    RAISE EXCEPTION 'vertical 7 move incomplete';
  END IF;
END $$;

-- ───────────── 8. autovacuum / storage settings ─────────────
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT relid FROM pg_partition_tree('intents') WHERE isleaf LOOP
    EXECUTE format('ALTER TABLE %s SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_insert_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02)', r.relid::regclass);
  END LOOP;
  FOR r IN SELECT relid FROM pg_partition_tree('matches') WHERE isleaf LOOP
    EXECUTE format('ALTER TABLE %s SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_insert_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05)', r.relid::regclass);
  END LOOP;
END $$;
ALTER TABLE intent_scopes SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02, autovacuum_vacuum_insert_scale_factor = 0.05);
ALTER TABLE notifications SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_insert_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);
ALTER TABLE jobs SET (autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_threshold = 500, autovacuum_analyze_scale_factor = 0.05);
ALTER TABLE sessions SET (fillfactor = 70, autovacuum_vacuum_scale_factor = 0.05);
