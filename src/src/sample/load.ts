// 見本の複製。架空データを、新しい project の中に作る。Claude は呼ばない。
// 確からしさ、点数、理由、検索の語は、本物の読み取りと同じ計算で出す。見本だけ違う見た目にしないため。
import { checkLines, itemConfidence } from "../ai/confidence";
import { rank, searchTerms } from "../ai/rank";
import type { Level, Strength } from "../types";
import { photoKey, thumbKey } from "../types";
import {
  SAMPLE_CLAIMS,
  SAMPLE_ITEMS,
  SAMPLE_MEMBERS,
  SAMPLE_PERSONS,
  SAMPLE_WAITS,
  type SampleItem,
} from "./data";

export function deriveItem(item: SampleItem) {
  const ceiling: Level = item.blur ? "low" : "high";
  const checked = checkLines(item.a!, item.a2, ceiling);
  const { score, reason, needsRetake } = rank(checked, item.b);
  const terms = searchTerms(checked, item.b);
  return {
    ceiling,
    checked,
    confidence: itemConfidence(checked, ceiling, false),
    score,
    reason,
    needsRetake,
    terms: { ...terms, name: [...new Set([item.title, ...terms.name])] },
  };
}

// 計画 3 章。1〜2 個＝弱、3〜9 個＝中、10 個以上＝強め。数えるのは名前が「はっきり」読めた物だけ
function isClear(key: string): boolean {
  const item = SAMPLE_ITEMS.find((i) => i.key === key)!;
  return deriveItem(item).checked.some((l) => l.type === "name" && l.level === "high");
}

export function claimStrength(itemKeys: string[]): Strength {
  const clear = itemKeys.filter(isClear).length;
  return clear >= 10 ? "strong" : clear >= 3 ? "mid" : "weak";
}

// 画像は架空なので public/sample/ に置き、project ごとの R2 に写す。以後は本物の写真と同じ道で配る
export async function storeSamplePhotos(env: Env, pid: string, itemIds: Map<string, string>) {
  const copy = async (file: string, key: string) => {
    const res = await env.ASSETS.fetch(new Request(`https://assets.local/sample/${file}`));
    if (!res.ok) throw new Error(`sample image ${file}: ${res.status}`);
    await env.PHOTOS.put(key, await res.arrayBuffer(), {
      httpMetadata: { contentType: "image/jpeg" },
    });
  };
  await Promise.all(
    SAMPLE_ITEMS.flatMap((item) => {
      const iid = itemIds.get(item.key)!;
      return [
        copy(`${item.key}.jpg`, photoKey(pid, iid)),
        copy(`${item.key}-thumb.jpg`, thumbKey(pid, iid)),
      ];
    }),
  );
}

export function sampleStatements(env: Env, pid: string, now: number) {
  const itemIds = new Map(SAMPLE_ITEMS.map((i) => [i.key, crypto.randomUUID()]));
  const userIds = new Map(SAMPLE_MEMBERS.map((m) => [m.key, crypto.randomUUID()]));
  const personIds = new Map(SAMPLE_PERSONS.map((p) => [p.key, crypto.randomUUID()]));
  const db = env.DB;

  const statements: D1PreparedStatement[] = [];
  SAMPLE_MEMBERS.forEach((m, i) => {
    statements.push(
      db
        .prepare("INSERT INTO users (id, display_name, is_guest, created_at) VALUES (?, ?, 1, ?)")
        .bind(userIds.get(m.key), m.display_name, now),
      db
        .prepare(
          "INSERT INTO memberships (project_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)",
        )
        .bind(pid, userIds.get(m.key), now + i + 1),
    );
  });
  SAMPLE_ITEMS.forEach((item, i) => {
    const iid = itemIds.get(item.key)!;
    const d = deriveItem(item);
    statements.push(
      db
        .prepare(
          `INSERT INTO items (id, project_id, seq, status, title, r2_key, confidence, rank_score, rank_reason,
             search_terms, pile, needs_retake, reading_json, ai_meta_json, image_ceiling, updated_at, created_at)
           VALUES (?, ?, ?, 'done', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          iid,
          pid,
          i + 1,
          item.title,
          photoKey(pid, iid),
          d.confidence,
          d.score,
          d.reason,
          JSON.stringify(d.terms),
          item.pile,
          d.needsRetake ? 1 : 0,
          JSON.stringify({ a: item.a, a2: item.a2, b: item.b, checked: d.checked }),
          null,
          d.ceiling,
          now,
          now,
        ),
    );
  });
  SAMPLE_PERSONS.forEach((p, i) => {
    statements.push(
      db
        .prepare(
          `INSERT INTO persons (id, project_id, subtype, label, linked_user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          personIds.get(p.key),
          pid,
          p.subtype,
          p.label,
          p.linked ? userIds.get(p.linked) : null,
          now + i,
          now + i,
        ),
    );
  });
  SAMPLE_CLAIMS.forEach((cl, i) => {
    const id = crypto.randomUUID();
    statements.push(
      db
        .prepare(
          `INSERT INTO claims (id, project_id, person_id, source, text, strength, author_user_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          pid,
          personIds.get(cl.person),
          cl.source,
          cl.text,
          cl.source === "family" ? null : claimStrength(cl.items),
          cl.author ? userIds.get(cl.author) : null,
          now + i,
        ),
      ...cl.items.map((key) =>
        db
          .prepare("INSERT INTO claim_items (project_id, claim_id, item_id, clear) VALUES (?, ?, ?, ?)")
          .bind(pid, id, itemIds.get(key), cl.source !== "family" && isClear(key) ? 1 : 0),
      ),
    );
  });
  SAMPLE_WAITS.forEach((w, i) => {
    statements.push(
      db
        .prepare(
          "INSERT INTO waits (project_id, item_id, user_id, note, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(pid, itemIds.get(w.item), userIds.get(w.user), w.note, now + i),
    );
  });
  return { itemIds, statements };
}
