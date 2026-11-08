-- 画面担当。人物の種類に親族（relative）を足す。家族が名前を直した札の、元の読みを持つ（read_label）。
-- SQLite は CHECK を変えられないので persons を作り直す。
-- persons を DROP すると ON DELETE CASCADE で claims と claim_items も消えるので、先に控えて戻す。
PRAGMA defer_foreign_keys = true;

CREATE TABLE claims_keep AS SELECT * FROM claims;
CREATE TABLE claim_items_keep AS SELECT * FROM claim_items;

CREATE TABLE persons_new (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  subtype        TEXT NOT NULL CHECK (subtype IN ('owner', 'relative', 'friend', 'vague')),
  label          TEXT NOT NULL,
  merged_into    TEXT REFERENCES persons(id),
  linked_user_id TEXT REFERENCES users(id),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  made_by        TEXT,
  read_label     TEXT
);
-- merged_into は親の persons を指す。DROP の間に外部キーの違反にならないよう、後で戻す
INSERT INTO persons_new (id, project_id, subtype, label, linked_user_id, created_at, updated_at, made_by)
  SELECT id, project_id, subtype, label, linked_user_id, created_at, updated_at, made_by FROM persons;
CREATE TABLE persons_merged_keep AS SELECT id, merged_into FROM persons WHERE merged_into IS NOT NULL;

DROP TABLE persons;
ALTER TABLE persons_new RENAME TO persons;
CREATE INDEX idx_persons_project ON persons(project_id);
UPDATE persons SET merged_into = (SELECT k.merged_into FROM persons_merged_keep k WHERE k.id = persons.id)
  WHERE id IN (SELECT id FROM persons_merged_keep);

DELETE FROM claim_items;
DELETE FROM claims;
INSERT INTO claims SELECT * FROM claims_keep;
INSERT INTO claim_items SELECT * FROM claim_items_keep;
DROP TABLE claims_keep;
DROP TABLE claim_items_keep;
DROP TABLE persons_merged_keep;
