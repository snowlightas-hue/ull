# Handoff — where the project stands and how to continue

Written for whoever continues the work: a person, or a Claude session on the owner's computer. Read `README.md` first, then this file.

## State (October 2026)

| Area | Status | Evidence / docs |
|---|---|---|
| Voice/text conversation → one question at a time → save → match → reasons | done | `docs/ARCHITECTURE.md`, `docs/CONTRACTS.md` |
| Rule-based Arabic understanding (Levantine + MSA) | done, measured | `docs/IMPROVEMENT-LOG.md` (cycles 1–11, held-out numbers) |
| Jev (TypeSafe) as optional resolver; honest status label | built; **not verified live** (sandbox network blocked it) | `docs/JEV.md` |
| Matching engine (hard/soft conditions, BigInt money, versions, no duplicate notes) | done | `docs/MATCHING.md` |
| Database: partitioned intents/matches, migrations 0001–0006, backup + restore test, advisor | done | `docs/DATABASE.md` |
| Server hardening, rate limits, health/metrics, app.sh/db.sh | done | `docs/OPERATIONS.md` |
| V2.1 location: GPS points, radius/nearest, live driver positions, rides | done | `docs/GEO.md` |
| V2.2 connections: chat, phone share, timed location share, block/report, recovery codes | done | `docs/CONNECTIONS.md` |
| V2.3 stores/catalog/bulk import/photos (EXIF stripped) | **in progress**: migration `0005_catalog.sql` + `src/catalog/*` exist; check `docs/CATALOG.md` and the latest commits | — |
| V2.4 share links (product/place/store/collection, expiry) | **not started**; migration number reserved: `0007_links` | `docs/FEATURES-V2.md` §3 |
| Browser-only edition (published Artifact, typing only) | out of date: has no chat, location or stores | `web-demo/` |
| Docker / local run on the owner's computer | done, tested | `docs/LOCAL-SETUP.md` |

Last verified test results:
- unit 212/212;
- server + flows + connections + geo-API integration 95/95;
- db/matching/geo 24/24;
- browser e2e 6/6 specs (scenarios 252 checks, a11y 43, connections 32, simulated voice).

Voice is tested only with a **mock** Web Speech API. A real-microphone check by a person is still open (`public/js/conversation/README.md` §7).

## How to verify quickly
```bash
cd ultra-link
npm install && npm start                     # or: docker compose up -d --build
npx tsc --noEmit -p tsconfig.json
node --test test/unit/*.test.ts
node --test --test-concurrency=1 test/integration/*.test.ts   # needs the local PostgreSQL from npm start
node test/e2e/run.ts                         # needs Chromium; set executablePath in test/e2e/app-lib.ts if not /opt/pw-browsers/chromium
node scripts/corpus-report.ts                # training corpus accuracy
node scripts/corpus-report.ts --holdout      # held-out: aggregate only, never read individual failures
```

## Next steps, in priority order
1. **Finish V2.3 stores**:
   - register `src/server/routes/catalog.ts` in `src/server/routes/index.ts`;
   - call `seedDemoStores` from `src/seed/seed.ts`;
   - wire the store info onto match cards;
   - run the catalog tests and e2e.
2. **V2.4 links** (`0007_links`): random unguessable ids, unlisted by default, and expiry 24 h / 7 d / 30 d / until stopped. Items that become unavailable show «غير متاح», and collections can nest up to depth 2. Public page with no login; contacting the owner goes through the normal consent flow.
3. **Browser edition parity**: in-memory versions of the new endpoints in `web-demo/local-api.ts`. Then rebuild (`node web-demo/build.ts`) and republish.
4. **Real checks a sandbox could not do**: speak to the app with a real microphone in Chrome; run Jev with the real key (`npm run ai:probe`) and compare rules vs Jev on the held-out set.
5. **Remaining review items** (`docs/REVIEW.md` → "Integrator response"):
   - drop `'unsafe-inline'` from the style CSP (m4);
   - add a rate limit on edits (m5).
6. **Understanding**: held-out conditions (≈49%) and attributes (≈57%) are the weakest. Improve only from training failures, and keep the held-out set unseen.

## Rules this project keeps
- **Secrets** live only in `ultra-link/.env` (git-ignored): `TYPESAFE_API_KEY`, `UL_RECOVERY_PEPPER`, DB URLs. Never log or commit them.
- **Synthetic data** is labeled «(تجريبي)» with `realm=synthetic`, and is never matched with real accounts. Do not invent users or metrics.
- **Migrations** are forward-only and checksummed. Never edit an applied one; schema ideas from tools/agents go to `migrations/proposed/` for review. A migration that adds an intents/matches partition pair must add the two leaf FKs (see 0006).
- **Matching** never widens a request by itself (suggestions only). Required conditions decide; preferences only rank. Money is compared only in the same currency and unit.
- **Measurements** are reported with the command that produced them; projections are labeled as projections.
