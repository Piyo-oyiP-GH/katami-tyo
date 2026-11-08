// 記憶係（Managed Agents）。片付け 1 つにメモリストアを 1 つ持ち、日や箱をまたいで背景の手がかりを覚える。
// 新しく読み終えた物の scene（文だけ）を渡し、記憶を読み書きさせ、写真をまたぐ知らせを返させる。
// エージェントと実行環境は scripts/ai/memory-setup.mjs で 1 回だけ作り、id を環境変数に置く。
// 2 日分の写真を通して確かめた形。
import Anthropic from "@anthropic-ai/sdk";
import type { BoxNotice, ItemReading, Scene } from "../types";
import { blockedTopic, judges } from "./guard";

type MemoryVars = { MEMORY_AGENT_ID?: string; MEMORY_ENV_ID?: string };
const MAX_NEW = 30; // 1 回に渡す物の数。残りは次の回
const BUDGET_CENTS = "100"; // 1 回の上限 1 ドル（list cost）
const TIMEOUT_MS = 5 * 60 * 1000;

export const memoryOn = (env: Env) => {
  const v = env as unknown as MemoryVars;
  return !!(v.MEMORY_AGENT_ID && v.MEMORY_ENV_ID);
};

export type MemoryRun = {
  notices: BoxNotice[];
  dropped: number;
  sent: number;
  seconds: number;
  list_cost: string | null; // セント
  error?: string;
};

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");
const factsOf = (s: Scene) => [s.subject, ...s.background].flatMap((t) => t.objective.map((o) => norm(o.text)));

async function storeFor(env: Env, client: Anthropic, pid: string): Promise<string> {
  const row = await env.DB.prepare("SELECT memory_store_id FROM projects WHERE id = ?")
    .bind(pid)
    .first<{ memory_store_id: string | null }>();
  if (row?.memory_store_id) return row.memory_store_id;
  const store = await client.beta.memoryStores.create({
    name: "katazuke-kioku",
    description:
      "1 つの片付け（実家）で見つけた、背景の手がかりのメモ。1 手がかり 1 ファイル。どの物（No.番号）の写真か、写真から取れた文、何回目の記録で見たか、知らせ済みかを書く。",
  });
  // 同時に 2 つ作らないよう、空のときだけ書く。負けたら作った分を消して、勝った方を使う
  const won = await env.DB.prepare(
    "UPDATE projects SET memory_store_id = ? WHERE id = ? AND memory_store_id IS NULL RETURNING id",
  )
    .bind(store.id, pid)
    .first();
  if (won) return store.id;
  await client.beta.memoryStores.delete(store.id).catch(() => {});
  return (await env.DB.prepare("SELECT memory_store_id FROM projects WHERE id = ?").bind(pid).first<{ memory_store_id: string }>())!
    .memory_store_id;
}

// 新しい物が無ければ null（前の知らせをそのまま使う）
export async function runMemory(env: Env, pid: string): Promise<MemoryRun | null> {
  const v = env as unknown as MemoryVars;
  const proj = await env.DB.prepare("SELECT memory_seq FROM projects WHERE id = ?")
    .bind(pid)
    .first<{ memory_seq: number }>();
  const { results } = await env.DB.prepare(
    "SELECT id, seq, reading_json FROM items WHERE project_id = ? AND status = 'done' AND reading_json IS NOT NULL ORDER BY seq",
  )
    .bind(pid)
    .all<{ id: string; seq: number; reading_json: string }>();
  const all = results.flatMap((r) => {
    try {
      const scene = (JSON.parse(r.reading_json) as ItemReading).scene;
      return scene ? [{ id: r.id, seq: r.seq, scene }] : [];
    } catch {
      return [];
    }
  });
  const fresh = all.filter((r) => r.seq > (proj?.memory_seq ?? 0)).slice(0, MAX_NEW);
  if (!fresh.length) return null;

  const started = Date.now();
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2 });
  const storeId = await storeFor(env, client, pid);
  const records = fresh.map(({ seq, scene }) => ({
    item: `No.${seq}`,
    subject: { kind: scene.subject.kind, objective: scene.subject.objective },
    background: scene.background.map((b, i) => ({ ref: `背景${i + 1}`, kind: b.kind, visibility: b.visibility, objective: b.objective })),
  }));

  const session = await client.beta.sessions.create({
    agent: v.MEMORY_AGENT_ID!,
    environment_id: v.MEMORY_ENV_ID!,
    title: `YukariNote 記憶係 ${pid.slice(0, 8)}`,
    budget: { type: "limit", max_list_cost: { amount: BUDGET_CENTS, currency: "USD" } },
    resources: [
      {
        type: "memory_store",
        memory_store_id: storeId,
        access: "read_write",
        instructions: "この片付けの、これまでの記録で見つけた背景の手がかり。始めに読み、終わりに書き足す。",
      },
    ],
  });
  let last = "";
  let error: string | undefined;
  try {
    const stream = await client.beta.sessions.events.stream(session.id);
    await client.beta.sessions.events.send(session.id, {
      events: [
        {
          type: "user.message",
          content: [{ type: "text", text: `新しく撮った物の記録です（${records.length} 点）。\n${JSON.stringify(records)}` }],
        },
      ],
    });
    for await (const ev of stream) {
      if (Date.now() - started > TIMEOUT_MS) {
        error = "timeout";
        break;
      }
      if (ev.type === "agent.message") {
        last = ev.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      } else if (ev.type === "agent.tool_use" && ev.evaluated_permission === "ask") {
        // 見ている人がいないので、判断のつかない道具は断る
        await client.beta.sessions.events.send(session.id, {
          events: [{ type: "user.tool_confirmation", tool_use_id: ev.id, result: "deny" }],
        });
      } else if (ev.type === "session.status_idle") {
        if (ev.stop_reason.type !== "requires_action") break;
      } else if (ev.type === "session.status_terminated") {
        break;
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.name : "unknown";
  }
  const done = await client.beta.sessions.retrieve(session.id).catch(() => null);
  await client.beta.sessions.archive(session.id).catch(() => {});

  type Raw = { notices?: { say?: string; items?: string[]; basis?: string[] }[] };
  let raw: Raw | null = null;
  try {
    raw = JSON.parse(last.slice(last.indexOf("{"), last.lastIndexOf("}") + 1)) as Raw;
  } catch {
    error ??= "bad_json";
  }

  // 見張り：番号が実在し、根拠の文がそれぞれ、名指しした物の客観にあるか
  const bySeq = new Map(all.map((r) => [r.seq, r]));
  const proposed = raw?.notices ?? [];
  const notices = proposed.slice(0, 3).flatMap((n) => {
    const members = [...new Set((n.items ?? []).map((s) => Number(String(s).replace(/\D/g, ""))))]
      .map((seq) => bySeq.get(seq))
      .filter((m) => !!m);
    const say = (n.say ?? "").trim();
    const basis = n.basis ?? [];
    if (members.length < 2 || !basis.length || !say || judges(say) || blockedTopic(say)) return [];
    const facts = members.flatMap((m) => factsOf(m.scene));
    const ok = basis.every((b) => norm(b).length >= 2 && facts.some((f) => f.includes(norm(b)) || norm(b).includes(f)));
    return ok ? [{ say, item_ids: members.map((m) => m.id), basis }] : [];
  });

  // 渡し終えた所まで進める。答えが壊れていても、記憶は書かれているので進める
  if (!error || error === "bad_json") {
    await env.DB.prepare("UPDATE projects SET memory_seq = MAX(memory_seq, ?) WHERE id = ?")
      .bind(fresh[fresh.length - 1]!.seq, pid)
      .run();
  }
  const usage = (done as { usage?: { list_cost?: { amount?: string } } } | null)?.usage;
  return {
    notices,
    dropped: proposed.length - notices.length,
    sent: fresh.length,
    seconds: (Date.now() - started) / 1000,
    list_cost: usage?.list_cost?.amount ?? null,
    ...(error ? { error } : {}),
  };
}

// 片付けを消すとき、メモリストアも消す。失敗しても片付けの削除は止めない
export async function deleteMemory(env: Env, storeId: string | null) {
  if (!storeId) return;
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1 });
  await client.beta.memoryStores.delete(storeId).catch(() => {});
}
