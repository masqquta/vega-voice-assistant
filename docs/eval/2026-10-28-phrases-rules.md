# NLU eval — 2026-10-28

Набор: `docs/eval/phrases.csv` (65 фраз). NOW = 2026-10-21 14:30, Europe/Moscow. Провайдер: rulebased.

| Метрика | Значение | Цель MVP |
|---|---|---|
| Intent accuracy | 100.0% (65/65) | ≥ 92% |
| Strict accuracy | 100.0% (65/65) | ≥ 85% (RuleBased ≥ 65%) |
| Clarification precision | 100.0% | ≥ 90% |
| Clarification recall | 100.0% | — |
| Latency p95 (весь пайплайн) | 6 мс | ≤ 2 с |
| Доля фраз, понятых LLM (каскад вкл) | 0.0% | — |

| Категория | Фраз | Intent | Strict |
|---|---|---|---|
| create_task | 11 | 100.0% | 100.0% |
| noise | 4 | 100.0% | 100.0% |
| relative_dates | 3 | 100.0% | 100.0% |
| create_meeting | 9 | 100.0% | 100.0% |
| clarification | 11 | 100.0% | 100.0% |
| list_events | 11 | 100.0% | 100.0% |
| search | 10 | 100.0% | 100.0% |
| context | 3 | 100.0% | 100.0% |
| off_topic | 3 | 100.0% | 100.0% |

## Ошибки

Нет.
