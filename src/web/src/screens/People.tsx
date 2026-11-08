// 人カード。物から見えてきた人の札が主。参加者と招待は下にまとめる。人物の札（Claude の仮説と家族の書き足し）。今の画面の機能を保つ
import { useEffect, useState } from "react";
import {
  SUBTYPE_NAMES,
  api,
  type InviteListResponse,
  type InviteResponse,
} from "../api";
import type { ProjectCtx } from "../App";
import { TabBar, useAct, useActPending, useScreenTitle, useToast } from "../ui";
import { LoadFailed, SOURCE_LABEL, usePersons } from "./Home";

// 招待のリンクは、サーバが今の画面（/#/join/）の形で返す。React 版で開けるよう /app/ に直す
const toAppUrl = (url: string) => {
  const m = url.match(/#\/join\/([0-9a-f]+)/);
  return m ? `${location.origin}/app/#/join/${m[1]}` : url;
};

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function Invites({ pid }: { pid: string }) {
  const act = useAct();
  const [actMake, making] = useActPending();
  const toast = useToast();
  const [list, setList] = useState<InviteListResponse["invites"] | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [name, setName] = useState("");
  const [made, setMade] = useState<{ name: string; url: string } | null>(null);
  const load = () =>
    api<InviteListResponse>(`/api/p/${pid}/invites`).then(
      (r) => {
        setListFailed(false);
        setList(r.invites);
      },
      () => setListFailed(true),
    );
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);

  return (
    <section className="sec" aria-labelledby="inv-h">
      <h2 className="h-mid" id="inv-h">
        招待
      </h2>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          const n = name.trim();
          if (!n) return;
          const r = await actMake(() => api<InviteResponse>(`/api/p/${pid}/invites`, { method: "POST", json: { display_name: n } }));
          if (r) {
            setMade({ name: r.display_name, url: toAppUrl(r.url) });
            setName("");
            load();
          }
        }}
      >
        <label htmlFor="invite-name">招待する人の名前</label>
        <input id="invite-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        <button className="btn btn-primary wide" type="submit" id="make-invite" disabled={making}>
          招待のリンクを作る
        </button>
      </form>
      {made ? (
        <div className="stack-tight" id="invite-made">
          <p>{made.name}さんに、このリンクを送ってください。1人に1つです。</p>
          <input readOnly value={made.url} aria-label="招待のリンク" onFocus={(e) => e.currentTarget.select()} />
          <button className="btn" onClick={async () => toast((await copy(made.url)) ? "写しました" : "リンクを長押しして写してください")}>
            リンクを写す
          </button>
        </div>
      ) : null}
      {listFailed && !list ? <LoadFailed onRetry={load} /> : null}
      {list?.length ? (
        <ul className="plain-list">
          {list.map((i) => (
            <li key={i.id} className="plain-row">
              <span>
                <b>{i.display_name}</b>
                <span className="note">{i.revoked ? "止めました" : i.joined ? `参加しました${i.joined_name && i.joined_name !== i.display_name ? `（${i.joined_name}）` : ""}` : "まだ開いていません"}</span>
              </span>
              {!i.revoked && !i.joined ? (
                <button
                  className="text-btn"
                  onClick={async () => {
                    const ok = await act(() => api(`/api/p/${pid}/invites/${i.id}`, { method: "DELETE" }));
                    if (ok !== undefined) load();
                  }}
                >
                  止める
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function People({ ctx }: { ctx: ProjectCtx }) {
  const { pid, me, project, items } = ctx;
  const act = useAct();
  const [actAdd, adding] = useActPending();
  const doneCount = (items ?? []).filter((i) => i.status === "done").length;
  const { persons, reloadPersons, failed: personsFailed } = usePersons(pid, doneCount);
  const h1 = useScreenTitle("人カード", project.title);
  const [writing, setWriting] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const myId = me.user?.id;
  const waited = (items ?? []).filter((i) => i.wait_count > 0).length;

  return (
    <div className="screen with-tabs">
      <main className="page">
        <header className="head">
          <h1 className="h-big" ref={h1} tabIndex={-1}>
            人カード
          </h1>
          <p className="sub">写真の文字から見えてきた人を、1人1枚にまとめています。家族が書き足せます。</p>
        </header>

        <section className="sec" aria-labelledby="per-h">
          <h2 className="vh" id="per-h">
            人カード
          </h2>
          {personsFailed ? <LoadFailed onRetry={reloadPersons} /> : null}
          {(persons?.persons ?? []).map((p) => (
            <article key={p.id} className="person">
              <div className="person-head">
                <b>{p.label}</b>
                <span className="person-kind">{SUBTYPE_NAMES[p.subtype]}</span>
                {p.linked_user_id && p.linked_user_id === myId ? <span className="person-kind">あなた</span> : null}
              </div>
              <ul className="claims">
                {p.claims.map((c) => (
                  <li key={c.id} className={`claim claim-${c.source}`}>
                    <span className="claim-src">
                      {SOURCE_LABEL[c.source]}
                      {c.author ? `（${c.author.display_name}）` : ""}
                    </span>
                    <span className="claim-text">{c.text}</span>
                  </li>
                ))}
              </ul>
              {writing === p.id ? (
                <form
                  className="stack-tight"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const t = text.trim();
                    if (!t) return;
                    const ok = await act(() => api(`/api/p/${pid}/persons/${p.id}/claims`, { method: "POST", json: { text: t } }));
                    if (ok) {
                      setText("");
                      setWriting(null);
                      reloadPersons();
                    }
                  }}
                >
                  <label htmlFor={`w-${p.id}`}>{p.label}について知っていること</label>
                  <textarea id={`w-${p.id}`} value={text} onChange={(e) => setText(e.target.value)} rows={3} />
                  <div className="row-2">
                    <button type="button" className="btn" onClick={() => setWriting(null)}>
                      やめる
                    </button>
                    <button type="submit" className="btn btn-primary">
                      書き足す
                    </button>
                  </div>
                </form>
              ) : (
                <div className="choice-row">
                  <button
                    className="btn btn-quiet"
                    onClick={() => {
                      setWriting(p.id);
                      setText("");
                    }}
                  >
                    書き足す
                  </button>
                  {myId && !p.linked_user_id && p.subtype === "relative" ? (
                    <button
                      className="text-btn"
                      onClick={async () => {
                        const ok = await act(() => api(`/api/p/${pid}/persons/${p.id}/link`, { method: "PUT", json: { user_id: myId } }));
                        if (ok !== undefined) reloadPersons();
                      }}
                    >
                      これはわたし
                    </button>
                  ) : p.linked_user_id === myId ? (
                    <button
                      className="text-btn"
                      onClick={async () => {
                        const ok = await act(() => api(`/api/p/${pid}/persons/${p.id}/link`, { method: "PUT", json: { user_id: null } }));
                        if (ok !== undefined) reloadPersons();
                      }}
                    >
                      わたしではない
                    </button>
                  ) : null}
                </div>
              )}
            </article>
          ))}
          <form
            className="stack-tight"
            onSubmit={async (e) => {
              e.preventDefault();
              const l = newLabel.trim();
              if (!l) return;
              const ok = await actAdd(() => api(`/api/p/${pid}/persons`, { method: "POST", json: { label: l } }));
              if (ok) {
                setNewLabel("");
                reloadPersons();
              }
            }}
          >
            <label htmlFor="new-person">人カードを足す（「〜夫妻」のような名前でよい）</label>
            <div className="note-row">
              <input id="new-person" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} autoComplete="off" />
              <button className="btn" type="submit" disabled={adding}>
                足す
              </button>
            </div>
          </form>
        </section>
        <section className="sec" aria-labelledby="mem-h">
          <h2 className="h-mid" id="mem-h">
            この片付けに参加している家族
          </h2>
          <ul className="plain-list" id="participants">
            {(persons?.participants ?? []).map((p) => (
              <li key={p.user_id} className="plain-row">
                <span>
                  <b>{p.display_name}</b>
                  {p.user_id === myId ? <span className="note">あなた</span> : null}
                </span>
                <span className="note">{p.role === "owner" ? "始めた人" : "参加者"}</span>
              </li>
            ))}
          </ul>
        </section>

        {project.role === "owner" && !project.is_sample ? <Invites pid={pid} /> : null}
        {project.is_sample ? <p className="note pad">見本では招待を作れません。自分の片付けを始めると招待できます。</p> : null}

      </main>
      <TabBar pid={pid} current="people" waited={waited} />
    </div>
  );
}
