// 撮った写真を手元に持ち、5 秒の取り消しの後に送る。
// 送れなかった写真は IndexedDB に残し、つながったら送り直す。ページを閉じても消えない。
import { prepare } from "./image.js";

export const UNDO_MS = 5000;
const RETRY_MS = 5000;
const DB = "matta-uploads";
const STORE = "pending";

const entries = new Map(); // cid → entry
const listeners = new Set();
let sending = false;
let retryTimer = null;

export const onChange = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const emit = () => listeners.forEach((fn) => fn());

// ---- IndexedDB。使えない端末では、開いている間だけ手元に持つ ----
let dbPromise = null;
function db() {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "cid" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}
async function tx(mode, fn) {
  const d = await db();
  if (!d) return null;
  return new Promise((resolve) => {
    try {
      const req = fn(d.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
const save = (e) =>
  tx("readwrite", (s) =>
    s.put({
      cid: e.cid,
      pid: e.pid,
      pile: e.pile,
      blob: e.blob,
      thumb: e.thumb,
      ceiling: e.ceiling,
      ready: e.ready,
      createdAt: e.createdAt,
    }),
  );
const drop = (cid) => tx("readwrite", (s) => s.delete(cid));

// 前に送れなかった写真を読み込む
export async function restore() {
  const rows = (await tx("readonly", (s) => s.getAll())) ?? [];
  for (const r of rows) {
    if (entries.has(r.cid)) continue;
    const e = { ...r, state: "wait", url: URL.createObjectURL(r.blob), item: null, seconds: null, error: null };
    entries.set(e.cid, e);
    if (!e.ready) ready(e);
  }
  if (rows.length) {
    emit();
    pump();
  }
}

async function ready(e) {
  try {
    const out = await prepare(e.blob);
    e.blob = out.photo;
    e.thumb = out.thumb;
    e.ceiling = out.ceiling;
    e.stats = out.stats;
  } catch {
    // 端末で読めない画像は、そのまま送る。上限は控えめにする
    e.ceiling = "mid";
  }
  e.ready = true;
  if (e.state === "undone") return;
  await save(e);
  emit();
  pump();
}

// crypto.randomUUID は https か localhost でしか使えない。同じ Wi-Fi の http でも撮れるようにする
const newCid = () =>
  crypto.randomUUID?.() ??
  [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

export function add(pid, pile, blob) {
  const e = {
    cid: newCid(),
    pid,
    pile,
    blob,
    thumb: null,
    ceiling: "high",
    ready: false,
    createdAt: Date.now(),
    state: "hold",
    holdUntil: Date.now() + UNDO_MS,
    url: URL.createObjectURL(blob),
    item: null,
    seconds: null,
    error: null,
  };
  entries.set(e.cid, e);
  save(e);
  ready(e);
  e.timer = setTimeout(() => {
    if (e.state !== "hold") return;
    e.state = "wait";
    emit();
    pump();
  }, UNDO_MS);
  emit();
  return e;
}

export function undo(cid) {
  const e = entries.get(cid);
  if (!e || e.state !== "hold") return false;
  clearTimeout(e.timer);
  e.state = "undone";
  entries.delete(cid);
  URL.revokeObjectURL(e.url);
  drop(cid);
  emit();
  return true;
}

// 送れないと決まった写真を、手元から外す
export function discard(cid) {
  const e = entries.get(cid);
  if (!e || e.state !== "rejected") return;
  entries.delete(cid);
  URL.revokeObjectURL(e.url);
  drop(cid);
  emit();
}

// 送り直しても同じ結果になる物。見本の上限は日が変わっても戻らない
export const canResend = (e) =>
  e.error !== "not_jpeg" && e.error !== "photo_too_large" && e.error !== "limit_sample";

export const list = (pid) =>
  [...entries.values()].filter((e) => e.pid === pid).sort((a, b) => b.createdAt - a.createdAt);

export function retryNow() {
  for (const e of entries.values()) {
    if (e.state === "rejected" && canResend(e)) {
      e.state = "wait";
      e.error = null;
    }
  }
  emit();
  pump();
}

async function send(e) {
  e.state = "sending";
  emit();
  const started = performance.now();
  const q = new URLSearchParams({ pile: e.pile, ceiling: e.ceiling, cid: e.cid });
  const res = await fetch(`/api/p/${e.pid}/items?${q}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "image/jpeg" },
    body: e.blob,
  });
  if (!res.ok) {
    const code = (await res.json().catch(() => null))?.error ?? "unknown";
    const err = new Error(code);
    err.status = res.status;
    throw err;
  }
  const { item } = await res.json();
  e.seconds = (performance.now() - started) / 1000;
  e.item = item;
  e.state = "sent";
  await drop(e.cid);
  if (e.thumb) {
    fetch(`/api/p/${e.pid}/items/${item.id}/thumb`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "image/jpeg" },
      body: e.thumb,
    }).catch(() => {}); // 無くても写真で代わりが利く
  }
  emit();
}

async function pump() {
  if (sending) return;
  sending = true;
  try {
    for (;;) {
      const next = [...entries.values()]
        .filter((e) => e.state === "wait" && e.ready)
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!next) break;
      try {
        await send(next);
      } catch (err) {
        // 上限や止めるスイッチは、自動で送り直しても通らない。写真は端末に残し、人に知らせる
        const fatal = (err.status >= 400 && err.status < 500) || err.message === "reading_stopped";
        next.state = fatal ? "rejected" : "wait";
        next.error = err.status ? err.message : "offline";
        emit();
        if (!fatal) {
          clearTimeout(retryTimer);
          retryTimer = setTimeout(pump, RETRY_MS);
          break;
        }
      }
    }
  } finally {
    sending = false;
  }
}

window.addEventListener("online", () => pump());
