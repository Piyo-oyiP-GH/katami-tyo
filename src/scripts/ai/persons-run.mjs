// 実写真を順に入れて、人物カードの更新が壊れないかを確かめる。本物の Claude を呼ぶ。
// 読めた文字は --out にだけ書く。画面には数だけ出す。--out と --state はリポジトリの外に限る。
// --dir の写真は名前の順に入れる。「名前.jpg.thumb」があれば縮小画像として送る。
//   node scripts/ai/persons-run.mjs --dir <写真> --out <フォルダ> --state <フォルダ> [--limit 10] [--port 8799]
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isInside } from "../lib/paths.mjs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: arg } = parseArgs({
  options: {
    dir: { type: "string" },
    out: { type: "string" },
    state: { type: "string" },
    limit: { type: "string", default: "10" },
    port: { type: "string", default: "8799" },
  },
});
if (!arg.dir || !arg.out || !arg.state) {
  console.error("--dir、--out、--state が要ります");
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repo = path.resolve(root, "..");
const out = path.resolve(arg.out);
const state = path.resolve(arg.state);
for (const p of [out, state]) {
  if (isInside(repo, p)) {
    console.error("--out と --state はリポジトリの外にしてください");
    process.exit(2);
  }
}
mkdirSync(out, { recursive: true });
const PORT = Number(arg.port);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const env = { ...process.env, MATTA_STATE_DIR: state };
const procs = [];
const run = (args) => {
  const p = spawn(process.execPath, args, { cwd: root, env, stdio: "ignore" });
  procs.push(p);
  return p;
};
process.on("exit", () => {
  for (const p of procs) spawnSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" });
});

await new Promise((resolve, reject) =>
  run(["scripts/dev.mjs", "migrate"]).on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`migrate ${c}`)))),
);
run(["scripts/dev.mjs", "dev", "--port", String(PORT), "--inspector-port", String(PORT + 500)]);
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${BASE}/api/health`)).ok) break;
  } catch {
    // 起動を待つ
  }
  if (i > 120) throw new Error("サーバが起動しませんでした");
  await sleep(500);
}

const made = await fetch(`${BASE}/api/projects`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ title: "評価の箱", display_name: "評価" }),
});
const cookie = made.headers.get("set-cookie").split(";")[0];
const { project_id: pid } = await made.json();
const headers = { cookie };
const get = async (p) => (await fetch(`${BASE}/api/p/${pid}${p}`, { headers })).json();
const post = (p, json) =>
  fetch(`${BASE}/api/p/${pid}${p}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(json),
  });

const TOPIC = /病|薬|通院|入院|介護|健康|お金|借金|貯金|収入|財産|遺産|年金|友人|親友|恋人|夫婦|親子|親戚|家族|大切|貴重/;
const strengthOf = (n) => (n >= 10 ? "strong" : n >= 3 ? "mid" : n >= 1 ? "weak" : null);
const key = (s) => s.normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();

const problems = [];
function audit(tag, data, items, details) {
  const known = new Set(items.map((i) => i.id));
  const labels = data.persons.map((p) => key(p.label));
  if (new Set(labels).size !== labels.length) problems.push(`${tag}: 同じ名前の札`);
  for (const p of data.persons) {
    const seen = new Set();
    for (const c of p.claims) {
      if (c.item_ids.some((id) => !known.has(id))) problems.push(`${tag}: 実在しない物`);
      if (c.clear_item_ids.some((id) => !c.item_ids.includes(id))) problems.push(`${tag}: はっきりが関連の外`);
      if (c.source === "family") {
        if (c.strength !== null || c.clear_item_ids.length) problems.push(`${tag}: 家族に強さ`);
        continue;
      }
      if (c.strength !== strengthOf(c.clear_item_ids.length + c.seen_item_ids.length)) problems.push(`${tag}: 強さが数と合わない`);
      if (c.source === "claude" && TOPIC.test(c.text)) problems.push(`${tag}: 止める話題が残った`);
      if (seen.has(c.text)) problems.push(`${tag}: 同じ文が 2 つ`);
      seen.add(c.text);
      // はっきりと数えた物に、本当にはっきりの行があるか
      for (const id of c.clear_item_ids) {
        const d = details.get(id);
        const lines = d?.reading?.checked ?? [];
        const okName = lines.some((l) => l.type === "name" && l.level === "high");
        const okAny = lines.some((l) => l.level === "high") || d?.item.confidence === "high";
        if (c.source === "photo" ? !okName : !okAny) problems.push(`${tag}: はっきりの根拠が無い`);
      }
    }
  }
}

const count = (d) => ({
  persons: d.persons.length,
  names: d.persons.flatMap((p) => p.claims).filter((c) => c.source === "photo").length,
  hypotheses: d.persons.flatMap((p) => p.claims).filter((c) => c.source === "claude").length,
  family: d.persons.flatMap((p) => p.claims).filter((c) => c.source === "family").length,
  strength: d.persons
    .flatMap((p) => p.claims)
    .filter((c) => c.source !== "family")
    .reduce((m, c) => ((m[c.strength ?? "none"] = (m[c.strength ?? "none"] ?? 0) + 1), m), {}),
});

let lastUpdated = null;
let snaps = 0;
let noted = false;
const runs = [];
async function snapshot() {
  const data = await get("/persons");
  if (data.updated_at === lastUpdated) return data;
  lastUpdated = data.updated_at;
  snaps++;
  const { items } = await get("/items");
  const details = new Map();
  for (const i of items) details.set(i.id, await get(`/items/${i.id}`));
  audit(`更新${snaps}`, data, items, details);
  writeFileSync(path.join(out, `snap_${snaps}.json`), JSON.stringify({ data, items }, null, 2));
  runs.push({ snap: snaps, items: items.length, ...count(data), meta: data.meta });
  console.log(JSON.stringify(runs.at(-1)));

  // 1 回目の更新の後に、家族のメモを足す。後の更新で消えないことを見る
  if (!noted && data.persons.length) {
    noted = true;
    const res = await post(`/persons/${data.persons[0].id}/claims`, { text: "家族の架空のメモ" });
    if (res.status !== 201) problems.push("家族のメモを書けない");
  }
  return data;
}

const files = readdirSync(arg.dir)
  .filter((f) => f.endsWith(".jpg"))
  .sort()
  .slice(0, Number(arg.limit));
for (const file of files) {
  const res = await fetch(`${BASE}/api/p/${pid}/items?pile=unsure`, {
    method: "POST",
    headers: { ...headers, "content-type": "image/jpeg" },
    body: readFileSync(path.join(arg.dir, file)),
  });
  const body = await res.json();
  if (res.status !== 202) {
    problems.push(`登録 ${res.status} ${body.error}`);
    continue;
  }
  const thumb = path.join(arg.dir, `${file}.thumb`);
  if (existsSync(thumb)) {
    await fetch(`${BASE}/api/p/${pid}/items/${body.item.id}/thumb`, {
      method: "PUT",
      headers: { ...headers, "content-type": "image/jpeg" },
      body: readFileSync(thumb),
    });
  }
  for (let i = 0; i < 120; i++) {
    const d = await get(`/items/${body.item.id}`);
    if (d.item.status === "done" || d.item.status === "failed") break;
    await sleep(1000);
  }
  await snapshot();
}

// 最後の物が 60 秒の遅延で更新されるのを待つ
let data = await snapshot();
const t0 = Date.now();
const firstSnaps = snaps;
while (Date.now() - t0 < 200_000) {
  data = await snapshot();
  const pendingDone = data.meta && snaps > firstSnaps;
  if (pendingDone && Date.now() - t0 > 75_000) break;
  await sleep(2000);
}

// 「違う」を、名前で結び付いた物に当てる。架空の字に直すと、そのつながりが外れるはず
const named = data.persons.flatMap((p) => p.claims).find((c) => c.source === "photo");
let correction = "名前のつながりが無いので未実施";
if (named) {
  const target = named.item_ids[0];
  const detail = await get(`/items/${target}`);
  const lines = detail.reading.checked;
  const before = named.item_ids.length;
  // 札の名前を含む行を全部、架空の字に直す
  const label = key(named.person_label);
  const idxs = lines.flatMap((l, i) => (l.type === "name" && key(l.text).includes(label.slice(0, 2)) ? [i] : []));
  for (const i of idxs) await post(`/items/${target}/correction`, { line: i, text: "架空 花子" });
  let gone = false;
  for (let i = 0; i < 90 && !gone; i++) {
    await sleep(1000);
    data = await snapshot();
    const now = data.persons.flatMap((p) => p.claims).find((c) => c.id === named.id);
    gone = !now || !now.item_ids.includes(target);
  }
  correction = gone ? `外れた（行 ${idxs.length}、元の関連 ${before}）` : `外れない（行 ${idxs.length}）`;
  if (!gone) problems.push("訂正でつながりが外れない");
}

const family = data.persons.flatMap((p) => p.claims).filter((c) => c.source === "family").length;
if (noted && family !== 1) problems.push("家族のメモが消えた");
const { items } = await get("/items");
const summary = {
  files: files.length,
  status: items.reduce((m, i) => ((m[i.status] = (m[i.status] ?? 0) + 1), m), {}),
  updates: snaps,
  final: count(data),
  correction,
  problems,
};
writeFileSync(path.join(out, "runs.json"), JSON.stringify(runs, null, 2));
writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
process.exit(problems.length ? 1 : 0);
