// 画面の共通部品。文字は必ず text ノードで入れる（読み取った文字を HTML として扱わない）。

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k in el && k !== "list") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export class ApiError extends Error {
  constructor(status, code, data = null) {
    super(code);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export async function api(path, { method = "GET", json, body, headers } = {}) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: json !== undefined ? { "content-type": "application/json" } : headers,
    body: json !== undefined ? JSON.stringify(json) : body,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? "unknown", data);
  return data;
}

// サーバの失敗の言葉。無い code は呼ぶ側の文を使う
const ERROR_TEXT = {
  limit_sample: "見本で読める枚数の上限です。この写真を外してください。続きは、自分の片付けで試せます。",
  limit_project: "この片付けの、今日の読み取りの上限です。明日また送れます。",
  limit_ip: "この接続からの、今日の読み取りの上限です。明日また送れます。",
  limit_total: "今日の読み取りの上限です。明日また送れます。",
  limit_guest: "今日はこれ以上、見本を作れません。",
  limit_new_project: "今日はこれ以上、片付けを作れません。",
  reading_stopped: "いま読み取りを止めています。",
  scoped_session: "この端末はリンクで 1 つの片付けにだけ入っています。ここからは使えません。",
  server_not_configured: "サーバの設定が足りません。.dev.vars の SESSION_SECRET を確かめてください。",
  not_jpeg: "この形式の画像は読めません。",
  photo_too_large: "写真が大きすぎて送れません。",
  person_exists: "同じ名前の札があります。",
};
export const errorText = (code) => ERROR_TEXT[code] ?? null;

const SENT_FAILED = "届きませんでした。もう一度押してください。";

// 操作の API 呼び出しを包む。失敗したら必ず画面で伝える。
// 参加者でなくなっていたら、拒否の画面へ移す。成功なら fn の値、失敗なら undefined を返す
export async function act(fn, { onFail } = {}) {
  try {
    return await fn();
  } catch (e) {
    onFail?.(e);
    if (e instanceof ApiError && (e.status === 401 || e.code === "not_member")) {
      window.dispatchEvent(new CustomEvent("matta:denied"));
    } else {
      toast((e instanceof ApiError && errorText(e.code)) || SENT_FAILED, 4000);
    }
    return undefined;
  }
}

// http の住所では navigator.clipboard が使えないので、選択してコピーする形に切り替える
export async function copyText(text) {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 下の方法に切り替える
    }
  }
  const area = h("textarea", { value: text, readOnly: true, style: "position:fixed;top:0;opacity:0" });
  document.body.append(area);
  area.focus();
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

// 画面が見えている間だけ、決まった間隔で動かす
export function poll(fn, ms) {
  let timer = null;
  let stopped = false;
  const tick = async () => {
    timer = null;
    if (stopped || document.visibilityState !== "visible") return;
    try {
      await fn();
    } catch {
      // 通信が切れても次の回で取り直す
    }
    if (!stopped && document.visibilityState === "visible") timer = setTimeout(tick, ms);
  };
  const onVisible = () => {
    if (document.visibilityState === "visible" && timer === null) tick();
    else if (document.visibilityState !== "visible" && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  document.addEventListener("visibilitychange", onVisible);
  timer = setTimeout(tick, ms);
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

export function toast(text, ms = 2500) {
  const box = document.getElementById("toast");
  box.replaceChildren(h("span", {}, text));
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => box.replaceChildren(), ms);
}

// 文字を 1 つ聞く小さな窓。取り消しなら null を返す。allowEmpty なら空の保存を "" で返す
export function askText({
  title,
  label,
  value = "",
  ok = "保存する",
  multiline = false,
  extra = null,
  allowEmpty = false,
}) {
  const dialog = document.getElementById("ask");
  return new Promise((resolve) => {
    const input = multiline
      ? h("textarea", { id: "ask-input", value })
      : h("input", { id: "ask-input", value, autocomplete: "off" });
    const close = (result) => {
      dialog.close();
      resolve(result);
    };
    dialog.replaceChildren(
      h(
        "form",
        {
          class: "stack",
          onsubmit: (e) => {
            e.preventDefault();
            const v = input.value.trim();
            if (v || allowEmpty) close(v);
          },
        },
        h("h2", {}, title),
        extra,
        h("label", { htmlFor: "ask-input" }, label),
        input,
        h(
          "div",
          { class: "row" },
          h("button", { class: "btn", type: "button", onclick: () => close(null) }, "やめる"),
          h("button", { class: "btn primary", type: "submit" }, ok),
        ),
      ),
    );
    dialog.showModal();
    input.focus();
  });
}

// 選択肢を 1 つ聞く小さな窓。取り消しなら null を返す
export function askChoice({ title, label, options, ok = "決める" }) {
  const dialog = document.getElementById("ask");
  return new Promise((resolve) => {
    const select = h(
      "select",
      { id: "ask-choice" },
      options.map(([value, name]) => h("option", { value }, name)),
    );
    const close = (result) => {
      dialog.close();
      resolve(result);
    };
    dialog.replaceChildren(
      h(
        "form",
        {
          class: "stack",
          onsubmit: (e) => {
            e.preventDefault();
            close(select.value);
          },
        },
        h("h2", {}, title),
        h("label", { htmlFor: "ask-choice" }, label),
        select,
        h(
          "div",
          { class: "row" },
          h("button", { class: "btn", type: "button", onclick: () => close(null) }, "やめる"),
          h("button", { class: "btn primary", type: "submit" }, ok),
        ),
      ),
    );
    dialog.showModal();
  });
}

export const PILE_NAMES = { keep: "いる", drop: "いらない", unsure: "迷う" };
export const LEVEL_NAMES = { high: "はっきり", mid: "一部あやしい", low: "読みにくい" };
export const STRENGTH_NAMES = { weak: "弱", mid: "中", strong: "強め" };
// 強さの数え方を見せる。見えた物は、あるときだけ出す
export const evidenceCounts = (c) =>
  `はっきり ${c.clear_item_ids.length} 個${c.seen_item_ids.length ? `、見えた物 ${c.seen_item_ids.length} 個` : ""}`;
export const SOURCE_NAMES = {
  text: "文字で一致",
  name: "物名で一致",
  synonym: "類義語で一致",
  inference: "見立てで一致",
};
export const SUBTYPE_NAMES = {
  owner: "持ち主",
  relative: "親族",
  friend: "友人や知人",
  vague: "はっきりしない人",
};

export const itemTitle = (item) => item.title ?? item.kind ?? `物 ${item.seq}`;

export function thumbImg(item, cls) {
  const img = h("img", {
    class: cls,
    src: item.thumb_url,
    alt: "",
    loading: "lazy",
    onerror: () => {
      // 縮小画像がまだ無いときは写真を出す
      if (img.src.endsWith("/thumb")) img.src = item.photo_url ?? item.thumb_url.replace(/thumb$/, "photo");
    },
  });
  return img;
}
