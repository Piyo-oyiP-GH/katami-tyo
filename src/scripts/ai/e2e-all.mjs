// Worker を通した評価。1 つの見本 project に写真を全部入れ、キューの処理を待って一覧と詳細を保存する。
// サーバは先に起動しておく。読めた文字は --out にだけ書き、画面には数だけ出す。--out はリポジトリの外に限る。
//   node scripts/ai/e2e-all.mjs --dir <写真のフォルダ> --glob IMG_ --out <フォルダ> --base http://127.0.0.1:8792 [--ceiling high]
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isInside } from "../lib/paths.mjs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: arg } = parseArgs({
  options: {
    dir: { type: "string" },
    glob: { type: "string", default: "" },
    out: { type: "string" },
    base: { type: "string", default: "http://127.0.0.1:8791" },
    ceiling: { type: "string", default: "high" },
  },
});
if (!arg.dir || !arg.out) {
  console.error("--dir と --out が要ります");
  process.exit(2);
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const out = path.resolve(arg.out);
if (isInside(repo, out)) {
  console.error("--out はリポジトリの外にしてください");
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const guest = await fetch(`${arg.base}/api/guest`, { method: "POST" });
if (guest.status !== 201) throw new Error(`guest ${guest.status}`);
const cookie = guest.headers.get("set-cookie").split(";")[0];
const { project_id: pid } = await guest.json();
const headers = { cookie };

const files = readdirSync(arg.dir).filter((f) => f.startsWith(arg.glob) && f.endsWith(".jpg")).sort();
const started = performance.now();
const uploads = [];
for (const file of files) {
  const res = await fetch(`${arg.base}/api/p/${pid}/items?pile=unsure&ceiling=${arg.ceiling}`, {
    method: "POST",
    headers: { ...headers, "content-type": "image/jpeg" },
    body: readFileSync(path.join(arg.dir, file)),
  });
  const body = await res.json();
  uploads.push({ file, status: res.status, id: body.item?.id, error: body.error });
}

const ids = uploads.filter((u) => u.id).map((u) => u.id);
let list;
for (;;) {
  const r = await fetch(`${arg.base}/api/p/${pid}/items`, { headers });
  list = await r.json();
  const open = list.items.filter((i) => i.status !== "done" && i.status !== "failed");
  if (open.length === 0) break;
  if (performance.now() - started > 540_000) throw new Error(`timeout ${open.length}`);
  await new Promise((res) => setTimeout(res, 2000));
}
const seconds = (performance.now() - started) / 1000;

const details = [];
for (const id of ids) {
  const r = await fetch(`${arg.base}/api/p/${pid}/items/${id}`, { headers });
  const d = await r.json();
  const photo = await fetch(`${arg.base}/api/p/${pid}/items/${id}/photo`, { headers });
  await photo.arrayBuffer();
  details.push({ file: uploads.find((u) => u.id === id).file, photo_status: photo.status, ...d });
}
writeFileSync(path.join(out, "list.json"), JSON.stringify(list, null, 2));
writeFileSync(path.join(out, "details.json"), JSON.stringify(details, null, 2));

const tally = (xs) => xs.reduce((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
const lines = details.flatMap((d) => d.reading?.checked ?? []);
const guards = details.map((d) => d.meta?.guard).filter(Boolean);
const sum = (k) => guards.reduce((s, g) => s + Number(g[k]), 0);
const summary = {
  uploaded: tally(uploads.map((u) => u.status)),
  status: tally(list.items.map((i) => i.status)),
  errors: tally(list.items.flatMap((i) => (i.error_code ? [i.error_code] : []))),
  photos_served: tally(details.map((d) => d.photo_status)),
  total_seconds: Math.round(seconds),
  item_seconds_max: Math.max(...details.map((d) => d.meta?.total_seconds ?? 0)),
  calls: details.reduce((s, d) => s + (d.meta?.calls.length ?? 0), 0),
  fallback_used: details.flatMap((d) => d.meta?.calls ?? []).filter((c) => c.fallback_used).length,
  input_tokens: details.flatMap((d) => d.meta?.calls ?? []).reduce((s, c) => s + c.input_tokens, 0),
  output_tokens: details.flatMap((d) => d.meta?.calls ?? []).reduce((s, c) => s + c.output_tokens, 0),
  lines: lines.length,
  line_level: tally(lines.map((l) => l.level)),
  item_confidence: tally(list.items.flatMap((i) => (i.confidence ? [i.confidence] : []))),
  needs_retake: list.items.filter((i) => i.needs_retake).length,
  banned_hits: sum("banned_hits"),
  regenerated: sum("regenerated"),
  banned_removed: sum("banned_removed"),
  downgraded: sum("downgraded"),
  scores: list.items.map((i) => i.rank_score),
};
writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
