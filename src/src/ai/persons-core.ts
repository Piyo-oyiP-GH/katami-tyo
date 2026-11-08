// 人物カードの差分の確かめと適用。D1 にも Claude にも触らない。
// Claude は差分を提案するだけ。物の実在、根拠、強さはここで決める。
import type { ItemReading, Level, Observation, PersonSubtype, Strength, TextType } from "../types";
import { normalize, UNKNOWN } from "./confidence";
import { blockedTopic, judges, unsupportedTokens } from "./guard";
import type {
  CheckedLine,
  DiffItem,
  ItemCorrection,
  PersonsApplied,
  PersonsDiff,
  PersonsRejected,
} from "./types";

export const OWNER_LABEL = "持ち主";
export const NAME_CLAIM_TEXT = "物の上に名前が読める";
export { blockedTopic };
const MAX_TEXT = 120;
const HEDGED = /かもしれません[。.]?$/u;

// つながりの根拠。clear＝はっきりの読み、seen＝見えたこと。強さはこの 2 つの合計で決める
export type Evidence = { clear: boolean; seen: boolean };

// ---- 物の事実 ----
export type FactLine = {
  text: string;
  type: TextType;
  handwritten: boolean;
  level: Level;
  family: boolean; // 家族の訂正。Claude には見せるが、根拠にも強さの数にも入れない
};

export type ItemFacts = {
  id: string;
  no: number;
  title: string | null;
  confidence: Level | null;
  lines: FactLine[];
  observed: string[]; // 見えたこと。仮説の根拠に使える
  familyTitle: string | null; // 家族が直した物名。Claude には見せるが、根拠には入れない
  b: Observation | null;
};

export type ItemRow = {
  id: string;
  seq: number;
  title: string | null;
  confidence: Level | null;
  reading_json: string | null;
  correction_json: string | null;
};

function parse<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

// 訂正を重ねた後の、今の読み。訂正された行の元の字は、もう根拠にならない
export function itemFacts(row: ItemRow): ItemFacts {
  const reading = parse<ItemReading & { checked?: CheckedLine[] }>(row.reading_json);
  const fix = parse<ItemCorrection>(row.correction_json);
  const base = reading?.checked ?? reading?.a?.lines.map((l) => ({ ...l, level: l.certainty })) ?? [];
  const lines = base.map((l, i): FactLine => {
    const text = fix?.lines?.[String(i)]?.text;
    return {
      text: text ?? l.text,
      type: l.type,
      handwritten: l.handwritten,
      level: text ? "mid" : l.level,
      family: !!text,
    };
  });
  const b = reading?.b ?? null;
  const title = fix?.title ?? row.title;
  // 家族が直した物名は根拠にしない。元の種類も、直された時点で根拠から外す
  const observed = [...(!fix?.title && b ? [b.kind] : []), ...(b?.evidence ?? [])];
  return {
    id: row.id,
    no: row.seq,
    title,
    confidence: row.confidence,
    lines,
    observed,
    familyTitle: fix?.title ?? null,
    b,
  };
}

// ---- 根拠 ----
const ASCII_ONLY = /^[\x00-\x7f]+$/;

// 引用がその文の中で意味のある塊か。数字や英字は語の全体、ほかは 3 字以上。
// 「品番 12345」の「12」のような、たまたま当たる切れ端を根拠にしない
function meaningfulQuote(text: string, quote: string): boolean {
  const q = normalize(quote);
  const whole = normalize(text);
  if (q === whole) return true;
  if (!whole.includes(q)) return false;
  if (ASCII_ONLY.test(q)) {
    return text
      .normalize("NFKC")
      .split(/[^0-9A-Za-z]+/)
      .some((t) => normalize(t) === q);
  }
  return q.length >= 3;
}

// 引用が今の読みにあるかを見る。読みにくい行は根拠にしない。
// 家族の訂正の行も根拠にしない。写真の読みとして札を作ると、出どころが混ざる。
// 訂正は元の読みを消すことで効く。家族が知る名前は家族のメモで残す。
// はっきりの数は、読みの行の確からしさだけで決める。
// 読みに当たらず見えたことに当たるつながりは、seen として別に数える。
// ただし字の引用を含む見えたことと、読みにくい物の見えたことは数えない。読み違いが混ざるため
const QUOTED = /[「『]/u;
export function support(item: ItemFacts, quote: string): Evidence | null {
  if (normalize(quote).length < 2) return null;
  const hits = item.lines.filter(
    (l) => l.level !== "low" && !l.family && meaningfulQuote(l.text, quote),
  );
  if (hits.length) return { clear: hits.some((l) => l.level === "high"), seen: false };
  const seen = item.observed.filter((o) => meaningfulQuote(o, quote));
  if (!seen.length) return null;
  return { clear: false, seen: item.confidence !== "low" && seen.some((o) => !QUOTED.test(o)) };
}

const stripHonorific = (s: string) => s.trim().replace(/\s*(様|さま|殿|さん|御中|先生)$/u, "").trim();
const nameKey = (s: string) => normalize(stripHonorific(s));

// 「川辺夫妻」「川辺家」の「川辺」。札が家全体を指すときだけ、名字で物に結ぶ余地を残す
const householdStem = (key: string) => key.replace(/(夫妻|夫婦|一家|家)$/u, "");

// 読めた人名の行と札の名前を、字の全体で比べる。
// - 全体が同じなら数える。空白の有無で結果を変えない
// - 札の名前の一部（名字だけなど）しか読めていない行は、つなぐが数えない
// - 字が違えば別の人。田中太郎 と 田中花子 は、2 字が同じでもつなげない。
//   名字だけの札 田中 にも、田中 太郎 と 田中 花子 をつなげない
function nameFit(line: string, label: string): { clear: boolean } | null {
  const key = nameKey(label);
  const whole = nameKey(line);
  if (whole === key) return { clear: true };
  if (whole.length >= 2 && key.includes(whole)) return { clear: false };
  const stem = householdStem(key);
  if (stem !== key && stem.length >= 2 && whole.startsWith(stem)) return { clear: false };
  return null;
}

export type NameRefusal = "no_support" | "bad_label";

// 人名の行の引用が、札の名前と合うかを見る
export function nameSupport(
  item: ItemFacts,
  quote: string,
  label: string,
): Evidence | NameRefusal {
  if (normalize(quote).length < 2 || quote.includes(UNKNOWN)) return "no_support";
  const q = normalize(quote);
  const hits = item.lines.filter(
    (l) => l.level !== "low" && !l.family && l.type === "name" && normalize(l.text).includes(q),
  );
  if (!hits.length) return "no_support";
  const fits = hits.flatMap((l) => {
    const fit = nameFit(l.text, label);
    return fit ? [{ clear: fit.clear && l.level === "high" }] : [];
  });
  if (!fits.length) return "bad_label";
  return { clear: fits.some((f) => f.clear), seen: false };
}

// 1〜2＝弱、3〜9＝中、10 以上＝強め。数える物が 0 なら強さは付けない
export function strengthOf(count: number): Strength | null {
  if (count >= 10) return "strong";
  if (count >= 3) return "mid";
  return count >= 1 ? "weak" : null;
}

// ---- カードの状態 ----
export type CardLink = Evidence & { item_id: string; basis: string | null };
export type Card = {
  id: string;
  person_id: string;
  source: "photo" | "claude" | "family";
  text: string;
  strength: Strength | null;
  links: CardLink[];
  fresh?: boolean; // この回に作った
  superseded?: boolean; // この回に取り下げた
};
export type PersonCard = {
  id: string;
  label: string;
  subtype: PersonSubtype;
  fresh?: boolean;
  readLabel?: string | null; // 家族が名前を直した札の、元の読み。物とのつながりはこの字で確かめる
};
const matchLabel = (p: { label: string; readLabel?: string | null }) => p.readLabel ?? p.label;
export type CardState = { persons: PersonCard[]; cards: Card[] };

// Claude に渡す番号。ID は見せない。family は番号を渡さないので触れない
export function refsOf(state: CardState) {
  const persons = new Map(state.persons.map((p, i) => [`P${i + 1}`, p]));
  const open = state.cards.filter((c) => c.source !== "family");
  const cards = new Map(open.map((c, i) => [`C${i + 1}`, c]));
  return { persons, cards };
}

export const zeroApplied = (): PersonsApplied => ({
  persons: 0,
  names: 0,
  hypotheses: 0,
  updated: 0,
  retired: 0,
});
export const zeroRejected = (): PersonsRejected => ({
  unknown_item: 0,
  unknown_ref: 0,
  no_support: 0,
  bad_label: 0,
  topic: 0,
  banned: 0,
  unsupported: 0,
});

function addLink(card: Card, link: CardLink) {
  const prev = card.links.find((l) => l.item_id === link.item_id);
  if (!prev) card.links.push(link);
  else if ((link.clear && !prev.clear) || (link.seen && !prev.clear && !prev.seen)) Object.assign(prev, link);
}

// state を直接書き換える。itemsByNo は読み終えた物だけを入れて渡す
export function applyDiff(
  state: CardState,
  diff: Partial<PersonsDiff>,
  itemsByNo: Map<number, ItemFacts>,
): { applied: PersonsApplied; rejected: PersonsRejected } {
  const applied = zeroApplied();
  const rejected = zeroRejected();
  const refs = refsOf(state);
  const add = diff.add ?? [];

  const findItem = (no: number) => {
    const item = itemsByNo.get(no);
    if (!item) rejected.unknown_item++;
    return item;
  };

  const nameCard = (person: PersonCard): Card => {
    const found = state.cards.find(
      (c) => c.person_id === person.id && c.source === "photo" && !c.superseded,
    );
    if (found) return found;
    const card: Card = {
      id: crypto.randomUUID(),
      person_id: person.id,
      source: "photo",
      text: NAME_CLAIM_TEXT,
      strength: null,
      links: [],
      fresh: true,
    };
    state.cards.push(card);
    return card;
  };

  // 名前のつながり。根拠は人名の行だけで、札の名前と字の全体が合わなければ退ける
  const nameLinks = (person: PersonCard, cites: DiffItem[]): CardLink[] =>
    cites.flatMap((cite) => {
      const item = findItem(cite.no);
      if (!item) return [];
      const s = nameSupport(item, cite.quote, matchLabel(person));
      if (typeof s === "string") {
        rejected[s]++;
        return [];
      }
      return [{ item_id: item.id, basis: cite.quote, ...s }];
    });

  const namedItems = (person: PersonCard) =>
    new Set(
      state.cards
        .filter((c) => c.person_id === person.id && c.source === "photo" && !c.superseded)
        .flatMap((c) => c.links.map((l) => l.item_id)),
    );

  // 仮説のつながり。名前の札に付けるなら、その名前が読めた物だけに限る
  const hypothesisLinks = (person: PersonCard, cites: DiffItem[]): CardLink[] => {
    const named = person.subtype === "owner" ? null : namedItems(person);
    return cites.flatMap((cite) => {
      const item = findItem(cite.no);
      if (!item) return [];
      const s = support(item, cite.quote);
      if (!s || (named && !named.has(item.id))) {
        rejected.no_support++;
        return [];
      }
      return [{ item_id: item.id, basis: cite.quote, ...s }];
    });
  };

  // 読めている人名と札の名前。仮説の文には、どの物の名前も書かない
  const knownNames = [
    ...[...itemsByNo.values()].flatMap((i) => i.lines.filter((l) => l.type === "name").map((l) => l.text)),
    ...state.persons.filter((p) => p.subtype !== "owner").map((p) => p.label),
  ]
    .flatMap((n) => [n, ...n.normalize("NFKC").split(/\s+/)])
    .map(nameKey)
    .filter((n) => n.length >= 2);

  // 文の検査。通れば整えた文を返す
  const okText = (raw: string, cited: CardLink[]): string | null => {
    const text = raw.trim().slice(0, MAX_TEXT);
    if (!text) return null;
    if (blockedTopic(text)) {
      rejected.topic++;
      return null;
    }
    if (judges(text)) {
      rejected.banned++;
      return null;
    }
    const ids = new Set(cited.map((l) => l.item_id));
    const read = normalize(
      [...itemsByNo.values()]
        .filter((i) => ids.has(i.id))
        .flatMap((i) => [...i.lines.map((l) => l.text), ...i.observed])
        .join("\n"),
    );
    const flat = normalize(text);
    if (
      !HEDGED.test(text) ||
      knownNames.some((n) => flat.includes(n)) ||
      unsupportedTokens(text, [], read).length
    ) {
      rejected.unsupported++;
      return null;
    }
    return text;
  };

  const newPerson = (rawLabel: string, cites: DiffItem[]): PersonCard | null => {
    const label = stripHonorific(rawLabel).slice(0, 40);
    const key = normalize(label);
    if (key.length < 2 || label.includes(UNKNOWN)) {
      rejected.bad_label++;
      return null;
    }
    const same = state.persons.find((p) => normalize(p.label) === key || normalize(matchLabel(p)) === key);
    if (same) return same;
    // 1 つの読み違いで札が増えないよう、名前は人名の行に実際にある字に限る
    const backed = cites.some((c) => {
      const item = itemsByNo.get(c.no);
      return item ? typeof nameSupport(item, label, label) !== "string" : false;
    });
    if (!backed) {
      rejected.bad_label++;
      return null;
    }
    const person: PersonCard = {
      id: crypto.randomUUID(),
      label,
      subtype: "vague", // 友人や持ち主と決めるのは人間関係の推測になるので、家族に任せる
      fresh: true,
    };
    state.persons.push(person);
    applied.persons++;
    return person;
  };

  const resolve = (op: { person: string; new_label: string; items: DiffItem[] }) => {
    if (op.person === "NEW") return newPerson(op.new_label, op.items);
    const person = refs.persons.get(op.person);
    if (!person) rejected.unknown_ref++;
    return person ?? null;
  };

  // 先に名前。仮説は、この回に足した名前のつながりも見て確かめる
  for (const op of add.filter((a) => a.kind === "name")) {
    const person = resolve(op);
    if (!person) continue;
    const links = nameLinks(person, op.items);
    if (!links.length) continue;
    const card = nameCard(person);
    for (const link of links) addLink(card, link);
    applied.names += links.length;
  }

  for (const op of diff.update ?? []) {
    const card = refs.cards.get(op.claim);
    if (!card || card.superseded) {
      rejected.unknown_ref++;
      continue;
    }
    const person = state.persons.find((p) => p.id === card.person_id)!;
    const gone = new Set(
      op.remove_nos.flatMap((no) => {
        const item = findItem(no);
        return item ? [item.id] : [];
      }),
    );
    const fresh =
      card.source === "photo" ? nameLinks(person, op.add_items) : hypothesisLinks(person, op.add_items);
    const before = JSON.stringify(card.links);
    card.links = card.links.filter((l) => !gone.has(l.item_id));
    for (const link of fresh) addLink(card, link);

    // 文が変わるときは、古い行を残して新しい行にする
    const wanted = op.text.trim();
    if (card.source === "claude" && wanted && wanted !== card.text) {
      const text = okText(wanted, card.links);
      if (text) {
        card.superseded = true;
        state.cards.push({ ...card, id: crypto.randomUUID(), text, fresh: true, superseded: false });
        applied.updated++;
        continue;
      }
    }
    if (JSON.stringify(card.links) !== before) applied.updated++;
  }

  for (const op of diff.retire ?? []) {
    const card = refs.cards.get(op.claim);
    if (!card || card.superseded) {
      rejected.unknown_ref++;
      continue;
    }
    card.superseded = true;
    applied.retired++;
  }

  for (const op of add.filter((a) => a.kind === "hypothesis")) {
    const isOwner = op.person === "OWNER";
    // 札を先に作らないよう、根拠を確かめてから持ち主の札を出す
    const target = isOwner
      ? (state.persons.find((p) => p.subtype === "owner") ?? null)
      : resolve(op);
    if (!target && !isOwner) continue;
    const links = hypothesisLinks(
      target ?? { id: "", label: OWNER_LABEL, subtype: "owner" },
      op.items,
    );
    if (!links.length) continue;
    const text = okText(op.text, links);
    if (!text) continue;
    let person = target;
    if (!person) {
      person = { id: crypto.randomUUID(), label: OWNER_LABEL, subtype: "owner", fresh: true };
      state.persons.push(person);
      applied.persons++;
    }
    const same = state.cards.find(
      (c) =>
        c.person_id === person.id &&
        c.source === "claude" &&
        !c.superseded &&
        normalize(c.text) === normalize(text),
    );
    if (same) {
      for (const link of links) addLink(same, link);
      continue;
    }
    state.cards.push({
      id: crypto.randomUUID(),
      person_id: person.id,
      source: "claude",
      text,
      strength: null,
      links,
      fresh: true,
    });
    applied.hypotheses++;
  }
  return { applied, rejected };
}

// 毎回、全部の物に対して確かめ直す。差分を積み上げない。
// 訂正で根拠が消えたつながりは外し、強さはその時の「はっきり」の数で計算し直す
export function settle(
  state: CardState,
  itemsById: Map<string, ItemFacts>,
): { dropped_links: number; retired_empty: number } {
  let dropped_links = 0;
  let retired_empty = 0;
  for (const card of state.cards) {
    if (card.source === "family" || card.superseded) continue;
    card.links = card.links.flatMap((link) => {
      const item = itemsById.get(link.item_id);
      if (!item) {
        dropped_links++;
        return [];
      }
      if (link.basis === null) return [link]; // 見本の行。根拠の字を持たない
      const owner = state.persons.find((p) => p.id === card.person_id);
      const label = owner ? matchLabel(owner) : "";
      const s = card.source === "photo" ? nameSupport(item, link.basis, label) : support(item, link.basis);
      if (!s || typeof s === "string") {
        dropped_links++;
        return [];
      }
      return [{ ...link, ...s }];
    });
    if (!card.links.length) {
      card.superseded = true;
      retired_empty++;
      continue;
    }
    card.strength = strengthOf(card.links.filter((l) => l.clear || l.seen).length);
  }
  return { dropped_links, retired_empty };
}
