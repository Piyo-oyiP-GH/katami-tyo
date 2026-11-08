// 公開版の入口の合言葉。サーバが要ると言ったときだけ出す。照合はサーバでする。
import { useEffect, useState, type ReactNode } from "react";

type State = "checking" | "need" | "open" | "offline";

export function Gate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>("checking");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = () =>
    fetch("/api/access", { credentials: "same-origin" })
      .then((r) => r.json() as Promise<{ required: boolean; ok: boolean }>)
      .then((r) => setState(!r.required || r.ok ? "open" : "need"))
      .catch(() => setState("offline"));

  useEffect(() => {
    check();
  }, []);

  if (state === "open") return <>{children}</>;
  if (state === "checking") return <main className="page entry" aria-busy="true" />;
  if (state === "offline")
    return (
      <main className="page entry">
        <h1 className="h-big">かたみ帳</h1>
        <p>つながりませんでした。</p>
        <button className="btn btn-primary wide" onClick={() => (setState("checking"), check())}>
          もう一度読み込む
        </button>
      </main>
    );

  return (
    <main className="page entry">
      <header className="entry-head">
        <h1 className="h-big">かたみ帳</h1>
        <p>この版は、審査と試用のために合言葉で入る形にしています。</p>
      </header>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy || !code.trim()) return;
          setBusy(true);
          setError(null);
          try {
            const r = await fetch("/api/access", {
              method: "POST",
              credentials: "same-origin",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ code }),
            });
            if (r.ok) setState("open");
            else if (r.status === 429) setError("試した回数が多すぎます。明日もう一度試してください。");
            else setError("合言葉が違います。");
          } catch {
            setError("通信できませんでした。もう一度押してください。");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label htmlFor="access-code">合言葉</label>
        <input
          id="access-code"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "access-error" : undefined}
        />
        {error ? (
          <p className="note" id="access-error" role="alert">
            {error}
          </p>
        ) : null}
        <button className="btn btn-primary wide" type="submit" disabled={busy} aria-busy={busy}>
          {busy ? "確かめています" : "入る"}
        </button>
      </form>
    </main>
  );
}
