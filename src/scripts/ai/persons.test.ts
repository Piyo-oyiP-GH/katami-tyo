// 人物カードの計算だけの確かめ。Claude も D1 も使わない。文字列はすべて架空。
//   npx esbuild scripts/ai/persons.test.ts --bundle --platform=node --format=esm --outfile=<リポジトリの外>/persons.mjs
//   node --test <リポジトリの外>/persons.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyDiff,
  blockedTopic,
  type CardState,
  itemFacts,
  type ItemFacts,
  settle,
  strengthOf,
} from "../../src/ai/persons-core";
import type { AddOp, CheckedLine } from "../../src/ai/types";
import type { Level } from "../../src/types";

const nameLine = (text: string, level: Level = "high"): CheckedLine => ({
  text,
  type: "name",
  handwritten: false,
  where: "上",
  certainty: level,
  source: "a",
  agreement: "high",
  level,
});

function item(no: number, lines: CheckedLine[], over: { correction?: object; confidence?: Level } = {}) {
  return itemFacts({
    id: `i${no}`,
    seq: no,
    title: "架空の紙",
    confidence: over.confidence ?? "high",
    reading_json: JSON.stringify({
      a: { lines },
      a2: null,
      checked: lines,
      b: {
        kind: "はんだごて",
        synonyms: [],
        evidence: ["細い金属の先"],
        signals: [],
        inferences: [],
      },
    }),
    correction_json: over.correction ? JSON.stringify(over.correction) : null,
  });
}

const maps = (items: ItemFacts[]) => ({
  byNo: new Map(items.map((i) => [i.no, i])),
  byId: new Map(items.map((i) => [i.id, i])),
});
const empty = (): CardState => ({ persons: [], cards: [] });
const nameOp = (label: string, ...nos: number[]): AddOp => ({
  kind: "name",
  person: "NEW",
  new_label: label,
  text: "",
  items: nos.map((no) => ({ no, quote: label })),
});
const owner = (text: string, no: number, quote: string): AddOp => ({
  kind: "hypothesis",
  person: "OWNER",
  new_label: "",
  text,
  items: [{ no, quote }],
});

test("強さの境目。はっきりの数だけで決まる", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 9, 10, 40].map(strengthOf),
    [null, "weak", "weak", "mid", "mid", "strong", "strong"],
  );
});

test("実在しない番号は退ける", () => {
  const items = [item(1, [nameLine("架空 太郎")])];
  const s = empty();
  const r = applyDiff(s, { add: [nameOp("架空 太郎", 1, 99)] }, maps(items).byNo);
  assert.equal(r.rejected.unknown_item, 1);
  assert.equal(s.cards[0]!.links.length, 1);
});

test("読めていない名前では札を作らない", () => {
  const items = [item(1, [nameLine("架空 太郎")])];
  const s = empty();
  const r = applyDiff(s, { add: [nameOp("架空 次郎", 1)] }, maps(items).byNo);
  assert.equal(s.persons.length, 0);
  assert.equal(r.rejected.bad_label, 1);
});

test("読みにくい行は根拠にならない。一部あやしいはつながるが数えない", () => {
  const items = [item(1, [nameLine("架空 太郎", "low")]), item(2, [nameLine("架空 太郎", "mid")])];
  const { byNo, byId } = maps(items);
  const s = empty();
  applyDiff(s, { add: [nameOp("架空 太郎", 1, 2)] }, byNo);
  settle(s, byId);
  const card = s.cards[0]!;
  assert.deepEqual(card.links.map((l) => l.item_id), ["i2"]);
  assert.equal(card.links[0]!.clear, false);
  assert.equal(card.strength, null);
});

test("敬称を外し、同じ名前は 1 枚の札にまとめる", () => {
  const items = [item(1, [nameLine("架空 太郎 様")]), item(2, [nameLine("架空太郎")])];
  const { byNo, byId } = maps(items);
  const s = empty();
  applyDiff(s, { add: [nameOp("架空 太郎 様", 1)] }, byNo);
  applyDiff(
    s,
    { add: [{ ...nameOp("架空太郎", 2), person: "NEW" }] },
    byNo,
  );
  settle(s, byId);
  assert.equal(s.persons.length, 1);
  assert.equal(s.persons[0]!.label, "架空 太郎");
  assert.equal(s.persons[0]!.subtype, "vague");
  assert.equal(s.cards.filter((c) => c.source === "photo").length, 1);
  assert.equal(s.cards[0]!.links.length, 2);
});

test("健康、お金、人間関係、判断の語の仮説は入らない", () => {
  const items = [item(1, [])];
  const s = empty();
  const r = applyDiff(
    s,
    {
      add: [
        owner("通院していたのかもしれません", 1, "はんだごて"),
        owner("貯金が好きだったのかもしれません", 1, "はんだごて"),
        owner("親友がいたのかもしれません", 1, "はんだごて"),
        owner("大切にしていたのかもしれません", 1, "はんだごて"),
      ],
    },
    maps(items).byNo,
  );
  assert.equal(r.rejected.topic, 3);
  assert.equal(r.rejected.banned, 1);
  assert.equal(s.cards.length, 0);
  assert.equal(s.persons.length, 0); // 札だけ先に増えない
  assert.equal(blockedTopic("工夫して組み立てていたのかもしれません"), false);
});

test("名字だけの札は、空白の有無によらず姓名の行につながらない", () => {
  for (const names of [["架空 太郎", "架空 花子", "架空 次郎"], ["架空太郎", "架空花子", "架空次郎"]]) {
    const items = names.map((n, i) => item(i + 1, [nameLine(n)]));
    const { byNo, byId } = maps(items);
    const s = empty();
    const r = applyDiff(
      s,
      {
        add: [
          {
            kind: "name",
            person: "NEW",
            new_label: "架空",
            text: "",
            items: names.map((n, i) => ({ no: i + 1, quote: "架空" })),
          },
        ],
      },
      byNo,
    );
    settle(s, byId);
    assert.equal(s.persons.length, 0, names[0]);
    assert.equal(s.cards.length, 0);
    assert.ok(r.rejected.bad_label >= 1);
  }
});

test("姓名の全体は、空白があってもなくても同じ人として数える", () => {
  const items = [item(1, [nameLine("架空 太郎")]), item(2, [nameLine("架空太郎")])];
  const { byNo, byId } = maps(items);
  const s = empty();
  applyDiff(
    s,
    {
      add: [
        {
          kind: "name",
          person: "NEW",
          new_label: "架空太郎",
          text: "",
          items: [
            { no: 1, quote: "架空 太郎" },
            { no: 2, quote: "架空太郎" },
          ],
        },
      ],
    },
    byNo,
  );
  settle(s, byId);
  assert.equal(s.cards[0]!.links.filter((l) => l.clear).length, 2);
  assert.equal(s.cards[0]!.strength, "weak");
});

test("家族が名前を直した札は、元の読みでつながりを保つ", () => {
  const items = [item(1, [nameLine("架空 はな")])];
  const { byNo, byId } = maps(items);
  const s = empty();
  applyDiff(
    s,
    { add: [{ kind: "name", person: "NEW", new_label: "架空 はな", text: "", items: [{ no: 1, quote: "架空 はな" }] }] },
    byNo,
  );
  s.persons[0]!.label = "架空 はる";
  s.persons[0]!.readLabel = "架空 はな";
  const r = settle(s, byId);
  assert.equal(r.dropped_links, 0);
  assert.equal(s.cards[0]!.links.length, 1);
  const again = applyDiff(
    s,
    { add: [{ kind: "name", person: "NEW", new_label: "架空 はな", text: "", items: [{ no: 1, quote: "架空 はな" }] }] },
    byNo,
  );
  assert.equal(again.applied.persons, 0, "元の読みで札を増やさない");
  assert.equal(s.persons.length, 1);
});

test("見えたことの仮説は見えた物として数える。はっきりには入れない。持ち主の札に付く", () => {
  const items = [item(1, []), item(2, [], { confidence: "mid" })];
  const { byNo, byId } = maps(items);
  const s = empty();
  applyDiff(
    s,
    {
      add: [
        {
          ...owner("電子工作をしていたのかもしれません", 1, "はんだごて"),
          items: [
            { no: 1, quote: "はんだごて" },
            { no: 2, quote: "細い金属の先" },
          ],
        },
      ],
    },
    byNo,
  );
  settle(s, byId);
  assert.equal(s.persons[0]!.subtype, "owner");
  assert.deepEqual(s.cards[0]!.links.map((l) => l.clear), [false, false]);
  assert.deepEqual(s.cards[0]!.links.map((l) => l.seen), [true, true]);
  assert.equal(s.cards[0]!.strength, "weak");
});

test("字の引用を含む見えたことは、読みなので見えた物に数えない", () => {
  const one = item(1, []);
  one.observed.push("文の中に「架空の字」と見える");
  const { byNo, byId } = maps([one]);
  const s = empty();
  applyDiff(s, { add: [owner("字を書いていたのかもしれません", 1, "架空の字")] }, byNo);
  settle(s, byId);
  assert.equal(s.cards[0]!.links[0]!.seen, false);
  assert.equal(s.cards[0]!.strength, null);
});

test("見えたことで 10 個つながれば強め。はっきりの数には入れない", () => {
  const items = Array.from({ length: 10 }, (_, i) => item(i + 1, []));
  const { byNo, byId } = maps(items);
  const s = empty();
  applyDiff(
    s,
    { add: [{ ...owner("電子工作をしていたのかもしれません", 1, "はんだごて"), items: items.map((i) => ({ no: i.no, quote: "はんだごて" })) }] },
    byNo,
  );
  settle(s, byId);
  assert.equal(s.cards[0]!.links.length, 10);
  assert.equal(s.cards[0]!.links.filter((l) => l.clear).length, 0);
  assert.equal(s.cards[0]!.links.filter((l) => l.seen).length, 10);
  assert.equal(s.cards[0]!.strength, "strong");
});

test("読みにくい物の見えたことは、つなぐが数えない", () => {
  const items = Array.from({ length: 10 }, (_, i) => item(i + 1, [], { confidence: "low" }));
  const { byNo, byId } = maps(items);
  const s = empty();
  applyDiff(
    s,
    { add: [{ ...owner("電子工作をしていたのかもしれません", 1, "はんだごて"), items: items.map((i) => ({ no: i.no, quote: "はんだごて" })) }] },
    byNo,
  );
  settle(s, byId);
  assert.equal(s.cards[0]!.links.length, 10);
  assert.equal(s.cards[0]!.strength, null);
});

test("字が違えば別の人。名字だけの一致はつなぐが数えない", () => {
  const items = [item(1, [nameLine("田中太郎")]), item(2, [nameLine("田中花子")]), item(3, [nameLine("田中")])];
  const { byNo, byId } = maps(items);
  const s = empty();
  const r = applyDiff(
    s,
    { add: [{ kind: "name", person: "NEW", new_label: "田中太郎", text: "", items: [{ no: 1, quote: "田中太郎" }, { no: 2, quote: "田中" }, { no: 3, quote: "田中" }] }] },
    byNo,
  );
  settle(s, byId);
  assert.equal(r.rejected.bad_label, 1, "田中花子 は別の人");
  assert.deepEqual(s.cards[0]!.links.map((l) => [l.item_id, l.clear]), [["i1", true], ["i3", false]]);
  assert.equal(s.cards[0]!.strength, "weak");
});

test("札が家全体なら、名字で物につなぐ余地を残す。数えない", () => {
  const items = [item(1, [nameLine("川辺 正")])];
  const { byNo, byId } = maps(items);
  const s: CardState = { persons: [{ id: "p1", label: "川辺夫妻", subtype: "vague" }], cards: [] };
  applyDiff(s, { add: [{ kind: "name", person: "P1", new_label: "", text: "", items: [{ no: 1, quote: "川辺" }] }] }, byNo);
  settle(s, byId);
  assert.deepEqual(s.cards[0]!.links.map((l) => l.clear), [false]);
});

test("たまたま当たる切れ端は根拠にしない。読めていない人名の文も、形の違う文も入らない", () => {
  const code = (no: number) => item(no, [{ ...nameLine("品番 12345"), type: "other" }]);
  const items = [code(1), code(2), code(3), item(4, [nameLine("架空太郎")])];
  const { byNo } = maps(items);
  const s = empty();
  const r = applyDiff(
    s,
    { add: [{ ...owner("演奏を続けていたのかもしれません", 1, "12"), items: [1, 2, 3].map((no) => ({ no, quote: "12" })) }] },
    byNo,
  );
  assert.equal(s.cards.length, 0);
  assert.equal(r.rejected.no_support, 3);
  const r2 = applyDiff(s, { add: [owner("ヤマハの教室で演奏を続けていたのかもしれません", 1, "12345")] }, byNo);
  assert.equal(s.cards.length, 0);
  assert.equal(r2.rejected.unsupported, 1);
  const r3 = applyDiff(s, { add: [owner("架空太郎と演奏を続けていたのかもしれません", 1, "12345")] }, byNo);
  assert.equal(r3.rejected.unsupported, 1, "人名は文に書かない");
  const r4 = applyDiff(s, { add: [owner("演奏を続けていました", 1, "12345")] }, byNo);
  assert.equal(r4.rejected.unsupported, 1, "「〜かもしれません」の形でない");
  applyDiff(s, { add: [owner("演奏を続けていたのかもしれません", 1, "12345")] }, byNo);
  assert.equal(s.cards.length, 1);
});

test("家族が直した物名は根拠にならない", () => {
  const items = [1, 2, 3].map((no) => item(no, [], { correction: { title: "釣り竿" } }));
  const { byNo, byId } = maps(items);
  const s = empty();
  applyDiff(
    s,
    { add: [{ ...owner("釣りをしていたのかもしれません", 1, "釣り竿"), items: items.map((i) => ({ no: i.no, quote: "釣り竿" })) }] },
    byNo,
  );
  settle(s, byId);
  assert.equal(s.cards.length, 0);
});

test("引用も年も、根拠の物に無ければ入らない", () => {
  const items = [item(1, [])];
  const s = empty();
  const r = applyDiff(
    s,
    {
      add: [
        owner("「架空の会」に入っていたのかもしれません", 1, "はんだごて"),
        owner("1987年に作ったのかもしれません", 1, "はんだごて"),
        owner("組み立てをしていたのかもしれません", 1, "写真に無い語"),
      ],
    },
    maps(items).byNo,
  );
  assert.equal(r.rejected.unsupported, 2);
  assert.equal(r.rejected.no_support, 1);
  assert.equal(s.cards.length, 0);
});

test("名前の札の仮説は、その名前が読めた物だけに付く", () => {
  const items = [item(1, [nameLine("架空 太郎")]), item(2, [])];
  const { byNo } = maps(items);
  const s = empty();
  applyDiff(s, { add: [nameOp("架空 太郎", 1)] }, byNo);
  const r = applyDiff(
    s,
    {
      add: [
        {
          kind: "hypothesis",
          person: "P1",
          new_label: "",
          text: "手で作るのが好きだったのかもしれません",
          items: [
            { no: 1, quote: "はんだごて" },
            { no: 2, quote: "はんだごて" },
          ],
        },
      ],
    },
    byNo,
  );
  assert.equal(r.rejected.no_support, 1);
  assert.deepEqual(s.cards.find((c) => c.source === "claude")!.links.map((l) => l.item_id), ["i1"]);
});

test("家族の項目には番号が無く、変えられない。強さにも入らない", () => {
  const items = [item(1, [nameLine("架空 太郎")])];
  const { byNo, byId } = maps(items);
  const s: CardState = {
    persons: [{ id: "p", label: "架空 太郎", subtype: "friend" }],
    cards: [
      {
        id: "f",
        person_id: "p",
        source: "family",
        text: "家族の架空のメモ",
        strength: null,
        links: [{ item_id: "i1", basis: null, clear: false, seen: false }],
      },
    ],
  };
  const r = applyDiff(s, { retire: [{ claim: "C1" }, { claim: "f" }] }, byNo);
  settle(s, byId);
  assert.equal(r.rejected.unknown_ref, 2);
  assert.equal(s.cards[0]!.superseded, undefined);
  assert.equal(s.cards[0]!.strength, null);
  assert.equal(s.persons[0]!.subtype, "friend");
});

test("「違う」で元の読みの根拠が消えると、つながりも外れ、強さも下がる", () => {
  const lines = [nameLine("架空 大郎")];
  const before = [item(1, lines), item(2, lines), item(3, lines)];
  const s = empty();
  const m = maps(before);
  applyDiff(s, { add: [nameOp("架空 大郎", 1, 2, 3)] }, m.byNo);
  settle(s, m.byId);
  assert.equal(s.cards[0]!.strength, "mid");

  const fixed = item(3, lines, { correction: { lines: { "0": { text: "架空 太郎", original: "架空 大郎" } } } });
  const after = maps([before[0]!, before[1]!, fixed]);
  const r = settle(s, after.byId);
  assert.equal(r.dropped_links, 1);
  assert.equal(s.cards[0]!.strength, "weak");

  // 全部の根拠が消えれば項目も取り下げる
  const none = settle(s, new Map());
  assert.equal(none.retired_empty, 1);
  assert.equal(s.cards[0]!.superseded, true);
});

test("家族の訂正の字からは、読めた名前の札を作らない", () => {
  const fixed = item(1, [nameLine("架空 大郎", "low")], {
    correction: { lines: { "0": { text: "架空 太郎", original: "架空 大郎" } } },
  });
  const { byNo, byId } = maps([fixed]);
  const s = empty();
  const r = applyDiff(s, { add: [nameOp("架空 太郎", 1)] }, byNo);
  settle(s, byId);
  assert.equal(s.persons.length, 0);
  assert.equal(s.cards.length, 0);
  assert.equal(r.rejected.bad_label, 1);
  assert.equal(fixed.lines[0]!.text, "架空 太郎"); // Claude には訂正後の字を見せる
});

test("物の名前の訂正で、元の種類は根拠でなくなる", () => {
  const fixed = item(1, [], { correction: { title: "架空の道具" } });
  assert.equal(fixed.title, "架空の道具");
  assert.equal(fixed.observed.includes("はんだごて"), false);
  assert.equal(fixed.observed.includes("架空の道具"), false, "家族の物名も写真の根拠にしない");
  assert.equal(fixed.familyTitle, "架空の道具");
});

test("文の更新は古い行を残して新しい行を作る。つながりは引き継ぐ", () => {
  const items = [item(1, []), item(2, [])];
  const { byNo, byId } = maps(items);
  const s = empty();
  applyDiff(s, { add: [owner("工作をしていたのかもしれません", 1, "はんだごて")] }, byNo);
  settle(s, byId);
  applyDiff(
    s,
    {
      update: [
        {
          claim: "C1",
          text: "電子工作をしていたのかもしれません",
          add_items: [{ no: 2, quote: "はんだごて" }],
          remove_nos: [],
        },
      ],
    },
    byNo,
  );
  settle(s, byId);
  const live = s.cards.filter((c) => !c.superseded);
  assert.equal(s.cards.length, 2);
  assert.equal(live.length, 1);
  assert.equal(live[0]!.links.length, 2);
});

test("足りない鍵があっても壊れない", () => {
  const s = empty();
  assert.doesNotThrow(() => applyDiff(s, {}, new Map()));
});
