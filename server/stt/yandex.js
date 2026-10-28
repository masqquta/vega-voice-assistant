// SpeechKit, синхронное распознавание (до 30 с, до 1 МБ). Принимает OggOpus или LPCM, поэтому
// webm/mp4 из браузера перекодируем ffmpeg в ogg/opus (в Docker-образе ffmpeg установлен).
import { spawn } from "node:child_process";
import { config } from "../config.js";

export const name = "yandex";
export const available = () => Boolean(config.yandex.apiKey && config.yandex.folderId);

function toOggOpus(buffer) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn", "-ac", "1",
      "-c:a", "libopus", "-b:a", "32k", "-ar", "48000", "-f", "ogg", "pipe:1"]);
    const chunks = [];
    ff.stdout.on("data", (c) => chunks.push(c));
    ff.on("error", (e) => reject(Object.assign(e, { code: "AUDIO_FORMAT" })));
    ff.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(Object.assign(new Error(`ffmpeg exit ${code}`), { code: "AUDIO_FORMAT" }))));
    ff.stdin.on("error", () => {});
    ff.stdin.end(buffer);
  });
}

export async function transcribe(buffer, mime) {
  const audio = mime === "audio/ogg" ? buffer : await toOggOpus(buffer);
  const url = new URL("https://stt.api.cloud.yandex.net/speech/v1/stt:recognize");
  url.search = new URLSearchParams({ lang: "ru-RU", folderId: config.yandex.folderId, format: "oggopus" }).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Api-Key ${config.yandex.apiKey}` },
    body: audio,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw Object.assign(new Error(`speechkit HTTP ${res.status}`), { status: res.status });
  return (await res.json()).result || "";
}
