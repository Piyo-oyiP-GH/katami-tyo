// モノ詳細。写真、関係図、読めた／見えた／見立て、待った。
import { recordOn, refreshTerms } from "./mask.js";
import {
  LEVEL_NAMES,
  PILE_NAMES,
  STRENGTH_NAMES,
  evidenceCounts,
  act,
  api,
  askChoice,
  askText,
  h,
  itemTitle,
  poll,
  thumbImg,
  toast,
} from "./util.js";

const POLL_MS = 3000;
const ERRORS = {
  refused: "この写真は読めませんでした。",
  truncated: "文字が多く、途中までしか読めませんでした。",
  photo_missing: "写真が見つかりません。",
  retry_exhausted: "何度か試しましたが、読めませんでした。",
  reading_stopped: "読み取りを止めていたので、読めませんでした。",
  observe_refused: "物の観察ができませんでした。",
  observe_truncated: "物の観察が途中で切れました。",
  observe_api_error: "物の観察ができませんでした。",
  read_refused: "文字を読めませんでした。物の観察だけ残しています。",
  read_truncated: "文字が多く、読み切れませんでした。物の観察だけ残しています。",
  read_api_error: "文字を読めませんでした。物の観察だけ残しています。",
  read_unknown: "文字を読めませんでした。物の観察だけ残しています。",
};

// Claude の文が、訂正された元の読みを引用しているか
function quotesOldReading(text, fixes) {
  const all = Object.values(fixes);
  const old = all.flatMap((f) => (f.original ? [f.original] : []));
  const fresh = all.map((f) => f.text);
  return [...text.matchAll(/「([^」]+)」|『([^』]+)』/g)].some((m) => {
    const q = m[1] ?? m[2];
    return old.some((o) => o.includes(q)) && !fresh.some((f) => f.includes(q));
  });
}

function avatar(name) {
  return h("span", { class: "avatar", "data-rec-avatar": name }, name.slice(0, 1));
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, v);
  el.append(...children.flat().filter((c) => c !== null && c !== undefined));
  return el;
}

const clipLabel = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// 関係図の絵。動かない SVG。左がこの物、真ん中が人、右が関連する物。
// 実線＝読めた名前、吹き出し＝家族が書いた、点線＝Claude の仮説
function relationSvg(pid, groups, rel, iid) {
  const ROW = 76;
  const NODE_H = 44;
  const W = 340;
  const H = Math.max(groups.length * ROW, ROW);
  const midY = H / 2;
  const itemW = 64;
  const personX = 124;
  const personW = 120;
  const parts = [];

  groups.forEach((list, i) => {
    const y = i * ROW + ROW / 2;
    const has = (s) => list.some((c) => c.source === s);
    // 点線はこの物が根拠の仮説だけ。別の物が根拠の仮説で、この物から線を引かない
    const drawn = (s) => list.some((c) => c.source === s && (s !== "claude" || c.item_ids.includes(iid)));
    const edge = (dy, cls) =>
      svg("line", { x1: itemW, y1: midY + dy, x2: personX, y2: y + dy, class: cls });
    // 種類ごとに少しずらして、3 本が重ならないようにする
    const kinds = [["photo", "rs-solid"], ["family", "rs-family"], ["claude", "rs-dotted"]].filter(([s]) => drawn(s));
    kinds.forEach(([, cls], k) => parts.push(edge((k - (kinds.length - 1) / 2) * 7, cls)));
    const label = list[0].person_label;
    const joined = list[0].linked_name;
    parts.push(
      svg("rect", { x: personX, y: y - NODE_H / 2, width: personW, height: NODE_H, rx: 2, class: `rs-person${joined ? " joined" : ""}` }),
      svg(
        "text",
        { x: personX + personW / 2, y: joined ? y - 3 : y + 6, "text-anchor": "middle", class: "rs-label", "data-rec": label },
        clipLabel(label, 7),
      ),
      joined
        ? svg("text", { x: personX + personW / 2, y: y + 15, "text-anchor": "middle", class: "rs-joined" }, "● 参加中")
        : null,
    );
    if (has("family")) {
      // 札の左上の角に載せる。線を隠さず、行どうしでも重ならない
      const bx = personX - 14;
      const by = y - 36;
      parts.push(
        svg(
          "g",
          { class: "rs-bubble", "data-kind": "family" },
          svg("path", {
            d: `M${bx + 6} ${by}h28a6 6 0 0 1 6 6v12a6 6 0 0 1-6 6h-16l-8 7v-7h-4a6 6 0 0 1-6-6v-12a6 6 0 0 1 6-6z`,
          }),
          svg("text", { x: bx + 20, y: by + 18, "text-anchor": "middle" }, "メモ"),
        ),
      );
    }
    const others = [...new Set(list.flatMap((c) => c.item_ids))]
      .map((id) => rel.get(id))
      .filter(Boolean)
      .slice(0, 2);
    others.forEach((r, k) => {
      const x = 250 + k * 46;
      parts.push(
        svg(
          "a",
          { href: `#/p/${pid}/item/${r.id}`, "aria-label": itemTitle(r), class: "rs-link" },
          svg("rect", { x, y: y - 22, width: 44, height: 44, rx: 4, class: "rs-thumb" }),
          svg("image", {
            href: r.thumb_url,
            x,
            y: y - 22,
            width: 44,
            height: 44,
            preserveAspectRatio: "xMidYMid slice",
          }),
        ),
      );
    });
  });

  return svg(
    "svg",
    {
      id: "relsvg",
      class: "relsvg",
      viewBox: `0 0 ${W} ${H}`,
      role: "group",
      "aria-label": "この物と人のつながりの図",
    },
    parts,
    svg("rect", { x: 0, y: midY - 26, width: itemW, height: 52, rx: 8, class: "rs-item" }),
    svg("text", { x: itemW / 2, y: midY + 6, "text-anchor": "middle", class: "rs-item-label" }, "この物"),
  );
}

function strengthLine(c) {
  const head = `関連する物 ${c.item_ids.length} 個（${evidenceCounts(c)}）`;
  return c.strength ? `${head}　強さ：${STRENGTH_NAMES[c.strength]}` : `${head}　強さは付いていません`;
}

function claimHead(c, iid) {
  if (c.source !== "claude" || c.item_ids.includes(iid)) return null;
  return h("p", { class: "sub fixed-note about-person" }, "この人についての仮説（別の物が根拠です）");
}

function relationMap(pid, data) {
  const { claims, related } = data;
  const iid = data.item.id;
  if (!claims.length) {
    return h("p", { class: "note" }, "この物につながる人は、まだ見つかっていません。");
  }
  const groups = new Map();
  for (const c of claims) {
    groups.set(c.person_id, [...(groups.get(c.person_id) ?? []), c]);
  }
  const rel = new Map(related.map((r) => [r.id, r]));
  return h(
    "div",
    {},
    h(
      "div",
      { class: "legend" },
      h("span", {}, "読めた名前"),
      h("span", { class: "l-family" }, "家族が書いた"),
      h("span", { class: "l-claude" }, "Claude の仮説"),
    ),
    relationSvg(pid, [...groups.values()], rel, iid),
    h(
      "div",
      { class: "relmap", id: "relmap" },
      [...groups.values()].map((list) =>
        h(
          "div",
          { class: "person-group" },
          h(
            "div",
            { class: "tag-row" },
            list[0].linked_name
              ? h("span", { class: "avatar small", "data-rec-avatar": list[0].linked_name }, list[0].linked_name.slice(0, 1))
              : null,
            h("span", { class: `tag${list[0].linked_name ? " joined" : ""}` }, list[0].person_label),
            list[0].linked_name ? h("span", { class: "joined-mark" }, "参加中") : null,
          ),
          list.map((c) => {
            const others = c.item_ids.map((id) => rel.get(id)).filter(Boolean);
            return h(
              "div",
              { class: `rel ${c.source}`, "data-source": c.source },
              claimHead(c, iid),
              h("p", c.source === "photo" ? {} : { "data-rec": "hide" }, c.text),
              c.source === "family" && c.author
                ? h("p", { class: "sub" }, `${c.author.display_name}さんが書きました`)
                : null,
              c.source !== "family" ? h("p", { class: "sub" }, strengthLine(c)) : null,
              others.length
                ? h(
                    "div",
                    { class: "related" },
                    others.map((r) =>
                      h(
                        "a",
                        { href: `#/p/${pid}/item/${r.id}`, "aria-label": itemTitle(r) },
                        thumbImg(r),
                      ),
                    ),
                  )
                : null,
            );
          }),
        ),
      ),
    ),
  );
}

export function detailView({ pid, iid, me }, root) {
  const box = h("div", {});
  const waitsBox = h("div", {});
  const bar = h("div", { class: "wait-bar" });
  const base = `/api/p/${pid}/items/${iid}`;
  let data = null;
  let shownKey = null;

  async function correct(line, current) {
    const value = await askText({
      title: line === null ? "物の名前を直す" : "読み取りを直す",
      label: line === null ? "正しい物の名前" : "正しい文字",
      // 録画モードでは、元の文字を入力欄にも出さない
      value: recordOn() ? "" : current,
    });
    if (!value) return;
    const next = await act(() =>
      api(`${base}/correction`, {
        method: "POST",
        json: line === null ? { title: value } : { line, text: value },
      }),
    );
    if (!next) return;
    data = next;
    toast("直しました。家族の訂正を優先します。");
    shownKey = null;
    render();
  }

  // 訂正した名前は写真の根拠にしないので、札に出すかは人が決める
  async function confirmName(line) {
    const res = await act(() => api(`/api/p/${pid}/persons`));
    if (!res) return;
    const choice = await askChoice({
      title: "人物の札にする",
      label: "どの札に結びますか",
      options: [["", "同じ名前の札か、新しい札"], ...res.persons.map((p) => [p.id, p.label])],
    });
    if (choice === null) return;
    const saved = await act(() =>
      api(`/api/p/${pid}/persons/confirm-name`, {
        method: "POST",
        json: { item_id: iid, line, ...(choice ? { person_id: choice } : {}) },
      }),
    );
    if (!saved) return;
    toast("札に結びました。");
    await act(load);
  }

  async function addNote() {
    const res = await act(() => api(`/api/p/${pid}/persons`));
    if (!res) return;
    const { persons } = res;
    if (!persons.length) {
      toast("先に「人」の画面で人物を足してください。");
      return;
    }
    const select = h(
      "select",
      { id: "note-person", "aria-label": "誰についてのメモか" },
      persons.map((p) => h("option", { value: p.id }, p.label)),
    );
    const text = await askText({
      title: "家族のメモを書く",
      label: "この物と人物について知っていること",
      multiline: true,
      ok: "書き足す",
      extra: select,
    });
    if (!text) return;
    const saved = await act(() =>
      api(`/api/p/${pid}/persons/${select.value}/claims`, {
        method: "POST",
        json: { text, item_id: iid },
      }),
    );
    if (saved) await act(load);
  }

  async function setPile(pile) {
    const next = await act(() => api(base, { method: "PATCH", json: { pile } }));
    if (!next) return;
    data = next;
    shownKey = null;
    render();
  }

  async function retry() {
    const res = await act(() => api(`${base}/retry`, { method: "POST" }));
    if (res) await act(load);
  }

  async function editNote() {
    const mine = data.waits.find((w) => w.user.id === me.user.id)?.note ?? "";
    if (mine && recordOn()) {
      toast("録画モードでは、ひとことを直せません。");
      return;
    }
    const note = await askText({
      title: "ひとこと",
      label: "待ったの理由や、ひとこと",
      multiline: true,
      value: mine,
      allowEmpty: true,
    });
    if (note === null) return;
    const res = await act(() => api(`${base}/wait`, { method: "POST", json: { note } }));
    if (res) applyWait(res);
  }

  async function pressWait() {
    const btn = bar.querySelector("#wait-btn");
    const status = bar.querySelector("#wait-status");
    btn.disabled = true;
    const method = data.item.waited_by_me ? "DELETE" : "POST";
    const hadNote = !!data.waits.find((w) => w.user.id === me.user.id)?.note;
    const res = await act(() => api(`${base}/wait`, { method, json: {} }), {
      onFail: () => {
        status.textContent = "届きませんでした。もう一度押してください。";
      },
    });
    btn.disabled = false;
    if (res) applyWait(res);
    if (res && method === "DELETE" && hadNote) toast("待ったを取り消しました。ひとことも消えました。", 4000);
  }

  const retrySection = (text) =>
    h(
      "section",
      { class: "section stack" },
      h("p", { class: "error-text" }, text),
      h("p", {}, "写真は残っています。"),
      data.item.can_retry
        ? h("button", { class: "btn primary wide", id: "retry", onclick: retry }, "もう一度読む")
        : null,
    );

  function renderReading() {
    const { item, reading, correction } = data;
    // checked は A と再読を比べた後の行。level が画面に出す確からしさ
    const lines = reading?.checked ?? reading?.a?.lines ?? [];
    const b = reading?.b;
    const fixes = correction?.lines ?? {};
    const parts = [];
    if (item.status === "failed") {
      parts.push(retrySection(ERRORS[item.error_code] ?? "読み取りに失敗しました。"));
    } else if (item.stale) {
      parts.push(retrySection("読み取りが止まっています。"));
    } else if (item.status !== "done") {
      parts.push(h("section", { class: "section" }, h("p", { id: "reading-now" }, "読み取り中です。")));
    } else if (item.error_code?.startsWith("observe_")) {
      parts.push(retrySection(ERRORS[item.error_code] ?? "物の観察ができませんでした。"));
    } else if (item.error_code?.startsWith("read_")) {
      parts.push(retrySection(ERRORS[item.error_code] ?? "文字を読めませんでした。物の観察だけ残しています。"));
    }
    if (reading) {
      parts.push(
        h(
          "section",
          { class: "section", id: "read-section" },
          h("h2", {}, "読めた文字"),
          item.confidence
            ? h("p", { class: "note" }, `全体：${LEVEL_NAMES[item.confidence]}`)
            : null,
          lines.length
            ? lines.map((l, i) => {
                const fix = fixes[String(i)]?.text;
                return h(
                  "div",
                  { class: "line-row" },
                  h(
                    "div",
                    {},
                    h("div", { class: "read", "data-rec": "hide" }, fix ?? l.text),
                    h(
                      "div",
                      { class: "sub" },
                      fix
                        ? "家族の訂正"
                        : `${l.handwritten ? "手書き" : "印刷"}　${LEVEL_NAMES[l.level ?? l.certainty]}${l.agreement === null ? "（再読なし）" : ""}`,
                    ),
                  ),
                  h(
                    "div",
                    { class: "line-actions" },
                    h(
                      "button",
                      { class: "btn small", onclick: () => correct(i, fix ?? l.text) },
                      "違う",
                    ),
                    fix && l.type === "name"
                      ? h("button", { class: "btn small to-person", onclick: () => confirmName(i) }, "人物の札にする")
                      : null,
                  ),
                );
              })
            : h("p", { class: "note" }, "文字は見つかりませんでした。"),
        ),
      );
    }
    if (b) {
      parts.push(
        h(
          "section",
          { class: "section" },
          h("h2", {}, "見えたもの"),
          h(
            "ul",
            { class: "plain-list" },
            [b.kind, ...b.evidence].map((t) =>
              h(
                "li",
                { "data-rec-quotes": true },
                t,
                quotesOldReading(t, fixes) ? h("span", { class: "note" }, "（訂正前の読みです）") : null,
              ),
            ),
          ),
          b.evidence.length ? null : h("p", { class: "note", id: "no-evidence" }, "見えた根拠は取れませんでした。"),
        ),
        h(
          "section",
          { class: "section" },
          h("h2", {}, "Claude の見立て"),
          h("p", { class: "note" }, "写真から考えたことです。事実とは限りません。"),
          b.inferences.length
            ? h(
                "ul",
                { class: "guess-list" },
                b.inferences.map((t) => h("li", { "data-rec": "hide" }, t)),
              )
            : h("p", { class: "note" }, "見立てはありません。"),
        ),
      );
    }
    return parts;
  }

  function renderWaits() {
    const { item, waits } = data;
    waitsBox.replaceChildren(
      h(
        "section",
        { class: "section" },
        h("h2", {}, "待った"),
        waits.length
          ? h(
              "ul",
              { class: "waits", id: "waits" },
              waits.map((w) =>
                h(
                  "li",
                  {},
                  avatar(w.user.display_name),
                  h(
                    "div",
                    {},
                    h("div", {}, `${w.user.display_name}さんが待ったをかけました`),
                    w.note ? h("div", { class: "note", "data-rec": "hide" }, w.note) : null,
                  ),
                ),
              ),
            )
          : h("p", { class: "note" }, "まだ待ったはありません。"),
        item.waited_by_me
          ? h(
              "button",
              { class: "btn small", id: "wait-note", onclick: editNote },
              waits.find((w) => w.user.id === me.user.id)?.note ? "ひとことを直す" : "ひとこと足す",
            )
          : null,
      ),
    );
    bar.replaceChildren(
      h(
        "div",
        { class: "inner" },
        h(
          "p",
          { class: "status", id: "wait-status" },
          item.wait_count
            ? `待った ${item.wait_count} 人。この物は残します。`
            : "1 人でも待ったをかけると、残します。",
        ),
        h(
          "button",
          {
            class: `wait-btn${item.waited_by_me ? " done" : ""}`,
            id: "wait-btn",
            onclick: pressWait,
          },
          item.waited_by_me ? "待ったを取り消す" : "待った",
        ),
      ),
    );
  }

  function applyWait(res) {
    data.waits = res.waits;
    data.item.wait_count = res.wait_count;
    data.item.waited_by_me = res.waited_by_me;
    renderWaits();
  }

  function render() {
    const { item } = data;
    const key = JSON.stringify([
      item.status,
      item.stale,
      item.can_retry,
      item.chips,
      item.rank_reason,
      item.title,
      item.pile,
      data.reading,
      data.correction,
      data.claims,
    ]);
    if (key !== shownKey) {
      shownKey = key;
      const title = itemTitle(item);
      box.replaceChildren(
        h("a", { class: "back", href: `#/p/${pid}/list` }, "一覧へ戻る"),
        h("img", { class: "photo", src: item.photo_url, alt: "撮った写真" }),
        h("h1", item.title && item.title !== item.kind ? { "data-rec": item.kind ?? "hide" } : {}, title),
        h(
          "div",
          { class: "chips" },
          item.chips.map((c) => h("span", { class: "chip" }, c)),
          item.needs_retake ? h("span", { class: "chip retake" }, "撮り直し候補") : null,
        ),
        item.rank_reason ? h("p", { class: "note reason-line", id: "reason-line" }, item.rank_reason) : null,
        item.title
          ? h("button", { class: "linkish", onclick: () => correct(null, item.title) }, "物の名前を直す")
          : null,
        h(
          "section",
          { class: "section" },
          h("h2", {}, "つながる人"),
          relationMap(pid, data),
          h("button", { class: "btn small", id: "add-note", onclick: addNote }, "家族のメモを書く"),
        ),
        ...renderReading(),
        h(
          "section",
          { class: "section" },
          h("h2", {}, "置いた山"),
          h(
            "div",
            { class: "pile-switch" },
            Object.entries(PILE_NAMES).map(([k, v]) =>
              h(
                "button",
                {
                  class: "filter",
                  "aria-pressed": String(item.pile === k),
                  onclick: () => setPile(k),
                },
                v,
              ),
            ),
          ),
        ),
      );
    }
    renderWaits();
  }

  async function load() {
    await refreshTerms(pid);
    data = await api(base);
    render();
  }

  root.replaceChildren(h("div", { class: "page detail" }, box, waitsBox), bar);
  load().catch((e) => {
    box.replaceChildren(
      h("a", { class: "back", href: `#/p/${pid}/list` }, "一覧へ戻る"),
      h("p", { class: "error-text" }, e.status === 404 ? "この物は見つかりません。" : "読み込めませんでした。"),
    );
  });
  return poll(load, POLL_MS);
}
