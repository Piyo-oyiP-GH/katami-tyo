// 人の画面。参加者（丸）と、持ち主につながる人（四角い札）を分ける。招待と録画モードもここ。
import { recordOn, refreshTerms, setRecord } from "./mask.js";
import {
  ApiError,
  STRENGTH_NAMES,
  evidenceCounts,
  SUBTYPE_NAMES,
  act,
  api,
  askText,
  copyText,
  errorText,
  h,
  itemTitle,
  poll,
  thumbImg,
  toast,
} from "./util.js";

const CLAIM_LABEL = { photo: "読めた名前", family: "家族が書いた", claude: "Claude の仮説" };
const PERSONS_ERRORS = {
  limited: "読み取りの上限に当たったので、人物の更新を止めています。",
  refused: "一部の物を、人物の更新に入れられませんでした。",
  truncated: "一部の物を、人物の更新に入れられませんでした。",
};

export function peopleView({ pid, project, me, rerender }, root) {
  const box = h("div", {});
  const inviteBox = h("div", {});
  const newLink = h("div", {});
  const selfBox = h("div", {});
  let lastJson = "";
  let lastInvites = "";

  // 操作の直後は、選択欄に焦点があっても描き直す
  async function linkPerson(personId, userId) {
    const done = await act(async () => {
      await api(`/api/p/${pid}/persons/${personId}/link`, {
        method: "PUT",
        json: { user_id: userId || null },
      });
      return true;
    });
    if (done) await act(() => load({ force: true }));
  }

  // リンクを画面に出す。録画モードでは隠す
  function showLink(box, text, url) {
    box.replaceChildren(
      h("p", { class: "note" }, text),
      h("div", { class: "invite-url", "data-rec": "hide" }, url),
      h(
        "button",
        {
          class: "btn small",
          type: "button",
          onclick: async () => {
            toast((await copyText(url)) ? "リンクをコピーしました。" : "コピーできません。リンクを長押ししてください。");
          },
        },
        "リンクをコピー",
      ),
    );
  }

  async function write(person) {
    const text = await askText({
      title: "家族のメモを書く",
      label: `${person.label}について知っていること`,
      multiline: true,
      ok: "書き足す",
    });
    if (!text) return;
    const saved = await act(() =>
      api(`/api/p/${pid}/persons/${person.id}/claims`, { method: "POST", json: { text } }),
    );
    if (saved) await act(load);
  }

  // 同じ名前の札があるときは、その札を見せる
  function showExisting(e) {
    toast(errorText("person_exists"), 4000);
    const card = root.querySelector(`[data-person="${e.data?.person_id}"]`);
    card?.scrollIntoView({ block: "center" });
    card?.classList.add("found");
    setTimeout(() => card?.classList.remove("found"), 2500);
  }

  async function rename(person) {
    const label = await askText({
      title: "札の名前を直す",
      label: "正しい名前",
      // 録画モードでは、元の名前を入力欄にも出さない
      value: recordOn() ? "" : person.label,
    });
    if (!label || label === person.label) return;
    try {
      await api(`/api/p/${pid}/persons/${person.id}`, { method: "PATCH", json: { label } });
    } catch (e) {
      if (e instanceof ApiError && e.code === "person_exists") return showExisting(e);
      return void act(() => Promise.reject(e));
    }
    await act(async () => {
      await refreshTerms(pid);
      await load({ force: true });
    });
  }

  async function setSubtype(personId, subtype) {
    const done = await act(async () => {
      await api(`/api/p/${pid}/persons/${personId}`, { method: "PATCH", json: { subtype } });
      return true;
    });
    if (done) await act(() => load({ force: true }));
  }

  function claimLine(c) {
    if (c.source === "family") return c.author ? `${c.author.display_name}さんが書きました` : CLAIM_LABEL.family;
    const head = `${CLAIM_LABEL[c.source]}　関連する物 ${c.item_ids.length} 個（${evidenceCounts(c)}）`;
    return c.strength ? `${head}　強さ：${STRENGTH_NAMES[c.strength]}` : `${head}　強さは付いていません`;
  }

  function personCard(p, participants, items) {
    const joined = participants.find((u) => u.user_id === p.linked_user_id);
    return h(
      "div",
      { class: `person-card${joined ? " joined" : ""}`, "data-person": p.id },
      h(
        "div",
        { class: "card-head" },
        joined
          ? h("span", { class: "avatar small", "data-rec-avatar": joined.display_name }, joined.display_name.slice(0, 1))
          : null,
        h("div", { class: "label" }, p.label),
        joined ? h("span", { class: "joined-mark" }, "参加中") : null,
      ),
      p.renamed ? h("p", { class: "sub fixed-note renamed" }, "名前は家族が直しました") : null,
      h(
        "label",
        { class: "kind" },
        "種類",
        h(
          "select",
          { class: "subtype", onchange: (e) => setSubtype(p.id, e.target.value) },
          Object.entries(SUBTYPE_NAMES).map(([k, v]) =>
            h("option", { value: k, selected: p.subtype === k }, v),
          ),
        ),
      ),
      p.claims.map((c) =>
        h(
          "div",
          { class: `rel ${c.source}`, "data-source": c.source },
          h("p", c.source === "photo" ? {} : { "data-rec": "hide" }, c.text),
          h("p", { class: "sub" }, claimLine(c)),
          c.item_ids.length
            ? h(
                "div",
                { class: "related" },
                c.item_ids
                  .map((id) => items.get(id))
                  .filter(Boolean)
                  .map((r) =>
                    h("a", { href: `#/p/${pid}/item/${r.id}`, "aria-label": itemTitle(r) }, thumbImg(r)),
                  ),
              )
            : null,
        ),
      ),
      h(
        "label",
        { class: "section note" },
        "参加者と同じ人なら選ぶ",
        h(
          "select",
          { onchange: (e) => linkPerson(p.id, e.target.value) },
          h("option", { value: "" }, "結び付けない"),
          participants.map((u) =>
            h("option", { value: u.user_id, selected: p.linked_user_id === u.user_id }, u.display_name),
          ),
        ),
      ),
      h(
        "div",
        { class: "card-actions" },
        h("button", { class: "btn small", onclick: () => write(p) }, "書き足す"),
        h("button", { class: "btn small rename", onclick: () => rename(p) }, "名前を直す"),
      ),
    );
  }

  async function load({ force = false } = {}) {
    await refreshTerms(pid);
    const data = await api(`/api/p/${pid}/persons`);
    const json = JSON.stringify(data);
    if (json === lastJson) return;
    // 周期の更新は、選んでいる途中の選択欄を壊さない。自分の操作の直後は描き直す
    if (!force && root.contains(document.activeElement) && document.activeElement.tagName === "SELECT") return;
    lastJson = json;
    box.replaceChildren(
      h(
        "section",
        { class: "section" },
        h("h2", {}, "参加している人"),
        h(
          "div",
          { class: "people-row", id: "participants" },
          data.participants.map((u) =>
            h(
              "div",
              { class: "member" },
              h("span", { class: "avatar", "data-rec-avatar": u.display_name }, u.display_name.slice(0, 1)),
              h("div", {}, u.display_name),
              data.persons.some((p) => p.linked_user_id === u.user_id)
                ? h("div", { class: "note" }, "人物の札あり")
                : null,
            ),
          ),
        ),
      ),
      h(
        "section",
        { class: "section" },
        h("h2", {}, "持ち主につながる人"),
        data.meta?.error
          ? h(
              "p",
              { class: "error-text fixed-note", id: "persons-error" },
              PERSONS_ERRORS[data.meta.error] ?? "人物の更新に失敗しました。少し待つと、もう一度試します。",
            )
          : null,
        data.persons.length
          ? data.persons.map((p) =>
              personCard(p, data.participants, new Map(data.items.map((r) => [r.id, r]))),
            )
          : h("p", { class: "note" }, "まだいません。写真を読むと増えます。下の欄から足すこともできます。"),
        h(
          "button",
          {
            class: "btn small",
            id: "add-person",
            onclick: async () => {
              const select = h(
                "select",
                { id: "person-subtype", "aria-label": "人物の種類" },
                Object.entries(SUBTYPE_NAMES).map(([k, v]) =>
                  h("option", { value: k, selected: k === "vague" }, v),
                ),
              );
              const label = await askText({
                title: "人物を足す",
                label: "名前（「川辺夫妻」のように曖昧でよい）",
                ok: "足す",
                extra: select,
              });
              if (!label) return;
              try {
                await api(`/api/p/${pid}/persons`, {
                  method: "POST",
                  json: { label, subtype: select.value },
                });
              } catch (e) {
                if (e instanceof ApiError && e.code === "person_exists") return showExisting(e);
                return void act(() => Promise.reject(e));
              }
              await act(async () => {
                await refreshTerms(pid);
                await load({ force: true });
              });
            },
          },
          "人物を足す",
        ),
      ),
    );
  }

  async function loadInvites() {
    if (project.role !== "owner") return;
    const { invites } = await api(`/api/p/${pid}/invites`);
    const json = JSON.stringify(invites);
    if (json === lastInvites) return;
    lastInvites = json;
    inviteBox.replaceChildren(
      ...invites.map((i) =>
        h(
          "div",
          { class: "invite-row" },
          h(
            "span",
            {},
            i.display_name,
            i.revoked
              ? "（止めました）"
              : !i.joined
                ? "（まだ開いていません）"
                : i.joined_name && i.joined_name !== i.display_name
                  ? `（${i.joined_name}さんが参加しました）`
                  : "（参加済み）",
          ),
          i.revoked
            ? null
            : h(
                "button",
                {
                  class: "btn small",
                  onclick: async () => {
                    const done = await act(async () => {
                      await api(`/api/p/${pid}/invites/${i.id}`, { method: "DELETE" });
                      return true;
                    });
                    if (!done) return;
                    toast("招待を止めました。");
                    await act(() => Promise.all([loadInvites(), load()]));
                  },
                },
                "止める",
              ),
        ),
      ),
    );
  }

  // 録画モードでは、打った名前も見せない（style.css の .rec）
  const nameInput = h("input", {
    id: "invite-name",
    autocomplete: "off",
    required: true,
  });
  const inviteForm = project.is_sample
    ? h(
        "section",
        { class: "section stack", id: "invite-sample" },
        h("h2", {}, "招待"),
        h("p", { class: "note fixed-note" }, "見本には人を招待できません。招待は、自分の片付けで使えます。"),
      )
    : project.role === "owner"
      ? h(
          "section",
          { class: "section stack" },
          h("h2", {}, "招待"),
          h("p", { class: "note" }, "相手の名前を入れて、できたリンクを本人に送ります。開くだけで参加できます。"),
          h(
            "form",
            {
              class: "stack",
              id: "invite-form",
              onsubmit: async (e) => {
                e.preventDefault();
                const res = await act(() =>
                  api(`/api/p/${pid}/invites`, {
                    method: "POST",
                    json: { display_name: nameInput.value },
                  }),
                );
                if (!res) return;
                nameInput.value = "";
                // 録画モードの語を先に取り直す。新しい名前が一瞬も出ないように
                await act(() => refreshTerms(pid));
                showLink(newLink, `${res.display_name}さん用のリンクです。この画面でしか表示しません。`, res.url);
                newLink.querySelector(".invite-url").id = "invite-url";
                await act(loadInvites);
              },
            },
            h("label", { htmlFor: "invite-name" }, "相手の名前"),
            nameInput,
            h("button", { class: "btn primary wide", type: "submit" }, "招待を作る"),
          ),
          newLink,
          inviteBox,
        )
      : null;

  // 本人用のリンク。別の端末で開くときと、Cookie が消えた作成者が戻るときに使う
  const selfSection =
    project.is_sample || me.scoped
      ? null
      : h(
          "section",
          { class: "section stack", id: "self-section" },
          h("h2", {}, "自分用のリンク"),
          h(
            "p",
            { class: "note" },
            project.role === "owner"
              ? "ログインはありません。この端末の記録が消えると、作成者も戻れなくなります。リンクを作って、自分だけが見る所に保存してください。"
              : "別の端末でも同じ名前で開くためのリンクです。",
          ),
          h(
            "button",
            {
              class: "btn small",
              id: "self-link",
              onclick: async () => {
                const res = await act(() => api(`/api/p/${pid}/self-link`, { method: "POST" }));
                if (res) showLink(selfBox, "自分用のリンクです。人に渡さないでください。作り直すと前のリンクは止まります。", res.url);
              },
            },
            "自分用のリンクを作る",
          ),
          selfBox,
        );

  const recordBox = h("input", {
    id: "record-mode",
    type: "checkbox",
    style: "width:32px;min-height:32px;height:32px",
    checked: recordOn(),
    onchange: async () => {
      setRecord(recordBox.checked);
      rerender();
    },
  });

  root.replaceChildren(
    h(
      "div",
      { class: "page" },
      h("a", { class: "back", id: "to-entry", href: "#/" }, "片付けの切り替え"),
      h("h1", { style: "font-size:22px" }, "人"),
      box,
      inviteForm,
      selfSection,
      h(
        "section",
        { class: "section stack" },
        h("h2", {}, "録画モード"),
        h(
          "label",
          { class: "switch-row" },
          h("span", {}, "名前と読めた文字を隠す"),
          recordBox,
        ),
        h(
          "p",
          { class: "note" },
          "名前を「親族A」「人物B」に、読めた文字を■■にします。データは変わりません。写真の中の文字は隠せません。",
        ),
      ),
    ),
  );
  act(load);
  act(loadInvites);
  return poll(() => Promise.all([load(), loadInvites()]), 5000);
}
