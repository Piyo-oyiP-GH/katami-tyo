// 見本の架空画像を canvas で作り、public/sample/ に JPEG で書き出す。
//   node src/sample/make-images.mjs
// 本物の写真は使わない。ここの画像は公開 URL で開けるので、架空の物だけにする。
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { SAMPLE_ITEMS } from "./data.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const browser = await chromium.launch();
const page = await browser.newPage();

const draw = ({ item, width, height }) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d");
  const s = width / 960;
  g.scale(s, s);
  const W = 960;
  const H = 720;
  // 机の面
  g.fillStyle = "#8d8577";
  g.fillRect(0, 0, W, H);
  if (item.blur) g.filter = `blur(${item.blur}px)`;

  const lines = item.a.lines.map((l) => l.text.replaceAll("〔不明〕", "□□"));
  const paper = (x, y, w, h, color, tilt = -0.02) => {
    g.save();
    g.translate(x + w / 2, y + h / 2);
    g.rotate(tilt);
    g.fillStyle = "rgba(0,0,0,.25)";
    g.fillRect(-w / 2 + 8, -h / 2 + 10, w, h);
    g.fillStyle = color;
    g.fillRect(-w / 2, -h / 2, w, h);
    g.restore();
  };
  const text = (t, x, y, size, color = "#27303b", font = "serif") => {
    g.fillStyle = color;
    g.font = `${size}px ${font}`;
    g.fillText(t, x, y);
  };

  if (item.paper === "letter") {
    paper(190, 70, 580, 580, "#efe7d2");
    lines.forEach((t, i) => text(t, 250, 170 + i * 110, 40, "#23407a", "cursive, serif"));
  } else if (item.paper === "photo") {
    paper(180, 90, 600, 540, "#f6f4ee", 0.03);
    text("（写真の裏）", 240, 170, 28, "#8a8578");
    lines.forEach((t, i) => text(t, 240, 280 + i * 110, 44, "#555", "cursive, serif"));
  } else if (item.paper === "award") {
    paper(160, 40, 640, 640, "#f7f3e6", 0);
    g.strokeStyle = "#a88f4a";
    g.lineWidth = 8;
    g.strokeRect(190, 70, 580, 580);
    lines.forEach((t, i) => text(t, 240, 180 + i * 120, i === 0 ? 72 : 42));
  } else if (item.paper === "card") {
    paper(120, 180, 720, 360, "#dfe8d8", 0.015);
    lines.forEach((t, i) => text(t, 170, 260 + i * 72, 38, i === 0 ? "#2c5a3a" : "#3a3a3a", "cursive, sans-serif"));
  } else if (item.paper === "note") {
    paper(240, 60, 480, 600, "#5d6f7f", -0.03);
    paper(280, 110, 400, 500, "#f1ecdd", -0.03);
    lines.forEach((t, i) => text(t, 310, 200 + i * 120, 32, "#2b3550", "cursive, serif"));
  } else if (item.paper === "box") {
    paper(220, 170, 520, 380, "#c9b48c", 0.01);
    g.strokeStyle = "#8f7a52";
    g.lineWidth = 6;
    for (let i = 1; i < 4; i++) {
      g.beginPath();
      g.moveTo(220 + i * 130, 170);
      g.lineTo(220 + i * 130, 550);
      g.stroke();
    }
    paper(300, 300, 360, 100, "#fbfaf4", 0);
    lines.forEach((t) => text(t, 330, 366, 44, "#333", "cursive, sans-serif"));
  } else if (item.paper === "board") {
    paper(210, 90, 540, 540, "#f4efe3", 0.02);
    g.strokeStyle = "#b8963e";
    g.lineWidth = 6;
    g.strokeRect(226, 106, 508, 508);
    const inks = ["#7a2f4b", "#23407a", "#2c5a3a", "#555"];
    lines.forEach((t, i) => text(t, 262, 200 + i * 105, 32, inks[i % 4], "cursive, serif"));
  } else if (item.paper === "greeting") {
    paper(200, 110, 560, 500, "#fdf3d7", -0.025);
    for (const [x, y, c] of [[640, 190, "#d9645a"], [695, 245, "#4f8fc0"], [610, 260, "#e0b23c"]]) {
      g.fillStyle = c;
      g.beginPath();
      g.ellipse(x, y, 32, 40, 0, 0, Math.PI * 2);
      g.fill();
    }
    lines.forEach((t, i) => text(t, 250, 240 + i * 120, 42, "#a4432f", "cursive, serif"));
  } else if (item.paper === "recipe") {
    paper(170, 150, 620, 420, "#fbf8ee", 0.02);
    g.strokeStyle = "#a9c4dc";
    g.lineWidth = 2;
    for (let y = 250; y < 550; y += 70) {
      g.beginPath();
      g.moveTo(180, y);
      g.lineTo(780, y);
      g.stroke();
    }
    g.fillStyle = "rgba(196,160,90,.35)";
    g.beginPath();
    g.ellipse(690, 490, 56, 38, 0.4, 0, Math.PI * 2);
    g.fill();
    lines.forEach((t, i) => text(t, 210, 240 + i * 105, 40, "#333", "cursive, serif"));
  } else if (item.paper === "manual") {
    paper(250, 60, 460, 600, "#e9eef0", 0.015);
    g.fillStyle = "#9db2bd";
    g.fillRect(400, 260, 160, 220);
    g.fillStyle = "#5f7884";
    g.fillRect(430, 225, 100, 35);
    const [head, tail] = lines[0].split(" ");
    text(head, 290, 150, 38, "#28414d", "sans-serif");
    text(tail, 290, 200, 38, "#28414d", "sans-serif");
    text(lines[1], 290, 590, 32, "#28414d", "sans-serif");
  } else {
    g.fillStyle = "#e8eef2";
    g.beginPath();
    g.moveTo(330, 200);
    g.lineTo(630, 200);
    g.lineTo(590, 540);
    g.lineTo(370, 540);
    g.closePath();
    g.fill();
    g.strokeStyle = "#2f5e8e";
    g.lineWidth = 12;
    for (const y of [280, 340, 400]) {
      g.beginPath();
      g.moveTo(345, y);
      g.lineTo(615, y);
      g.stroke();
    }
  }
  g.filter = "none";
  return canvas.toDataURL("image/jpeg", 0.8).split(",")[1];
};

const dir = path.join(root, "public", "sample");
mkdirSync(dir, { recursive: true });
let bytes = 0;
for (const item of SAMPLE_ITEMS) {
  for (const [name, width, height] of [
    [`${item.key}.jpg`, 960, 720],
    [`${item.key}-thumb.jpg`, 320, 240],
  ]) {
    const jpeg = Buffer.from(await page.evaluate(draw, { item, width, height }), "base64");
    writeFileSync(path.join(dir, name), jpeg);
    bytes += jpeg.length;
  }
}
await browser.close();
console.log(`${SAMPLE_ITEMS.length * 2} 枚、${Math.round(bytes / 1024)}KB`);
