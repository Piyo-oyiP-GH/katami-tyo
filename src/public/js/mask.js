// 録画モード。名前を「親族A」「人物B」に、読めた文字を■■に置き換える。
// 画面の上の文字だけを置き換える。データは変えない。写真そのものは隠さない。
import { api } from "./util.js";

const KEY = "matta.record";
const HIDE = "■■";
// 読み取りから来ない、画面そのものの文字。語の置き換えを掛けない。「全 12 件」が隠れないように
const CHROME =
  "script,style,button,nav,.chips,.filters,#count,.item-status,.pile-tag,.wait-mark,#wait-status,.legend,.section>h2,.order-note,.capture-top,.shot-status,.pile-name,.fixed-note,.reason-line,.joined-mark";
let on = false;
let pairs = []; // [語, 置き換え]。長い語から順に並べる
let observer = null;

try {
  on = localStorage.getItem(KEY) === "1";
} catch {
  on = false;
}

export const recordOn = () => on;

// 入力欄の文字は画面の置き換えが届かない。録画モードでは点に見せる（style.css の .rec）
const markRoot = () => document.documentElement.classList.toggle("rec", on);
markRoot();

export function setRecord(value) {
  on = value;
  try {
    localStorage.setItem(KEY, value ? "1" : "0");
  } catch {
    // 保存できない端末では、開いている間だけ効く
  }
  markRoot();
  if (on) start();
  else stop();
}

// 画面を描く前に呼ぶ。録画モードでなければ何もしない
export async function refreshTerms(pid) {
  if (!on || !pid) return;
  const { aliases, hidden } = await api(`/api/p/${pid}/record-terms`);
  pairs = [
    ...aliases.map((a) => [a.term, a.alias]),
    ...hidden.map((t) => [t, HIDE]),
  ].sort((a, b) => b[0].length - a[0].length);
  apply(document.body);
}

export function maskString(s) {
  if (!on || !s) return s;
  let out = s;
  for (const [term, rep] of pairs) if (out.includes(term)) out = out.split(term).join(rep);
  return out;
}

function apply(root) {
  if (!on) return;
  const el = root.nodeType === Node.ELEMENT_NODE ? root : root.parentElement;
  if (!el) return;
  const self = el.matches?.("[data-rec]") ? [el] : [];
  for (const node of [...self, ...el.querySelectorAll("[data-rec]")]) {
    const want = node.dataset.rec === "hide" ? HIDE : maskString(node.dataset.rec);
    if (node.textContent !== want) node.textContent = want;
  }
  for (const node of el.querySelectorAll("[data-rec-avatar]")) {
    const alias = maskString(node.dataset.recAvatar);
    const want = alias.slice(-1);
    if (node.textContent !== want) node.textContent = want;
  }
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (parent?.closest(`${CHROME},[data-rec],[data-rec-avatar]`)) continue;
    let want = maskString(n.nodeValue);
    // Claude の文は、写真の字を「」で引用する。行の一部だと語の一致では隠せない
    if (parent?.closest("[data-rec-quotes]")) {
      want = want.replace(/「[^」]*」/g, `「${HIDE}」`).replace(/『[^』]*』/g, `『${HIDE}』`);
    }
    if (want !== n.nodeValue) n.nodeValue = want;
  }
  const title = maskString(document.title);
  if (title !== document.title) document.title = title;
}

function start() {
  if (observer) return;
  observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "characterData") apply(r.target);
      else for (const n of r.addedNodes) apply(n);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

function stop() {
  observer?.disconnect();
  observer = null;
  pairs = [];
}

if (on) start();
