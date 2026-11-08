// 捨てる前の確認。
// 伝えること：「処分したい物のうち、待ったの付いた物はこれ。袋から抜いてから捨てる」
import { useEffect, useState } from "react";
import { api, itemTitle, type ItemDetailX } from "../api";
import type { ProjectCtx } from "../App";
import { BackLink, Stamp, Thumb, useScreenTitle } from "../ui";

const pulledKey = (pid: string) => `yukari.pulled.${pid}`;
function loadPulled(pid: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(pulledKey(pid)) ?? "[]");
  } catch {
    return [];
  }
}

export function Check({ ctx }: { ctx: ProjectCtx }) {
  const { pid, items, project } = ctx;
  const h1 = useScreenTitle("捨てる前の確認", project.title);
  const drops = (items ?? []).filter((i) => i.pile === "drop");
  const waited = drops.filter((i) => i.wait_count > 0);
  const rest = drops.filter((i) => i.wait_count === 0);
  const [names, setNames] = useState<Record<string, string>>({});
  // 抜いた印はこの端末だけに持つ（API に無いため）
  const [pulled, setPulled] = useState<string[]>(() => loadPulled(pid));

  const waitedIds = waited.map((i) => i.id).join(",");
  useEffect(() => {
    // 誰が待ったかは詳細にしか無い。待ったの物だけ取りに行く
    waited.forEach((i) => {
      api<ItemDetailX>(`/api/p/${pid}/items/${i.id}`).then(
        (d) => setNames((n) => ({ ...n, [i.id]: d.waits.map((w) => w.user.display_name).join("、") })),
        () => {},
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, waitedIds]);

  const toggle = (id: string) => {
    const next = pulled.includes(id) ? pulled.filter((x) => x !== id) : [...pulled, id];
    setPulled(next);
    try {
      localStorage.setItem(pulledKey(pid), JSON.stringify(next));
    } catch {
      // 開いている間だけ効く
    }
  };

  return (
    <main className="page">
      <header className="head">
        <BackLink href={`#/p/${pid}`}>つながり</BackLink>
        <h1 className="h-big" ref={h1} tabIndex={-1}>
          捨てる前の確認
        </h1>
        <p className="sub">処分したい {items ? `${drops.length}点` : ""}</p>
      </header>

      {waited.length ? (
        <section className="sec warn" id="waited-drops">
          <h2 className="h-mid warn-title">待ったの付いた物が{waited.length}点あります</h2>
          <p>処分の袋から抜いてください。1人でも待ったを押した物は残します。</p>
          <ul className="check-list">
            {waited.map((i) => (
              <li key={i.id}>
                <a className="rel-thumb-wrap" href={`#/p/${pid}/item/${i.id}`} aria-label={itemTitle(i)}>
                  <Thumb item={i} className="rel-thumb" />
                  <Stamp />
                </a>
                <span className="rel-body">
                  <b>{itemTitle(i)}</b>
                  <span className="note">{names[i.id] ? `${names[i.id]}が待った` : `${i.wait_count}人が待った`}</span>
                </span>
                <label className="check-box">
                  <input type="checkbox" checked={pulled.includes(i.id)} onChange={() => toggle(i.id)} />
                  <span>抜いた</span>
                </label>
              </li>
            ))}
          </ul>
        </section>
      ) : items ? (
        <section className="sec">
          <p>処分したい物に、待ったの付いた物はありません。</p>
        </section>
      ) : null}

      {items ? null : <p className="note pad" role="status">読み込んでいます</p>}
      <section className="sec">
        <h2 className="h-mid">そのまま処分する物{items ? ` ${rest.length}点` : ""}</h2>
        <div className="grid grid-tight">
          {rest.map((i) => (
            <a key={i.id} className="tile" href={`#/p/${pid}/item/${i.id}`} aria-label={itemTitle(i)}>
              <Thumb item={i} />
            </a>
          ))}
        </div>
        <p className="note">抜いた印はこの端末にだけ残ります。</p>
      </section>
    </main>
  );
}
