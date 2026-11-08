-- 画面担当。招待のリンクから入り直したセッションを、1 つの片付けに閉じる。
-- sessions.project_id：NULL なら本人の端末のセッション。値があれば、その片付けでだけ使える。
-- sessions.invite_id：このセッションを作った招待。失効のときに消す。
ALTER TABLE sessions ADD COLUMN project_id TEXT;
ALTER TABLE sessions ADD COLUMN invite_id TEXT;
CREATE INDEX idx_sessions_invite ON sessions(invite_id) WHERE invite_id IS NOT NULL;
CREATE INDEX idx_sessions_project ON sessions(project_id) WHERE project_id IS NOT NULL;
-- invites.kind：invite は人を招く招待。self は本人が別の端末で開くためのリンク。
-- invites.reentry：1 ならリンクを持つ人が、その片付けの中でだけ入り直せる。
--   招待で作られた人と、本人用のリンクだけが 1。ログイン済みの人が使った招待は 0 で、使い切りになる。
ALTER TABLE invites ADD COLUMN kind TEXT NOT NULL DEFAULT 'invite';
ALTER TABLE invites ADD COLUMN reentry INTEGER NOT NULL DEFAULT 0;
-- T8。回数の数え口。key に日付や project を入れる。day は古い行を消すためだけに使う。
CREATE TABLE usage_counts (
  key TEXT PRIMARY KEY,
  n   INTEGER NOT NULL,
  day TEXT NOT NULL
);
CREATE INDEX idx_usage_day ON usage_counts(day);
