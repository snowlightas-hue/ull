// MatchCard privacy + connection info, applied by src/server/app.ts to every MatchCard it returns
// (GET /api/matches, GET /api/matches/:id, POST /api/intents/:id/match).
//
//   * accept reveals the counterpart's DISPLAY NAME only: any phone that hydration attached is removed here;
//   * the phone comes back only while the counterpart's «شارك رقمي» is on and the connection is open;
//   * `connection: { id, status, unread }` lets the card offer «فتح المحادثة».
import type { Queryable } from '../db/pool.ts';
import { viewStatus } from './repo.ts';

interface CardLike {
  id: string;
  contact?: { status?: string; counterpart?: { displayName: string; phone?: string } } | null;
  connection?: { id: string; status: string; unread: number } | null;
}

export async function decorateMatchCards<T extends CardLike>(db: Queryable, userId: string, cards: T[]): Promise<T[]> {
  for (const card of cards) {
    if (card?.contact?.counterpart) card.contact.counterpart = { displayName: card.contact.counterpart.displayName };
  }
  const ids = cards.map((c) => c?.id).filter((id): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id));
  if (!ids.length) return cards;
  const { rows } = await db.query(
    `SELECT r.public_id AS match_public_id, c.public_id, c.status, c.status_by, c.message_count,
            CASE WHEN c.a_user_id = $2 THEN c.a_last_read_seq ELSE c.b_last_read_seq END AS my_last_read,
            CASE WHEN c.status = 'open' AND (CASE WHEN c.a_user_id = $2 THEN c.b_phone_shared ELSE c.a_phone_shared END)
                 THEN u.contact_phone END AS phone
       FROM match_refs r
       JOIN connections c ON c.vertical_id = r.vertical_id AND c.match_id = r.match_id
       JOIN users u ON u.id = CASE WHEN c.a_user_id = $2 THEN c.b_user_id ELSE c.a_user_id END
      WHERE r.public_id = ANY($1::uuid[]) AND (c.a_user_id = $2 OR c.b_user_id = $2)`,
    [ids, userId]);
  const by = new Map(rows.map((r) => [String(r.match_public_id), r]));
  for (const card of cards) {
    const r = by.get(card?.id);
    if (!r) continue;
    card.connection = { id: r.public_id, status: viewStatus(r, userId), unread: Math.max(0, r.message_count - r.my_last_read) };
    if (r.phone && card.contact?.counterpart) card.contact.counterpart.phone = r.phone;
  }
  return cards;
}
