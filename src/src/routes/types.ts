// 画面担当の型。共有の src/types.ts は変えず、足す分だけここに置く。
import type {
  ClaimView,
  ItemCard,
  ItemDetailResponse,
  MeResponse,
  PersonView,
  PersonsResponse,
  SearchSource,
} from "../types";

// 一覧のカードに足す分。種類と理由チップ
export type ItemCardX = ItemCard & {
  kind: string | null;
  chips: string[];
  corrected: boolean;
  stale: boolean; // 読み取り中のまま止まっている
  can_retry: boolean; // もう一度読める
  notice: string | null; // 写真の背景で見落としやすい物の問いかけ。多くの物では null
};

// items.correction_json の形。読み取りより優先する
export type Correction = {
  title?: string; // 物の名前の訂正
  // 画面に出す行の番号 → 正しい文字。行は reading.checked（無ければ a.lines）の並び
  lines?: Record<string, { text: string; original: string | null }>;
  by: { id: string; display_name: string };
  at: number;
};

export type RelatedItem = { id: string; seq: number; title: string | null; thumb_url: string };

// 強さの元になった物。確からしさが「はっきり」の読みだけ
// linked_name は、この人物に結び付いた参加者の名前。結び付いていなければ null
export type ClaimX = ClaimView & { clear_item_ids: string[]; seen_item_ids: string[]; linked_name: string | null };

// renamed は、家族が札の名前を直した印
export type PersonX = Omit<PersonView, "claims"> & { claims: ClaimX[]; renamed: boolean };
export type PersonsX = Omit<PersonsResponse, "persons"> & {
  persons: PersonX[];
  items: RelatedItem[]; // claims の item_ids が指す物
  updated_at: number | null; // 人物の更新が最後に走った時刻
  meta: unknown; // その回の計測。数だけ
};

export type ItemDetailX = Omit<ItemDetailResponse, "item" | "claims"> & {
  item: ItemCardX;
  claims: ClaimX[];
  correction: Correction | null;
  related: RelatedItem[];
};

// 写真をまたぐ知らせ。item_ids は items に含まれる物の id
export type BoxNoticeX = { say: string; item_ids: string[] };
export type ItemListX = { items: ItemCardX[]; notices: BoxNoticeX[] };
export type SearchX = {
  hits: { item: ItemCardX; matched: { source: SearchSource; term: string }[] }[];
};

export type MeX = Omit<MeResponse, "projects"> & {
  projects: (MeResponse["projects"][number] & { expires_at: number | null })[];
  scoped: boolean; // リンクで 1 つの片付けにだけ入っている
  limits: { sample_photos: number };
};

export type InviteListItem = {
  id: string;
  display_name: string;
  joined: boolean;
  joined_name: string | null; // 実際に入った人の名前。名前のある人が開くと、招待の名前と違う
  revoked: boolean;
  created_at: number;
};
export type InviteListResponse = { invites: InviteListItem[] };

// 録画モードで置き換える語。データは変えず、画面の上だけで使う
export type RecordTerms = {
  aliases: { term: string; alias: string }[];
  hidden: string[];
};
