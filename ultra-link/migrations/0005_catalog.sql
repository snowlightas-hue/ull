-- 0005_catalog.sql — Ultra Link V2.3 "stores, catalog & photos" (owner: catalog role; design: docs/FEATURES-V2.md §2,
-- details: docs/CATALOG.md).
--
--  1. stores: a provider profile (Arabic name, optional description, place, contact preferences, status). realm is the
--     OWNER's realm, copied by a trigger on insert/update (never taken from the client): a synthetic owner's store is
--     synthetic. Status active | paused; pausing a store pauses its products' intents through the normal status path
--     (src/catalog/repo.ts), so matching re-evaluates them and invalidates their matches.
--     next_position hands out product positions under the store row lock (dense enough for keyset paging, never reused).
--  2. store_items: the link "this provide intent is product N of store S". Products ARE ordinary intents — no column is
--     added to intents and createIntent is unchanged — so the matching engine treats them like any other offer.
--     PRIMARY KEY (vertical_id, intent_id): an intent belongs to at most one store. UNIQUE (store_id, position)
--     INCLUDE (vertical_id, intent_id) is the keyset index of the product list (position order, index-only).
--     name_norm (normalised product name) serves duplicate detection on import: (store_id, name_norm).
--     paused_by_store remembers which products the STORE paused, so resuming the store does not resume a product its
--     owner paused individually. A trigger enforces the invariant the matcher relies on: the intent is a `provide`
--     intent of the store owner, in the store's realm.
--  3. catalog_imports: idempotency of a bulk import confirm — (store_id, import_id) with the client-generated uuid and a
--     sha256 of the request; a retried confirm returns the stored result, a different request with the same id is 409.
--  4. media_blobs: one row per distinct CLEANED image (sha256 of the bytes after metadata removal) — the file lives at
--     var/media/<aa>/<bb>/<sha256 hex>. last_used_at lets the garbage collector keep blobs that an upload in flight
--     is about to reference (it only removes unreferenced blobs older than one hour).
--     store_item_photos: up to 6 photos per product (slot 1..6, UNIQUE per product; the same image twice on one
--     product is one row). Rows go away with the product link (cascade).
--
-- Locks: new tables only (no rewrite of existing tables); milliseconds on the app DB.
-- Rollback (forward-only runner; inverse statements):
--   DROP TABLE store_item_photos, media_blobs, catalog_imports, store_items, stores;
--   DROP FUNCTION ul_catalog_store_realm(), ul_catalog_item_check();
--   (the products stay as ordinary offers; photo files under var/media can then be deleted)
-- Tests: test/integration/catalog-*.test.ts.

SET LOCAL lock_timeout = '10s';

-- ───────────── 1. stores ─────────────
CREATE TABLE stores (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id      uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  owner_id       bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  realm          text NOT NULL CHECK (realm IN ('real', 'synthetic')),      -- = users.realm of owner_id (trigger)
  name_ar        text NOT NULL CHECK (char_length(btrim(name_ar)) BETWEEN 2 AND 80),
  description_ar text CHECK (description_ar IS NULL OR char_length(description_ar) <= 500),
  place_id       integer NOT NULL REFERENCES places (id),
  contact_pref   text NOT NULL DEFAULT 'chat' CHECK (contact_pref IN ('chat', 'chat_then_phone')),
  hours_ar       text CHECK (hours_ar IS NULL OR char_length(hours_ar) <= 120),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  version        integer NOT NULL DEFAULT 1 CHECK (version > 0),
  next_position  integer NOT NULL DEFAULT 1 CHECK (next_position > 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
-- the owner's store list (≤ 5 per owner) and the users FK cascade
CREATE INDEX stores_owner_idx ON stores (owner_id, created_at, id);

CREATE FUNCTION ul_catalog_store_realm() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT u.realm INTO NEW.realm FROM users u WHERE u.id = NEW.owner_id;
  RETURN NEW;
END $$;
CREATE TRIGGER stores_realm_trg BEFORE INSERT OR UPDATE OF owner_id, realm ON stores
  FOR EACH ROW EXECUTE FUNCTION ul_catalog_store_realm();

-- ───────────── 2. store_items (store ↔ provide intent) ─────────────
CREATE TABLE store_items (
  vertical_id     smallint NOT NULL,
  intent_id       bigint NOT NULL,
  store_id        bigint NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  position        integer NOT NULL CHECK (position > 0),
  name_ar         text NOT NULL CHECK (char_length(name_ar) BETWEEN 1 AND 80),
  name_norm       text NOT NULL CHECK (char_length(name_norm) BETWEEN 1 AND 200),
  paused_by_store boolean NOT NULL DEFAULT false,
  import_id       uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vertical_id, intent_id),
  CONSTRAINT store_items_position_key UNIQUE (store_id, position) INCLUDE (vertical_id, intent_id),
  FOREIGN KEY (vertical_id, intent_id) REFERENCES intents (vertical_id, id) ON DELETE CASCADE
);
CREATE INDEX store_items_name_idx ON store_items (store_id, name_norm);

CREATE FUNCTION ul_catalog_item_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE iu bigint; ir text; isd text; so bigint; sr text;
BEGIN
  SELECT i.user_id, i.realm, i.side INTO iu, ir, isd FROM intents i WHERE i.vertical_id = NEW.vertical_id AND i.id = NEW.intent_id;
  SELECT s.owner_id, s.realm INTO so, sr FROM stores s WHERE s.id = NEW.store_id;
  IF iu IS DISTINCT FROM so OR ir IS DISTINCT FROM sr OR isd IS DISTINCT FROM 'provide' THEN
    RAISE EXCEPTION 'store_items: intent %/% is not a provide intent of the store owner in the store realm', NEW.vertical_id, NEW.intent_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER store_items_check_trg BEFORE INSERT OR UPDATE OF vertical_id, intent_id, store_id ON store_items
  FOR EACH ROW EXECUTE FUNCTION ul_catalog_item_check();

-- ───────────── 3. bulk import idempotency ─────────────
CREATE TABLE catalog_imports (
  store_id     bigint NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  import_id    uuid NOT NULL,
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  line_count   integer NOT NULL CHECK (line_count BETWEEN 1 AND 200),
  created      integer NOT NULL CHECK (created >= 0),
  result       jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(result) = 'object'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, import_id)
);

-- ───────────── 4. photos (content-addressed) ─────────────
CREATE TABLE media_blobs (
  sha256       bytea PRIMARY KEY CHECK (octet_length(sha256) = 32),
  mime         text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  bytes        integer NOT NULL CHECK (bytes BETWEEN 1 AND 5242880),
  width        integer NOT NULL CHECK (width BETWEEN 1 AND 65535),
  height       integer NOT NULL CHECK (height BETWEEN 1 AND 65535),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE store_item_photos (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id   uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  vertical_id smallint NOT NULL,
  intent_id   bigint NOT NULL,
  slot        smallint NOT NULL CHECK (slot BETWEEN 1 AND 6),
  sha256      bytea NOT NULL REFERENCES media_blobs (sha256),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_item_photos_slot_key UNIQUE (vertical_id, intent_id, slot),
  CONSTRAINT store_item_photos_blob_key UNIQUE (vertical_id, intent_id, sha256),
  FOREIGN KEY (vertical_id, intent_id) REFERENCES store_items (vertical_id, intent_id) ON DELETE CASCADE
);
-- garbage collection ("is this blob still referenced?") and the media_blobs FK
CREATE INDEX store_item_photos_blob_idx ON store_item_photos (sha256);
