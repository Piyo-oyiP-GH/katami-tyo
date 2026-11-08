// 見本の架空データ。登場する人も物もすべて作りごと。実在の人や本物の読み取りは入れない。
// 読み取り A、再読 A2、観察 B の形で書く。確からしさ、点数、理由、検索の語は load.ts が
// 本物の読み取りと同じコードで計算するので、ここには書かない。Claude は呼ばない。
// 画像は make-images.mjs がここの文字から生成する。
import type { ItemReading, Level, Pile, ReadLine, TextType } from "../types";

export type SampleItem = ItemReading & {
  key: string;
  title: string;
  pile: Pile;
  blur?: number; // 画像をぼかす量。ぼけた画像は確からしさの上限が low になる
  paper:
    | "letter"
    | "photo"
    | "note"
    | "card"
    | "award"
    | "box"
    | "cup"
    | "board"
    | "greeting"
    | "recipe"
    | "manual";
};

const line = (
  text: string,
  type: TextType,
  handwritten: boolean,
  where: string,
  certainty: Level = "high",
): ReadLine => ({ text, type, handwritten, where, certainty });

export const SAMPLE_MEMBERS = [
  { key: "yuta", display_name: "ゆうた" },
  { key: "misaki", display_name: "みさき" },
  { key: "kenji", display_name: "けんじ" },
];

export const SAMPLE_ITEMS: SampleItem[] = [
  {
    key: "letter",
    title: "手書きの手紙",
    pile: "unsure",
    paper: "letter",
    a: {
      lines: [
        line("山里 はな 様", "name", true, "上の左"),
        line("庭の梅が咲きました", "other", true, "真ん中"),
        line("昭和四十八年 三月二日", "date", true, "下の右"),
        line("川辺 みつ", "name", true, "下の右"),
      ],
    },
    a2: {
      lines: [
        line("山里 はな 様", "name", true, "上の左"),
        line("昭和四十八年 三月二日", "date", true, "下の右"),
        line("川辺 みつ", "name", true, "下の右"),
      ],
    },
    b: {
      kind: "手紙",
      synonyms: ["便り", "便箋", "ふみ"],
      evidence: ["便箋が 1 枚", "青いインクの手書き", "文の中に「梅が咲」と見える字がある"],
      signals: ["手書き", "宛名や署名", "古び"],
      inferences: ["季節のあいさつを書いた便りに見える"],
    },
  },
  {
    key: "photo",
    title: "裏に書き込みのある紙焼き写真",
    pile: "keep",
    paper: "photo",
    a: {
      lines: [
        line("一九七二年 夏", "date", true, "裏の上"),
        line("河口湖にて はな", "name", true, "裏の真ん中"),
      ],
    },
    a2: {
      lines: [
        line("一九七二年 夏", "date", true, "裏の上"),
        line("はな", "name", true, "裏の真ん中"),
      ],
    },
    b: {
      kind: "紙焼き写真",
      synonyms: ["写真", "プリント", "アルバム"],
      evidence: ["白いふちの付いた紙焼き", "裏に鉛筆の書き込み"],
      signals: ["手書き", "紙焼きの原本", "古び"],
      inferences: ["旅行のときに撮った写真かもしれない"],
    },
  },
  {
    key: "award",
    title: "俳句大会の賞状",
    pile: "keep",
    paper: "award",
    a: {
      lines: [
        line("賞状", "other", false, "上の真ん中"),
        line("山里 はな 殿", "name", false, "真ん中"),
        line("第十二回 若葉句会", "other", false, "下"),
        line("昭和五十五年 五月", "date", false, "下"),
      ],
    },
    a2: {
      lines: [
        line("山里 はな 殿", "name", false, "真ん中"),
        line("昭和五十五年 五月", "date", false, "下"),
      ],
    },
    b: {
      kind: "賞状",
      synonyms: ["表彰状", "俳句", "句会"],
      evidence: ["厚手の紙に印刷", "縁に飾りの線"],
      signals: ["宛名や署名", "古び"],
      inferences: ["俳句の会に出ていた人のものに見える"],
    },
  },
  {
    key: "score",
    title: "ゴルフのスコアカード",
    pile: "drop",
    paper: "card",
    a: {
      lines: [
        line("緑ヶ丘カントリー倶楽部", "other", false, "上"),
        line("山里 正一", "name", true, "名前の欄"),
        line("1986.10.12", "date", true, "日付の欄"),
        line("OUT 48 IN 51", "number", true, "下"),
      ],
    },
    a2: {
      lines: [
        line("山里 正一", "name", true, "名前の欄"),
        line("1986.10.12", "date", true, "日付の欄"),
        line("48", "number", true, "下"),
        line("51", "number", true, "下"),
      ],
    },
    b: {
      kind: "スコアカード",
      synonyms: ["ゴルフ", "スコア表", "記録"],
      evidence: ["細長い厚紙", "鉛筆で数字の書き込み"],
      signals: ["手書き"],
      inferences: ["休みの日にゴルフをしていた人のものに見える"],
    },
  },
  {
    key: "note",
    title: "俳句の手帳",
    pile: "unsure",
    paper: "note",
    a: {
      lines: [
        line("句帳 はな", "name", true, "表紙", "mid"),
        line("風鈴や 〔不明〕 の午後", "other", true, "1 行目", "mid"),
        line("平成二年", "date", true, "ページの端", "mid"),
      ],
    },
    a2: {
      lines: [
        line("句帳 はな", "name", true, "表紙", "mid"),
        line("平成三年", "date", true, "ページの端", "low"),
      ],
    },
    b: {
      kind: "手帳",
      synonyms: ["ノート", "俳句", "句帳", "日記"],
      evidence: ["布の表紙", "万年筆の細い字が並ぶ"],
      signals: ["手書き", "古び"],
      inferences: ["自分で作った俳句を書きためた手帳かもしれない"],
    },
  },
  {
    key: "postcard",
    title: "文字がぼけた葉書",
    pile: "drop",
    blur: 5,
    paper: "letter",
    a: {
      lines: [
        line("〔不明〕 みつ", "name", true, "左下", "low"),
        line("〔不明〕 お元気ですか", "other", true, "真ん中", "low"),
      ],
    },
    a2: { lines: [line("〔不明〕", "name", true, "左下", "low")] },
    b: {
      kind: "葉書",
      synonyms: ["はがき", "便り", "手紙"],
      evidence: ["官製はがきの大きさ", "手書きの字があるが、ぼけている"],
      signals: ["手書き", "宛名や署名"],
      inferences: ["近況を知らせる便りかもしれない"],
    },
  },
  {
    key: "parts",
    title: "ボタンの入った缶",
    pile: "drop",
    paper: "box",
    a: { lines: [line("ボタン 大小", "other", true, "ふたの札", "mid")] },
    a2: { lines: [] },
    b: {
      kind: "ボタンの缶",
      synonyms: ["裁縫", "手芸", "缶"],
      evidence: ["丸い缶に服のボタンが入っている", "ふたに手書きの札"],
      signals: ["手書き"],
      inferences: ["服を直すときのために取っておいたのかもしれない"],
    },
  },
  {
    key: "cup",
    title: "湯のみ",
    pile: "drop",
    paper: "cup",
    a: { lines: [] },
    a2: { lines: [] },
    b: {
      kind: "湯のみ",
      synonyms: ["茶碗", "食器"],
      evidence: ["青い線の入った陶器"],
      signals: [],
      inferences: [],
    },
  },
  {
    key: "board",
    title: "寄せ書きの色紙",
    pile: "unsure",
    paper: "board",
    a: {
      lines: [
        line("山里 はなさんへ", "name", true, "真ん中の上"),
        line("十年間 ありがとうございました", "other", true, "真ん中"),
        line("若葉句会 一同", "name", true, "下"),
        line("平成十五年 春", "date", true, "下"),
      ],
    },
    a2: {
      lines: [
        line("山里 はなさんへ", "name", true, "真ん中の上"),
        line("若葉句会 一同", "name", true, "下"),
        line("平成十五年 春", "date", true, "下"),
      ],
    },
    b: {
      kind: "色紙",
      synonyms: ["寄せ書き", "サイン色紙", "句会"],
      evidence: ["四角い厚紙", "色の違うペンで字が並ぶ"],
      signals: ["手書き", "宛名や署名"],
      inferences: ["句会の人たちが書いた色紙かもしれない"],
    },
  },
  {
    key: "greeting",
    title: "手書きの誕生日カード",
    pile: "unsure",
    paper: "greeting",
    a: {
      lines: [
        line("ゆうたへ", "name", true, "上"),
        line("七才 おめでとう", "other", true, "真ん中"),
        line("二〇〇三年 六月", "date", true, "下"),
      ],
    },
    a2: {
      lines: [
        line("ゆうたへ", "name", true, "上"),
        line("二〇〇三年 六月", "date", true, "下"),
      ],
    },
    b: {
      kind: "カード",
      synonyms: ["誕生日カード", "バースデーカード", "メッセージカード"],
      evidence: ["二つ折りの厚紙", "色鉛筆で描いた風船"],
      signals: ["手書き", "宛名や署名"],
      inferences: ["子どもの誕生日に書いたカードに見える"],
    },
  },
  {
    key: "recipe",
    title: "手書きの料理メモ",
    pile: "drop",
    paper: "recipe",
    a: {
      lines: [
        line("はなの茶碗蒸し", "other", true, "上"),
        line("卵 三個 だし 二カップ", "other", true, "真ん中"),
        line("弱火で十五分", "other", true, "下", "mid"),
      ],
    },
    a2: { lines: [] },
    b: {
      kind: "料理メモ",
      synonyms: ["レシピ", "作り方", "献立"],
      evidence: ["罫線の入ったカード", "油のしみがある"],
      signals: ["手書き", "古び"],
      inferences: ["家で作る料理の作り方を書きとめたものかもしれない"],
    },
  },
  {
    key: "manual",
    title: "電気ポットの説明書",
    pile: "drop",
    paper: "manual",
    a: {
      lines: [
        line("電気ポット 取扱説明書", "other", false, "表紙の上"),
        line("型番 KP-220", "number", false, "表紙の下"),
      ],
    },
    a2: { lines: [line("KP-220", "number", false, "表紙の下")] },
    b: {
      kind: "取扱説明書",
      synonyms: ["説明書", "マニュアル", "家電"],
      evidence: ["印刷された冊子", "表紙に製品の絵"],
      signals: [],
      inferences: [],
    },
  },
];

export const SAMPLE_PERSONS: {
  key: string;
  subtype: "owner" | "relative" | "friend" | "vague";
  label: string;
  linked?: string; // 参加者と人が結び付けた札。名前の一致で自動では結ばない
}[] = [
  { key: "hana", subtype: "owner", label: "山里 はな" },
  { key: "shoichi", subtype: "relative", label: "山里 正一" },
  { key: "mitsu", subtype: "friend", label: "川辺 みつ" },
  { key: "yuta", subtype: "relative", label: "ゆうた", linked: "yuta" },
  { key: "kukai", subtype: "vague", label: "若葉句会の人たち" },
];

// 強さは load.ts が、関連する物の数から計算する（家族の書き足しには付かない）
export const SAMPLE_CLAIMS: {
  person: string;
  source: "photo" | "family" | "claude";
  text: string;
  author?: string;
  items: string[];
}[] = [
  {
    person: "hana",
    source: "photo",
    text: "宛名や裏書きに名前が読める",
    items: ["letter", "photo", "award", "board"],
  },
  { person: "mitsu", source: "photo", text: "手紙の署名に名前が読める", items: ["letter"] },
  {
    person: "hana",
    source: "claude",
    text: "俳句を続けていた人かもしれない",
    items: ["award", "note", "board"],
  },
  {
    person: "kukai",
    source: "photo",
    text: "賞状と色紙に、同じ会の名前が読める",
    items: ["award", "board"],
  },
  { person: "shoichi", source: "photo", text: "スコアカードの名前の欄に読める", items: ["score"] },
  {
    person: "shoichi",
    source: "claude",
    text: "休みの日にゴルフをしていたかもしれない",
    items: ["score"],
  },
  { person: "yuta", source: "photo", text: "誕生日カードの宛名に名前が読める", items: ["greeting"] },
  {
    person: "mitsu",
    source: "family",
    text: "川辺さんは、はなさんの古い友だちのはず",
    author: "yuta",
    items: ["letter"],
  },
  {
    person: "hana",
    source: "family",
    text: "春になると句会の話をしていました",
    author: "misaki",
    items: ["note"],
  },
];

export const SAMPLE_WAITS: { item: string; user: string; note: string | null }[] = [
  { item: "letter", user: "yuta", note: "字を見てみたいです" },
  { item: "note", user: "misaki", note: null },
  { item: "note", user: "yuta", note: null },
  { item: "recipe", user: "misaki", note: "作り方を残したいです" },
  { item: "score", user: "kenji", note: "父の字か確かめたいです" },
];
