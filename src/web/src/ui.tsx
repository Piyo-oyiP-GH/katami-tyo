// 画面の共通部品。文字は必ず React の文字として入れる（読み取った文字を HTML として扱わない）。
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, PILE_NAMES, errorText, itemTitle, type ItemCardX } from "./api";
import { goBack } from "./router";

// ---- 知らせ（小さな帯。大きな知らせは出さない） ----
const ToastCtx = createContext<(text: string, ms?: number) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [text, setText] = useState<string | null>(null);
  const timer = useRef<number>(0);
  const show = useCallback((t: string, ms = 3000) => {
    setText(t);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setText(null), ms);
  }, []);
  // 画面が変わったら、前の画面の知らせは消す
  useEffect(() => {
    const clear = () => {
      clearTimeout(timer.current);
      setText(null);
    };
    window.addEventListener("hashchange", clear);
    return () => window.removeEventListener("hashchange", clear);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div className="toast" role="status" aria-live="polite">
        {text ? <span>{text}</span> : null}
      </div>
    </ToastCtx.Provider>
  );
}

// 操作の API 呼び出しを包む。失敗したら必ず画面で伝える。成功なら値、失敗なら undefined
export function useAct() {
  const toast = useToast();
  return useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.code === "not_member")) {
          window.dispatchEvent(new CustomEvent("yukari:denied"));
        } else {
          toast((e instanceof ApiError && errorText(e.code)) || "届きませんでした。もう一度押してください。", 4000);
        }
        return undefined;
      }
    },
    [toast],
  );
}

// useAct と同じ。送っている間は pending が true になり、その間の二度押しは届けない
export function useActPending() {
  const act = useAct();
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      if (busy.current) return undefined;
      busy.current = true;
      setPending(true);
      try {
        return await act(fn);
      } finally {
        busy.current = false;
        setPending(false);
      }
    },
    [act],
  );
  return [run, pending] as const;
}

// 読み込み中。速く開くときにちらつかないよう、少し遅れてから文を出す
export function Loading({ text = "開いています" }: { text?: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setShow(true), 400);
    return () => clearTimeout(t);
  }, []);
  return (
    <main className="page" aria-busy="true">
      <p className="note pad loading" role="status">
        {show ? text : null}
      </p>
    </main>
  );
}

// 画面の題名を「画面名｜片付け名」にし、見出しへフォーカスを移す（読み上げで画面が変わったと分かる）
// 返す ref を h1 に付け、h1 には tabIndex={-1} を付ける
export function useScreenTitle(screen: string, project?: string) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = project ? `${screen}｜${project}` : screen;
  }, [screen, project]);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return ref;
}

// ---- 写真の印 ----
// 待ったの判子。茜は待っただけに使う。形（円）と文字でも分かる
export const Stamp = ({ count }: { count?: number }) => (
  <span className="stamp" aria-label={count && count > 1 ? `待った ${count}人` : "待った"}>
    待った
  </span>
);

// 行き先の帯。残したい＝塗り、迷う＝塗り（明るい）、処分したい＝枠だけ。色と形と文字で分ける
export const Lane = ({ pile }: { pile: string }) => (
  <span className={`lane lane-${pile}`}>{PILE_NAMES[pile] ?? pile}</span>
);

export function Thumb({
  item,
  className,
  vt,
}: {
  item: Pick<ItemCardX, "thumb_url"> & { photo_url?: string };
  className?: string;
  vt?: string; // 画面をまたいで同じ写真として動かす名前
}) {
  const [src, setSrc] = useState(item.thumb_url);
  useEffect(() => setSrc(item.thumb_url), [item.thumb_url]);
  return (
    <img
      className={className}
      src={src}
      alt=""
      loading="lazy"
      style={vt ? { viewTransitionName: vt } : undefined}
      // 縮小画像がまだ無いときは写真を出す
      onError={() => {
        if (src.endsWith("/thumb")) setSrc(item.photo_url ?? src.replace(/thumb$/, "photo"));
      }}
    />
  );
}

// 一覧の 1 枚。印は 2 つまで（判子は角、行き先は下端の帯）
export function Tile({ pid, item }: { pid: string; item: ItemCardX }) {
  const reading = item.status === "queued" || item.status === "reading";
  return (
    <a className="tile" href={`#/p/${pid}/item/${item.id}`} aria-label={`${itemTitle(item)}。${PILE_NAMES[item.pile]}${item.wait_count ? "。待ったあり" : ""}${item.notice ? `。気づき：${item.notice}` : ""}`}
      title={item.notice ? `気づき：${item.notice}` : undefined}
    >
      <Thumb item={item} vt={`item-${item.id}`} />
      {reading ? <span className="veil">読み取り中</span> : null}
      {item.status === "failed" ? <span className="veil">読めませんでした</span> : null}
      {item.wait_count > 0 ? <Stamp count={item.wait_count} /> : null}
      {item.notice && !reading ? <span className="tile-notice" aria-hidden="true">気づき</span> : null}
      <Lane pile={item.pile} />
    </a>
  );
}

// ---- 下のタブ。待ったの数だけを数字で出す ----
// 今いる画面は、上の太い線と色と太字で示す。撮るは画面ではなく操作なので、丸い印で分ける
const TabIcon = ({ kind }: { kind: "home" | "shoot" | "people" }) => (
  <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true" className="tab-ic">
    {kind === "home" ? (
      <g fill="none" stroke="currentColor" strokeWidth="2.2">
        <circle cx="6" cy="7" r="3" />
        <circle cx="20" cy="7" r="3" />
        <circle cx="13" cy="20" r="3" />
        <path d="M8.5 9 11 17.5M17.5 9 15 17.5M9 7h8" />
      </g>
    ) : kind === "shoot" ? (
      <g fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round">
        <path d="M3 9h4l2-3h8l2 3h4v12H3z" />
        <circle cx="13" cy="14.5" r="4" />
      </g>
    ) : (
      <g fill="none" stroke="currentColor" strokeWidth="2.2">
        <rect x="3" y="4" width="20" height="18" />
        <circle cx="10" cy="11" r="3" />
        <path d="M5.5 19c.8-2.6 2.4-4 4.5-4s3.7 1.4 4.5 4M16 10h4M16 14h4" />
      </g>
    )}
  </svg>
);

export function TabBar({ pid, current, waited }: { pid: string; current: "home" | "people"; waited: number }) {
  return (
    <nav className="tabbar" aria-label="画面">
      <a href={`#/p/${pid}`} aria-current={current === "home" ? "page" : undefined} id="tab-home">
        <span className="tab-ic-wrap">
          <TabIcon kind="home" />
          {waited > 0 ? (
            <span className="badge" aria-label={`待った ${waited}点`}>
              {waited}
            </span>
          ) : null}
        </span>
        <span>つながり</span>
      </a>
      <a href={`#/p/${pid}/capture`} className="tab-shoot" id="tab-capture">
        <span className="shoot-ring">
          <TabIcon kind="shoot" />
        </span>
        <span>撮る</span>
      </a>
      <a href={`#/p/${pid}/people`} aria-current={current === "people" ? "page" : undefined} id="tab-people">
        <span className="tab-ic-wrap">
          <TabIcon kind="people" />
        </span>
        <span>人カード</span>
      </a>
    </nav>
  );
}

export function BackLink({ href, children = "戻る" }: { href: string; children?: ReactNode }) {
  return (
    <a
      className="back"
      href={href}
      onClick={(e) => {
        // 新しいタブで開く操作はそのまま
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        goBack(href);
      }}
    >
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M12.5 4 6.5 10l6 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {children}
    </a>
  );
}

// 画面が見えている間だけ、決まった間隔で動かす
export function usePoll(fn: () => Promise<unknown>, ms: number, deps: unknown[]) {
  useEffect(() => {
    let stopped = false;
    let timer: number | null = null;
    const tick = async () => {
      timer = null;
      if (stopped || document.visibilityState !== "visible") return;
      try {
        await fn();
      } catch {
        // 通信が切れても次の回で取り直す
      }
      if (!stopped && document.visibilityState === "visible") timer = window.setTimeout(tick, ms);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && timer === null) tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    tick();
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

// 置き場（仕分け先）。API に置き場が無いので、この端末にだけ持つ
export type Place = { id: string; name: string; pile: "keep" | "unsure" | "drop" };
const placeKey = (pid: string) => `yukari.places.${pid}`;
const currentKey = (pid: string) => `yukari.place.${pid}`;
export function loadPlaces(pid: string): Place[] {
  try {
    return JSON.parse(localStorage.getItem(placeKey(pid)) ?? "[]");
  } catch {
    return [];
  }
}
export function savePlaces(pid: string, places: Place[]) {
  try {
    localStorage.setItem(placeKey(pid), JSON.stringify(places));
  } catch {
    // 保存できない端末では、開いている間だけ効く
  }
}
export function loadCurrentPlace(pid: string): string | null {
  try {
    return localStorage.getItem(currentKey(pid));
  } catch {
    return null;
  }
}
export function saveCurrentPlace(pid: string, id: string | null) {
  try {
    if (id) localStorage.setItem(currentKey(pid), id);
    else localStorage.removeItem(currentKey(pid));
  } catch {
    // 同上
  }
}
