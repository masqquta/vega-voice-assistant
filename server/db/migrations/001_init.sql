-- 001: схема из docs/04-data-model (локальные due_date/due_time — источник истины, start_utc производное)

CREATE TABLE users (
  id          TEXT PRIMARY KEY,                -- uuid из X-User-Id
  tz          TEXT NOT NULL DEFAULT 'Europe/Moscow',
  created_at  INTEGER NOT NULL
);

CREATE TABLE items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL REFERENCES users(id),
  type          TEXT NOT NULL CHECK (type IN ('task','meeting','reminder')),
  title         TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  title_raw     TEXT,                            -- исходный текст до чистки (датасет, отладка)
  notes         TEXT,
  participants  TEXT,                            -- JSON-массив строк или NULL
  due_date      TEXT CHECK (due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  due_time      TEXT CHECK (due_time IS NULL OR due_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  start_utc     INTEGER,                         -- производное, NULL если нет даты или времени
  duration_min  INTEGER CHECK (duration_min IS NULL OR duration_min BETWEEN 5 AND 1440),
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  source        TEXT NOT NULL DEFAULT 'assistant' CHECK (source IN ('assistant','api','dataset')),
  type_confidence TEXT CHECK (type_confidence IN ('high','low')),  -- для датасета
  search_text   TEXT NOT NULL DEFAULT '',        -- стемы title + notes + participants для FTS
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  deleted_at    INTEGER,
  CHECK (due_time IS NULL OR due_date IS NOT NULL),                    -- время без даты нельзя
  CHECK (type != 'reminder' OR (due_date IS NOT NULL AND due_time IS NOT NULL)),
  CHECK (type != 'meeting'  OR (due_date IS NOT NULL AND due_time IS NOT NULL))
);

CREATE INDEX idx_items_user_date  ON items(user_id, due_date, due_time) WHERE deleted_at IS NULL;
CREATE INDEX idx_items_user_type  ON items(user_id, type)               WHERE deleted_at IS NULL;
CREATE INDEX idx_items_user_start ON items(user_id, start_utc)          WHERE deleted_at IS NULL AND type = 'meeting';
CREATE INDEX idx_items_created    ON items(user_id, created_at);

-- Полнотекстовый индекс (external content)
CREATE VIRTUAL TABLE items_fts USING fts5(
  search_text,
  content='items', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, search_text) VALUES (new.id, new.search_text);
END;
CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, search_text) VALUES ('delete', old.id, old.search_text);
END;
CREATE TRIGGER items_au AFTER UPDATE OF search_text ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, search_text) VALUES ('delete', old.id, old.search_text);
  INSERT INTO items_fts(rowid, search_text) VALUES (new.id, new.search_text);
END;

CREATE TABLE embeddings (
  item_id     INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  model       TEXT NOT NULL,                     -- например 'yandex/text-search-doc'
  dim         INTEGER NOT NULL,
  vector      BLOB NOT NULL,                     -- Float32Array, little-endian
  text_hash   TEXT NOT NULL,                     -- хеш исходного текста, пересчёт только при изменении
  updated_at  INTEGER NOT NULL
);

CREATE TABLE dialog_context (
  session_id  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  state_json  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX idx_ctx_expires ON dialog_context(expires_at);

CREATE TABLE message_log (                       -- история и метрики NLU
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  input_text  TEXT NOT NULL,
  channel     TEXT NOT NULL CHECK (channel IN ('text','voice')),
  nlu_json    TEXT,
  provider    TEXT,
  status      TEXT,
  latency_ms  INTEGER,
  created_at  INTEGER NOT NULL
);
