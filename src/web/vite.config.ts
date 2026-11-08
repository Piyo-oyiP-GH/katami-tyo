// React 版の画面。ビルド結果は ../public/app に出し、Workers の静的配信で /app/ から出す。
// 今の画面（../public の index.html と js/）には触らない。
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "..", "public", "app");
// 空にするのは public/app だけ。public 全体を消さないよう、念のため確かめる
if (path.basename(outDir) !== "app" || path.basename(path.dirname(outDir)) !== "public") {
  throw new Error(`outDir がおかしい: ${outDir}`);
}

export default defineConfig({
  base: "/app/",
  plugins: [react()],
  build: { outDir, emptyOutDir: true },
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    // API は npm run dev（wrangler、8791 番）へ流す。試験では API_TARGET で変える
    proxy: { "/api": process.env.API_TARGET ?? "http://127.0.0.1:8791" },
    fs: { allow: [path.resolve(here, "..")] },
  },
});
