// 撮影。3 つのボタンのどれかを押すと、撮影と仕分けが同時に済む。
import { refreshTerms } from "./mask.js";
import * as up from "./uploader.js";
import { PILE_NAMES, act, api, errorText, h, itemTitle, poll } from "./util.js";

const NATIVE_KEY = "matta.nativeCamera";
const STATE_TEXT = {
  hold: "取り消せます",
  wait: "送信待ち",
  sending: "送信中",
  rejected: "送れませんでした",
};

async function openCamera(video) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 4096 },
      height: { ideal: 3072 },
    },
  });
  video.srcObject = stream;
  await video.play();
  return stream;
}

// 原寸の 1 枚を取る。ImageCapture があれば写真の解像度で撮れる
async function grab(video, stream) {
  const track = stream.getVideoTracks()[0];
  if (typeof ImageCapture !== "undefined" && track) {
    try {
      return await new ImageCapture(track).takePhoto();
    } catch {
      // 下の方法に切り替える
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
}

function preferNative() {
  try {
    return localStorage.getItem(NATIVE_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberNative(value) {
  try {
    localStorage.setItem(NATIVE_KEY, value ? "1" : "0");
  } catch {
    // 保存できない端末では、開いている間だけ効く
  }
}

export function captureView({ pid, project, me }, root) {
  let stream = null;
  let busy = false;
  let wantPile = null;
  let leaving = false;
  const server = new Map(); // item.id → 最新の状態

  const video = h("video", { muted: true, playsInline: true, autoplay: true });
  video.setAttribute("playsinline", "");
  const finder = h("div", { class: "viewfinder" });
  const strip = h("div", { class: "strip", id: "strip" });
  const counter = h("span", {});
  const undoBox = h("div", { class: "undo-slot" });
  const native = h("input", {
    id: "native-camera",
    type: "file",
    accept: "image/*",
    capture: "environment",
    hidden: true,
    onchange: () => {
      const file = native.files[0];
      native.value = "";
      if (file && wantPile) up.add(pid, wantPile, file);
    },
  });

  const canLive = window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
  const useNative = (text) => {
    finder.replaceChildren(h("p", { class: "hint", id: "native-hint" }, text));
  };

  function startLive() {
    finder.replaceChildren(video);
    openCamera(video)
      .then((s) => {
        if (leaving || preferNative()) s.getTracks().forEach((t) => t.stop());
        else stream = s;
      })
      .catch(() => useNative("カメラを画面の中で開けません。ボタンを押すと、標準のカメラが開きます。"));
  }

  function stopLive() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  // 画面の中のカメラで文字が読めないときに、標準のカメラへ切り替える
  const switcher = h(
    "button",
    {
      class: "camera-switch",
      id: "camera-switch",
      hidden: !canLive,
      onclick: () => {
        const toNative = !preferNative();
        rememberNative(toNative);
        switcher.textContent = toNative ? "画面の中で撮る" : "標準のカメラで撮る";
        if (toNative) {
          stopLive();
          useNative("ボタンを押すと、標準のカメラが開きます。撮ると、押した山に入ります。");
        } else startLive();
      },
    },
    preferNative() ? "画面の中で撮る" : "標準のカメラで撮る",
  );

  const flash = () => {
    finder.classList.add("flash");
    setTimeout(() => finder.classList.remove("flash"), 90);
  };

  async function press(pile) {
    if (busy) return;
    if (!stream) {
      wantPile = pile;
      native.click();
      return;
    }
    busy = true;
    flash();
    try {
      const blob = await grab(video, stream);
      if (blob) up.add(pid, pile, blob);
    } finally {
      busy = false;
    }
  }

  function renderStrip() {
    const all = up.list(pid);
    const shots = all.slice(0, 12);
    counter.textContent = all.length ? `この回 ${all.length} 枚` : "";
    strip.replaceChildren(
      ...shots.map((e) => {
        const item = e.item ? (server.get(e.item.id) ?? e.item) : null;
        let status = STATE_TEXT[e.state] ?? "";
        const extra = [];
        if (e.state === "sent") {
          if (item.status === "done") status = "読み取りました";
          else if (item.status === "failed") status = "読めませんでした";
          else status = "読み取り中";
        }
        if (e.state === "hold") {
          extra.push(h("button", { onclick: () => up.undo(e.cid) }, "取り消す"));
        }
        if (e.state === "rejected") {
          status = errorText(e.error) ?? status;
          if (up.canResend(e)) extra.push(h("button", { onclick: () => up.retryNow() }, "もう一度送る"));
          extra.push(h("button", { class: "discard", onclick: () => up.discard(e.cid) }, "この写真を外す"));
        }
        if (e.state === "wait" && e.error === "offline") status = "通信待ち。写真は残っています";
        if (item?.stale) status = "読み取りが止まっています";
        if (item?.can_retry) {
          extra.push(
            h(
              "button",
              {
                onclick: async () => {
                  const res = await act(() => api(`/api/p/${pid}/items/${item.id}/retry`, { method: "POST" }));
                  if (!res) return;
                  server.set(res.item.id, res.item);
                  renderStrip();
                },
              },
              "もう一度読む",
            ),
          );
        }
        const done = item?.status === "done";
        return h(
          "div",
          { class: "shot", "data-state": item?.status ?? e.state },
          h("img", { src: e.url, alt: "" }),
          h("div", { class: "pile-name" }, PILE_NAMES[e.pile]),
          done && item.title
            ? h("div", { "data-rec": item.kind ?? "hide" }, itemTitle(item))
            : null,
          h("div", { class: "shot-status" }, status),
          e.seconds !== null ? h("div", {}, `送信 ${e.seconds.toFixed(1)} 秒`) : null,
          extra,
        );
      }),
    );
    renderUndo();
  }

  function renderUndo() {
    const held = up.list(pid).find((e) => e.state === "hold");
    if (!held) {
      undoBox.replaceChildren();
      return;
    }
    const left = Math.max(1, Math.ceil((held.holdUntil - Date.now()) / 1000));
    undoBox.replaceChildren(
      h(
        "div",
        { class: "undo-bar", id: "undo-bar" },
        h("span", {}, `${PILE_NAMES[held.pile]}（あと ${left} 秒）`),
        h("button", { id: "undo", onclick: () => up.undo(held.cid) }, "取り消す"),
      ),
    );
  }

  const unsubscribe = up.onChange(renderStrip);
  const clock = setInterval(renderUndo, 500);
  const stopPoll = poll(async () => {
    if (!up.list(pid).some((e) => e.state === "sent" && server.get(e.item.id)?.status !== "done")) return;
    await refreshTerms(pid);
    const { items } = await api(`/api/p/${pid}/items`);
    for (const it of items) server.set(it.id, it);
    renderStrip();
  }, 3000);

  root.replaceChildren(
    h(
      "div",
      { class: "capture" },
      h(
        "div",
        { class: "capture-head" },
        h(
          "div",
          { class: "capture-top" },
          h("a", { href: `#/p/${pid}/list` }, "一覧へ"),
          switcher,
          counter,
        ),
        project.is_sample
          ? h(
              "p",
              { class: "capture-note", id: "sample-cost" },
              `見本の中で撮ると、本物の Claude を呼びます。1 枚ごとに料金がかかります。読めるのは ${me.limits.sample_photos} 枚までです。`,
            )
          : null,
      ),
      finder,
      strip,
      undoBox,
      h(
        "div",
        { class: "pile-buttons" },
        ...Object.entries(PILE_NAMES).map(([pile, name]) =>
          h("button", { class: pile, id: `pile-${pile}`, onclick: () => press(pile) }, name),
        ),
      ),
      native,
    ),
  );
  renderStrip();

  if (canLive && !preferNative()) startLive();
  else {
    useNative("ボタンを押すと、標準のカメラが開きます。撮ると、押した山に入ります。");
  }

  return () => {
    leaving = true;
    stopLive();
    unsubscribe();
    clearInterval(clock);
    stopPoll();
  };
}
