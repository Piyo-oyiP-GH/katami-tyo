// 公開版の入口の合言葉。ACCESS_CODE（秘密の設定）があるときだけ効く。手元の開発では設定しなければ素通り。
// 合言葉はサーバでだけ照合し、合えば署名付きの cookie を渡す。合言葉を変えると、前の cookie は効かなくなる。
// 総当たりは、接続元ごとの 1 日の試行回数で止める。
import type { Context, Next } from "hono";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import { take, today } from "./usage";

const COOKIE = "yk_access";
const TRIES_PER_IP = 30;
const MAX_AGE_DAYS = 30;

type AccessVars = { ACCESS_CODE?: string };
const codeOf = (env: Env) => (env as unknown as AccessVars).ACCESS_CODE ?? "";
export const accessOn = (env: Env) => codeOf(env).length > 0;

// 大文字小文字・全角半角・空白の違いは同じとみなす
const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();

async function sha(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 長さが同じ 16 進どうしを、時間の差が出ないように比べる
function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

// cookie の中身。合言葉のハッシュに結びつける
const ticket = async (env: Env) => `v1.${(await sha(`access:${norm(codeOf(env))}`)).slice(0, 32)}`;

async function hasAccess(c: Context): Promise<boolean> {
  const v = await getSignedCookie(c, c.env.SESSION_SECRET, COOKIE);
  return typeof v === "string" && same(v, await ticket(c.env));
}

// /api/* の前に置く。合言葉を通っていなければ 401
export async function requireAccess(c: Context, next: Next) {
  if (!accessOn(c.env)) return next();
  const path = new URL(c.req.url).pathname;
  if (path === "/api/health" || path === "/api/access") return next();
  if (await hasAccess(c)) return next();
  return c.json({ error: "access_required" }, 401);
}

// 画面が最初に聞く。合言葉が要るか、もう通っているか
export async function getAccess(c: Context) {
  if (!accessOn(c.env)) return c.json({ required: false, ok: true });
  return c.json({ required: true, ok: await hasAccess(c) });
}

export async function postAccess(c: Context) {
  if (!accessOn(c.env)) return c.json({ ok: true });
  const ip = c.req.header("cf-connecting-ip") ?? "local";
  const over = await take(c.env, [{ key: `acc:${ip}:${today()}`, limit: TRIES_PER_IP, code: "limit_access" }]);
  if (over) return c.json({ error: over }, 429);
  const body = await c.req.json<{ code?: unknown }>().catch(() => ({}) as { code?: unknown });
  const given = typeof body.code === "string" ? body.code.slice(0, 200) : "";
  if (!given || !same(await sha(norm(given)), await sha(norm(codeOf(c.env))))) {
    return c.json({ error: "access_denied" }, 403);
  }
  await setSignedCookie(c, COOKIE, await ticket(c.env), c.env.SESSION_SECRET, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:",
    maxAge: MAX_AGE_DAYS * 86400,
  });
  return c.json({ ok: true });
}
