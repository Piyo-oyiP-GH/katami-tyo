// 手がかりの多い順。計画 3 章の式をそのまま計算する。各項は有る無しで数え、個数では増やさない。
// 大切さの順ではない。理由の文に、読めた文字は入れない。
import type { Level, Observation, SearchTerms } from "../types";
import { itemConfidence, UNKNOWN, unsureRotated } from "./confidence";
import type { CheckedLine, CheckedReading, ItemCorrection, Signal } from "./types";

const C: Record<Level, number> = { high: 1, mid: 0.7, low: 0.4 };
export const LEVEL_LABEL: Record<Level, string> = {
  high: "はっきり",
  mid: "一部あやしい",
  low: "読みにくい",
};

function bestLevel(lines: CheckedLine[]): Level | null {
  if (lines.some((l) => l.level === "high")) return "high";
  if (lines.some((l) => l.level === "mid")) return "mid";
  return lines.length ? "low" : null;
}

const nameLabel = (lines: CheckedLine[], best: Level) =>
  lines.some((l) => l.family) ? "家族の訂正" : LEVEL_LABEL[best];

// b が null なのは、物の観察ができなかったとき。手がかりが無いのではなく、見ていない
export function rank(lines: CheckedLine[], b: Observation | null) {
  const has = (s: Signal) => b?.signals.includes(s) ?? false;
  const handLines = lines.filter((l) => l.handwritten);
  const handwritten = handLines.length > 0 || has("手書き");
  const name = bestLevel(lines.filter((l) => l.type === "name"));
  const date = bestLevel(lines.filter((l) => l.type === "date"));

  const score =
    (handwritten ? 3 : 0) +
    (name ? 3 * C[name] : 0) +
    (date ? 2 * C[date] : 0) +
    (has("宛名や署名") ? 2 : 0) +
    (has("紙焼きの原本") ? 2 : 0) +
    (has("古び") ? 1 : 0);

  // 読めない手書きは点を残し、撮り直し候補にする
  const needsRetake =
    b === null ||
    (has("手書き") && handLines.length === 0) ||
    handLines.some((l) => l.level === "low" || l.text.includes(UNKNOWN));

  const parts: string[] = [];
  if (handwritten) parts.push("手書き");
  if (name) parts.push(`人名（${nameLabel(lines.filter((l) => l.type === "name"), name)}）`);
  if (date) parts.push(`日付（${nameLabel(lines.filter((l) => l.type === "date"), date)}）`);
  if (has("宛名や署名")) parts.push("宛名や署名");
  if (has("紙焼きの原本")) parts.push("紙焼きの写真");
  if (has("古び")) parts.push("古び");
  let reason = parts.length ? `手がかり：${parts.join("、")}。` : "";
  if (b === null) reason += "物の観察ができませんでした。";
  else if (!reason) reason = "手がかりは見つかっていません。";
  if (lines.some(unsureRotated)) reason += "字を上に向けて撮り直す候補です。";
  else if (needsRetake) reason += "撮り直し候補です。";

  return { score: Math.round(score * 100) / 100, reason, needsRetake };
}

// 「違う」のあと、訂正済みの読みで計算し直す。読み取りの列は変えない
export function reapplyCorrection(reading: CheckedReading, fix: ItemCorrection, ceiling: Level) {
  const lines = reading.checked.map((l, i): CheckedLine => {
    const text = fix.lines?.[String(i)]?.text;
    if (!text) return l;
    return { ...l, text, family: true, rotated: false, certainty: "high", agreement: "high", level: "high" };
  });
  return {
    ...rank(lines, reading.b),
    confidence: itemConfidence(lines, ceiling, reading.a2 === null),
  };
}

// 検索の語。一致元を出せるよう、出どころごとに分けて持つ
export function searchTerms(lines: CheckedLine[], b: Observation | null): SearchTerms {
  const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
  return {
    // 逆さや横向きの手書きは読み違いが多い。「文字で一致」と出さないよう検索に入れない。
    // 数字や日付で A と A2 が同じ行は、数字で探せるよう残す
    text: uniq(
      lines
        .filter((l) => !unsureRotated(l))
        .flatMap((l) => l.text.replaceAll(UNKNOWN, " ").split(/\s+/)),
    ),
    name: uniq(b ? [b.kind] : []),
    synonym: uniq(b?.synonyms ?? []),
    // 文字の裏付けが無く下げた文は、検索に入れない。写真に無い字で物が見つかってしまう
    inference: uniq((b?.inferences ?? []).filter((t) => !b?.moved?.includes(t))),
  };
}
