# Unfinished work (not active code)

These two patches contain work that was **stopped before it was finished or tested**, at the owner's request (handover
to run locally). They are kept so nothing is lost. Nothing in this folder is loaded, migrated, built or tested.

| Patch | What it contains | State when stopped |
|---|---|---|
| `v2.4-links.partial.patch` | Share links (V2.4): `migrations/0007_links.sql`, `src/links/*`, `src/server/routes/links.ts`, `public/link.html`, a worker hook, test helpers | Core code written; tests, UI hooks («مشاركة», «روابطي») and docs **not done**; never run |
| `browser-edition-parity.partial.patch` | Browser-only edition: in-memory chat/account/stores in `web-demo/*`, `test/e2e/web-demo.spec.ts` | Most endpoints written; the e2e spec was being written; **not built or run** |

To continue one of them (from the repository root `ull/`):
```bash
git apply ultra-link/wip/v2.4-links.partial.patch            # or browser-edition-parity.partial.patch
```
Then review every file it adds against `docs/FEATURES-V2.md` §3 / `docs/HANDOFF.md`, finish it, and make the tests pass
before running it. Do not apply `0007_links.sql` to a database you care about before it is tested.
