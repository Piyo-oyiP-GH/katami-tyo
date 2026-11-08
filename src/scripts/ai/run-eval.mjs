// eval.ts を束ねて動かす。束ねたファイルと結果は --out の側（リポジトリの外）に置く。
// 鍵は node の --env-file で渡し、ここでは中身を見ない。
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { isInside } from "../lib/paths.mjs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const repo = path.resolve(root, "..");
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
if (outIndex < 0) {
  console.error("--out が要ります");
  process.exit(2);
}
const out = path.resolve(args[outIndex + 1]);
if (isInside(repo, out)) {
  console.error("--out はリポジトリの外にしてください");
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const bundle = path.join(out, "eval.bundle.mjs");
const esbuild = path.join(root, "node_modules", "esbuild", "bin", "esbuild");
execFileSync(
  process.execPath,
  [esbuild, path.join(here, "eval.ts"), "--bundle", "--platform=node", "--format=esm", "--log-level=warning", `--outfile=${bundle}`],
  { cwd: root, stdio: "inherit" },
);
const r = spawnSync(
  process.execPath,
  [`--env-file=${path.join(root, ".dev.vars")}`, bundle, ...args, "--repo", repo],
  { stdio: "inherit" },
);
process.exit(r.status ?? 1);
