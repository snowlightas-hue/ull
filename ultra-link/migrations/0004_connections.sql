-- 0004_connections.sql — Ultra Link V2.2 "connections & chat" (owner: connections role; design: docs/FEATURES-V2.md §4,
-- details: docs/CONNECTIONS.md).
--
--  1. connections: the «ربط» between the two users of one match, created (idempotently) when a contact request is
--     accepted. One row per match: UNIQUE (vertical_id, match_id) — two concurrent accepts (A→B and B→A) end in one
--     row (INSERT … ON CONFLICT DO NOTHING). Status machine: open → closed | blocked | archived (closed → archived and
--     blocked → closed on unblock). Per-side state lives on the row (a_* = the match's a_user, b_* = b_user):
--     phone share toggles and read receipts (last read message seq). message_count is the last message seq:
--     messages are numbered 1..n per connection without gaps, so a page's exact total and position cost nothing.
--  2. connection_messages: append-only chat messages. PRIMARY KEY (connection_id, seq) is the keyset index (newest
--     first / "after seq" for live updates) and is already the shape a HASH (connection_id) partitioning needs
--     (docs/CONNECTIONS.md §Scale). seq is assigned under the connection row lock (SELECT … FOR UPDATE), so it grows
--     in commit order — a reader polling "after seq" can never miss a message that commits later with a smaller seq.
--     UNIQUE (connection_id, sender_id, client_msg_id) makes a retried send one row. No FK on sender_id on purpose: the
--     sender is always a participant (checked on insert) and rows go away with the connection (cascade); an FK would
--     make every user deletion scan this table.
--  3. user_blocks: user-level block (blocker → blocked). Refuses contact requests between the two in either
--     direction and freezes their connection(s). Reports are stored for human review; nothing is auto-banned.
--  4. connection_location_shares: one row per (connection, sharer) for a time-limited live location share
--     (15/30/60 min, CHECK ≤ 60 min). Each start gets a new share_id. Coordinates are erased when the share ends
--     (CHECK: ended ⇒ no coordinates). Self-contained: no dependency on 0003's live_positions.
--  5. user_recovery_codes: one recovery code per real account (MAJOR-6). Only HMAC-SHA256(pepper, code) is stored
--     (UNIQUE → direct lookup, like sessions.token_hash); the code itself is shown once.
--  6. Backfill: a connection for every contact request accepted before this migration (same realm only). Phone
--     shares start OFF — the counterpart's phone is no longer revealed by an accept (docs/CONNECTIONS.md).
--
-- Locks: new tables only, plus a read of contact_requests/matches/users for the backfill (milliseconds on the app DB).
-- Rollback (forward-only runner; inverse statements):
--   DROP TABLE user_recovery_codes, connection_location_shares, connection_reports, user_blocks, connection_messages, connections;
-- Tests: test/integration/connections-*.test.ts.

SET LOCAL lock_timeout = '10s';

-- ───────────── 1. connections ─────────────
CREATE TABLE connections (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id       uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  vertical_id     smallint NOT NULL,
  match_id        bigint NOT NULL,
  realm           text NOT NULL CHECK (realm IN ('real', 'synthetic')),
  a_user_id       bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,  -- = matches.a_user_id
  b_user_id       bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,  -- = matches.b_user_id
  a_intent_id     bigint NOT NULL,                                          -- = matches.a_intent_id (same vertical)
  b_intent_id     bigint NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'blocked', 'archived')),
  status_by       bigint,            -- the participant who closed/blocked (NULL for open / automatic archive)
  status_reason   text CHECK (status_reason IN ('closed_by_user', 'blocked_by_user', 'intents_done', 'idle')),
  a_phone_shared  boolean NOT NULL DEFAULT false,
  b_phone_shared  boolean NOT NULL DEFAULT false,
  a_last_read_seq integer NOT NULL DEFAULT 0,
  b_last_read_seq integer NOT NULL DEFAULT 0,
  message_count   integer NOT NULL DEFAULT 0 CHECK (message_count >= 0),   -- = seq of the newest message
  last_message_at timestamptz,
  activity_at     timestamptz NOT NULL DEFAULT now(),                       -- creation, then newest message
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,       -- when it stopped being open (closed / blocked / archived)
  archived_at     timestamptz,
  UNIQUE (vertical_id, match_id),
  CHECK (a_user_id <> b_user_id),
  CHECK (a_last_read_seq BETWEEN 0 AND message_count AND b_last_read_seq BETWEEN 0 AND message_count),
  CHECK (status_by IS NULL OR status_by = a_user_id OR status_by = b_user_id),
  CHECK ((status = 'open') = (closed_at IS NULL)),
  CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  CHECK (status NOT IN ('closed', 'blocked') OR status_by IS NOT NULL),
  FOREIGN KEY (vertical_id, match_id) REFERENCES matches (vertical_id, id) ON DELETE CASCADE
);
-- the viewer's list (either side), newest activity first; also serves the users FK cascades
CREATE INDEX connections_a_user_idx ON connections (a_user_id, activity_at DESC, id DESC);
CREATE INDEX connections_b_user_idx ON connections (b_user_id, activity_at DESC, id DESC);
-- the archive sweep walks only connections that can still be archived
CREATE INDEX connections_sweep_idx ON connections (id) WHERE status IN ('open', 'closed');
-- every message rewrites the row (count, activity, read receipt): keep those updates HOT
ALTER TABLE connections SET (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);

-- ───────────── 2. messages (append-only) ─────────────
CREATE TABLE connection_messages (
  connection_id bigint NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
  seq           integer NOT NULL CHECK (seq > 0),
  sender_id     bigint NOT NULL,
  client_msg_id uuid NOT NULL,
  body          text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, seq),
  UNIQUE (connection_id, sender_id, client_msg_id)
);
ALTER TABLE connection_messages SET (autovacuum_vacuum_insert_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);

-- ───────────── 3. blocks & reports ─────────────
CREATE TABLE user_blocks (
  blocker_id    bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  blocked_id    bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  connection_id bigint,              -- where it happened (context only; the block is user-level)
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX user_blocks_blocked_idx ON user_blocks (blocked_id);

CREATE TABLE connection_reports (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  connection_id bigint NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
  reporter_id   bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  reported_id   bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  reason        text NOT NULL CHECK (reason IN ('spam', 'scam', 'abuse', 'inappropriate', 'fake', 'other')),
  note          text CHECK (note IS NULL OR char_length(note) <= 500),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'dismissed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  reviewed_at   timestamptz,
  UNIQUE (connection_id, reporter_id),
  CHECK (reporter_id <> reported_id)
);
CREATE INDEX connection_reports_queue_idx ON connection_reports (created_at) WHERE status = 'open';
CREATE INDEX connection_reports_reporter_idx ON connection_reports (reporter_id);
CREATE INDEX connection_reports_reported_idx ON connection_reports (reported_id);

-- ───────────── 4. time-limited live location shares ─────────────
CREATE TABLE connection_location_shares (
  connection_id bigint NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
  sharer_id     bigint NOT NULL,     -- a participant of the connection (checked on write)
  share_id      uuid NOT NULL DEFAULT gen_random_uuid(),   -- new on every start (job + notification dedupe)
  started_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  ended_at      timestamptz,
  end_reason    text CHECK (end_reason IN ('stopped', 'expired', 'connection_ended')),
  lat           double precision CHECK (lat BETWEEN -90 AND 90),
  lng           double precision CHECK (lng BETWEEN -180 AND 180),
  accuracy_m    integer CHECK (accuracy_m BETWEEN 0 AND 100000),
  position_at   timestamptz,
  PRIMARY KEY (connection_id, sharer_id),
  UNIQUE (share_id),
  CHECK (expires_at > started_at AND expires_at <= started_at + interval '60 minutes'),
  CHECK ((lat IS NULL) = (lng IS NULL) AND (lat IS NULL) = (position_at IS NULL)),
  CHECK (ended_at IS NULL OR lat IS NULL),                   -- coordinates never outlive the share
  CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);
CREATE INDEX connection_location_shares_live_idx ON connection_location_shares (expires_at) WHERE ended_at IS NULL;
-- every position ping rewrites the row
ALTER TABLE connection_location_shares SET (fillfactor = 70, autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 200);

-- ───────────── 5. account recovery (real accounts) ─────────────
CREATE TABLE user_recovery_codes (
  user_id      bigint PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  code_hash    bytea NOT NULL UNIQUE CHECK (octet_length(code_hash) = 32),   -- HMAC-SHA256(pepper, normalized code)
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

-- ───────────── 6. backfill: contact requests accepted before 0004 ─────────────
INSERT INTO connections (vertical_id, match_id, realm, a_user_id, b_user_id, a_intent_id, b_intent_id, created_at, activity_at, updated_at)
SELECT DISTINCT ON (m.vertical_id, m.id)
       m.vertical_id, m.id, ua.realm, m.a_user_id, m.b_user_id, m.a_intent_id, m.b_intent_id,
       coalesce(cr.responded_at, cr.created_at), coalesce(cr.responded_at, cr.created_at), now()
  FROM contact_requests cr
  JOIN matches m ON m.vertical_id = cr.vertical_id AND m.id = cr.match_id
  JOIN users ua ON ua.id = m.a_user_id
  JOIN users ub ON ub.id = m.b_user_id
 WHERE cr.status = 'accepted' AND ua.realm = ub.realm
 ORDER BY m.vertical_id, m.id, coalesce(cr.responded_at, cr.created_at)
ON CONFLICT (vertical_id, match_id) DO NOTHING;
