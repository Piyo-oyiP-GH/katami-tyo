-- 記憶係（Managed Agents のメモリストア）。片付け 1 つにメモリストア 1 つ
-- memory_store_id：作ったメモリストアの id。memory_seq：記憶係に渡し終えた items.seq。memory_meta_json：最後の回の計測（数だけ）
ALTER TABLE projects ADD COLUMN memory_store_id TEXT;
ALTER TABLE projects ADD COLUMN memory_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN memory_meta_json TEXT;
