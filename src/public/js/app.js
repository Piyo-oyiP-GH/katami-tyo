// 画面の切り替え。パスはすべて # の後ろに置く。招待のトークンをサーバのログに残さないため。
import { captureView } from "./capture.js";
import { detailView } from "./detail.js";
import { listView } from "./list.js";
import { recordOn, refreshTerms } from "./mask.js";
import { peopleView } from "./people.js";
import { restore } from "./uploader.js";
import { ApiError, api, errorText, h, toast } from "./util.js";

const app = document.getElementById("app");
const SAMPLE_KEY = "matta.samples";
let cleanup = null;

// 開いた見本の番号を覚える。期限が切れた後に、招待の案内ではなく正しい案内を出すため
function seenSamples() {
  try {
    return JSON.parse(localStorage.getItem(SAMPLE_KEY) ?? "[]");
  } catch {
    return [];
  }
}
function rememberSample(pid) {
  try {
    const seen = seenSamples();
    if (!seen.includes(pid)) localStorage.setItem(SAMPLE_KEY, JSON.stringify([...seen, pid].slice(-10)));
  } catch {
    // 覚えられない端末では、ふつうの案内を出す
  }
}

function tabbar(pid, current) {
  const tab = (key, name) =>
    h(
      "a",
      {
        href: `#/p/${pid}/${key}`,
        id: `tab-${key}`,
        "aria-current": key === current ? "page" : null,
      },
      name,
    );
  return h("nav", { class: "tabbar", "aria-label": "画面" }, tab("capture", "撮る"), tab("list", "一覧"), tab("people", "人"));
}

function denied(text) {
  app.replaceChildren(
    h(
      "div",
      { class: "page entry stack" },
      h("h1", { style: "font-size:24px" }, "この片付けは開けません"),
      h("p", { id: "denied" }, text),
      h("a", { class: "btn primary wide", href: "#/" }, "入口へ戻る"),
    ),
  );
}

async function attempt(fn) {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ApiError && e.code === "invite_invalid") {
      toast("この招待は使えません。送った人に確かめてください。", 4000);
    } else if (e instanceof ApiError && e.code === "bad_params") {
      toast("入力を確かめてください。");
    } else if (e instanceof ApiError && errorText(e.code)) {
      toast(errorText(e.code), 4000);
    } else {
      toast("通信できませんでした。もう一度押してください。");
    }
  }
}

function tokenFrom(text) {
  const t = text.trim();
  const m = t.match(/#\/join\/([0-9a-f]+)/);
  return m ? m[1] : t;
}

async function entryView() {
  const me = await api("/api/me");
  const live = me.projects;
  const sample = live.find((p) => p.is_sample);
  const inviteInput = h("input", { id: "invite-input", autocomplete: "off" });
  const nameInput = h("input", { id: "new-name", autocomplete: "name", required: !me.user || me.user.is_guest });
  const titleInput = h("input", { id: "new-title", autocomplete: "off", required: true, value: "" });

  app.replaceChildren(
    h(
      "div",
      { class: "page entry" },
      h("div", { class: "seal", "aria-hidden": "true" }, "待った"),
      h("h1", {}, "待った箱"),
      h(
        "p",
        { class: "lead" },
        "片付けの現場で物を撮ると、その場にいない親族も、捨てる前に「待った」をかけられます。",
      ),
      live.length
        ? h(
            "div",
            { class: "resume stack" },
            live.map((p) =>
              h("a", { class: "btn wide", href: `#/p/${p.id}/list` }, `${recordOn() ? "この片付け" : p.title}を開く`),
            ),
          )
        : null,
      me.scoped ? h("p", { class: "note", id: "scoped-note" }, "この端末はリンクで入っています。開けるのは上の片付けだけです。") : null,
      // 見本がすでにあるときは、上の「開く」と同じ動きになるので出さない
      me.scoped || sample
        ? null
        : h(
        "button",
        {
          class: "btn primary wide",
          id: "try-sample",
          onclick: () => {
            attempt(async () => {
              const { project_id } = await api("/api/guest", { method: "POST" });
              location.hash = `#/p/${project_id}/list`;
            });
          },
        },
        "見本で試す",
      ),
      h(
        "details",
        {},
        h("summary", {}, "招待で入る"),
        h(
          "form",
          {
            class: "stack",
            onsubmit: (e) => {
              e.preventDefault();
              const token = tokenFrom(inviteInput.value);
              if (token) location.hash = `#/join/${token}`;
            },
          },
          h("label", { htmlFor: "invite-input" }, "送られてきたリンク"),
          inviteInput,
          h("button", { class: "btn wide", type: "submit" }, "参加する"),
        ),
      ),
      me.scoped
        ? null
        : h(
        "details",
        {},
        h("summary", {}, "新しい片付けを始める"),
        h(
          "form",
          {
            class: "stack",
            id: "new-project",
            onsubmit: async (e) => {
              e.preventDefault();
              await attempt(async () => {
                const res = await api("/api/projects", {
                  method: "POST",
                  json: { display_name: nameInput.value, title: titleInput.value },
                });
                location.hash = `#/p/${res.project_id}/people`;
              });
            },
          },
          !me.user || me.user.is_guest
            ? [h("label", { htmlFor: "new-name" }, "あなたの名前"), nameInput]
            : null,
          h("label", { htmlFor: "new-title" }, "片付けの名前（例：実家の押し入れ）"),
          titleInput,
          h("button", { class: "btn wide", type: "submit" }, "始める"),
        ),
      ),
    ),
  );
}

async function joinView(token) {
  app.replaceChildren(h("div", { class: "page entry" }, h("p", {}, "招待を確かめています。")));
  try {
    const { project_id } = await api("/api/invite", { method: "POST", json: { token } });
    // トークンを履歴に残さない
    history.replaceState(null, "", `#/p/${project_id}/list`);
    route();
  } catch (e) {
    history.replaceState(null, "", "#/join");
    if (e instanceof ApiError && e.code === "invite_other_user") {
      denied("このリンクは別の人のものです。この端末は今の人のままです。自分のリンクを開いてください。");
    } else if (e instanceof ApiError && e.code === "scoped_session") {
      denied("この端末はリンクで別の片付けに入っています。新しい招待は、いつも使っている端末で開いてください。");
    } else {
      denied("この招待は使えません。止められたか、もう使われています。送った人に確かめてください。");
    }
  }
}

async function route() {
  cleanup?.();
  cleanup = null;
  const hash = location.hash.replace(/^#/, "") || "/";
  const join = hash.match(/^\/join\/(.+)$/);
  if (join) return joinView(join[1]);

  const m = hash.match(/^\/p\/([^/]+)\/(capture|list|people|item)(?:\/([^/]+))?$/);
  if (!m) return entryView().catch(() => denied("通信できませんでした。もう一度開いてください。"));

  const [, pid, screen, iid] = m;
  let me;
  try {
    me = await api("/api/me");
  } catch {
    return denied("通信できませんでした。もう一度開いてください。");
  }
  const project = me.projects.find((p) => p.id === pid);
  if (!project) {
    if (seenSamples().includes(pid)) {
      return denied("この見本は 24 時間を過ぎたので消えました。入口の「見本で試す」から、もう一度試せます。");
    }
    return denied(
      me.user
        ? "この片付けの参加者ではありません。招待のリンクを開いてください。"
        : "参加者だけが開けます。招待のリンクを開いてください。",
    );
  }
  if (project.is_sample) rememberSample(pid);
  document.title = `${project.title}｜待った箱`;
  if (recordOn()) await refreshTerms(pid).catch(() => {});

  const ctx = { pid, iid, project, me, rerender: route };
  const body = h("div", {});
  const views = { capture: captureView, list: listView, people: peopleView, item: detailView };
  const nodes = screen === "capture" || screen === "item" ? [body] : [body, tabbar(pid, screen)];
  app.replaceChildren(...nodes);
  cleanup = views[screen](ctx, body);
}

window.addEventListener("hashchange", route);
// 操作の途中で参加者でなくなったら、拒否の画面へ移す
window.addEventListener("matta:denied", route);
restore();
route();
