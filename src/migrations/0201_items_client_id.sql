-- 画面担当。端末が付ける番号。通信が切れて送り直しても、同じ物を 2 つ作らないため。
ALTER TABLE items ADD COLUMN client_id TEXT;
CREATE UNIQUE INDEX idx_items_client ON items(project_id, client_id) WHERE client_id IS NOT NULL;
