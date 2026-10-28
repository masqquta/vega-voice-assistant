// Общие правила контракта (docs/03 раздел 1): request_id, X-User-Id, лимит запросов, X-Debug-Now, ошибки.
import crypto from "node:crypto";
import { nowIn } from "../dates/resolver.js";

export class ApiError extends Error {
  constructor(http, code, message, details) { super(message); this.http = http; this.code = code; this.details = details; }
}

export const errorBody = (req, code, message, details) => ({
  request_id: req.requestId, status: "error", error: { code, message, ...(details ? { details } : {}) },
});

export function requestId(req, res, next) {
  req.requestId = `r_${crypto.randomBytes(3).toString("hex")}`;
  res.setHeader("X-Request-Id", req.requestId);
  next();
}

/** X-User-Id обязателен (anonymous uuid из localStorage). Нет заголовка → 400 USER_REQUIRED. */
export function userId(req, res, next) {
  const id = req.get("X-User-Id");
  if (!id || !/^[\w-]{1,64}$/.test(id)) return next(new ApiError(400, "USER_REQUIRED", "X-User-Id header is required"));
  req.userId = id;
  next();
}

/** Не больше N запросов в минуту с одного пользователя (скользящее окно в памяти). */
export function rateLimit(perMin) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const arr = (hits.get(req.userId) || []).filter((t) => now - t < 60_000);
    if (arr.length >= perMin) return next(new ApiError(429, "RATE_LIMIT", "too many requests"));
    arr.push(now);
    hits.set(req.userId, arr);
    next();
  };
}

/** NOW запроса в таймзоне пользователя. X-Debug-Now подменяет его только вне production (нужен тестам). */
export function clock({ production, tzOf }) {
  return (req, res, next) => {
    const tz = tzOf(req);
    const debug = req.get("X-Debug-Now");
    let now = nowIn(tz);
    if (debug && !production) {
      const d = nowIn(tz, debug);
      if (!d.isValid) return next(new ApiError(400, "VALIDATION", "X-Debug-Now must be ISO 8601"));
      now = d;
    }
    req.tz = tz;
    req.now = now;
    next();
  };
}

export function errorHandler(log) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (err instanceof ApiError) return res.status(err.http).json(errorBody(req, err.code, err.message, err.details));
    if (err.type === "entity.parse.failed") return res.status(400).json(errorBody(req, "VALIDATION", "invalid JSON"));
    if (err.type === "entity.too.large") return res.status(413).json(errorBody(req, "PAYLOAD_TOO_LARGE", "request body too large"));
    if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json(errorBody(req, "PAYLOAD_TOO_LARGE", "audio is larger than 1 MB"));
    if (err.code === "VALIDATION") return res.status(400).json(errorBody(req, "VALIDATION", err.message, err.details));
    log({ level: "error", event: "unhandled", request_id: req.requestId, error: err.message, stack: err.stack });
    return res.status(500).json(errorBody(req, "INTERNAL", "Что-то пошло не так. Попробуйте ещё раз."));
  };
}
