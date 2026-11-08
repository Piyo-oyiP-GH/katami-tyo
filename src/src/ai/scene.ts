// 写真を対象と背景に分けた結果（呼び出し C）と、その見張り。
// Claude が出した線と知らせは、根拠の文がその物の客観に本当にあるかをコードで確かめる。
// 判断の語や、健康・お金・人間関係の見立ては消す。
import type { Scene, SceneFact, SceneThing } from "../types";
import { blockedTopic, judges } from "./guard";

type RawThing = Omit<SceneThing, "visibility"> & { visibility?: "はっきり" | "ぼんやり" };
export type RawScene = {
  subject: RawThing;
  background: (RawThing & { visibility: "はっきり" | "ぼんやり" })[];
  links: { from: string; to: string; relation: string; basis: string }[];
  notice: { say: string; about: string; basis: string };
};

const norm = (s: string | undefined) => (s ?? "").normalize("NFKC").replace(/\s+/g, "");
// 根拠の文が、客観の文と（どちらかが他方を含む形で）一致するか。短すぎる根拠は認めない
const has = (facts: SceneFact[], q: string) =>
  norm(q).length >= 2 && facts.some((o) => norm(o.text).includes(norm(q)) || norm(q).includes(norm(o.text)));

const clean = <T extends RawThing>(t: T): T => ({
  ...t,
  objective: t.objective.filter((o) => o.text.trim()),
  subjective: t.subjective.filter((s) => s.trim() && !judges(s) && !blockedTopic(s)),
});

// ref は「対象」か「背景N」
export function thingOf(scene: Pick<Scene, "subject" | "background">, ref: string): SceneThing | null {
  if (ref === "対象") return scene.subject;
  const n = Number((ref.match(/背景(\d+)/) ?? [])[1]);
  return Number.isInteger(n) && n >= 1 ? (scene.background[n - 1] ?? null) : null;
}

export function checkScene(raw: RawScene): Scene {
  const subject = clean(raw.subject);
  const background = raw.background.map(clean);
  const base = { subject, background };
  const links = raw.links
    .filter((l) => !judges(l.relation) && !blockedTopic(l.relation))
    .flatMap((l) => {
      const a = thingOf(base, l.from);
      const b = thingOf(base, l.to);
      return a && b && (has(a.objective, l.basis) || has(b.objective, l.basis)) ? [l] : [];
    });
  const n = raw.notice;
  const target = n.say ? thingOf(base, n.about) : null;
  const noticeOk = !!target && has(target.objective, n.basis) && !judges(n.say) && !blockedTopic(n.say);
  return {
    subject,
    background,
    links,
    notice: noticeOk ? { say: n.say.trim(), about: n.about, basis: n.basis } : null,
    dropped: raw.links.length - links.length + (n.say && !noticeOk ? 1 : 0),
  };
}
