// Сборка приложения: один сервис отдаёт API (/api/v1) и статику фронта (docs/02 раздел 8).
// Зависимости передаются снаружи — тесты подменяют БД, NLU и STT.
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { apiRouter, healthHandler } from "./api/routes.js";
import { requestId, userId, rateLimit, clock, errorHandler } from "./api/middleware.js";
import { ensureUser } from "./services/items.js";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "../web");
const THREE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/three");   // three.js отдаём сами: без CDN заставка не зависает

/**
 * @param {{db, assistant, nlu, stt, embedder?, config: {production: boolean, tzDefault: string,
 *          rateLimitPerMin: number}, log?: Function}} deps
 */
export function createApp({ db, assistant, nlu, stt, embedder = null, config, log = () => {} }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);

  const tzOf = (req) => {
    const fromReq = req.body?.tz || req.query?.tz;
    if (typeof fromReq === "string" && /^[A-Za-z_]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?$/.test(fromReq)) return fromReq;
    const user = req.userId && db.prepare("SELECT tz FROM users WHERE id = ?").get(req.userId);
    return user?.tz || config.tzDefault;
  };

  const api = express.Router();
  api.use(requestId);
  api.get("/health", healthHandler({ db, nlu }));
  api.use(express.json({ limit: "16kb" }));
  api.use(userId);
  api.use(rateLimit(config.rateLimitPerMin));
  api.use(clock({ production: config.production, tzOf }));
  api.use((req, res, next) => {                       // пользователь из X-User-Id существует для всех эндпоинтов
    try { ensureUser(db, req.userId, req.tz, Math.floor(req.now.toSeconds())); next(); } catch (e) { next(e); }
  });
  api.use(apiRouter({ db, assistant, stt, embedder, nlu, log }));
  api.use((req, res) => res.status(404).json({ request_id: req.requestId, status: "error", error: { code: "NOT_FOUND", message: "unknown endpoint" } }));
  api.use(errorHandler(log));
  app.use("/api/v1", api);

  app.use("/vendor/three/build", express.static(path.join(THREE_DIR, "build"), { maxAge: "7d", immutable: true }));
  app.use("/vendor/three/examples/jsm", express.static(path.join(THREE_DIR, "examples/jsm"), { maxAge: "7d", immutable: true }));
  app.use(express.static(WEB, { extensions: ["html"], maxAge: config.production ? "1h" : 0 }));
  return app;
}
