-- 0003_geo.sql — Ultra Link V2.1 "location & live tracking" (owner: location role; design: docs/FEATURES-V2.md §1, docs/GEO.md)
--
--  1. Extensions cube + earthdistance: ll_to_earth(lat, lng) → a point on a 3-D sphere; GiST on it answers
--     "within R km" (earth_box … @>) and "nearest first" (ORDER BY … <-> …) without scanning.
--     NOTE (measured on this cluster): cube is a TRUSTED extension (the database owner may create it), earthdistance is
--     NOT (pg_available_extension_versions.trusted = f; "Must be superuser to create this extension"). scripts/db.sh
--     provision installs both as superuser in ultralink, ultralink_test and ultralink_template, so the CREATE below is a
--     no-op there; elsewhere this migration fails with an explicit remedy instead of half-applying.
--  2. Partitions for vertical 8 (transport: transport.ride / transport.delivery), seeded but so far routed to the
--     DEFAULT partitions. Guard: if rows of vertical 8 already sit in intents_other / matches_other the migration stops
--     with a clear message (move them first, as 0002 §7 did for vertical 7) — it never moves user data silently.
--     Storage settings as 0002 §8 gave every other leaf partition.
--  3. intents: precise point (geo_lat/geo_lng/geo_accuracy_m/geo_source/geo_at), distance condition
--     (radius_km/radius_strength) and "nearest" — the persisted form of PlaceSpec.geo / radiusKm / nearest
--     (src/domain/types.ts). Shape CHECKs mirror src/domain/validate.ts. ADD COLUMN … DEFAULT false is metadata-only
--     (no table rewrite); the CHECKs scan existing rows once (all NULL).
--  4. intents_geo_knn_idx: GiST on ll_to_earth(geo_lat, geo_lng), active rows with a point only. Serves the GEO
--     retrieval direction (src/geo/retrieve.ts): KNN within the search radius.
--     intents_point_coarse_idx: the RANGE key of intents_point_idx restricted to active rows WITHOUT a precise point
--     (no fix, or a fix coarser than 3 km). Distance-bounded retrieval reads place-only counterparts at nearby places
--     through it; without it, every GPS-located row at those places (e.g. 100k drivers whose nearest city is إعزاز)
--     would be visited and filtered. Cost: one more B-tree entry per place-only active intent.
--  5. live_positions: one small, hot row per intent that is sharing its live position (provide / join only). Each ping
--     is an UPSERT here — the intent's version is NOT bumped and no re-match runs per ping. Filter columns are copied
--     from the intent (like intent_scopes) so KNN needs no join. expires_at = updated_at + 10 min ("connected" window);
--     rows of paused/closed intents are deleted by setIntentStatus, and by the FK cascade with the intent/user.
--
-- Locks: brief ACCESS EXCLUSIVE locks while columns/indexes are added (milliseconds on the app DB; for a large table
-- build the per-partition indexes CONCURRENTLY first and ATTACH them — docs/DATABASE.md "large-table playbook").
-- Rollback (forward-only runner; inverse statements):
--   DROP TABLE live_positions; DROP INDEX intents_point_coarse_idx, intents_geo_knn_idx;
--   ALTER TABLE intents DROP CONSTRAINT intents_geo_chk, DROP CONSTRAINT intents_radius_chk,
--     DROP COLUMN geo_lat, DROP COLUMN geo_lng, DROP COLUMN geo_accuracy_m, DROP COLUMN geo_source, DROP COLUMN geo_at,
--     DROP COLUMN radius_km, DROP COLUMN radius_strength, DROP COLUMN nearest;
--   (partitions: move vertical-8 rows to the DEFAULT partitions first, then DETACH/DROP intents_transport, matches_transport)
-- Tests: test/integration/geo-migration.test.ts (fresh DB, guard, constraints, plans), geo-*.test.ts.

SET LOCAL lock_timeout = '10s';

-- ───────────── 1. extensions ─────────────
CREATE EXTENSION IF NOT EXISTS cube;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'earthdistance') THEN
    BEGIN
      CREATE EXTENSION earthdistance;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION '0003_geo: extension earthdistance is missing and role % may not create it (earthdistance is not a trusted extension)', current_user
        USING HINT = 'As a superuser run: CREATE EXTENSION IF NOT EXISTS cube; CREATE EXTENSION IF NOT EXISTS earthdistance;  (or: bash scripts/db.sh provision) — then migrate again.';
    END;
  END IF;
END $$;

-- ───────────── 2. transport partitions (vertical 8) ─────────────
DO $$
DECLARE ni bigint; nm bigint;
BEGIN
  SELECT count(*) INTO ni FROM intents_other WHERE vertical_id = 8;
  SELECT count(*) INTO nm FROM matches_other WHERE vertical_id = 8;
  IF ni > 0 OR nm > 0 THEN
    RAISE EXCEPTION '0003_geo: % intents and % matches of vertical 8 (transport) already sit in the DEFAULT partitions', ni, nm
      USING HINT = 'Move them out first (copy with dependants, delete, re-insert after the partitions exist — the pattern of 0002 §7), or delete these synthetic/test rows; then migrate again.';
  END IF;
END $$;
CREATE TABLE intents_transport PARTITION OF intents FOR VALUES IN (8);
CREATE TABLE matches_transport PARTITION OF matches FOR VALUES IN (8);
ALTER TABLE intents_transport SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_insert_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE matches_transport SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_insert_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);

-- ───────────── 3. intents: precise point, radius, nearest ─────────────
ALTER TABLE intents
  ADD COLUMN geo_lat         double precision,
  ADD COLUMN geo_lng         double precision,
  ADD COLUMN geo_accuracy_m  integer,
  ADD COLUMN geo_source      text,
  ADD COLUMN geo_at          timestamptz,
  ADD COLUMN radius_km       numeric(6, 2),
  ADD COLUMN radius_strength text,
  ADD COLUMN nearest         boolean NOT NULL DEFAULT false;
ALTER TABLE intents ADD CONSTRAINT intents_geo_chk CHECK (
  (geo_lat IS NULL) = (geo_lng IS NULL)
  AND (geo_lat IS NULL OR (geo_lat BETWEEN -90 AND 90 AND geo_lng BETWEEN -180 AND 180 AND geo_source IS NOT NULL))
  AND (geo_lat IS NOT NULL OR (geo_accuracy_m IS NULL AND geo_source IS NULL AND geo_at IS NULL))
  AND (geo_source IS NULL OR geo_source IN ('gps', 'live', 'place'))
  AND (geo_accuracy_m IS NULL OR geo_accuracy_m BETWEEN 0 AND 100000));
ALTER TABLE intents ADD CONSTRAINT intents_radius_chk CHECK (
  (radius_km IS NULL) = (radius_strength IS NULL)
  AND (radius_km IS NULL OR (radius_km > 0 AND radius_km <= 500))
  AND (radius_strength IS NULL OR radius_strength IN ('required', 'preferred')));

-- ───────────── 4. indexes ─────────────
CREATE INDEX intents_geo_knn_idx ON intents USING gist (ll_to_earth(geo_lat, geo_lng))
  WHERE status = 'active' AND geo_lat IS NOT NULL;
CREATE INDEX intents_point_coarse_idx ON intents (realm, side, deal_type_id, category_id, point_lft)
  INCLUDE (created_at, user_id, id, vertical_id) WHERE status = 'active' AND (geo_lat IS NULL OR geo_accuracy_m > 3000);

-- ───────────── 5. live positions ─────────────
CREATE TABLE live_positions (
  vertical_id  smallint NOT NULL,
  intent_id    bigint NOT NULL,
  user_id      bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- copies of the intent's matching keys (kept in sync by src/geo/live.ts; the intent's own row is authoritative)
  realm        text NOT NULL CHECK (realm IN ('real', 'synthetic')),
  side         text NOT NULL CHECK (side IN ('provide', 'join')),
  deal_type_id smallint NOT NULL,
  category_id  integer NOT NULL,
  lat          double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng          double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  accuracy_m   integer CHECK (accuracy_m BETWEEN 0 AND 100000),
  heading      smallint CHECK (heading BETWEEN 0 AND 359),
  speed_kmh    smallint CHECK (speed_kmh BETWEEN 0 AND 400),
  started_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  PRIMARY KEY (vertical_id, intent_id),
  FOREIGN KEY (vertical_id, intent_id) REFERENCES intents (vertical_id, id) ON DELETE CASCADE,
  CHECK (expires_at > updated_at AND updated_at >= started_at)
);
CREATE INDEX live_positions_knn_idx ON live_positions USING gist (ll_to_earth(lat, lng));
CREATE INDEX live_positions_expiry_idx ON live_positions (expires_at);
CREATE INDEX live_positions_user_idx ON live_positions (user_id);
-- every ping rewrites the row: vacuum early, keep free space on the page
ALTER TABLE live_positions SET (fillfactor = 70, autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 200, autovacuum_analyze_scale_factor = 0.05);
