// 検索。D1 の LIKE で候補を絞り、語の一覧で一致元を決める。
import { Hono } from "hono";
import type { ItemReading, SearchSource, SearchTerms } from "../types";
import { ItemRow, SELECT_ITEM, clip, parseJson, toCard } from "./cards";
import { AppEnv } from "./session";
import type { Correction, SearchX } from "./types";

const SOURCES: SearchSource[] = ["text", "name", "synonym", "inference"];
const like = (s: string) => `%${s.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

const wordsOf = (line: string) => line.replaceAll("〔不明〕", " ").split(/\s+/).filter(Boolean);

function termsOf(row: ItemRow): SearchTerms {
  const t = parseJson<Partial<SearchTerms>>(row.search_terms);
  const fix = parseJson<Correction>(row.correction_json);
  const reading = parseJson<ItemReading & { checked?: { text: string }[] }>(row.reading_json);
  const fixed = fix?.lines ?? {};
  // 訂正された行の元の語は外す。訂正後の文字と、訂正していない行に同じ語があれば残す
  const alive = new Set([
    ...(reading?.checked ?? []).flatMap((l, i) => (fixed[String(i)] ? [] : wordsOf(l.text))),
    ...Object.values(fixed).flatMap((l) => wordsOf(l.text)),
  ]);
  const wrong = [...new Set(Object.values(fixed).flatMap((l) => wordsOf(l.original ?? "")))].filter(
    (w) => !alive.has(w),
  );
  const stillTrue = (term: string) => !wrong.some((w) => w.length >= 2 && term.includes(w));
  return {
    // 家族の訂正は、読めた文字として探せるようにする
    text: [
      ...(t?.text ?? []).filter((w) => !wrong.includes(w)),
      ...Object.values(fixed).flatMap((l) => [l.text, ...wordsOf(l.text)]),
    ],
    // 物の名前を直したら、元の種類の語では「物名で一致」にしない
    name: fix?.title ? [fix.title] : [...(t?.name ?? []), ...(row.title ? [row.title] : [])],
    synonym: (t?.synonym ?? []).filter(stillTrue),
    inference: (t?.inference ?? []).filter(stillTrue),
  };
}

export const searchRoutes = new Hono<AppEnv>();

searchRoutes.get("/", async (c) => {
  const pid = c.req.param("pid")!;
  const words = clip(c.req.query("q"), 100).split(/\s+/).filter(Boolean).slice(0, 5);
  if (!words.length) return c.json<SearchX>({ hits: [] });
  const cond = words
    .map(
      () =>
        `(i.search_terms LIKE ? ESCAPE '\\' OR i.title LIKE ? ESCAPE '\\' OR i.correction_json LIKE ? ESCAPE '\\')`,
    )
    .join(" AND ");
  const { results } = await c.env.DB.prepare(
    `${SELECT_ITEM} AND ${cond} ORDER BY i.rank_score IS NULL, i.rank_score DESC, i.seq DESC`,
  )
    .bind(c.get("user")!.id, pid, ...words.flatMap((w) => [like(w), like(w), like(w)]))
    .all<ItemRow>();

  const hits: SearchX["hits"] = [];
  for (const row of results) {
    const terms = termsOf(row);
    const matched: SearchX["hits"][number]["matched"] = [];
    const allFound = words.every((w) => {
      const lw = w.toLowerCase();
      let found = false;
      for (const source of SOURCES) {
        const term = terms[source].find((t) => t.toLowerCase().includes(lw));
        if (!term) continue;
        found = true;
        if (!matched.some((m) => m.source === source && m.term === term)) {
          matched.push({ source, term });
        }
      }
      return found;
    });
    if (allFound) hits.push({ item: toCard(pid, row), matched });
  }
  return c.json<SearchX>({ hits });
});
