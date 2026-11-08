// 探す。読めた文字、物の名前、類義語、Claude の見立てから探す。どこで一致したかを出す
import { useEffect, useState } from "react";
import { SOURCE_NAMES, api, itemTitle, type SearchX } from "../api";
import type { ProjectCtx } from "../App";
import { splitQuery } from "../router";
import { BackLink, Lane, Stamp, Thumb, useScreenTitle } from "../ui";

export function Search({ ctx }: { ctx: ProjectCtx }) {
  const { pid, project } = ctx;
  // 言葉はハッシュの ?q= に持つ。詳細から戻ったとき、同じ言葉で探し直せる
  const [q, setQ] = useState(() => splitQuery(location.hash.replace(/^#/, ""))[1].get("q") ?? "");
  const h1 = useScreenTitle("探す", project.title);
  const [res, setRes] = useState<SearchX | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    try {
      const url = `#/p/${pid}/search${q ? `?q=${encodeURIComponent(q)}` : ""}`;
      if (location.hash !== url) history.replaceState(history.state, "", url);
    } catch {
      // 残せないだけ
    }
    const word = q.trim();
    if (!word) {
      setRes(null);
      return;
    }
    const t = window.setTimeout(() => {
      api<SearchX>(`/api/p/${pid}/search?q=${encodeURIComponent(word)}`).then(
        (r) => {
          setFailed(false);
          setRes(r);
        },
        () => setFailed(true),
      );
    }, 250);
    return () => clearTimeout(t);
  }, [q, pid]);

  return (
    <main className="page">
      <header className="head">
        <BackLink href={`#/p/${pid}`}>つながり</BackLink>
        <h1 className="h-big" ref={h1} tabIndex={-1}>
          探す
        </h1>
      </header>
      <form className="sec" role="search" onSubmit={(e) => e.preventDefault()}>
        <label htmlFor="q" className="h-mid">
          名前、年、物の種類など
        </label>
        <input id="q" type="search" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" placeholder="例：俳句、昭和、手紙" />
        <p className="note">読めた文字のほか、Claude の見立てでも探します。見立ては事実とは限りません。</p>
      </form>
      {failed ? <p className="note pad">通信できませんでした。もう一度入れてください。</p> : null}
      {res ? (
        <section className="sec" aria-live="polite">
          <h2 className="h-mid">{res.hits.length ? `${res.hits.length}点` : "見つかりませんでした"}</h2>
          <ul className="rel-list" id="hits">
            {res.hits.map(({ item, matched }) => (
              <li key={item.id}>
                <a className="rel-row" href={`#/p/${pid}/item/${item.id}?back=search`}>
                  <span className="rel-thumb-wrap">
                    <Thumb item={item} className="rel-thumb" />
                    {item.wait_count ? <Stamp /> : null}
                  </span>
                  <span className="rel-body">
                    <b>{itemTitle(item)}</b>
                    <span className="note">
                      {[...new Set(matched.map((m) => SOURCE_NAMES[m.source] ?? m.source))].join("、")}
                    </span>
                    <Lane pile={item.pile} />
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
