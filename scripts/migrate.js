// npm run migrate — применяет новые миграции к DB_PATH.
import { config } from "../server/config.js";
import { openDb } from "../server/db/index.js";

const db = openDb(config.dbPath);
const versions = db.prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version").all();
console.log(`DB ${config.dbPath}: применены миграции ${versions.map((v) => v.version).join(", ") || "—"}`);
db.close();
