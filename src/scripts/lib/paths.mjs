// 出力先がリポジトリの中かを確かめる。読めた文字を公開リポジトリへ書かないための確認。
// Windows のパスは大文字小文字を区別しないので、文字列の startsWith では「c:/」の形が素通りする。
import { realpathSync } from "node:fs";
import path from "node:path";

// まだ無いパスは realpath が失敗する。在る所まで遡って実体にし、残りを足す
function realish(p) {
  let head = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      const real = path.join(realpathSync.native(head), ...rest);
      return process.platform === "win32" ? real.toLowerCase() : real;
    } catch {
      const up = path.dirname(head);
      if (up === head) {
        const full = path.join(head, ...rest);
        return process.platform === "win32" ? full.toLowerCase() : full;
      }
      rest.unshift(path.basename(head));
      head = up;
    }
  }
}

export function isInside(repo, target) {
  const rel = path.relative(realish(repo), realish(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
