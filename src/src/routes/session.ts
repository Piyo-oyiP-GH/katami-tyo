// セッションと参加者の確認。署名 Cookie に 128bit 以上の乱数を入れ、D1 にはハッシュだけ持つ。
//
// 決まり
// - ログイン中の人のセッションを、別の人のものへ黙って置き換えない
// - 招待のリンクから入り直したセッションは、その片付けでだけ使える（sessions.project_id）
// - 入り直せるのは、招待で作られた人と、本人が発行したリンクだけ（invites.reentry）
import { Hono } from "hono";
import type { Context } from "hono";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { maintainSoon } from "../maintain";
import type { GuestResponse, UserView } from "../types";
import { sampleStatements, storeSamplePhotos } from "../sample/load";
import { guestQuotas, limitOf, projectQuotas, take } from "../usage";
import { clip } from "./cards";
import type { MeX } from "./types";

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: UserView | null;
    scope: string | null; // このセッションが閉じている片付け。null なら閉じていない
    role: "owner" | "member"; // requireMember の後だけ入る
    isSample: boolean; // requireMember の後だけ入る
  };
};

const COOKIE = "sid";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const RENEW_MS = 15 * 24 * 60 * 60 * 1000; // 残りがこれを切ったら延ばす
const SAMPLE_MS = 24 * 60 * 60 * 1000;

export async function sha256Hex(data: string | ArrayBuffer): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 接続元。D1 には短いハッシュだけを置く。無いときは全部を 1 つの接続元として数える
export async function clientKey(c: Context<AppEnv>): Promise<string> {
  const ip = c.req.header("cf-connecting-ip");
  return ip ? (await sha256Hex(ip)).slice(0, 16) : "local";
}

const writeCookie = (c: Context, env: Env, token: string, expires: number) =>
  setSignedCookie(c, COOKIE, token, env.SESSION_SECRET, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:",
    expires: new Date(expires),
  });

type SessionScope = { projectId?: string; inviteId?: string };

export async function startSession(c: Context, env: Env, userId: string, scope: SessionScope = {}) {
  const token = randomToken();
  const expires = Date.now() + SESSION_MS;
  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, expires_at, project_id, invite_id) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(await sha256Hex(token), userId, expires, scope.projectId ?? null, scope.inviteId ?? null)
    .run();
  await writeCookie(c, env, token, expires);
}

export const loadSession = createMiddleware<AppEnv>(async (c, next) => {
  c.set("user", null);
  c.set("scope", null);
  const token = await getSignedCookie(c, c.env.SESSION_SECRET, COOKIE);
  if (token) {
    const hash = await sha256Hex(token);
    const row = await c.env.DB.prepare(
      `SELECT u.id, u.display_name, u.is_guest, s.project_id, s.expires_at FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ?`,
    )
      .bind(hash, Date.now())
      .first<{
        id: string;
        display_name: string;
        is_guest: number;
        project_id: string | null;
        expires_at: number;
      }>();
    if (row) {
      c.set("user", { id: row.id, display_name: row.display_name, is_guest: !!row.is_guest });
      c.set("scope", row.project_id);
      // 使っている間は期限を延ばす。作成者には招待が無いので、切れると戻れない
      if (row.expires_at - Date.now() < RENEW_MS) {
        const expires = Date.now() + SESSION_MS;
        await c.env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").bind(expires, hash).run();
        await writeCookie(c, c.env, token, expires);
      }
    }
  }
  await next();
});

// /api/p/:pid/* の全部に掛ける。参加者でなければ、project の有無も教えない
export const requireMember = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "login_required" }, 401);
  const pid = c.req.param("pid")!;
  const scope = c.get("scope");
  if (scope && scope !== pid) return c.json({ error: "not_member" }, 403);
  const row = await c.env.DB.prepare(
    `SELECT m.role, p.is_sample FROM memberships m
     JOIN projects p ON p.id = m.project_id
     WHERE m.project_id = ? AND m.user_id = ? AND (p.expires_at IS NULL OR p.expires_at > ?)`,
  )
    .bind(pid, user.id, Date.now())
    .first<{ role: "owner" | "member"; is_sample: number }>();
  if (!row) return c.json({ error: "not_member" }, 403);
  c.set("role", row.role);
  c.set("isSample", !!row.is_sample);
  await next();
});

export const sessionRoutes = new Hono<AppEnv>();

sessionRoutes.get("/me", async (c) => {
  maintainSoon(c.env, (p) => c.executionCtx.waitUntil(p));
  const user = c.get("user");
  const limits = { sample_photos: limitOf(c.env, "SAMPLE_PHOTOS") };
  if (!user) return c.json<MeX>({ user: null, projects: [], scoped: false, limits });
  const scope = c.get("scope");
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.title, p.is_sample, p.expires_at, m.role FROM memberships m
     JOIN projects p ON p.id = m.project_id
     WHERE m.user_id = ?1 AND (p.expires_at IS NULL OR p.expires_at > ?2)
       AND (?3 IS NULL OR p.id = ?3)
     ORDER BY p.created_at DESC`,
  )
    .bind(user.id, Date.now(), scope)
    .all<{
      id: string;
      title: string;
      is_sample: number;
      expires_at: number | null;
      role: "owner" | "member";
    }>();
  return c.json<MeX>({
    user,
    projects: results.map((p) => ({ ...p, is_sample: !!p.is_sample })),
    scoped: !!scope,
    limits,
  });
});

// 「見本で試す」。独立の project を作り、架空データを複製する。expires_at に 24 時間後を記録し、
// 期限を過ぎた分は maintain.ts が D1 と R2 から消す。
// ログイン中の人が押しても Cookie を差し替えない。今の人に見本を足すので、元の片付けに戻れる
sessionRoutes.post("/guest", async (c) => {
  const current = c.get("user");
  if (c.get("scope")) return c.json({ error: "scoped_session" }, 409);
  const now = Date.now();
  if (current) {
    const live = await c.env.DB.prepare(
      `SELECT p.id FROM memberships m JOIN projects p ON p.id = m.project_id
       WHERE m.user_id = ? AND p.is_sample = 1 AND p.expires_at > ? LIMIT 1`,
    )
      .bind(current.id, now)
      .first<{ id: string }>();
    if (live) return c.json<GuestResponse>({ project_id: live.id, user: current });
  }
  const over = await take(c.env, guestQuotas(c.env, await clientKey(c)));
  if (over) return c.json({ error: over }, 429);

  const pid = crypto.randomUUID();
  const user: UserView = current ?? { id: crypto.randomUUID(), display_name: "ゲスト", is_guest: true };
  const sample = sampleStatements(c.env, pid, now);
  await storeSamplePhotos(c.env, pid, sample.itemIds);
  await c.env.DB.batch([
    ...(current
      ? []
      : [
          c.env.DB.prepare(
            "INSERT INTO users (id, display_name, is_guest, created_at) VALUES (?, ?, 1, ?)",
          ).bind(user.id, user.display_name, now),
        ]),
    c.env.DB.prepare(
      `INSERT INTO projects (id, title, is_sample, owner_user_id, created_at, expires_at)
       VALUES (?, '見本の片付け', 1, ?, ?, ?)`,
    ).bind(pid, user.id, now, now + SAMPLE_MS),
    c.env.DB.prepare(
      "INSERT INTO memberships (project_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
    ).bind(pid, user.id, now),
    ...sample.statements,
  ]);
  if (!current) await startSession(c, c.env, user.id);
  return c.json<GuestResponse>({ project_id: pid, user }, 201);
});

// 新しい片付けを始める。作った人が招待を出す側になる。本物の project なので期限は無い。
// ゲストが作るときは、同じ人のまま名前を付ける。見本にも戻れる
sessionRoutes.post("/projects", async (c) => {
  type Body = { display_name?: string; title?: string };
  const body = await c.req.json<Body>().catch(() => ({}) as Body);
  const title = clip(body.title, 40);
  const name = clip(body.display_name, 40);
  const current = c.get("user");
  if (c.get("scope")) return c.json({ error: "scoped_session" }, 409);
  const known = current && !current.is_guest ? current : null;
  if (!title || (!known && !name)) return c.json({ error: "bad_params" }, 400);
  const over = await take(c.env, projectQuotas(c.env, await clientKey(c)));
  if (over) return c.json({ error: over }, 429);
  const now = Date.now();
  const pid = crypto.randomUUID();
  const user: UserView = known ?? {
    id: current?.id ?? crypto.randomUUID(),
    display_name: name,
    is_guest: false,
  };
  const stmts = [
    c.env.DB.prepare(
      "INSERT INTO projects (id, title, is_sample, owner_user_id, created_at) VALUES (?, ?, 0, ?, ?)",
    ).bind(pid, title, user.id, now),
    c.env.DB.prepare(
      "INSERT INTO memberships (project_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
    ).bind(pid, user.id, now),
  ];
  if (current?.is_guest) {
    stmts.unshift(
      c.env.DB.prepare("UPDATE users SET display_name = ?, is_guest = 0 WHERE id = ?").bind(name, user.id),
    );
  } else if (!current) {
    stmts.unshift(
      c.env.DB.prepare(
        "INSERT INTO users (id, display_name, is_guest, created_at) VALUES (?, ?, 0, ?)",
      ).bind(user.id, user.display_name, now),
    );
  }
  await c.env.DB.batch(stmts);
  if (!current) await startSession(c, c.env, user.id);
  return c.json<GuestResponse>({ project_id: pid, user }, 201);
});

// 招待を開く。今のセッションと招待の状態の組み合わせで決まる。
//
//   今の人    未使用の招待             使用済みで入り直せる         使用済みで入り直せない
//   なし      人を作って入る           その片付けだけのセッション   断る（403）
//   ゲスト    同じ人に名前を付けて入る 断る（409）                  断る（409）
//   名前あり  同じ人のまま入る         断る（409）                  断る（409）
//   閉じた人  断る（409）              断る（409）                  断る（409）
//
// すでに参加している人が開いたときは、人を入れ替えず、招待も使い切らない。
// トークンは本文で受ける。パスに入れるとサーバのログに残るため。パスの形も契約どおり受ける
sessionRoutes.post("/invite/:token?", async (c) => {
  const body = await c.req.json<{ token?: string }>().catch(() => ({}) as { token?: string });
  const token = c.req.param("token") ?? body.token;
  if (!token) return c.json({ error: "invite_invalid" }, 403);
  const hash = await sha256Hex(token);
  const now = Date.now();
  type Invite = {
    id: string;
    project_id: string;
    display_name: string;
    used_by_user_id: string | null;
    reentry: number;
  };
  const invite = await c.env.DB.prepare(
    `SELECT i.id, i.project_id, i.display_name, i.used_by_user_id, i.reentry FROM invites i
     JOIN projects p ON p.id = i.project_id
     WHERE i.token_hash = ? AND i.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at > ?)
       AND p.is_sample = 0`,
  )
    .bind(hash, now)
    .first<Invite>();
  if (!invite) return c.json({ error: "invite_invalid" }, 403);
  const pid = invite.project_id;
  const current = c.get("user");
  const scope = c.get("scope");

  const enteredAs = async (userId: string) => {
    const u = await c.env.DB.prepare("SELECT id, display_name, is_guest FROM users WHERE id = ?")
      .bind(userId)
      .first<{ id: string; display_name: string; is_guest: number }>();
    return c.json<GuestResponse>({
      project_id: pid,
      user: { id: u!.id, display_name: u!.display_name, is_guest: !!u!.is_guest },
    });
  };

  // 使用済みのリンクを開いたとき
  const reopen = async (used: { used_by_user_id: string | null; reentry: number }) => {
    if (current) return c.json({ error: "invite_other_user" }, 409);
    if (!used.reentry) return c.json({ error: "invite_invalid" }, 403);
    await startSession(c, c.env, used.used_by_user_id!, { projectId: pid, inviteId: invite.id });
    return enteredAs(used.used_by_user_id!);
  };

  if (current) {
    const member = await c.env.DB.prepare(
      "SELECT 1 FROM memberships WHERE project_id = ? AND user_id = ?",
    )
      .bind(pid, current.id)
      .first();
    if (member && (!scope || scope === pid)) return c.json<GuestResponse>({ project_id: pid, user: current });
    if (scope) {
      return c.json({ error: invite.used_by_user_id ? "invite_other_user" : "scoped_session" }, 409);
    }
  }
  if (invite.used_by_user_id) return reopen(invite);

  // 未使用の招待。未ログインの人は招待の名前で作る。ログイン中の人はその人のまま入る
  const userId = current?.id ?? crypto.randomUUID();
  if (!current) {
    await c.env.DB.prepare(
      "INSERT INTO users (id, display_name, is_guest, created_at) VALUES (?, ?, 0, ?)",
    )
      .bind(userId, invite.display_name, now)
      .run();
  }
  // 名前のある人が使った招待は、リンクでは入り直せない。その人の別の片付けへ渡らないため
  const reentry = !current || current.is_guest ? 1 : 0;
  // 同時に 2 回開かれても、使えるのは 1 人だけ
  const claim = await c.env.DB.prepare(
    "UPDATE invites SET used_by_user_id = ?, reentry = ? WHERE id = ? AND used_by_user_id IS NULL",
  )
    .bind(userId, reentry, invite.id)
    .run();
  if (!claim.meta.changes) {
    if (!current) await c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
    const again = await c.env.DB.prepare("SELECT used_by_user_id, reentry FROM invites WHERE id = ?")
      .bind(invite.id)
      .first<{ used_by_user_id: string; reentry: number }>();
    return reopen(again!);
  }
  const stmts = [
    c.env.DB.prepare(
      "INSERT INTO memberships (project_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)",
    ).bind(pid, userId, now),
  ];
  if (current?.is_guest) {
    stmts.push(
      c.env.DB.prepare("UPDATE users SET display_name = ?, is_guest = 0 WHERE id = ?").bind(
        invite.display_name,
        userId,
      ),
    );
  }
  await c.env.DB.batch(stmts);
  if (!current) await startSession(c, c.env, userId, { inviteId: invite.id });
  return enteredAs(userId);
});
