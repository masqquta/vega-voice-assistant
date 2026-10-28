// Переменные окружения (шаблон — .env.example). Секреты только из окружения.
import fs from "node:fs";

// .env для локального запуска (без зависимостей): KEY=VALUE построчно, окружение важнее файла
if (fs.existsSync(".env")) {
  for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const env = process.env;
export const config = {
  port: Number(env.PORT || 3000),
  production: env.NODE_ENV === "production",
  dbPath: env.DB_PATH || "data/app.db",
  tzDefault: env.TZ_DEFAULT || "Europe/Moscow",
  yandex: {
    apiKey: env.YANDEX_API_KEY || "",
    folderId: env.YANDEX_FOLDER_ID || "",
    llmModel: env.YANDEX_LLM_MODEL || "yandexgpt/latest",
  },
  groq: {
    apiKey: env.GROQ_API_KEY || "",
    models: (env.GROQ_MODELS || "openai/gpt-oss-120b,qwen/qwen3.8-27b,openai/gpt-oss-20b")
      .split(",").map((s) => s.trim()).filter(Boolean),
  },
  openrouter: {
    apiKey: env.OPENROUTER_API_KEY || "",
    models: (env.OPENROUTER_MODELS || "nvidia/nemotron-3.5-super-vl:free,nvidia/nemotron-3.5-lightning:free,nvidia/nemotron-3-ultra-550b-a55b:free")
      .split(",").map((s) => s.trim()).filter(Boolean),
  },
  gigachat: {
    authKey: env.GIGACHAT_AUTH_KEY || "",
    scope: env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS",
    model: env.GIGACHAT_MODEL || "GigaChat",
  },
  // Есть ключ Groq — распознавание через бесплатный Whisper на Groq; иначе SpeechKit или браузер
  sttProvider: env.STT_PROVIDER || (env.GROQ_API_KEY ? "whisper" : "yandex"),
  whisperApiKey: env.WHISPER_API_KEY || env.GROQ_API_KEY || "",
  whisperUrl: env.WHISPER_URL || (!env.WHISPER_API_KEY && env.GROQ_API_KEY
    ? "https://api.groq.com/openai/v1/audio/transcriptions" : "https://api.openai.com/v1/audio/transcriptions"),
  whisperModel: env.WHISPER_MODEL || (!env.WHISPER_API_KEY && env.GROQ_API_KEY ? "whisper-large-v3-turbo" : "whisper-1"),
  llmTimeoutMs: Number(env.LLM_TIMEOUT_MS || 4000),
  embeddings: env.EMBEDDINGS || "local",        // local | yandex | off
  semThreshold: env.SEM_THRESHOLD ? Number(env.SEM_THRESHOLD) : null,
  modelCacheDir: env.MODEL_CACHE_DIR || ".cache/models",
  nluCascade: env.NLU_CASCADE !== "0",
  humanize: env.HUMANIZE !== "0",               // 0 — отвечать шаблонами без перефразирования LLM          // 0 — всегда спрашивать LLM (для сравнения в eval)
  rateLimitPerMin: Number(env.RATE_LIMIT_PER_MIN || 30),
  seedDemo: env.SEED_DEMO !== "0",
};
