# YukariNote

捨てる前に現場の物を撮っておくと、その場にいない親族も、あとから中身を見て「待った」をかけられるアプリです。

Built with Claude Japan 2026 ハッカソンの提出作品です。

## 試す

**https://matta-box.digital-lab.workers.dev/**

入口で合言葉を聞かれます（合言葉は提出フォームに書いています）。入ったら「見本で試す」で、架空の家族の見本を開けます。料金を守るため、Claude で読む写真は全体で 1 日 50 枚までです。

## 誰の、何の課題を解くか

親族の家の片付けで、本人に聞けず、時間や衛生の制約もあるとき、中身を見ないまま「全部捨てる」ことになる場合があります。作者の体験でも、全部を捨てる予定だった家を引き渡しの前に見直すと、古い写真や手作りの物が見つかりました。見直す人がいなければ、そのまま処分されていました。

その場で中身を見る人がいない理由は、遠い・忙しい・体力がない・疎遠など、ふつうにあります。YukariNote は、この「待った」の役割を、その場にいない家族にも渡します。

- 撮るのは誰でもよく、見直して決めるのは家族です
- Claude は「大切です」「捨ててよい」とは言いません。写真から読めた文字と見えた物を返すだけで、判断は家族がします
- 本人への効果は、まだ確かめていません

## 主な機能

コードで存在を確かめたものだけを書いています。画面は `src/web`（React 版）です。

| 機能 | 中身 | 確かめた場所 |
|---|---|---|
| 撮って 3 択で仕分け | 物を撮り、「残したい／迷う／処分したい」を選ぶ。API の値は `keep`／`unsure`／`drop`。端末で EXIF を外し、5MiB に収め、送れなかった写真は IndexedDB に残す | `src/web/src/screens/Capture.tsx`、`src/web/src/lib/`、`src/web/README.md` |
| Claude が文字と物を読む | 写真 1 枚につき Claude を 4 回、並列で呼ぶ（文字読み、人名・日付・数字の再読、物の観察、対象と背景）。読めた文字、見えた物、見立てを分けてカードに出す | `src/src/ai/pipeline.ts`、`src/src/ai/read.ts` |
| 順位と確からしさ | 一覧は手がかりの多い順。順位と確からしさは Claude ではなくコードで計算する | `src/src/ai/rank.ts`、`src/src/ai/confidence.ts`、`src/README.md` |
| 物どうしのつながり | 「つながり」画面で、あなたに関係しそうな物と、物どうしのつながりを、開かずに見られる | `src/web/src/screens/Home.tsx` |
| 人カード | 物から見えてきた人を札にまとめる。名前の訂正、家族が足す情報、札と参加者の結びつけ | `src/web/src/screens/People.tsx`、`src/src/routes/people.ts`、`src/src/ai/persons.ts` |
| 待った | 1 人でも押せば残す。押した人とひとことが残る。取り消しもできる | `src/src/routes/items.ts`（`/:iid/wait`） |
| 招待 | 作成者が名前を入れて招待リンクを出し、相手は開くだけで参加する。本人用のリンクも出せる。ログイン画面は無い | `src/src/routes/people.ts`、`src/src/routes/session.ts`、`src/README.md` |
| 捨てる前の確認 | 「処分したい」の物から、待ったの付いた物を抜くための画面 | `src/web/src/screens/Check.tsx` |
| 背景の見落としの知らせ | 写真の背景にある手がかり（紙の束に混じった手書きのメモなど）を、写真ごと・箱ぜんたいで問いかけにする。根拠の文が物の記録にあるかをコードで確かめ、無ければ外す | `src/src/ai/scene.ts`、`src/src/ai/notices.ts`、`src/CONTRACT.md` |
| 記憶係 | Managed Agents のメモリで、日や箱をまたいで背景の手がかりを覚え、つながりを知らせる。片付け 1 つにメモリストア 1 つ。設定が無いときは、箱の知らせを 1 回の呼び出しで作る | `src/src/ai/memory.ts`、`src/scripts/ai/memory-setup.mjs` |
| 探す | 読めた文字や見立てから探す | `src/src/routes/search.ts`、`src/web/src/screens/Search.tsx` |
| 見本で試す | 架空の家族の 12 点の物が入った見本。ログイン不要、24 時間で消える | `src/README.md`、`src/src/sample/` |
| 料金の守り | 1 日の読み取り枚数などの上限と、Claude の呼び出しを止めるスイッチ | `src/README.md`（「守り」）、`src/src/usage.ts` |

画面だけで持っていて、サーバにも親族にも共有されないもの：仕分け先（置き場）、捨てる前の確認の「抜いた」印。端末の localStorage にだけ残ります。

作っていないもの：動画からの読み取り、自動撮影、現場の音声、場所の記録、部屋の 3D、業者が撮る形、OAuth のログイン、ゲストの継続。

## Claude の使い方

モデル名は `src/src/ai/read.ts` の定数 `MODEL`、`JUDGE_MODEL` と、`src/scripts/ai/memory-setup.mjs` から確かめました。呼び出しは `client.beta.messages.create`（beta `server-side-fallback-2026-07-01`、JSON スキーマの構造化出力、effort は `medium`）です。

| 場面 | モデル | 呼び出し |
|---|---|---|
| 文字読み（A）、人名・日付・数字の再読（A2）、物の観察（B）、対象と背景（C） | `claude-sonnet-5-5` | 写真 1 枚につき 4 回、並列 |
| 人物の仮説の更新 | `claude-sonnet-5-5` | 5 枚ごとか 60 秒（`src/CONTRACT.md`）。`askClaude` の既定モデル |
| 箱ぜんたいの知らせの判定（N） | `claude-opus-5-5` | 文だけを 1 箱に 1 回。記憶係が無いときの経路 |
| 記憶係 | `claude-opus-5-5` | Managed Agents のエージェントとして作成（`memory-setup.mjs`）。メモリストアを読み書きして知らせを返す |

- 11/08 に読み取りを Opus から Sonnet へ替えました。実写真 17 枚の試しで、見落としの知らせは Sonnet でも足りると判断した、とコードのコメントにあります
- Claude に判断はさせません。順位・確からしさ・知らせの根拠の検査はコードで行います
- 写真の中の文字は読む対象で、命令として扱いません（読み取りと記憶係の指示文に明記）

## 使った技術と、動作に必要な環境

| 層 | 技術 | 版（package.json の記載） |
|---|---|---|
| API | TypeScript、Hono | hono 4.13.16、typescript 7.0.2 |
| 実行環境 | Cloudflare Workers（ローカルは wrangler dev）、D1、R2、Queues、cron | wrangler 4.158.0 |
| Claude | Anthropic SDK | @anthropic-ai/sdk 1.6.0 |
| 画面（React 版） | React、Vite、TypeScript | react 19.3.1、vite 8.3.6 |
| 試験 | Playwright | 1.65.0 |
| 書体 | BIZ UDPGothic、BIZ UDPMincho（Google Fonts から読み込む） | |

要るもの：

- Node.js 24
- Claude の API キー。記憶係を使うなら、Managed Agents が使えるキー
- Cloudflare のログインは要りません。ローカルでは D1 と R2 を手元に置いて動きます
- 画面の書体を外部から読むため、画面を開く PC にネット接続が要ります

## セットアップと実行

`src/README.md`、`src/web/README.md`、`src/package.json`、`src/scripts/dev.mjs` に書いてある手順だけを並べました。

### 1. API を動かす

```bash
git clone <このリポジトリ>
cd <リポジトリ>/src
npm ci
cp .dev.vars.example .dev.vars
```

`.dev.vars` は `.dev.vars.example` を写して、値を入れます（項目は `.dev.vars.example` を見てください）。`.dev.vars` は Git に入りません。人に渡さないでください。

データの置き場所は、リポジトリの外にします（写真をリポジトリに残さないため）。

```bash
export MATTA_STATE_DIR="$HOME/matta-box-state"   # PowerShell は $env:MATTA_STATE_DIR = "$HOME\matta-box-state"
npm run db:migrate
npm run dev      # http://localhost:8791
```

`db:migrate` と `dev` は同じ置き場所で動かします。

### 2. 画面（React 版）を出す

別のターミナルで動かします。

```bash
cd src/web
npm ci
npm run dev        # http://localhost:5173/app/ 。/api は 127.0.0.1:8791 へ流れる
```

API と同じ 8791 番から出すときは、ビルドします。結果は `src/public/app/` に出て、`http://localhost:8791/app/` で開けます（`/` を開いても `/app/` へ移ります）。`public/app/` は Git に入れていないので、配備の前に必ずビルドします。素の HTML で作った前の版の画面は `/?legacy` で開けます。

```bash
npm run build
```

### 3. 記憶係を作る（任意・初回だけ）

`.dev.vars` に `ANTHROPIC_API_KEY` を入れたうえで、`src` で次を 1 回だけ実行します。

```bash
node scripts/ai/memory-setup.mjs
```

出力された 2 つの ID（`MEMORY_AGENT_ID`、`MEMORY_ENV_ID`）を `.dev.vars` に足します。指示文を変えたときは `node scripts/ai/memory-setup.mjs update` です。2 つの ID が無いときは、記憶係を使わずに動きます。実行すると Anthropic 側にエージェントと実行環境が作られます。

### 4. 型の確かめ

```bash
npm run typecheck      # src で
npm run typecheck      # src/web で
```

### 見本で試す、同じ Wi-Fi のスマホで試す

手順は `src/README.md` の「まず見本で試す」「同じ Wi-Fi のスマホで試す」にあります。見本の中で撮ると本物の Claude を呼ぶので、料金がかかります。

## デモ動画

準備中です。

## 開発の流れと Claude の使い方

期間（11/2〜11/8）中の開発の流れ、決めたこと、Claude と Claude Code の使い方は [docs/開発の流れ.md](docs/開発の流れ.md) にまとめています。作品の仕様は [docs/仕様.md](docs/仕様.md) です。

## フォルダの案内

| 場所 | 内容 |
|---|---|
| [docs/](docs/) | 仕様、開発の流れ |
| [src/](src/) | 実装。API（`src/src/`）、画面（`src/web/`）、マイグレーション、スクリプト。詳しい決まりは [src/README.md](src/README.md)、[src/CONTRACT.md](src/CONTRACT.md)、[src/web/README.md](src/web/README.md) |
