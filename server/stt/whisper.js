// Whisper (OpenAI-совместимый /audio/transcriptions). Принимает webm, ogg, mp4, wav как есть.
import { config } from "../config.js";

export const name = "whisper";
export const available = () => Boolean(config.whisperApiKey);

const EXT = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "mp4", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/wav": "wav", "audio/x-wav": "wav" };

export async function transcribe(buffer, mime) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mime }), `voice.${EXT[mime] || "webm"}`);
  form.append("model", process.env.WHISPER_MODEL || "whisper-1");
  form.append("language", "ru");
  const res = await fetch(process.env.WHISPER_URL || "https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.whisperApiKey}` },
    body: form,
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw Object.assign(new Error(`whisper HTTP ${res.status}`), { status: res.status });
  return (await res.json()).text || "";
}
