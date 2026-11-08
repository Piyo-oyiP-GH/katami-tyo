// 写真 1 枚の読み取り全体。D1 と R2 に触らないので、Worker の外でも同じものを動かせる。
import Anthropic from "@anthropic-ai/sdk";
import type { AiCallMeta, Level, ReadResult, Scene } from "../types";
import { checkLines, itemConfidence, minLevel } from "./confidence";
import { countBanned, countTopics, downgrade, removeBanned, removeTopics } from "./guard";
import { rank, searchTerms } from "./rank";
import {
  callObserve,
  callReadAll,
  callReread,
  callScene,
  REDO_EVIDENCE_NOTE,
  REDO_KEEP_EVIDENCE_NOTE,
  REDO_NOTE,
  REDO_TOPIC_NOTE,
  RefusedError,
  TruncatedError,
} from "./read";
import { checkScene } from "./scene";
import type { GuardCounts, ItemCardFields, RawObservation } from "./types";

export type PipelineResult =
  | { outcome: "done"; fields: ItemCardFields; calls: AiCallMeta[]; guard: GuardCounts }
  | { outcome: "failed"; code: string; calls: AiCallMeta[]; status?: number; message?: string }
  | { outcome: "retry"; calls: AiCallMeta[]; status?: number; message?: string };

type Failure = { kind: "transient" | "permanent"; code: string; status?: number; message?: string };

export function classify(e: unknown): Failure {
  if (e instanceof RefusedError) return { kind: "permanent", code: "refused" };
  if (e instanceof TruncatedError) return { kind: "permanent", code: "truncated" };
  if (e instanceof Anthropic.APIError) {
    const transient =
      e instanceof Anthropic.RateLimitError ||
      e instanceof Anthropic.InternalServerError ||
      e instanceof Anthropic.APIConnectionError;
    return {
      kind: transient ? "transient" : "permanent",
      code: e.status === 413 ? "photo_too_large_for_api" : "api_error",
      status: e.status,
      message: e.message.slice(0, 300),
    };
  }
  return { kind: "transient", code: "unknown" }; // 壊れた JSON など。もう一度読めば直る見込みがある
}

const cleanRead = (r: ReadResult): ReadResult => ({
  lines: r.lines.filter((l) => l.text.trim()).map((l) => ({ ...l, text: l.text.trim() })),
});

// 作り直しの答えのまとめ方。話題だけの作り直しは見立てしか頼んでいないので、見立てだけを受け取る。
// 見えたことが空で返ったときは、前の答えの見えたことを残す
function mergeRedo(first: RawObservation, redo: RawObservation, topicOnly: boolean): RawObservation {
  const proper_nouns = [...new Set([...first.proper_nouns, ...redo.proper_nouns])];
  if (topicOnly) return { ...first, inferences: redo.inferences, proper_nouns };
  return { ...redo, evidence: redo.evidence.length ? redo.evidence : first.evidence, proper_nouns };
}

// final は最後の試行。次が無いので、取れた分だけでカードを作る
export async function readPhoto(
  client: Anthropic,
  imageBase64: string,
  ceiling: Level,
  { final = false }: { final?: boolean } = {},
): Promise<PipelineResult> {
  const calls: AiCallMeta[] = [];
  const [ra, ra2, rb, rc] = await Promise.allSettled([
    callReadAll(client, imageBase64),
    callReread(client, imageBase64),
    callObserve(client, imageBase64),
    callScene(client, imageBase64),
  ]);
  for (const r of [ra, ra2, rb, rc]) if (r.status === "fulfilled") calls.push(r.value.meta);
  // C（対象と背景）は足し。失敗しても読み取り全体は止めず、無しで進める
  let scene: Scene | null = null;
  if (rc.status === "fulfilled") {
    try {
      scene = checkScene(rc.value.result);
    } catch {
      scene = null;
    }
  }

  const failures = [ra, ra2, rb].flatMap((r) =>
    r.status === "rejected" ? [classify(r.reason)] : [],
  );
  const usable = ra.status === "fulfilled" || rb.status === "fulfilled";
  const transient = failures.find((f) => f.kind === "transient");
  if (transient && !(final && usable)) {
    return { outcome: "retry", calls, status: transient.status, message: transient.message };
  }
  // 文字が読めなくても、物の観察が取れていれば捨てない。物の種類と見えたことをカードに残す
  const readFailure = ra.status === "rejected" ? classify(ra.reason) : null;
  if (readFailure && rb.status === "rejected") {
    return {
      outcome: "failed",
      code: readFailure.code,
      calls,
      status: readFailure.status,
      message: readFailure.message,
    };
  }

  const a = ra.status === "fulfilled" ? cleanRead(ra.value.result) : { lines: [] };
  const a2 = ra2.status === "fulfilled" ? cleanRead(ra2.value.result) : null;
  const reads = [a, a2];

  // 物の観察が断られた、途中で切れた。文字も無ければ、読めなかった物として扱う
  const observeFailure = rb.status === "rejected" ? classify(rb.reason) : null;
  if (observeFailure && !a.lines.length) {
    return {
      outcome: "failed",
      code: `observe_${observeFailure.code}`,
      calls,
      status: observeFailure.status,
      message: observeFailure.message,
    };
  }

  // 観察の検査。判断の語、健康やお金や人間関係の見立て、見えたことの空があれば 1 回だけ作り直し、
  // それでも残れば項目ごと消す
  const guard: GuardCounts = {
    banned_hits: 0,
    regenerated: false,
    banned_removed: 0,
    downgraded: 0,
    topic_hits: 0,
    topic_removed: 0,
    evidence_empty: false,
    ...(ra2.status === "rejected" ? { reread_error: classify(ra2.reason).code } : {}),
  };
  let raw: RawObservation | null = rb.status === "fulfilled" ? rb.value.result : null;
  if (raw) {
    guard.banned_hits = countBanned(raw, reads);
    guard.topic_hits = countTopics(raw);
    const empty = raw.evidence.length === 0;
    const first: RawObservation = raw;
    if (guard.banned_hits > 0 || guard.topic_hits > 0 || empty) {
      guard.regenerated = true;
      const note = [
        guard.banned_hits > 0 ? REDO_NOTE : "",
        guard.topic_hits > 0 ? REDO_TOPIC_NOTE : "",
        empty ? REDO_EVIDENCE_NOTE : REDO_KEEP_EVIDENCE_NOTE,
      ].join("");
      try {
        const redo = await callObserve(client, imageBase64, note);
        calls.push(redo.meta);
        raw = mergeRedo(first, redo.result, guard.banned_hits === 0 && !empty);
      } catch {
        // 作り直せなくても、下で項目ごと消すので進める
      }
    }
    guard.banned_removed = countBanned(raw, reads);
    if (guard.banned_removed > 0) raw = removeBanned(raw, reads);
  }
  const down = raw ? downgrade(raw, reads) : null;
  guard.downgraded = down?.downgraded ?? 0;
  // 話題の検査は下げた後に掛ける。見えたことから見立てへ移った文も通るため
  const clean = down ? removeTopics(down.observation) : null;
  guard.topic_removed = clean?.removed ?? 0;
  const b = clean?.observation ?? null;
  guard.evidence_empty = !!b && b.evidence.length === 0;

  const checked = checkLines(a, a2, ceiling);
  const ranked = rank(checked, b);
  const { score } = ranked;
  const reason = readFailure ? `文字の読み取りができませんでした。${ranked.reason}` : ranked.reason;
  const needsRetake = ranked.needsRetake || !!readFailure;
  const confidence = itemConfidence(checked, ceiling, a2 === null);
  return {
    outcome: "done",
    calls,
    guard,
    fields: {
      title: b?.kind ?? null,
      // 物の観察か文字の読みが欠けると裏が取れないので、はっきりとは言わない
      confidence: confidence && (b === null || readFailure) ? minLevel(confidence, "mid") : confidence,
      rank_score: score,
      rank_reason: reason,
      needs_retake: needsRetake,
      search_terms: searchTerms(checked, b),
      reading: { a, a2, b, checked, scene },
      error_code: readFailure
        ? `read_${readFailure.code}`
        : observeFailure
          ? `observe_${observeFailure.code}`
          : null,
    },
  };
}
