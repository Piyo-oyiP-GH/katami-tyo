-- 計画書 v2 の 4 章の全テーブル。時刻はすべて Unix ミリ秒の整数。
-- 計画の表は「主な列」なので、足した列には「追加」と書いた。

CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  is_guest     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL            -- 追加
);

CREATE TABLE identities (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  sub      TEXT NOT NULL,
  PRIMARY KEY (provider, sub)
);

CREATE TABLE projects (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  is_sample          INTEGER NOT NULL DEFAULT 0,
  owner_user_id      TEXT NOT NULL REFERENCES users(id),
  created_at         INTEGER NOT NULL,     -- 追加
  expires_at         INTEGER,              -- 追加：見本は 24 時間で消す
  persons_seq        INTEGER NOT NULL DEFAULT 0, -- 追加：人物の仮説が読み終えた items.seq
  persons_updated_at INTEGER               -- 追加：人物の仮説を最後に更新した時刻
);

CREATE TABLE memberships (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at INTEGER NOT NULL,             -- 追加
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX idx_memberships_user ON memberships(user_id);

CREATE TABLE invites (
  id              TEXT PRIMARY KEY,        -- 追加
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  display_name    TEXT NOT NULL,
  token_hash      TEXT NOT NULL UNIQUE,
  revoked_at      INTEGER,
  used_by_user_id TEXT REFERENCES users(id), -- 追加：開いた人
  created_at      INTEGER NOT NULL         -- 追加
);
CREATE INDEX idx_invites_project ON invites(project_id);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,             -- Cookie の乱数の SHA-256。乱数そのものは保存しない
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE items (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'reading', 'done', 'failed')),
  title           TEXT,
  r2_key          TEXT NOT NULL,
  confidence      TEXT CHECK (confidence IN ('high', 'mid', 'low')),
  rank_score      REAL,
  rank_reason     TEXT,
  search_terms    TEXT,                    -- JSON。SearchTerms の形
  pile            TEXT NOT NULL CHECK (pile IN ('keep', 'drop', 'unsure')),
  updated_at      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,        -- 追加
  image_ceiling   TEXT NOT NULL DEFAULT 'high'
                  CHECK (image_ceiling IN ('high', 'mid', 'low')), -- 追加：端末で測った画像の上限
  needs_retake    INTEGER NOT NULL DEFAULT 0, -- 追加：撮り直し候補
  reading_json    TEXT,                    -- 追加：読み取りの結果。ItemReading の形
  ai_meta_json    TEXT,                    -- 追加：計測だけ。読んだ文字は入れない。AiRunMeta の形
  error_code      TEXT,                    -- 追加：失敗の種類
  correction_json TEXT,                    -- 追加：「違う」ボタンの家族の訂正。読み取りより優先する
  UNIQUE (project_id, seq)
);
CREATE INDEX idx_items_rank ON items(project_id, rank_score DESC);

CREATE TABLE persons (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  subtype        TEXT NOT NULL CHECK (subtype IN ('owner', 'friend', 'vague')),
  label          TEXT NOT NULL,
  merged_into    TEXT REFERENCES persons(id),
  linked_user_id TEXT REFERENCES users(id), -- 追加：参加者との結び付け。人が確定したときだけ入れる
  created_at     INTEGER NOT NULL,         -- 追加
  updated_at     INTEGER NOT NULL          -- 追加
);
CREATE INDEX idx_persons_project ON persons(project_id);

CREATE TABLE claims (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  person_id      TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  source         TEXT NOT NULL CHECK (source IN ('photo', 'family', 'claude')),
  text           TEXT NOT NULL,
  strength       TEXT CHECK (strength IN ('weak', 'mid', 'strong')), -- コードで計算する。family は NULL
  author_user_id TEXT REFERENCES users(id),
  superseded_at  INTEGER,
  created_at     INTEGER NOT NULL          -- 追加
);
CREATE INDEX idx_claims_person ON claims(project_id, person_id);

CREATE TABLE claim_items (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, -- 「全テーブルに project_id」
  claim_id   TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  item_id    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  PRIMARY KEY (claim_id, item_id)
);
CREATE INDEX idx_claim_items_item ON claim_items(item_id);

CREATE TABLE waits (
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_id      TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note         TEXT,                       -- 追加：ひとこと（T4b）
  created_at   INTEGER NOT NULL,
  withdrawn_at INTEGER,
  UNIQUE (item_id, user_id)
);
CREATE INDEX idx_waits_project ON waits(project_id, item_id);
