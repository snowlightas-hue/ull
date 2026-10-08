-- 0006: per-partition ("leaf") foreign keys from matches to intents instead of the partitioned-parent FKs.
-- Proposed and measured by Role 5 (database); adopted by the integrator after 0003 (transport partitions) landed.
--
-- why (measured, bench/exp-leaf-fk.ts → bench/results/exp-leaf-fk.json, 1M intents, schema 0001–0003, 30 dense seekers,
--   every run a FIRST evaluation inside a rolled-back savepoint, same samples in each variant):
--     matchIntent() p50 1,972 ms / p95 7,390 ms with the parent FKs (second pass 1,824 / 6,869)
--                   p50   744 ms / p95 2,821 ms with leaf FKs                      → −62 % p50, −62 % p95
--   Every RI check of an FK that references a PARTITIONED table goes through the parent (≈ 0.14 ms per row); against a
--   plain table it costs ≈ 0.007 ms. matches and intents share the partition key (vertical_id), so each matches partition
--   can reference its own intents partition directly with identical meaning.
-- RULE FOR LATER MIGRATIONS: a migration that creates a new intents/matches partition pair must add the two leaf FKs
--   (<matches partition>_a_intent_fkey / _b_intent_fkey) itself; test/integration/db-migrations.test.ts fails otherwise.
-- cost: VALIDATE scans each matches partition once (SHARE UPDATE EXCLUSIVE; writes continue). Cascades are unchanged.
-- rollback: drop the leaf constraints (names *_a_intent_fkey / *_b_intent_fkey) and re-add
--   ALTER TABLE matches ADD FOREIGN KEY (vertical_id, a_intent_id) REFERENCES intents (vertical_id, id) ON DELETE CASCADE; (same for b).

SET LOCAL lock_timeout = '10s';

ALTER TABLE matches DROP CONSTRAINT matches_vertical_id_a_intent_id_fkey;
ALTER TABLE matches DROP CONSTRAINT matches_vertical_id_b_intent_id_fkey;

DO $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN
    SELECT m.relid::regclass AS m, i.relid::regclass AS i, mc.relname AS mname
      FROM pg_partition_tree('matches') m
      JOIN pg_class mc ON mc.oid = m.relid
      LEFT JOIN pg_partition_tree('intents') i
        ON i.isleaf AND pg_get_expr((SELECT relpartbound FROM pg_class WHERE oid = i.relid), i.relid)
                      = pg_get_expr(mc.relpartbound, m.relid)
     WHERE m.isleaf
  LOOP
    IF r.i IS NULL THEN
      RAISE EXCEPTION 'matches partition % has no intents partition with the same bound', r.m;
    END IF;
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (vertical_id, a_intent_id) REFERENCES %s (vertical_id, id) ON DELETE CASCADE NOT VALID',
                   r.m, r.mname || '_a_intent_fkey', r.i);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (vertical_id, b_intent_id) REFERENCES %s (vertical_id, id) ON DELETE CASCADE NOT VALID',
                   r.m, r.mname || '_b_intent_fkey', r.i);
    EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', r.m, r.mname || '_a_intent_fkey');
    EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', r.m, r.mname || '_b_intent_fkey');
    n := n + 1;
  END LOOP;
  IF n = 0 THEN RAISE EXCEPTION 'no matches partitions found'; END IF;
END $$;
