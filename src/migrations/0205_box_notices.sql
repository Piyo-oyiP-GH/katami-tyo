-- projects.notices_json：箱全体の、写真をまたぐ知らせ（BoxNotices）。物の人物更新のあとに作り直す
ALTER TABLE projects ADD COLUMN notices_json TEXT;
