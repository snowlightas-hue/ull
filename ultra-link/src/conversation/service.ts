// Conversation service: persists drafts after every turn (survives reloads), idempotent turns
// (clientTurnId), optional Jev resolution with a strict latency budget, server-side validation,
// and intent creation when the draft is complete.
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { withTx } from '../db/pool.ts';
import type { Registry } from '../domain/registry.ts';
import { attributesFor } from '../domain/registry.ts';
import { validateSpec } from '../domain/validate.ts';
import type { Question } from '../domain/types.ts';
import { getJev, resolveWithJev, shouldCallJev, type JevField } from '../ai/index.ts';
import { normalizeAr } from '../nlu/arabic.ts';
import { parseUtterance } from '../nlu/parse.ts';
import type { JevResolution } from '../nlu/types.ts';
import { createIntent, loadIntent, toCard, type IntentCard } from '../repo/intents.ts';
import { enqueue } from '../repo/jobs.ts';
import type { SessionUser } from '../repo/users.ts';
import { applyTurn, emptyDraft, recordAsked, summarize, titleOf, type ConversationDraft } from './engine.ts';
import { jevUsable, reportJevFailure } from './jev-gate.ts';

export interface TurnResult {
  conversation: { id: string; state: 'collecting' | 'asking' | 'saved' | 'cancelled'; turns: number };
  action: 'ask' | 'saved' | 'cancelled' | 'unclear';
  question?: Question;
  summary: { titleAr: string; chips: { labelAr: string; valueAr: string; slot: string }[] };
  intent?: IntentCard;
  messageAr?: string;
  understanding: { engine: 'rules' | 'jev' | 'jev-sim'; latencyMs: number; notesAr?: string[] };
}

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, messageAr: string) { super(messageAr); this.status = status; this.code = code; }
}

const JEV_BUDGET_MS = Number(process.env.UL_JEV_BUDGET_MS ?? 2500);

export async function startConversation(db: pg.Pool, user: SessionUser) {
  // close any open draft of this user (one active conversation at a time keeps "current" unambiguous)
  await db.query("UPDATE conversations SET state = 'cancelled', updated_at = now() WHERE user_id = $1 AND state IN ('collecting','asking')", [user.id]);
  const { rows } = await db.query("INSERT INTO conversations (user_id, draft) VALUES ($1, $2) RETURNING public_id, state", [user.id, JSON.stringify(emptyDraft())]);
  return { id: rows[0].public_id, state: rows[0].state, turns: 0 };
}

export async function currentConversation(db: pg.Pool, reg: Registry, user: SessionUser) {
  const { rows } = await db.query(
    "SELECT public_id, state, draft, pending_question FROM conversations WHERE user_id = $1 AND state IN ('collecting','asking') ORDER BY updated_at DESC LIMIT 1",
    [user.id],
  );
  const r = rows[0];
  if (!r) return null;
  const draft = r.draft as ConversationDraft;
  return { id: r.public_id, state: r.state, turns: draft.turns ?? 0, question: r.pending_question ?? null, summary: summarize(reg, draft) };
}

export async function cancelConversation(db: pg.Pool, user: SessionUser, publicId: string) {
  const { rows } = await db.query(
    "UPDATE conversations SET state = 'cancelled', updated_at = now() WHERE public_id = $1 AND user_id = $2 AND state IN ('collecting','asking') RETURNING public_id, state",
    [publicId, user.id],
  );
  if (!rows[0]) throw new HttpError(404, 'not_found', 'المحادثة غير موجودة');
  return { id: rows[0].public_id, state: rows[0].state };
}

export async function handleTurn(pool: pg.Pool, reg: Registry, user: SessionUser, convId: string, body: { text: string; modality: 'voice' | 'text'; clientTurnId: string }): Promise<TurnResult> {
  const text = (body.text ?? '').trim();
  if (!text || text.length > 1000) throw new HttpError(422, 'bad_text', 'النص فارغ أو طويل جدًا');
  if (!/^[0-9a-f-]{36}$/i.test(convId)) throw new HttpError(404, 'not_found', 'المحادثة غير موجودة');
  const turnId = /^[0-9a-f-]{36}$/i.test(body.clientTurnId ?? '') ? body.clientTurnId : null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const { rows } = await pool.query('SELECT id, public_id, state, draft, pending_question, revision FROM conversations WHERE public_id = $1 AND user_id = $2', [convId, user.id]);
    const conv = rows[0];
    if (!conv) throw new HttpError(404, 'not_found', 'المحادثة غير موجودة');
    // idempotent retry: same clientTurnId → same answer, no re-processing
    if (turnId) {
      const prev = await pool.query("SELECT meta FROM conversation_messages WHERE conversation_id = $1 AND client_turn_id = $2 AND role = 'user'", [conv.id, turnId]);
      if (prev.rows[0]?.meta?.result) return prev.rows[0].meta.result as TurnResult;
    }
    if (conv.state === 'saved' || conv.state === 'cancelled') throw new HttpError(409, 'conversation_closed', 'هذه المحادثة انتهت. ابدأ طلبًا جديدًا.');

    const draft: ConversationDraft = { ...emptyDraft(), ...(conv.draft as ConversationDraft) };
    const answering: Question | null = conv.pending_question ?? null;
    const t0 = Date.now();

    // ── optional Jev: only for fields still open in the conversation, under a strict time budget
    let jev: JevResolution | null = null;
    const notes: string[] = [];
    const rt = getJev();
    if (rt.client && jevUsable(rt.client)) {
      const open: JevField[] = [];
      if (!draft.side) open.push('side');
      if (!draft.category) open.push('category');
      if (!draft.deal) open.push('deal');
      if (!draft.price) open.push('priceOp');
      if (!draft.place?.value.strength) open.push('placeStrength');
      const pre = parseUtterance(reg, text, { categoryHint: draft.category?.value ?? null, sideHint: draft.side?.value ?? null });
      if (open.length && shouldCallJev(pre, { registry: reg, only: open })) {
        try {
          jev = await resolveWithJev(rt.client, reg, text, pre, { only: open, signal: AbortSignal.timeout(JEV_BUDGET_MS) });
        } catch {
          reportJevFailure();
          notes.push('تعذّر الوصول إلى Jev — استُخدم المحلّل المحلي');
        }
      }
    }

    const out = applyTurn(reg, draft, { text, answering, jev });
    const engine: TurnResult['understanding']['engine'] = jev && out.appliedJev.length ? jev.engine : 'rules';
    if (out.appliedJev.length) notes.push(`حُدّد بواسطة ${jev?.engine === 'jev-sim' ? 'محاكاة Jev' : 'Jev'}: ${out.appliedJev.join('، ')}`);
    const understanding = { engine, latencyMs: Date.now() - t0, notesAr: notes.length ? notes : undefined };

    try {
      return await withTx(pool, async (tx) => {
        const msg = await tx.query(
          `INSERT INTO conversation_messages (conversation_id, role, modality, text, client_turn_id) VALUES ($1,'user',$2,$3,$4) RETURNING id`,
          [conv.id, body.modality === 'voice' ? 'voice' : 'text', text, turnId],
        );
        const messageId = msg.rows[0].id;
        await tx.query(
          `INSERT INTO extraction_runs (conversation_id, message_id, engine, model, input_hash, output, validated, latency_ms, input_tokens, output_tokens)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [conv.id, messageId, engine, jev?.model ?? null, createHash('sha256').update(normalizeAr(text)).digest(),
            JSON.stringify({ side: out.parse.side?.value ?? null, categories: out.parse.categories.map((c) => c.value), deal: out.parse.deal?.value ?? null, places: out.parse.places.map((p) => p.placeId), prices: out.parse.prices.length, appliedJev: out.appliedJev, next: out.next.kind }),
            out.next.kind !== 'unclear', understanding.latencyMs, jev?.usage?.inputTokens ?? null, jev?.usage?.outputTokens ?? null],
        );
        for (const term of out.parse.unknownTerms.slice(0, 5)) {
          await tx.query(
            `INSERT INTO unknown_terms (term_norm, category_id) VALUES ($1, $2)
             ON CONFLICT (term_norm, category_id) DO UPDATE SET hits = unknown_terms.hits + 1, last_seen = now()`,
            [term, out.draft.category ? reg.categoryByCode.get(out.draft.category.value)?.id ?? 0 : 0],
          );
        }

        let result: TurnResult;
        const convOut = (state: TurnResult['conversation']['state']) => ({ id: conv.public_id, state, turns: out.draft.turns });
        if (out.next.kind === 'ask') {
          recordAsked(out.draft, out.next.question);
          await saveConv(tx, conv, out.draft, out.next.question, 'asking');
          await tx.query("INSERT INTO conversation_messages (conversation_id, role, text, meta) VALUES ($1,'assistant',$2,$3)", [conv.id, out.next.question.text, JSON.stringify({ question: out.next.question })]);
          result = { conversation: convOut('asking'), action: 'ask', question: out.next.question, summary: summarize(reg, out.draft), understanding };
        } else if (out.next.kind === 'unclear') {
          await saveConv(tx, conv, out.draft, null, 'collecting');
          result = { conversation: convOut('collecting'), action: 'unclear', messageAr: out.next.messageAr, summary: summarize(reg, out.draft), understanding };
        } else {
          const v = validateSpec(reg, out.next.spec);
          if (!v.ok) {
            // never save unverifiable data; tell the user plainly and keep the draft
            await saveConv(tx, conv, out.draft, null, 'collecting');
            console.warn('[turn] spec validation failed', v.issues.map((i) => `${i.path}:${i.code}`).join(','));
            result = { conversation: convOut('collecting'), action: 'unclear', messageAr: 'ما قدرت أتحقق من كل التفاصيل. جرّب تحكيها بطريقة تانية.', summary: summarize(reg, out.draft), understanding };
          } else {
            const title = titleWithKeyAttr(reg, out.draft, v.spec);
            const created = await createIntent(tx, reg, { userId: user.id, realm: user.realm, spec: v.spec, titleAr: title, sourceText: text, conversationId: conv.id });
            const upd = await tx.query("UPDATE conversations SET state = 'saved', draft = $2, pending_question = NULL, intent_vertical_id = $3, intent_id = $4, revision = revision + 1, updated_at = now() WHERE id = $1 AND revision = $5", [conv.id, JSON.stringify(out.draft), created.verticalId, created.id, conv.revision]);
            if (!upd.rowCount) throw new Error('revision_conflict');
            // safety net: if the client never asks for results, the worker still matches (and notifies)
            await enqueue(tx, 'match_intent', { verticalId: created.verticalId, intentId: created.id, version: created.version, trigger: 'job' }, { dedupeKey: `match:${created.verticalId}:${created.id}:${created.version}`, runAt: new Date(Date.now() + 15_000) });
            const row = await loadIntent(tx, created.verticalId, created.id);
            result = { conversation: convOut('saved'), action: 'saved', summary: summarize(reg, out.draft), intent: toCard(reg, row!), understanding };
          }
        }
        await tx.query('UPDATE conversation_messages SET meta = $2 WHERE id = $1', [messageId, JSON.stringify({ result })]);
        return result;
      });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === '40001' || err.message === 'revision_conflict') continue; // concurrent turn: re-read and retry
      if (err.code === '23505' && turnId) continue; // same clientTurnId raced: the stored result will be returned
      throw e;
    }
  }
  throw new HttpError(409, 'busy', 'في طلب آخر قيد المعالجة، حاول مرة ثانية');
}

async function saveConv(tx: pg.PoolClient, conv: { id: string; revision: number }, draft: ConversationDraft, q: Question | null, state: string) {
  const r = await tx.query(
    'UPDATE conversations SET draft = $2, pending_question = $3, state = $4, revision = revision + 1, updated_at = now() WHERE id = $1 AND revision = $5',
    [conv.id, JSON.stringify(draft), q ? JSON.stringify(q) : null, state, conv.revision],
  );
  if (!r.rowCount) throw new Error('revision_conflict');
}

function titleWithKeyAttr(reg: Registry, d: ConversationDraft, spec: import('../domain/types.ts').IntentSpec): string {
  const base = titleOf(reg, d);
  const defs = attributesFor(reg, spec.categoryCode);
  const keyAttr = ['subject', 'appliance', 'make'].map((k) => {
    const v = spec.attrs[k] ?? spec.constraints.find((c) => c.key === k && c.op === 'eq')?.value;
    if (v === undefined) return null;
    return defs.find((x) => x.key === k)?.values?.find((x) => x.code === v)?.labelAr ?? null;
  }).find(Boolean);
  return keyAttr ? `${base} (${keyAttr})` : base;
}
