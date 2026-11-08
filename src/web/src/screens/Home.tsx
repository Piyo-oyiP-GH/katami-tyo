// つながり：離れた親族の最初の画面。
// 伝えること：「あなたに関係しそうな物と、物どうしのつながりが、開かずに分かる」
// 順位：あなたに関係しそうな物 → 写真の格子 → 物どうしのつながり（最初の画面で写真が見えるように）
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { SUBTYPE_NAMES, api, itemTitle, type ClaimX, type PersonsX } from "../api";
import type { ProjectCtx } from "../App";
import { TabBar, Thumb, Tile, useAct, useScreenTitle } from "../ui";

export const SOURCE_LABEL: Record<string, string> = {
  photo: "読めた文字から",
  claude: "Claude の推測。事実とは限りません",
  family: "家族が書いたこと",
};

// 札ごとの、つながる物の番号（重なりを除く）
export const personItemIds = (claims: ClaimX[]) => [...new Set(claims.flatMap((c) => c.item_ids))];

// doneCount：読み終わった物の数。増えたら札を取り直す（新しい名前が読めているかもしれない）
export function usePersons(pid: string, doneCount = 0) {
  const [persons, setPersons] = useState<PersonsX | null>(null);
  const [failed, setFailed] = useState(false);
  const load = () =>
    api<PersonsX>(`/api/p/${pid}/persons`).then(
      (r) => {
        setFailed(false);
        setPersons(r);
      },
      () => setFailed(true),
    );
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, doneCount]);
  // failed は、一度も取れていないときだけ true として返す（取れた札は残す）
  return { persons, reloadPersons: load, failed: failed && !persons };
}

// 取れなかったことを、空と見分けて伝える
export const LoadFailed = ({ onRetry }: { onRetry: () => void }) => (
  <p className="note">
    読み込めませんでした。
    <button type="button" className="text-btn" onClick={onRetry}>
      もう一度
    </button>
  </p>
);

// 詳細などへ移る前の位置と絞り込み。戻ったときに戻す（pid ごと）
const homeKey = (pid: string) => `yukari.home.${pid}`;
type HomeSaved = { y: number; focus: string | null; yi?: number };
const historyIndex = () => (history.state as { yi?: number } | null)?.yi ?? 0;
function loadHome(pid: string): HomeSaved | null {
  try {
    const s: HomeSaved | null = JSON.parse(sessionStorage.getItem(homeKey(pid)) ?? "null");
    // 戻る（同じ履歴の項目へ戻った）ときだけ戻す。タブなどで新しく開いたときは上から
    return s && s.yi === historyIndex() ? s : null;
  } catch {
    return null;
  }
}

export function Home({ ctx }: { ctx: ProjectCtx }) {
  const { pid, me, project, items, notices } = ctx;
  const act = useAct();
  const doneCount = (items ?? []).filter((i) => i.status === "done").length;
  const { persons, reloadPersons, failed: personsFailed } = usePersons(pid, doneCount);
  const [initial] = useState(() => loadHome(pid));
  const saved = useRef(initial);
  const [focus, setFocus] = useState<string | null>(saved.current?.focus ?? null);
  const myId = me.user?.id ?? null;
  const h1 = useScreenTitle("つながり", project.title);

  // 一覧と札がそろってから、前の位置へ戻す（高さが足りないと途中で止まるため）
  useEffect(() => {
    const s = saved.current;
    if (!s || !items || (!persons && !personsFailed)) return;
    saved.current = null;
    try {
      sessionStorage.removeItem(homeKey(pid));
    } catch {
      // 戻せないだけ
    }
    requestAnimationFrame(() => window.scrollTo(0, s.y));
  }, [items, persons, personsFailed, pid]);

  // 画面の中のリンクで移る前に、位置と絞り込みを覚える
  const remember = (e: MouseEvent) => {
    if (!(e.target as Element).closest?.("a[href]")) return;
    try {
      sessionStorage.setItem(homeKey(pid), JSON.stringify({ y: window.scrollY, focus, yi: historyIndex() } satisfies HomeSaved));
    } catch {
      // 覚えられない端末では、いちばん上に戻る
    }
  };
  // 絞ったら、絞った写真の見出しへ動かす
  const pick = (id: string | null) => {
    setFocus(id);
    if (!id) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    requestAnimationFrame(() =>
      document.getElementById("all-h")?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" }),
    );
  };

  const byId = useMemo(() => new Map((items ?? []).map((i) => [i.id, i])), [items]);
  const mine = persons?.persons.filter((p) => p.linked_user_id && p.linked_user_id === myId) ?? [];
  const mineIds = [...new Set(mine.flatMap((p) => personItemIds(p.claims)))].filter((id) => byId.has(id));
  // 札と結べる人。親族の札だけ。ほかの人に結ばれた札は出さない（人の画面では、どの札とも結べる）
  const linkable = persons?.persons.filter((p) => !p.linked_user_id && p.subtype === "relative") ?? [];

  const groups = (persons?.persons ?? [])
    .map((p) => ({ p, ids: personItemIds(p.claims).filter((id) => byId.has(id)) }))
    .filter((g) => g.ids.length > 0)
    .sort((a, b) => b.ids.length - a.ids.length);
  const focused = groups.find((g) => g.p.id === focus) ?? null;
  const shown = focused ? (items ?? []).filter((i) => focused.ids.includes(i.id)) : (items ?? []);
  const waited = (items ?? []).filter((i) => i.wait_count > 0).length;

  return (
    <div className="screen with-tabs">
      <main className="page home" onClickCapture={remember}>
        <header className="head">
          <div className="head-row">
            <h1 className="h-big" ref={h1} tabIndex={-1}>
              {project.title}
            </h1>
            <a className="icon-btn" href={`#/p/${pid}/search`} id="go-search">
              <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
                <circle cx="9.5" cy="9.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="2.4" />
                <path d="m14.5 14.5 5 5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
              </svg>
              探す
            </a>
          </div>
          <p className="sub">{items ? `全${items.length}点。残してほしい物に待ったを` : "読み込んでいます"}</p>
        </header>

        {mineIds.length ? (
          <section className="sec" aria-labelledby="mine-h">
            <h2 className="h-mid" id="mine-h">
              あなたに関係しそうな物
            </h2>
            <div className="thumbs" id="mine">
              {mineIds.map((id) => {
                const it = byId.get(id)!;
                return (
                  <a key={id} href={`#/p/${pid}/item/${id}`} className="thumb-link">
                    <Thumb item={it} className="thumb" />
                    <span className="thumb-name">{itemTitle(it)}</span>
                  </a>
                );
              })}
            </div>
          </section>
        ) : (
          // 空のときは1行の案内に畳む（写真を最初の画面に出すため）
          (personsFailed || persons) && (
          <div className="sec" id="mine-note">
            {personsFailed ? (
              <LoadFailed onRetry={reloadPersons} />
            ) : !persons ? null : mine.length ? (
              <p className="note">あなたの名前が読める物は、まだありません。</p>
            ) : linkable.length ? (
              <details className="fold">
                <summary>あなたの人カードを選ぶと、あなたに関係しそうな物が出ます</summary>
                <div className="choice-row">
                  {linkable.map((p) => (
                    <button
                      key={p.id}
                      className="btn"
                      onClick={async () => {
                        if (!myId) return;
                        const ok = await act(() => api(`/api/p/${pid}/persons/${p.id}/link`, { method: "PUT", json: { user_id: myId } }));
                        if (ok !== undefined) await reloadPersons();
                      }}
                    >
                      わたしは {p.label}
                    </button>
                  ))}
                </div>
              </details>
            ) : (
              <p className="note">名前が読めた物が増えると、あなたに関係しそうな物がここに出ます。</p>
            )}
          </div>
          )
        )}

        <section className="grid-sec" aria-labelledby="all-h">
          <div className="grid-head">
            <div className="head-row">
              <h2 className="h-mid" id="all-h">
                {focused ? `${focused.p.label}につながる物` : "すべての物"}
              </h2>
              {focused ? (
                <button type="button" className="text-btn" id="clear-focus" onClick={() => pick(null)}>
                  すべてに戻す
                </button>
              ) : null}
            </div>
            <p className="note">手がかりの多い順です。大切さの順ではありません</p>
            {notices.length ? (
              // 写真をまたぐ気づき。作業を止めないよう閉じて置き、開いた人だけが読む
              <details className="fold box-notices" id="box-notices">
                <summary>気づき {notices.length} 件</summary>
                <ul className="box-notice-list">
                  {notices.map((n, i) => (
                    <li key={i} className="box-notice">
                      <p className="notice-say">{n.say}</p>
                      <p className="notice-items">
                        {n.item_ids
                          .map((id) => byId.get(id))
                          .filter((it): it is NonNullable<typeof it> => !!it)
                          .map((it) => (
                            <a key={it.id} className="notice-item" href={`#/p/${pid}/item/${it.id}`}>
                              <Thumb item={it} className="thumb-mini" />
                              <span>{itemTitle(it)}</span>
                            </a>
                          ))}
                      </p>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
          <div className="grid" id="grid">
            {shown.map((it) => (
              <Tile key={it.id} pid={pid} item={it} />
            ))}
          </div>
          {items && items.length === 0 ? <p className="note pad">まだ物がありません。下の「撮る」から始めます。</p> : null}
        </section>

        <section className="sec" aria-labelledby="links-h">
          <h2 className="h-mid" id="links-h">
            物どうしのつながり
          </h2>
          {groups.length ? <p className="note">同じ人の名前が読めた物をまとめています。押すと、その物だけを上の写真に出します。</p> : null}
          {groups.length ? (
            // 点数の多い順に並べ、点数を太い数字と横の帯で見せる。押すと下の写真がその人の物に絞られる
            <ul className="links" role="group" aria-label="つながりで絞る">
              {groups.map(({ p, ids }) => (
                <li key={p.id}>
                  <button className="link-row" aria-pressed={focus === p.id} onClick={() => pick(focus === p.id ? null : p.id)}>
                    <span className="link-name">
                      <b>{p.label}</b>
                      <span className="link-kind">{SUBTYPE_NAMES[p.subtype]}</span>
                    </span>
                    <span className="link-count">
                      <b>{ids.length}</b>点
                    </span>
                    <span className="link-bar" aria-hidden="true">
                      <span style={{ width: `${Math.round((ids.length / groups[0].ids.length) * 100)}%` }} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            personsFailed ? (
              <LoadFailed onRetry={reloadPersons} />
            ) : (
              <p className="note">{persons ? "物が増えると、Claude がつながりを見つけます。" : "読み込んでいます"}</p>
            )
          )}
          {focused ? (
            <ul className="claims">
              {focused.p.claims.map((c) => (
                <li key={c.id} className={`claim claim-${c.source}`}>
                  <span className="claim-src">{SOURCE_LABEL[c.source]}</span>
                  <span className="claim-text">{c.text}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <nav className="rows" aria-label="片付けの道具">
          <a className="row-link" href={`#/p/${pid}/check`} id="go-check">
            <span>捨てる前の確認</span>
            <span className="note">処分したい物から、待ったの物を抜く</span>
          </a>
          <a className="row-link" href={`#/p/${pid}/places`} id="go-places">
            <span>仕分け先</span>
            <span className="note">使わなくても大丈夫です</span>
          </a>
        </nav>
      </main>
      <TabBar pid={pid} current="home" waited={waited} />
    </div>
  );
}
