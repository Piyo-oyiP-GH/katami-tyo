// wrangler を動かす入口。ローカルの D1 と R2 を、必ずリポジトリの外に置く。
// 写真と読み取り結果が .wrangler/state（リポジトリの中）に残らないようにするため。
//   node scripts/dev.mjs migrate
//   node scripts/dev.mjs dev
// 置き場所は環境変数 MATTA_STATE_DIR で変えられる。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isInside } from "./lib/paths.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(root, "..");
const stateDir = path.resolve(
  process.env.MATTA_STATE_DIR ?? path.join(repo, "..", ".matta-state", "wrangler-state"),
);
if (isInside(repo, stateDir)) {
  console.error("MATTA_STATE_DIR はリポジトリの外にしてください");
  process.exit(1);
}
mkdirSync(stateDir, { recursive: true });

const [cmd, ...rest] = process.argv.slice(2);
const args = {
  migrate: ["d1", "migrations", "apply", "DB", "--local", "--persist-to", stateDir],
  dev: ["dev", "--persist-to", stateDir, "--show-interactive-dev-session=false", ...rest],
}[cmd];
if (!args) {
  console.error("使い方: node scripts/dev.mjs migrate | dev");
  process.exit(1);
}
// 鍵が空のまま起動すると、画面には通信の失敗にしか見えない。値は表示しない
if (cmd === "dev" && !rest.includes("--env-file")) {
  const file = path.join(root, ".dev.vars");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const empty = ["ANTHROPIC_API_KEY", "SESSION_SECRET"].filter(
    (k) => !new RegExp(`^${k}=[^\\S\\n]*[^\\s]`, "m").test(text),
  );
  if (empty.length) {
    console.error(`.dev.vars に値がありません：${empty.join("、")}`);
    console.error("README の「動かす」のとおりに入れてから、もう一度起動してください。");
    process.exit(1);
  }
}
const bin = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const child = spawn(process.execPath, [bin, ...args], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 1));
