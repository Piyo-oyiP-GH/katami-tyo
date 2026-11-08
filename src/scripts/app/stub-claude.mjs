// 画面の試験で使う、Claude の代わりのサーバ。ヘッダは読まず、記録もしない。
// 中身は架空の固定の文字。POST /__fail?n=3 で、次の n 回を 400 で失敗させる。
// call=A|A2|B|P で呼び出しを絞り、status で失敗の番号を変えられる。
// POST /__reply に JSON を送ると、答えの中身を書き換える。{ "__stop_reason": "refusal" } は B だけを断る。
import http from "node:http";

const BASE_REPLY = () => JSON.parse(JSON.stringify(ORIGINAL));
const port = Number(process.argv[2] ?? 8793);
let delayMs = Number(process.argv[3] ?? 1500);
let hits = 0;
let failNext = 0;
let failCall = null;
let failStatus = 400;

let REPLY = {
  lines: [
    { text: "架空 太郎", type: "name", handwritten: true, where: "上", certainty: "high" },
    { text: "二〇〇一年", type: "date", handwritten: true, where: "下", certainty: "high" },
  ],
  kind: "試験の紙",
  synonyms: ["テスト"],
  evidence: ["白い紙"],
  signals: ["手書き", "古び"],
  proper_nouns: [],
  inferences: ["試験用の紙かもしれない"],
  changes: [],
  add: [],
  update: [],
  retire: [],
};

const ORIGINAL = JSON.parse(JSON.stringify(REPLY));
let refuseObserve = false;

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/__hits") return res.end(String(hits));
    if (url.pathname === "/__delay") {
      delayMs = Number(url.searchParams.get("ms") ?? 100);
      return res.end("ok");
    }
    if (url.pathname === "/__reply") {
      const body = [];
      req.on("data", (c) => body.push(c));
      req.on("end", () => {
        const change = JSON.parse(Buffer.concat(body).toString("utf8") || "{}");
        refuseObserve = change.__stop_reason === "refusal";
        delete change.__stop_reason;
        REPLY = { ...BASE_REPLY(), ...change };
        res.end("ok");
      });
      return;
    }
    if (url.pathname === "/__fail") {
      failNext = Number(url.searchParams.get("n") ?? 1);
      failCall = url.searchParams.get("call");
      failStatus = Number(url.searchParams.get("status") ?? 400);
      return res.end("ok");
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      hits++;
      // /__fail は読み取りの失敗を作るためのもの。人物の更新の呼び出しは数えない
      const bodyBuf = Buffer.concat(chunks);
      const isPersons = bodyBuf.includes("current_cards");
      const isObserve = bodyBuf.includes("kind") && bodyBuf.includes("proper_nouns");
      const call = isPersons ? "P" : isObserve ? "B" : bodyBuf.includes("人名、日付、数字だけ") ? "A2" : "A";
      const fail = failNext > 0 && (failCall ? call === failCall : !isPersons);
      if (fail) failNext--;
      setTimeout(() => {
        res.setHeader("content-type", "application/json");
        if (fail) {
          res.statusCode = failStatus;
          return res.end(
            JSON.stringify({
              type: "error",
              error: { type: "invalid_request_error", message: "stub failure" },
            }),
          );
        }
        res.end(
          JSON.stringify({
            id: "msg_stub",
            type: "message",
            role: "assistant",
            model: "claude-opus-5-5",
            content: [{ type: "text", text: JSON.stringify(REPLY) }],
            stop_reason: refuseObserve && isObserve ? "refusal" : "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      }, delayMs);
    });
  })
  .listen(port, "127.0.0.1");
