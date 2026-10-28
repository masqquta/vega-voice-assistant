// STT-адаптер: transcribe(buffer, mime) → { text }. Провайдер выбирается STT_PROVIDER (yandex | whisper).
// Браузерный MediaRecorder пишет webm/opus (Chrome, Firefox) или mp4/aac (Safari).
import { config } from "../config.js";
import * as yandex from "./yandex.js";
import * as whisper from "./whisper.js";

export const SUPPORTED = ["audio/webm", "audio/ogg", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/wav", "audio/x-wav"];
export const baseMime = (m) => String(m || "").split(";")[0].trim().toLowerCase();

export function createStt(provider = config.sttProvider) {
  const impl = provider === "whisper" ? whisper : yandex;
  return {
    name: impl.name,
    available: impl.available,
    async transcribe(buffer, mime) {
      if (!SUPPORTED.includes(baseMime(mime))) throw Object.assign(new Error(`unsupported ${mime}`), { code: "AUDIO_FORMAT" });
      if (!impl.available()) throw Object.assign(new Error("stt not configured"), { code: "STT_UNAVAILABLE" });
      try {
        return { text: String(await impl.transcribe(buffer, baseMime(mime))).trim() };
      } catch (e) {
        throw Object.assign(e, { code: e.code === "AUDIO_FORMAT" ? "AUDIO_FORMAT" : "STT_UNAVAILABLE" });
      }
    },
  };
}
