// 物の詳細。
// 伝えること：「この物について AI が見つけた事実と、ほかの物とのつながり。残してほしければ待った」
// 順位：写真 → AI の一言 → つながりの図 → 待った（下に固定）
import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  PILES,
  PILE_NAMES,
  api,
  itemTitle,
  type ClaimX,
  type ItemDetailX,
  type ReadLine,
  type WaitResponse,
} from "../api";
import type { ProjectCtx } from "../App";
import { BackLink, Lane, Thumb, useAct, usePoll, useToast } from "../ui";
import { SOURCE_LABEL } from "./Home";

// AI の一言。「大切です」「捨ててよい」とは言わない。数はコードで数える
function headline(d: ItemDetailX, total: number | null): { say: string; note: string; guess: boolean } {
  const id = d.item.id;
  const photo = d.claims
    .filter((c) => c.source === "photo" && c.item_ids.includes(id))
    .sort((a, b) => a.item_ids.length - b.item_ids.length)[0];
  const counted = total ? `全${total}点を数えた結果です` : "この片付けの物を数えた結果です";
  if (photo) {
    const n = photo.item_ids.length;
    return n === 1
      ? { say: `「${photo.person_label}」の名前が読める物は、この1点だけです`, note: counted, guess: false }
      : { say: `「${photo.person_label}」の名前が読める物が、ほかに${n - 1}点あります`, note: counted, guess: false };
  }
  const claude = d.claims.find((c) => c.source === "claude" && c.item_ids.includes(id));
  if (claude) return { say: claude.text, note: "Claude の推測です。事実とは限りません", guess: true };
  const inf = d.reading?.b?.inferences?.[0];
  if (inf) return { say: inf, note: "Claude の推測です。事実とは限りません", guess: true };
  const kind = d.reading?.b?.kind;
  return { say: kind ? `${kind}に見えます` : itemTitle(d.item), note: "写真から見えた物です", guess: false };
}

// 読めた文字。家族の訂正を先に使う
function readLines(d: ItemDetailX): { text: string; fixed: boolean; hand: boolean }[] {
  const r = d.reading as (ItemDetailX["reading"] & { checked?: { lines: ReadLine[] } }) | null;
  const lines = r?.checked?.lines ?? r?.a?.lines ?? [];
  return lines.map((l, i) => {
    const fix = d.correction?.lines?.[String(i)];
    return { text: fix?.text ?? l.text, fixed: !!fix, hand: l.handwritten };
  });
}

type Edge = { label: string; dashed: boolean };
function edgeOf(claims: ClaimX[], a: string, b: string): Edge {
  const both = claims.filter((c) => c.item_ids.includes(a) && c.item_ids.includes(b));
  if (both.some((c) => c.source === "photo")) return { label: "同じ名前", dashed: false };
  if (both.some((c) => c.source === "family")) return { label: "家族の話", dashed: false };
  return { label: "推測", dashed: true };
}

// つながりの図。真ん中にこの物、周りに隣の段だけ（6点まで）。位置は固定
const W = 358;
const H = 300;
const R_NODE = 38;
const R_CENTER = 50;
function slots(n: number): [number, number][] {
  const cx = W / 2;
  const cy = H / 2;
  const rx = W / 2 - R_NODE - 4;
  const ry = H / 2 - R_NODE - 28; // 下に言葉を置く余白
  return Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + Math.PI / n + (2 * Math.PI * i) / n;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  });
}

function LinkMap({ pid, d, origin }: { pid: string; d: ItemDetailX; origin: string }) {
  const rel = d.related.slice(0, 6);
  const pos = slots(rel.length);
  const pct = (x: number, y: number) => ({ left: `${(x / W) * 100}%`, top: `${(y / H) * 100}%` });
  return (
    <div className="map" role="img" aria-label={`つながる物 ${rel.length}点の図。下に同じ内容の一覧があります`}>
      <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        {rel.map((r, i) => {
          const e = edgeOf(d.claims, d.item.id, r.id);
          return (
            <line
              key={r.id}
              x1={W / 2}
              y1={H / 2}
              x2={pos[i][0]}
              y2={pos[i][1]}
              className="map-line"
              strokeDasharray={e.dashed ? "6 6" : undefined}
            />
          );
        })}
      </svg>
      <span className="node node-center" style={pct(W / 2, H / 2)}>
        <Thumb item={d.item} />
      </span>
      {rel.map((r, i) => {
        const e = edgeOf(d.claims, d.item.id, r.id);
        // 言葉は物の写真のすぐ下に置く。線の上だと真ん中の写真に重なる
        const mx = pos[i][0];
        const my = pos[i][1] + R_NODE + 14;
        return (
          <span key={r.id}>
            <a
              className="node"
              style={pct(pos[i][0], pos[i][1])}
              href={`#/p/${pid}/item/${r.id}?from=${origin}`}
              tabIndex={-1}
              aria-hidden="true"
            >
              <Thumb item={r} />
            </a>
            <span className="map-label" style={pct(mx, my)} aria-hidden="true">
              {e.label}
            </span>
          </span>
        );
      })}
    </div>
  );
}

// 読み取り中の間だけ置く。外れると取り直しも止まる
function ReadPoll({ fn }: { fn: () => Promise<unknown> }) {
  usePoll(fn, 3000, []);
  return null;
}

export function Detail({ ctx, iid, from, back }: { ctx: ProjectCtx; iid: string; from: string | null; back?: string | null }) {
  // 戻るの言葉は来た道に合わせる（BackLink は前の画面へ history.back する）
  const backLabel = from ? "前の物" : back === "search" ? "探す" : "つながり";
  const { pid, me, items, reload } = ctx;
  const act = useAct();
  const toast = useToast();
  const [d, setD] = useState<ItemDetailX | null>(null);
  const [fail, setFail] = useState<"missing" | "net" | null>(null);
  const [tries, setTries] = useState(0);
  const [showText, setShowText] = useState(false);
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [undoNote, setUndoNote] = useState<string | null>(null); // 取り消した直後だけ「元に戻す」を出す
  const undoTimer = useRef<number>(0);
  const waitBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setFail(null);
    setUndoNote(null); // 別の物で「元に戻す」が効かないように
    clearTimeout(undoTimer.current);
    api<ItemDetailX>(`/api/p/${pid}/items/${iid}`).then(
      (x) => {
        setD(x);
        setNote(x.waits.find((w) => w.user.id === me.user?.id)?.note ?? "");
      },
      (e) => setFail(e instanceof ApiError && e.status === 404 ? "missing" : "net"),
    );
  }, [pid, iid, me.user?.id, tries]);

  useEffect(() => () => clearTimeout(undoTimer.current), []);

  // 題名を物の名前にする
  const titleText = d ? itemTitle(d.item) : null;
  useEffect(() => {
    if (titleText) document.title = `${titleText}｜${ctx.project.title}`;
  }, [titleText, ctx.project.title]);

  if (fail === "missing")
    return (
      <main className="page">
        <BackLink href={`#/p/${pid}`}>{backLabel}</BackLink>
        <p className="pad">この物は見つかりません。消えたか、番号が違います。</p>
      </main>
    );
  if (fail === "net" && !d)
    return (
      <main className="page">
        <BackLink href={`#/p/${pid}`}>{backLabel}</BackLink>
        <p className="pad">通信できませんでした。</p>
        <button className="btn" onClick={() => setTries((n) => n + 1)}>
          もう一度開く
        </button>
      </main>
    );
  if (!d)
    return (
      <main className="page" aria-busy="true">
        <p className="pad">開いています…</p>
      </main>
    );

  const item = d.item;
  const h = headline(d, items?.length ?? null);
  const lines = readLines(d);
  const origin = from ?? iid;
  const reading = item.status === "queued" || item.status === "reading";

  // 読み取りが終わったら一覧も取り直す
  const refetch = async () => {
    const x = await api<ItemDetailX>(`/api/p/${pid}/items/${iid}`);
    setD(x);
    if (x.item.status !== "queued" && x.item.status !== "reading") reload().catch(() => {});
  };

  // 弾む動き。key で入れ替えず、class を付け直す（フォーカスを保つ）
  const bounce = () => {
    const el = waitBtn.current;
    if (!el) return;
    el.classList.remove("pop");
    void el.offsetWidth;
    el.classList.add("pop");
  };

  // 送信中は disabled でフォーカスが外れるので、描き直したあとに戻す
  const focusWait = () => requestAnimationFrame(() => waitBtn.current?.focus());

  const sendWait = async (on: boolean, withNote?: string): Promise<boolean> => {
    setBusy(true);
    const res = await act(() =>
      api<WaitResponse>(`/api/p/${pid}/items/${iid}/wait`, {
        method: on ? "POST" : "DELETE",
        json: on ? (withNote !== undefined ? { note: withNote } : {}) : undefined,
      }),
    );
    setBusy(false);
    if (!res) return false;
    setD((cur) =>
      cur ? { ...cur, item: { ...cur.item, wait_count: res.wait_count, waited_by_me: res.waited_by_me }, waits: res.waits } : cur,
    );
    reload().catch(() => {});
    return true;
  };

  const onWait = async () => {
    if (busy) return;
    if (item.waited_by_me) {
      // オンのときは取り消さない。ひとことの欄を開くだけ
      setNoteOpen(true);
      return;
    }
    clearTimeout(undoTimer.current);
    setUndoNote(null);
    const ok = await sendWait(true);
    if (ok) {
      bounce();
      setNoteOpen(true);
    }
    focusWait();
  };

  const cancelWait = async () => {
    if (busy) return;
    const before = d.waits.find((w) => w.user.id === me.user?.id)?.note ?? "";
    if (!(await sendWait(false))) return;
    setNoteOpen(false);
    setNote("");
    toast("待ったを取り消しました。すぐ下の「元に戻す」で戻せます", 6000);
    setUndoNote(before);
    clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setUndoNote(null), 6000);
    focusWait();
  };

  const undoCancel = async () => {
    if (busy || undoNote === null) return;
    const before = undoNote;
    clearTimeout(undoTimer.current);
    if (await sendWait(true, before)) {
      setUndoNote(null);
      setNote(before);
      bounce();
      toast("待ったを戻しました");
    }
    focusWait();
  };

  const setPile = async (pile: string) => {
    if (pile === item.pile) return;
    const res = await act(() => api<ItemDetailX>(`/api/p/${pid}/items/${iid}`, { method: "PATCH", json: { pile } }));
    if (res) {
      setD(res);
      toast(`行き先を『${PILE_NAMES[pile] ?? pile}』にしました`);
      reload().catch(() => {});
    }
  };

  return (
    <div className="screen with-foot">
      <main className="page detail">
        {reading ? <ReadPoll key={iid} fn={refetch} /> : null}
        <div className="photo">
          <button className="photo-btn" onClick={() => setShowText(!showText)} aria-pressed={showText}>
            <img src={item.photo_url} alt="" style={{ viewTransitionName: `item-${item.id}` }} />
            {/* 重ねの上に出すため z-index を付ける */}
            <span className="read-hint" style={{ zIndex: 1 }}>
              {showText ? "押すと写真に戻る" : "押すと読めた文字"}
            </span>
          </button>
          {/* 読めた文字はボタンの外に置き、読み上げで隠さない。押すと写真に戻る */}
          {showText ? (
              <div className="read-layer" id="read-layer" onClick={() => setShowText(false)}>
                {lines.length ? (
                  lines.map((l, i) => (
                    <span key={i} className="read-line">
                      {l.text}
                      {l.hand ? <small>手書き</small> : null}
                      {l.fixed ? <small>家族が訂正</small> : null}
                    </span>
                  ))
                ) : (
                  <span className="read-line">読めた文字はありません</span>
                )}
              </div>
          ) : null}
          <div className="photo-top">
            <BackLink href={`#/p/${pid}`}>{backLabel}</BackLink>
          </div>
        </div>

        <section className="sec">
          <div className="title-row">
            <h1 className="h-mid">{itemTitle(item)}</h1>
            <Lane pile={item.pile} />
          </div>
          {reading ? (
            <p className="note">Claude が読み取っています。少し待つと、ここに見つけたことが出ます。</p>
          ) : (
            <>
              <p className={`say${h.guess ? " say-guess" : ""}`} id="say">
                {h.say}
              </p>
              <p className="note">{h.note}</p>
              {d.reading?.scene?.notice ? (
                <p className="item-notice" id="item-notice">
                  <span className="item-notice-label">気づき</span>
                  {d.reading.scene.notice.say}
                </p>
              ) : null}
            </>
          )}
          {item.can_retry ? (
            <button
              className="btn"
              onClick={async () => {
                const res = await act(() => api<{ item: ItemDetailX["item"] }>(`/api/p/${pid}/items/${iid}/retry`, { method: "POST" }));
                if (res) setD((cur) => (cur ? { ...cur, item: res.item } : cur));
              }}
            >
              もう一度読む
            </button>
          ) : null}
        </section>

        {d.related.length ? (
          <section className="sec" aria-labelledby="map-h">
            <h2 className="h-mid" id="map-h">
              つながる物
            </h2>
            <LinkMap pid={pid} d={d} origin={origin} />
            {from && from !== iid ? (
              <a className="btn" href={`#/p/${pid}/item/${from}`} id="back-origin">
                最初の物に戻る
              </a>
            ) : null}
            <ul className="rel-list">
              {d.related.map((r) => {
                const why = d.claims.filter((c) => c.item_ids.includes(r.id));
                return (
                  <li key={r.id}>
                    <a href={`#/p/${pid}/item/${r.id}?from=${origin}`} className="rel-row">
                      <Thumb item={r} className="rel-thumb" />
                      <span className="rel-body">
                        <b>{itemTitle(r)}</b>
                        {why.map((c) => (
                          <span key={c.id} className={`claim-${c.source}`}>
                            {c.source === "claude" ? "推測：" : c.source === "family" ? "家族：" : ""}
                            {c.text}
                          </span>
                        ))}
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {d.claims.length ? (
          <section className="sec" aria-labelledby="claims-h">
            <h2 className="h-mid" id="claims-h">
              分かったこと
            </h2>
            <ul className="claims">
              {d.claims.map((c) => (
                <li key={c.id} className={`claim claim-${c.source}`}>
                  <span className="claim-src">
                    {c.person_label}。{SOURCE_LABEL[c.source]}
                  </span>
                  <span className="claim-text">{c.text}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="sec" aria-labelledby="pile-h">
          <h2 className="h-mid" id="pile-h">
            行き先
          </h2>
          <div className="pile-pick" role="group" aria-label="行き先を変える">
            {PILES.map((p) => (
              <button key={p} className={`pick pick-${p}`} aria-pressed={item.pile === p} onClick={() => setPile(p)}>
                {PILE_NAMES[p]}
              </button>
            ))}
          </div>
        </section>

        {d.waits.length ? (
          <section className="sec" aria-labelledby="waits-h">
            <h2 className="h-mid" id="waits-h">
              待ったをかけた人
            </h2>
            <ul className="waits" id="waits">
              {d.waits.map((w) => (
                <li key={w.user.id}>
                  <b>{w.user.display_name}</b>
                  {w.note ? <span className="family-words">{w.note}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </main>

      <footer className="foot">
        {noteOpen && item.waited_by_me ? (
          <form
            className="note-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (busy) return;
              if (await sendWait(true, note)) {
                setNoteOpen(false);
                focusWait();
                toast("ひとことを送りました");
              }
            }}
          >
            <label htmlFor="wait-note">ひとこと（任意）</label>
            <div className="note-row">
              <input id="wait-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="例：父の字なので残したい" />
              <button className="btn" type="submit" disabled={busy} aria-busy={busy}>
                送る
              </button>
            </div>
          </form>
        ) : (
          <p className="note">1人でも押せば、この物は残します</p>
        )}
        <div className="wait-row">
          {/* 1つのボタン。オンのときに押しても取り消さない（取り消しは横の小さなボタン） */}
          <button
            ref={waitBtn}
            className={`btn btn-wait${item.waited_by_me ? " is-held" : ""}`}
            id="wait"
            aria-pressed={item.waited_by_me}
            disabled={busy}
            aria-busy={busy}
            onClick={onWait}
          >
            {item.waited_by_me ? (
              <>
                <span className="stamp-mini" aria-hidden="true">
                  待
                </span>
                待ったをかけました
              </>
            ) : (
              "待った"
            )}
          </button>
          {item.waited_by_me ? (
            <button className="text-btn" id="wait-cancel" disabled={busy} aria-busy={busy} onClick={cancelWait}>
              取り消す
            </button>
          ) : undoNote !== null ? (
            <button className="text-btn" id="wait-undo" disabled={busy} aria-busy={busy} onClick={undoCancel}>
              元に戻す
            </button>
          ) : null}
        </div>
      </footer>
    </div>
  );
}
