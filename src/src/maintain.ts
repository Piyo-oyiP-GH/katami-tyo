// 定期の片付け。cron から動く。cron の無い手元の PC では、画面を開いたときにも動く。
// 1 期限切れの見本を、D1 と R2 から消す  2 読み取りのまま止まった物をキューに入れ直す
// 3 人物の更新に入らないまま残った物の更新を頼み直す
import { deleteMemory } from "./ai/memory";
import type { ReadItemJob, UpdatePersonsJob } from "./types";
import { readingOff, today } from "./usage";

export const STALE_MS = 3 * 60 * 1000; // 読み取り中のまま止まった、と見なすまでの時間
const MAX_PROJECTS = 20; // 1 回に消す数。残りは次の回に消す
const MIN_GAP_MS = 60 * 1000;
const PERSONS_RETRY_MS = 10 * 60 * 1000; // 人物の更新が失敗し続けても、Claude を呼び続けないための間隔

async function deletePhotos(env: Env, pid: string) {
  const prefix = `p/${pid}/`;
  for (;;) {
    const page = await env.PHOTOS.list({ prefix, limit: 500 });
    if (!page.objects.length) return;
    await env.PHOTOS.delete(page.objects.map((o) => o.key));
    if (!page.truncated) return;
  }
}

// 写真を先に消す。D1 の行が残っていれば、途中で止まっても次の回に続きができる。
// ON DELETE CASCADE に頼らず、子の表から順に消す
async function deleteProject(env: Env, pid: string) {
  await deletePhotos(env, pid);
  const mem = await env.DB.prepare("SELECT memory_store_id FROM projects WHERE id = ?")
    .bind(pid)
    .first<{ memory_store_id: string | null }>();
  await deleteMemory(env, mem?.memory_store_id ?? null);
  const del = (sql: string) => env.DB.prepare(sql).bind(pid);
  await env.DB.batch([
    del("DELETE FROM claim_items WHERE project_id = ?"),
    del("DELETE FROM claims WHERE project_id = ?"),
    del("DELETE FROM waits WHERE project_id = ?"),
    del("UPDATE persons SET merged_into = NULL WHERE project_id = ?"),
    del("DELETE FROM persons WHERE project_id = ?"),
    del("DELETE FROM items WHERE project_id = ?"),
    del("DELETE FROM invites WHERE project_id = ?"),
    del("DELETE FROM sessions WHERE project_id = ?"),
    del("DELETE FROM memberships WHERE project_id = ?"),
    del("DELETE FROM projects WHERE id = ?"),
  ]);
}

export async function purgeExpired(env: Env, now = Date.now()): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT id FROM projects WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT ?",
  )
    .bind(now, MAX_PROJECTS)
    .all<{ id: string }>();
  for (const { id } of results) await deleteProject(env, id);
  const weekAgo = today(now - 7 * 24 * 3600_000);
  await env.DB.batch([
    // どの片付けにも属さないゲストと見本の架空の人。セッションは連鎖で消える
    env.DB.prepare(
      `DELETE FROM users WHERE is_guest = 1
         AND id NOT IN (SELECT user_id FROM memberships)
         AND id NOT IN (SELECT owner_user_id FROM projects)`,
    ),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM usage_counts WHERE day < ?").bind(weekAgo),
  ]);
  return results.length;
}

// 止まった物は、サーバの再起動などでキューの仕事が失われた物。写真は R2 に残っている。
// 状態は変えず、仕事だけを足す。元の仕事がまだ生きていても、processItem の権利の取り合いで 1 つだけが読む。
// 待ちの物は updated_at を進め、次の入れ直しまで 3 分空ける
export async function requeueStale(env: Env, now = Date.now()): Promise<number> {
  if (readingOff(env)) return 0;
  const { results } = await env.DB.prepare(
    `SELECT id, project_id, r2_key FROM items
     WHERE status IN ('queued', 'reading') AND updated_at <= ? LIMIT 20`,
  )
    .bind(now - STALE_MS)
    .all<{ id: string; project_id: string; r2_key: string }>();
  for (const r of results) {
    await env.DB.prepare(
      "UPDATE items SET updated_at = ? WHERE id = ? AND project_id = ? AND status = 'queued'",
    )
      .bind(now, r.id, r.project_id)
      .run();
    const job: ReadItemJob = { type: "read_item", pid: r.project_id, iid: r.id, r2_key: r.r2_key };
    await env.READ_QUEUE.send(job);
  }
  return results.length;
}

// 人物の更新が失敗すると、物の印（persons_pending_at）だけが残り、次の読み取りが無ければ誰も拾わない。
// 最後の更新の試行から間を空けて、頼み直す。上限に当たっていれば updatePersons が Claude を呼ばない
export async function requeuePersons(env: Env, now = Date.now()): Promise<number> {
  if (readingOff(env)) return 0;
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT i.project_id FROM items i
     JOIN projects p ON p.id = i.project_id
     WHERE i.status = 'done' AND i.persons_pending_at IS NOT NULL AND i.persons_pending_at <= ?
       AND COALESCE(json_extract(p.persons_meta_json, '$.at'), 0) <= ?
     LIMIT 20`,
  )
    .bind(now - STALE_MS, now - PERSONS_RETRY_MS)
    .all<{ project_id: string }>();
  for (const { project_id } of results) {
    const job: UpdatePersonsJob = { type: "update_persons", pid: project_id };
    await env.PERSONS_QUEUE.send(job);
  }
  return results.length;
}

export async function maintain(env: Env) {
  await purgeExpired(env);
  await requeueStale(env);
  await requeuePersons(env);
}

// 画面からの呼び出しは、1 分に 1 回までにする
let lastRun = 0;
export function maintainSoon(env: Env, wait: (p: Promise<unknown>) => void) {
  const now = Date.now();
  if (now - lastRun < MIN_GAP_MS) return;
  lastRun = now;
  wait(maintain(env).catch((e) => console.error("maintain failed", e instanceof Error ? e.name : "unknown")));
}
