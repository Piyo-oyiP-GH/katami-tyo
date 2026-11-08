// 画面の試験。スマホの大きさで、wrangler dev に対して動かす。
//   node scripts/app/ui-test.mjs [--out <リポジトリの外のフォルダ>]
// Claude は stub-claude.mjs に置き換える。写真は試験の中で生成した小さな画像だけを使う。
// 本物の .dev.vars は読まず、試験用の値だけの env ファイルを出力先に作る。
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isInside } from "../lib/paths.mjs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repo = path.resolve(root, "..");
const argOut = process.argv.indexOf("--out");
const out = path.resolve(
  argOut > 0 ? process.argv[argOut + 1] : path.join(repo, "..", ".matta-state", "ui-test"),
);
if (isInside(repo, out)) throw new Error("出力はリポジトリの外にしてください");
const state = path.join(out, `state-${Date.now()}`);
mkdirSync(state, { recursive: true });

const PORT = 8792;
const STUB = 8793;
const BASE = `http://127.0.0.1:${PORT}`;
const PHONE = {
  viewport: { width: 390, height: 780 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  locale: "ja-JP",
};

const results = [];
const failures = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "OK  " : "NG  "}${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(name);
}
const ITEMS_RE = /\/items\?/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 200) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return { value: v, ms: Date.now() - t0 };
    if (Date.now() - t0 > ms) return { value: null, ms: Date.now() - t0 };
    await sleep(step);
  }
}
const sha = (b) => createHash("sha256").update(b).digest("hex");

// ---- サーバ ----
const envFile = path.join(state, "test.env");
writeFileSync(
  envFile,
  `ANTHROPIC_API_KEY=stub\nANTHROPIC_BASE_URL=http://127.0.0.1:${STUB}\nSESSION_SECRET=${randomBytes(24).toString("hex")}\nGUEST_IP_DAILY=1000\nGUEST_TOTAL_DAILY=1000\nPROJECT_IP_DAILY=1000\nSAMPLE_PHOTOS=1000\nSAMPLE_IP_DAILY=1000\nIP_DAILY=1000\nTOTAL_DAILY=1000\n`,
);
const env = { ...process.env, MATTA_STATE_DIR: state };
const procs = [];
function run(args, opts = {}) {
  const p = spawn(process.execPath, args, { cwd: root, env, stdio: opts.stdio ?? "ignore" });
  procs.push(p);
  return p;
}
await new Promise((resolve, reject) => {
  run(["scripts/dev.mjs", "migrate"]).on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`migrate ${c}`))));
});
run(["scripts/app/stub-claude.mjs", String(STUB), "1500"]);
run([
  "scripts/dev.mjs", "dev", "--port", String(PORT), "--inspector-port", "9342",
  "--env-file", envFile,
]);
const stopAll = () => {
  // Windows では子の workerd まで止める
  for (const p of procs) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" });
    else p.kill();
  }
};
process.on("exit", stopAll);

const up = await until(async () => {
  try {
    return (await fetch(`${BASE}/api/health`)).ok;
  } catch {
    return false;
  }
}, 60000, 500);
if (!up.value) throw new Error("サーバが起動しませんでした");
const stubHits = async () => Number(await (await fetch(`http://127.0.0.1:${STUB}/__hits`)).text());

// ---- ブラウザ ----
const browser = await chromium.launch({
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const newCtx = async (extra = {}) => {
  const ctx = await browser.newContext({ ...PHONE, permissions: ["camera"], ...extra });
  return ctx;
};
const noCamera = () => {
  Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
};

// 小さな JPEG を canvas で作る
async function makeJpeg(page, { w = 320, h = 240, noise = false, q = 0.9 } = {}) {
  const b64 = await page.evaluate(
    ({ w, h, noise, q }) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d");
      g.fillStyle = "#fff";
      g.fillRect(0, 0, w, h);
      if (noise) {
        const img = g.createImageData(w, h);
        const buf = new Uint32Array(img.data.buffer);
        const chunk = new Uint32Array(16384);
        for (let i = 0; i < buf.length; i += chunk.length) {
          crypto.getRandomValues(chunk);
          buf.set(chunk.subarray(0, Math.min(chunk.length, buf.length - i)), i);
        }
        for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
        g.putImageData(img, 0, 0);
      } else {
        g.fillStyle = "#223";
        g.font = "24px sans-serif";
        g.fillText("TEST", 20, 60);
        g.fillRect(20, 80, w / 2, 8);
      }
      return c.toDataURL("image/jpeg", q).split(",")[1];
    },
    { w, h, noise, q },
  );
  return Buffer.from(b64, "base64");
}

// EXIF の向きを入れた JPEG を作る
function withExifOrientation(jpeg, orientation, extra = "") {
  const tiff = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // II*\0 と IFD の位置
    0x01, 0x00, // 項目 1 つ
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff, Buffer.from(extra, "latin1")]);
  const len = body.length + 2;
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, len >> 8, len & 255]), body]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

async function apiJson(page, url, init) {
  return page.evaluate(
    async ({ url, init }) => {
      const r = await fetch(url, init);
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    { url, init },
  );
}

try {
  // ===== 1. 見本（T4c、T3） =====
  const gctx = await newCtx();
  const g = await gctx.newPage();
  await g.goto(`${BASE}/`);
  await shot(g, "01_entry");
  await g.click("#try-sample");
  await g.waitForSelector(".card");
  await shot(g, "02_list");
  const sampleUrl = g.url();
  const samplePid = sampleUrl.match(/\/p\/([^/]+)\//)[1];
  const cards = await g.locator(".card h2").allInnerTexts();
  check("見本は架空の物を複製する", cards.length === 12, `${cards.length} 件`);
  check("手がかりの多い順。先頭は手書きの物", /手紙|紙焼き/.test(cards[0]), cards[0]);
  check(
    "大切さの順ではないと書いてある",
    (await g.innerText("#order-note")).includes("大切さの順ではありません"),
  );
  check("理由チップが出る", (await g.locator(".chip").count()) > 5);
  check("撮り直し候補が下に埋もれず見える", (await g.locator(".card", { hasText: "ぼけた" }).locator(".chip", { hasText: "撮り直し候補" }).count()) === 1);
  const gme = (await apiJson(g, "/api/me")).body;
  const sp = gme.projects[0];
  const leftH = (sp.expires_at - Date.now()) / 3600000;
  check("見本の期限が 24 時間で記録される", sp.is_sample && leftH > 23.9 && leftH <= 24, `${leftH.toFixed(2)} 時間`);

  // 検索と一致元
  const expectMatch = async (q, label) => {
    await g.fill("#search", q);
    const r = await until(async () => {
      const t = await g.locator(".match").allInnerTexts();
      return t.some((s) => s.includes(label)) ? t : null;
    }, 5000);
    check(`検索「${q}」は${label}`, !!r.value, r.value?.[0] ?? "");
  };
  await expectMatch("梅", "文字で一致");
  await expectMatch("手帳", "物名で一致");
  await expectMatch("表彰状", "類義語で一致");
  await expectMatch("旅行", "見立てで一致");
  await shot(g, "03_search");
  await g.fill("#search", "存在しない語");
  await g.waitForSelector(".empty");
  await g.fill("#search", "");
  await g.waitForFunction(() => document.querySelectorAll(".card").length === 12);

  // 山の絞り込みと、待ったの物だけ
  await g.click("#filter-keep");
  check("山で絞れる", (await g.locator(".card").count()) === 2);
  await g.click("#filter-all");
  await g.click("#filter-waited");
  check("待ったの物だけに絞れる", (await g.locator(".card").count()) === 4);
  await shot(g, "04_waited");
  await g.click("#filter-waited");

  // 詳細と関係図
  await g.locator(".card", { hasText: "手書きの手紙" }).click();
  await g.waitForSelector("#relmap");
  const srcs = await g.locator("#relmap .rel").evaluateAll((els) => els.map((e) => e.dataset.source));
  check("関係図に 3 種類が出る／実線と吹き出し", srcs.includes("photo") && srcs.includes("family"), srcs.join(","));
  await g.waitForSelector("#relsvg");
  check(
    "関係図の絵に実線と吹き出しがある",
    (await g.locator("#relsvg .rs-solid").count()) > 0 && (await g.locator("#relsvg .rs-bubble").count()) > 0,
  );
  check("関係図の絵から関連する物へ飛べる", (await g.locator("#relsvg a").count()) > 0);
  check(
    "強さの数に「はっきり」が出る",
    (await g.locator("#relmap .rel.photo .sub").first().innerText()).includes("はっきり"),
  );
  await g.locator("#relsvg").evaluate((e) => e.scrollIntoView({ block: "start" }));
  await g.screenshot({ path: path.join(out, "05_relsvg.png") });
  await shot(g, "05_detail");
  await g.screenshot({ path: path.join(out, "05_detail_full.png"), fullPage: true });
  check("待ったは下に固定", await g.locator(".wait-bar").evaluate((e) => getComputedStyle(e).position === "fixed"));

  // 「違う」ボタン
  await g.locator(".line-row button").first().click();
  await g.fill("#ask-input", "山里 花 様");
  await g.click("#ask button[type=submit]");
  await g.waitForFunction(() => document.querySelector(".read")?.textContent === "山里 花 様");
  check("「違う」で家族の訂正が出る", (await g.locator(".line-row .sub").first().innerText()) === "家族の訂正");

  // 録画モード
  await g.goto(`${BASE}/#/p/${samplePid}/people`);
  await g.waitForSelector(".person-card");
  await shot(g, "06_people");
  check("人の画面に関連する物が出る", (await g.locator(".person-card .related a").count()) > 0);
  check("人の札の種類を選べる", (await g.locator(".person-card select.subtype").count()) > 0);
  const rawBefore = (await apiJson(g, `/api/p/${samplePid}/persons`)).body;
  await g.check("#record-mode");
  await g.waitForFunction(() => !document.body.innerText.includes("山里"));
  await shot(g, "07_record_people");
  const secret = ["梅が咲", "山里", "はな", "川辺", "みつ", "ゆうた", "みさき", "正一", "若葉", "河口湖", "昭和", "一九七二", "緑ヶ丘", "風鈴", "見本の片付け", "けんじ", "茶碗蒸し", "おめでとう", "十年間", "取扱説明書", "KP-220"];
  const leak = async (where) => {
    const t = await g.evaluate(() => document.body.innerText + document.title);
    const hits = secret.filter((s) => t.includes(s));
    check(`録画モード：${where}に名前と文字が残らない`, hits.length === 0, hits.join(","));
    return t;
  };
  const tPeople = await leak("人の画面");
  check("録画モード：親族A と 人物B が出る", /親族A/.test(tPeople) && /人物B/.test(tPeople));
  await g.click("#tab-list");
  await g.waitForSelector(".card");
  await g.waitForTimeout(300);
  await leak("一覧");
  await shot(g, "08_record_list");
  await g.fill("#search", "梅");
  await g.waitForSelector(".match");
  await g.waitForTimeout(200);
  const matchText = await g.locator(".match").first().innerText();
  check("録画モード：検索の一致語も隠れる", matchText.includes("■■") && !matchText.includes("梅"), matchText);
  await g.fill("#search", "");
  await g.waitForFunction(() => document.querySelectorAll(".card").length === 12);
  await g.locator(".card").nth(0).click();
  await g.waitForSelector(".read");
  await g.waitForTimeout(300);
  await leak("詳細");
  const svgText = await g.locator("#relsvg").evaluate((e) => e.textContent);
  const svgHits = secret.filter((w) => svgText.includes(w));
  check("録画モード：関係図の絵に名前が残らない", svgHits.length === 0, svgHits.join(","));
  await shot(g, "09_record_detail");
  const rawAfter = (await apiJson(g, `/api/p/${samplePid}/persons`)).body;
  // 人物の更新の時刻と計測は、裏のキューで変わるので比べない
  const cardsOnly = ({ participants, persons }) => JSON.stringify({ participants, persons });
  check("録画モードでデータは変わらない", cardsOnly(rawBefore) === cardsOnly(rawAfter));
  await g.goto(`${BASE}/#/p/${samplePid}/people`);
  await g.waitForSelector("#record-mode");
  await g.uncheck("#record-mode");
  await g.waitForFunction(() => document.body.innerText.includes("山里"));
  check("録画モードを切ると元に戻る", true);

  // ===== 2. 招待、参加者（T4a） =====
  const actx = await newCtx();
  const a = await actx.newPage();
  await a.goto(`${BASE}/`);
  await a.locator("summary", { hasText: "新しい片付け" }).click();
  await a.fill("#new-name", "架空のあき");
  await a.fill("#new-title", "試験の押し入れ");
  await a.click("#new-project button[type=submit]");
  await a.waitForSelector("#invite-form");
  const pid = a.url().match(/\/p\/([^/]+)\//)[1];
  await a.fill("#invite-name", "架空のふゆ");
  await a.click("#invite-form button[type=submit]");
  await a.waitForSelector("#invite-url");
  const inviteUrl = await a.innerText("#invite-url");
  await shot(a, "10_invite");
  const token = inviteUrl.split("/join/")[1];
  check("招待のトークンは 128bit 以上", token.length >= 32, `${token.length * 4}bit`);

  const bctx = await newCtx();
  const b = await bctx.newPage();
  await b.goto(inviteUrl);
  await b.waitForSelector("#search");
  check("招待を開くだけで入れる。名前の入力なし", b.url().includes(`/p/${pid}/list`));
  check("URL からトークンが消える", !b.url().includes(token));
  const bme = (await apiJson(b, "/api/me")).body;
  check("招待の名前が付く", bme.user.display_name === "架空のふゆ", bme.user.display_name);

  // 作成者が使用済みのリンクを押しても、作成者のまま
  await a.goto(inviteUrl);
  await a.reload();
  await a.waitForSelector("#search");
  const ame = (await apiJson(a, "/api/me")).body;
  check(
    "作成者が使用済みの招待を開いても入れ替わらない",
    ame.user.display_name === "架空のあき" && ame.projects.find((p) => p.id === pid)?.role === "owner",
    ame.user.display_name,
  );

  // 同じ人の別の端末
  const b2ctx = await newCtx();
  const b2 = await b2ctx.newPage();
  await b2.goto(inviteUrl);
  await b2.waitForSelector("#search");
  const b2me = (await apiJson(b2, "/api/me")).body;
  check("同じ招待の 2 台目は同じ人になる", b2me.user.id === bme.user.id);
  await b2ctx.close();

  // ===== 3. 撮影（T1a、T1b、T1c） =====
  await a.goto(`${BASE}/#/p/${pid}/capture`);
  await a.waitForFunction(() => document.querySelector("video")?.videoWidth > 0, null, { timeout: 15000 });
  await shot(a, "11_capture");
  const btnBox = await a.locator("#pile-keep").boundingBox();
  check("ボタンは親指の届く下半分で大きい", btnBox.y > 780 * 0.6 && btnBox.height >= 88, `高さ ${btnBox.height}px`);
  const posts = [];
  a.on("request", (r) => {
    if (r.method() === "POST" && /\/items\?/.test(r.url())) posts.push({ url: r.url(), t: Date.now() });
  });

  // 取り消し
  await a.click("#pile-drop");
  await a.waitForSelector("#undo-bar");
  await shot(a, "12_undo");
  check("押すとすぐカードが出る", (await a.locator(".shot").count()) === 1);
  await a.click("#undo");
  await sleep(5600);
  check("5 秒以内の取り消しでは何も送らない", posts.length === 0 && (await a.locator(".shot").count()) === 0);

  // 撮影 → 5 秒後に送る → 読み取り中 → 完了
  const t0 = Date.now();
  await a.click("#pile-keep");
  await a.waitForSelector('.shot[data-state="hold"]');
  const sent = await until(() => posts.length > 0, 9000, 50);
  check("5 秒待ってから送る", sent.value && posts[0].t - t0 >= 4800, `${posts[0]?.t - t0}ms`);
  check("山と端末の測定値を送る", /pile=keep/.test(posts[0].url) && /ceiling=(high|mid|low)/.test(posts[0].url), posts[0].url.split("?")[1].replace(/cid=[^&]+/, "cid=…"));
  const reading = await until(async () => (await a.locator(".shot .shot-status").first().innerText()) === "読み取り中", 6000, 50);
  check("読み取り中の状態が出る", !!reading.value);
  await shot(a, "13_reading");
  const done = await until(async () => (await a.locator('.shot[data-state="done"]').count()) === 1, 20000);
  check("読み取りが終わるとカードが変わる", !!done.value, `${done.ms}ms`);
  check("Claude は置き換えに届いている", (await stubHits()) > 0, `${await stubHits()} 回`);

  // 標準カメラの経路（http の代わりに mediaDevices を消す）
  const nctx = await newCtx({ storageState: await actx.storageState() });
  await nctx.addInitScript(noCamera);
  const n = await nctx.newPage();
  await n.goto(`${BASE}/#/p/${pid}/capture`);
  await n.waitForSelector("#native-hint");
  await shot(n, "14_native");
  const sendNative = async (pile, buffer) => {
    const [chooser] = await Promise.all([n.waitForEvent("filechooser"), n.click(`#pile-${pile}`)]);
    await chooser.setFiles({ name: "test.jpg", mimeType: "image/jpeg", buffer });
  };
  const small = await makeJpeg(n, { w: 640, h: 480 });
  const itemsOf = async () => (await apiJson(n, `/api/p/${pid}/items`)).body.items;
  const before = (await itemsOf()).length;
  await sendNative("unsure", small);
  const r1 = await until(async () => ((await itemsOf()).length === before + 1 ? await itemsOf() : null), 12000);
  const first = r1.value?.find((i) => i.pile === "unsure");
  check("標準カメラでも撮って山に入る", !!first, first?.pile);
  const served = await n.evaluate(async (u) => {
    const r = await fetch(u);
    return { status: r.status, hex: [...new Uint8Array(await r.arrayBuffer())].map((x) => String.fromCharCode(x)).join("") };
  }, first.photo_url);
  check("原寸の写真がそのまま届く（ハッシュ一致）", sha(Buffer.from(served.hex, "latin1")) === sha(small), `${small.length} バイト`);
  const thumb = await until(async () => (await n.evaluate(async (u) => (await fetch(u)).status, first.thumb_url)) === 200, 5000);
  check("縮小画像も保存される", !!thumb.value);

  // EXIF の向きと位置
  const exif = withExifOrientation(small, 6, "FAKEGPS");
  await sendNative("drop", exif);
  const r2 = await until(async () => {
    const list = await itemsOf();
    return list.length === before + 2 ? list : null;
  }, 12000);
  const rot = r2.value?.sort((x, y) => y.seq - x.seq)[0];
  const dims = await n.evaluate(async (u) => {
    const bm = await createImageBitmap(await (await fetch(u)).blob());
    return [bm.width, bm.height];
  }, rot.photo_url);
  check("EXIF の向きは残す。画素は作り直さない", dims[0] === 480 && dims[1] === 640, dims.join("x"));
  const rotBytes = await n.evaluate(async (u) => {
    const r = await fetch(u);
    return [...new Uint8Array(await r.arrayBuffer())].map((x) => String.fromCharCode(x)).join("");
  }, rot.photo_url);
  check("位置などの EXIF は送らない", !rotBytes.includes("FAKEGPS") && rotBytes.length < small.length + 64, `${rotBytes.length} バイト`);
  const exif1 = withExifOrientation(small, 1);
  await sendNative("drop", exif1);
  const r3 = await until(async () => {
    const list = await itemsOf();
    return list.length === before + 3 ? list : null;
  }, 12000);
  const plain = r3.value?.sort((x, y) => y.seq - x.seq)[0];
  const plainHash = await n.evaluate(async (u) => {
    const r = await fetch(u);
    return [...new Uint8Array(await r.arrayBuffer())].map((x) => String.fromCharCode(x)).join("");
  }, plain.photo_url);
  check("EXIF を外し、本体はそのまま送る", sha(Buffer.from(plainHash, "latin1")) === sha(small));

  // 5MB を超えるとき
  const big = await makeJpeg(n, { w: 2800, h: 2100, noise: true, q: 0.97 });
  await sendNative("keep", big);
  const r4 = await until(async () => {
    const list = await itemsOf();
    return list.length === before + 4 ? list : null;
  }, 40000, 500);
  const bigItem = r4.value?.sort((x, y) => y.seq - x.seq)[0];
  const bigInfo = bigItem
    ? await n.evaluate(async (u) => {
        const blob = await (await fetch(u)).blob();
        const bm = await createImageBitmap(blob);
        return { size: blob.size, w: bm.width, h: bm.height };
      }, bigItem.photo_url)
    : null;
  check(
    "5MiB を超える写真は画質を下げて収める",
    bigInfo && bigInfo.size <= 5 * 1024 * 1024 && big.length > 5 * 1024 * 1024,
    `元 ${(big.length / 1048576).toFixed(2)}MiB → ${(bigInfo?.size / 1048576).toFixed(2)}MiB、${bigInfo?.w}x${bigInfo?.h}`,
  );

  // 画面の中のカメラと標準のカメラの切り替え
  const sctx = await newCtx({ storageState: await actx.storageState() });
  const sw = await sctx.newPage();
  await sw.goto(`${BASE}/#/p/${pid}/capture`);
  await sw.waitForFunction(() => document.querySelector("video")?.videoWidth > 0);
  await sw.click("#camera-switch");
  await sw.waitForSelector("#native-hint");
  const [swChooser] = await Promise.all([sw.waitForEvent("filechooser"), sw.click("#pile-keep")]);
  check("標準のカメラに手で切り替えられる", !!swChooser);
  await sw.reload();
  await sw.waitForSelector("#native-hint");
  check("切り替えは次回も残る", true);
  await sctx.close();

  // サーバが受け付けない写真は外せる
  await n.route(ITEMS_RE, (route) =>
    route.fulfill({ status: 415, contentType: "application/json", body: '{"error":"not_jpeg"}' }),
  );
  await sendNative("keep", small);
  await n.waitForSelector("button.discard", { timeout: 12000 });
  const shotsBefore = await n.locator(".shot").count();
  await n.click("button.discard");
  await until(async () => (await n.locator(".shot").count()) === shotsBefore - 1, 3000);
  check("受け付けられない写真を外せる", (await n.locator("button.discard").count()) === 0);
  await n.unroute(ITEMS_RE);

  // 通信を切る（T1c）
  await nctx.setOffline(true);
  const offBefore = (await apiJson(a, `/api/p/${pid}/items`)).body.items.length;
  const [chooser] = await Promise.all([n.waitForEvent("filechooser"), n.click("#pile-unsure")]);
  await chooser.setFiles({ name: "off.jpg", mimeType: "image/jpeg", buffer: small });
  const offState = await until(async () => {
    const t = await n.locator(".shot .shot-status").allInnerTexts();
    return t.some((s) => s.includes("通信待ち"));
  }, 12000);
  check("通信が切れると写真を残して待つ", !!offState.value);
  await shot(n, "15_offline");
  check("オフラインの間は登録されない", (await apiJson(a, `/api/p/${pid}/items`)).body.items.length === offBefore);
  await nctx.setOffline(false);
  const back = await until(async () => (await apiJson(a, `/api/p/${pid}/items`)).body.items.length === offBefore + 1, 15000);
  check("つながると自動で送り直す", !!back.value, `${back.ms}ms`);

  // 応答だけが失われたとき。同じ物を 2 つ作らない
  let dropped = false;
  await n.route(/\/items\?/, async (route) => {
    if (dropped) return route.continue();
    dropped = true;
    await route.fetch();
    await route.abort();
  });
  const dupBefore = (await apiJson(a, `/api/p/${pid}/items`)).body.items.length;
  await sendNative("drop", small);
  await until(async () => (await n.locator(".shot .shot-status").first().innerText()).includes("読み取"), 20000);
  await sleep(500);
  check("応答が失われて送り直しても 1 件だけ", (await apiJson(a, `/api/p/${pid}/items`)).body.items.length === dupBefore + 1);
  await n.unroute(/\/items\?/);

  // 端末を閉じても残る
  await nctx.setOffline(true);
  const [ch2] = await Promise.all([n.waitForEvent("filechooser"), n.click("#pile-keep")]);
  await ch2.setFiles({ name: "off2.jpg", mimeType: "image/jpeg", buffer: small });
  await sleep(5600);
  await n.route(/\/items\?/, (route) => route.abort());
  await nctx.setOffline(false);
  await n.reload();
  await n.waitForSelector(".shot");
  check("ページを開き直しても写真が残る", (await n.locator(".shot").count()) === 1);
  await n.unroute(/\/items\?/);
  await nctx.close();

  // 読み取りの失敗（T1c）
  await fetch(`http://127.0.0.1:${STUB}/__fail?n=3`);
  await a.goto(`${BASE}/#/p/${pid}/capture`);
  await a.waitForFunction(() => document.querySelector("video")?.videoWidth > 0);
  await a.click("#pile-unsure");
  const failed = await until(async () => (await apiJson(a, `/api/p/${pid}/items`)).body.items.find((i) => i.status === "failed"), 25000);
  check("読み取りに失敗すると failed になる", !!failed.value, failed.value?.error_code);
  await a.goto(`${BASE}/#/p/${pid}/list`);
  await a.waitForSelector('.card[data-status="failed"]');
  await shot(a, "16_failed");
  check("失敗した物は写真が残り、先頭に出る", (await a.locator(".card").first().getAttribute("data-status")) === "failed");
  await a.locator('.card[data-status="failed"]').first().click();
  await a.waitForSelector("#retry");
  await a.click("#retry");
  const retried = await until(async () => {
    const item = (await apiJson(a, `/api/p/${pid}/items`)).body.items.find((i) => i.id === failed.value.id);
    return item.status === "done";
  }, 20000);
  check("もう一度読むと通る", !!retried.value);

  // ===== 4. 待った（T4b）。別のセッションに数秒で届く =====
  await b.goto(`${BASE}/#/p/${pid}/list`);
  await b.waitForSelector(".card");
  const target = (await apiJson(a, `/api/p/${pid}/items`)).body.items.at(-1);
  await a.goto(`${BASE}/#/p/${pid}/item/${target.id}`);
  await a.waitForSelector("#wait-btn");
  const tw = Date.now();
  await a.click("#wait-btn");
  const seen = await until(
    async () => (await b.locator(`.card[data-item="${target.id}"] .wait-mark`).count()) === 1,
    10000,
    50,
  );
  const seconds = (Date.now() - tw) / 1000;
  check("別のセッションに待ったが数秒で届く", !!seen.value && seconds < 6, `${seconds.toFixed(1)} 秒`);
  await shot(b, "17_wait_seen");
  await b.locator(`.card[data-item="${target.id}"]`).click();
  await b.waitForSelector("#waits");
  const names = await b.innerText("#waits");
  check("待ったに名前が自動で付く", names.includes("架空のあき"), names.split("\n")[0]);
  await b.click("#wait-btn");
  const aSees = await until(async () => (await a.innerText("#wait-status")).includes("待った 2 人"), 10000, 100);
  check("相手の詳細の画面にも届く", !!aSees.value, `${aSees.ms}ms`);
  await b.click("#wait-note");
  await b.fill("#ask-input", "架空のひとこと");
  await b.click("#ask button[type=submit]");
  await b.waitForFunction(() => document.querySelector("#waits")?.innerText.includes("架空のひとこと"));
  check("ひとことを足せる", true);
  await b.click("#wait-btn");
  await until(async () => (await b.innerText("#wait-btn")) === "待った", 3000);
  await shot(a, "18_wait_detail");
  const again = (await apiJson(b, `/api/p/${pid}/items/${target.id}`)).body;
  check("待ったを取り消せる", again.waits.length === 1 && !again.item.waited_by_me);

  // 画面が見えない間は更新しない
  const vctx = await newCtx({ storageState: await bctx.storageState() });
  await vctx.addInitScript(() => {
    window.__vis = "visible";
    Object.defineProperty(document, "visibilityState", { get: () => window.__vis });
  });
  const v = await vctx.newPage();
  let reqs = 0;
  v.on("request", (r) => {
    if (/\/items$/.test(new URL(r.url()).pathname)) reqs++;
  });
  await v.goto(`${BASE}/#/p/${pid}/list`);
  await v.waitForSelector(".card");
  await sleep(3500);
  const whileVisible = reqs;
  await v.evaluate(() => {
    window.__vis = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await sleep(300);
  const atHide = reqs;
  await sleep(7000);
  check("見えない間は問い合わせない", reqs === atHide && whileVisible >= 2, `見える間 ${whileVisible} 回、隠れた 7 秒で ${reqs - atHide} 回`);
  await v.evaluate(() => {
    window.__vis = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const resumed = await until(() => reqs > atHide, 2000, 50);
  check("見えると更新に戻る", !!resumed.value);
  await vctx.close();

  // ===== 5. 権限 =====
  const photoUrl = target.photo_url;
  const anon = await fetch(`${BASE}/api/p/${pid}/items`);
  check("Cookie なしの一覧は 401", anon.status === 401, String(anon.status));
  const anonPhoto = await fetch(`${BASE}${photoUrl}`);
  check("Cookie なしの写真は 401", anonPhoto.status === 401, String(anonPhoto.status));

  const cctx = await newCtx(); // 招待のないセッション。見本のゲストになる
  const c = await cctx.newPage();
  await c.goto(`${BASE}/`);
  await c.click("#try-sample");
  await c.waitForSelector(".card");
  const cPid = c.url().match(/\/p\/([^/]+)\//)[1];
  check("見本は人ごとに別の project", cPid !== samplePid && cPid !== pid);
  const denied = {};
  for (const [k, u] of Object.entries({
    items: `/api/p/${pid}/items`,
    item: `/api/p/${pid}/items/${target.id}`,
    photo: photoUrl,
    thumb: target.thumb_url,
    search: `/api/p/${pid}/search?q=a`,
    persons: `/api/p/${pid}/persons`,
    terms: `/api/p/${pid}/record-terms`,
    invites: `/api/p/${pid}/invites`,
  })) {
    denied[k] = (await apiJson(c, u)).status;
  }
  check("招待のないセッションは全部 403", Object.values(denied).every((s) => s === 403), JSON.stringify(denied));
  const waitDenied = await apiJson(c, `/api/p/${pid}/items/${target.id}/wait`, { method: "POST" });
  check("招待のないセッションの待ったは 403", waitDenied.status === 403);
  const cross = {
    item: (await apiJson(c, `/api/p/${cPid}/items/${target.id}`)).status,
    photo: (await apiJson(c, `/api/p/${cPid}/items/${target.id}/photo`)).status,
    wait: (await apiJson(c, `/api/p/${cPid}/items/${target.id}/wait`, { method: "POST" })).status,
    retry: (await apiJson(c, `/api/p/${cPid}/items/${target.id}/retry`, { method: "POST" })).status,
    thumb: (await apiJson(c, `/api/p/${cPid}/items/${target.id}/thumb`, { method: "PUT", body: "x" })).status,
  };
  check("自分の project 経由で他人の物は触れない", Object.values(cross).every((s) => s === 404), JSON.stringify(cross));
  const memberInvite = await apiJson(b, `/api/p/${pid}/invites`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ display_name: "x" }),
  });
  check("招待を出せるのは作成者だけ", memberInvite.status === 403);
  await c.goto(`${BASE}/#/p/${pid}/list`);
  await c.waitForSelector("#denied");
  await shot(c, "19_denied");
  check("招待なしで開くと画面でも断る", true);

  // 失効
  await a.goto(`${BASE}/#/p/${pid}/people`);
  await a.waitForSelector(".invite-row button");
  await a.click(".invite-row button");
  await a.waitForSelector(".invite-row:has-text('止めました')");
  check("失効すると入った人も外れる", [401, 403].includes((await apiJson(b, `/api/p/${pid}/items`)).status));
  const dctx = await newCtx();
  const d = await dctx.newPage();
  await d.goto(inviteUrl);
  await d.waitForSelector("#denied");
  check("失効したリンクでは入れない", !d.url().includes(token));
  await dctx.close();

  // ===== 6. 見やすさ =====
  const measureUi = (p) =>
    p.evaluate(() => {
      let minFont = 99;
      let smallest = "";
      for (const el of document.querySelectorAll("body *")) {
        if (!el.childNodes.length || !el.offsetParent) continue;
        const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
        if (!hasText) continue;
        const f = parseFloat(getComputedStyle(el).fontSize);
        if (f < minFont) {
          minFont = f;
          smallest = el.tagName;
        }
      }
      const small = [...document.querySelectorAll("button,a.btn,.tabbar a,input:not([type=checkbox]),select")]
        .filter((e) => e.offsetParent)
        .map((e) => e.getBoundingClientRect().height)
        .filter((hh) => hh > 0 && hh < 44).length;
      const wide = document.documentElement.scrollWidth > window.innerWidth;
      return { minFont, smallest, small, wide };
    });
  const screens = [
    ["一覧", `#/p/${cPid}/list`],
    ["人", `#/p/${cPid}/people`],
  ];
  for (const [name, hash] of screens) {
    await c.goto(`${BASE}/${hash}`);
    await c.waitForTimeout(800);
    const m = await measureUi(c);
    check(`${name}：文字 16px 以上、押す所 44px 以上、横にはみ出ない`, m.minFont >= 16 && m.small === 0 && !m.wide, JSON.stringify(m));
  }
  await c.locator("#tab-list").click();
  await c.waitForSelector(".card");
  await c.locator(".card").first().click();
  await c.waitForSelector("#relmap");
  const md = await measureUi(c);
  check("詳細：文字 16px 以上、押す所 44px 以上、横にはみ出ない", md.minFont >= 16 && md.small === 0 && !md.wide, JSON.stringify(md));

  const dark = await newCtx({ colorScheme: "dark", storageState: await cctx.storageState() });
  const dk = await dark.newPage();
  await dk.goto(`${BASE}/#/p/${cPid}/list`);
  await dk.waitForSelector(".card");
  await shot(dk, "20_dark_list");
  await dk.locator(".card").first().click();
  await dk.waitForSelector("#relmap");
  await dk.screenshot({ path: path.join(out, "21_dark_detail.png"), fullPage: true });
  const bg = await dk.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check("暗い画面に切り替わる", bg === "rgb(20, 32, 44)", bg);
  await dark.close();

  check("読み取りの置き換えに届いた回数", (await stubHits()) > 0, String(await stubHits()));
} catch (e) {
  check("試験が最後まで走る", false, e.message?.split("\n")[0]);
  console.error(e);
  let i = 0;
  for (const ctx of browser.contexts()) {
    for (const pg of ctx.pages()) {
      await pg.screenshot({ path: path.join(out, `fail_${i}.png`) }).catch(() => {});
      console.log(`fail_${i}`, pg.url().replace(/join\/.*/, "join/…"), (await pg.innerText("body").catch(() => "")).slice(0, 80));
      i++;
    }
  }
} finally {
  await browser.close();
  stopAll();
}

writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failures.length} / ${results.length} 通過`);
if (failures.length) console.log(`失敗：\n- ${failures.join("\n- ")}`);
process.exit(failures.length ? 1 : 0);
