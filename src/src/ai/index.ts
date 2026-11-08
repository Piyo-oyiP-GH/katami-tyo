// 読み取りの入口。キューの消費者はここの 2 つの関数だけを呼ぶ。
import { Buffer } from "node:buffer";
import Anthropic from "@anthropic-ai/sdk";
import { STALE_MS } from "../maintain";
import type { JobOutcome, Level, ReadItemJob } from "../types";
import { schedulePersons } from "./persons";
import { API_IMAGE_LIMIT_BASE64, exifOrientation } from "./photo";
import { readPhoto } from "./pipeline";
import type { AiRunMetaExt, ItemCardFields } from "./types";

export { updatePersons } from "./persons";
export { updateBoxNotices } from "./notices";
export { reapplyCorrection } from "./rank";
export { strengthOf } from "./persons-core";

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function saveDone(env: Env, job: ReadItemJob, f: ItemCardFields, meta: AiRunMetaExt) {
  await env.DB.prepare(
    `UPDATE items SET status = 'done', title = ?, confidence = ?, rank_score = ?, rank_reason = ?,
       search_terms = ?, needs_retake = ?, reading_json = ?, ai_meta_json = ?, error_code = ?,
       persons_pending_at = ?, updated_at = ? WHERE id = ? AND project_id = ?`,
  )
    .bind(
      f.title,
      f.confidence,
      f.rank_score,
      f.rank_reason,
      JSON.stringify(f.search_terms),
      f.needs_retake ? 1 : 0,
      JSON.stringify(f.reading),
      JSON.stringify(meta),
      f.error_code,
      Date.now(),
      Date.now(),
      job.iid,
      job.pid,
    )
    .run();
}

// 読めなかった物は消さない。写真と行を残し、未解析のまま再試行できるようにする
async function saveFailed(env: Env, job: ReadItemJob, code: string, meta: AiRunMetaExt | null) {
  await env.DB.prepare(
    `UPDATE items SET status = 'failed', error_code = ?, ai_meta_json = ?, updated_at = ?
     WHERE id = ? AND project_id = ?`,
  )
    .bind(code, meta ? JSON.stringify(meta) : null, Date.now(), job.iid, job.pid)
    .run();
}

// final は最後の試行。消費者が決める
export async function processItem(env: Env, job: ReadItemJob, final = false): Promise<JobOutcome> {
  // 読み始める権利を取る。同じ物の仕事が 2 つあっても、Claude を呼ぶのは 1 つだけ。
  // 読み終えた物、読んでいる最中の物の仕事はここで終わる。止まった物だけ読み直せる
  const now = Date.now();
  const row = await env.DB.prepare(
    `UPDATE items SET status = 'reading', error_code = NULL, updated_at = ?
     WHERE id = ? AND project_id = ?
       AND (status = 'queued' OR (status = 'reading' AND updated_at <= ?))
     RETURNING image_ceiling`,
  )
    .bind(now, job.iid, job.pid, now - STALE_MS)
    .first<{ image_ceiling: Level }>();
  if (!row) return "failed"; // 取れない、または行が無い。書く先が無いので終わる

  const obj = await env.PHOTOS.get(job.r2_key);
  if (!obj) {
    await saveFailed(env, job, "photo_missing", null);
    return "failed";
  }
  const photo = await obj.arrayBuffer();

  const encodeStart = performance.now();
  const base64 = Buffer.from(photo).toString("base64"); // 3 回の呼び出しで使い回す
  const encodeMs = performance.now() - encodeStart;

  const started = Date.now();
  const meta: AiRunMetaExt = {
    photo_bytes: photo.byteLength,
    photo_sha256: await sha256Hex(photo),
    base64_chars: base64.length,
    encode_ms: encodeMs,
    calls: [],
    total_seconds: 0,
    orientation: exifOrientation(photo),
  };
  if (base64.length > API_IMAGE_LIMIT_BASE64) {
    await saveFailed(env, job, "photo_too_large_for_api", meta);
    return "failed";
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2 });
  const result = await readPhoto(client, base64, row.image_ceiling, { final });
  meta.calls = result.calls;
  meta.total_seconds = (Date.now() - started) / 1000;

  if (result.outcome === "done") {
    meta.guard = result.guard;
    await saveDone(env, job, result.fields, meta);
    try {
      await schedulePersons(env, job.pid);
    } catch (e) {
      // 人物の更新を始められなくても、読み取りは済んでいる。次の物の時に拾う
      console.error("schedulePersons failed", e instanceof Error ? e.name : "unknown");
    }
    return "done";
  }
  meta.error_status = result.status;
  meta.error_message = result.message;
  if (result.outcome === "failed") {
    await saveFailed(env, job, result.code, meta);
    return "failed";
  }
  return "retry";
}
