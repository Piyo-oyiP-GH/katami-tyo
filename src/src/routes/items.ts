// 物の登録、一覧、詳細、写真の配信、待った、訂正。
import { Hono } from "hono";
import {
  AiRunMeta,
  BoxNotices,
  ItemReading,
  MAX_PHOTO_BYTES,
  ReadItemJob,
  UpdatePersonsJob,
  WaitResponse,
  WaitView,
  photoKey,
  thumbKey,
} from "../types";
import { reapplyCorrection } from "../ai";
import type { CheckedReading } from "../ai/types";
import { photoQuotas, readingOff, take } from "../usage";
import { ItemRow, SELECT_ITEM, clip, isStale, parseJson, retryable, toCard } from "./cards";
import { claimsForItem, relatedItems } from "./claims";
import { AppEnv, clientKey } from "./session";
import type { Correction, ItemDetailX, ItemListX } from "./types";

const MAX_THUMB_BYTES = 512 * 1024;
const PILES: readonly string[] = ["keep", "drop", "unsure"];
const LEVELS: readonly string[] = ["high", "mid", "low"];

const isJpeg = (b: ArrayBuffer) => {
  const head = new Uint8Array(b, 0, Math.min(2, b.byteLength));
  return head[0] === 0xff && head[1] === 0xd8;
};

const getItem = (env: Env, userId: string, pid: string, iid: string) =>
  env.DB.prepare(`${SELECT_ITEM} AND i.id = ?`).bind(userId, pid, iid).first<ItemRow>();

// 物がこの project のものかを確かめる。参加者の確認は pid にしか効かないので、物ごとに要る
const itemExists = (env: Env, pid: string, iid: string) =>
  env.DB.prepare("SELECT 1 FROM items WHERE id = ? AND project_id = ?").bind(iid, pid).first();

export const itemRoutes = new Hono<AppEnv>();

// キューへ入れ直す。写真は R2 に残っている
async function requeue(env: Env, pid: string, iid: string, r2_key: string) {
  await env.DB.prepare(
    "UPDATE items SET status = 'queued', error_code = NULL, updated_at = ? WHERE id = ? AND project_id = ?",
  )
    .bind(Date.now(), iid, pid)
    .run();
  const job: ReadItemJob = { type: "read_item", pid, iid, r2_key };
  await env.READ_QUEUE.send(job);
}

// 本文は JPEG そのもの。POST /items?pile=keep&ceiling=high&cid=端末が付けた番号
itemRoutes.post("/", async (c) => {
  const pid = c.req.param("pid")!;
  const userId = c.get("user")!.id;
  const pile = c.req.query("pile") ?? "";
  const ceiling = c.req.query("ceiling") ?? "high";
  const cid = c.req.query("cid")?.slice(0, 64) || null;
  if (!PILES.includes(pile) || !LEVELS.includes(ceiling)) return c.json({ error: "bad_params" }, 400);

  // 送り直しのとき。前の送信が届いていれば、同じ物を返す
  if (cid) {
    const prev = await c.env.DB.prepare(`${SELECT_ITEM} AND i.client_id = ?`)
      .bind(userId, pid, cid)
      .first<ItemRow>();
    if (prev) {
      // 前の送信のキューの仕事が失われていたら、ここで入れ直す
      if (isStale(prev) && !readingOff(c.env)) {
        await requeue(c.env, pid, prev.id, prev.r2_key);
        const row = await getItem(c.env, userId, pid, prev.id);
        return c.json({ item: toCard(pid, row!) }, 200);
      }
      return c.json({ item: toCard(pid, prev) }, 200);
    }
  }

  // 本文を読む前に大きさを見る
  if (Number(c.req.header("content-length") ?? 0) > MAX_PHOTO_BYTES) return c.json({ error: "photo_too_large" }, 413);
  const photo = await c.req.arrayBuffer();
  if (photo.byteLength > MAX_PHOTO_BYTES) return c.json({ error: "photo_too_large" }, 413);
  if (!isJpeg(photo)) return c.json({ error: "not_jpeg" }, 415);

  // 写真を置く前、キューに積む前に確かめる
  if (readingOff(c.env)) return c.json({ error: "reading_stopped" }, 503);
  const over = await take(c.env, photoQuotas(c.env, pid, c.get("isSample"), await clientKey(c)));
  if (over) return c.json({ error: over }, 429);

  const iid = crypto.randomUUID();
  const r2_key = photoKey(pid, iid);
  const now = Date.now();
  // 先に写真を置く。後の段で失敗しても写真は消えない
  await c.env.PHOTOS.put(r2_key, photo, { httpMetadata: { contentType: "image/jpeg" } });
  await c.env.DB.prepare(
    `INSERT INTO items (id, project_id, seq, r2_key, pile, image_ceiling, client_id, updated_at, created_at)
     SELECT ?, ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?, ? FROM items WHERE project_id = ?`,
  )
    .bind(iid, pid, r2_key, pile, ceiling, cid, now, now, pid)
    .run();
  const job: ReadItemJob = { type: "read_item", pid, iid, r2_key };
  await c.env.READ_QUEUE.send(job);

  const row = await getItem(c.env, userId, pid, iid);
  return c.json({ item: toCard(pid, row!) }, 202);
});

// 手がかりの多い順。読めなかった物は、やり直せるよう先頭に出す
itemRoutes.get("/", async (c) => {
  const pid = c.req.param("pid")!;
  const { results } = await c.env.DB.prepare(
    // 物の観察ができなかった物も、埋もれないよう前に出す
    `${SELECT_ITEM} ORDER BY i.status = 'failed' DESC, i.error_code IS NOT NULL DESC,
       i.rank_score IS NULL, i.rank_score DESC, i.seq DESC`,
  )
    .bind(c.get("user")!.id, pid)
    .all<ItemRow>();
  const box = await c.env.DB.prepare("SELECT notices_json FROM projects WHERE id = ?")
    .bind(pid)
    .first<{ notices_json: string | null }>();
  const ids = new Set(results.map((r) => r.id));
  const notices = (parseJson<BoxNotices>(box?.notices_json ?? null)?.notices ?? [])
    .map((n) => ({ say: n.say, item_ids: n.item_ids.filter((id) => ids.has(id)) }))
    .filter((n) => n.item_ids.length >= 2);
  return c.json<ItemListX>({ items: results.map((r) => toCard(pid, r)), notices });
});

async function loadWaits(env: Env, pid: string, iid: string): Promise<WaitView[]> {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.display_name, w.note, w.created_at FROM waits w
     JOIN users u ON u.id = w.user_id
     WHERE w.project_id = ? AND w.item_id = ? AND w.withdrawn_at IS NULL
     ORDER BY w.created_at`,
  )
    .bind(pid, iid)
    .all<{ id: string; display_name: string; note: string | null; created_at: number }>();
  return results.map((r) => ({
    user: { id: r.id, display_name: r.display_name },
    note: r.note,
    created_at: r.created_at,
  }));
}

async function detail(env: Env, pid: string, row: ItemRow): Promise<ItemDetailX> {
  const [claims, waits] = await Promise.all([
    claimsForItem(env, pid, row.id),
    loadWaits(env, pid, row.id),
  ]);
  const ids = [...new Set(claims.flatMap((cl) => cl.item_ids))].filter((id) => id !== row.id);
  const related = await relatedItems(env, pid, ids);
  return {
    item: toCard(pid, row),
    reading: parseJson<ItemReading>(row.reading_json),
    meta: publicMeta(parseJson<AiRunMeta>(row.ai_meta_json)),
    correction: parseJson<Correction>(row.correction_json),
    claims,
    waits,
    related,
  };
}

itemRoutes.get("/:iid", async (c) => {
  const pid = c.req.param("pid")!;
  const row = await getItem(c.env, c.get("user")!.id, pid, c.req.param("iid"));
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json<ItemDetailX>(await detail(c.env, pid, row));
});

// 山の変更。「いらない」の物を「迷う」に移す、など
itemRoutes.patch("/:iid", async (c) => {
  const pid = c.req.param("pid")!;
  const iid = c.req.param("iid");
  const body = await c.req.json<{ pile?: string }>().catch(() => ({}) as { pile?: string });
  if (!body.pile || !PILES.includes(body.pile)) return c.json({ error: "bad_params" }, 400);
  const res = await c.env.DB.prepare(
    "UPDATE items SET pile = ?, updated_at = ? WHERE id = ? AND project_id = ?",
  )
    .bind(body.pile, Date.now(), iid, pid)
    .run();
  if (!res.meta.changes) return c.json({ error: "not_found" }, 404);
  const row = await getItem(c.env, c.get("user")!.id, pid, iid);
  return c.json<ItemDetailX>(await detail(c.env, pid, row!));
});

// 写真は公開 URL を作らず、ここを通して参加者だけに返す
async function servePhoto(
  env: Env,
  pid: string,
  iid: string,
  key: (p: string, i: string) => string,
) {
  const obj = (await itemExists(env, pid, iid)) ? await env.PHOTOS.get(key(pid, iid)) : null;
  if (!obj) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(obj.body, {
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}

itemRoutes.get("/:iid/photo", (c) =>
  servePhoto(c.env, c.req.param("pid")!, c.req.param("iid"), photoKey),
);
itemRoutes.get("/:iid/thumb", (c) =>
  servePhoto(c.env, c.req.param("pid")!, c.req.param("iid"), thumbKey),
);

// 端末で作った縮小画像
itemRoutes.put("/:iid/thumb", async (c) => {
  const pid = c.req.param("pid")!;
  const iid = c.req.param("iid");
  if (!(await itemExists(c.env, pid, iid))) return c.json({ error: "not_found" }, 404);
  if (Number(c.req.header("content-length") ?? 0) > MAX_THUMB_BYTES) return c.json({ error: "photo_too_large" }, 413);
  const thumb = await c.req.arrayBuffer();
  if (thumb.byteLength > MAX_THUMB_BYTES) return c.json({ error: "photo_too_large" }, 413);
  if (!isJpeg(thumb)) return c.json({ error: "not_jpeg" }, 415);
  await c.env.PHOTOS.put(thumbKey(pid, iid), thumb, {
    httpMetadata: { contentType: "image/jpeg" },
  });
  return c.body(null, 204);
});

// 読み取りのやり直し。写真は R2 に残っているので、キューに入れ直すだけでよい
itemRoutes.post("/:iid/retry", async (c) => {
  const pid = c.req.param("pid")!;
  const iid = c.req.param("iid");
  const userId = c.get("user")!.id;
  const row = await getItem(c.env, userId, pid, iid);
  if (!row) return c.json({ error: "not_found" }, 404);
  if (!retryable(row)) return c.json({ error: "not_failed" }, 409);
  if (readingOff(c.env)) return c.json({ error: "reading_stopped" }, 503);
  const over = await take(c.env, photoQuotas(c.env, pid, c.get("isSample"), await clientKey(c)));
  if (over) return c.json({ error: over }, 429);
  await requeue(c.env, pid, iid, row.r2_key);
  const next = await getItem(c.env, userId, pid, iid);
  return c.json({ item: toCard(pid, next!) }, 202);
});

// 「違う」ボタン。本文は { title } か { line, text }。読み取りの列は変えず、訂正の列に足す
itemRoutes.post("/:iid/correction", async (c) => {
  const pid = c.req.param("pid")!;
  const iid = c.req.param("iid");
  const user = c.get("user")!;
  const row = await getItem(c.env, user.id, pid, iid);
  if (!row) return c.json({ error: "not_found" }, 404);
  type Body = { title?: string; line?: number; text?: string };
  const body = await c.req.json<Body>().catch(() => ({}) as Body);
  const prev = parseJson<Correction>(row.correction_json);
  const next: Correction = {
    ...prev,
    by: { id: user.id, display_name: user.display_name },
    at: Date.now(),
  };
  const title = clip(body.title, 60);
  const text = clip(body.text, 200);
  const line = body.line;
  if (title) next.title = title;
  else if (typeof line === "number" && Number.isInteger(line) && line >= 0 && text) {
    const reading = parseJson<ItemReading & { checked?: { text: string }[] }>(row.reading_json);
    const shown = reading?.checked ?? reading?.a?.lines ?? [];
    const original = prev?.lines?.[String(line)]?.original ?? shown[line]?.text ?? null;
    next.lines = { ...prev?.lines, [String(line)]: { text, original } };
  } else return c.json({ error: "bad_params" }, 400);
  // 点数、理由、確からしさは訂正済みの読みで計算し直す
  const reading = parseJson<CheckedReading>(row.reading_json);
  const redo = reading?.checked ? reapplyCorrection(reading, next, row.image_ceiling) : null;
  // 人物カードの根拠も確かめ直す。印の 1 は「60 秒を待たない」の意味
  await c.env.DB.prepare(
    `UPDATE items SET correction_json = ?, updated_at = ?,
       confidence = ?, rank_score = ?, rank_reason = ?, needs_retake = ?,
       persons_pending_at = CASE WHEN status = 'done' THEN 1 ELSE persons_pending_at END
     WHERE id = ? AND project_id = ?`,
  )
    .bind(
      JSON.stringify(next),
      Date.now(),
      redo ? redo.confidence : row.confidence,
      redo ? redo.score : row.rank_score,
      redo ? redo.reason : row.rank_reason,
      redo ? (redo.needsRetake ? 1 : 0) : row.needs_retake,
      iid,
      pid,
    )
    .run();
  if (row.status === "done") {
    const job: UpdatePersonsJob = { type: "update_persons", pid };
    await c.env.PERSONS_QUEUE.send(job);
  }
  const fresh = await getItem(c.env, user.id, pid, iid);
  return c.json<ItemDetailX>(await detail(c.env, pid, fresh!));
});

// 待った。名前はセッションの人から付く。本文は { note? }
async function waitState(env: Env, userId: string, pid: string, iid: string): Promise<WaitResponse> {
  const waits = await loadWaits(env, pid, iid);
  return {
    wait_count: waits.length,
    waited_by_me: waits.some((w) => w.user.id === userId),
    waits,
  };
}

itemRoutes.post("/:iid/wait", async (c) => {
  const pid = c.req.param("pid")!;
  const iid = c.req.param("iid");
  const userId = c.get("user")!.id;
  if (!(await itemExists(c.env, pid, iid))) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json<{ note?: string }>().catch(() => ({}) as { note?: string });
  const note = clip(body.note, 200) || null;
  // note を送らなければ前のひとことを残す。空の文字を送ったら消す
  const clear = typeof body.note === "string" && !note ? 1 : 0;
  await c.env.DB.prepare(
    `INSERT INTO waits (project_id, item_id, user_id, note, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (item_id, user_id) DO UPDATE SET
       withdrawn_at = NULL,
       note = CASE WHEN ?6 = 1 THEN NULL ELSE COALESCE(excluded.note, waits.note) END,
       created_at = excluded.created_at`,
  )
    .bind(pid, iid, userId, note, Date.now(), clear)
    .run();
  return c.json<WaitResponse>(await waitState(c.env, userId, pid, iid));
});

itemRoutes.delete("/:iid/wait", async (c) => {
  const pid = c.req.param("pid")!;
  const iid = c.req.param("iid");
  const userId = c.get("user")!.id;
  if (!(await itemExists(c.env, pid, iid))) return c.json({ error: "not_found" }, 404);
  await c.env.DB.prepare(
    `UPDATE waits SET withdrawn_at = ?, note = NULL
     WHERE project_id = ? AND item_id = ? AND user_id = ? AND withdrawn_at IS NULL`,
  )
    .bind(Date.now(), pid, iid, userId)
    .run();
  return c.json<WaitResponse>(await waitState(c.env, userId, pid, iid));
});

// API のエラー文（request_id など）は参加者に返さない。記録には残す
function publicMeta(m: AiRunMeta | null): AiRunMeta | null {
  if (!m) return m;
  const { error_message: _e, ...rest } = m as AiRunMeta & { error_message?: string };
  return rest as AiRunMeta;
}
