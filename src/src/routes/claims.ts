// claims の読み出し。詳細と人物の画面で共通に使う。
import type { ClaimSource, Strength } from "../types";
import type { ClaimX, RelatedItem } from "./types";

type ClaimRow = {
  id: string;
  person_id: string;
  person_label: string;
  source: ClaimSource;
  text: string;
  strength: Strength | null;
  author_id: string | null;
  author_name: string | null;
  linked_name: string | null;
};

// 統合された人物は、統合先の人物として見せる
const SELECT_CLAIM = `
  SELECT c.id, COALESCE(m.id, p.id) AS person_id, COALESCE(m.label, p.label) AS person_label,
         c.source, c.text, c.strength, u.id AS author_id, u.display_name AS author_name,
         lu.display_name AS linked_name
  FROM claims c
  JOIN persons p ON p.id = c.person_id AND p.project_id = c.project_id
  LEFT JOIN persons m ON m.id = p.merged_into AND m.project_id = c.project_id
  LEFT JOIN users u ON u.id = c.author_user_id
  LEFT JOIN users lu ON lu.id = COALESCE(m.linked_user_id, p.linked_user_id)
  WHERE c.project_id = ? AND c.superseded_at IS NULL`;

export async function loadClaims(env: Env, pid: string): Promise<ClaimX[]> {
  const [{ results: rows }, { results: links }] = await Promise.all([
    env.DB.prepare(`${SELECT_CLAIM} ORDER BY c.created_at`).bind(pid).all<ClaimRow>(),
    env.DB.prepare("SELECT claim_id, item_id, clear, seen FROM claim_items WHERE project_id = ?")
      .bind(pid)
      .all<{ claim_id: string; item_id: string; clear: number; seen: number }>(),
  ]);
  const byClaim = new Map<string, string[]>();
  const clearBy = new Map<string, string[]>();
  const seenBy = new Map<string, string[]>();
  for (const l of links) {
    byClaim.set(l.claim_id, [...(byClaim.get(l.claim_id) ?? []), l.item_id]);
    if (l.clear) clearBy.set(l.claim_id, [...(clearBy.get(l.claim_id) ?? []), l.item_id]);
    if (l.seen) seenBy.set(l.claim_id, [...(seenBy.get(l.claim_id) ?? []), l.item_id]);
  }
  return rows.map((r) => ({
    id: r.id,
    person_id: r.person_id,
    person_label: r.person_label,
    source: r.source,
    text: r.text,
    strength: r.strength,
    author: r.author_id ? { id: r.author_id, display_name: r.author_name ?? "" } : null,
    item_ids: byClaim.get(r.id) ?? [],
    clear_item_ids: clearBy.get(r.id) ?? [],
    seen_item_ids: seenBy.get(r.id) ?? [],
    linked_name: r.linked_name,
  }));
}

// この物の項目と、この物につながる人の家族のメモと Claude の仮説。
// 別の物が根拠の仮説は、画面が item_ids を見て「この人についての仮説」として分ける
export async function claimsForItem(env: Env, pid: string, itemId: string): Promise<ClaimX[]> {
  const all = await loadClaims(env, pid);
  const direct = all.filter((c) => c.item_ids.includes(itemId));
  const people = new Set(direct.map((c) => c.person_id));
  return all.filter(
    (c) => c.item_ids.includes(itemId) || (c.source !== "photo" && people.has(c.person_id)),
  );
}

// 物の番号から、画面に出す小さな情報を作る
export async function relatedItems(env: Env, pid: string, ids: string[]): Promise<RelatedItem[]> {
  if (!ids.length) return [];
  const { results } = await env.DB.prepare(
    `SELECT id, seq, title FROM items WHERE project_id = ? AND id IN (${ids.map(() => "?").join(",")}) ORDER BY seq`,
  )
    .bind(pid, ...ids)
    .all<{ id: string; seq: number; title: string | null }>();
  return results.map((r) => ({ ...r, thumb_url: `/api/p/${pid}/items/${r.id}/thumb` }));
}
