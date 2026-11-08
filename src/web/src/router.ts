// 画面の切り替え。パスはすべて # の後ろに置く（招待のトークンをサーバのログに残さないため）。
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";

// アプリの中で何回移ったかを、履歴の各項目に番号（yi）として持たせる。
// 0 の項目は、直接開いた（またはアプリの外から来た）画面。戻るはそこから先へは history.back() しない
type NavState = { yi?: number } | null;
const stateIndex = () => ((history.state as NavState)?.yi ?? 0);
let currentIndex = stateIndex();
let replacing = false;
try {
  if ((history.state as NavState)?.yi === undefined) history.replaceState({ ...(history.state ?? {}), yi: currentIndex }, "");
} catch {
  // 履歴に書けない環境では、いつも直接開いた扱い
}
window.addEventListener("hashchange", () => {
  const st = history.state as NavState;
  if (st?.yi !== undefined) currentIndex = st.yi;
  else {
    // 新しく積まれた項目。置き換えなら番号はそのまま
    currentIndex = replacing ? currentIndex : currentIndex + 1;
    try {
      history.replaceState({ ...(st ?? {}), yi: currentIndex }, "");
    } catch {
      // 同上
    }
  }
  replacing = false;
});

// アプリの中に前の画面があるか
export const canGoBack = () => stateIndex() > 0;

export function useHash(): string {
  const [hash, setHash] = useState(() => location.hash.replace(/^#/, "") || "/");
  useEffect(() => {
    const on = () => {
      const next = location.hash.replace(/^#/, "") || "/";
      // 押した写真が次の画面の写真へ移る。動きを減らす設定では切り替えるだけ
      const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
      if (doc.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
        doc.startViewTransition(() => flushSync(() => setHash(next)));
      } else setHash(next);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

export const go = (path: string, replace = false) => {
  if (location.hash === `#${path}`) return;
  if (replace) {
    replacing = true;
    location.replace(`#${path}`);
  } else location.hash = `#${path}`;
};

// 戻る：アプリの中に前の画面があれば履歴を戻る。無ければ href へ置き換えて移る（履歴を積まない）
export function goBack(href: string) {
  if (canGoBack()) history.back();
  else go(href.replace(/^#/, ""), true);
}

export function splitQuery(hash: string): [string, URLSearchParams] {
  const i = hash.indexOf("?");
  return i < 0 ? [hash, new URLSearchParams()] : [hash.slice(0, i), new URLSearchParams(hash.slice(i + 1))];
}
