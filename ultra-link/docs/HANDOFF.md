# Handoff — where the project stands and how to continue

Written for whoever continues the work: a person, or a Claude session on the owner's computer. Read `README.md` first,
then this file. Run it locally with `docs/LOCAL-SETUP.md`.

## State at handover (October 2026, commit after `3e3a3dc`)

| Area | Status | Docs |
|---|---|---|
| Voice/text conversation → one question at a time → save → match → reasons | done | `docs/ARCHITECTURE.md`, `docs/CONTRACTS.md` |
| Arabic understanding (Levantine + MSA, rule-based), measured on training + held-out corpora | done | `docs/IMPROVEMENT-LOG.md` (cycles 1–11) |
| Jev (TypeSafe) as optional resolver; honest status label | built; **not verified live** (the cloud sandbox blocked api.typesafe.ai) | `docs/JEV.md` |
| Matching (required vs preferred, BigInt money, versions, stale-job safety, notification coalescing) | done | `docs/MATCHING.md` |
| Database: partitioned intents/matches, migrations 0001–0006, backup + restore test, advisor | done | `docs/DATABASE.md` |
| Server hardening, rate limits, health/metrics, `scripts/app.sh` / `scripts/db.sh` | done | `docs/OPERATIONS.md` |
| V2.1 location: GPS points, radius / nearest, live driver positions, rides | done | `docs/GEO.md` |
| V2.2 connections: chat, phone share, timed location share, block/report, recovery codes | done | `docs/CONNECTIONS.md` |
| V2.3 stores: catalog, bulk import with preview, photos (metadata stripped), store badges/grouping | done | `docs/CATALOG.md` |
| Run on the owner's computer: Docker Compose + native scripts | done, tested in the sandbox | `docs/LOCAL-SETUP.md` |
| V2.4 share links (product/place/store/collection, expiry) | **unfinished**, saved as a patch, not active | `wip/README.md`, `docs/FEATURES-V2.md` §3 |
| Browser-only edition (published Artifact, typing only) | **out of date** (no chat/location/stores); update saved as an unfinished patch | `wip/README.md`, `web-demo/` |

Last verified results (all on this commit's code):

| Suite | Result |
|---|---|
| typecheck | 0 errors |
| unit | 212/212 |
| integration: server, flows, connections, catalog, geo, matching, db | all green |
| browser e2e (`node test/e2e/run.ts`) | 7/7 specs: UI preview 24, simulated voice 76, six README scenarios 252, accessibility 43, two-browser chat 32, stores 81, voice in the real app |
| Docker stack | migrations 0001–0006, demo seed, health ok, simulated-voice e2e passes, restart keeps data |

Not verified by anyone yet:
- a **human voice** through a real microphone (all voice tests use a mock Web Speech API; checklist in `public/js/conversation/README.md` §7);
- **Jev live**;
- running on the owner's own Windows/macOS machine.

## How to verify on a new machine
```bash
cd ultra-link
docker compose up -d --build            # app at http://localhost:8080   (or: npm install && npm start)
# for development and tests (needs Node 22.18+ and PostgreSQL 16 + contrib, i.e. the non-Docker path):
npm install && npm start
npx tsc --noEmit -p tsconfig.json
node --test test/unit/*.test.ts
node --test --test-concurrency=1 test/integration/*.test.ts
node test/e2e/run.ts                    # needs Chromium; adjust executablePath in test/e2e/app-lib.ts and specs if not /opt/pw-browsers/chromium
node scripts/corpus-report.ts           # training accuracy; add --holdout for the held-out set (aggregate only)
```

## Next steps, in priority order
1. **Owner checks first**: run it locally, speak to it in Chrome with a real microphone, and try `TYPESAFE_API_KEY` in `.env` (`npm run ai:probe`). Fix what that reveals.
2. **V2.4 links**: `git apply ultra-link/wip/v2.4-links.partial.patch`, review against `docs/FEATURES-V2.md` §3, then finish.
   - Remaining work: tests, the «مشاركة» / «روابطي» UI, docs, and registering the plugin in `src/server/routes/index.ts`.
   - Rules: random unguessable ids, unlisted by default, expiry 24 h / 7 d / 30 d / until stopped, «غير متاح» items, nested collections up to depth 2, no phone/precise location/identity on the public page.
3. **Browser edition**: apply `wip/browser-edition-parity.partial.patch`, finish `test/e2e/web-demo.spec.ts`, then `node web-demo/build.ts` and republish.
4. **Review leftovers** (`docs/REVIEW.md` → "Integrator response"): drop style `'unsafe-inline'` from the CSP (m4) and rate-limit edits (m5).
5. **Understanding**: the held-out set is weakest on conditions (≈49%) and attributes (≈57%). Improve only from training failures, and keep the held-out set unseen.

## Rules this project keeps
- **Secrets** live only in `ultra-link/.env`, which is git-ignored and never in Docker images: `TYPESAFE_API_KEY`, `UL_RECOVERY_PEPPER`, DB URLs. Never log or commit them.
- **Synthetic data** is labeled «(تجريبي)» with `realm=synthetic`, and is never matched with real accounts. Do not invent users or metrics.
- **Migrations** are forward-only and checksummed. Never edit an applied one; schema ideas go to `migrations/proposed/` for review. A migration that adds an intents/matches partition pair must add the two leaf FKs (see 0006).
- **Matching** never widens a request by itself (suggestions only). Required conditions decide; preferences only rank. Money is compared only in the same currency and unit.
- **Measurements** come with the command that produced them; projections are labeled as such.
- Prefer one feature per change, with its tests, before moving to the next.

---

## Prompt to give the agent (copy as is)

```
أنت تتابع تطوير مشروع «ألترا لينك — Ultra Link» الموجود في هذا المجلد (المستودع ull، المشروع داخل ultra-link).
اقرأ أولًا وبالترتيب: ultra-link/README.md ثم ultra-link/docs/HANDOFF.md ثم ultra-link/docs/LOCAL-SETUP.md،
وارجع عند الحاجة إلى docs/ARCHITECTURE.md وdocs/CONTRACTS.md وdocs/PRODUCT.md وdocs/FEATURES-V2.md.

ما هو جاهز: الطلب بالصوت أو الكتابة مع سؤال واحد عند النقص، المطابقة بالأسباب، الموقع وأقرب سيارة، المحادثة بين
الطرفين مع مشاركة الرقم والموقع لمدة محددة واسترجاع الحساب، المتاجر مع إضافة المنتجات دفعة واحدة والصور، والتشغيل
المحلي عبر Docker. ما لم يكتمل: الروابط القابلة للمشاركة (V2.4) وتحديث نسخة المتصفح؛ عملهما الناقص محفوظ في
ultra-link/wip/ كملفات patch غير مفعّلة (اقرأ ultra-link/wip/README.md).

ابدأ بهذا بالترتيب ولا تنتقل لخطوة قبل أن تنجح سابقتها:
1) شغّل المشروع (docker compose up -d --build أو npm install && npm start) وتأكد أن http://localhost:8080 يعمل،
   ثم شغّل: npx tsc --noEmit -p tsconfig.json، واختبارات الوحدات والتكامل، وأبلغني بالنتائج الفعلية.
2) ساعدني أجرّب الصوت بميكروفون حقيقي في Chrome ومفتاح Jev من ملف .env (npm run ai:probe)، وأصلح ما يظهر.
3) أكمل الروابط (V2.4) انطلاقًا من ultra-link/wip/v2.4-links.partial.patch مع اختباراتها وواجهتها وتوثيقها.
4) ثم حدّث نسخة المتصفح من ultra-link/wip/browser-edition-parity.partial.patch.

القواعد: لا تضع الأسرار في الكود أو السجلات (فقط في .env)؛ البيانات التجريبية تبقى معلّمة «(تجريبي)» ولا تُخلط
بالحقيقية؛ لا تخترع مستخدمين أو أرقامًا — كل رقم أذكره يكون من أمر شغّلته فعلًا؛ الترحيلات للأمام فقط ولا تعدّل
ترحيلًا مطبّقًا؛ المطابقة لا توسّع الطلب من تلقاء نفسها؛ لا تفعّل مدفوعات أو خدمات مدفوعة. بعد كل خطوة: شغّل
الاختبارات، حدّث docs/HANDOFF.md وdocs/IMPROVEMENT-LOG.md، واحفظ التغييرات في git برسالة واضحة.
```
