// 仕分け先（任意のサブ機能）。
// 伝えること：「先に置き場を決めると、仕分けの手が止まらない。使わなくてもよい」（置き場はまだ物に記録しない）
// API に置き場が無いので、この端末にだけ持つ。撮る画面の「置き場」の欄で選べる
import { useState } from "react";
import { PILES, PILE_NAMES } from "../api";
import type { ProjectCtx } from "../App";
import { BackLink, loadPlaces, savePlaces, useScreenTitle, type Place } from "../ui";

function Illustration() {
  // 3 つの箱と人。残す、保留、処分の場所を先に作る絵
  return (
    <svg viewBox="0 0 300 200" className="illus-svg" role="img" aria-label="残す、迷う、処分の3つの置き場を先に作る絵">
      <g fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="150" cy="30" r="15" />
        <path d="M150 45v32M150 56l-24 15M150 56l24 15" />
        {[20, 115, 210].map((x) => (
          <g key={x}>
            <rect x={x} y="110" width="70" height="60" />
            <path d={`M${x} 110l10-18h50l10 18`} />
          </g>
        ))}
      </g>
      <rect x="38" y="132" width="34" height="14" className="illus-keep" />
      <rect x="133" y="132" width="34" height="14" className="illus-unsure" />
      <rect x="228" y="132" width="34" height="14" className="illus-drop" />
      <text x="55" y="194" textAnchor="middle" className="illus-text">残す</text>
      <text x="150" y="194" textAnchor="middle" className="illus-text">迷う</text>
      <text x="245" y="194" textAnchor="middle" className="illus-text">処分</text>
    </svg>
  );
}

export function Places({ ctx, back }: { ctx: ProjectCtx; back?: string | null }) {
  const titleRef = useScreenTitle("仕分け先", ctx.project.title);
  const { pid } = ctx;
  const [places, setPlaces] = useState<Place[]>(() => loadPlaces(pid));
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [pile, setPile] = useState<Place["pile"]>("unsure");

  const update = (next: Place[]) => {
    setPlaces(next);
    savePlaces(pid, next);
  };

  return (
    <main className="page">
      <header className="head">
        <BackLink href={back === "capture" ? `#/p/${pid}/capture` : `#/p/${pid}`}>{back === "capture" ? "撮る" : "つながり"}</BackLink>
        <h1 className="h-big" ref={titleRef} tabIndex={-1}>仕分け先</h1>
        <p className="sub">使わなくても、YukariNote は使えます</p>
      </header>
      <div className="illus">
        <Illustration />
      </div>
      <section className="sec">
        <h2 className="h-mid">先に仕分け置き場を作るやり方</h2>
        <p className="note">残したい、迷う、処分したいの場所を先に決めておくと、仕分けの手が止まりません。</p>
      </section>

      <ul className="place-list" id="places">
        {places.map((p) => (
          <li key={p.id} className="place-row">
            <span className={`sq sq-${p.pile}`} aria-hidden="true" />
            <b>{p.name}</b>
            <span className="note">{PILE_NAMES[p.pile]}</span>
            <button className="text-btn" onClick={() => update(places.filter((x) => x.id !== p.id))} aria-label={`${p.name}を消す`}>
              消す
            </button>
          </li>
        ))}
      </ul>

      {adding ? (
        <form
          className="sec"
          onSubmit={(e) => {
            e.preventDefault();
            const n = name.trim();
            if (!n) return;
            update([...places, { id: crypto.getRandomValues(new Uint32Array(2)).join("-"), name: n, pile }]);
            setName("");
            setAdding(false);
          }}
        >
          <label htmlFor="place-name">置き場の名前（例：保留の箱、処分の袋1）</label>
          <input id="place-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          <fieldset className="pile-pick">
            <legend>入れる物</legend>
            {PILES.map((p) => (
              <button type="button" key={p} className={`pick pick-${p}`} aria-pressed={pile === p} onClick={() => setPile(p)}>
                {PILE_NAMES[p]}
              </button>
            ))}
          </fieldset>
          <div className="row-2">
            <button type="button" className="btn" onClick={() => setAdding(false)}>
              やめる
            </button>
            <button type="submit" className="btn btn-primary">
              足す
            </button>
          </div>
        </form>
      ) : (
        <button className="add" id="add-place" onClick={() => setAdding(true)}>
          置き場を足す
        </button>
      )}
      <p className="note pad">置き場はこの端末にだけ残ります。まだ親族とは共有されません。</p>
    </main>
  );
}
