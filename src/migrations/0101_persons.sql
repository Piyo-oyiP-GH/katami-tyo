-- AI 担当。人物カードの差分更新（T5a）。
-- items.persons_pending_at：読み終えて、まだ人物の更新に入っていない物の印。読み終えた時刻。
--   読み取りは順不同に終わるので、persons_seq の位置だけでは飛ばす物が出る。この列を正とする。
--   家族の訂正のときは 1 を入れる（60 秒を待たずに更新する）。
ALTER TABLE items ADD COLUMN persons_pending_at INTEGER;
CREATE INDEX idx_items_persons ON items(project_id, persons_pending_at) WHERE persons_pending_at IS NOT NULL;
-- claim_items.basis：つながりの根拠の字。訂正のたびに、まだ根拠があるかを確かめ直す。
-- claim_items.clear：確からしさが「はっきり」の読みなら 1。強さはこの数だけで決める。
ALTER TABLE claim_items ADD COLUMN basis TEXT;
ALTER TABLE claim_items ADD COLUMN clear INTEGER NOT NULL DEFAULT 0;
-- persons.made_by：Claude が作った札は 'claude'。根拠が全部消えたら画面から外す。
ALTER TABLE persons ADD COLUMN made_by TEXT;
-- projects.persons_meta_json：最後の更新の計測。数だけで、読んだ文字は入れない。
ALTER TABLE projects ADD COLUMN persons_meta_json TEXT;
