// 撮る。
// 伝えること：「撮ったら、残したい／迷う／処分したいを選ぶだけ」
// シャッターで撮ると写真が浮き、下の段が 3 択に変わる。選ぶと写真が左下へ吸い込まれ、取り消しの帯が出る。
// 「処分したい」を押してもその場では消さない。送るのは取り消しの 5 秒の後（uploader.js と同じ）
import { useEffect, useReducer, useRef, useState } from "react";
import { PILES, PILE_NAMES, errorText, itemTitle } from "../api";
import type { ProjectCtx } from "../App";
import * as up from "../lib/uploader.js";
import { loadCurrentPlace, loadPlaces, saveCurrentPlace } from "../ui";

type Entry = {
  cid: string;
  pile: string;
  state: "hold" | "wait" | "sending" | "sent" | "rejected" | "undone";
  url: string;
  holdUntil?: number;
  error: string | null;
  item: { id: string } | null;
};

const NATIVE_KEY = "matta.nativeCamera";
const preferNative = () => {
  try {
    return localStorage.getItem(NATIVE_KEY) === "1";
  } catch {
    return false;
  }
};

async function openCamera(video: HTMLVideoElement, cancelled: () => boolean) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: "environment" }, width: { ideal: 4096 }, height: { ideal: 3072 } },
  });
  // 開くあいだに画面を離れていたら（開発中の StrictMode の 2 回目を含む）、映像につながない
  if (cancelled()) return stream;
  video.srcObject = stream;
  await video.play();
  return stream;
}

// 原寸の 1 枚を取る。ImageCapture があれば写真の解像度で撮れる
async function grab(video: HTMLVideoElement, stream: MediaStream): Promise<Blob | null> {
  const track = stream.getVideoTracks()[0];
  const IC = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => { takePhoto(): Promise<Blob> } }).ImageCapture;
  if (IC && track) {
    try {
      return await new IC(track).takePhoto();
    } catch {
      // 下の方法に切り替える
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d")!.drawImage(video, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
}

export function Capture({ ctx }: { ctx: ProjectCtx }) {
  const { pid, project, me, items } = ctx;
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nativeRef = useRef<HTMLInputElement>(null);
  const floatRef = useRef<HTMLDivElement>(null);
  const lastRef = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState(false);
  const [pending, setPending] = useState<{ blob: Blob; url: string } | null>(null);
  const [flying, setFlying] = useState<{ url: string; to: string } | null>(null);
  const [flash, setFlash] = useState(0);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [placeId, setPlaceId] = useState(() => loadCurrentPlace(pid));
  useEffect(() => {
    document.title = `撮る｜${project.title}`;
  }, [project.title]);
  const places = loadPlaces(pid);

  // 送り状況が変わるたびに描き直す。取り消しの残り秒も
  useEffect(() => {
    const off = up.onChange(bump);
    const clock = setInterval(bump, 500);
    return () => {
      off();
      clearInterval(clock);
    };
  }, []);

  useEffect(() => {
    let leaving = false;
    const canLive = window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
    if (canLive && !preferNative() && videoRef.current) {
      openCamera(videoRef.current, () => leaving).then(
        (s) => {
          if (leaving) s.getTracks().forEach((t) => t.stop());
          else {
            streamRef.current = s;
            setLive(true);
          }
        },
        () => setLive(false),
      );
    }
    return () => {
      leaving = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  const entries = up.list(pid) as Entry[];
  const held = entries.find((e) => e.state === "hold");
  const rejected = entries.filter((e) => e.state === "rejected");
  const unsent = entries.filter((e) => e.state !== "sent").length;
  const total = (items?.length ?? 0) + unsent;
  const last = entries[0];
  const lastItem = last?.item ? items?.find((i) => i.id === last.item!.id) : null;

  const shoot = async () => {
    if (pending) return;
    const stream = streamRef.current;
    if (!stream || !videoRef.current) {
      nativeRef.current?.click();
      return;
    }
    setFlash((n) => n + 1);
    const blob = await grab(videoRef.current, stream);
    if (blob) setPending({ blob, url: URL.createObjectURL(blob) });
  };

  const choose = (pile: string) => {
    if (!pending) return;
    up.add(pid, pile, pending.blob);
    // 浮いた写真を、左下の直前の写真の場所へ動かす
    const f = floatRef.current?.getBoundingClientRect();
    const l = lastRef.current?.getBoundingClientRect();
    const to =
      f && l
        ? `translate(${l.left + l.width / 2 - (f.left + f.width / 2)}px, ${l.top + l.height / 2 - (f.top + f.height / 2)}px) scale(${l.width / f.width})`
        : "scale(0.3)";
    const url = pending.url;
    setFlying({ url, to });
    setPending(null);
    window.setTimeout(() => {
      setFlying(null);
      URL.revokeObjectURL(url);
    }, 420);
  };

  const left = held?.holdUntil ? Math.max(1, Math.ceil((held.holdUntil - Date.now()) / 1000)) : 0;

  return (
    <div className="screen cam">
      <div className="view">
        <video ref={videoRef} muted playsInline autoPlay hidden={!live} />
        {!live ? (
          <p className="cam-hint" id="native-hint">
            シャッターを押すと、標準のカメラが開きます。
          </p>
        ) : null}
        {pending ? <div className="dim" /> : null}
        {flash ? <div key={flash} className="flash" aria-hidden="true" /> : null}
        <div className="cam-top">
          <a className="pill" href={`#/p/${pid}`} aria-label="つながりへ戻る">
            ← 戻る
          </a>
          <label className="pill pill-select">
            <span>置き場：</span>
            <select
              aria-label="置き場"
              value={placeId ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "__edit") {
                  location.hash = `#/p/${pid}/places?back=capture`;
                  return;
                }
                setPlaceId(v || null);
                saveCurrentPlace(pid, v || null);
              }}
            >
              <option value="">決めない</option>
              {places.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              <option value="__edit">置き場を作る…</option>
            </select>
          </label>
          <span className="pill" id="count">
            {total}点
          </span>
        </div>
        {project.is_sample ? (
          <p className="cam-note" id="sample-cost">
            見本の中で撮ると、本物の Claude を呼びます。料金がかかります。読めるのは {me.limits.sample_photos} 枚までです。
          </p>
        ) : null}
        {pending ? (
          <div className="float in" ref={floatRef}>
            <img src={pending.url} alt="撮った写真" />
          </div>
        ) : null}
        {flying ? (
          <div className="float go" style={{ transform: flying.to }}>
            <img src={flying.url} alt="" />
          </div>
        ) : null}
        {held ? (
          <div className="undo" id="undo-bar" role="status">
            <span>
              {PILE_NAMES[held.pile]}に入れました。<span aria-hidden="true">あと {left} 秒で送ります</span>
            </span>
            <button id="undo" onClick={() => up.undo(held.cid)}>
              取り消す
            </button>
          </div>
        ) : rejected.length ? (
          <div className="undo" role="alert">
            <span>{errorText(rejected[0].error) ?? "送れなかった写真があります"}</span>
            {up.canResend(rejected[0]) ? <button onClick={() => up.retryNow()}>もう一度送る</button> : null}
            <button onClick={() => up.discard(rejected[0].cid)}>外す</button>
          </div>
        ) : null}
      </div>

      <div className="dock">
        {pending ? (
          <>
            <p className="dock-hint">この物は？</p>
            <div className="three">
              {PILES.map((p) => (
                <button key={p} className={`three-${p}`} id={`pile-${p}`} onClick={() => choose(p)}>
                  {PILE_NAMES[p]}
                </button>
              ))}
            </div>
            <button className="retake" onClick={() => {
                URL.revokeObjectURL(pending.url);
                setPending(null);
              }}>
              撮り直す
            </button>
          </>
        ) : (
          <>
            <p className="dock-hint">
              {last && last.state === "sent"
                ? lastItem?.status === "done"
                  ? `直前の物：${itemTitle(lastItem)}`
                  : "直前の物を Claude が読み取っています"
                : last?.error === "offline"
                  ? "通信待ち。写真は残っています"
                  : "撮ると、入れ先を聞きます"}
            </p>
            <div className="bar">
              <div className="last" ref={lastRef}>
                {last ? <img src={last.url} alt="直前の写真" /> : null}
              </div>
              {live ? (
                <button className="shutter" id="shutter" aria-label="撮る" onClick={shoot} />
              ) : (
                // 生のカメラが使えない（http や許可なし）ときは、ラベルで標準のカメラを開く。
                // スクリプトからの click() は、端末によっては開かない
                <label
                  className="shutter"
                  id="shutter"
                  htmlFor="native-camera"
                  role="button"
                  tabIndex={0}
                  aria-label="撮る"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      nativeRef.current?.click();
                    }
                  }}
                />
              )}
              <div className="count" aria-hidden="true">
                <b>{total}</b>点
              </div>
            </div>
          </>
        )}
      </div>
      <input
        ref={nativeRef}
        id="native-camera"
        type="file"
        accept="image/*"
        capture="environment"
        className="vh"
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) setPending({ blob: file, url: URL.createObjectURL(file) });
        }}
      />
    </div>
  );
}
