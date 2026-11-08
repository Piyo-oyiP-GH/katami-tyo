# 契約書（AI 担当と画面担当の境目）

仕様は `idea/plan-v2.md`。ここは、2人が同じファイルを触らずに並行で作るための決まりを書く。
パスはすべて、このフォルダ（リポジトリの `src/`）から見た相対パス。だから Worker のコードは `src/src/` にある。

## 1. 担当

| 場所 | 担当 |
|---|---|
| `src/ai/`、`scripts/ai/` | AI 担当 |
| `src/routes/`、`public/`、`scripts/app/` | 画面担当 |
| `src/index.ts`、`src/types.ts`、`wrangler.jsonc`、`migrations/0001_init.sql`、`package.json`、`scripts/dev.mjs`、`scripts/e2e-photo.mjs`、`CONTRACT.md` | 共有。さわらない |

- 共有ファイルは2人とも変えない。変えたいときは、変えずに結果の報告に書く
- 新しい型は自分の側に置く。AI 担当は `src/ai/types.ts`、画面担当は `src/routes/types.ts`
- 新しいパッケージが要るときも、入れずに報告に書く
- 列を足すときは新しいマイグレーションを作る。AI 担当は `migrations/01xx_*.sql`、画面担当は `migrations/02xx_*.sql`
- `src/ai/` から `src/routes/` を import しない。逆は `src/index.ts` と、訂正の計算し直しで `src/routes/items.ts` が `src/ai/index.ts` を呼ぶ。`src/usage.ts` と `src/maintain.ts` は両方から使う共通の部品

## 2. 動かし方

```
npm install
npm run db:migrate    # マイグレーションを当てる
npm run dev           # http://127.0.0.1:8791
npm run typecheck
npm run e2e:photo -- --photo <写真> --out <リポジトリの外のフォルダ> --name <結果の名前>
```

- `.dev.vars` に `ANTHROPIC_API_KEY` と `SESSION_SECRET` が要る（`.dev.vars.example` を参照）
- `wrangler dev` を直接呼ばない。必ず `npm run dev` を使う。D1 と R2 の中身をリポジトリの外へ置くため（既定はクローンした場所の 1 つ上の `.matta-state/wrangler-state`。`MATTA_STATE_DIR` で変えられる）
- 8787 番は別のサーバが使っていることがある。だから 8791 番に固定した
- 終わるときはサーバを止める。Windows では `workerd.exe` が残ることがある。止めるのは、コマンドラインに `Ry-bwc-works` を含むものだけ

## 3. キューと AI の関数

キューは 2 本。メッセージには番号だけを入れ、写真の本体は入れない。

| キュー | 束縛 | 仕事 | 同時実行 |
|---|---|---|---|
| `matta-read` | `READ_QUEUE` | `ReadItemJob` | 4 |
| `matta-persons` | `PERSONS_QUEUE` | `UpdatePersonsJob` | 1 |

`src/index.ts` の消費者は、次の 2 つだけを呼ぶ。名前と形を変えない。

```ts
// src/ai/index.ts
export function processItem(env: Env, job: ReadItemJob, final?: boolean): Promise<JobOutcome>; // final は最後の試行
export function updatePersons(env: Env, job: UpdatePersonsJob): Promise<JobOutcome>;

type ReadItemJob = { type: "read_item"; pid: string; iid: string; r2_key: string };
type UpdatePersonsJob = { type: "update_persons"; pid: string };
type JobOutcome = "done" | "failed" | "retry";
```

- `"done"` と `"failed"`：関数の中で items を書き終えている。消費者は ack するだけ
- `"retry"`：一時的な失敗。消費者が少し待って再実行する。4 回目も retry なら、消費者が `status='failed'`、`error_code='retry_exhausted'` にする
- 例外を投げたときは retry と同じ扱い
- 人物の更新を始めるのは AI 担当。`processItem` の最後で「5枚ごとか60秒」を判定し、`env.PERSONS_QUEUE.send(...)` する

いまの `processItem` は呼び出し A を 1 回だけ行う（T0b）。T2 では次の形で 3 回を並列にする。

```ts
// src/ai/read.ts（A はある。A2 と B は AI 担当が足す）
callReadAll(client, imageBase64): Promise<{ result: ReadResult; meta: AiCallMeta }>;  // A
callReread(client, imageBase64):  Promise<{ result: ReadResult; meta: AiCallMeta }>;  // A2
callObserve(client, imageBase64): Promise<{ result: Observation; meta: AiCallMeta }>; // B
```

11/08 追加：

```ts
callScene(client, imageBase64): Promise<{ result: RawScene; meta: AiCallMeta }>; // C 対象と背景、写真ごとの知らせ（失敗しても全体は止めない）
updateBoxNotices(env, pid): Promise<void>; // N 箱全体の写真をまたぐ知らせ。人物更新の仕事の入口で動き、projects.notices_json に書く
```

- モデル：A・A2・B・C と人物は `claude-sonnet-5-5`。N（文だけ、1 箱 1 回）は `claude-opus-5-5`
- C の結果は `reading_json.scene`（型 `Scene`）。線と知らせは、根拠の文がその物の客観にあるかをコードで確かめ、無ければ外す
- 一覧の API：カードに `notice`（写真ごとの問いかけ、無ければ null）、応答に `notices`（`{ say, item_ids }[]`）
- D1：`projects.notices_json`（0205）
- 記憶係（Managed Agents）：環境変数 `MEMORY_AGENT_ID` と `MEMORY_ENV_ID` があれば、N を記憶係のセッションに置き換える（`src/ai/memory.ts`）。片付け 1 つにメモリストア 1 つ（`projects.memory_store_id`）、渡し終えた所は `projects.memory_seq`、計測は `memory_meta_json`（0206）。知らせは回ごとに足し、新しい順に 6 つまで。失敗したら 1 回の呼び出しに戻す。片付けを消すときはメモリストアも消す
- 記憶係のエージェントと環境は `node scripts/ai/memory-setup.mjs` で 1 回だけ作る（指示を変えたら `update`）

Claude の呼び方（実際に動かして通った形）：`client.beta.messages.create` に `model: "claude-opus-5-5"`、`betas: ["server-side-fallback-2026-07-01"]`、`fallbacks: "default"`、`output_config: { effort, format: { type: "json_schema", schema } }`。

- `fallbacks` は beta の側にしかない
- スキーマの object には全部 `additionalProperties: false` を付ける
- `thinking: disabled` と `tool_choice` の強制は 400 になるので使わない（資料による。実行はしていない）
- `content` を読む前に `stop_reason` の `refusal` と `max_tokens` を見る
- base64 は `Buffer.from(buf).toString("base64")`（`node:buffer`）
- ログと `ai_meta_json` に、読んだ文字を出さない

## 4. D1 の列

全体は `migrations/0001_init.sql`。時刻は Unix ミリ秒。値の型は `src/types.ts`。

**AI 担当が書く列**

| 表 | 列 | 中身 |
|---|---|---|
| items | `status` | `queued`（画面担当が登録時に入れる）→ `reading` → `done`／`failed` |
| items | `title` | 物の名前。カードの見出し |
| items | `confidence` | `high`／`mid`／`low`。`min(本人申告, A と A2 の一致, image_ceiling)` |
| items | `rank_score`、`rank_reason` | 計画 3 章の式の点数と、平文 1 行の理由 |
| items | `search_terms` | `SearchTerms` の JSON |
| items | `needs_retake` | 読めない手書きがあれば 1 |
| items | `reading_json` | `ItemReading` の JSON。`a`、`a2`、`b` |
| items | `ai_meta_json` | `AiRunMeta` の JSON。計測だけ |
| items | `error_code` | `photo_missing`、`refused`、`truncated`、`api_error` など。`status='done'` で片方だけ失敗した物は `observe_*`（物の観察）か `read_*`（文字） |
| items | `updated_at` | 書くたびに更新する。一覧の更新の目印 |
| projects | `persons_seq`、`persons_updated_at` | 人物の仮説が読み終えた位置と時刻 |
| persons | 全部（`linked_user_id` を除く） | 新しい人物は `subtype` を決めて作る |
| claims | `source` が `photo`、`claude` の行 | `strength` はコードで計算する |
| claim_items | 上の claims の行 | 物の番号の実在を確かめてから入れる |
| projects | `persons_meta_json` | 人物の更新の計測。失敗も `error` に残し、人の画面に出す |

**AI 担当が読むだけの列**：items の `r2_key`、`pile`、`image_ceiling`、`correction_json`（家族の訂正。読み取りより優先する）、`seq`。claims の `source='family'` の行（入力に使うが、根拠の数に入れない）。

**画面担当が書く列**：上以外の全部。items の登録と `pile`、`correction_json`、family の claims、`persons.linked_user_id`、waits、invites、memberships、sessions、users。

- 全部の問い合わせに `project_id` の条件を付ける
- 「残す」は保存しない。`withdrawn_at IS NULL` の waits があれば残す

## 5. API

全部 JSON。失敗は `{ "error": "<code>" }`。`/api/p/:pid/*` は参加者だけが通れる。未ログインは 401、参加者でなければ 403。型は `src/types.ts`。

**できているもの**

| 方法とパス | 返す型 | メモ |
|---|---|---|
| `GET /api/health` | `{ ok: true }` | |
| `GET /api/me` | `MeResponse` | |
| `POST /api/guest` | `GuestResponse`（201） | 見本の project を作り Cookie を付ける。架空データの複製は T4c |
| `POST /api/p/:pid/items?pile=&ceiling=` | `UploadResponse`（202） | 本文は JPEG そのもの。`pile` は keep／drop／unsure。`ceiling` は high／mid／low で省略時 high。413 `photo_too_large`、415 `not_jpeg`、400 `bad_params` |
| `GET /api/p/:pid/items` | `ItemListResponse` | 手がかりの多い順 |
| `GET /api/p/:pid/items/:iid` | `ItemDetailResponse` | `claims` と `waits` はいま空 |
| `GET /api/p/:pid/items/:iid/photo` | JPEG | |
| `GET /api/p/:pid/items/:iid/thumb` | JPEG | `thumb.jpg` が無いと 404。登録の口は下 |

**これから画面担当が作るもの**（`src/routes/project.ts` に足す。いまは 501）

| 方法とパス | 返す型 | タスク |
|---|---|---|
| `PUT /api/p/:pid/items/:iid/thumb` | 204 | T1b。端末で作った縮小画像 |
| `POST /api/p/:pid/items/:iid/retry` | `UploadResponse` | T1c。キューに入れ直す |
| `POST /api/p/:pid/items/:iid/correction` | `ItemDetailResponse` | 「違う」ボタン |
| `POST`、`DELETE /api/p/:pid/items/:iid/wait` | `WaitResponse` | T4b。本文は `{ note? }`。note を送らなければ前のひとことを残し、空の文字で消す |
| `GET /api/p/:pid/search?q=` | `SearchResponse` | T3c。`matched.source` で一致元を出す |
| `GET /api/p/:pid/persons` | `PersonsResponse` | T5b |
| `POST /api/p/:pid/persons/:id/claims` | `ClaimView` | T5b。source は family |
| `POST /api/p/:pid/persons` | `PersonView`（201） | 本文は `{ label, subtype? }`。同じ名前は 409 `person_exists` と `person_id` |
| `PATCH /api/p/:pid/persons/:id` | 204 | 本文は `{ subtype?, label? }`。名前を直すと元の読みを `read_label` に残し、物とのつながりはその字で確かめ続ける。同じ名前は 409 |
| `POST /api/p/:pid/persons/confirm-name` | `{ person_id }`（201、もう結んであれば 200） | 本文は `{ item_id, line, person_id? }`。訂正した人名の行を札に結ぶ。family の項目として残し、強さの数には入れない |
| `POST /api/p/:pid/invites` | `InviteResponse` | T4a。本文は `{ display_name }`。見本では 400 |
| `DELETE /api/p/:pid/invites/:id` | 204 | T4a。止めた招待にもう一度送っても何も変えない |
| `POST /api/invite/:token` | `GuestResponse` と同じ形 | T4a。`src/routes/session.ts` に足す。`startSession` を使う。組み合わせの表は session.ts の頭。409 `invite_other_user`、`scoped_session` |
| `POST /api/p/:pid/self-link` | `{ url }`（201） | 本人用のリンク。別の端末と、作成者の戻り道。開いたセッションはこの片付けだけ |

**守り（T8）**：`POST /items` と `POST /retry` は、上限で 429（`limit_sample`、`limit_project`、`limit_ip`、`limit_total`）、スイッチで 503（`reading_stopped`）を返す。`POST /guest` と `POST /projects` も 429。値は `src/usage.ts`。

## 6. 写真の大きさ

実測（ローカル、`claude-opus-5-5`、T0b）。

- 原寸の 4.03MB（base64 で 5.38MB）も、5.22MB（base64 で 6.97MB）も、そのまま受け付けられた。base64 の長さでは止まらない
- `MAX_PHOTO_BYTES` は 5MiB（5,242,880 バイト）。これを超えると Worker は 413 を返す
- 5.22MB より上は Claude に送って試していない
- 手元の実写真は 19 枚中 4 枚が 5MiB を超える。**T1b で、超えるときだけ端末で画質を下げてから送る処理が要る**。これが無いと、その写真は登録で止まる

## 7. 守ること

- 実写真をリポジトリに入れない。読めた文字を、リポジトリの中のどのファイルにも書かない（テスト、ログ、資料も）
- テストの出力は `../.matta-state/` の下に置く（リポジトリの外）。写真の場所は引数で渡す
- 見本は架空のデータだけ。画像も生成する
- `.dev.vars` の中身を表示しない。コードやログに鍵を書かない
- 作らないものは計画の 9 章
