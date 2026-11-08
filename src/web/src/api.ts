// API の呼び出し。型は Worker 側の定義をそのまま使う（API は変えない）。
export type {
  ClaimSource,
  ItemStatus,
  Level,
  Pile,
  PersonSubtype,
  ReadLine,
  SearchSource,
  WaitResponse,
  WaitView,
  GuestResponse,
  InviteResponse,
  ParticipantView,
} from "../../src/types";
export type {
  BoxNoticeX,
  ClaimX,
  Correction,
  InviteListItem,
  InviteListResponse,
  ItemCardX,
  ItemDetailX,
  ItemListX,
  MeX,
  PersonX,
  PersonsX,
  RelatedItem,
  SearchX,
} from "../../src/routes/types";

export class ApiError extends Error {
  status: number;
  code: string;
  data: unknown;
  constructor(status: number, code: string, data: unknown = null) {
    super(code);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

type Opts = { method?: string; json?: unknown; body?: BodyInit; headers?: HeadersInit };

export async function api<T>(path: string, { method = "GET", json, body, headers }: Opts = {}): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: json !== undefined ? { "content-type": "application/json" } : headers,
    body: json !== undefined ? JSON.stringify(json) : body,
  });
  if (res.status === 204) return null as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? "unknown", data);
  return data as T;
}

// サーバの失敗の言葉。今の画面（public/js/util.js）と同じ文
const ERROR_TEXT: Record<string, string> = {
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
  invite_invalid: "この招待は使えません。送った人に確かめてください。",
  bad_params: "入力を確かめてください。",
};
export const errorText = (code: string | null | undefined) => (code ? (ERROR_TEXT[code] ?? null) : null);

// 判断の言葉。API の値は keep／unsure／drop のまま、画面の言葉だけを変える
export const PILES = ["keep", "unsure", "drop"] as const;
export const PILE_NAMES: Record<string, string> = { keep: "残したい", unsure: "迷う", drop: "処分したい" };

export const SOURCE_NAMES: Record<string, string> = {
  text: "文字で一致",
  name: "物名で一致",
  synonym: "類義語で一致",
  inference: "見立てで一致",
};
export const SUBTYPE_NAMES: Record<string, string> = {
  owner: "持ち主",
  relative: "親族",
  friend: "友人や知人",
  vague: "はっきりしない人",
};

export const itemTitle = (item: { title: string | null; kind?: string | null; seq: number }) =>
  item.title ?? item.kind ?? `物 ${item.seq}`;
