# Ultra Link — Database (PostgreSQL 16)

> **ملخص:** كل رقم في قسم «MEASURED» قيس فعلًا على هذا الجهاز (الأوامر والملفات مذكورة)، وكل ما في قسم «PROJECTED»
> تقدير غير مُختبر. لا ندّعي دعم مليارات المستخدمين. أعلى ما قيس: مليون نيّة (1,000,000) على جهاز واحد بأربع أنوية.

Owner: Role 5. Schema design rationale: `docs/ARCHITECTURE.md` §3; schema: `migrations/0001_core.sql`, `0002_*.sql`
(this role), `0003_geo.sql` (location role). Tools: `src/db/*`, `scripts/backup.sh`, `scripts/restore-test.sh`, `bench/*`,
`src/advisor/*`.

## 1. Migrations

* `node src/db/migrate.ts [--test] [--upto NNNN]` (`npm run db:migrate`). Files `migrations/NNNN_name.sql` run in order,
  **each in one transaction** under `pg_advisory_xact_lock(4242001)`, recorded in `schema_migrations` with a sha256
  checksum. A changed checksum of an applied file stops the runner (applied files are immutable — add a new one).
  `--upto` applies pending files only up to that version (used to put 0002 on the app DB without 0003).
* `migrations/proposed/` is **never** read by the runner (advisor and human drafts live there).
* Numbers 0003–0006 are reserved for the V2 features (`docs/FEATURES-V2.md` §5).

Safe procedure used for the app DB (all steps were run on 2026-10-08, outputs in the hand-off report):
1. `bash scripts/backup.sh` → `bash scripts/restore-test.sh --keep-db`
2. `DATABASE_URL=…/ultralink_restore_check node src/db/migrate.ts --upto 0002` (rehearsal on the restored copy), drop it
3. `node src/db/migrate.ts --upto 0002` on `ultralink` (applied in 97 ms; demo kept serving: `/api/health` before and after; intents,
   matches and notifications endpoints returned 200 after it) → backup + restore-test again (manifest: 0001,0002).

### 1.1 What 0002 changes (and why)

| # | Change | Evidence |
|---|---|---|
| 1 | `intents_point_idx` INCLUDE `(created_at, user_id, id, vertical_id)` (drops unused `price_lo, currency, price_unit`) | RANGE/BROAD/outside-count/null-point statements become Index Only Scans (0 heap fetches); paired A/B below |
| 2 | `intents_owner_idx` + INCLUDE `(status)` | owner counts index-only: heaviest owner (6,031 intents) count 15.0 ms/5,533 buffers → 1.9 ms/97 buffers. Typical owners: **no measurable change** (A/B p50 8.77 vs 8.48 ms) |
| 3 | `notifications_unread_idx` → `(recipient_id, created_at DESC, id DESC) WHERE read_at IS NULL` | serves the unread badge, the unread-only page and its rangeStart count in index order |
| 4 | FK-supporting indexes: `intent_refs UNIQUE (vertical_id, intent_id)`, `match_refs UNIQUE (vertical_id, match_id)`, `intent_refs(user_id)`, `contact_requests(requester_id)`, `conversations(user_id)`, `extraction_runs(message_id)`, `intents(conversation_id) WHERE NOT NULL` | user delete p50 811 ms → 3.2 ms; contact respond p50 72 ms → 0.57 ms (A/B). The advisor finds exactly this set on a 0001 database (integration test) |
| 5 | CHECKs mirroring `validate.ts` and the status machine: price shape, when shape, `closed_at` ⇔ terminal status, `intent_scopes` domains, non-negative `match_runs` counters | malformed rows are rejected at the source (test: one rejection per rule) |
| 6 | `categories UNIQUE (id, vertical_id)` + `intents FK (category_id, vertical_id)` | an intent can no longer sit in a partition that disagrees with its category (the matcher would never see it). Side effect: `syncReference()` cannot move a category that has intents to another vertical — it fails loudly |
| 7 | Partitions `intents_help` / `matches_help` (vertical 7); existing vertical-7 rows are **moved** with refs, scopes, runs, matches, match refs and contact requests (same ids) | test inserts vertical-7 rows on a 0001 DB, migrates, compares every row |
| 8 | Autovacuum per leaf partition (insert-vacuum 5 % for intents: index-only scans need a fresh visibility map), `intent_scopes` 2 %, `jobs` 1 %+500, `sessions` fillfactor 70 (HOT updates of `last_seen_at` on every request) | settings verified by test; effect not separately benchmarked |

Cost (measured, 1M intents): intents indexes 202 → 217 MB; `intents_point_idx` 29.5 → 36.3 MB; `intents_owner_idx`
62.0 → 73.8 MB; `notifications_unread_idx` 4.7 → 13.5 MB; new `intent_refs` indexes +44 MB; bulk generation of
intents+refs+scopes 9,262 → 7,337 rows/s (more indexes and checks). Interactive `createIntent()` throughput: 275 vs 265
per second sequential (unchanged within noise).

**0002 rollback** (manual, one transaction, then `DELETE FROM schema_migrations WHERE version = '0002'`):
```sql
DROP INDEX intents_point_idx;  CREATE INDEX intents_point_idx ON intents (realm, side, deal_type_id, category_id, point_lft) INCLUDE (price_lo, currency, price_unit) WHERE status = 'active';
DROP INDEX intents_owner_idx;  CREATE INDEX intents_owner_idx ON intents (user_id, side, created_at DESC, id DESC);
DROP INDEX notifications_unread_idx; CREATE INDEX notifications_unread_idx ON notifications (recipient_id) WHERE read_at IS NULL;
ALTER TABLE intent_refs DROP CONSTRAINT intent_refs_intent_key;  ALTER TABLE match_refs DROP CONSTRAINT match_refs_match_key;
DROP INDEX intent_refs_user_idx, contact_requests_requester_idx, conversations_user_idx, extraction_runs_message_idx, intents_conversation_idx;
ALTER TABLE intents DROP CONSTRAINT intents_price_shape_chk, DROP CONSTRAINT intents_when_shape_chk, DROP CONSTRAINT intents_closed_at_chk;
ALTER TABLE intent_scopes DROP CONSTRAINT intent_scopes_values_chk;  ALTER TABLE match_runs DROP CONSTRAINT match_runs_counts_chk;
ALTER TABLE intents ADD CONSTRAINT intents_category_id_fkey FOREIGN KEY (category_id) REFERENCES categories (id);
ALTER TABLE intents DROP CONSTRAINT intents_category_vertical_fkey;  ALTER TABLE categories DROP CONSTRAINT categories_id_vertical_key;
-- keep intents_help/matches_help (harmless); storage settings: ALTER TABLE … RESET (autovacuum_…, fillfactor)
```
If 0003 is applied, roll it back first (its header lists the inverse statements).

**Large-table playbook** (not needed at today's size): build new per-partition indexes with `CREATE INDEX CONCURRENTLY`
outside the runner, then `CREATE INDEX … ON ONLY parent` + `ALTER INDEX … ATTACH PARTITION` in the migration; add FKs and
CHECKs `NOT VALID` and `VALIDATE` them separately (SHARE UPDATE EXCLUSIVE lock, writes continue).

## 2. Backup and restore test (MEASURED on the app DB)

`bash scripts/backup.sh [--keep N] [--dir DIR]` (`npm run db:backup`, default keep 7):
* `pg_dump -Fc --compress=6` from **one exported snapshot**: a psql coprocess holds a `REPEATABLE READ READ ONLY`
  transaction, `pg_dump --snapshot` dumps it, and the manifest is computed in the same snapshot — so the counts match the
  dump exactly while the app keeps writing. Read-only; credentials go through libpq env vars, never argv.
* Manifest `backups/ultralink-<UTC stamp>.json`: `schema_migrations` (version, name, checksum), **exact** `count(*)`
  of every table and partition, sha256 and size of the dump, server/pg_dump versions, dump duration.
* Keeps the newest N dump+manifest pairs (verified with `--keep 2`: third run removed the oldest).

`bash scripts/restore-test.sh [dump] [--keep-db]` (`npm run db:restore-test`): sha256 check → restore into
`ultralink_restore_check` (cloned from `ultralink_template`, extension TOC entries filtered, `--single-transaction
--exit-on-error`) → compares migrations and every table's exact count with the manifest → sample join
intents→matches→match_refs→intent_refs (100 rows) → orphan and unvalidated-FK checks → drops the database.

Measured 2026-10-08 (app DB after 0002: 3,293 rows, 37 tables): dump 192 ms, 339 KiB; restore 890 ms; all checks OK.
Logical dumps only: **no point-in-time recovery yet** (RPO = time since the last dump). PROJECTED next step: WAL archiving +
`pg_basebackup`, restore-test run nightly against the newest dump.

## 3. Retention (`src/db/retention.ts`)

`node src/db/retention.ts --db app [--dry-run] [--batch 10000]`, daily off-peak. Never touches intents, matches or users.
Read notifications > 90 d and any notification > 180 d; done/superseded jobs > 7 d, failed > 30 d; sessions expired > 1 d;
`match_runs` > 30 d except each intent's newest run (the API shows it); `extraction_runs` > 180 d (advisor window).
Deletes walk primary-key windows (one short statement per window, no long transaction). A deleted notification frees its
`(recipient, dedupe_key)`: the same event more than 90/180 days later may notify again (intended). Test:
`test/integration/db-retention.test.ts`.

## 4. Benchmark (MEASURED)

**Machine:** 4 vCPU Intel Xeon @ 2.80 GHz (`nproc` = 4), 16 GB RAM (`free -h`: 15 Gi total, ~13 Gi available, no swap),
PostgreSQL 16.15, shared_buffers 512 MB, work_mem 16 MB, effective_cache_size 4 GB, random_page_cost 1.1, Node 22.22.
Warm cache (the data set fits in RAM); latencies are wall-clock from the Node client over localhost TCP.

**Data** — `node bench/generate.ts [--migrations-upto 0001]` into `ultralink_bench` (never the app DB), seed 20261008,
120 days of history: **1,000,000 intents** (455k active; 60 % offers, 35 % requests, 5 % activities), 166,667 users
(0.1 % "dealers" own up to 6,031 intents), 472k scope keys, ~290k matches, ~775k notifications, ~2.9k contact requests.
Skew: 16.5 % of intents in Aleppo city, 10.5 % Azaz, 7.5 % Idlib, 6 % Gaziantep, then a long tail; prices in
USD/TRY/SYP/EUR × total/month/year/day/hour/session/person. Build time: 183 s (schema 0001) / 215 s (0001+0002).

**Method** — `node bench/run.ts --label <l>`: ≥ 200 measured samples per shape after 20 warm-up samples (25 for user
delete); the real engine/repo functions (`retrieveCandidates`, `matchIntent`, `listIntents`, `listMatches`,
`listNotifications`, `createIntent`) are called, and every SQL statement they issue is EXPLAINed. Results:
`bench/results/{baseline-0001,after-0002}/results.json` + `explain-*.txt`.

### 4.1 Two independent runs (baseline = schema 0001, after = 0001+0002), ms

| shape | samples | 0001 p50 / p95 / p99 | 0002 p50 / p95 / p99 |
|---|---:|---|---|
| RANGE retrieval (required scope) | 200 | 16.7 / 84.0 / 115.0 | 10.5 / 43.9 / 53.0 |
| PROBE retrieval (scope keys) | 200 | 3.19 / 8.46 / 19.7 | 2.98 / 8.02 / 15.2 |
| BROAD retrieval (no point, no scope) | 200 | 20.4 / 77.2 / 103.5 | 9.01 / 27.1 / 35.7 |
| full `matchIntent()` (first evaluation, writes) | 200 | 960 / 2,953 / 3,726 | 1,008 / 3,013 / 3,473 |
| owner list page (20 cards, exact totals) | 200 | 6.98 / 12.4 / 13.6 | 9.39 / 15.6 / 21.3 |
| match list page (20 cards, hydrated) | 200 | 7.36 / 10.4 / 11.8 | 6.55 / 9.99 / 12.9 |
| notifications page | 200 | 1.42 / 2.11 / 2.59 | 1.03 / 1.70 / 2.21 |
| contact respond (rolled back) | 200 | 27.5 / 49.1 / 58.7 | 0.44 / 0.78 / 1.12 |
| user delete with cascades (rolled back) | 25 | 1,093 / 2,004 / 2,080 | 3.81 / 8.31 / 11.0 |
| `createIntent()` sequential | 2,000 | 275/s; 3.15 / 7.64 / 10.1 | 265/s; 3.52 / 5.63 / 8.68 |
| `createIntent()` 4 connections | 2,000 | 488/s; 7.53 / 14.6 / 19.2 | 892/s; 4.25 / 6.92 / 9.58 |

The two runs draw **different random samples** (physical row order differs between builds), so differences that 0002
cannot explain are run-to-run variance, not effects: owner list p50 (A/B in 4.2 shows no change) and the 4-connection
insert rate (488 vs 892/s — 0002 only adds index work to inserts; checkpoints/autovacuum during the run are the likely
cause; not investigated further). Hence the paired A/B in 4.2.

### 4.2 0002 — measured effect: paired A/B on identical data and samples (`node bench/ab-0002.ts`)

`bench/results/ab-0002.json`. Same database (0001+0002), same 200 samples (md5-ordered); variant 0001 = the 0002 indexes dropped and the 0001
definitions recreated **inside a transaction that is rolled back** (`indcheckxmin` verified false, plans in
`bench/results/ab-0002-range-plans.txt`).

| shape | 0001 p50 | 0002 p50 | 0001 p95 | 0002 p95 | 0001 p99 | 0002 p99 |
|---|---:|---:|---:|---:|---:|---:|
| RANGE retrieval | 17.9 | 11.6 | 93.1 | 57.7 | 129.8 | 73.4 |
| BROAD retrieval | 26.0 | 12.4 | 98.0 | 39.7 | 110.6 | 52.3 |
| owner list | 8.77 | 8.48 | 14.17 | 14.23 | 15.49 | 16.7 |
| contact respond | 72.0 | 0.57 | 119.5 | 0.78 | 139.8 | 1.13 |
| user delete (25) | 811 | 3.23 | 2,679 | 7.05 | 2,756 | 10.3 |

### 4.3 Plans

* **No Seq Scan on any `intents_*`, `intent_scopes` or `matches_*` relation** in 813 RANGE, 200 PROBE, 251 BROAD and
  12 in-transaction `matchIntentTx` statement plans (automatic check over every sampled statement; same result at 0001).
* RANGE before: `Index Scan … Filter: (user_id <> …) AND (vertical_id = …)` — a heap visit per in-range row. After:
  `Index Only Scan … Heap Fetches: 0`. The planner keeps `vertical_id = $1` as a filter on the pruned partition, so
  `vertical_id` must be stored in the index.
* Baseline user delete: almost all time in `Trigger for constraint intent_refs_vertical_id_intent_id_fkey*` (a seq scan
  of ~1M `intent_refs` per deleted intent); contact respond hash-joined a Seq Scan of all ~290k `match_refs`.
* Full `matchIntent()` is dominated by **writing** pairs, not by retrieval: a first evaluation persists up to thousands
  of pairs (p50 ~2,400 candidates; 35 % of runs hit `UL_CANDIDATE_LIMIT` = 5,000). In one 2,708-pair upsert, 778 ms went
  to the two FK checks `matches → intents`, because an FK that references a **partitioned** table costs ≈ 0.14 ms per row
  vs ≈ 0.007 ms for a plain table (`notifications → users` in the same run).

### 4.4 Measured but not applied: leaf foreign keys (`node bench/exp-leaf-fk.ts`)

Replacing the two parent-level FKs `matches → intents` by per-partition FKs (`matches_<v> → intents_<v>`, same meaning
because both tables are partitioned by `vertical_id`), on 30 dense seekers, same samples, every run a first evaluation
in a rolled-back savepoint: `matchIntent()` p50 **1,972 → 744 ms**, p95 **7,390 → 2,821 ms** (parent again: 1,824 /
6,869). Draft: `migrations/proposed/role5_leaf_fk_matches_intents.sql` (tested on a fresh DB by
`db-migrations.test.ts`). Not in 0002 because every future partition pair (0003 already creates
`intents_transport`/`matches_transport`) must then add its own leaf FKs — a cross-team convention to agree on first.

## 5. Schema advisor (`npm run advisor -- --db app|test|bench`)

Reads evidence and **proposes**; it never executes DDL. Collection runs in one `READ ONLY` transaction that is rolled
back (the server rejects any write), and every statement passes a SELECT/WITH-only guard. Rules (`src/advisor/rules.ts`):

| evidence | proposal | draft? |
|---|---|---|
| `unknown_terms` (≥ 3 hits) | lexicon: add keyword to the category (seed file) / map-or-ignore unmapped term | no (data, not schema) |
| `extraction_runs` (≥ 20 turns / 30 d) | lexicon: slots Jev decides in ≥ 20 % of turns; unclear rate ≥ 25 %; category: no-category rate, overlapping categories | no |
| `match_runs` (≥ 20 runs) | partition: candidate cap hit ≥ 5 %; index: p95 ≥ 250 ms; category: ≥ 50 % zero-candidate runs | no (design decision) |
| rows in DEFAULT partitions | partition: own partitions for the vertical | **yes** — move procedure generated from the live FK graph: every ON DELETE CASCADE dependant is copied and re-inserted parents-first (by `vertical_id`, or through its FK into the parent's copied rows — today 12 tables incl. 0003 `live_positions` and 0004 `connections` + children); other FKs into moved rows become guards that stop the draft |
| `pg_constraint` + `pg_index` | index for a FK whose referenced rows are deleted (CASCADE/SET NULL, or deletes seen) | **yes** |
| `pg_stat_user_indexes` (≥ 7 d of statistics) | drop a never-scanned, non-unique index ≥ 1 MB | **yes**, with the exact recreate statement |
| `pg_stat_statements` (≥ 20 calls, mean ≥ 50 ms) / `pg_stat_user_tables` | index: investigate slow statement / repeated full scans | no |

Output: one `schema_proposals` row per `dedupe_key` (re-runs update evidence of open proposals; approved/rejected rows
are never modified) and DRAFT files `migrations/proposed/<kind>_<slug>_<hash>.sql` (same finding → same file).
`--dry-run` writes nothing. On the app DB today: **0 proposals** (no unknown terms, 33 turns, statistics only 1.8 h old
so the unused-index rule is skipped, 6 NO ACTION FKs to never-deleted reference data listed in a note). On the bench DB
it reports the dense verticals (candidate cap hit in 16–67 % of runs), slow pair upserts and two indexes never used by the
benchmark (`intents_attrs_idx`, `intents_point_coarse_idx`) — the latter only because `--min-stats-days 0` was forced.
Tests: `test/unit/advisor-*.test.ts`, `test/integration/db-advisor.test.ts` (dedupe, decided rows untouched, schema
fingerprint unchanged, a generated partition draft applied by the test moves rows correctly, 0001 DB → exactly the
0002 FK indexes).

## 6. PROJECTED (not measured)

* Retrieval cost follows the number of candidates inside the scope, not the table size (range scans on a covering
  index, equality probes on scope keys). At 1M intents RANGE p95 is 44 ms. A 10M-intent data set with the same skew
  would put ~10× more counterparts in the dense cities; retrieval is already capped at 5,000 candidates and 35 % of runs
  are truncated at 1M, so the binding limit becomes **density**, not index depth: sub-partitioning dense verticals by
  region (the advisor's `partition:dense:*` proposals) and capping persisted pairs per run (Role 6) come first.
* Storage grows roughly linearly: ~524 MB for intents + indexes, ~352 MB notifications, ~228 MB matches per 1M intents
  here → a few GB per 10M (estimate, not measured).
* Beyond one node (plan only): `vertical_id` is already the co-location key of intents, matches and scope keys; a
  vertical × region shard key, read replicas for list pages, WAL-based backups and archiving closed intents would be
  needed. None of this is implemented or tested; no claim is made beyond the 1M-intent measurements above.

## 7. Reproduce

```bash
node bench/generate.ts --migrations-upto 0001 --parallel 4 && node bench/run.ts --label baseline-0001
node bench/generate.ts --parallel 4 && node bench/run.ts --label after-0002 && node bench/ab-0002.ts
node bench/exp-leaf-fk.ts            # needs the bench DB at the current schema
node --test test/unit/advisor-*.test.ts test/integration/db-*.test.ts
bash scripts/db.sh psql -d postgres -c "DROP DATABASE ultralink_bench"   # ~2.7 GB after all runs
```
