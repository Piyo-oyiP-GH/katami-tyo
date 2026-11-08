// Worker の入口。共有ファイル。API は routes/、読み取りは ai/ に置く。
import { Hono } from "hono";
import { processItem, updateBoxNotices, updatePersons } from "./ai";
import { maintain } from "./maintain";
import { projectRoutes } from "./routes/project";
import { AppEnv, loadSession, sessionRoutes } from "./routes/session";
import { getAccess, postAccess, requireAccess } from "./access";
import type { JobOutcome, ReadItemJob, UpdatePersonsJob } from "./types";
import { readingOff } from "./usage";

const app = new Hono<AppEnv>();

app.get("/api/health", (c) => c.json({ ok: true }));
// 鍵が無いと署名で落ち、画面には通信の失敗に見える。原因を別の言葉で返す
app.use("/api/*", async (c, next) => {
  if (!c.env.SESSION_SECRET) return c.json({ error: "server_not_configured" }, 500);
  await next();
  // 応答を途中で保存させない（写真は各ルートで private を付けている）
  if (!c.res.headers.get("Cache-Control")) c.res.headers.set("Cache-Control", "no-store");
  c.res.headers.set("X-Content-Type-Options", "nosniff");
});
// 公開版の合言葉。通っていなければ、ここから先の API は 401
app.get("/api/access", getAccess);
app.post("/api/access", postAccess);
app.use("/api/*", requireAccess);
app.use("/api/*", loadSession);
app.route("/api", sessionRoutes);
app.route("/api/p/:pid", projectRoutes);
app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

const MAX_ATTEMPTS = 4; // wrangler.jsonc の max_retries 3 ＋ 最初の 1 回

async function markFailed(env: Env, job: ReadItemJob, code: string) {
  await env.DB.prepare(
    "UPDATE items SET status = 'failed', error_code = ?, updated_at = ? WHERE id = ? AND project_id = ?",
  )
    .bind(code, Date.now(), job.iid, job.pid)
    .run();
}

async function handleRead(msg: Message<ReadItemJob>, env: Env) {
  // スイッチが入っていれば、積まれた分も Claude を呼ばない。写真は残るので、後で読み直せる
  if (readingOff(env)) {
    await markFailed(env, msg.body, "reading_stopped");
    return msg.ack();
  }
  let outcome: JobOutcome;
  try {
    outcome = await processItem(env, msg.body, msg.attempts >= MAX_ATTEMPTS);
  } catch (e) {
    // 読んだ文字を出さないよう、種類だけ記録する
    console.error("processItem threw", e instanceof Error ? e.name : "unknown");
    outcome = "retry";
  }
  if (outcome !== "retry") return msg.ack();
  if (msg.attempts >= MAX_ATTEMPTS) {
    await markFailed(env, msg.body, "retry_exhausted");
    return msg.ack();
  }
  // 次の回が読み始める権利を取れるよう、待ちに戻す
  await env.DB.prepare(
    "UPDATE items SET status = 'queued', updated_at = ? WHERE id = ? AND project_id = ? AND status = 'reading'",
  )
    .bind(Date.now(), msg.body.iid, msg.body.pid)
    .run();
  msg.retry({ delaySeconds: 5 * msg.attempts });
}

async function handlePersons(msg: Message<UpdatePersonsJob>, env: Env) {
  // 箱の知らせは人物とは別に作る。失敗しても人物の更新は進める
  try {
    await updateBoxNotices(env, msg.body.pid);
  } catch (e) {
    console.error("updateBoxNotices threw", e instanceof Error ? e.name : "unknown");
  }
  try {
    const outcome = await updatePersons(env, msg.body);
    if (outcome === "retry" && msg.attempts < MAX_ATTEMPTS) return msg.retry({ delaySeconds: 30 });
  } catch (e) {
    console.error("updatePersons threw", e instanceof Error ? e.name : "unknown");
    if (msg.attempts < MAX_ATTEMPTS) return msg.retry({ delaySeconds: 30 });
  }
  msg.ack();
}

export default {
  fetch: app.fetch,
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(maintain(env));
  },
  async queue(batch: MessageBatch<ReadItemJob | UpdatePersonsJob>, env: Env) {
    for (const msg of batch.messages) {
      if (msg.body.type === "read_item") await handleRead(msg as Message<ReadItemJob>, env);
      else await handlePersons(msg as Message<UpdatePersonsJob>, env);
    }
  },
} satisfies ExportedHandler<Env, ReadItemJob | UpdatePersonsJob>;
