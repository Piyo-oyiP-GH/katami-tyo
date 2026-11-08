// 端から端までの確かめ。wrangler dev を動かした状態で実行する。
//   node scripts/e2e-photo.mjs --photo <写真の場所> --out <結果を置くフォルダ> [--base http://127.0.0.1:8791]
// 読めた文字は --out のファイルにだけ書き、画面には出さない。--out はリポジトリの外に限る。
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isInside } from "./lib/paths.mjs";
import { parseArgs } from "node:util";

const { values: arg } = parseArgs({
  options: {
    photo: { type: "string" },
    out: { type: "string" },
    base: { type: "string", default: "http://127.0.0.1:8791" },
    name: { type: "string", default: "e2e-result" },
  },
});
if (!arg.photo || !arg.out) {
  console.error("--photo と --out が要ります");
  process.exit(2);
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = path.resolve(arg.out);
if (isInside(repo, out)) {
  console.error("--out はリポジトリの外にしてください");
  process.exit(2);
}

const photo = readFileSync(arg.photo);
const localSha = createHash("sha256").update(photo).digest("hex");

const guest = await fetch(`${arg.base}/api/guest`, { method: "POST" });
if (guest.status !== 201) throw new Error(`guest ${guest.status}`);
const cookie = guest.headers.get("set-cookie").split(";")[0];
const { project_id: pid } = await guest.json();
const headers = { cookie };

const t0 = performance.now();
const up = await fetch(`${arg.base}/api/p/${pid}/items?pile=unsure`, {
  method: "POST",
  headers: { ...headers, "content-type": "image/jpeg" },
  body: photo,
});
const t1 = performance.now();
if (up.status !== 202) {
  console.log(JSON.stringify({ upload_status: up.status, body: await up.json() }));
  process.exit(1);
}
const { item } = await up.json();

let detail;
for (;;) {
  const r = await fetch(`${arg.base}/api/p/${pid}/items/${item.id}`, { headers });
  detail = await r.json();
  if (detail.item.status === "done" || detail.item.status === "failed") break;
  if (performance.now() - t0 > 300_000) throw new Error("timeout");
  await new Promise((res) => setTimeout(res, 500));
}
const t2 = performance.now();

const served = await fetch(`${arg.base}/api/p/${pid}/items/${item.id}/photo`, { headers });
const servedSha = createHash("sha256").update(Buffer.from(await served.arrayBuffer())).digest("hex");
const denied = await fetch(`${arg.base}/api/p/${pid}/items/${item.id}/photo`);

mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, `${arg.name}.json`), JSON.stringify(detail, null, 2));

const m = detail.meta ?? {};
console.log(
  JSON.stringify(
    {
      status: detail.item.status,
      error_code: detail.item.error_code,
      file_bytes: photo.length,
      upload_seconds: +((t1 - t0) / 1000).toFixed(2),
      total_seconds: +((t2 - t0) / 1000).toFixed(2),
      sent_bytes: m.photo_bytes,
      base64_chars: m.base64_chars,
      sha_equal_sent: m.photo_sha256 === localSha,
      sha_equal_served: servedSha === localSha,
      no_cookie_photo_status: denied.status,
      encode_ms: m.encode_ms,
      calls: m.calls,
      lines_count: detail.reading?.a?.lines?.length ?? null,
      error_status: m.error_status,
      error_message: m.error_message,
    },
    null,
    1,
  ),
);
