// 人物、家族の書き足し、招待、録画モードの語。
import { Hono } from "hono";
import type {
  ClaimView,
  InviteResponse,
  ItemReading,
  ParticipantView,
  PersonSubtype,
  PersonView,
  SearchTerms,
} from "../types";
import { clip, parseJson } from "./cards";
import { loadClaims, relatedItems } from "./claims";
import { AppEnv, randomToken, sha256Hex } from "./session";
import type { Correction, InviteListResponse, PersonX, PersonsX, RecordTerms } from "./types";

const SUBTYPES: readonly string[] = ["owner", "relative", "friend", "vague"];
const FAMILY_NAME_TEXT = "家族が訂正した名前です";

export const peopleRoutes = new Hono<AppEnv>();

type PersonRow = {
  id: string;
  subtype: PersonSubtype;
  label: string;
  linked_user_id: string | null;
  made_by: string | null;
  read_label: string | null;
};

// 札の名前の比べ方。空白と全角半角の違いでは別の人にしない
const labelKey = (s: string) => s.normalize("NFKC").replace(/\s/g, "").toLowerCase();

async function loadParticipants(env: Env, pid: string): Promise<ParticipantView[]> {
  const { results } = await env.DB.prepare(
    `SELECT u.id AS user_id, u.display_name, m.role FROM memberships m
     JOIN users u ON u.id = m.user_id
     WHERE m.project_id = ? ORDER BY m.role = 'owner' DESC, m.created_at, u.id`,
  )
    .bind(pid)
    .all<ParticipantView>();
  return results;
}

async function loadPersonRows(env: Env, pid: string): Promise<PersonRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, subtype, label, linked_user_id, made_by, read_label FROM persons
     WHERE project_id = ? AND merged_into IS NULL ORDER BY created_at, id`,
  )
    .bind(pid)
    .all<PersonRow>();
  return results;
}

peopleRoutes.get("/persons", async (c) => {
  const pid = c.req.param("pid")!;
  const [participants, rows, claims, project] = await Promise.all([
    loadParticipants(c.env, pid),
    loadPersonRows(c.env, pid),
    loadClaims(c.env, pid),
    c.env.DB.prepare("SELECT persons_updated_at, persons_meta_json FROM projects WHERE id = ?")
      .bind(pid)
      .first<{ persons_updated_at: number | null; persons_meta_json: string | null }>(),
  ]);
  const persons: PersonX[] = rows
    .map(({ made_by, read_label, ...p }) => ({
      ...p,
      made_by,
      renamed: read_label !== null,
      claims: claims.filter((cl) => cl.person_id === p.id),
    }))
    // 訂正で根拠が全部消えた Claude の札は出さない
    .filter((p) => p.made_by !== "claude" || p.claims.length > 0)
    .map(({ made_by: _, ...p }) => p);
  const ids = [...new Set(persons.flatMap((p) => p.claims.flatMap((cl) => cl.item_ids)))];
  return c.json<PersonsX>({
    participants,
    persons,
    items: await relatedItems(c.env, pid, ids),
    updated_at: project?.persons_updated_at ?? null,
    meta: parseJson(project?.persons_meta_json ?? null),
  });
});

// 家族が名前を登録する。「〜夫妻」のような曖昧な名前でよい
peopleRoutes.post("/persons", async (c) => {
  const pid = c.req.param("pid")!;
  type Body = { label?: string; subtype?: string };
  const body = await c.req.json<Body>().catch(() => ({}) as Body);
  const label = clip(body.label, 40);
  const subtype = body.subtype ?? "vague";
  if (!label || !SUBTYPES.includes(subtype)) return c.json({ error: "bad_params" }, 400);
  const same = (await loadPersonRows(c.env, pid)).find((p) => labelKey(p.label) === labelKey(label));
  if (same) return c.json({ error: "person_exists", person_id: same.id }, 409);
  const id = crypto.randomUUID();
  const now = Date.now();
  await c.env.DB.prepare(
    "INSERT INTO persons (id, project_id, subtype, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, pid, subtype, label, now, now)
    .run();
  return c.json<PersonView>(
    { id, subtype: subtype as PersonSubtype, label, linked_user_id: null, claims: [] },
    201,
  );
});

// 札の種類と名前を家族が決める。Claude が作る札は「はっきりしない人」のまま。
// 名前を直しても、物とのつながりは元の読み（read_label）で確かめ続ける。読みそのものは変わらないため
peopleRoutes.patch("/persons/:id", async (c) => {
  const pid = c.req.param("pid")!;
  const id = c.req.param("id");
  type Body = { subtype?: string; label?: string };
  const body = await c.req.json<Body>().catch(() => ({}) as Body);
  const label = body.label === undefined ? null : clip(body.label, 40);
  const subtypeOk = body.subtype !== undefined && SUBTYPES.includes(body.subtype);
  if ((!subtypeOk && label === null) || label === "" || (body.subtype !== undefined && !subtypeOk)) {
    return c.json({ error: "bad_params" }, 400);
  }
  if (label !== null) {
    const same = (await loadPersonRows(c.env, pid)).find(
      (p) => p.id !== id && labelKey(p.label) === labelKey(label),
    );
    if (same) return c.json({ error: "person_exists", person_id: same.id }, 409);
  }
  const res = await c.env.DB.prepare(
    `UPDATE persons SET
       subtype = COALESCE(?1, subtype),
       read_label = CASE WHEN ?2 IS NOT NULL AND ?2 <> label THEN COALESCE(read_label, label) ELSE read_label END,
       label = COALESCE(?2, label),
       updated_at = ?3
     WHERE id = ?4 AND project_id = ?5`,
  )
    .bind(body.subtype ?? null, label, Date.now(), id, pid)
    .run();
  if (!res.meta.changes) return c.json({ error: "not_found" }, 404);
  return c.body(null, 204);
});

// 訂正した名前を、人が札に結ぶ。訂正の行は写真の根拠にしないので、家族の書き足しとして残す。
// 本文は { item_id, line } と、既にある札へ結ぶなら person_id。無ければ同じ名前の札か、新しい札を使う
peopleRoutes.post("/persons/confirm-name", async (c) => {
  const pid = c.req.param("pid")!;
  const user = c.get("user")!;
  type Body = { item_id?: string; line?: number; person_id?: string };
  const body = await c.req.json<Body>().catch(() => ({}) as Body);
  if (!body.item_id || typeof body.line !== "number") return c.json({ error: "bad_params" }, 400);
  const row = await c.env.DB.prepare(
    "SELECT reading_json, correction_json FROM items WHERE id = ? AND project_id = ?",
  )
    .bind(body.item_id, pid)
    .first<{ reading_json: string | null; correction_json: string | null }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  const reading = parseJson<{ checked?: { type: string }[] }>(row.reading_json);
  const text = parseJson<Correction>(row.correction_json)?.lines?.[String(body.line)]?.text;
  if (!text || reading?.checked?.[body.line]?.type !== "name") return c.json({ error: "bad_params" }, 400);
  const label = clip(text.replace(/\s*(様|さま|殿|さん|御中|先生)$/u, ""), 40);

  const rows = await loadPersonRows(c.env, pid);
  const person = body.person_id
    ? rows.find((p) => p.id === body.person_id)
    : rows.find((p) => labelKey(p.label) === labelKey(label));
  if (body.person_id && !person) return c.json({ error: "not_found" }, 404);
  const now = Date.now();
  const personId = person?.id ?? crypto.randomUUID();
  const done = await c.env.DB.prepare(
    `SELECT 1 FROM claims c JOIN claim_items ci ON ci.claim_id = c.id
     WHERE c.project_id = ? AND c.person_id = ? AND c.source = 'family' AND c.text = ?
       AND c.superseded_at IS NULL AND ci.item_id = ?`,
  )
    .bind(pid, personId, FAMILY_NAME_TEXT, body.item_id)
    .first();
  if (done) return c.json({ person_id: personId });
  const claimId = crypto.randomUUID();
  await c.env.DB.batch([
    ...(person
      ? []
      : [
          c.env.DB.prepare(
            "INSERT INTO persons (id, project_id, subtype, label, created_at, updated_at) VALUES (?, ?, 'vague', ?, ?, ?)",
          ).bind(personId, pid, label, now, now),
        ]),
    c.env.DB.prepare(
      `INSERT INTO claims (id, project_id, person_id, source, text, author_user_id, created_at)
       VALUES (?, ?, ?, 'family', ?, ?, ?)`,
    ).bind(claimId, pid, personId, FAMILY_NAME_TEXT, user.id, now),
    c.env.DB.prepare("INSERT INTO claim_items (project_id, claim_id, item_id) VALUES (?, ?, ?)").bind(
      pid,
      claimId,
      body.item_id,
    ),
  ]);
  return c.json({ person_id: personId }, 201);
});

// 参加者との結び付け。名前の一致では自動で結ばず、人が決める。本文は { user_id } か { user_id: null }
peopleRoutes.put("/persons/:id/link", async (c) => {
  const pid = c.req.param("pid")!;
  type Body = { user_id?: string | null };
  const body = await c.req.json<Body>().catch(() => ({}) as Body);
  const userId = body.user_id ?? null;
  if (userId) {
    const member = await c.env.DB.prepare(
      "SELECT 1 FROM memberships WHERE project_id = ? AND user_id = ?",
    )
      .bind(pid, userId)
      .first();
    if (!member) return c.json({ error: "bad_params" }, 400);
  }
  const res = await c.env.DB.prepare(
    "UPDATE persons SET linked_user_id = ?, updated_at = ? WHERE id = ? AND project_id = ?",
  )
    .bind(userId, Date.now(), c.req.param("id"), pid)
    .run();
  if (!res.meta.changes) return c.json({ error: "not_found" }, 404);
  return c.body(null, 204);
});

// 家族の書き足し。source は family に固定。強さは付けず、写真の根拠の数にも入れない
peopleRoutes.post("/persons/:id/claims", async (c) => {
  const pid = c.req.param("pid")!;
  const personId = c.req.param("id");
  const user = c.get("user")!;
  type Body = { text?: string; item_id?: string };
  const body = await c.req.json<Body>().catch(() => ({}) as Body);
  const text = clip(body.text, 300);
  if (!text) return c.json({ error: "bad_params" }, 400);
  const person = await c.env.DB.prepare("SELECT label FROM persons WHERE id = ? AND project_id = ?")
    .bind(personId, pid)
    .first<{ label: string }>();
  if (!person) return c.json({ error: "not_found" }, 404);
  if (body.item_id) {
    const item = await c.env.DB.prepare("SELECT 1 FROM items WHERE id = ? AND project_id = ?")
      .bind(body.item_id, pid)
      .first();
    if (!item) return c.json({ error: "not_found" }, 404);
  }
  const id = crypto.randomUUID();
  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO claims (id, project_id, person_id, source, text, author_user_id, created_at)
       VALUES (?, ?, ?, 'family', ?, ?, ?)`,
    ).bind(id, pid, personId, text, user.id, Date.now()),
  ];
  if (body.item_id) {
    stmts.push(
      c.env.DB.prepare(
        "INSERT INTO claim_items (project_id, claim_id, item_id) VALUES (?, ?, ?)",
      ).bind(pid, id, body.item_id),
    );
  }
  await c.env.DB.batch(stmts);
  return c.json<ClaimView>(
    {
      id,
      person_id: personId,
      person_label: person.label,
      source: "family",
      text,
      strength: null,
      author: { id: user.id, display_name: user.display_name },
      item_ids: body.item_id ? [body.item_id] : [],
    },
    201,
  );
});

// ---- 招待。作成者だけが扱える ----
peopleRoutes.get("/invites", async (c) => {
  if (c.get("role") !== "owner") return c.json({ error: "owner_only" }, 403);
  const { results } = await c.env.DB.prepare(
    `SELECT i.id, i.display_name, i.used_by_user_id, i.revoked_at, i.created_at, u.display_name AS joined_name
     FROM invites i LEFT JOIN users u ON u.id = i.used_by_user_id
     WHERE i.project_id = ? AND i.kind = 'invite' ORDER BY i.created_at DESC`,
  )
    .bind(c.req.param("pid"))
    .all<{
      id: string;
      display_name: string;
      used_by_user_id: string | null;
      revoked_at: number | null;
      created_at: number;
      joined_name: string | null;
    }>();
  return c.json<InviteListResponse>({
    invites: results.map((r) => ({
      id: r.id,
      display_name: r.display_name,
      joined: !!r.used_by_user_id,
      joined_name: r.joined_name,
      revoked: !!r.revoked_at,
      created_at: r.created_at,
    })),
  });
});

peopleRoutes.post("/invites", async (c) => {
  if (c.get("role") !== "owner") return c.json({ error: "owner_only" }, 403);
  // 見本は 24 時間で消す架空の片付け。招待で本物の人を入れない
  if (c.get("isSample")) return c.json({ error: "bad_params" }, 400);
  const body = await c.req
    .json<{ display_name?: string }>()
    .catch(() => ({}) as { display_name?: string });
  const display_name = clip(body.display_name, 40);
  if (!display_name) return c.json({ error: "bad_params" }, 400);
  const id = crypto.randomUUID();
  const token = randomToken(); // 256bit。ハッシュだけを保存する
  await c.env.DB.prepare(
    "INSERT INTO invites (id, project_id, display_name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, c.req.param("pid"), display_name, await sha256Hex(token), Date.now())
    .run();
  // # の後ろはサーバへ送られない。画面はトークンを POST の本文で渡す
  const url = `${new URL(c.req.url).origin}/#/join/${token}`;
  return c.json<InviteResponse>({ id, display_name, url }, 201);
});

// 失効。リンクを止め、すでに入った人も外す
peopleRoutes.delete("/invites/:id", async (c) => {
  if (c.get("role") !== "owner") return c.json({ error: "owner_only" }, 403);
  const pid = c.req.param("pid")!;
  const id = c.req.param("id");
  const invite = await c.env.DB.prepare(
    "SELECT used_by_user_id, revoked_at FROM invites WHERE id = ? AND project_id = ? AND kind = 'invite'",
  )
    .bind(id, pid)
    .first<{ used_by_user_id: string | null; revoked_at: number | null }>();
  if (!invite) return c.json({ error: "not_found" }, 404);
  // 止めた後に新しい招待で戻った人を、古い招待の取り消しで外さない
  if (invite.revoked_at) return c.body(null, 204);
  const now = Date.now();
  const stmts = [
    c.env.DB.prepare("UPDATE invites SET revoked_at = ? WHERE id = ? AND project_id = ?").bind(now, id, pid),
  ];
  if (invite.used_by_user_id) {
    stmts.push(
      c.env.DB.prepare(
        "DELETE FROM memberships WHERE project_id = ? AND user_id = ? AND role = 'member'",
      ).bind(pid, invite.used_by_user_id),
      // その人が発行した本人用のリンクも止める
      c.env.DB.prepare(
        `UPDATE invites SET revoked_at = ?
         WHERE project_id = ? AND kind = 'self' AND used_by_user_id = ? AND revoked_at IS NULL`,
      ).bind(now, pid, invite.used_by_user_id),
      // この片付けに閉じたセッションは全部消す
      c.env.DB.prepare("DELETE FROM sessions WHERE project_id = ? AND user_id = ?").bind(
        pid,
        invite.used_by_user_id,
      ),
      // 招待で作った最初のセッションは、ほかに行き先が無ければ消す
      c.env.DB.prepare(
        `DELETE FROM sessions WHERE invite_id = ?
           AND user_id NOT IN (SELECT user_id FROM memberships)`,
      ).bind(id),
    );
  }
  await c.env.DB.batch(stmts);
  return c.body(null, 204);
});

// 本人用のリンク。別の端末で開くときと、Cookie が消えた作成者が戻るときに使う。
// 開いたセッションは、この片付けでだけ使える。発行し直すと前のリンクは止まる
peopleRoutes.post("/self-link", async (c) => {
  const pid = c.req.param("pid")!;
  const user = c.get("user")!;
  if (c.get("scope")) return c.json({ error: "scoped_session" }, 409);
  if (c.get("isSample")) return c.json({ error: "bad_params" }, 400);
  const { results: old } = await c.env.DB.prepare(
    `SELECT id FROM invites
     WHERE project_id = ? AND kind = 'self' AND used_by_user_id = ? AND revoked_at IS NULL`,
  )
    .bind(pid, user.id)
    .all<{ id: string }>();
  const now = Date.now();
  const id = crypto.randomUUID();
  const token = randomToken();
  await c.env.DB.batch([
    ...old.flatMap((o) => [
      c.env.DB.prepare("UPDATE invites SET revoked_at = ? WHERE id = ?").bind(now, o.id),
      c.env.DB.prepare("DELETE FROM sessions WHERE invite_id = ?").bind(o.id),
    ]),
    c.env.DB.prepare(
      `INSERT INTO invites (id, project_id, display_name, token_hash, used_by_user_id, kind, reentry, created_at)
       VALUES (?, ?, ?, ?, ?, 'self', 1, ?)`,
    ).bind(id, pid, user.display_name, await sha256Hex(token), user.id, now),
  ]);
  return c.json({ url: `${new URL(c.req.url).origin}/#/join/${token}` }, 201);
});

// ---- 録画モード。データは変えず、画面の上で置き換える語だけを返す ----
const letter = (i: number) => {
  let s = "";
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
  return s;
};
const pieces = (s: string) => [s, ...s.split(/[\s　]+/)].filter((t) => t.length >= 2);
// 名前は 1 字でも隠す。空白で分けた部分は 2 字以上だけにする
const namePieces = (s: string) => [s.trim(), ...pieces(s)].filter(Boolean);

peopleRoutes.get("/record-terms", async (c) => {
  const pid = c.req.param("pid")!;
  // 招待の名前は作成者にだけ見える。まだ開いていない人や止めた人の名前を、参加者に渡さない
  const inviteNames =
    c.get("role") === "owner"
      ? c.env.DB.prepare("SELECT display_name FROM invites WHERE project_id = ? ORDER BY created_at, id")
          .bind(pid)
          .all<{ display_name: string }>()
      : Promise.resolve({ results: [] as { display_name: string }[] });
  const [participants, persons, invites, project, items] = await Promise.all([
    loadParticipants(c.env, pid),
    loadPersonRows(c.env, pid),
    inviteNames,
    c.env.DB.prepare("SELECT title FROM projects WHERE id = ?").bind(pid).first<{ title: string }>(),
    c.env.DB.prepare(
      "SELECT reading_json, search_terms, correction_json FROM items WHERE project_id = ?",
    )
      .bind(pid)
      .all<{
        reading_json: string | null;
        search_terms: string | null;
        correction_json: string | null;
      }>(),
  ]);

  const aliases = new Map<string, string>();
  const add = (name: string, alias: string) => {
    for (const t of namePieces(name)) if (!aliases.has(t)) aliases.set(t, alias);
  };
  const relatives = [
    ...participants.map((p) => p.display_name),
    ...invites.results.map((i) => i.display_name),
  ];
  [...new Set(relatives)].forEach((name, i) => add(name, `親族${letter(i)}`));
  persons.forEach((p, i) => {
    add(p.label, `人物${letter(i)}`);
    if (p.read_label) add(p.read_label, `人物${letter(i)}`);
  });
  if (project) aliases.set(project.title, "この片付け");

  const hidden = new Set<string>();
  for (const row of items.results) {
    const reading = parseJson<ItemReading>(row.reading_json);
    const fix = parseJson<Correction>(row.correction_json);
    const terms = parseJson<Partial<SearchTerms>>(row.search_terms);
    const lines = [
      ...(reading?.a?.lines ?? []).map((l) => l.text),
      ...(reading?.a2?.lines ?? []).map((l) => l.text),
      ...(terms?.text ?? []),
      ...Object.values(fix?.lines ?? {}).flatMap((l) => [l.text, l.original ?? ""]),
      // 文字の裏付けが無く見立てに下がった固有名詞も、行の外に出ている
      ...(reading?.b?.proper_nouns ?? []),
    ];
    for (const line of lines) {
      for (const t of pieces(line.replaceAll("〔不明〕", " ").trim())) hidden.add(t);
    }
  }
  return c.json<RecordTerms>({
    aliases: [...aliases].map(([term, alias]) => ({ term, alias })),
    hidden: [...hidden].filter((t) => !aliases.has(t)),
  });
});
