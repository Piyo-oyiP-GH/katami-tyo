// 人物カードの更新を Worker、D1、キューごと通す確かめ。Claude は置き換える。文字はすべて架空。
// 5 枚の境目、60 秒の遅延、同時実行 1、番号の検査、強さの変化、「違う」の優先を見る。
//   node scripts/ai/persons-stub-test.mjs --state <リポジトリの外のフォルダ>
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: arg } = parseArgs({
  options: { state: { type: "string" }, port: { type: "string", default: "8797" } },
});
if (!arg.state) {
  console.error("--state が要ります");
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const state = path.resolve(arg.state);
if (state.startsWith(path.resolve(root, "..") + path.sep)) {
  console.error("--state はリポジトリの外にしてください");
  process.exit(2);
}
mkdirSync(state, { recursive: true });
const PORT = Number(arg.port);
const STUB = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const NAME = "架空 太郎";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(label, ok, note = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "NG  "} ${label}${note ? `  (${note})` : ""}`);
}

// ---- Claude の代わり ----
const stub = { calls: 0, inFlight: 0, maxInFlight: 0, certainty: "high", lastInput: null, images: 0 };
const readReply = () => ({
  lines: [{ text: NAME, type: "name", handwritten: false, where: "上", rotated: false, certainty: stub.certainty }],
  kind: "架空の電子部品",
  synonyms: ["部品"],
  evidence: ["小さな金属の足がある"],
  signals: [],
  proper_nouns: [],
  inferences: [],
});
function personsReply(input) {
  const person = input.current_cards.find((c) => c.label === NAME);
  const nos = input.new_items.map((i) => i.no);
  const cites = nos.map((no) => ({ no, quote: NAME }));
  const claim = person?.claims.find((c) => c.kind === "name")?.claim;
  const hypo = input.current_cards.flatMap((c) => c.claims).find((c) => c.kind === "hypothesis");
  const parts = nos.map((no) => ({ no, quote: "架空の電子部品" }));
  return {
    add: [
      ...(claim
        ? []
        : [{ kind: "name", person: "NEW", new_label: `${NAME} 様`, text: "", items: cites }]),
      // どれも退けられるはずの提案
      { kind: "name", person: "NEW", new_label: "写真に無い 人", text: "", items: cites },
      { kind: "name", person: "P99", new_label: "", text: "", items: cites },
      ...input.new_items.flatMap((i) =>
        i.lines
          .filter((l) => l.family_corrected)
          .map((l) => ({
            kind: "name",
            person: "NEW",
            new_label: l.text,
            text: "",
            items: [{ no: i.no, quote: l.text }],
          })),
      ),
      { kind: "hypothesis", person: "OWNER", new_label: "", text: "通院していたのかもしれません", items: parts },
      { kind: "hypothesis", person: "OWNER", new_label: "", text: "番号違いの物かもしれません", items: [{ no: 9999, quote: "架空の電子部品" }] },
      ...(hypo
        ? []
        : [{ kind: "hypothesis", person: "OWNER", new_label: "", text: "電子工作をしていたのかもしれません", items: parts }]),
    ],
    update: [
      ...(claim ? [{ claim, text: "", add_items: [...cites, { no: 9999, quote: NAME }], remove_nos: [] }] : []),
      ...(hypo ? [{ claim: hypo.claim, text: "", add_items: parts, remove_nos: [] }] : []),
    ],
    retire: [{ claim: "C999" }],
  };
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const first = body.messages?.[0]?.content?.find((c) => c.type === "text")?.text ?? "";
    const isPersons = first.startsWith('{"current_cards"');
    let reply = readReply();
    if (isPersons) {
      stub.calls++;
      stub.inFlight++;
      stub.maxInFlight = Math.max(stub.maxInFlight, stub.inFlight);
      const input = JSON.parse(first);
      stub.lastInput = input;
      stub.images = body.messages[0].content.filter((c) => c.type === "image").length;
      reply = personsReply(input);
      await sleep(1500); // 重なりを見つけるために長めに持つ
      stub.inFlight--;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: "msg_stub",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: JSON.stringify(reply) }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  });
});
await new Promise((r) => server.listen(STUB, "127.0.0.1", r));

// ---- サーバ ----
const envFile = path.join(state, "test.env");
writeFileSync(
  envFile,
  `ANTHROPIC_API_KEY=stub\nANTHROPIC_BASE_URL=http://127.0.0.1:${STUB}\nSESSION_SECRET=${randomBytes(24).toString("hex")}\n`,
);
const env = { ...process.env, MATTA_STATE_DIR: path.join(state, "wrangler") };
const procs = [];
const run = (args) => {
  const p = spawn(process.execPath, args, { cwd: root, env, stdio: "ignore" });
  procs.push(p);
  return p;
};
const stopAll = () => {
  server.close();
  for (const p of procs) spawnSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" });
};
process.on("exit", stopAll);

await new Promise((resolve, reject) =>
  run(["scripts/dev.mjs", "migrate"]).on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`migrate ${c}`)))),
);
run(["scripts/dev.mjs", "dev", "--port", String(PORT), "--inspector-port", String(PORT + 500), "--env-file", envFile]);
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${BASE}/api/health`)).ok) break;
  } catch {
    // 起動を待つ
  }
  if (i > 120) throw new Error("サーバが起動しませんでした");
  await sleep(500);
}

// ---- 流れ ----
const made = await fetch(`${BASE}/api/projects`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ title: "試験の箱", display_name: "試験の人" }),
});
const cookie = made.headers.get("set-cookie").split(";")[0];
const { project_id: pid } = await made.json();
const headers = { cookie };
const photo = readFileSync(path.join(root, "public", "sample", "letter.jpg"));
const get = async (p) => (await fetch(`${BASE}/api/p/${pid}${p}`, { headers })).json();
const post = async (p, json) =>
  fetch(`${BASE}/api/p/${pid}${p}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(json),
  });
const upload = async () => {
  const r = await fetch(`${BASE}/api/p/${pid}/items?pile=unsure`, {
    method: "POST",
    headers: { ...headers, "content-type": "image/jpeg" },
    body: photo,
  });
  return (await r.json()).item;
};
async function allDone() {
  for (let i = 0; i < 240; i++) {
    const { items } = await get("/items");
    if (items.every((x) => x.status === "done" || x.status === "failed")) return items;
    await sleep(500);
  }
  throw new Error("読み取りが終わりません");
}
async function untilPersons(pred, ms) {
  const t0 = Date.now();
  for (;;) {
    const data = await get("/persons");
    if (pred(data)) return { data, ms: Date.now() - t0 };
    if (Date.now() - t0 > ms) return { data, ms: null };
    await sleep(500);
  }
}
const nameClaim = (d) => d.persons.find((p) => p.label === NAME)?.claims.find((c) => c.source === "photo");
const hypoClaim = (d) => d.persons.flatMap((p) => p.claims).find((c) => c.source === "claude");

// 1. 5 枚に足りないとき
await upload();
await upload();
await allDone();
const early = await get("/persons");
check("2 枚ではまだ動かない", stub.calls === 0 && early.persons.length === 0);

// 2. 60 秒の遅延で動く
const t60 = await untilPersons((d) => d.updated_at !== null, 90000);
check("5 枚に足りなくても約 60 秒で動く", t60.ms !== null, `${Math.round((t60.ms ?? 0) / 1000)} 秒待った`);
check("名前の札ができ、敬称が外れる", !!nameClaim(t60.data));
check("札は「はっきりしない人」", t60.data.persons.find((p) => p.label === NAME)?.subtype === "vague");
check("読めていない名前の札はできない", !t60.data.persons.some((p) => p.label.includes("写真に無い")));
check("2 個は弱", nameClaim(t60.data)?.strength === "weak", `はっきり ${nameClaim(t60.data)?.clear_item_ids.length}`);
check("持ち主の札に仮説が付く", hypoClaim(t60.data)?.person_label === "持ち主");
check("健康の仮説は入らない", !JSON.stringify(t60.data.persons).includes("通院"));
check("番号違いの仮説は入らない", !JSON.stringify(t60.data.persons).includes("番号違い"));
const m1 = t60.data.meta;
check("退けた数が記録される", m1.rejected.unknown_item >= 1 && m1.rejected.topic >= 1 && m1.rejected.bad_label >= 1 && m1.rejected.unknown_ref >= 2, JSON.stringify(m1.rejected));
check("写真も渡している", stub.images === 2, `${stub.images} 枚`);

// 3. 5 枚で動く
const callsBefore = stub.calls;
for (let i = 0; i < 5; i++) await upload();
await allDone();
const t5 = await untilPersons((d) => nameClaim(d)?.item_ids.length === 7, 30000);
check("5 枚たまると 60 秒を待たずに動く", t5.ms !== null && stub.calls > callsBefore, `${t5.ms} ms`);
check("7 個は中", nameClaim(t5.data)?.strength === "mid");

// 4. 一部あやしいの読みは数えない
stub.certainty = "mid";
for (let i = 0; i < 5; i++) await upload();
await allDone();
const tm = await untilPersons((d) => nameClaim(d)?.item_ids.length === 12, 30000);
const c12 = nameClaim(tm.data);
check("一部あやしいはつながるが数えない", c12?.item_ids.length === 12 && c12?.clear_item_ids.length === 7, `${c12?.item_ids.length} 個、はっきり ${c12?.clear_item_ids.length} 個`);
check("はっきり 7 個なので中のまま", c12?.strength === "mid");

// 5. 10 個で強め
stub.certainty = "high";
for (let i = 0; i < 5; i++) await upload();
await allDone();
const ts = await untilPersons((d) => nameClaim(d)?.item_ids.length === 17, 30000);
const c17 = nameClaim(ts.data);
check("はっきり 10 個以上で強め", c17?.strength === "strong", `はっきり ${c17?.clear_item_ids.length} 個`);
const parts = ts.data.persons.flatMap((p) => p.claims ?? []).find((c) => c.text.startsWith("電子工作"));
check(
  "見えた物 10 個以上で強め。はっきりには入れない",
  parts?.seen_item_ids.length >= 10 && parts?.clear_item_ids.length === 0 && parts?.strength === "strong",
  `見えた物 ${parts?.seen_item_ids.length} 個、はっきり ${parts?.clear_item_ids.length} 個、強さ ${parts?.strength}`,
);
const items = (await get("/items")).items;
const ids = new Set(items.map((i) => i.id));
check("関連する物は全部実在する", ts.data.persons.every((p) => p.claims.every((c) => c.item_ids.every((id) => ids.has(id)))));
check("札は増えていない", ts.data.persons.filter((p) => p.label === NAME).length === 1);
check("仮説も 1 つのまま", ts.data.persons.flatMap((p) => p.claims).filter((c) => c.source === "claude").length === 1);

// 6. 家族の書き足し
const person = ts.data.persons.find((p) => p.label === NAME);
const noteItem = c17.clear_item_ids[0];
const note = await post(`/persons/${person.id}/claims`, { text: "家族の架空のメモ", item_id: noteItem });
check("家族のメモを書ける", note.status === 201);
const after = await get("/persons");
const familyClaim = after.persons.find((p) => p.id === person.id).claims.find((c) => c.source === "family");
check("家族のメモに強さは付かない", familyClaim.strength === null && familyClaim.clear_item_ids.length === 0);
check("書き足しで強さの数は変わらない", nameClaim(after).clear_item_ids.length === c17.clear_item_ids.length);

// 7. 「違う」が優先される
const target = c17.clear_item_ids[1];
const t0 = Date.now();
const fixRes = await post(`/items/${target}/correction`, { line: 0, text: "架空 花子" });
check("「違う」を受け付ける", fixRes.status === 200);
const tc = await untilPersons((d) => !nameClaim(d)?.item_ids.includes(target), 20000);
check("訂正した物のつながりが外れる", tc.ms !== null, `${Date.now() - t0} ms`);
check("はっきりの数が 1 つ減る", nameClaim(tc.data)?.clear_item_ids.length === c17.clear_item_ids.length - 1);
check("訂正の字から読めた名前の札は作らない", !tc.data.persons.some((p) => p.label === "架空 花子"));
check("家族のメモは残る", tc.data.persons.find((p) => p.id === person.id).claims.some((c) => c.source === "family"));
const detail = await get(`/items/${noteItem}`);
check("詳細に 3 種類が届く", ["photo", "family", "claude"].every((s) => detail.claims.some((c) => c.source === s)), detail.claims.map((c) => c.source).join(","));
check("Claude に家族のメモが渡る", (await untilPersons(() => stub.lastInput?.current_cards.some((c) => c.family_notes.includes("家族の架空のメモ")), 1000)).ms !== null);
check("Claude に家族の訂正が渡る", stub.lastInput.new_items.some((i) => i.lines.some((l) => l.family_corrected && l.text === "架空 花子")));

// 8. 同時実行
check("人物の更新は同時に 1 つだけ", stub.maxInFlight === 1, `最大 ${stub.maxInFlight}、呼び出し ${stub.calls} 回`);

console.log(JSON.stringify({ pass, fail }));
process.exit(fail ? 1 : 0);
