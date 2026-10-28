# NLU eval — 2026-10-28

Набор: `docs/eval/phrases_hard.csv` (40 фраз). NOW = 2026-10-21 14:30, Europe/Moscow. Провайдер: groq, rulebased.

| Метрика | Значение | Цель MVP |
|---|---|---|
| Intent accuracy | 100.0% (40/40) | ≥ 92% |
| Strict accuracy | 95.0% (38/40) | ≥ 85% (RuleBased ≥ 65%) |
| Clarification precision | 100.0% | ≥ 90% |
| Clarification recall | 100.0% | — |
| Latency p95 (весь пайплайн) | 2390 мс | ≤ 2 с |
| Доля фраз, понятых LLM (каскад вкл) | 60.0% | — |

| Категория | Фраз | Intent | Strict |
|---|---|---|---|
| colloquial | 6 | 100.0% | 100.0% |
| relative_dates | 5 | 100.0% | 100.0% |
| create_meeting | 2 | 100.0% | 100.0% |
| typos | 2 | 100.0% | 100.0% |
| list_events | 6 | 100.0% | 100.0% |
| search | 6 | 100.0% | 100.0% |
| semantic | 2 | 100.0% | 0.0% |
| clarification | 3 | 100.0% | 100.0% |
| context | 5 | 100.0% | 100.0% |
| off_topic | 2 | 100.0% | 100.0% |
| noise | 1 | 100.0% | 100.0% |

## Ошибки

- **H-27** «когда была встреча по деньгам?»: intent search; first_title: ждали "Встреча с Иваном Петровым по бюджету", получили null
- **H-29** «найди, где я про зарплату и финансы писал»: intent search; first_title: ждали "Встреча с Иваном Петровым по бюджету", получили null
