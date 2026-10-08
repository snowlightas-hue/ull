// Measures the deterministic parser + conversation engine against the labeled corpus (written by the
// product role, independently of the parser). Usage: node scripts/corpus-report.ts [--fails N] [--json out.json]
import { normalizeAr } from '../src/nlu/arabic.ts';
import { writeFileSync } from 'node:fs';
import { seedRegistry } from '../src/domain/registry.ts';
import { parseUtterance } from '../src/nlu/parse.ts';
import { applyTurn, emptyDraft, nextQuestion, recordAsked, type ConversationDraft } from '../src/conversation/engine.ts';
import type { Question } from '../src/domain/types.ts';
import { readFileSync } from 'node:fs';
import trainUtterances from '../test/corpus/utterances.json' with { type: 'json' };
import dialogues from '../test/corpus/dialogues.json' with { type: 'json' };

// --holdout: measure on the held-out set. Individual failures are never printed for it, so it stays
// an honest measure of generalization (fix only from the training set, then re-measure here).
const HOLDOUT = process.argv.includes('--holdout');
const utterances = HOLDOUT ? JSON.parse(readFileSync(new URL('../test/corpus/holdout-utterances.json', import.meta.url), 'utf8')) : trainUtterances;

const reg = seedRegistry();
const now = new Date('2026-10-08T10:00:00Z');
const args = process.argv.slice(2);
const showFails = HOLDOUT ? 0 : Number(args[args.indexOf('--fails') + 1]) || (args.includes('--fails') ? 15 : 0);

type Field = 'side' | 'category' | 'deal' | 'places' | 'placeStrength' | 'negation' | 'price' | 'when' | 'attrs' | 'constraints' | 'mustAsk';
const stats: Record<Field, { ok: number; n: number; fails: string[] }> = {} as any;
const rec = (f: Field, ok: boolean, why: string) => { stats[f] ??= { ok: 0, n: 0, fails: [] }; stats[f].n++; if (ok) stats[f].ok++; else stats[f].fails.push(why); };
const eqJ = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

for (const u of utterances as any[]) {
  const e = u.expected;
  const r = parseUtterance(reg, u.text, { now });
  const tag = `${u.id} «${u.text}»`;
  // side: corpus null = genuinely ambiguous; a non-explicit guess counts as "unknown"
  const side = r.side && (r.side.explicit || r.side.confidence >= 0.8) ? r.side.value : null;
  rec('side', side === e.side, `${tag} side got=${side} want=${e.side}`);
  const cat = r.categories[0]?.value ?? null;
  rec('category', cat === e.category, `${tag} category got=${cat} want=${e.category}`);
  const deal = r.deal && (r.deal.explicit || r.deal.confidence >= 0.8) ? r.deal.value : null;
  const catDeals = e.category ? reg.categoryByCode.get(e.category)?.deals ?? [] : [];
  const dealGot = deal ?? (catDeals.length === 1 && cat === e.category ? catDeals[0] : null);
  rec('deal', dealGot === e.deal, `${tag} deal got=${dealGot} want=${e.deal}`);
  const gotPlaces = r.places.map((p) => reg.placeById.get(p.placeId)!.code).sort();
  const wantPlaces = (e.places ?? []).map((p: any) => p.code).sort();
  rec('places', eqJ(gotPlaces, wantPlaces), `${tag} places got=${gotPlaces} want=${wantPlaces}`);
  for (const wp of e.places ?? []) {
    const gp = r.places.find((p) => reg.placeById.get(p.placeId)!.code === wp.code);
    if (!gp) continue;
    if (wp.strength !== null || gp.strength !== null) rec('placeStrength', gp.strength === wp.strength, `${tag} ${wp.code} strength got=${gp.strength} want=${wp.strength}`);
    if (wp.negated || gp.negated) rec('negation', gp.negated === wp.negated, `${tag} ${wp.code} negated got=${gp.negated} want=${wp.negated}`);
  }
  const p0 = r.prices[0] ?? null;
  const wantP = e.price;
  if (wantP || p0) {
    const got = p0 ? { op: p0.op, lo: p0.lo, hi: p0.hi, currency: p0.currency, unit: p0.unit } : null;
    // provider asking price without operator = eq; corpus uses eq for asking prices
    if (got && got.op === null && e.side === 'provide') got.op = 'eq';
    if (got && got.op === null && e.side !== 'provide' && wantP?.op === 'lte') { got.op = 'lte'; got.lo = null; }
    const want = wantP ? { op: wantP.op, lo: wantP.lo, hi: wantP.hi, currency: wantP.currency, unit: wantP.unit } : null;
    rec('price', eqJ(got, want), `${tag} price got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  }
  if (e.when || r.when) {
    const wd = r.when ? new Date(Date.parse(r.when.from) + 3 * 3600_000).getUTCDay() : null;
    const names = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    let ok = false;
    if (e.when?.weekday) ok = wd !== null && names[wd] === e.when.weekday;
    else if (e.when?.relative) ok = !!r.when && ({ today: 'اليوم', tomorrow: 'بكرا', next_week: 'الأسبوع الجاي' } as any)[e.when.relative] === r.when.label;
    else ok = false;
    rec('when', ok, `${tag} when got=${r.when?.label ?? null} want=${JSON.stringify(e.when)}`);
  }
  // free-text values (car models) compare in normalized form: «أكسنت» = «اكسنت»
  const normV = (v: unknown) => (typeof v === 'string' ? normalizeAr(v) : v);
  const wantAttrs = Object.fromEntries(Object.entries(e.attrs ?? {}).map(([k, v]) => [k, normV(v)]));
  const gotAttrs = Object.fromEntries(Object.entries(r.attrs).map(([k, v]) => [k, normV(v.value)]));
  if (Object.keys(wantAttrs).length || Object.keys(gotAttrs).length) rec('attrs', eqJ(sortObj(gotAttrs), sortObj(wantAttrs)), `${tag} attrs got=${JSON.stringify(gotAttrs)} want=${JSON.stringify(wantAttrs)}`);
  const norm = (cs: any[]) => cs.map((c) => `${c.key}:${c.op}:${JSON.stringify(c.value ?? c.values ?? [c.lo, c.hi])}:${c.strength ?? null}`).sort();
  // the corpus labels the user's explicit cue (null = no cue), so compare raw mention strengths
  const rawCons = r.constraints.map((c) => ({ ...c, strength: r.attrMentions.find((m) => m.key === c.key)?.strength ?? null }));
  if ((e.constraints ?? []).length || rawCons.length) rec('constraints', eqJ(norm(rawCons), norm(e.constraints ?? [])), `${tag} constraints got=${norm(rawCons)} want=${norm(e.constraints ?? [])}`);
  // first question the engine would ask vs the corpus' essential fields
  const out = applyTurn(reg, emptyDraft(), { text: u.text, answering: null, now });
  const first = out.next.kind === 'ask' ? String(out.next.question.field) : null;
  const must: string[] = e.mustAsk ?? [];
  const okAsk = must.length === 0 ? first === null || out.next.kind !== 'ask' : first !== null && must.includes(first);
  rec('mustAsk', okAsk, `${tag} firstAsk=${first} mustAsk=${must}`);
}

// dialogues: question sequence + "never ask an answered field twice"
let dOk = 0, dN = 0, repeats = 0;
const dFails: string[] = [];
for (const d of dialogues as any[]) {
  let draft: ConversationDraft = emptyDraft();
  let q: Question | null = null;
  const asked: string[] = [];
  let ok = true;
  const trace: string[] = [];
  for (const t of d.turns) {
    const out = applyTurn(reg, draft, { text: t.user, answering: q, now });
    draft = out.draft;
    const got = out.next.kind === 'ask' ? String(out.next.question.field) : null;
    if (out.next.kind === 'ask') { q = out.next.question; recordAsked(draft, q); } else q = null;
    trace.push(`«${t.user}»→${got}`);
    if (got !== t.expectAsk) ok = false;
    if (got && got !== 'conflict' && asked.includes(got) && draft.resolved.includes(got)) repeats++;
    if (got) asked.push(got);
  }
  dN++; if (ok) dOk++; else dFails.push(`${d.id} [${d.tags}] ${trace.join(' | ')} want=${d.turns.map((t: any) => t.expectAsk).join(',')}`);
}
void nextQuestion;

console.log(`\nField accuracy on the ${HOLDOUT ? 'HELD-OUT' : 'training'} corpus (${utterances.length} utterances; rules engine, no Jev):`);
console.log('field'.padEnd(14), 'accuracy'.padStart(9), '  n');
for (const [f, s] of Object.entries(stats)) console.log(f.padEnd(14), `${((100 * s.ok) / s.n).toFixed(1)}%`.padStart(9), ` ${s.ok}/${s.n}`);
console.log(`dialogues     ${((100 * dOk) / dN).toFixed(1)}%   ${dOk}/${dN}   repeated-question violations: ${repeats}`);
if (showFails) {
  for (const [f, s] of Object.entries(stats)) if (s.fails.length) { console.log(`\n── ${f} failures (${s.fails.length}):`); for (const x of s.fails.slice(0, showFails)) console.log('  ', x); }
  console.log(`\n── dialogue failures (${dFails.length}):`); for (const x of dFails.slice(0, showFails)) console.log('  ', x);
}
const ji = args.indexOf('--json');
if (ji >= 0) writeFileSync(args[ji + 1]!, JSON.stringify({ stats: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { ok: v.ok, n: v.n }])), dialogues: { ok: dOk, n: dN, repeats } }, null, 2));

function sortObj(o: Record<string, unknown>) { return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, Array.isArray(v) ? [...v].sort() : v])); }
