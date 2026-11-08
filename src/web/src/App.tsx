// 画面の切り替え。参加者かどうかを確かめてから、各画面を出す。
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { ApiError, api, type BoxNoticeX, type ItemCardX, type ItemListX, type MeX } from "./api";
import { splitQuery, useHash } from "./router";
import { Capture } from "./screens/Capture";
import { Check } from "./screens/Check";
import { Detail } from "./screens/Detail";
import { Entry, Join } from "./screens/Entry";
import { Home } from "./screens/Home";
import { People } from "./screens/People";
import { Places } from "./screens/Places";
import { Search } from "./screens/Search";
import { Loading, usePoll } from "./ui";
// 撮った写真の送り直し（前に送れなかった分）
import { restore } from "./lib/uploader.js";

restore();

const SAMPLE_KEY = "yukari.samples";
function seenSamples(): string[] {
  try {
    return JSON.parse(localStorage.getItem(SAMPLE_KEY) ?? "[]");
  } catch {
    return [];
  }
}
function rememberSample(pid: string) {
  try {
    const seen = seenSamples();
    if (!seen.includes(pid)) localStorage.setItem(SAMPLE_KEY, JSON.stringify([...seen, pid].slice(-10)));
  } catch {
    // 覚えられない端末では、ふつうの案内を出す
  }
}

export function Denied({ text }: { text: string }) {
  useEffect(() => {
    document.title = "開けません｜YukariNote";
  }, []);
  return (
    <main className="page entry">
      <h1 className="h-big">この片付けは開けません</h1>
      <p id="denied">{text}</p>
      <a className="btn btn-primary wide" href="#/">
        入口へ戻る
      </a>
    </main>
  );
}

// 参加者でない（401・not_member）ときだけ締め出す。それ以外の失敗かどうか
export const isDenied = (e: unknown) => e instanceof ApiError && (e.status === 401 || e.code === "not_member");

// 通信の失敗。拒否とは分け、取り直せるようにする
export function Unreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="page entry">
      <h1 className="h-big">つながりませんでした</h1>
      <p>通信が戻ったら、もう一度読み込んでください。</p>
      <button className="btn btn-primary wide" onClick={onRetry}>
        もう一度読み込む
      </button>
    </main>
  );
}

export type ProjectCtx = {
  pid: string;
  me: MeX;
  project: MeX["projects"][number];
  items: ItemCardX[] | null;
  notices: BoxNoticeX[];
  reload: () => Promise<void>;
};

const SCREENS = ["capture", "item", "search", "people", "places", "check"] as const;

export function App() {
  const hash = useHash();
  const [path, query] = splitQuery(hash);
  const join = path.match(/^\/join\/(.+)$/);
  const m = path.match(/^\/p\/([^/]+)(?:\/([a-z]+))?(?:\/([^/]+))?$/);
  if (join) return <Join token={join[1]} />;
  if (!m || (m[2] && !(SCREENS as readonly string[]).includes(m[2]))) return <Entry />;
  return <ProjectGate pid={m[1]} screen={m[2] ?? "home"} iid={m[3] ?? null} query={query} />;
}

function ProjectGate({ pid, screen, iid, query }: { pid: string; screen: string; iid: string | null; query: URLSearchParams }) {
  const [me, setMe] = useState<MeX | null>(null);
  const [failed, setFailed] = useState<"denied" | "net" | null>(null);
  const [items, setItems] = useState<ItemCardX[] | null>(null);
  const [notices, setNotices] = useState<BoxNoticeX[]>([]);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    setFailed(null);
    setMe(null);
    setItems(null);
    setNotices([]);
    api<MeX>("/api/me").then(setMe, (e) => setFailed(isDenied(e) ? "denied" : "net"));
    // 操作の途中で参加者でなくなったら、拒否の画面へ移す
    const onDenied = () => setNonce((n) => n + 1);
    window.addEventListener("yukari:denied", onDenied);
    return () => window.removeEventListener("yukari:denied", onDenied);
  }, [pid, nonce]);

  const project = me?.projects.find((p) => p.id === pid) ?? null;
  const reload = useCallback(async () => {
    const res = await api<ItemListX>(`/api/p/${pid}/items`);
    setItems(res.items);
    // 中身が同じなら差し替えない（開いて読んでいる人の邪魔をしない）
    const next = res.notices ?? [];
    setNotices((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, [pid]);
  // 一覧はどの画面でも使う（タブの数字）。読み取り中の物があるあいだは早めに取り直す
  const busy = items?.some((i) => i.status === "queued" || i.status === "reading") ?? false;
  usePoll(async () => (project ? reload() : undefined), busy ? 3000 : 8000, [project?.id, busy, reload]);

  useEffect(() => {
    if (project?.is_sample) rememberSample(pid);
  }, [project, pid]);
  // 既定の題名。画面ごとの題名（useScreenTitle）は、このあとに子の effect で上書きされる
  useLayoutEffect(() => {
    if (project) document.title = `${project.title}｜YukariNote`;
  }, [project, pid, screen, iid]);

  if (failed === "denied") return <Denied text="参加者だけが開けます。招待のリンクを開いてください。" />;
  if (failed === "net") return <Unreachable onRetry={() => setNonce((n) => n + 1)} />;
  if (!me) return <Loading text="開いています" />;
  if (!project) {
    if (seenSamples().includes(pid)) {
      return <Denied text="この見本は 24 時間を過ぎたので消えました。入口の「見本で試す」から、もう一度試せます。" />;
    }
    return (
      <Denied
        text={
          me.user
            ? "この片付けの参加者ではありません。招待のリンクを開いてください。"
            : "参加者だけが開けます。招待のリンクを開いてください。"
        }
      />
    );
  }
  const ctx: ProjectCtx = { pid, me, project, items, notices, reload };
  switch (screen) {
    case "capture":
      return <Capture ctx={ctx} />;
    case "item":
      return iid ? <Detail key={iid} ctx={ctx} iid={iid} from={query.get("from")} back={query.get("back")} /> : <Home ctx={ctx} />;
    case "search":
      return <Search ctx={ctx} />;
    case "people":
      return <People ctx={ctx} />;
    case "places":
      return <Places ctx={ctx} back={query.get("back")} />;
    case "check":
      return <Check ctx={ctx} />;
    default:
      return <Home ctx={ctx} />;
  }
}
