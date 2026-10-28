// CSV по RFC 4180: запятые, кавычки, переносы строк внутри кавычек. Первая строка — заголовок.
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

const q = (v) => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
export const toCsv = (head, rows) => [head.join(","), ...rows.map((r) => head.map((h) => q(r[h] ?? "")).join(","))].join("\n") + "\n";
