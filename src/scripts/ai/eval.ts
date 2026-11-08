// 実写真の評価。Worker を通さず、同じ readPhoto を Node から呼ぶ。
// 読めた文字を含む結果は --out にだけ書き、画面には数だけ出す。--out はリポジトリの外に限る。
//   node scripts/ai/run-eval.mjs --dir <写真のフォルダ> --glob IMG_ --out <フォルダ> --round r1 [--ceiling high] [--limit 3]
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isInside } from "../lib/paths.mjs";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { exifOrientation } from "../../src/ai/photo";
import { readPhoto } from "../../src/ai/pipeline";
import type { Level } from "../../src/types";

const { values: arg } = parseArgs({
  options: {
    dir: { type: "string" },
    glob: { type: "string", default: "" },
    out: { type: "string" },
    round: { type: "string", default: "r1" },
    ceiling: { type: "string", default: "high" },
    limit: { type: "string" },
    concurrency: { type: "string", default: "4" },
    repo: { type: "string" },
  },
});
if (!arg.dir || !arg.out || !arg.repo) {
  console.error("--dir と --out と --repo が要ります");
  process.exit(2);
}
const repo = path.resolve(arg.repo);
const out = path.resolve(arg.out, arg.round);
if (isInside(repo, out)) {
  console.error("--out はリポジトリの外にしてください");
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const files = readdirSync(arg.dir)
  .filter((f) => f.startsWith(arg.glob!) && f.endsWith(".jpg"))
  .sort()
  .slice(0, arg.limit ? Number(arg.limit) : undefined);

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2 });
const results: Record<string, unknown>[] = [];

async function one(file: string) {
  const bytes = readFileSync(path.join(arg.dir!, file));
  const started = Date.now();
  const base64 = bytes.toString("base64");
  try {
    const r = await readPhoto(client, base64, arg.ceiling as Level);
    const seconds = (Date.now() - started) / 1000;
    const orientation = exifOrientation(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
    results.push({ file, bytes: bytes.length, orientation, seconds, ...r });
  } catch (e) {
    results.push({ file, outcome: "threw", error: e instanceof Error ? e.name : "unknown" });
  }
}

const queue = [...files];
await Promise.all(
  Array.from({ length: Number(arg.concurrency) }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) await one(f);
  }),
);
results.sort((x, y) => String(x.file).localeCompare(String(y.file)));
writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));

type Done = {
  outcome: "done";
  seconds: number;
  guard: { banned_hits: number; regenerated: boolean; banned_removed: number; downgraded: number };
  fields: {
    confidence: Level;
    needs_retake: boolean;
    reading: { checked: { source: string; type: string; agreement: Level | null; level: Level }[] };
  };
};
const done = results.filter((r) => r.outcome === "done") as unknown as Done[];
const lines = done.flatMap((r) => r.fields.reading.checked);
const key = lines.filter((l) => l.type !== "other");
const tally = <T>(xs: T[]) =>
  xs.reduce<Record<string, number>>((m, x) => ((m[String(x)] = (m[String(x)] ?? 0) + 1), m), {});

const summary = {
  photos: files.length,
  outcomes: tally(results.map((r) => r.outcome)),
  seconds_max: Math.max(...done.map((r) => r.seconds)),
  seconds_avg: done.reduce((s, r) => s + r.seconds, 0) / (done.length || 1),
  lines: lines.length,
  key_lines: key.length,
  a2_only: lines.filter((l) => l.source === "a2").length,
  agreement: tally(key.map((l) => l.agreement)),
  line_level: tally(lines.map((l) => l.level)),
  item_confidence: tally(done.map((r) => r.fields.confidence)),
  needs_retake: done.filter((r) => r.fields.needs_retake).length,
  banned_hits: done.reduce((s, r) => s + r.guard.banned_hits, 0),
  regenerated: done.filter((r) => r.guard.regenerated).length,
  banned_removed: done.reduce((s, r) => s + r.guard.banned_removed, 0),
  downgraded: done.reduce((s, r) => s + r.guard.downgraded, 0),
};
writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
