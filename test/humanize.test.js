// Перефразирование ответа LLM: факты (время, дата, название, вопрос) обязаны сохраниться, иначе — шаблон.
import { test } from "node:test";
import assert from "node:assert/strict";
import { keepsFacts, createHumanizer } from "../server/reply/humanize.js";

const T = "Готово. Напомню завтра, 29 октября, в 10:00: позвонить Ивану.";

test("живой перефраз с теми же фактами принимается", () => {
  assert.ok(keepsFacts(T, "Хорошо, завтра, 29 октября, в 10:00 напомню вам позвонить Ивану."));
});
test("потеряно время / дата / название / вопрос — отклоняется", () => {
  assert.ok(!keepsFacts(T, "Хорошо, завтра утром напомню позвонить Ивану."));
  assert.ok(!keepsFacts(T, "Хорошо, в 10:00 напомню позвонить Ивану."));
  assert.ok(!keepsFacts("Записала задачу «Купить билеты».", "Записала, не забудьте про билеты."));
  assert.ok(!keepsFacts("На какое время поставить встречу?", "Поставлю встречу."));
  assert.ok(!keepsFacts(T, "**Готово!** 29 октября в 10:00 — позвонить Ивану, завтра."));
});
test("LLM ответила мусором или упала — остаётся шаблон", async () => {
  const bad = createHumanizer({ llm: { available: () => true, complete: async () => "Конечно!" } });
  assert.equal(await bad({ action: "create_task", status: "ok", reply: T }, "напомни"), T);
  const down = createHumanizer({ llm: { available: () => true, complete: async () => { throw new Error("503"); } } });
  assert.equal(await down({ action: "create_task", status: "ok", reply: T }, "напомни"), T);
  const good = createHumanizer({ llm: { available: () => true, complete: async () => "Договорились: завтра, 29 октября, в 10:00 напомню позвонить Ивану." } });
  assert.match(await good({ action: "create_task", status: "ok", reply: T }, "напомни"), /^Договорились/);
});
test("списки и найденное не переписываются — там важен каждый пункт", async () => {
  const llm = { available: () => true, complete: async () => { throw new Error("не должно вызываться"); } };
  const h = createHumanizer({ llm });
  assert.equal(await h({ action: "list_events", status: "ok", reply: "Завтра два дела: …" }, "что завтра"), "Завтра два дела: …");
});
