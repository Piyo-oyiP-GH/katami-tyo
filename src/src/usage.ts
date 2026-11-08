// T8 の守り。回数の上限と、読み取りを止めるスイッチ。上限はキューに積む前に確かめる。
// 値は環境変数（.dev.vars）で変えられる。

export const LIMITS = {
  PROJECT_DAILY: 300, // 本物の片付け 1 つの、1 日の読み取り枚数
  SAMPLE_PHOTOS: 10, // 見本 1 つで読める枚数。見本は 24 時間で消える
  IP_DAILY: 300, // 同じ接続元からの、1 日の読み取り枚数
  SAMPLE_IP_DAILY: 20, // 同じ接続元が見本の中で読める、1 日の枚数
  TOTAL_DAILY: 500, // 全体の 1 日の読み取り枚数
  GUEST_IP_DAILY: 10, // 同じ接続元が作れる、1 日の見本の数
  GUEST_TOTAL_DAILY: 100, // 全体で作れる、1 日の見本の数
  PROJECT_IP_DAILY: 20, // 同じ接続元が作れる、1 日の片付けの数
  PERSONS_DAILY: 100, // 片付け 1 つの、1 日の人物の更新の回数
  SAMPLE_PERSONS: 10, // 見本 1 つの、人物の更新の回数
} as const;

type Knobs = Partial<Record<keyof typeof LIMITS | "READING_OFF", string>>;

export function limitOf(env: Env, name: keyof typeof LIMITS): number {
  const raw = (env as unknown as Knobs)[name];
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : LIMITS[name];
}

// 環境変数 READING_OFF=1 で、Claude の呼び出しを全部止める
export const readingOff = (env: Env) => (env as unknown as Knobs).READING_OFF === "1";

// 日本時間の日付
export const today = (now = Date.now()) => new Date(now + 9 * 3600_000).toISOString().slice(0, 10);

export type Quota = { key: string; limit: number; code: string };

// まとめて 1 回分を数える。どれかが上限を超えたら全部戻し、超えた上限の code を返す。通れば null
export async function take(env: Env, quotas: Quota[]): Promise<string | null> {
  const day = today();
  const results = await env.DB.batch<{ n: number }>(
    quotas.map((q) =>
      env.DB.prepare(
        `INSERT INTO usage_counts (key, n, day) VALUES (?, 1, ?)
         ON CONFLICT (key) DO UPDATE SET n = n + 1 RETURNING n`,
      ).bind(q.key, day),
    ),
  );
  const over = quotas.find((q, i) => (results[i]?.results[0]?.n ?? 0) > q.limit);
  if (!over) return null;
  await env.DB.batch(
    quotas.map((q) => env.DB.prepare("UPDATE usage_counts SET n = n - 1 WHERE key = ?").bind(q.key)),
  );
  return over.code;
}

// 写真 1 枚の読み取りの分。読み直しも同じ額がかかるので同じに数える
export function photoQuotas(env: Env, pid: string, isSample: boolean, ip: string): Quota[] {
  const d = today();
  return [
    isSample
      ? { key: `sp:${pid}`, limit: limitOf(env, "SAMPLE_PHOTOS"), code: "limit_sample" }
      : { key: `p:${pid}:${d}`, limit: limitOf(env, "PROJECT_DAILY"), code: "limit_project" },
    isSample
      ? { key: `sip:${ip}:${d}`, limit: limitOf(env, "SAMPLE_IP_DAILY"), code: "limit_ip" }
      : { key: `ip:${ip}:${d}`, limit: limitOf(env, "IP_DAILY"), code: "limit_ip" },
    { key: `all:${d}`, limit: limitOf(env, "TOTAL_DAILY"), code: "limit_total" },
  ];
}

export function guestQuotas(env: Env, ip: string): Quota[] {
  const d = today();
  return [
    { key: `gip:${ip}:${d}`, limit: limitOf(env, "GUEST_IP_DAILY"), code: "limit_guest" },
    { key: `gall:${d}`, limit: limitOf(env, "GUEST_TOTAL_DAILY"), code: "limit_guest" },
  ];
}

export const projectQuotas = (env: Env, ip: string): Quota[] => [
  { key: `pip:${ip}:${today()}`, limit: limitOf(env, "PROJECT_IP_DAILY"), code: "limit_new_project" },
];

export function personsQuota(env: Env, pid: string, isSample: boolean): Quota[] {
  return [
    isSample
      ? { key: `spc:${pid}`, limit: limitOf(env, "SAMPLE_PERSONS"), code: "limit_sample" }
      : { key: `pc:${pid}:${today()}`, limit: limitOf(env, "PERSONS_DAILY"), code: "limit_project" },
  ];
}
