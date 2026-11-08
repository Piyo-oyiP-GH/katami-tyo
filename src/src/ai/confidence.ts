// 確からしさの計算。min(本人申告, A と A2 の一致, 画像の上限)。
// 同じモデルの再読なので、一致は「確認済み」を意味しない。
import type { Level, ReadLine, ReadResult } from "../types";
import type { CheckedLine } from "./types";

export const UNKNOWN = "〔不明〕";
const ORDER: Record<Level, number> = { low: 0, mid: 1, high: 2 };

export const minLevel = (...levels: Level[]): Level =>
  levels.reduce((m, l) => (ORDER[l] < ORDER[m] ? l : m), "high" as Level);

// 比べるための形。全角半角と大小をそろえ、空白と記号を消す
export function normalize(s: string): string {
  return s
    .replaceAll(UNKNOWN, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

// ---- 日付 ----
const ERA_START: Record<string, number> = { 明治: 1868, 大正: 1912, 昭和: 1926, 平成: 1989, 令和: 2019 };
const KANJI_DIGIT: Record<string, number> = {
  〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const KANJI_UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

// 四十→40、二〇〇一→2001、元→1
function kanjiNumber(s: string): number {
  if (s === "元") return 1;
  if (/^\d+$/.test(s)) return Number(s);
  if (![...s].some((ch) => ch in KANJI_UNIT)) {
    return Number([...s].map((ch) => KANJI_DIGIT[ch] ?? "").join(""));
  }
  let total = 0;
  let digit = 0;
  for (const ch of s) {
    if (ch in KANJI_UNIT) {
      total += (digit || 1) * KANJI_UNIT[ch]!;
      digit = 0;
    } else digit = KANJI_DIGIT[ch] ?? 0;
  }
  return total + digit;
}

// 日付は数の並びで比べる。元号は西暦に直す。2024.05.03 と 2024年5月3日 は同じ。
// 昭和3年 と 平成3年 は 61 年違うので別の物
function dateKey(s: string): string {
  const text = s
    .normalize("NFKC")
    .replace(
      /(明治|大正|昭和|平成|令和)\s*(\d+|元|[〇零一二三四五六七八九十百]+)\s*年?/g,
      (_, era: string, n: string) => `${ERA_START[era]! + kanjiNumber(n) - 1}年`,
    )
    .replace(/[〇零一二三四五六七八九十百千]+(?=\s*[年月日])/g, (n) => String(kanjiNumber(n)));
  const groups = text.match(/\d+/g) ?? [];
  return groups.length ? `-${groups.map((g) => g.replace(/^0+(?=\d)/, "")).join("-")}-` : "";
}

function contains(long: string, short: string): boolean {
  if (!short || !long) return false;
  if (short.length >= 2) return long.includes(short);
  // 1 字の数字は数の単位で比べる
  return long === short || [...long.matchAll(/\d+/g)].some((m) => m[0] === short);
}

const nameKey = (s: string) => normalize(s).replace(/(様|さま|殿|さん|御中|先生)$/u, "");
const digitsOf = (s: string) => s.normalize("NFKC").replace(/\D/g, "");

// 日付の表し方の字を除いた残り。日付の行に混ざった人名などを見分ける
const dateRest = (s: string) =>
  normalize(s).replace(/明治|大正|昭和|平成|令和|[0-9〇零一二三四五六七八九十百千元年月日]/g, "");
const digitRest = (s: string) => normalize(s).replace(/[0-9a-z]/g, "");

// 数字や日付は同じで、残りの字が読み比べられていない行。
// 「TEL」「重さ」「杯分」のような添え字は見ない。それ以外の 2 字以上が片方だけにあれば、
// 人名かもしれないので同じと言わない
const LABEL_WORDS =
  /^(?:重さ|長さ|高さ|幅|杯分|杯|電話|番号|定価|価格|税込|送料|第|約|円|枚|号|個|本|冊|回|歳|才|部|巻|頁|番|午前|午後|頃|ごろ|曜|火|水|木|金|土|生|発行)+$/u;
function restDiffers(x: string, y: string): boolean {
  const [long, short] = x.length >= y.length ? [x, y] : [y, x];
  if (!long.includes(short)) return true;
  const extra = long.replace(short, "");
  return extra.length >= 2 && !LABEL_WORDS.test(extra);
}

// A と A2 の比べ方。same は読みの全体が同じ。partial は片方がもう片方の一部で、残りの字は読み比べていない。
// 字が落ちた読みを同じと見ないよう、人名、日付、数字は全体が同じときだけ same にする。
// 敬称と記号の違いだけは同じと見る。文の行（other）だけ、ほぼ同じ長さなら同じと見る
export type Match = "same" | "partial" | "none";
const NEAR_EQUAL = 0.8;

export function compareReading(x: ReadLine, y: ReadLine): Match {
  if (x.type === "date" || y.type === "date") {
    const kx = dateKey(x.text);
    const ky = dateKey(y.text);
    if (kx && ky) {
      if (kx === ky) return restDiffers(dateRest(x.text), dateRest(y.text)) ? "partial" : "same";
      return kx.includes(ky) || ky.includes(kx) ? "partial" : "none";
    }
  }
  const nx = nameKey(x.text);
  const ny = nameKey(y.text);
  if (!nx || !ny) return "none";
  if (nx === ny) return "same";
  if (x.type === "number" || y.type === "number") {
    const dx = digitsOf(x.text);
    if (dx && dx === digitsOf(y.text)) {
      return restDiffers(digitRest(x.text), digitRest(y.text)) ? "partial" : "same";
    }
  }
  const [long, short] = nx.length >= ny.length ? [nx, ny] : [ny, nx];
  if (!contains(long, short)) return "none";
  const prose = x.type === "other" && y.type === "other" && digitsOf(x.text) === digitsOf(y.text);
  return prose && short.length / long.length >= NEAR_EQUAL ? "same" : "partial";
}

export const sameReading = (x: ReadLine, y: ReadLine) => compareReading(x, y) !== "none";

function similarity(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + cost);
    }
    row = next;
  }
  return 1 - row[b.length]! / Math.max(a.length, b.length);
}

const tokensOf = (s: string) =>
  [s, ...s.normalize("NFKC").split(/\s+/)].map(normalize).filter((t) => t.length >= 2);

// 同じ物を別の字に読んだらしい組。どちらかは必ず誤り。種類が違っても比べる。
// 長い行の中の 1 語の読み違いも拾うよう、語ごとにも比べる
function conflicts(x: ReadLine, y: ReadLine): boolean {
  return tokensOf(x.text).some((a) => tokensOf(y.text).some((b) => similarity(a, b) >= 0.5));
}

const isKey = (l: ReadLine) => l.type !== "other";

// 逆さや横向きの手書きは、実測で意味の通る別の文に読み違えた。本人の申告によらず low にする。
// ただし短い数字や日付で A と A2 が全く同じなら、読めたと見て mid までにする
export const isRotatedHand = (l: ReadLine & { rotated?: boolean }) => l.handwritten && !!l.rotated;
const isNumeric = (l: ReadLine) => l.type === "number" || l.type === "date";

// 向きのせいで読みを信じない行。撮り直しを勧め、検索にも入れない
export const unsureRotated = (l: CheckedLine) =>
  isRotatedHand(l) && !(isNumeric(l) && l.agreement === "high");

// 不明の字がある行は、本人が high と言っても high にしない
function selfLevel(l: ReadLine, agreement: Level | null = null): Level {
  if (isRotatedHand(l)) return isNumeric(l) && agreement === "high" ? minLevel(l.certainty, "mid") : "low";
  if (!l.text.includes(UNKNOWN)) return l.certainty;
  return normalize(l.text) ? minLevel(l.certainty, "mid") : "low";
}

// A の 1 行と再読の一致。null は比べていない行。
// - 再読に同じ読みがあれば high
// - 再読と食い違えば low。一部だけ合っていても食い違いを先に見る
// - 一部だけ合う行と、人名、日付、数字で再読に見当たらない行は mid
// - 数字の無い other は、手書きでも再読の対象でないので比べていない（null）
function agreementOf(line: ReadLine, rereads: ReadLine[], unmatched: ReadLine[]): Level | null {
  const results = rereads.map((r) => compareReading(line, r));
  if (results.includes("same")) return "high";
  if (unmatched.some((r) => conflicts(line, r))) return "low";
  if (isKey(line) || digitsOf(line.text)) return "mid";
  return null;
}

export function checkLines(a: ReadResult, a2: ReadResult | null, ceiling: Level): CheckedLine[] {
  const rereadLines = a2?.lines ?? [];
  const matched = new Set<ReadLine>();
  for (const line of a.lines) {
    for (const r of rereadLines) if (sameReading(line, r)) matched.add(r);
  }
  const unmatched = rereadLines.filter((r) => !matched.has(r));

  const checked: CheckedLine[] = a.lines.map((line) => {
    const agreement = agreementOf(line, rereadLines, unmatched);
    const same = rereadLines.filter((r) => sameReading(line, r));
    const self = minLevel(selfLevel(line, agreement), ...same.map((r) => selfLevel(r, agreement)));
    return { ...line, source: "a", agreement, level: minLevel(self, agreement ?? "high", ceiling) };
  });

  for (const r of unmatched) {
    if (!normalize(r.text)) continue; // 読めなかったという行は、A の側で足りている
    const agreement: Level = a.lines.some((l) => conflicts(l, r)) ? "low" : "mid";
    checked.push({
      ...r,
      source: "a2",
      agreement,
      level: minLevel(selfLevel(r), agreement, ceiling),
    });
  }
  return checked;
}

// 複数の行を 1 つの段階にまとめる。全部 high なら high、全部 low なら low、混ざれば mid（一部あやしい）
function overall(levels: Level[]): Level {
  if (levels.every((l) => l === "high")) return "high";
  return levels.every((l) => l === "low") ? "low" : "mid";
}

// 物全体の確からしさ。min(本人申告, A と A2 の一致, 画像の上限)。
// 人名、日付、数字、手書きの行で決める。それらが無ければ全部の行で決める。
// 文字が 1 行も無ければ、読みそのものが無いので null。「はっきり」と出さない
export function itemConfidence(
  lines: CheckedLine[],
  ceiling: Level,
  rereadMissing: boolean,
): Level | null {
  if (!lines.length) return null;
  const key = lines.filter((l) => isKey(l) || l.handwritten);
  // 再読だけが読んだ行で、A の読みの全体を決めない
  const used = key.some((l) => l.source === "a") ? key : lines;
  const agreements = used.flatMap((l) => (l.agreement ? [l.agreement] : []));
  return minLevel(
    ceiling,
    rereadMissing ? "mid" : "high",
    // 行の level には、A の本人申告に再読の本人申告も入っている
    overall(used.map((l) => l.level)),
    overall(agreements),
  );
}
