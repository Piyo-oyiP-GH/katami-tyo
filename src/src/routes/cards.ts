// items の行を API の形に直す。一覧、検索、詳細で共通に使う。
import { STALE_MS } from "../maintain";
import type { ItemReading, ItemStatus, Level, Pile } from "../types";
import type { Correction, ItemCardX } from "./types";

export type ItemRow = {
  id: string;
  seq: number;
  status: ItemStatus;
  pile: Pile;
  title: string | null;
  confidence: Level | null;
  rank_score: number | null;
  rank_reason: string | null;
  needs_retake: number;
  error_code: string | null;
  updated_at: number;
  r2_key: string;
  image_ceiling: Level;
  search_terms: string | null;
  reading_json: string | null;
  ai_meta_json: string | null;
  correction_json: string | null;
  wait_count: number;
  waited_by_me: number;
};

// 使うときは、1 番目に見る人の user_id、2 番目に project_id を渡す
export const SELECT_ITEM = `
  SELECT i.*,
    (SELECT COUNT(*) FROM waits w WHERE w.item_id = i.id AND w.withdrawn_at IS NULL) AS wait_count,
    EXISTS (SELECT 1 FROM waits w WHERE w.item_id = i.id AND w.user_id = ? AND w.withdrawn_at IS NULL) AS waited_by_me
  FROM items i WHERE i.project_id = ?`;

// 理由 1 行を、チップに分ける。「手がかり：手書き、古び。撮り直し候補です。」の形。
// 撮り直し候補は needs_retake から別に出す
export function reasonChips(reason: string | null): string[] {
  if (!reason) return [];
  return reason
    .replace(/^手がかり：/, "")
    .split(/[、。]+/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("撮り直し候補") && !s.startsWith("字を上に向けて"));
}

export function parseJson<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

// 読み取り中のまま止まった物。サーバの時計で決める
export const isStale = (r: Pick<ItemRow, "status" | "updated_at">) =>
  (r.status === "queued" || r.status === "reading") && Date.now() - r.updated_at > STALE_MS;

// もう一度読める物。片方だけ失敗した物は、家族の訂正の行番号がずれないよう、訂正があれば読み直さない
export function retryable(r: ItemRow): boolean {
  if (r.status === "failed" || isStale(r)) return true;
  if (r.status !== "done" || !/^(?:observe|read)_/.test(r.error_code ?? "")) return false;
  return !parseJson<Correction>(r.correction_json)?.lines;
}

export function toCard(pid: string, r: ItemRow): ItemCardX {
  const base = `/api/p/${pid}/items/${r.id}`;
  const correction = parseJson<Correction>(r.correction_json);
  const reading = parseJson<ItemReading>(r.reading_json);
  return {
    id: r.id,
    seq: r.seq,
    status: r.status,
    pile: r.pile,
    title: correction?.title ?? r.title,
    confidence: r.confidence,
    rank_score: r.rank_score,
    rank_reason: r.rank_reason,
    needs_retake: !!r.needs_retake,
    error_code: r.error_code,
    wait_count: r.wait_count,
    waited_by_me: !!r.waited_by_me,
    photo_url: `${base}/photo`,
    thumb_url: `${base}/thumb`,
    updated_at: r.updated_at,
    kind: reading?.b?.kind ?? null,
    chips: [...reasonChips(r.rank_reason), ...(correction ? ["家族の訂正あり"] : [])],
    corrected: !!correction,
    stale: isStale(r),
    can_retry: retryable(r),
    notice: reading?.scene?.notice?.say ?? null,
  };
}

export const clip = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";
