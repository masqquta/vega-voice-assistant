-- 002: повторяющиеся записи. NULL — разовая; "daily" | "weekdays" | "weekly:N" | "monthly:D" (server/domain/repeat.js)
ALTER TABLE items ADD COLUMN repeat TEXT;
