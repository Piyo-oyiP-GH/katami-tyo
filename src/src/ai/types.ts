// AI 担当だけが使う型。共有の型は ../types.ts にある。
import type { AiRunMeta, ItemReading, Level, Observation, ReadLine, SearchTerms } from "../types";

// B が見たと報告してよい印。順位の点はこの語で数える
export const SIGNALS = ["手書き", "宛名や署名", "紙焼きの原本", "古び"] as const;
export type Signal = (typeof SIGNALS)[number];

// B の生の出力
export type RawObservation = Observation & { proper_nouns: string[] };

// 確かめた後の 1 行。level が画面に出す確からしさ
export type CheckedLine = ReadLine & {
  rotated?: boolean; // 写真の中で字が逆さや横向き
  source: "a" | "a2"; // a2 は、A に無く再読だけが読んだ行
  agreement: Level | null; // A と A2 の一致。比べない行は null
  level: Level; // min(本人申告, 一致, 画像の上限)
  family?: boolean; // 家族の訂正で直した行
};

// reading_json の中身。ItemReading に checked を足した形
export type CheckedReading = ItemReading & { checked: CheckedLine[] };

export type GuardCounts = {
  banned_hits: number; // 判断の語を含んでいた項目の数（作り直す前）
  regenerated: boolean; // B を作り直したか
  banned_removed: number; // 作り直しても残り、消した項目の数
  downgraded: number; // 文字の裏付けが無く、見立てに下げた項目の数
  topic_hits: number; // 健康、お金、人間関係の見立ての数（作り直す前）
  topic_removed: number; // 作り直しても残り、消した見立ての数
  evidence_empty: boolean; // 作り直しても、見えたことが空だった
  reread_error?: string; // 再読だけ失敗した。全体は「はっきり」にしない
};

// ai_meta_json の中身。計測だけ。読んだ文字を入れない
export type AiRunMetaExt = AiRunMeta & { orientation: number; guard?: GuardCounts };

export type ItemCardFields = {
  title: string | null;
  confidence: Level | null; // 文字が 1 行も無ければ null
  rank_score: number;
  rank_reason: string;
  needs_retake: boolean;
  search_terms: SearchTerms;
  reading: CheckedReading;
  error_code: string | null; // 片方だけ失敗した物の印。observe_（物の観察）か read_（文字）で始まる
};

// items.correction_json のうち、AI 担当が読む分。家族の訂正は読み取りより優先する
export type ItemCorrection = {
  title?: string;
  lines?: Record<string, { text: string; original: string | null }>; // 番号は reading.checked の並び
};

// ---- 人物カードの差分。Claude はこの形で提案し、コードが確かめて適用する ----
export type DiffItem = { no: number; quote: string }; // no は items.seq、quote は根拠の字
export type AddOp = {
  kind: "name" | "hypothesis";
  person: string; // P1 のような札の番号、OWNER、NEW
  new_label: string; // NEW のときの名前
  text: string; // 仮説の文。name では使わない
  items: DiffItem[];
};
export type UpdateOp = { claim: string; text: string; add_items: DiffItem[]; remove_nos: number[] };
export type RetireOp = { claim: string };
export type PersonsDiff = { add: AddOp[]; update: UpdateOp[]; retire: RetireOp[] };

export type PersonsApplied = {
  persons: number;
  names: number;
  hypotheses: number;
  updated: number;
  retired: number;
};
// 退けた数。中身は記録しない
export type PersonsRejected = {
  unknown_item: number; // 実在しない番号
  unknown_ref: number; // 渡していない札や項目の番号
  no_support: number; // 読みや観察に根拠が無い
  bad_label: number; // 読めた名前と合わない人物名
  topic: number; // 健康、お金、人間関係
  banned: number; // 判断の語
  unsupported: number; // 文の中の引用、年、人名に裏付けが無い。「〜かもしれません」の形でない
};

// projects.persons_meta_json。数だけ
export type PersonsRunMeta = {
  at: number;
  batch: number;
  images: number;
  model: string | null;
  effort: string;
  seconds: number;
  input_tokens: number;
  output_tokens: number;
  fallback_used: boolean;
  applied: PersonsApplied;
  rejected: PersonsRejected;
  dropped_links: number; // 確かめ直しで外れたつながり
  retired_empty: number; // つながりが無くなって取り下げた項目
  error?: string;
};
