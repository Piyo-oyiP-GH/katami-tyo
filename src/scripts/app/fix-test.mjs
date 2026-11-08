// 回帰の試験。招待、見本、回数の上限、自動の削除、訂正、守り、止まった読み取り、画面を確かめる。
//   node scripts/app/fix-test.mjs [--out <リポジトリの外のフォルダ>]
// Claude は stub-claude.mjs に置き換える。本物の .dev.vars は読まない。データはすべて架空。
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isInside } from "../lib/paths.mjs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repo = path.resolve(root, "..");
const argOut = process.argv.indexOf("--out");
const out = path.resolve(
  argOut > 0 ? process.argv[argOut + 1] : path.join(repo, "..", ".matta-state", "fix-test"),
);
if (isInside(repo, out)) throw new Error("出力はリポジトリの外にしてください");
const state = path.join(out, `state-${Date.now()}`);
mkdirSync(state, { recursive: true });

const PORT = 8794;
const STUB = 8795;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = randomBytes(24).toString("hex");
const JPEG = readFileSync(path.join(root, "public", "sample", "note-thumb.jpg"));
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "OK  " : "NG  "}${name}${detail !== "" ? `  (${detail})` : ""}`);
  if (!ok) failures.push(name);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000, step = 200) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
}

// ---- サーバ ----
const env = { ...process.env, MATTA_STATE_DIR: state };
const stopTree = (p) => {
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" });
  else p.kill("SIGKILL");
};
const node = (args) => spawn(process.execPath, args, { cwd: root, env, stdio: "ignore" });
await new Promise((resolve, reject) => {
  node(["scripts/dev.mjs", "migrate"]).on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`migrate ${c}`))));
});
const stub = node(["scripts/app/stub-claude.mjs", String(STUB), "100"]);
let server = null;
async function startServer(vars = {}) {
  if (server) await stopServer();
  const envFile = path.join(state, "test.env");
  const all = {
    ANTHROPIC_API_KEY: "stub",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${STUB}`,
    SESSION_SECRET: SECRET,
    GUEST_IP_DAILY: 1000,
    GUEST_TOTAL_DAILY: 1000,
    PROJECT_IP_DAILY: 1000,
    SAMPLE_PHOTOS: 1000,
    SAMPLE_IP_DAILY: 1000,
    IP_DAILY: 1000,
    TOTAL_DAILY: 1000,
    ...vars,
  };
  writeFileSync(envFile, Object.entries(all).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  server = node([
    "scripts/dev.mjs", "dev", "--port", String(PORT), "--inspector-port", "9344",
    "--env-file", envFile, "--test-scheduled",
  ]);
  const up = await until(async () => {
    try {
      return (await fetch(`${BASE}/api/health`)).ok;
    } catch {
      return false;
    }
  }, 60000, 300);
  if (!up) throw new Error("サーバが起動しませんでした");
}
async function stopServer() {
  if (!server) return;
  stopTree(server);
  server = null;
  await until(async () => {
    try {
      await fetch(`${BASE}/api/health`);
      return false;
    } catch {
      return true;
    }
  }, 15000);
}
process.on("exit", () => {
  if (server) stopTree(server);
  stopTree(stub);
});

const stubHits = async () => Number(await (await fetch(`http://127.0.0.1:${STUB}/__hits`)).text());
const stubReply = (change) =>
  fetch(`http://127.0.0.1:${STUB}/__reply`, { method: "POST", body: JSON.stringify(change) });
const stubDelay = (ms) => fetch(`http://127.0.0.1:${STUB}/__delay?ms=${ms}`);

function sql(command) {
  const bin = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
  const r = spawnSync(
    process.execPath,
    [bin, "d1", "execute", "DB", "--local", "--persist-to", state, "--json", "--command", command],
    { cwd: root, env: { ...env, CI: "1", WRANGLER_SEND_METRICS: "false" }, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`sql: ${r.stderr}`);
  return JSON.parse(r.stdout)[0].results;
}
const count = (table, where = "1=1") => sql(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)[0].n;

// R2 のオブジェクトの数。ローカルの置き場の SQLite を読むだけ
function r2Keys(prefix) {
  const dir = path.join(state, "v3", "r2", "miniflare-R2BucketObject");
  let keys = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sqlite") && x !== "metadata.sqlite")) {
    const db = new DatabaseSync(path.join(dir, f), { readOnly: true });
    keys = keys.concat(db.prepare("SELECT key FROM _mf_objects").all().map((r) => r.key));
    db.close();
  }
  return keys.filter((k) => k.startsWith(prefix));
}

// ---- Cookie を持つ API の呼び手 ----
class Client {
  cookie = "";
  async req(method, url, body, headers = {}) {
    const res = await fetch(BASE + url, {
      method,
      redirect: "manual",
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(body !== undefined && !(body instanceof Uint8Array) ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie?.() ?? [];
    this.setCookie = set.length > 0;
    for (const c of set) this.cookie = c.split(";")[0];
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }
  get = (u) => this.req("GET", u);
  post = (u, b = {}) => this.req("POST", u, b);
  del = (u) => this.req("DELETE", u);
  me = async () => (await this.get("/api/me")).json;
  async project(name, title) {
    return (await this.post("/api/projects", { display_name: name, title })).json.project_id;
  }
  async invite(pid, name) {
    const r = await this.post(`/api/p/${pid}/invites`, { display_name: name });
    return { id: r.json.id, token: r.json.url.split("#/join/")[1] };
  }
  join = (token) => this.post("/api/invite", { token });
  photo = (pid, q = "pile=keep&ceiling=high", headers) =>
    this.req("POST", `/api/p/${pid}/items?${q}`, new Uint8Array(JPEG), { "content-type": "image/jpeg", ...headers });
  async done(pid, iid) {
    return until(async () => {
      const r = await this.get(`/api/p/${pid}/items/${iid}`);
      return r.json?.item?.status === "done" || r.json?.item?.status === "failed" ? r.json : null;
    });
  }
}
const titles = (me) => me.projects.map((p) => `${p.title}:${p.role}`).sort();

// ---- 1 招待とセッション ----
async function invites() {
  console.log("\n# 招待とセッション");
  // 1. 自然な流れ
  const o = new Client();
  const home = await o.project("架空O", "実家");
  const inv = await o.invite(home, "架空R");
  const r = new Client();
  await r.join(inv.token);
  const rHome = await r.project(undefined, "Rの自宅");
  check("参加した人が自分の片付けを作れる", (await r.me()).projects.length === 2);
  const stranger = new Client();
  const j = await stranger.join(inv.token);
  check("リンクの再利用は入れる", j.status === 200);
  const sm = await stranger.me();
  check("再利用のセッションはその片付けだけ", JSON.stringify(titles(sm)) === '["実家:member"]', titles(sm).join());
  check("再利用のセッションでは作成者の片付けの招待を見られない", (await stranger.get(`/api/p/${rHome}/invites`)).status === 403);
  check("再利用のセッションでは物も見られない", (await stranger.get(`/api/p/${rHome}/items`)).status === 403);
  check("閉じたセッションは新しい片付けを作れない", (await stranger.post("/api/projects", { title: "別" })).status === 409);
  check("閉じたセッションは見本を作れない", (await stranger.post("/api/guest")).status === 409);
  check("閉じたセッションは本人用のリンクを作れない", (await stranger.post(`/api/p/${home}/self-link`)).status === 409);
  const w = new Client();
  const wp = await w.project("架空W2", "別の箱");
  const unused = await w.invite(wp, "架空S");
  const c3 = await stranger.join(unused.token);
  check("閉じたセッションは未使用の招待を使わない", c3.status === 409, c3.json?.error);

  // 2. 狙って行う流れ
  const x = new Client();
  const xp = await x.project("架空X", "Xの箱");
  const v = new Client();
  const vp = await v.project("被害者V", "Vの箱");
  const vInv = await x.invite(xp, "おとり");
  const vj = await v.join(vInv.token);
  check("ログイン済みの人は同じ人のまま招待に入る", vj.json?.user?.display_name === "被害者V");
  const attacker = new Client();
  const steal = await attacker.join(vInv.token);
  check("ログイン済みの人が使った招待では入れない", steal.status === 403, steal.json?.error);
  check("攻撃者は V の物を読めない", (await attacker.get(`/api/p/${vp}/items`)).status === 401);
  check("V は自分の片付けにいる", (await v.get(`/api/p/${vp}/items`)).status === 200);

  // 3. 失効
  const revoke = await o.del(`/api/p/${home}/invites/${inv.id}`);
  check("失効できる", revoke.status === 204);
  check("失効でリンクのセッションは消える", (await stranger.me()).user === null);
  check("失効の後は入り直せない", (await new Client().join(inv.token)).status === 403);
  check("失効の後、本人も元の片付けは 403", (await r.get(`/api/p/${home}/items`)).status === 403);
  check("失効の後も、本人の別の片付けは残る", (await r.get(`/api/p/${rHome}/items`)).status === 200);
  check(
    "失効で招待のセッションの残りは無い",
    count("sessions", `project_id = '${home}'`) === 0,
  );

  // 別の人の使用済みリンク
  const k = new Client();
  const kp = await k.project("架空K", "Kの箱");
  const inv2 = await o.invite(home, "架空Y");
  const y = new Client();
  await y.join(inv2.token);
  const before = k.cookie;
  const kj = await k.join(inv2.token);
  check("別の人の使用済みリンクは断る", kj.status === 409 && kj.json.error === "invite_other_user", kj.json?.error);
  check("Cookie は変わらない", k.cookie === before);
  check("作成者は自分の片付けに残る", (await k.get(`/api/p/${kp}/items`)).status === 200);
  check("名前も変わらない", (await k.me()).user.display_name === "架空K");

  // 本人が開き直す、ゲストが開く
  check("本人が開き直しても変わらない", (await y.join(inv2.token)).status === 200 && !y.setCookie);
  const g = new Client();
  await g.post("/api/guest");
  const gCookie = g.cookie;
  check("ゲストは使用済みのリンクで置き換わらない", (await g.join(inv2.token)).status === 409 && g.cookie === gCookie);
  const inv3 = await o.invite(home, "架空T");
  const gj = await g.join(inv3.token);
  check("ゲストが未使用の招待を開くと、同じ人に名前が付く", gj.json?.user?.display_name === "架空T" && g.cookie === gCookie);
  check("そのゲストは見本にも戻れる", (await g.me()).projects.length === 2);
  const again = new Client();
  check("その招待は別の端末でも入り直せる", (await again.join(inv3.token)).status === 200);
  check("別の端末は片付け 1 つだけ", (await again.me()).projects.length === 1);

  // 作成者の戻り道
  const self = await o.post(`/api/p/${home}/self-link`);
  check("本人用のリンクを作れる", self.status === 201);
  const selfToken = self.json.url.split("#/join/")[1];
  const lost = new Client();
  const lj = await lost.join(selfToken);
  check("Cookie を失った作成者が戻れる", lj.json?.user?.display_name === "架空O");
  check("戻った人は作成者のまま", (await lost.me()).projects[0].role === "owner");
  check("戻った人は招待を出せる", (await lost.get(`/api/p/${home}/invites`)).status === 200);
  check("本人用のリンクは招待の一覧に出ない", !(await o.get(`/api/p/${home}/invites`)).json.invites.some((i) => i.display_name === "架空O"));
  check("別の人が開いても置き換わらない", (await k.join(selfToken)).status === 409);
  const self2 = await o.post(`/api/p/${home}/self-link`);
  check("作り直すと前のセッションは消える", (await lost.me()).user === null);
  check("作り直すと前のリンクは止まる", (await new Client().join(selfToken)).status === 403);
  check("新しいリンクは使える", (await new Client().join(self2.json.url.split("#/join/")[1])).status === 200);

  // 期限の延長
  const ids = sql(`SELECT id FROM sessions WHERE user_id = (SELECT id FROM users WHERE display_name = '架空K')`);
  sql(`UPDATE sessions SET expires_at = ${Date.now() + 86400000} WHERE id = '${ids[0].id}'`);
  await k.me();
  check("使っている間はセッションが延びる", k.setCookie && sql(`SELECT expires_at FROM sessions WHERE id = '${ids[0].id}'`)[0].expires_at > Date.now() + 20 * 86400000);
}

// ---- 2 見本で締め出されない ----
async function sampleLockout() {
  console.log("\n# 見本");
  const o = new Client();
  const p = await o.project("架空O2", "架空の押し入れ");
  const cookie = o.cookie;
  const g = await o.post("/api/guest");
  check("作成者が見本を押しても Cookie は変わらない", g.status === 201 && o.cookie === cookie);
  check("作成者の入口に両方が出る", (await o.me()).projects.length === 2);
  check("元の片付けを開ける", (await o.get(`/api/p/${p}/items`)).status === 200);
  check("見本を開ける", (await o.get(`/api/p/${g.json.project_id}/items`)).status === 200);
  check("もう一度押しても同じ見本", (await o.post("/api/guest")).json.project_id === g.json.project_id);
  const n = new Client();
  const ng = await n.post("/api/guest");
  const np = await n.post("/api/projects", { display_name: "架空N", title: "新しい片付け" });
  check("ゲストが片付けを作っても見本に戻れる", (await n.get(`/api/p/${ng.json.project_id}/items`)).status === 200);
  check("ゲストは名前の付いた人になる", (await n.me()).user.display_name === "架空N" && np.status === 201);
  const inv = await o.invite(p, "架空R2");
  const r = new Client();
  await r.join(inv.token);
  const rc = r.cookie;
  await r.post("/api/guest");
  check("親族が見本を押しても本物の片付けに残る", r.cookie === rc && (await r.get(`/api/p/${p}/items`)).status === 200);
}

// ---- 3 訂正と検索 ----
async function correction() {
  console.log("\n# 訂正と検索");
  await stubReply({
    lines: [{ text: "誤読 太郎", type: "name", handwritten: false, where: "上", certainty: "high" }],
    inferences: ["誤読という名前の持ち物かもしれません"],
  });
  const o = new Client();
  const p = await o.project("架空O3", "訂正の箱");
  const up = await o.photo(p);
  const iid = up.json.item.id;
  const d0 = await o.done(p, iid);
  const before = d0.item.rank_score;
  check("読めた名前で検索に当たる", (await o.get(`/api/p/${p}/search?q=誤読`)).json.hits.length === 1);
  const fix = await o.post(`/api/p/${p}/items/${iid}/correction`, { line: 0, text: "正解 花子" });
  check("訂正は通る", fix.status === 200);
  const miss = (await o.get(`/api/p/${p}/search?q=誤読`)).json.hits;
  check("訂正の後、誤った語では当たらない", miss.length === 0, JSON.stringify(miss.flatMap((h) => h.matched)));
  check("同じ行の残った語（太郎）でも当たらない", (await o.get(`/api/p/${p}/search?q=太郎`)).json.hits.length === 0);
  const hit = (await o.get(`/api/p/${p}/search?q=正解`)).json.hits;
  check("訂正の語で文字として当たる", hit[0]?.matched.some((m) => m.source === "text" && m.term.includes("正解")));
  const d1 = (await o.get(`/api/p/${p}/items/${iid}`)).json;
  check("チップは訂正を出す", d1.item.chips.includes("人名（家族の訂正）") && d1.item.chips.includes("家族の訂正あり"), d1.item.chips.join());
  check("「はっきり」のチップは残らない", !d1.item.chips.some((c) => c.includes("人名（はっきり）")));
  check("点数が訂正済みで計算される", typeof d1.item.rank_score === "number", `${before}→${d1.item.rank_score}`);
  await o.post(`/api/p/${p}/items/${iid}/correction`, { title: "架空の札" });
  check("物名の訂正で元の種類の語は物名に当たらない", !(await o.get(`/api/p/${p}/search?q=試験の紙`)).json.hits.some((h) => h.matched.some((m) => m.source === "name")));
  await stubReply({});
}

// ---- 4 守り（本物の流れを通す）----
async function guards() {
  console.log("\n# 読み取りの守り");
  const o = new Client();
  const p = await o.project("架空O4", "守りの箱");
  const read = async () => (await o.done(p, (await o.photo(p)).json.item.id));

  await stubReply({
    inferences: ["重要な書類かもしれません", "処分してよさそうです", "通院の記録かもしれません", "夫婦でやり取りした手紙かもしれません", "趣味の紙かもしれません"],
  });
  const d = await read();
  check("判断の語と話題の見立ては画面に残らない", JSON.stringify(d.reading.b.inferences) === '["趣味の紙かもしれません"]', d.reading.b.inferences.join("／"));
  check("検索でも当たらない", (await o.get(`/api/p/${p}/search?q=通院`)).json.hits.length === 0);

  await stubReply({ lines: [], evidence: ["白い紙"], signals: [] });
  const n = await read();
  check("文字の無い写真は確からしさを出さない", n.item.confidence === null, String(n.item.confidence));

  await stubReply({ __stop_reason: "refusal" });
  const b = await read();
  check("B が断られても埋もれない", b.item.error_code === "observe_refused" && b.item.needs_retake && b.item.confidence !== "high", `${b.item.error_code} ${b.item.confidence}`);
  check("理由は「見つかっていません」ではない", !b.item.rank_reason.includes("見つかっていません"), b.item.rank_reason);
  check("もう一度読める", b.item.can_retry);
  const list = (await o.get(`/api/p/${p}/items`)).json.items;
  check("一覧の前に出る", list[0].id === b.item.id);
  await stubReply({});
  const retry = await o.post(`/api/p/${p}/items/${b.item.id}/retry`);
  check("観察の失敗はやり直せる", retry.status === 202);
  const b2 = await o.done(p, b.item.id);
  check("やり直すと直る", b2.item.error_code === null && b2.reading.b !== null);

  await stubReply({ evidence: ["森川商店の封筒が見える"], proper_nouns: ["森川商店"], lines: [] });
  const m = await read();
  check("読めていない固有名詞の文は見立てにも残らない", !JSON.stringify(m.reading.b.inferences).includes("森川商店") && !m.reading.b.evidence.length);
  const terms = (await o.get(`/api/p/${p}/record-terms`)).json;
  check("録画モードの語に固有名詞が入る", terms.hidden.includes("森川商店"));
  await stubReply({});
}

// ---- 5 回数の上限 ----
async function limits() {
  console.log("\n# 回数の上限");
  sql("DELETE FROM usage_counts");
  await startServer({
    SAMPLE_PHOTOS: 3,
    SAMPLE_IP_DAILY: 5,
    GUEST_IP_DAILY: 3,
    PROJECT_DAILY: 4,
    IP_DAILY: 6,
    PROJECT_IP_DAILY: 2,
  });
  const a = new Client();
  const pa = (await a.post("/api/guest")).json.project_id;
  const res = [];
  for (let i = 0; i < 5; i++) res.push(await a.photo(pa));
  check("見本は上限の枚数で止まる", res.map((r) => r.status).join() === "202,202,202,429,429", res.map((r) => r.status).join());
  check("超えたら理由を返す", res[4].json.error === "limit_sample", res[4].json.error);
  await sleep(1500);
  const h0 = await stubHits();
  for (let i = 0; i < 3; i++) await a.photo(pa);
  await sleep(1500);
  check("超えた分は Claude を呼ばない", (await stubHits()) === h0, `${h0}→${await stubHits()}`);
  check("超えた分は写真も置かない", (await a.get(`/api/p/${pa}/items`)).json.items.length === 15, String((await a.get(`/api/p/${pa}/items`)).json.items.length));
  const b = new Client();
  const pb = (await b.post("/api/guest")).json.project_id;
  const r2 = [];
  for (let i = 0; i < 3; i++) r2.push((await b.photo(pb)).status);
  check("別のゲストに分けても接続元で止まる", r2.join() === "202,202,429", r2.join());
  const c = new Client();
  await c.post("/api/guest");
  const d = new Client();
  const g4 = await d.post("/api/guest");
  check("見本の作成も上限で止まる", g4.status === 429, g4.json?.error);
  const keyed = count("usage_counts", "key LIKE 'gip:%' AND key NOT LIKE 'gip:local:%'");
  console.log(`    接続元の取得：${keyed ? "cf-connecting-ip あり" : "無し（全部を 1 つの接続元として数えた）"}`);
  const spoof = new Client();
  const sg = await spoof.req("POST", "/api/guest", {}, { "cf-connecting-ip": "203.0.113.9" });
  console.log(`    cf-connecting-ip を手で付けた見本の作成：${sg.status}（201 なら手元の wrangler dev では偽装できる）`);

  const e = new Client();
  const pe = await e.project("架空E", "上限の箱");
  const r3 = [];
  for (let i = 0; i < 6; i++) r3.push((await e.photo(pe)).status);
  check("本物の片付けも 1 日の上限で止まる", r3.join() === "202,202,202,202,429,429", r3.join());
  const p2 = await e.project(undefined, "二つ目の箱");
  const r4 = [];
  for (let i = 0; i < 4; i++) r4.push((await e.photo(p2)).status);
  check("片付けを増やしても接続元で止まる", r4.join() === "202,202,429,429", r4.join());
  const f = new Client();
  check("片付けの作成も上限で止まる", (await f.post("/api/projects", { display_name: "架空F", title: "三つ目" })).status === 429);

  await startServer({ TOTAL_DAILY: 0 });
  const t = new Client();
  const pt = await t.project("架空T2", "全体の箱");
  const over = await t.photo(pt);
  check("全体の 1 日の上限で止まる", over.status === 429 && over.json.error === "limit_total", over.json?.error);
}

// ---- 6 止めるスイッチ ----
async function killSwitch() {
  console.log("\n# 止めるスイッチ");
  await startServer();
  const a = new Client();
  const p = await a.project("架空G", "スイッチの箱");
  await stubDelay(4000);
  const up = await a.photo(p);
  const iid = up.json.item.id;
  const cookie = a.cookie;
  await stubDelay(100);
  await startServer({ READING_OFF: 1 });
  a.cookie = cookie;
  const h0 = await stubHits();
  const r = await a.photo(p);
  check("スイッチで新しい読み取りを断る", r.status === 503 && r.json.error === "reading_stopped", String(r.status));
  check("断った物は増えない", (await a.get(`/api/p/${p}/items`)).json.items.length === 1);
  sql(`UPDATE items SET status='failed', updated_at=0 WHERE id='${iid}'`);
  const rr = await a.post(`/api/p/${p}/items/${iid}/retry`);
  check("読み直しも断る", rr.status === 503);
  // 人物の更新も呼ばない。訂正を保存する道は止めない
  sql(`UPDATE items SET status='done', reading_json='{"a":{"lines":[]},"a2":{"lines":[]},"b":null,"checked":[]}' WHERE id='${iid}'`);
  const fx = await a.post(`/api/p/${p}/items/${iid}/correction`, { title: "架空の物" });
  check("スイッチの間も訂正は保存できる", fx.status === 200);
  await sleep(2500);
  check("訂正の後の人物の更新も Claude を呼ばない", (await stubHits()) === h0, `${h0}→${await stubHits()}`);
  await sleep(1500);
  check("スイッチの間は Claude を呼ばない", (await stubHits()) === h0, `${h0}→${await stubHits()}`);
  await startServer();
}

// ---- 7 自動の削除 ----
async function purge() {
  console.log("\n# 自動の削除");
  const g = new Client();
  const p = (await g.post("/api/guest")).json.project_id;
  const up = await g.photo(p);
  await g.done(p, up.json.item.id);
  const keep = new Client();
  const real = await keep.project("架空H", "消えない箱");
  const inv = await keep.invite(real, "架空I");
  await new Client().join(inv.token);
  const realItem = (await keep.photo(real)).json.item.id;
  await keep.done(real, realItem);
  const tables = ["items", "persons", "claims", "claim_items", "waits", "invites", "memberships"];
  const rows = () => tables.reduce((n, t) => n + count(t, `project_id = '${p}'`), 0);
  const before = rows();
  const keysBefore = r2Keys(`p/${p}/`).length;
  check("消す前に行と写真がある", before > 0 && keysBefore > 0, `${before} 行、${keysBefore} 個`);
  sql(`UPDATE projects SET expires_at = ${Date.now() - 1000} WHERE id = '${p}'`);
  check("期限切れは閉じる", (await g.get(`/api/p/${p}/items`)).status === 403);
  let res = await fetch(`${BASE}/cdn-cgi/handler/scheduled`);
  if (!res.ok) res = await fetch(`${BASE}/__scheduled`);
  check("定期処理を起こせる", res.ok, String(res.status));
  const gone = await until(() => count("projects", `id = '${p}'`) === 0, 15000, 500);
  check("project が消える", !!gone);
  check("子の表の行が 0", rows() === 0, String(rows()));
  check("R2 の写真が 0", r2Keys(`p/${p}/`).length === 0, String(r2Keys(`p/${p}/`).length));
  check("ゲストと架空の人が消える", count("users", "is_guest = 1 AND id NOT IN (SELECT user_id FROM memberships)") === 0);
  check("ゲストのセッションが消える", (await g.me()).user === null);
  check("本物の片付けは残る", (await keep.get(`/api/p/${real}/items/${realItem}`)).status === 200 && r2Keys(`p/${real}/`).length > 0);
}

// ---- 8 止まった読み取り ----
async function stale() {
  console.log("\n# 止まった読み取り");
  const a = new Client();
  const p = await a.project("架空J", "止まる箱");
  await stubDelay(8000);
  const up = await a.photo(p, "pile=keep&ceiling=high&cid=stale-1");
  const iid = up.json.item.id;
  await until(async () => (await a.get(`/api/p/${p}/items/${iid}`)).json.item.status === "reading");
  const cookie = a.cookie;
  await stopServer();
  await stubDelay(100);
  await startServer();
  a.cookie = cookie;
  await sleep(4000);
  const now = (await a.get(`/api/p/${p}/items/${iid}`)).json.item;
  check("再起動の後、読み取り中のまま", now.status === "reading", now.status);
  check("3 分たつまでは止まった扱いにしない", !now.stale && !now.can_retry);
  sql(`UPDATE items SET updated_at = ${Date.now() - 200000} WHERE id = '${iid}'`);
  const card = (await a.get(`/api/p/${p}/items/${iid}`)).json.item;
  check("3 分を過ぎると止まった扱いになる", card.stale && card.can_retry);
  const re = await a.post(`/api/p/${p}/items/${iid}/retry`);
  check("もう一度読める", re.status === 202);
  const d = await a.done(p, iid);
  check("読み終わる", d?.item.status === "done");

  // 同じ番号の送り直しでも入れ直す
  await stubDelay(8000);
  const up2 = await a.photo(p, "pile=keep&ceiling=high&cid=stale-2");
  const i2 = up2.json.item.id;
  await until(async () => (await a.get(`/api/p/${p}/items/${i2}`)).json.item.status === "reading");
  await stopServer();
  await stubDelay(100);
  await startServer();
  a.cookie = cookie;
  sql(`UPDATE items SET updated_at = ${Date.now() - 200000} WHERE id = '${i2}'`);
  const res = await a.photo(p, "pile=keep&ceiling=high&cid=stale-2");
  check("送り直しで入れ直す", res.status === 200 && res.json.item.status === "queued", res.json?.item?.status);
  check("送り直しでも読み終わる", (await a.done(p, i2))?.item.status === "done");
}

// 定期処理の入れ直しが、読んでいる最中の物を二重に読まないこと
async function requeue() {
  console.log("\n# 入れ直し");
  const a = new Client();
  const p = await a.project("架空L", "待ちの箱");
  await sleep(1000);
  await stubDelay(8000);
  const h0 = await stubHits();
  const iid = (await a.photo(p)).json.item.id;
  await until(async () => (await a.get(`/api/p/${p}/items/${iid}`)).json.item.status === "reading");
  sql(`UPDATE items SET updated_at = ${Date.now() - 200000} WHERE id = '${iid}'`);
  await fetch(`${BASE}/cdn-cgi/handler/scheduled`);
  const d = await a.done(p, iid);
  await stubDelay(100);
  await sleep(10000);
  const n = (await stubHits()) - h0;
  check("読んでいる物を定期処理が二重に読まない", d?.item.status === "done" && n === 3, `Claude ${n} 回`);
}

// ---- 9 画面 ----
async function screens() {
  console.log("\n# 画面");
  const browser = await chromium.launch({
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  const phone = { viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true, locale: "ja-JP", permissions: ["camera"] };
  const open = async (extra = {}) => {
    const ctx = await browser.newContext({ ...phone, ...extra });
    const page = await ctx.newPage();
    return { ctx, page };
  };
  const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });
  const { ctx, page: g } = await open();
  await g.goto(`${BASE}/#/`);
  await g.click("#try-sample");
  await g.waitForSelector(".card");
  const pid = g.url().match(/#\/p\/([^/]+)/)[1];
  await g.waitForSelector("#filter-drop");

  // 一覧
  const waited = g.locator(".card.waited");
  check("待ったの物に「残す」が出る", (await waited.count()) > 0 && (await waited.locator(".pile-tag.kept").count()) === (await waited.count()));
  const dropCount = await g.locator("#filter-drop").innerText();
  await g.click("#filter-drop");
  const shown = await g.locator(".card").count();
  check("「いらない」の数は待ったを除く", dropCount.endsWith(` ${shown}`), `${dropCount} / ${shown}`);
  check("「いらない」に待ったの物が混ざらない", (await g.locator(".card.waited").count()) === 0);
  check("除いたことを出す", await g.locator("#drop-note").isVisible());
  check("絞り込み中は表示の件数を出す", (await g.locator("#count").innerText()).startsWith(`${shown} 件を表示`), await g.locator("#count").innerText());
  await g.click("#filter-all");
  await shot(g, "list");
  check("入口へ戻るリンクがある", (await g.locator("#to-entry").getAttribute("href")) === "#/");
  await g.click("#tab-people");
  await g.waitForSelector("#participants");
  check("人の画面からも入口へ戻れる", (await g.locator("#to-entry").count()) === 1);
  check("見本には自分用のリンクを出さない", (await g.locator("#self-section").count()) === 0);

  // 撮影
  await g.goto(`${BASE}/#/p/${pid}/capture`);
  await g.waitForSelector("#sample-cost");
  check("見本の撮影画面に料金の注意が出る", /本物の Claude/.test(await g.locator("#sample-cost").innerText()));
  await sleep(800);
  await g.click("#pile-keep");
  await sleep(300);
  await g.click("#pile-drop");
  await sleep(300);
  await g.click("#pile-unsure");
  await g.waitForSelector("#undo-bar");
  await sleep(200);
  const overlap = await g.evaluate(() => {
    const bar = document.getElementById("undo-bar").getBoundingClientRect();
    return [...document.querySelectorAll(".shot, .shot button")].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.bottom > bar.top + 1 && r.top < bar.bottom - 1 && r.right > bar.left && r.left < bar.right;
    }).length;
  });
  check("取り消しの帯は撮った物に重ならない", overlap === 0, String(overlap));
  await shot(g, "capture");
  const btnBox = await g.locator("#pile-keep").boundingBox();
  check("ボタンは下半分のまま", btnBox.y > 780 * 0.6 && btnBox.height >= 88, `${btnBox.y}`);
  await g.setViewportSize({ width: 320, height: 568 });
  await sleep(300);
  const wrap = await g.evaluate(() => {
    const lines = (e) => {
      const r = document.createRange();
      r.selectNodeContents(e);
      return new Set([...r.getClientRects()].map((c) => Math.round(c.top))).size;
    };
    return {
      top: [...document.querySelectorAll(".capture-top a, .capture-top button, .capture-top span")].map(lines),
      pile: [...document.querySelectorAll(".pile-buttons button")].map(lines),
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  check("幅 320 で上の行とボタンが折り返さない", [...wrap.top, ...wrap.pile].every((n) => n <= 1) && !wrap.overflow, JSON.stringify(wrap));
  await shot(g, "capture-320");
  await g.setViewportSize({ width: 390, height: 780 });
  await g.goto(`${BASE}/#/p/${pid}/list`);
  await g.waitForSelector(".card");
  await until(async () => (await g.locator(".card").count()) >= 15, 12000).catch(() => {});

  // 録画モードで件数やボタンが隠れない。12 件の見本で、ある行を「12」に直して確かめる
  const firstDone = (await g.evaluate(async (p) => (await (await fetch(`/api/p/${p}/items`)).json()).items, pid)).find((i) => i.status === "done");
  await g.evaluate(async ([p, i]) => fetch(`/api/p/${p}/items/${i}/correction`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ line: 0, text: "12" }) }), [pid, firstDone.id]);
  await g.evaluate(() => localStorage.setItem("matta.record", "1"));
  await g.reload();
  await g.waitForSelector(".card");
  await sleep(800);
  const total = await g.evaluate(async (p) => (await (await fetch(`/api/p/${p}/items`)).json()).items.length, pid);
  const terms = await g.evaluate(async (p) => (await (await fetch(`/api/p/${p}/record-terms`)).json()).hidden, pid);
  check("隠す語に「12」が入っている", terms.includes("12"));
  check("録画モードで全件の数が隠れない", (await g.locator("#count").innerText()) === `全 ${total} 件`, await g.locator("#count").innerText());
  check("録画モードで絞り込みの数が隠れない", !(await g.locator(".filters").innerText()).includes("■"), (await g.locator(".filters").innerText()).replace(/\n/g, " "));
  await g.evaluate(() => localStorage.setItem("matta.record", "0"));
  await g.reload();
  await g.waitForSelector(".card");

  // 詳細：家族の線
  const itemRes = await g.evaluate(async (p) => (await (await fetch(`/api/p/${p}/persons`)).json()).persons, pid);
  const person = itemRes[0];
  const items = await g.evaluate(async (p) => (await (await fetch(`/api/p/${p}/items`)).json()).items, pid);
  const plain = items.find((i) => i.status === "done" && !i.wait_count);
  const fam = await g.evaluate(async ([p, per, iid]) => {
    const add = await fetch(`/api/p/${p}/persons`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "架空夫妻", subtype: "vague" }) });
    const np = await add.json();
    await fetch(`/api/p/${p}/persons/${np.id}/claims`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "架空のメモ", item_id: iid }) });
    return np.id;
  }, [pid, person.id, items.at(-1).id]);
  await g.goto(`${BASE}/#/p/${pid}/item/${items.at(-1).id}`);
  await g.waitForSelector("#relsvg");
  check("家族のメモだけの人にも線が出る", (await g.locator("#relsvg line.rs-family").count()) >= 1, String(fam).length);
  await shot(g, "family-line");

  // ひとこと
  await g.goto(`${BASE}/#/p/${pid}/item/${plain.id}`);
  await g.waitForSelector("#wait-btn");
  await g.click("#wait-btn");
  await g.waitForSelector("#wait-note");
  await g.click("#wait-note");
  await g.fill("#ask-input", "一つ目のひとこと");
  await g.click('#ask button[type="submit"]');
  await g.waitForFunction(() => document.querySelector("#waits")?.innerText.includes("一つ目"));
  check("保存すると「ひとことを直す」になる", (await g.locator("#wait-note").innerText()) === "ひとことを直す");
  await g.click("#wait-note");
  check("前のひとことが入力欄に入る", (await g.inputValue("#ask-input")) === "一つ目のひとこと");
  await g.fill("#ask-input", "一つ目のひとこと、二つ目");
  await g.click('#ask button[type="submit"]');
  await g.waitForFunction(() => document.querySelector("#waits")?.innerText.includes("二つ目"));
  check("前の文を残して直せる", (await g.locator("#waits").innerText()).includes("一つ目のひとこと、二つ目"));

  // 待ったの失敗
  await g.click("#wait-btn");
  await g.waitForFunction(() => document.getElementById("wait-btn").innerText === "待った");
  await ctx.setOffline(true);
  await g.click("#wait-btn");
  await g.waitForFunction(() => document.getElementById("wait-status").innerText.includes("届きません"));
  check("通信が切れた待ったは画面で伝える", (await g.locator("#toast").innerText()).includes("届きません"), await g.locator("#toast").innerText());
  await shot(g, "wait-offline");
  await ctx.setOffline(false);

  // 録画モード
  const { ctx: c2, page: o } = await open();
  await o.goto(`${BASE}/#/`);
  await o.click("summary:has-text('新しい片付け')");
  await o.fill("#new-name", "架空太一");
  await o.fill("#new-title", "架空家の押入れ");
  await o.click('#new-project button[type="submit"]');
  await o.waitForSelector("#invite-form");
  const rp = o.url().match(/#\/p\/([^/]+)/)[1];
  check("作成者に自分用のリンクの案内が出る", /作成者も戻れなくなります/.test(await o.locator("#self-section").innerText()));
  await o.click("#self-link");
  await o.waitForSelector("#self-section .invite-url");
  const selfUrl = await o.locator("#self-section .invite-url").innerText();
  const { ctx: c3, page: recov } = await open();
  await recov.goto(selfUrl);
  await recov.waitForURL(new RegExp(`/p/${rp}/list`));
  check("自分用のリンクを別のブラウザで開ける", true);
  await recov.goto(`${BASE}/#/`);
  await recov.waitForSelector("#scoped-note");
  check("閉じたセッションの入口は片付けだけ", (await recov.locator("#try-sample").count()) === 0);
  await c3.close();

  // 誰かの招待を作り、録画モードで漏れないことを見る
  await o.check("#record-mode");
  await sleep(1000);
  await o.waitForSelector("#invite-form");
  await o.evaluate(() => {
    window.__seen = [];
    new MutationObserver(() => window.__seen.push(document.body.innerText)).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await o.fill("#invite-name", "健");
  await o.click('#invite-form button[type="submit"]');
  await o.waitForSelector("#invite-url");
  await sleep(600);
  const leak = await o.evaluate(() => window.__seen.filter((t) => /健（|健さん/.test(t)).length);
  check("招待の直後も 1 字の名前が出ない", leak === 0 && !(await o.locator("body").innerText()).includes("健さん"), String(leak));
  await o.fill("#invite-name", "架空山田");
  await o.click('#invite-form button[type="submit"]');
  await sleep(800);
  const peopleText = await o.locator("body").innerText();
  check("招待の名前が別名になる", !peopleText.includes("架空山田") && /親族[A-C]/.test(peopleText));
  await shot(o, "record-people");
  await o.goto(`${BASE}/#/`);
  await o.reload();
  await o.waitForSelector(".resume a");
  check("録画モードの入口は片付けの名前を出さない", (await o.locator(".resume").innerText()).includes("この片付けを開く") && !(await o.locator("body").innerText()).includes("架空家"));

  // 読み取り結果の隠れ方
  await stubReply({
    lines: [{ text: "山里 はな 様", type: "name", handwritten: false, where: "上", certainty: "high" }, { text: "12", type: "number", handwritten: false, where: "下", certainty: "high" }],
    kind: "短い手紙のカード",
    synonyms: ["便り"],
    evidence: ["「山里 はな 様」と書かれた白い紙"],
    inferences: ["俳句の会で使ったカードかもしれません"],
  });
  const iid = await o.evaluate(async (p) => {
    const blob = await (await fetch("/sample/note-thumb.jpg")).blob();
    const r = await fetch(`/api/p/${p}/items?pile=keep&ceiling=high`, { method: "POST", headers: { "content-type": "image/jpeg" }, body: blob });
    return (await r.json()).item.id;
  }, rp);
  await until(async () => (await o.evaluate(async ([p, i]) => (await (await fetch(`/api/p/${p}/items/${i}`)).json()).item.status, [rp, iid])) === "done");
  await stubReply({});
  await o.goto(`${BASE}/#/p/${rp}/list`);
  await o.waitForSelector(".card");
  await sleep(500);
  check("録画モードで件数が隠れない", (await o.locator("#count").innerText()).includes("全 1 件"), await o.locator("#count").innerText());
  await o.fill("#search", "俳句");
  await o.waitForSelector(".match");
  await sleep(600);
  check("見立ての一致語が隠れる", !(await o.locator(".match").first().innerText()).includes("俳句"));
  await o.fill("#search", "手紙");
  await sleep(1000);
  check("物名の一致語が隠れる", !(await o.locator(".match").allInnerTexts()).join().includes("短い手紙"), (await o.locator(".match").allInnerTexts()).join());
  await o.goto(`${BASE}/#/p/${rp}/item/${iid}`);
  await o.waitForSelector(".guess-list");
  await sleep(600);
  check("見立ては丸ごと隠れる", !(await o.locator(".guess-list").innerText()).includes("俳句"));
  await o.locator(".line-row button").first().click();
  check("「違う」の入力欄に本当の文字を出さない", (await o.inputValue("#ask-input")) === "");
  await shot(o, "record-correct");
  await o.click('#ask button[type="button"]');

  // 招待を止めた人が押す
  const invited = await o.evaluate(async (p) => {
    const r = await fetch(`/api/p/${p}/invites`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ display_name: "架空まゆ" }) });
    return r.json();
  }, rp);
  const { ctx: c4, page: m } = await open();
  await m.goto(invited.url);
  await m.waitForURL(new RegExp(`/p/${rp}/list`));
  await m.goto(`${BASE}/#/p/${rp}/item/${iid}`);
  await m.waitForSelector("#wait-btn");
  await o.evaluate(async ([p, id]) => fetch(`/api/p/${p}/invites/${id}`, { method: "DELETE" }), [rp, invited.id]);
  await m.click("#wait-btn");
  await m.waitForSelector("#denied", { timeout: 8000 }).catch(() => {});
  check("招待を止められた人が押すと拒否の画面に移る", (await m.locator("#denied").count()) === 1);
  await c4.close();

  // 人物の結び付け
  await o.uncheck("#record-mode").catch(() => {});
  await o.goto(`${BASE}/#/p/${rp}/people`);
  await o.waitForSelector("#record-mode");
  await o.uncheck("#record-mode");
  await o.waitForSelector("#add-person");
  await o.evaluate(async (p) => fetch(`/api/p/${p}/persons`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "架空みさき", subtype: "vague" }) }), rp);
  await o.waitForSelector(".person-card");
  const sel = o.locator(".person-card label.section select");
  await sel.focus();
  await sel.selectOption({ index: 1 });
  const linked = await until(async () => (await o.locator("#participants").innerText()).includes("人物の札あり"), 3000);
  check("結び付けはすぐ画面に出る", !!linked);

  // 招待のリンクのコピー（http の住所）
  const { ctx: c5, page: h } = await open();
  await h.addInitScript(() => {
    Object.defineProperty(window, "isSecureContext", { value: false });
    Object.defineProperty(navigator, "clipboard", { value: undefined });
  });
  await c5.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE }).catch(() => {});
  await h.goto(`${BASE}/#/`);
  await h.click("summary:has-text('新しい片付け')");
  await h.fill("#new-name", "架空あや");
  await h.fill("#new-title", "コピーの箱");
  await h.click('#new-project button[type="submit"]');
  await h.waitForSelector("#invite-form");
  await h.fill("#invite-name", "架空ひろ");
  await h.click('#invite-form button[type="submit"]');
  await h.waitForSelector("#invite-url");
  await h.locator("#invite-url ~ button").click();
  await sleep(200);
  check("http でもコピーできる", (await h.locator("#toast").innerText()).includes("コピーしました"), await h.locator("#toast").innerText());

  // 読めない形式
  const ctxP = h.url().match(/#\/p\/([^/]+)/)[1];
  await h.goto(`${BASE}/#/p/${ctxP}/capture`);
  await h.waitForSelector("#native-camera", { state: "attached" });
  await h.evaluate(() => localStorage.setItem("matta.nativeCamera", "1"));
  await h.reload();
  await h.waitForSelector("#native-camera", { state: "attached" });
  const chooser = h.waitForEvent("filechooser");
  await h.click("#pile-keep");
  await (await chooser).setFiles({ name: "x.heic", mimeType: "image/heic", buffer: Buffer.from("not a jpeg at all") });
  await h.waitForSelector('.shot[data-state="rejected"]', { timeout: 12000 });
  const rej = await h.locator(".shot").first().innerText();
  check("読めない形式は理由を出す", rej.includes("この形式の画像は読めません"), rej.replace(/\n/g, " "));
  check("もう一度送るを出さない", !rej.includes("もう一度送る"));
  await h.locator("button.discard").click();

  // 訂正前の読みの印と、止まった物の「もう一度読む」
  await stubReply({
    lines: [{ text: "庭の梅が咲きました", type: "other", handwritten: true, where: "中", certainty: "high" }],
    evidence: ["「梅が咲」と書かれた紙"],
  });
  const post = (p) =>
    h.evaluate(async (p) => {
      const blob = await (await fetch("/sample/note-thumb.jpg")).blob();
      const r = await fetch(`/api/p/${p}/items?pile=keep&ceiling=high`, { method: "POST", headers: { "content-type": "image/jpeg" }, body: blob });
      return (await r.json()).item.id;
    }, p);
  const fixId = await post(ctxP);
  await until(async () => (await h.evaluate(async ([p, i]) => (await (await fetch(`/api/p/${p}/items/${i}`)).json()).item.status, [ctxP, fixId])) === "done");
  await h.goto(`${BASE}/#/p/${ctxP}/item/${fixId}`);
  await h.waitForSelector(".line-row button");
  await h.locator(".line-row button").first().click();
  await h.fill("#ask-input", "庭の桃が咲きました");
  await h.click('#ask button[type="submit"]');
  await h.waitForFunction(() => document.querySelector(".plain-list")?.innerText.includes("訂正前の読み"), null, { timeout: 8000 }).catch(() => {});
  check("見えたものの訂正前の読みに印が付く", (await h.locator(".plain-list").innerText()).includes("訂正前の読み"));
  await stubReply({});
  await stubDelay(30000);
  const stuckId = await post(ctxP);
  await stubDelay(100);
  sql(`UPDATE items SET status='reading', updated_at=${Date.now() - 200000} WHERE id='${stuckId}'`);
  await h.goto(`${BASE}/#/p/${ctxP}/item/${stuckId}`);
  await h.waitForSelector("#retry", { timeout: 8000 }).catch(() => {});
  check("止まった物に「もう一度読む」が出る", (await h.locator("#retry").count()) === 1);
  await shot(h, "stale");
  await h.goto(`${BASE}/#/p/${ctxP}/list`);
  await h.waitForSelector(".card");
  check("一覧でも止まったと分かる", (await h.locator(".card", { hasText: "読み取りが止まっています" }).count()) === 1);

  // ぼけと白飛びの上限。背景だけくっきりの画像を画面の中で作り、本物の measure に掛ける
  const img = await g.evaluate(async () => {
    const { measure, ceilingOf } = await import("/js/image.js");
    const draw = (fn) => {
      const c = document.createElement("canvas");
      c.width = 1024;
      c.height = 768;
      const x = c.getContext("2d");
      const noise = x.createImageData(1024, 768);
      for (let i = 0; i < noise.data.length; i += 4) {
        const v = 90 + Math.random() * 120;
        noise.data[i] = noise.data[i + 1] = noise.data[i + 2] = v;
        noise.data[i + 3] = 255;
      }
      x.putImageData(noise, 0, 0);
      fn?.(x, c);
      return c;
    };
    const sharp = draw();
    const soft = draw((x, c) => {
      x.save();
      x.beginPath();
      x.rect(358, 269, 307, 230);
      x.clip();
      x.filter = "blur(12px)";
      x.drawImage(c, 0, 0);
      x.restore();
    });
    const glare = draw((x) => {
      x.fillStyle = "#fff";
      x.fillRect(358, 269, 307, 230);
    });
    return [sharp, soft, glare].map((c) => ceilingOf(measure(c)));
  });
  check("くっきりの背景でも、真ん中のぼけと白飛びで high にならない", img.join() === "high,mid,mid", img.join());

  // 期限切れの案内
  sql(`UPDATE projects SET expires_at = ${Date.now() - 1000} WHERE id = '${pid}'`);
  await g.goto(`${BASE}/#/`);
  await g.goto(`${BASE}/#/p/${pid}/list`);
  await g.reload();
  await g.waitForSelector("#denied");
  check("見本の期限切れは専用の案内を出す", /24 時間を過ぎた/.test(await g.locator("#denied").innerText()), await g.locator("#denied").innerText());
  await shot(g, "expired");
  await browser.close();
}

// 上限に当たった写真の画面
async function limitScreen() {
  console.log("\n# 上限の画面");
  await startServer({ SAMPLE_PHOTOS: 1 });
  const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, permissions: ["camera"], locale: "ja-JP" });
  const g = await ctx.newPage();
  const posts = [];
  g.on("request", (r) => {
    if (r.method() === "POST" && /\/items\?/.test(r.url())) posts.push(Date.now());
  });
  await g.goto(`${BASE}/#/`);
  await g.click("#try-sample");
  await g.waitForSelector(".card");
  const pid = g.url().match(/#\/p\/([^/]+)/)[1];
  await g.goto(`${BASE}/#/p/${pid}/capture`);
  await g.waitForSelector("#sample-cost");
  await sleep(800);
  await g.click("#pile-keep");
  await sleep(400);
  await g.click("#pile-keep");
  await g.waitForSelector('.shot[data-state="rejected"]', { timeout: 15000 });
  const txt = await g.locator('.shot[data-state="rejected"]').innerText();
  check("上限に当たった写真は理由を出す", txt.includes("見本で読める枚数の上限"), txt.replace(/\n/g, " "));
  const n = posts.length;
  await sleep(7000);
  check("上限の後は自動で送り直さない", posts.length === n, `${n}→${posts.length}`);
  check("見本の上限に「もう一度送る」を出さない", !txt.includes("もう一度送る") && txt.includes("この写真を外す"), txt.replace(/\s+/g, " "));
  await g.click('.capture-top a');
  await g.waitForSelector("#pending-discard");
  check("一覧でも外す案内と自分の片付けの案内が出る", (await g.locator("#to-own").count()) === 1 && !(await g.locator("#pending").innerText()).includes("もう一度送る"));
  await g.screenshot({ path: path.join(out, "r-limit-list.png") });
  await g.click("#pending-discard");
  await sleep(300);
  check("外すと案内が消える", (await g.locator("#pending").count()) === 0);
  await browser.close();
  await startServer({ SESSION_SECRET: "" });
  const bad = await new Client().post("/api/guest");
  check("鍵が空なら原因を返す", bad.status === 500 && bad.json?.error === "server_not_configured", bad.json?.error);
}

// ---- 10 レビューの指摘の確かめ（API） ----
const stubFail = (q) => fetch(`http://127.0.0.1:${STUB}/__fail?${q}`);
const SCHEDULED = `${BASE}/cdn-cgi/handler/scheduled`;

async function reviewApi() {
  console.log("\n# レビューの指摘（API）");
  // 見本の招待
  const g = new Client();
  const sample = (await g.post("/api/guest")).json.project_id;
  const si = await g.post(`/api/p/${sample}/invites`, { display_name: "架空S招待" });
  check("見本では招待を作れない", si.status === 400, si.status);

  // 招待の名前は作成者だけ
  const o = new Client();
  const p = await o.project("架空作成者", "架空の箱");
  const used = await o.invite(p, "架空参加の人");
  await o.invite(p, "架空未使用の人");
  const gone = await o.invite(p, "架空失効の人");
  await o.del(`/api/p/${p}/invites/${gone.id}`);
  const m = new Client();
  await m.join(used.token);
  const terms = JSON.stringify((await m.get(`/api/p/${p}/record-terms`)).json);
  check("参加者の隠す語に未使用と失効の招待の名前が無い", !terms.includes("架空未使用の人") && !terms.includes("架空失効の人"));
  check("参加者の隠す語に参加者の名前はある", terms.includes("架空参加の人"));
  const ownerTerms = JSON.stringify((await o.get(`/api/p/${p}/record-terms`)).json);
  check("作成者の隠す語には招待の名前も入る", ownerTerms.includes("架空未使用の人") && ownerTerms.includes("架空失効の人"));

  // 失効の二重取り消し
  const a = await o.invite(p, "架空戻る人");
  const back = new Client();
  await back.join(a.token);
  await o.del(`/api/p/${p}/invites/${a.id}`);
  check("失効で外れる", (await back.get(`/api/p/${p}/items`)).status !== 200);
  const name = (await back.me()).user?.display_name;
  const b = await o.invite(p, "架空戻る人2");
  const back2 = new Client();
  await back2.join(b.token);
  check("新しい招待で入れる", (await back2.get(`/api/p/${p}/items`)).status === 200, name);
  // 元の人を同じ user に戻す場面：招待 b を使った人を、古い招待 a の取り消しが外さないことを、行を付け替えて確かめる
  const backUser = (await back2.me()).user.id;
  sql(`UPDATE invites SET used_by_user_id = '${backUser}' WHERE id = '${a.id}'`);
  const again = await o.del(`/api/p/${p}/invites/${a.id}`);
  check("失効済みをもう一度取り消しても 204", again.status === 204, again.status);
  check("新しい招待で入った人は外れない", (await back2.get(`/api/p/${p}/items`)).status === 200);

  // 親族の種類、同じ名前、名前の変更
  const rel = await o.post(`/api/p/${p}/persons`, { label: "架空 親戚", subtype: "relative" });
  check("親族の種類で札を作れる", rel.status === 201 && rel.json.subtype === "relative", rel.status);
  const dup = await o.post(`/api/p/${p}/persons`, { label: "架空親戚", subtype: "vague" });
  check("同じ名前の札は 409 で既存を示す", dup.status === 409 && dup.json.person_id === rel.json.id, dup.status);
  const ren = await o.req("PATCH", `/api/p/${p}/persons/${rel.json.id}`, { label: "架空 親類" });
  const persons = (await o.get(`/api/p/${p}/persons`)).json.persons;
  check("札の名前を直せて、家族が直した印が付く", ren.status === 204 && persons[0].label === "架空 親類" && persons[0].renamed === true, ren.status);
  const other = await o.post(`/api/p/${p}/persons`, { label: "架空 別人" });
  const clash = await o.req("PATCH", `/api/p/${p}/persons/${other.json.id}`, { label: "架空親類" });
  check("直した名前が別の札と同じなら 409", clash.status === 409, clash.status);

  // 訂正した名前を札に結ぶ
  await stubReply({ lines: [{ text: "架空 はな 様", type: "name", handwritten: true, where: "上", certainty: "high" }] });
  const iid = (await o.photo(p)).json.item.id;
  await o.done(p, iid);
  await stubReply({});
  await o.post(`/api/p/${p}/items/${iid}/correction`, { line: 0, text: "架空 はる 様" });
  const cf = await o.post(`/api/p/${p}/persons/confirm-name`, { item_id: iid, line: 0 });
  const after = (await o.get(`/api/p/${p}/items/${iid}`)).json;
  check("訂正した名前の札ができ、物につながる", cf.status === 201 && after.claims.some((c) => c.person_label === "架空 はる" && c.source === "family"), cf.status);
  const cf2 = await o.post(`/api/p/${p}/persons/confirm-name`, { item_id: iid, line: 0 });
  const n = (await o.get(`/api/p/${p}/persons`)).json.persons.filter((x) => x.label === "架空 はる").length;
  check("もう一度押しても増えない", cf2.status === 200 && n === 1, `${cf2.status} ${n}`);

  // ひとことを消す
  await o.post(`/api/p/${p}/items/${iid}/wait`, { note: "架空のひとこと" });
  await o.post(`/api/p/${p}/items/${iid}/wait`, {});
  const keep = (await o.get(`/api/p/${p}/items/${iid}`)).json.waits[0].note;
  await o.post(`/api/p/${p}/items/${iid}/wait`, { note: "" });
  const cleared = (await o.get(`/api/p/${p}/items/${iid}`)).json.waits;
  check("note を送らなければひとことは残り、空で消える", keep === "架空のひとこと" && cleared.length === 1 && cleared[0].note === null, keep);

  // 見本：親族、仮説、参加の印、読み取りの段階
  const list = (await g.get(`/api/p/${sample}/items`)).json.items;
  const levels = list.reduce((acc, i) => ({ ...acc, [i.confidence]: (acc[i.confidence] ?? 0) + 1 }), {});
  console.log("    見本の読み取りの段階", JSON.stringify(levels));
  const letter = list.find((i) => i.title === "手書きの手紙");
  const ld = (await g.get(`/api/p/${sample}/items/${letter.id}`)).json;
  check("手書きの手紙の全体がはっきり", letter.confidence === "high", letter.confidence);
  const hyp = ld.claims.find((c) => c.source === "claude" && !c.item_ids.includes(letter.id));
  check("つながった人の別の物の仮説も返す", !!hyp, ld.claims.map((c) => c.source).join());
  check("強さは変えない", hyp?.strength === "weak", hyp?.strength);
  const sp = (await g.get(`/api/p/${sample}/persons`)).json.persons;
  const yuta = sp.find((x) => x.label === "ゆうた");
  check("見本の親族の種類", yuta?.subtype === "relative", yuta?.subtype);
  const greet = list.find((i) => i.title?.includes("誕生日"));
  const gd = (await g.get(`/api/p/${sample}/items/${greet?.id}`)).json;
  check("参加者と結び付いた札の印が詳細に届く", gd.claims?.some((c) => c.linked_name === "ゆうた"), gd.claims?.map((c) => c.linked_name).join());
}

async function reviewFail() {
  console.log("\n# レビューの指摘（失敗の扱い）");
  const o = new Client();
  const p = await o.project("架空F", "失敗の箱");
  await stubReply({});

  // 人物の更新が失敗しても拾い直す
  await stubFail("n=1000&call=P&status=400");
  const iids = [];
  for (let i = 0; i < 5; i++) iids.push((await o.photo(p, `pile=keep&ceiling=high&cid=f${i}`)).json.item.id);
  for (const i of iids) await o.done(p, i);
  const failed = await until(async () => (await o.get(`/api/p/${p}/persons`)).json.meta?.error, 30000);
  check("人物の更新の失敗が記録され、画面に渡る", failed === "api_error", failed);
  check("印は残る", count("items", `project_id = '${p}' AND persons_pending_at IS NOT NULL`) === 5);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, locale: "ja-JP" });
  const [cn, cv] = o.cookie.split(/=(.*)/s);
  await ctx.addCookies([{ name: cn, value: cv, url: BASE }]);
  const pg = await ctx.newPage();
  await pg.goto(`${BASE}/#/p/${p}/people`);
  await pg.waitForSelector("#persons-error");
  check("人の画面に更新の失敗が出る", (await pg.locator("#persons-error").innerText()).includes("失敗"));
  await pg.screenshot({ path: path.join(out, "r-persons-error.png") });
  await stubFail("n=0");
  await fetch(SCHEDULED);
  await sleep(3000);
  check("間を空けるまでは頼み直さない", count("items", `project_id = '${p}' AND persons_pending_at IS NOT NULL`) === 5);
  sql(`UPDATE items SET persons_pending_at = ${Date.now() - 400000} WHERE project_id = '${p}'`);
  sql(`UPDATE projects SET persons_meta_json = json_set(persons_meta_json, '$.at', ${Date.now() - 700000}) WHERE id = '${p}'`);
  await fetch(SCHEDULED);
  const cleared = await until(() => count("items", `project_id = '${p}' AND persons_pending_at IS NOT NULL`) === 0, 30000, 1000);
  check("定期処理が拾い直して片付く", cleared === true);
  check("直ると失敗の表示が消える", !(await o.get(`/api/p/${p}/persons`)).json.meta?.error);

  // 横向きの手書き：理由の 1 行と撮り直しの案内
  await stubReply({ lines: [{ text: "架空の文", type: "other", handwritten: true, rotated: true, where: "上", certainty: "high" }] });
  const rot = (await o.photo(p, "pile=keep&ceiling=high&cid=frot")).json.item.id;
  await o.done(p, rot);
  await stubReply({});
  await pg.goto(`${BASE}/#/p/${p}/item/${rot}`);
  await pg.waitForSelector("#reason-line");
  check("詳細に字を上に向ける案内が出る", (await pg.locator("#reason-line").innerText()).includes("字を上に向けて"));
  await pg.goto(`${BASE}/#/p/${p}/list`);
  await pg.waitForSelector(".retake-hint");
  check("一覧のカードにも案内が出る", (await pg.locator(".retake-hint").first().innerText()).includes("字を上に向けて"));
  await pg.screenshot({ path: path.join(out, "r-retake-hint.png") });
  await browser.close();

  // A だけ失敗
  await stubFail("n=1&call=A&status=400");
  const a = (await o.photo(p, "pile=keep&ceiling=high&cid=fa")).json.item.id;
  const ad = await o.done(p, a);
  check("A だけ失敗してもカードが残る", ad.item.status === "done" && ad.item.error_code === "read_api_error" && !!ad.reading.b, ad.item.error_code);
  check("A だけ失敗した物はやり直せる", ad.item.can_retry);

  // 再読が失敗し続けても、最後の試行でカードになる
  await stubFail("n=1000&call=A2&status=500");
  const b = (await o.photo(p, "pile=keep&ceiling=high&cid=fb")).json.item.id;
  const bd = await until(async () => {
    const r = await o.get(`/api/p/${p}/items/${b}`);
    return r.json.item.status === "done" || r.json.item.status === "failed" ? r.json : null;
  }, 90000, 1000);
  await stubFail("n=0");
  check("再読だけ失敗し続けても読み終える", bd?.item.status === "done", bd?.item.status);
  check("再読なしは「はっきり」にしない", bd?.item.confidence !== "high", bd?.item.confidence);
  check("再読の失敗を計測に残す", bd?.meta?.guard?.reread_error === "api_error", bd?.meta?.guard?.reread_error);
}

// ---- 11 レビューの指摘の確かめ（画面） ----
async function reviewUi() {
  console.log("\n# レビューの指摘（画面）");
  const browser = await chromium.launch({
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  const phone = { viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true, locale: "ja-JP", permissions: ["camera"] };
  const ctx = await browser.newContext(phone);
  const g = await ctx.newPage();
  const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });
  await g.goto(`${BASE}/#/`);
  await g.click("#try-sample");
  await g.waitForSelector(".card");
  const pid = g.url().match(/#\/p\/([^/]+)/)[1];

  // 入口のボタン
  await g.goto(`${BASE}/#/`);
  await g.waitForSelector(".resume");
  check("見本があるとき入口の「見本で試す」は出ない", (await g.locator("#try-sample").count()) === 0);
  await g.goto(`${BASE}/#/p/${pid}/list`);
  await g.waitForSelector(".card");

  // 戻っても検索と絞り込みと位置が残る
  await g.click("#filter-unsure");
  await g.fill("#search", "手紙");
  await g.waitForFunction(() => document.querySelector("#count")?.textContent.includes("「手紙」で"));
  const before = await g.locator("#count").innerText();
  await g.locator(".card").first().click();
  await g.waitForSelector("#wait-btn");
  await g.click(".back");
  await g.waitForFunction(() => document.querySelector("#count")?.textContent.includes("「手紙」"));
  check("詳細から戻っても検索語が残る", (await g.inputValue("#search")) === "手紙", await g.locator("#count").innerText());
  check("詳細から戻っても絞り込みが残る", (await g.getAttribute("#filter-unsure", "aria-pressed")) === "true");
  check("件数の行も同じ", (await g.locator("#count").innerText()) === before);
  await g.fill("#search", "");
  await g.click("#filter-all");
  await g.waitForFunction(() => document.querySelector("#count")?.textContent.startsWith("全 "));
  await g.evaluate(() => window.scrollTo(0, 900));
  await sleep(200);
  const y0 = await g.evaluate(() => window.scrollY);
  await g.evaluate(() => {
    const below = [...document.querySelectorAll(".card")].find((c) => c.getBoundingClientRect().top > 100);
    below.click();
  });
  await g.waitForSelector("#wait-btn");
  await g.click(".back");
  await g.waitForSelector(".card");
  await sleep(600);
  const y1 = await g.evaluate(() => window.scrollY);
  check("詳細から戻るとスクロールの位置が戻る", Math.abs(y1 - y0) < 8 && y0 > 0, `${y0}→${y1}`);

  // いらないと待ったの重ね
  await g.click("#filter-drop");
  await g.click("#filter-waited");
  await sleep(200);
  const items = await g.evaluate(async (p) => (await (await fetch(`/api/p/${p}/items`)).json()).items, pid);
  const dropWaited = items.filter((i) => i.pile === "drop" && i.wait_count > 0).length;
  check("いらないと待ったを重ねると、待ったの物が出る", (await g.locator(".card").count()) === dropWaited && dropWaited > 0, `${dropWaited}`);
  await shot(g, "r-drop-waited");
  await g.click("#filter-waited");
  await g.click("#filter-all");

  // モノ詳細：仮説、参加の印、理由の 1 行、ボタンの名前
  const letter = items.find((i) => i.title === "手書きの手紙");
  await g.goto(`${BASE}/#/p/${pid}/item/${letter.id}`);
  await g.waitForSelector("#relmap");
  const rel = await g.locator("#relmap").innerText();
  check("手紙の詳細に同じ人の仮説が出る", rel.includes("俳句を続けていた人かもしれない") && rel.includes("この人についての仮説"));
  check("別の物が根拠の仮説は、この物から点線を引かない", (await g.locator("#relsvg line.rs-dotted").count()) === 0);
  check("理由の 1 行が出る", (await g.locator("#reason-line").innerText()).startsWith("手がかり："), await g.locator("#reason-line").innerText());
  check("物の名前を直す、と書く", (await g.locator("button.linkish").innerText()) === "物の名前を直す");
  await shot(g, "r-detail-hypothesis");
  const greet = items.find((i) => i.title?.includes("誕生日"));
  await g.goto(`${BASE}/#/p/${pid}/item/${greet.id}`);
  await g.waitForSelector("#relmap .joined-mark", { timeout: 8000 }).catch(() => {});
  check("関係図の札に参加中が出る", (await g.locator("#relmap .joined-mark").count()) >= 1 && (await g.locator("#relsvg .rs-joined").count()) >= 1);
  await shot(g, "r-detail-joined");

  // 人の画面：参加の印、親族、招待の案内
  await g.goto(`${BASE}/#/p/${pid}/people`);
  await g.waitForSelector(".person-card");
  const yuta = g.locator(".person-card", { has: g.locator(".label", { hasText: "ゆうた" }) });
  check("参加者に結び付いた札に印が出る", (await yuta.locator(".joined-mark").innerText()) === "参加中" && (await yuta.locator(".avatar").count()) === 1);
  check("情報だけの札に印は出ない", (await g.locator(".person-card:not(.joined) .joined-mark").count()) === 0);
  check("札の種類に親族がある", (await yuta.locator("select.subtype").inputValue()) === "relative");
  check("見本に招待の入力欄が無い", (await g.locator("#invite-form").count()) === 0 && (await g.locator("#invite-sample").count()) === 1);
  await shot(g, "r-people");

  // 人物の足し算と重複
  await g.click("#add-person");
  await g.fill("#ask-input", "山里はな");
  await g.click('#ask button[type="submit"]');
  await g.waitForSelector(".person-card.found");
  check("同じ名前を足すと既存の札を示す", (await g.locator(".person-card.found .label").innerText()) === "山里 はな");
  check("札は増えない", (await g.locator(".person-card .label", { hasText: "山里 はな" }).count()) === 1);

  // 名前を直す
  await g.locator(".person-card", { has: g.locator(".label", { hasText: "川辺 みつ" }) }).locator("button.rename").click();
  await g.fill("#ask-input", "川辺 みち");
  await g.click('#ask button[type="submit"]');
  await g.waitForSelector(".renamed");
  check("札の名前を直すと印が出る", (await g.locator(".person-card", { has: g.locator(".label", { hasText: "川辺 みち" }) }).locator(".renamed").count()) === 1);

  // ひとことを空にする
  const plain = items.find((i) => i.status === "done" && !i.wait_count);
  await g.goto(`${BASE}/#/p/${pid}/item/${plain.id}`);
  await g.waitForSelector("#wait-btn");
  await g.click("#wait-btn");
  await g.waitForSelector("#wait-note");
  await g.click("#wait-note");
  await g.fill("#ask-input", "架空のひとこと");
  await g.click('#ask button[type="submit"]');
  await g.waitForSelector("#waits .note");
  await g.click("#wait-note");
  await g.fill("#ask-input", "");
  await g.click('#ask button[type="submit"]');
  await sleep(500);
  check("ひとことの窓は空でも閉じる", !(await g.locator("#ask").evaluate((d) => d.open)));
  check("空で保存するとひとことが消える", (await g.locator("#waits .note").count()) === 0);
  await g.click("#wait-note");
  await g.fill("#ask-input", "架空のひとこと");
  await g.click('#ask button[type="submit"]');
  await g.waitForSelector("#waits .note");
  await g.click("#wait-btn");
  await g.waitForFunction(() => document.querySelector("#toast")?.textContent.includes("ひとことも消えました"));
  check("待ったの取り消しでひとことが消えると案内が出る", true);

  // 録画モード
  await g.evaluate(() => localStorage.setItem("matta.record", "1"));
  await g.goto(`${BASE}/#/p/${pid}/list`);
  await g.reload();
  await g.waitForSelector(".card");
  check("見本の定型文が隠れない", (await g.locator(".list-head").innerText()).includes("名前も物も架空です"));
  await g.fill("#search", "山里");
  await g.waitForFunction(() => document.querySelector("#count")?.textContent.includes("で "));
  await sleep(500);
  const cnt = await g.locator("#count").innerText();
  check("録画モードの件数の行に検索語が出ない", !cnt.includes("山里") && cnt.includes("■■"), cnt);
  const sec = await g.evaluate(() => getComputedStyle(document.querySelector("#search")).webkitTextSecurity);
  check("録画モードの検索欄は点で見える", sec === "disc", sec);
  await shot(g, "r-rec-search");
  await g.fill("#search", "");
  await g.goto(`${BASE}/#/p/${pid}/people`);
  await g.waitForSelector(".person-card");
  await sleep(600);
  const body = await g.locator("#app").innerText();
  check("録画モードの札の見出しに名前が残らない", !/ゆうた|山里|川辺/.test(body), body.slice(0, 60));
  check("録画モードでも参加中の印は残る", (await g.locator(".person-card .joined-mark").first().innerText()) === "参加中");
  await g.click("#add-person");
  await g.fill("#ask-input", "架空の川上さん");
  const sec2 = await g.evaluate(() => getComputedStyle(document.querySelector("#ask-input")).webkitTextSecurity);
  check("録画モードの人物の入力は点で見える", sec2 === "disc", sec2);
  await shot(g, "r-rec-addperson");
  await g.click('#ask button[type="button"]');
  const yutaItem = items.find((i) => i.wait_count > 0);
  await g.goto(`${BASE}/#/p/${pid}/item/${yutaItem.id}`);
  await g.waitForSelector("#wait-btn");
  await g.click("#add-note");
  await g.waitForSelector("#ask-input");
  const sec3 = await g.evaluate(() => getComputedStyle(document.querySelector("#ask-input")).webkitTextSecurity);
  check("録画モードのメモの入力は点で見える", sec3 === "disc", `${sec3} ${await g.evaluate(() => document.querySelector("#ask-input").tagName)}`);
  await g.click('#ask button[type="button"]');
  await g.evaluate(() => localStorage.setItem("matta.record", "0"));
  await g.reload();

  // 訂正した名前を札にする
  await stubReply({ lines: [{ text: "架空 はな 様", type: "name", handwritten: true, where: "上", certainty: "high" }] });
  const iid = await g.evaluate(async (p) => {
    const blob = await (await fetch("/sample/note-thumb.jpg")).blob();
    const r = await fetch(`/api/p/${p}/items?pile=keep&ceiling=high`, { method: "POST", headers: { "content-type": "image/jpeg" }, body: blob });
    return (await r.json()).item.id;
  }, pid);
  await until(async () => (await g.evaluate(async ([p, i]) => (await (await fetch(`/api/p/${p}/items/${i}`)).json()).item.status, [pid, iid])) === "done");
  await stubReply({});
  await g.goto(`${BASE}/#/p/${pid}/item/${iid}`);
  await g.waitForSelector(".line-row button");
  await g.locator(".line-row button").first().click();
  await g.fill("#ask-input", "架空 はる 様");
  await g.click('#ask button[type="submit"]');
  await g.waitForSelector(".to-person");
  await g.click(".to-person");
  await g.click('#ask button[type="submit"]');
  await g.waitForFunction(() => document.querySelector("#relmap")?.textContent.includes("架空 はる"));
  check("訂正した名前を札にして、詳細につながる", true);
  await shot(g, "r-correct-to-person");

  // 横向き
  await g.setViewportSize({ width: 780, height: 360 });
  await g.goto(`${BASE}/#/p/${pid}/capture`);
  await g.waitForSelector("video");
  await sleep(800);
  const h0 = await g.evaluate(() => document.querySelector(".viewfinder").getBoundingClientRect().height);
  await g.click("#pile-keep");
  await g.waitForSelector("#undo-bar");
  await sleep(300);
  const h1 = await g.evaluate(() => document.querySelector(".viewfinder").getBoundingClientRect().height);
  await shot(g, "r-landscape-hold");
  await sleep(7000);
  const h2 = await g.evaluate(() => document.querySelector(".viewfinder").getBoundingClientRect().height);
  check("横向きで撮っても映像の高さが残る", h0 > 140 && h1 > 140 && h2 > 140, `${h0}/${h1}/${h2}`);
  const btn = await g.evaluate(() => [...document.querySelectorAll(".pile-buttons button")].map((b) => Math.round(b.getBoundingClientRect().height)));
  check("横向きでもボタンが押せる高さ", btn.every((x) => x >= 48), btn.join());
  await shot(g, "r-landscape-after");
  await g.setViewportSize({ width: 390, height: 780 });
  await g.goto(`${BASE}/#/p/${pid}/capture`);
  await g.waitForSelector("video");
  await sleep(800);
  const portrait = await g.evaluate(() => document.querySelector(".viewfinder").getBoundingClientRect().height);
  check("縦向きの映像は元のまま", portrait > 200, portrait);

  // 取り消せる間に一覧へ
  await g.click("#pile-keep");
  await g.waitForSelector("#undo-bar");
  await g.click(".capture-top a");
  await g.waitForSelector("#pending-undo");
  check("一覧でも取り消せると分かる", (await g.locator("#pending-hold").innerText()).includes("取り消せます"));
  await shot(g, "r-list-hold");
  await g.click("#pending-undo");
  await sleep(300);
  check("一覧の取り消しで写真が外れる", (await g.locator("#pending").count()) === 0);
  await ctx.close();

  // 「人」の画面を開いたまま、招待の行が新しくなる。名前のある人が開くと、その名前を出す
  const octx = await browser.newContext(phone);
  const o = await octx.newPage();
  await o.goto(`${BASE}/#/`);
  await o.click("summary:has-text('新しい片付けを始める')");
  await o.fill("#new-name", "架空O");
  await o.fill("#new-title", "招待の箱");
  await o.click("#new-project button[type=submit]");
  await o.waitForSelector("#invite-form");
  const op = o.url().match(/#\/p\/([^/]+)/)[1];
  await o.fill("#invite-name", "たけし");
  await o.click("#invite-form button[type=submit]");
  await o.waitForSelector("#invite-url");
  const url = await o.locator("#invite-url").innerText();
  await o.waitForSelector(".invite-row");
  const other = new Client();
  await other.project("別の人", "別の箱");
  const j = await other.join(url.split("#/join/")[1]);
  const seen = await until(async () => (await o.locator(".invite-row").first().innerText()).includes("別の人さんが参加しました"), 12000);
  check("開いたままの画面で招待の行が更新され、入った人の名前が出る", !!seen && j.status === 200, await o.locator(".invite-row").first().innerText());
  await shot(o, "r-invite-row");
  await browser.close();
}

const sections = { invites, sampleLockout, correction, guards, limits, killSwitch, purge, stale, requeue, screens, limitScreen, reviewApi, reviewFail, reviewUi };
try {
  await startServer();
  for (const [name, fn] of Object.entries(sections)) {
    if (only && !only.includes(name)) continue;
    try {
      await fn();
    } catch (e) {
      check(`${name} が最後まで走る`, false, e.message?.split("\n")[0]);
    }
    if (["limits", "killSwitch", "limitScreen"].includes(name) || !server) await startServer();
  }
} finally {
  await stopServer();
  console.log(`\n失敗 ${failures.length} 件${failures.length ? `：\n- ${failures.join("\n- ")}` : ""}`);
  stopTree(stub);
  process.exit(failures.length ? 1 : 0);
}
