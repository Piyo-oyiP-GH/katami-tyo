// Claude の観察を、保存してよい形に直す。
// 1 判断の語を見つける  2 文字の裏付けが無い固有名詞や年を見立てに下げる
// 3 健康、お金、人間関係の見立てを消す
import type { Observation, ReadResult } from "../types";
import { normalize, UNKNOWN } from "./confidence";
import type { RawObservation } from "./types";

// 判断の語。プロンプトの禁止語も、ここから作る
export const JUDGE_WORDS = [
  "大切",
  "貴重",
  "捨て",
  "重要",
  "大事",
  "価値",
  "処分",
  "廃棄",
  "不要",
  "不用",
  "高価",
  "残すべき",
  "思い入れ",
  "宝物",
  "かけがえ",
  "思い出深",
  "愛着",
  "手放",
  "破棄",
  "不必要",
];
export const JUDGE_WORDS_TEXT = JUDGE_WORDS.map((w) => `「${w}」`).join("");

// かなの書き方と、言い換え。「すてる」は、ステンレスなどに当たらないよう活用の形で見る
const JUDGE_VARIANTS =
  "たいせつ|タイセツ|だいじ|ダイジ|じゅうよう|ジュウヨウ|きちょう(?!めん)|しょぶん|ショブン|" +
  "すて(?:て|る|ら|た|よ|ま)|いらない|要らない|必要ない|必要のない|必要は(?:な|あり)|必要が(?:な|あり)|" +
  "思い出の(?!アルバム)|形見|記念の品|特別な(?:品|物|もの|存在)|お宝|たからもの|てばな|ゴミ|ごみ|がらくた|ガラクタ";

// 「残す」「取っておく」「保管する」は、ふつうの文にも出る（記録を残す習慣、取っておいた手紙）。
// 語だけでは止めず、勧める形と活用で止める
const GOOD = "(?:よ|良|いい)";
const BETTER = `(?:と${GOOD}|べき|(?:の|方|ほう)が${GOOD})`; // 「〜とよい」「〜のがよい」「〜方がいい」
const KEEP_ADVICE =
  `残(?:す(?:候補|必要|かどうか|${BETTER})|し(?:ましょう|たい|た(?:方|ほう)が|て(?:も|は)?${GOOD}|ておく${BETTER}|ておき(?:たい|ましょう)|ておいて(?:も|は)${GOOD}|ておいた(?:方|ほう)が)|さ(?:なくて|ない|なけれ|ずに${GOOD}))|` +
  `(?:取|と)って(?:お|置)(?:きたい|きましょう|く${BETTER}|いて(?:も|は)${GOOD}|いた(?:方|ほう)が)|` +
  `(?:保管|保存)(?:すべき|しましょう|した(?:方|ほう)が|する${BETTER}|しておく${BETTER})`;
// 言い切りの勧め。「手放してもよさそうです」「よいでしょう」。「とても良い」は勧めではない
const VERDICT = "(?<!と)ても(?:よい|良い|いい|よさそう|よろしい)|てよい|て良い|てよさそう|(?:よい|良い|いい)でしょう";
export const BANNED = new RegExp(
  `${JUDGE_WORDS.join("|")}|${JUDGE_VARIANTS}|${KEEP_ADVICE}|${VERDICT}`,
  "u",
);

// 物の名前で、判断ではない語。先に外してから調べる。「使い捨てる」は動詞なので外さない
const OBJECT_NOUNS =
  /使い捨て(?![てるたらよま])|貴重品(?:袋|入れ|ケース|ボックス)|重要文化財|重要無形|ダイジェスト|大事典|だいじょうぶ|ゴミ(?:箱|袋|収集|ばさみ)|ごみ(?:箱|袋|収集|ばさみ)/gu;
export const judges = (text: string) => BANNED.test(text.normalize("NFKC").replace(OBJECT_NOUNS, ""));

// 健康、お金、人間関係の話題。誤って止める分には害が小さいので、広めに止める
const TOPICS = new RegExp(
  [
    // 健康
    "病|薬|医|通院|入院|手術|介護|看護|健康|体調|認知症|障害|診察|診断|検診|健診|治療|療養|持病|処方|服用|服薬|点滴|血圧|血糖|透析|歯科|リハビリ|車椅子|補聴器|見舞|老眼|視力",
    "びょう(?:いん|き)|くすり|かいご|にゅういん|つういん|けんこう",
    // お金
    "お金|金銭|借金|貯金|預金|収入|所得|年収|給料|給与|財産|資産|遺産|相続|年金|保険|ローン|負債|節約|裕福|貧|経済的|家計|投資|通帳|口座|銀行|株(?!式)|家賃|税金|確定申告|残高|返済|融資|支払|高額|現金|売って|売却|売買|売れ",
    "おかね|しゃっきん|ちょきん|ぎんこう|つうちょう",
    // 人間関係
    "友人|友達|親友|知人|恋人|愛人|夫婦|夫妻|妻|(?<![工丈])夫|親子|父|母|息子|娘|兄|弟|姉|妹|祖父|祖母|孫|親戚|親族|家族|不倫|離婚|再婚|結婚|仲が|仲良|仲間|同僚|同級|同窓|上司|部下|恩師|師匠|人間関係|交際|付き合い|奥さん|主人|嫁|婿|彼女|彼氏|親し|知り合い|贈|恋",
    "ともだち|こいびと|かぞく|ふうふ|しんせき",
  ].join("|"),
  "u",
);
export const blockedTopic = (text: string) => TOPICS.test(text.normalize("NFKC"));

// 写真の字の引用。『』と直線の引用符も同じに扱う
const QUOTE = /「([^」]*)」|『([^』]*)』|"([^"]*)"|“([^”]*)”/g;
const quotes = (text: string) =>
  [...text.matchAll(QUOTE)].map((m) => m.slice(1).find((g) => g !== undefined) ?? "");
export const FALLBACK_TITLE = "不明な物";

// ---- 文字の裏付け ----
// 読みにくい行は裏付けにしない。〔不明〕の所で切るので、「山〔不明〕田」は「山田」の裏付けにならない
const SEP = "\u0001";
export function readTexts(reads: (ReadResult | null)[]): string {
  return reads
    .flatMap((r) => r?.lines.filter((l) => l.certainty !== "low") ?? [])
    .flatMap((l) => l.text.split(UNKNOWN).map(normalize))
    .filter(Boolean)
    .join(SEP);
}

const wholeLines = (reads: (ReadResult | null)[]) =>
  reads.flatMap((r) => r?.lines.map((l) => normalize(l.text)) ?? []).filter(Boolean);

const supportedBy = (read: string, token: string) => {
  const n = normalize(token);
  return !n || read.includes(n);
};

// 写真の字をそのまま引用しただけなら、判断の語として数えない。
// 行の全体か、5 字以上の引用だけ。短い引用は判断の語の抜き書きと区別できない
function isTranscription(inner: string, lines: string[]): boolean {
  const n = normalize(inner);
  if (!n) return false;
  return lines.some((l) => l === n || (n.length >= 5 && l.includes(n)));
}

function hasBanned(text: string, lines: string[]): boolean {
  const unquoted = text.replace(QUOTE, (m, ...groups: unknown[]) => {
    const inner = groups.slice(0, 4).find((g) => typeof g === "string") as string;
    return isTranscription(inner, lines) ? "" : m;
  });
  return judges(unquoted);
}

// 判断の語を含む項目の数
export function countBanned(b: Observation, reads: (ReadResult | null)[]): number {
  const lines = wholeLines(reads);
  return [b.kind, ...b.synonyms, ...b.evidence, ...b.inferences].filter((t) => hasBanned(t, lines))
    .length;
}

// 作り直しても残った項目を、語だけでなく項目ごと消す
export function removeBanned(b: RawObservation, reads: (ReadResult | null)[]): RawObservation {
  const lines = wholeLines(reads);
  const keep = (t: string) => !hasBanned(t, lines);
  const synonyms = b.synonyms.filter(keep);
  return {
    ...b,
    kind: keep(b.kind) ? b.kind : (synonyms[0] ?? FALLBACK_TITLE),
    synonyms,
    evidence: b.evidence.filter(keep),
    inferences: b.inferences.filter(keep),
  };
}

// 話題の検査は見立てに掛ける。物の種類（薬、通帳など）と見えた事実は対象にしない。
// ただし「見えたこと」に書かれた推測は、見立てと同じに扱う
const GUESS = /らしい|らしく|ようだ|ようです|ように見え|していた|していました|と思われ|推測|おそらく|たぶん/u;
const blockedEvidence = (t: string) => GUESS.test(t) && blockedTopic(t);

export const countTopics = (b: Pick<Observation, "inferences" | "evidence">) =>
  b.inferences.filter(blockedTopic).length + b.evidence.filter(blockedEvidence).length;

export function removeTopics(b: Observation): { observation: Observation; removed: number } {
  const inferences = b.inferences.filter((t) => !blockedTopic(t));
  const evidence = b.evidence.filter((t) => !blockedEvidence(t));
  const moved = b.moved?.filter((t) => inferences.includes(t));
  return {
    observation: { ...b, inferences, evidence, ...(moved ? { moved } : {}) },
    removed: b.inferences.length - inferences.length + b.evidence.length - evidence.length,
  };
}

// ---- 固有名詞らしい語 ----
// B が自分で申告した一覧だけに頼らず、形で拾う。辞書は持たないので、全部は拾えない。
// 拾いすぎても、見えたことが見立てに移るだけで済む
const YEAR = /(?:明治|大正|昭和|平成|令和)\s*(?:\d+|元)\s*年?|(?:19|20)\d{2}\s*年?|\d{2,4}\s*年/g;
const BARE_ERA = /明治|大正|昭和|平成|令和/g;
const KANJI_NUM = "〇零一二三四五六七八九十百千";
const KANJI_YEAR = new RegExp(
  `(?:明治|大正|昭和|平成|令和)\\s*(?:[${KANJI_NUM}]+|元)\\s*年?|[${KANJI_NUM}]{2,}\\s*年`,
  "g",
);
const LONG_NUMBER = /\d{2,}(?:-\d+)+|\d{3,}/g;
const HONORED_NAME = /\p{Script=Han}{2,5}(?=\s*(?:さん|様|さま|氏|殿|先生|君|ちゃん))/gu;
// 「様」「さま」で終わるが人名でない語。先に外す。水玉模様の「水玉模」を名前と見ない
const NOT_HONORIFIC = /模様|文様|仕様|同様|異様|多様|一様|左様|逆さま|さまざま/gu;
// 署名の欄に書かれた、敬称の無い名前。「差出人の署名」の類は名前ではない
const SIGNED_NAME = /\p{Script=Han}{2,6}(?=の(?:署名|サイン|記名|自筆|筆跡))/gu;
const NOT_SIGNER =
  /^(?:差出人|受取人|宛先|本人|筆者|作者|持ち主|所有者|送り主|手書き|直筆|自筆|鉛筆|万年筆|墨|(?:封筒|葉書|写真|色紙|賞状|手紙|表紙|本文|文書|書類)?(?:右下|左下|右上|左上|右端|左端|下部|上部|中央|末尾|文末|裏面|表面|裏側|表側|裏|表|隅)?)$/u;
const PLACE =
  /北海道|青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|東京|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|京都|大阪|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄/gu;
const MAKER =
  /(?:\p{Script=Katakana}[\p{Script=Katakana}ー]+|[A-Za-z][A-Za-z0-9&.-]+)(?=社?製|ブランド|のロゴ|の製品|の商品)/gu;
const MATERIAL =
  /^(?:プラスチック|ステンレス|アルミ|アルミニウム|スチール|ビニール|ビニル|ナイロン|ゴム|ガラス|ブリキ|ポリエステル|ウレタン|シリコン|シリコーン|カーボン|アクリル|レザー|セラミック|ホーロー|メタル|ウール|コットン|ポリ|チタン)$/u;
const COMPANY =
  /[\p{Script=Han}\p{Script=Katakana}ー]{2,}(?:株式会社|商店|商会|工業|電機|製作所|百貨店)/gu;
const LATIN = /[A-Za-z][A-Za-z0-9-]{2,}/g;
const COMMON_LATIN = /^(?:USB|LED|DVD|CD-?R?|HDMI|SIM|LCD|PDF|ISBN|JAN|QR|AC|DC|IC|PC|TV|SD)$/i;
const BRANDS =
  /ソニー|ヤマハ|パナソニック|ナショナル|東芝|日立|シャープ|三菱|キヤノン|ニコン|カシオ|セイコー|シチズン|トヨタ|ホンダ|日産|任天堂|マイクロソフト|サンリオ|ディズニー|ナイキ|アディダス|ミズノ|タイガー|象印|コクヨ|ゼブラ|パイロット/gu;

function nameLikeTokens(n: string): string[] {
  return [
    ...(n.match(YEAR) ?? []),
    ...(n.match(KANJI_YEAR) ?? []),
    ...(n.match(LONG_NUMBER) ?? []),
    ...(n.match(BARE_ERA) ?? []),
    ...(n.replace(NOT_HONORIFIC, "　").match(HONORED_NAME) ?? []),
    ...(n.match(SIGNED_NAME) ?? []).filter((t) => !NOT_SIGNER.test(t)),
    ...(n.match(PLACE) ?? []),
    ...(n.match(MAKER) ?? []).filter((t) => !MATERIAL.test(t)),
    ...(n.match(COMPANY) ?? []),
    ...(n.match(LATIN) ?? []).filter((t) => !COMMON_LATIN.test(t)),
    ...(n.match(BRANDS) ?? []),
  ];
}

export function unsupportedTokens(text: string, nouns: string[], read: string): string[] {
  const n = text.normalize("NFKC");
  const tokens = [
    ...nouns.filter((p) => normalize(p) && normalize(n).includes(normalize(p))),
    ...quotes(text),
    ...nameLikeTokens(n),
  ];
  return tokens.filter((t) => !supportedBy(read, t));
}

// 時代、地名、製造元のような語は、字の綴りを言い切らない。「かもしれません」を付ければ見立てにできる。
// 引用、人名、型番などは写真の字を言い切る文なので、見立てにも残さない（読めない字を補わない）
const SOFT_TOKEN = new RegExp(
  `^(?:${[YEAR, KANJI_YEAR, BARE_ERA, PLACE, BRANDS].map((r) => r.source).join("|")})$`,
  "u",
);
const isSoft = (token: string, text: string) =>
  SOFT_TOKEN.test(token) ||
  [...text.normalize("NFKC").matchAll(MAKER)].some((m) => m[0] === token);

// 「〜かもしれません」の形でない文を、その形に直す
const HEDGED_END = /かもしれ(?:ません|ない)[。.]?$/u;
export function hedge(sentence: string): string {
  const t = sentence.trim();
  if (HEDGED_END.test(t)) return t;
  const stem = t
    .replace(/[。.]+$/u, "")
    .replace(/(?:よう|らしい)(?:です|だ)$/u, "")
    .replace(/でした$/u, "だった")
    .replace(/です$/u, "")
    .replace(/だ$/u, "")
    .replace(/あります$/u, "ある")
    .replace(/います$/u, "いる")
    .replace(/ました$/u, "た")
    .replace(/見えます$/u, "見える")
    .replace(/ます$/u, "る");
  return `${stem}かもしれません。`;
}

// A と A2 に無い固有名詞や年は「見えた」に置かない。
// 綴りを言い切る文は消す。時代や地名の文は、言い切らない形にして見立てへ下げる。
// 下げた文は moved に印を付け、検索の語には入れない
export function downgrade(
  b: RawObservation,
  reads: (ReadResult | null)[],
): { observation: Observation; downgraded: number } {
  const read = readTexts(reads);
  const tokensOf = (t: string) => unsupportedTokens(t, b.proper_nouns, read);
  const isBad = (t: string) => tokensOf(t).length > 0;
  const isHard = (t: string) => tokensOf(t).some((k) => !isSoft(k, t));

  const failed = [...b.evidence.filter(isBad), ...b.synonyms.filter(isBad)];
  const synonyms = b.synonyms.filter((t) => !isBad(t));
  let kind = b.kind;
  if (isBad(kind)) {
    failed.push(kind);
    kind = synonyms[0] ?? FALLBACK_TITLE;
  }
  const moved = failed.filter((t) => !isHard(t)).map(hedge);
  // Claude の見立ても同じ。読めていない字を言い切る文は残さず、形をそろえる
  const inferences = b.inferences.filter((t) => !isHard(t)).map(hedge);
  return {
    observation: {
      kind,
      synonyms,
      evidence: b.evidence.filter((t) => !isBad(t)),
      signals: b.signals,
      inferences: [...inferences, ...moved],
      moved,
      // 画面には出さない。録画モードで隠す語に使う
      proper_nouns: b.proper_nouns,
    },
    downgraded: failed.length + (b.inferences.length - inferences.length),
  };
}
