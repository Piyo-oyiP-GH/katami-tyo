// ぼけの目安を決めるための測定。写真のフォルダを引数で渡す。写真はコピーしない。
//   node scripts/app/calibrate-blur.mjs --dir <写真のフォルダ> --out <リポジトリの外の JSON>
// 出力は数字だけ。ファイル名も、読めた文字も書かない。
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isInside } from "../lib/paths.mjs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const arg = (k) => process.argv[process.argv.indexOf(k) + 1];
const dir = arg("--dir");
const outFile = arg("--out");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repo = path.resolve(root, "..");
if (isInside(repo, outFile)) throw new Error("出力はリポジトリの外にしてください");

const code = readFileSync(path.join(root, "public", "js", "image.js"), "utf8").replace(/^export /gm, "");
const browser = await chromium.launch();
const page = await browser.newPage();
await page.addScriptTag({ content: `${code}\nwindow.__measure = measure; window.__ceiling = ceilingOf;` });

const files = readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f)).sort();
const rows = [];
for (const [i, f] of files.entries()) {
  const b64 = readFileSync(path.join(dir, f)).toString("base64");
  const row = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bm = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
    const out = {};
    const r = (v) => Math.round(v * 10) / 10;
    const add = (name, c) => {
      const s = window.__measure(c);
      out[name] = { sharp: r(s.sharp), center: r(s.center), glare: r(s.glare), clipped: Math.round(s.clipped * 1000) / 1000, ceiling: window.__ceiling(s) };
    };
    for (const blur of [0, 3, 6, 12]) {
      const c = new OffscreenCanvas(bm.width, bm.height);
      const g = c.getContext("2d");
      g.filter = blur ? `blur(${blur}px)` : "none";
      g.drawImage(bm, 0, 0);
      add(`blur${blur}`, c);
    }
    // 背景はくっきりのまま、真ん中の物だけぼけた写真。size は 1 辺の割合
    for (const [size, blur] of [[0.5, 28], [0.3, 28], [0.5, 12], [0.3, 12]]) {
      const c = new OffscreenCanvas(bm.width, bm.height);
      const g = c.getContext("2d");
      g.drawImage(bm, 0, 0);
      const w = bm.width * size;
      const h = bm.height * size;
      g.save();
      g.beginPath();
      g.rect((bm.width - w) / 2, (bm.height - h) / 2, w, h);
      g.clip();
      g.filter = `blur(${blur}px)`;
      g.drawImage(bm, 0, 0);
      g.restore();
      add(`mid${size * 100}_${blur}`, c);
    }
    return out;
  }, b64);
  rows.push({ n: i + 1, ...row });
  console.log(i + 1, Object.values(row).map((r) => `${r.center}/${r.ceiling}`).join("  "));
}
await browser.close();
writeFileSync(outFile, JSON.stringify(rows, null, 1));
