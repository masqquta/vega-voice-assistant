# NLU eval — 2026-10-28

Набор: `docs/eval/phrases_hard.csv` (40 фраз). NOW = 2026-10-21 14:30, Europe/Moscow. Провайдер: rulebased.

| Метрика | Значение | Цель MVP |
|---|---|---|
| Intent accuracy | 82.5% (33/40) | ≥ 92% |
| Strict accuracy | 67.5% (27/40) | ≥ 85% (RuleBased ≥ 65%) |
| Clarification precision | 60.0% | ≥ 90% |
| Clarification recall | 100.0% | — |
| Latency p95 (весь пайплайн) | 5 мс | ≤ 2 с |

| Категория | Фраз | Intent | Strict |
|---|---|---|---|
| colloquial | 6 | 100.0% | 83.3% |
| relative_dates | 5 | 100.0% | 80.0% |
| create_meeting | 2 | 100.0% | 100.0% |
| typos | 2 | 100.0% | 50.0% |
| list_events | 6 | 33.3% | 16.7% |
| search | 6 | 50.0% | 50.0% |
| semantic | 2 | 100.0% | 0.0% |
| clarification | 3 | 100.0% | 100.0% |
| context | 5 | 100.0% | 100.0% |
| off_topic | 2 | 100.0% | 100.0% |
| noise | 1 | 100.0% | 100.0% |

## Ошибки

- **H-1** «слушай, не забудь в субботу ближе к вечеру сказать, чтоб я маме купил цветы»: intent create_task; уточнение задано лишнее; type: ждали "reminder", получили null; due_date: ждали "2026-10-24", получили null; due_time: ждали "19:00", получили null
- **H-7** «напомни через полтора часа выключить духовку»: intent create_task; уточнение задано лишнее; type: ждали "reminder", получили null; due_date: ждали "2026-10-21", получили null; due_time: ждали "16:00", получили null
- **H-14** «в четверк в 3 часа дня встреча с бухгалтером»: intent create_meeting; due_date: ждали "2026-10-22", получили "2026-10-21"
- **H-16** «чё там по планам на выходные?»: intent unknown (ждали list_events); period_from: ждали "2026-10-24", получили null; period_to: ждали "2026-10-25", получили null
- **H-18** «есть чё на сегодня?»: intent create_task (ждали list_events); period_from: ждали "2026-10-21", получили null
- **H-19** «расскажи, что меня ждёт на следующей неделе»: intent create_task (ждали list_events); period_from: ждали "2026-10-26", получили null; period_to: ждали "2026-11-01", получили null
- **H-20** «покажи мои дела на 30-е»: intent list_events; period_from: ждали "2026-10-30", получили "2026-10-21"
- **H-21** «мне на этой неделе что-то надо было сделать?»: intent create_task (ждали list_events); period_from: ждали "2026-10-19", получили null; period_to: ждали "2026-10-25", получили null
- **H-23** «где у меня было про бухгалтерию»: intent unknown (ждали search); first_title: ждали "Отправить счёт в бухгалтерию", получили null
- **H-24** «когда мы созванивались с дизайнером?»: intent unknown (ждали search); first_title: ждали "Созвон с дизайнером по макетам", получили null
- **H-27** «когда была встреча по деньгам?»: intent search; first_title: ждали "Встреча с Иваном Петровым по бюджету", получили null
- **H-28** «покажи всё, что связано с макетами»: intent list_events (ждали search); first_title: ждали "Созвон с дизайнером по макетам", получили null
- **H-29** «найди, где я про зарплату и финансы писал»: intent search; first_title: ждали "Встреча с Иваном Петровым по бюджету", получили null
