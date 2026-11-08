// 計算だけの確かめ。Claude は呼ばない。文字列はすべて架空。
//   npx esbuild scripts/ai/unit.test.ts --bundle --platform=node --format=esm --outfile=<リポジトリの外>/unit.mjs
//   node --test <リポジトリの外>/unit.mjs
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import test from "node:test";
import { checkLines, compareReading, itemConfidence } from "../../src/ai/confidence";
import {
  blockedTopic,
  countBanned,
  countTopics,
  downgrade,
  hedge,
  judges,
  removeBanned,
  removeTopics,
  unsupportedTokens,
} from "../../src/ai/guard";
import { exifOrientation } from "../../src/ai/photo";
import { readPhoto } from "../../src/ai/pipeline";
import { rank, reapplyCorrection, searchTerms } from "../../src/ai/rank";
import type { RawObservation } from "../../src/ai/types";
import type { Level, ReadLine, ReadResult, TextType } from "../../src/types";

const line = (
  text: string,
  type: TextType = "other",
  certainty: Level = "high",
  handwritten = false,
): ReadLine => ({ text, type, handwritten, where: "中央", certainty });
const read = (...lines: ReadLine[]): ReadResult => ({ lines });
const obs = (over: Partial<RawObservation> = {}): RawObservation => ({
  kind: "はがき",
  synonyms: ["葉書"],
  evidence: [],
  signals: [],
  inferences: [],
  proper_nouns: [],
  ...over,
});

test("日付の書き方が違っても一致とみなす", () => {
  const [l] = checkLines(read(line("2031年5月3日", "date")), read(line("2031.05.03", "date")), "high");
  assert.equal(l!.agreement, "high");
  assert.equal(l!.level, "high");
});

test("名前が 1 字違えば low。A2 に無ければ mid", () => {
  const [x] = checkLines(read(line("架空太郎", "name")), read(line("架空大郎", "name")), "high");
  assert.equal(x!.agreement, "low");
  const [y] = checkLines(read(line("架空太郎", "name")), read(), "high");
  assert.equal(y!.agreement, "mid");
});

test("A の other の行に含まれる語は、A2 だけの行にならない", () => {
  const c = checkLines(read(line("宛先 架空花子 様")), read(line("架空花子", "name")), "high");
  assert.equal(c.length, 1);
});

test("A2 だけが読んだ行は残す", () => {
  const c = checkLines(read(line("見本")), read(line("架空花子", "name")), "high");
  assert.equal(c.length, 2);
  assert.equal(c[1]!.source, "a2");
  assert.equal(c[1]!.level, "mid");
});

test("上限と不明の字", () => {
  const [x] = checkLines(read(line("架空太郎", "name")), read(line("架空太郎", "name")), "low");
  assert.equal(x!.level, "low");
  const [y] = checkLines(read(line("架〔不明〕太郎", "name")), read(line("架〔不明〕太郎", "name")), "high");
  assert.equal(y!.level, "mid");
  const [z] = checkLines(read(line("〔不明〕", "other")), null, "high");
  assert.equal(z!.level, "low");
});

test("物全体の確からしさ。混ざれば mid、全部 low なら low、再読が無ければ mid まで", () => {
  const c = checkLines(read(line("架空太郎", "name"), line("見本", "other", "low")), read(line("架空太郎", "name")), "high");
  assert.equal(itemConfidence(c, "high", false), "high");
  assert.equal(itemConfidence(c, "high", true), "mid");
  assert.equal(itemConfidence([], "high", false), null, "文字が無ければ確からしさは無い");
  const mixed = checkLines(read(line("架空太郎", "name"), line("2031年", "date", "low")), read(line("架空太郎", "name"), line("2031年", "date", "low")), "high");
  assert.equal(itemConfidence(mixed, "high", false), "mid");
  assert.equal(itemConfidence(mixed, "low", false), "low");
  const bad = checkLines(read(line("架空太郎", "name")), read(line("架空大郎", "name")), "high");
  assert.equal(itemConfidence(bad, "high", false), "low");
});

test("手書きの文は再読の対象でないので、比べていない行として扱う", () => {
  const [x] = checkLines(read(line("見本の文", "other", "high", true)), read(), "high");
  assert.deepEqual([x!.agreement, x!.level], [null, "high"]);
  const lines = checkLines(
    read(line("架空太郎", "name", "high", true), line("見本の文", "other", "high", true)),
    read(line("架空太郎", "name", "high", true)),
    "high",
  );
  assert.equal(itemConfidence(lines, "high", false), "high", "読みがきれいなら全体もはっきり");
  assert.equal(itemConfidence(lines, "mid", false), "mid", "画像の上限は効く");
});

test("逆さの手書きは low で、向きを直す撮り直し候補。印刷は下げない", () => {
  const hand = { ...line("見本の文", "other", "mid", true), rotated: true };
  const c = checkLines(read(hand), read(), "high");
  assert.equal(c[0]!.level, "low");
  const r = rank(c, obs());
  assert.equal(r.needsRetake, true);
  assert.ok(r.reason.includes("上に向けて"));
  assert.deepEqual(searchTerms(c, null).text, []);
  const printed = checkLines(read({ ...line("見本の文"), rotated: true }), read(), "high");
  assert.equal(printed[0]!.level, "high");
});

test("1 字の数字は数の単位で比べる", () => {
  const c = checkLines(read(line("1杯分", "number"), line("2031", "number")), read(line("1", "number"), line("3", "number")), "high");
  assert.equal(c[0]!.agreement, "high");
  assert.equal(c[2]!.source, "a2");
});

test("順位の式", () => {
  const c = checkLines(
    read(line("架空太郎", "name", "high", true), line("2031年5月3日", "date", "mid", true)),
    read(line("架空太郎", "name"), line("2031年5月3日", "date", "mid")),
    "high",
  );
  const r = rank(c, obs({ signals: ["宛名や署名", "紙焼きの原本", "古び"] }));
  assert.equal(r.score, 3 + 3 + 2 * 0.7 + 2 + 2 + 1);
  assert.equal(r.needsRetake, false);
  assert.ok(!r.reason.includes("架空"));
});

test("読めない手書きは点を残し、撮り直し候補にする", () => {
  const c = checkLines(read(line("〔不明〕", "other", "low", true)), read(), "high");
  const r = rank(c, obs());
  assert.equal(r.score, 3);
  assert.equal(r.needsRetake, true);
  const r2 = rank([], obs({ signals: ["手書き"] }));
  assert.equal(r2.score, 3);
  assert.equal(r2.needsRetake, true);
  assert.equal(rank([], obs()).score, 0);
});

test("判断の語。引用は数えず、作り直しても残れば項目ごと消す", () => {
  const reads = [read(line("大切に保管"))];
  assert.equal(countBanned(obs({ evidence: ["「大切に保管」と書いてある"] }), reads), 0);
  assert.equal(countBanned(obs({ inferences: ["大切な物かもしれません"] }), reads), 1);
  assert.equal(countBanned(obs({ synonyms: ["使い捨てマスク"] }), []), 0);
  const b = obs({ inferences: ["捨てずに残された物かもしれません", "趣味の物かもしれません"] });
  assert.equal(countBanned(b, []), 1);
  assert.deepEqual(removeBanned(b, []).inferences, ["趣味の物かもしれません"]);
});

test("判断の語の広がり。かな、言い換え、語の抜き書き。説明の文は止めない", () => {
  const hit = (t: string, reads: ReadResult[] = []) => countBanned(obs({ inferences: [t] }), reads);
  for (const t of [
    "重要な書類かもしれません",
    "大事にしていた物かもしれません",
    "処分してよさそうです",
    "価値のある品かもしれません",
    "たいせつにしていたかもしれません",
    "タイセツな品です",
    "すててよい物です",
    "高価な品です",
    "不要な物かもしれません",
    "使い捨てるべき物です",
    "残すべき物です",
    "思い入れのある品です",
  ]) {
    assert.equal(hit(t), 1, t);
  }
  assert.equal(hit("「大切」な品かもしれません", [read(line("大切にしてください"))]), 1, "語の抜き書きは通さない");
  assert.equal(hit("「大切にしてください」と書いてある", [read(line("大切にしてください"))]), 0);
  for (const t of ["メモを残すための紙かもしれません", "ステンレスの箱", "使い捨てカイロ", "ステテコ"]) {
    assert.equal(hit(t), 0, t);
  }
});

test("話題の語の広がり", () => {
  for (const t of [
    "通帳を管理していたかもしれません",
    "血圧を毎日測っていたかもしれません",
    "株を買っていたかもしれません",
    "びょういんに通っていたかもしれません",
    "おかねを貯めていたかもしれません",
    "同級生と会っていたかもしれません",
    "奥さんと旅行していたかもしれません",
    "家賃の控えかもしれません",
    "ともだちと遊んでいたかもしれません",
  ]) {
    assert.equal(blockedTopic(t), true, t);
  }
  assert.equal(blockedTopic("工夫して組み立てていたかもしれません"), false);
  assert.equal(blockedTopic("株式会社の封筒かもしれません"), false);
});

test("申告の無い固有名詞も形で拾う。低い行と〔不明〕の中の字は裏付けにしない", () => {
  const moved = (t: string, reads: ReadResult[] = []) => downgrade(obs({ evidence: [t] }), reads).downgraded;
  for (const t of ["ヤマハ製の鍵盤です", "田中太郎さんの字です", "電話番号は03-1111-2222です", "昭和四十年の品です"]) {
    assert.equal(moved(t), 1, t);
  }
  assert.equal(moved("プラスチック製の黒いケース"), 0);
  assert.equal(moved("白い紙に青いインク"), 0);
  const d = downgrade(obs({ kind: "ソニーのラジオ", synonyms: ["受信機"] }), []);
  assert.equal(d.observation.kind, "受信機");
  assert.equal(moved("「山田」と書いてある", [read(line("山〔不明〕田"))]), 1, "〔不明〕をまたいだ字");
  assert.equal(moved("「山田」と書いてある", [read(line("山田", "name", "low"))]), 1, "読みにくい行");
  assert.equal(moved("「山田」と書いてある", [read(line("山田", "name", "mid"))]), 0);
  assert.deepEqual(unsupportedTokens("品です", [], ""), []);
});

test("A2 が一部しか読めていなければ mid。食い違いは先に見る", () => {
  const [x] = checkLines(read(line("田中太郎", "name")), read(line("田中", "name")), "high");
  assert.deepEqual([x!.agreement, x!.level], ["mid", "mid"]);
  const [y] = checkLines(read(line("03-1234-5678", "number")), read(line("1234", "number")), "high");
  assert.deepEqual([y!.agreement, y!.level], ["mid", "mid"]);
  const [z] = checkLines(read(line("田中太郎", "name")), read(line("田中", "name"), line("田中次郎", "name")), "high");
  assert.equal(z!.level, "low");
  const [w] = checkLines(read(line("田中太郎 様", "name")), read(line("田中太郎", "name")), "high");
  assert.equal(w!.level, "high", "敬称の違いは同じ読み");
  const [v] = checkLines(read(line("TEL 03-1234-5678", "number")), read(line("03-1234-5678", "number")), "high");
  assert.equal(v!.level, "high");
});

test("日付は元号も比べる。違う元号は食い違い", () => {
  const [x] = checkLines(read(line("昭和3年5月", "date")), read(line("平成3年5月", "date")), "high");
  assert.deepEqual([x!.agreement, x!.level], ["low", "low"]);
  const [y] = checkLines(read(line("昭和3年5月", "date")), read(line("昭和三年五月", "date")), "high");
  assert.equal(y!.level, "high");
  const [z] = checkLines(read(line("昭和3年5月", "date")), read(line("1928年5月", "date")), "high");
  assert.equal(z!.level, "high", "元号と西暦は同じ年なら同じ");
});

test("other の行も再読と比べる。数字のある行は裏付けが無ければ mid", () => {
  const [x] = checkLines(read(line("重さ 235g")), read(line("285g", "number")), "high");
  assert.equal(x!.level, "low");
  const [y] = checkLines(read(line("山田太郎")), read(line("山田大郎", "name")), "high");
  assert.equal(y!.level, "low");
  const [z] = checkLines(read(line("重さ 235g")), read(), "high");
  assert.equal(z!.level, "mid");
  const [v] = checkLines(read(line("重さ 235g")), read(line("235g", "number")), "high");
  assert.equal(v!.level, "high");
  const [w] = checkLines(read(line("取扱説明書")), read(), "high");
  assert.deepEqual([w!.agreement, w!.level], [null, "high"], "数字の無い印刷は比べていない行");
});

test("訂正の後は、訂正済みの読みで点数と理由を計算し直す", () => {
  const hand = (t: string, type: TextType, level: Level) => ({ ...line(t, type, level, true), source: "a" as const, agreement: level, level });
  const b = obs();
  const reading = { a: null, a2: read(), b, checked: [hand("架〔不明〕", "name", "low")] };
  const before = rank(reading.checked, b);
  assert.equal(before.needsRetake, true);
  const after = reapplyCorrection(reading, { lines: { "0": { text: "架空花子", original: "架〔不明〕" } } }, "high");
  assert.equal(after.needsRetake, false);
  assert.equal(after.confidence, "high");
  assert.match(after.reason, /人名（家族の訂正）/);
  assert.ok(after.score > before.score);
});

test("文字の裏付けが無い固有名詞と年を見立てに下げる", () => {
  const reads = [read(line("架空商事 2031年")), null];
  const { observation: o, downgraded } = downgrade(
    obs({
      kind: "見本社のはがき",
      synonyms: ["葉書", "見本社の郵便"],
      evidence: ["架空商事の字がある", "1985年ごろの紙に見える", "「架空商事」と読める", "「幻社」と読める", "青い線がある"],
      proper_nouns: ["架空商事", "見本社"],
    }),
    reads,
  );
  assert.equal(o.kind, "葉書");
  assert.deepEqual(o.synonyms, ["葉書"]);
  assert.deepEqual(o.evidence, ["架空商事の字がある", "「架空商事」と読める", "青い線がある"]);
  assert.equal(downgraded, 4);
  assert.deepEqual(o.inferences, ["1985年ごろの紙に見えるかもしれません。"], "綴りを言い切る文は残さない");
  assert.deepEqual(o.moved, o.inferences);
});

test("写真に無い綴りは見立てにも残さず、検索にも入れない", () => {
  const reads = [read(line("架空商店")), read(line("架空商店"))];
  const { observation: o } = downgrade(
    obs({
      evidence: ["「架空商占」と読める字があります", "http://kakuu.example と印刷されています", "『山本次郎』と書かれている", "山本次郎の署名がある", "昭和中期の型のラジオ", "京都の土産物の包装", "大正時代の品に見える"],
      inferences: ["「幻の店」の品かもしれません", "趣味で使っていたようです"],
      proper_nouns: ["山本次郎"],
    }),
    reads,
  );
  assert.deepEqual(o.evidence, []);
  assert.deepEqual(o.inferences, [
    "趣味で使っていたかもしれません。",
    "昭和中期の型のラジオかもしれません。",
    "京都の土産物の包装かもしれません。",
    "大正時代の品に見えるかもしれません。",
  ]);
  const terms = searchTerms([], o);
  assert.deepEqual(terms.inference, ["趣味で使っていたかもしれません。"], "下げた文は検索の語に入れない");
});

test("模様や逆さまは名前ではない", () => {
  for (const t of ["水玉模様の布", "青い縞模様です", "表面に唐草模様が見える", "上下逆さまに置かれている", "同様の品が見える"]) {
    assert.deepEqual(unsupportedTokens(t, [], ""), [], t);
  }
  assert.deepEqual(unsupportedTokens("架空太郎様あて", [], ""), ["架空太郎"]);
});

test("署名の場所や道具は人名ではない", () => {
  for (const t of ["右下の署名がある", "裏面の記名", "鉛筆の筆跡", "万年筆の署名", "封筒の署名", "差出人の署名"]) {
    assert.deepEqual(unsupportedTokens(t, [], ""), [], t);
  }
  assert.deepEqual(unsupportedTokens("山本次郎の署名がある", [], ""), ["山本次郎"]);
});

test("言い切りの文を「かもしれません」の形にする", () => {
  assert.equal(hedge("手紙です。"), "手紙かもしれません。");
  assert.equal(hedge("印刷されています"), "印刷されているかもしれません。");
  assert.equal(hedge("字があります。"), "字があるかもしれません。");
  assert.equal(hedge("手紙かもしれない"), "手紙かもしれない");
});

test("価値や残す、捨てるの判断を止める", () => {
  for (const t of [
    "家の宝物だったかもしれません", "かけがえのない品", "思い出深い品", "思い出の写真", "記念の品", "愛着のある品", "特別な品",
    "残しておくとよいかもしれません", "残す候補", "取っておきたい", "手放してもよい", "ゴミかもしれません", "残す必要はない",
    "破棄してよい物です", "ごみです", "手放してもよさそうです", "残しましょう", "保管しておくとよいです", "宝物です", "不必要な物",
    "残したいです", "残さなくてよい", "ゴミです", "取っておくとよい",
  ]) {
    assert.equal(judges(t), true, t);
  }
});

test("物の名前と、ふつうの文は止めない", () => {
  for (const t of [
    "ダイジェスト版の冊子", "だいじょうぶ", "貴重品袋", "重要文化財の絵はがき", "ゴミ箱", "ごみ袋", "記念切手", "百科大事典",
    "記録を残す習慣があったかもしれません", "特別な日に使っていたかもしれません", "取っておいた手紙かもしれません",
    "使い捨てのカイロ", "傷が残っている", "残された手紙",
    "記録を残していたかもしれません", "記録を残すという習慣", "記録を残すのが好きだったかもしれません",
    "切手を保存するのが趣味だったかもしれません", "包装紙を取っておく方だったかもしれません",
    "とてもよく使い込まれている", "とても良い状態",
  ]) {
    assert.equal(judges(t), false, t);
  }
});

test("A と A2 で字が落ちた読みを同じにしない", () => {
  const same = (x: string, y: string, t: TextType) => compareReading(line(x, t), line(y, t));
  assert.equal(same("10000", "1000", "number"), "partial");
  assert.equal(same("03-1234-5678", "03-1234-567", "number"), "partial");
  assert.equal(same("1234567890", "123456789", "number"), "partial");
  assert.equal(same("架空太郎丸", "架空太郎", "name"), "partial");
  assert.equal(same("2024年5月3日 架空太郎", "2024年5月3日", "date"), "partial");
  assert.equal(same("123 架空太郎", "123", "number"), "partial");
  assert.equal(same("2024年5月3日 山田", "2024年5月3日", "date"), "partial");
  assert.equal(same("123 山田", "123", "number"), "partial");
  assert.equal(same("TEL 03-1234-5678", "03-1234-5678", "number"), "same");
  assert.equal(same("電話番号 03-1234-5678", "03-1234-5678", "number"), "same");
  assert.equal(same("2031年5月3日", "2031.05.03", "date"), "same");
  assert.equal(same("架空 太郎 様", "架空太郎", "name"), "same");
  const [l] = checkLines(read(line("10000", "number")), read(line("1000", "number")), "high");
  assert.notEqual(l!.level, "high");
});

test("再読の本人申告が低ければ、全体もはっきりにしない", () => {
  const lines = checkLines(read(line("架空太郎", "name", "high")), read(line("架空太郎", "name", "low")), "high");
  assert.equal(lines[0]!.level, "low");
  assert.notEqual(itemConfidence(lines, "high", false), "high");
});

test("横向きの手書きの数字は、A と A2 が同じなら mid で探せる。文は low のまま", () => {
  const num = { ...line("1234", "number", "high", true), rotated: true };
  const [n] = checkLines(read(num), read(line("1234", "number", "high", true)), "high");
  assert.equal(n!.level, "mid");
  assert.ok(searchTerms([n!], null).text.includes("1234"));
  assert.equal(rank([n!], null).reason.includes("字を上に向けて"), false);
  const prose = { ...line("見本の文", "other", "high", true), rotated: true };
  const [p] = checkLines(read(prose), read(), "high");
  assert.equal(p!.level, "low");
  assert.deepEqual(searchTerms([p!], null).text, []);
  assert.equal(rank([p!], obs()).reason.includes("字を上に向けて"), true);
  const [d] = checkLines(read(num), read(line("1235", "number", "high", true)), "high");
  assert.equal(d!.level, "low", "食い違えば下げたまま");
});

test("話題の検査を広げ、見えたことの推測にも掛ける", () => {
  for (const t of [
    "親しい人から贈られた物かもしれません", "知り合いへの贈り物かもしれません", "贈り主と親しかったかもしれません", "恋文かもしれません",
    "老眼鏡を使っていたかもしれません", "視力が弱かったかもしれません", "お見舞いの品かもしれません", "高額な品かもしれません", "売って現金にしたかもしれません",
  ]) {
    assert.equal(blockedTopic(t), true, t);
  }
  assert.equal(blockedTopic("販売の仕事をしていたかもしれません"), false, "仕事の仮説は止めない");
  const b = obs({ evidence: ["通院していたらしい", "青い封筒がある", "病院の封筒がある"], inferences: [] });
  assert.equal(countTopics(b), 1);
  assert.deepEqual(removeTopics(b).observation.evidence, ["青い封筒がある", "病院の封筒がある"]);
});

test("検索の語は出どころごとに分ける", () => {
  const c = checkLines(read(line("架空 商事"), line("〔不明〕")), null, "high");
  const s = searchTerms(c, obs({ inferences: ["趣味の物かもしれません"] }));
  assert.deepEqual(s, {
    text: ["架空", "商事"],
    name: ["はがき"],
    synonym: ["葉書"],
    inference: ["趣味の物かもしれません"],
  });
});

test("EXIF の向きを読む", () => {
  const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0];
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const size = exif.length + 2;
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, size >> 8, size & 255, ...exif, 0xff, 0xda, 0, 2]);
  assert.equal(exifOrientation(jpg.buffer), 6);
  assert.equal(exifOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]).buffer), 1);
  assert.equal(exifOrientation(new Uint8Array([1, 2, 3, 4]).buffer), 1);
});

// ---- 失敗の経路。Claude の代わりに偽物を返す ----
type Part = "A" | "A2" | "B";
function fakeClient(reply: (part: Part, nth: number) => unknown) {
  const count: Record<Part, number> = { A: 0, A2: 0, B: 0 };
  const create = async (p: { output_config: { format: { schema: { required: string[] } } }; messages: { content: { text?: string }[] }[] }) => {
    const prompt = p.messages[0]!.content[1]!.text ?? "";
    const part: Part = p.output_config.format.schema.required.includes("kind") ? "B" : prompt.includes("だけを読んで") ? "A2" : "A";
    count[part]++;
    const r = reply(part, count[part]);
    if (r instanceof Error) throw r;
    const stop = r === "refusal" || r === "max_tokens" ? r : "end_turn";
    return {
      model: "fake",
      stop_reason: stop,
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "text", text: JSON.stringify(r) }],
    };
  };
  return { client: { beta: { messages: { create } } } as unknown as Anthropic, count };
}
const okRead = read(line("架空太郎", "name"));
const ok = (part: Part) => (part === "B" ? obs() : okRead);
const rate = () => new Anthropic.RateLimitError(429, {}, "rate", new Headers());
const badRequest = () => new Anthropic.BadRequestError(400, {}, "bad", new Headers());

test("全部通れば done", async () => {
  const { client } = fakeClient(ok);
  const r = await readPhoto(client, "x", "high");
  assert.equal(r.outcome, "done");
  if (r.outcome === "done") assert.equal(r.fields.confidence, "high");
});

test("一時エラーはどの呼び出しでも retry", async () => {
  for (const bad of ["A", "A2", "B"]) {
    const { client } = fakeClient((p) => (p === bad ? rate() : ok(p)));
    assert.equal((await readPhoto(client, "x", "high")).outcome, "retry");
  }
});

test("壊れた JSON は retry", async () => {
  const create = async () => ({ model: "fake", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "{" }] });
  const client = { beta: { messages: { create } } } as unknown as Anthropic;
  assert.equal((await readPhoto(client, "x", "high")).outcome, "retry");
});

test("A も B も読めなければ failed。理由を残す", async () => {
  for (const [reply, code] of [["refusal", "refused"], ["max_tokens", "truncated"], [badRequest(), "api_error"]] as const) {
    const { client } = fakeClient((p) => (p === "A" || p === "B" ? reply : ok(p)));
    const r = await readPhoto(client, "x", "high");
    assert.equal(r.outcome, "failed");
    if (r.outcome === "failed") assert.equal(r.code, code);
  }
});

test("A だけ失敗しても、物の観察はカードに残す", async () => {
  for (const [reply, code] of [["refusal", "read_refused"], ["max_tokens", "read_truncated"], [badRequest(), "read_api_error"]] as const) {
    const { client } = fakeClient((p) => (p === "A" ? reply : ok(p)));
    const r = await readPhoto(client, "x", "high");
    assert.equal(r.outcome, "done");
    if (r.outcome === "done") {
      assert.equal(r.fields.error_code, code);
      assert.ok(r.fields.reading.b);
      assert.equal(r.fields.needs_retake, true);
      assert.notEqual(r.fields.confidence, "high");
    }
  }
});

test("最後の試行では、一時的な失敗でも取れた分でカードを作る", async () => {
  const onlyA2 = fakeClient((p) => (p === "A2" ? rate() : ok(p)));
  assert.equal((await readPhoto(onlyA2.client, "x", "high")).outcome, "retry");
  const last = await readPhoto(onlyA2.client, "x", "high", { final: true });
  assert.equal(last.outcome, "done");
  if (last.outcome === "done") {
    assert.equal(last.fields.reading.a2, null);
    assert.equal(last.guard.reread_error, "api_error");
    assert.notEqual(last.fields.confidence, "high");
  }
  const all = fakeClient(() => rate());
  assert.equal((await readPhoto(all.client, "x", "high", { final: true })).outcome, "retry");
});

test("A2 だけ失敗すれば done で mid まで。B だけ失敗すれば題名なしの done で、印が付く", async () => {
  const x = await readPhoto(fakeClient((p) => (p === "A2" ? "refusal" : ok(p))).client, "x", "high");
  assert.equal(x.outcome, "done");
  if (x.outcome === "done") assert.equal(x.fields.confidence, "mid");
  const y = await readPhoto(fakeClient((p) => (p === "B" ? badRequest() : ok(p))).client, "x", "high");
  assert.equal(y.outcome, "done");
  if (y.outcome === "done") {
    assert.equal(y.fields.title, null);
    assert.equal(y.fields.error_code, "observe_api_error");
    assert.equal(y.fields.needs_retake, true);
    assert.equal(y.fields.confidence, "mid");
    assert.match(y.fields.rank_reason, /物の観察ができませんでした/);
    assert.doesNotMatch(y.fields.rank_reason, /見つかっていません/);
  }
});

test("B が断られ文字も無ければ failed にする。手がかり無しとして埋めない", async () => {
  const f = fakeClient((p) => (p === "B" ? "refusal" : { lines: [] }));
  const r = await readPhoto(f.client, "x", "high");
  assert.equal(r.outcome, "failed");
  if (r.outcome === "failed") assert.equal(r.code, "observe_refused");
});

test("文字の無い写真は確からしさを出さない", async () => {
  const f = fakeClient((p) => (p === "B" ? obs({ evidence: ["白い"] }) : { lines: [] }));
  const r = await readPhoto(f.client, "x", "high");
  assert.equal(r.outcome, "done");
  if (r.outcome === "done") assert.equal(r.fields.confidence, null);
});

test("見えたことが空なら、もう 1 回だけ観察を頼む", async () => {
  const f = fakeClient((p, n) => (p === "B" ? (n === 1 ? obs({ evidence: [] }) : obs({ evidence: ["白い紙"] })) : okRead));
  const r = await readPhoto(f.client, "x", "high");
  assert.equal(f.count.B, 2);
  if (r.outcome === "done") {
    assert.deepEqual(r.fields.reading.b!.evidence, ["白い紙"]);
    assert.equal(r.guard.evidence_empty, false);
  }
  const g = fakeClient((p) => (p === "B" ? obs({ evidence: [] }) : okRead));
  const r2 = await readPhoto(g.client, "x", "high");
  assert.equal(g.count.B, 2, "2 回で止める");
  if (r2.outcome === "done") assert.equal(r2.guard.evidence_empty, true);
});

test("話題だけの作り直しは、見立てだけを受け取る。見えたことは消えない", async () => {
  const first = obs({ evidence: ["青い線がある", "角が折れている"], inferences: ["通院の記録かもしれません"] });
  const redo = obs({ kind: "別の物", evidence: [], inferences: ["趣味の道具かもしれません"] });
  const f = fakeClient((p, n) => (p === "B" ? (n === 1 ? first : redo) : okRead));
  const r = await readPhoto(f.client, "x", "high");
  assert.equal(r.outcome, "done");
  if (r.outcome === "done") {
    assert.deepEqual(r.fields.reading.b!.evidence, ["青い線がある", "角が折れている"]);
    assert.equal(r.fields.reading.b!.kind, first.kind);
    assert.deepEqual(r.fields.reading.b!.inferences, ["趣味の道具かもしれません"]);
    assert.equal(r.guard.evidence_empty, false);
  }
});

test("判断の語の作り直しが空の見えたことを返しても、前の見えたことを残す", async () => {
  const first = obs({ evidence: ["青い線がある"], inferences: ["大切な品かもしれません"] });
  const redo = obs({ evidence: [], inferences: [] });
  const f = fakeClient((p, n) => (p === "B" ? (n === 1 ? first : redo) : okRead));
  const r = await readPhoto(f.client, "x", "high");
  if (r.outcome === "done") {
    assert.deepEqual(r.fields.reading.b!.evidence, ["青い線がある"]);
    assert.deepEqual(r.fields.reading.b!.inferences, []);
  } else assert.fail("done になるはず");
});

test("健康、お金、人間関係の見立ては作り直し、残れば消す。種類と見えたことは残す", async () => {
  const dirty = obs({
    kind: "薬の箱",
    evidence: ["白い箱に青い線がある"],
    inferences: ["通院の記録かもしれません", "家庭で使う物かもしれません", "趣味の道具かもしれません"],
  });
  const f = fakeClient((p) => (p === "B" ? dirty : okRead));
  const r = await readPhoto(f.client, "x", "high");
  assert.equal(f.count.B, 2);
  assert.equal(r.outcome, "done");
  if (r.outcome === "done") {
    assert.equal(r.fields.reading.b!.kind, "薬の箱");
    assert.deepEqual(r.fields.reading.b!.inferences, ["家庭で使う物かもしれません", "趣味の道具かもしれません"]);
    assert.equal(r.fields.search_terms.inference.some((t) => t.includes("通院")), false);
    assert.equal(r.guard.topic_removed, 1);
  }
});

test("見えたことから下げた文にも話題の検査が掛かる", () => {
  const down = downgrade(obs({ evidence: ["昭和の病院の封筒"] }), []);
  assert.equal(down.observation.inferences.length, 1);
  assert.deepEqual(removeTopics(down.observation).observation.inferences, []);
});

test("判断の語は 1 回作り直す。直れば消さず、残れば項目ごと消す", async () => {
  const dirty = obs({ inferences: ["大切な物かもしれません"] });
  const f1 = fakeClient((p, n) => (p === "B" ? (n === 1 ? dirty : obs()) : okRead));
  const r1 = await readPhoto(f1.client, "x", "high");
  assert.equal(f1.count.B, 2);
  if (r1.outcome === "done") assert.deepEqual([r1.guard.banned_hits, r1.guard.banned_removed], [1, 0]);
  const f2 = fakeClient((p) => (p === "B" ? dirty : okRead));
  const r2 = await readPhoto(f2.client, "x", "high");
  assert.equal(f2.count.B, 2);
  assert.equal(r2.outcome, "done");
  if (r2.outcome === "done") {
    assert.deepEqual(r2.fields.reading.b!.inferences, []);
    assert.equal(r2.guard.banned_removed, 1);
  }
});
