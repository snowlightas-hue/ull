// Server-side validation of an IntentSpec against the registry. Nothing reaches the database (and no
// model output is trusted) without passing this. Returns a list of Arabic-friendly error codes.

import { z } from 'zod';
import type { Registry } from './registry.ts';
import { attributesFor } from './registry.ts';
import type { IntentSpec } from './types.ts';

const MONEY = z.string().regex(/^\d{1,15}$/, 'money must be integer minor units');
const STRENGTH = z.enum(['required', 'preferred']);

export const IntentSpecSchema = z.object({
  side: z.enum(['seek', 'provide', 'join']),
  categoryCode: z.string().min(1).max(80),
  deal: z.enum(['sale', 'rent', 'service', 'lesson', 'activity', 'help']),
  place: z.object({
    pointPlaceId: z.number().int().nullable(),
    scopePlaceIds: z.array(z.number().int()).max(10),
    scopeStrength: STRENGTH,
    excludePlaceIds: z.array(z.number().int()).max(10).optional(),
    evidence: z.string().max(200).optional(),
    geo: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(100_000).optional(), source: z.enum(['gps', 'live', 'place']), at: z.string().max(40).optional() }).nullable().optional(),
    radiusKm: z.object({ value: z.number().positive().max(500), strength: STRENGTH }).nullable().optional(),
    nearest: z.boolean().optional(),
  }),
  price: z.object({
    op: z.enum(['eq', 'lte', 'gte', 'between', 'approx']),
    lo: MONEY.nullable(),
    hi: MONEY.nullable(),
    currency: z.enum(['USD', 'TRY', 'SYP', 'EUR']).nullable(),
    unit: z.enum(['total', 'month', 'year', 'week', 'day', 'hour', 'session', 'person']).nullable(),
    strength: STRENGTH,
    negotiable: z.boolean().optional(),
    evidence: z.string().max(300).optional(),
  }).nullable(),
  when: z.object({ from: z.iso.datetime(), to: z.iso.datetime(), strength: STRENGTH, label: z.string().max(60).optional(), evidence: z.string().max(100).optional() }).nullable(),
  attrs: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.union([z.number(), z.boolean(), z.string().max(60), z.array(z.string().max(60)).min(1).max(12)])),
  constraints: z.array(z.object({
    key: z.string().regex(/^[a-z][a-z0-9_]*$/),
    op: z.enum(['eq', 'neq', 'lte', 'gte', 'between', 'in']),
    value: z.union([z.number(), z.boolean(), z.string().max(60)]).optional(),
    values: z.array(z.union([z.number(), z.boolean(), z.string().max(60)])).max(20).optional(),
    lo: z.number().optional(),
    hi: z.number().optional(),
    strength: STRENGTH,
    weight: z.number().int().min(1).max(5).optional(),
    evidence: z.string().max(200).optional(),
  })).max(30),
  notes: z.string().max(500).optional(),
});

export interface ValidationIssue { path: string; code: string }

export function validateSpec(reg: Registry, input: unknown): { ok: true; spec: IntentSpec } | { ok: false; issues: ValidationIssue[] } {
  const parsed = IntentSpecSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), code: i.message })) };
  const spec = parsed.data as IntentSpec;
  const issues: ValidationIssue[] = [];
  const cat = reg.categoryByCode.get(spec.categoryCode);
  if (!cat) issues.push({ path: 'categoryCode', code: 'unknown_category' });
  else {
    if (!cat.deals.includes(spec.deal)) issues.push({ path: 'deal', code: 'deal_not_allowed_for_category' });
    if (cat.relation === 'peer' && spec.side !== 'join') issues.push({ path: 'side', code: 'peer_category_requires_join' });
    if (cat.relation === 'exchange' && spec.side === 'join') issues.push({ path: 'side', code: 'exchange_category_requires_seek_or_provide' });
  }
  const placeIds = [spec.place.pointPlaceId, ...spec.place.scopePlaceIds, ...(spec.place.excludePlaceIds ?? [])].filter((x): x is number => x !== null);
  for (const id of placeIds) if (!reg.placeById.has(id)) issues.push({ path: 'place', code: `unknown_place_${id}` });
  if (spec.price) {
    const p = spec.price;
    if (p.lo === null && p.hi === null) issues.push({ path: 'price', code: 'price_without_amount' });
    if (p.lo !== null && p.hi !== null && BigInt(p.lo) > BigInt(p.hi)) issues.push({ path: 'price', code: 'price_lo_gt_hi' });
    if (p.op === 'eq' && p.lo !== p.hi) issues.push({ path: 'price', code: 'eq_requires_lo_eq_hi' });
    if (p.op === 'lte' && p.hi === null) issues.push({ path: 'price', code: 'lte_requires_hi' });
    if (p.op === 'gte' && p.lo === null) issues.push({ path: 'price', code: 'gte_requires_lo' });
    if (p.op === 'between' && (p.lo === null || p.hi === null)) issues.push({ path: 'price', code: 'between_requires_both' });
  }
  if (spec.when && Date.parse(spec.when.from) >= Date.parse(spec.when.to)) issues.push({ path: 'when', code: 'when_empty_range' });
  if (cat) {
    const defs = new Map(attributesFor(reg, cat.code).map((a) => [a.key, a] as const));
    const checkValue = (path: string, key: string, v: unknown) => {
      const d = defs.get(key);
      if (!d) { issues.push({ path, code: `unknown_attribute_${key}` }); return; }
      if (d.type === 'int' && !(typeof v === 'number' && Number.isInteger(v) && (d.min === undefined || v >= d.min) && (d.max === undefined || v <= d.max))) issues.push({ path, code: `bad_int_${key}` });
      if (d.type === 'bool' && typeof v !== 'boolean') issues.push({ path, code: `bad_bool_${key}` });
      if (d.type === 'enum' && !(typeof v === 'string' && d.values?.some((x) => x.code === v))) issues.push({ path, code: `bad_enum_${key}` });
      if (d.type === 'text' && typeof v !== 'string') issues.push({ path, code: `bad_text_${key}` });
    };
    for (const [k, v] of Object.entries(spec.attrs)) {
      if (Array.isArray(v)) {
        if (defs.get(k)?.type !== 'enum') issues.push({ path: `attrs.${k}`, code: `multi_value_requires_enum_${k}` });
        else for (const x of v) checkValue(`attrs.${k}`, k, x);
      } else checkValue(`attrs.${k}`, k, v);
    }
    spec.constraints.forEach((c, i) => {
      if (c.value !== undefined) checkValue(`constraints.${i}`, c.key, c.value);
      for (const v of c.values ?? []) checkValue(`constraints.${i}`, c.key, v);
      if (c.op === 'between' && c.lo === undefined && c.hi === undefined) issues.push({ path: `constraints.${i}`, code: 'between_requires_bounds' });
      if (['eq', 'neq', 'lte', 'gte'].includes(c.op) && c.value === undefined) issues.push({ path: `constraints.${i}`, code: 'op_requires_value' });
      if (c.op === 'in' && !c.values?.length) issues.push({ path: `constraints.${i}`, code: 'in_requires_values' });
    });
  }
  return issues.length ? { ok: false, issues } : { ok: true, spec };
}
