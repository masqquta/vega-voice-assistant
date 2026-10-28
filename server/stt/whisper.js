// Whisper (OpenAI-совместимый /audio/transcriptions): по умолчанию бесплатный whisper-large-v3-turbo на Groq.
// Принимает webm, ogg, mp4, wav как есть.
import { config } from "../config.js";

export const name = "whisper";
export const available = () => Boolean(config.whisperApiKey);

const EXT = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "mp4", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/wav": "wav", "audio/x-wav": "wav" };

export async function transcribe(buffer, mime) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mime }), `voice.${EXT[mime] || "webm"}`);
  form.append("model", config.whisperModel);
  form.append("language", "ru");
  const res = await fetch(config.whisperUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.whisperApiKey}` },
    body: form,
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw Object.assign(new Error(`whisper HTTP ${res.status}`), { status: res.status });
  return (await res.json()).text || "";
}
