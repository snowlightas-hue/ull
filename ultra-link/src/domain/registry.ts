// In-memory registry of taxonomy + places + attributes + vocabulary.
// Built from the same row shapes whether they come from the seed file (tests) or PostgreSQL (runtime).

import { normalizeAr } from '../nlu/arabic.ts';
import type { AttrSeed, CategorySeed, DealSeed, PlaceSeed, VerticalSeed } from '../seed/taxonomy.ts';
import { ATTRIBUTES, CATEGORIES, DEALS, PLACES, VERTICALS } from '../seed/taxonomy.ts';
import type { DealCode } from './types.ts';

export interface Category extends CategorySeed {
  verticalId: number;
  verticalCode: string;
  depth: number;
  ancestors: number[]; // ids, self first, root last
  descendants: number[]; // ids incl. self
  relation: 'exchange' | 'peer';
}

export interface Place extends PlaceSeed {
  depth: number;
  lft: number; // nested-set interval (with gaps) — "place interval code"
  rgt: number;
  ancestors: number[]; // ids, self first, root last
}

export interface Registry {
  verticals: VerticalSeed[];
  deals: DealSeed[];
  dealByCode: Map<DealCode, DealSeed>;
  dealById: Map<number, DealSeed>;
  categories: Category[];
  categoryByCode: Map<string, Category>;
  categoryById: Map<number, Category>;
  places: Place[];
  placeById: Map<number, Place>;
  placeByCode: Map<string, Place>;
  attributes: AttrSeed[];
  /** normalized phrase -> category code (longest phrases win during parsing) */
  categoryPhrases: Map<string, string>;
  /** normalized alias -> place id */
  placePhrases: Map<string, number>;
  /** normalized word -> {attr key, enum code, category} */
  attrValuePhrases: Map<string, { key: string; code: string; category: string }[]>;
  rootPlaceId: number;
  version: string;
}

const GAP = 1000; // spacing in the interval code so new places can be inserted without renumbering

export function buildRegistry(
  verticals: VerticalSeed[] = VERTICALS,
  deals: DealSeed[] = DEALS,
  categories: CategorySeed[] = CATEGORIES,
  attributes: AttrSeed[] = ATTRIBUTES,
  places: PlaceSeed[] = PLACES,
): Registry {
  const dealByCode = new Map(deals.map((d) => [d.code, d] as const));
  const dealById = new Map(deals.map((d) => [d.id, d] as const));

  // categories
  const catByCode = new Map<string, Category>();
  for (const c of categories) {
    const verticalCode = c.code.split('.')[0]!;
    const v = verticals.find((x) => x.code === verticalCode);
    if (!v) throw new Error(`category ${c.code}: unknown vertical ${verticalCode}`);
    const relation = c.deals.every((d) => dealByCode.get(d)?.relation === 'peer') ? 'peer' : 'exchange';
    catByCode.set(c.code, { ...c, verticalId: v.id, verticalCode, depth: 0, ancestors: [], descendants: [], relation });
  }
  for (const c of catByCode.values()) {
    let cur: Category | undefined = c;
    while (cur) {
      c.ancestors.push(cur.id);
      cur = cur.parent ? catByCode.get(cur.parent) : undefined;
    }
    c.depth = c.ancestors.length - 1;
  }
  const catById = new Map([...catByCode.values()].map((c) => [c.id, c] as const));
  for (const c of catByCode.values()) for (const a of c.ancestors) catById.get(a)!.descendants.push(c.id);

  // places: nested set with gaps, DFS in seed order
  const children = new Map<string | null, PlaceSeed[]>();
  for (const p of places) {
    const list = children.get(p.parent) ?? [];
    list.push(p);
    children.set(p.parent, list);
  }
  const placeByCode = new Map<string, Place>();
  let counter = 0;
  const visit = (p: PlaceSeed, depth: number, ancestors: number[]) => {
    counter += GAP;
    const node: Place = { ...p, depth, lft: counter, rgt: 0, ancestors: [p.id, ...ancestors] };
    placeByCode.set(p.code, node);
    for (const ch of children.get(p.code) ?? []) visit(ch, depth + 1, node.ancestors);
    counter += GAP;
    node.rgt = counter;
  };
  const roots = children.get(null) ?? [];
  if (roots.length !== 1) throw new Error('places must have exactly one root');
  visit(roots[0]!, 0, []);
  const placeById = new Map([...placeByCode.values()].map((p) => [p.id, p] as const));

  // vocabulary
  const categoryPhrases = new Map<string, string>();
  for (const c of catByCode.values()) {
    for (const k of [c.nameAr, ...c.keywords]) {
      const n = normalizeAr(k);
      if (n && !categoryPhrases.has(n)) categoryPhrases.set(n, c.code);
    }
  }
  const placePhrases = new Map<string, number>();
  for (const p of placeById.values()) {
    for (const a of [p.nameAr, ...(p.aliases ?? [])]) {
      const n = normalizeAr(a);
      if (n && !placePhrases.has(n)) placePhrases.set(n, p.id);
    }
  }
  const attrValuePhrases = new Map<string, { key: string; code: string; category: string }[]>();
  for (const a of attributes) {
    for (const v of a.values ?? []) {
      for (const w of [v.labelAr, ...v.words]) {
        const n = normalizeAr(w);
        const list = attrValuePhrases.get(n) ?? [];
        if (!list.some((x) => x.key === a.key && x.code === v.code)) list.push({ key: a.key, code: v.code, category: a.category });
        attrValuePhrases.set(n, list);
      }
    }
  }

  const version = `seed:${categories.length}c/${places.length}p/${attributes.length}a`;
  return {
    verticals, deals, dealByCode, dealById,
    categories: [...catByCode.values()], categoryByCode: catByCode, categoryById: catById,
    places: [...placeByCode.values()], placeById, placeByCode,
    attributes, categoryPhrases, placePhrases, attrValuePhrases,
    rootPlaceId: roots[0]!.id, version,
  };
}

/** Attribute definitions that apply to a category (its own + inherited from ancestors). */
export function attributesFor(reg: Registry, categoryCode: string): AttrSeed[] {
  const cat = reg.categoryByCode.get(categoryCode);
  if (!cat) return [];
  const codes = new Set(cat.ancestors.map((id) => reg.categoryById.get(id)!.code));
  return reg.attributes.filter((a) => codes.has(a.category));
}

export function isPlaceWithin(reg: Registry, placeId: number, scopeId: number): boolean {
  const p = reg.placeById.get(placeId);
  const s = reg.placeById.get(scopeId);
  if (!p || !s) return false;
  return p.lft >= s.lft && p.rgt <= s.rgt;
}

export function isCategoryWithin(reg: Registry, catId: number, scopeCatId: number): boolean {
  return reg.categoryById.get(catId)?.ancestors.includes(scopeCatId) ?? false;
}

/** Great-circle distance in km between two places when both have coordinates (ranking only). */
export function distanceKm(reg: Registry, a: number | null, b: number | null): number | null {
  if (a == null || b == null) return null;
  const pa = reg.placeById.get(a);
  const pb = reg.placeById.get(b);
  if (pa?.lat == null || pa.lng == null || pb?.lat == null || pb.lng == null) return null;
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (pb.lat - pa.lat) * rad;
  const dLng = (pb.lng - pa.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(pa.lat * rad) * Math.cos(pb.lat * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

let defaultRegistry: Registry | null = null;
export function seedRegistry(): Registry {
  defaultRegistry ??= buildRegistry();
  return defaultRegistry;
}
