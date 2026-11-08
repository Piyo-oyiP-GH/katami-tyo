// 入口：続きを開く、見本で試す、新しく始める、招待で入る。今の画面と同じ API を使う。
import { useEffect, useState } from "react";
import { ApiError, api, errorText, type GuestResponse, type MeX } from "../api";
import { Loading, useToast } from "../ui";
import { Denied, Unreachable } from "../App";

function tokenFrom(text: string) {
  const t = text.trim();
  const m = t.match(/#\/join\/([0-9a-f]+)/);
  return m ? m[1] : t;
}

export function Entry() {
  const toast = useToast();
  const [me, setMe] = useState<MeX | null>(null);
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState("");
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");

  useEffect(() => {
    document.title = "YukariNote";
    setFailed(false);
    api<MeX>("/api/me").then(setMe, () => setFailed(true));
  }, [nonce]);

  const attempt = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast((e instanceof ApiError && errorText(e.code)) || "通信できませんでした。もう一度押してください。", 4000);
    } finally {
      setBusy(false);
    }
  };

  // 入口の /api/me は締め出しではないので、失敗は取り直せる形で出す
  if (failed) return <Unreachable onRetry={() => setNonce((n) => n + 1)} />;
  if (!me) return <Loading text="開いています" />;
  const sample = me.projects.find((p) => p.is_sample);
  const needName = !me.user || me.user.is_guest;

  return (
    <main className="page entry">
      <header className="entry-head">
        <h1 className="h-big">YukariNote</h1>
        <p>家財を撮ると、Claude が文字や物を読み、物どうしのつながりを示します。離れた親族も、捨てる前に「待った」をかけられます。</p>
      </header>

      {me.projects.length ? (
        <section className="sec">
          <h2 className="h-mid">続きを開く</h2>
          {me.projects.map((p) => (
            <a key={p.id} className="btn wide" href={`#/p/${p.id}`}>
              {p.title}
            </a>
          ))}
        </section>
      ) : null}
      {me.scoped ? <p className="note" id="scoped-note">この端末はリンクで入っています。開けるのは上の片付けだけです。</p> : null}

      {me.scoped || sample ? null : (
        <section className="sec">
          <button
            className="btn btn-primary wide"
            id="try-sample"
            disabled={busy}
            onClick={() =>
              attempt(async () => {
                const { project_id } = await api<GuestResponse>("/api/guest", { method: "POST" });
                location.hash = `#/p/${project_id}`;
              })
            }
          >
            見本で試す
          </button>
          <p className="note">架空の家族の 12 点で試せます。ログインは要りません。24 時間で消えます。</p>
        </section>
      )}

      {me.scoped ? null : (
        <details className="fold">
          <summary>新しい片付けを始める</summary>
          <form
            className="stack"
            id="new-project"
            onSubmit={(e) => {
              e.preventDefault();
              attempt(async () => {
                const res = await api<{ project_id: string }>("/api/projects", {
                  method: "POST",
                  json: { display_name: name, title },
                });
                location.hash = `#/p/${res.project_id}/people`;
              });
            }}
          >
            {needName ? (
              <>
                <label htmlFor="new-name">名前またはニックネーム</label>
                <input id="new-name" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
              </>
            ) : null}
            <label htmlFor="new-title">片付けの名前（例：祖母の家）</label>
            <input id="new-title" autoComplete="off" required value={title} onChange={(e) => setTitle(e.target.value)} />
            <button className="btn wide" type="submit" disabled={busy}>
              始める
            </button>
          </form>
        </details>
      )}
      <details className="fold">
        <summary>招待で入る</summary>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            const token = tokenFrom(invite);
            if (token) location.hash = `#/join/${token}`;
          }}
        >
          <label htmlFor="invite-input">送られてきたリンク</label>
          <input id="invite-input" autoComplete="off" value={invite} onChange={(e) => setInvite(e.target.value)} />
          <button className="btn wide" type="submit">
            参加する
          </button>
        </form>
      </details>

    </main>
  );
}

// 開発中の StrictMode は effect を 2 回動かす。同じ招待を 2 回送らないよう、トークンごとに 1 つの約束を使い回す
const joins = new Map<string, Promise<GuestResponse>>();
const joinOnce = (token: string) => {
  let p = joins.get(token);
  if (!p) {
    p = api<GuestResponse>("/api/invite", { method: "POST", json: { token } });
    joins.set(token, p);
  }
  return p;
};

export function Join({ token }: { token: string }) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    joinOnce(token).then(
      ({ project_id }) => {
        if (!live) return;
        // トークンを履歴に残さない
        history.replaceState(null, "", `#/p/${project_id}`);
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      },
      (e) => {
        if (!live) return;
        history.replaceState(null, "", "#/join");
        if (e instanceof ApiError && e.code === "invite_other_user") {
          setError("このリンクは別の人のものです。この端末は今の人のままです。自分のリンクを開いてください。");
        } else if (e instanceof ApiError && e.code === "scoped_session") {
          setError("この端末はリンクで別の片付けに入っています。新しい招待は、いつも使っている端末で開いてください。");
        } else {
          setError("この招待は使えません。止められたか、もう使われています。送った人に確かめてください。");
        }
      },
    );
    return () => {
      live = false;
    };
  }, [token]);
  if (error) return <Denied text={error} />;
  return (
    <main className="page entry">
      <p>招待を確かめています。</p>
    </main>
  );
}
