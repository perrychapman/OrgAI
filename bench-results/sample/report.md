# Org chart benchmark report

- label: sample
- model: test-model
- date: 2026-11-19T00:00:00.000Z; commit: abc1234; scorer version: 1
- sessions: 9 (8 scored, 1 skipped); reported spend $3.23 of a $5.00 cap

## Recommendation (mean 57.4 / 100)

| scenario | cx | n | score | valid | struct | size | cover | priv | tier | prompt | roles | depth | tier mix | cost proxy | asks | q turns | revise | $ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| c1 | 1 | 2 | 72.3 | 88 | 93 | 63 | 100 | 50 | 50 | 51 | 4.0 | 1.5 | top 1, deep 5, everyday 1, other 1 | 11.0 | 1.5 | 1.5 | 1.0 | $0.85 |
| c4 | 4 | 1 | 100.0 | 100 | 100 | 100 | 100 | 100 | 100 | 100 | 10.0 | 2.0 | deep 3, everyday 7 | 16.0 | 0.0 | 1.0 | 0.0 | $0.93 |
| c2 | 2 | 1 | 0.0 (1 no chart) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0 | 0.0 | - | 0.0 | 2.0 | 3.0 | 0.0 | $0.31 |

Dimension columns are percent of the dimension; the score is out of 100 (weights in docs/design/org-chart-benchmark.md). Cost proxy: top 5, deep 3, everyday 1, fast 0.3 per role, unscored.

Mean per dimension: valid 63, struct 64, size 54, cover 67, priv 50, tier 50, prompt 51

## Self-healing: revisions after a run record (mean 84.4 / 100)

| scenario | cx | n | score | fix | minimal | stable | spend | valid | listed | roles before>after | cost proxy delta | turns | revise | $ | time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| r2 | 2 | 1 | 100.0 | 100 | 100 | 100 | 100 | 100 | 1.0 | 3>3 | 0.00 | 3.0 | 0.0 | $0.12 | 19s |
| r3 | 4 | 1 | 100.0 | 100 | 100 | 100 | 100 | 100 | 1.0 | 11>11 | 0.00 | 5.0 | 0.0 | $0.40 | 33s |
| r5 | 3 | 1 | 37.5 | 0 | 50 | 50 | 50 | 100 | 1.0 | 6>5 | 1.70 | 6.0 | 0.0 | $0.55 | 41s |
| r6 | 4 | 1 | 100.0 | 100 | 100 | 100 | 100 | 100 | 0.0 | 11>11 | 0.00 | 2.0 | 0.0 | $0.07 | 11s |

Efficiency (unscored): turns, reported cost and time of the healing session itself. Cost proxy delta is the change in the chart's ongoing cost proxy (positive = the chart now costs more per run).

Mean per dimension: fix 75, minimal 88, stable 88, spend 88, valid 100

## Lowest-scoring checks (these drive the tuning)

| check | dimension | failed | of | mean credit % | scenarios | example |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| retro/healthy-untouched | stability | 1 | 1 | 0 | r5 | a healthy chart was modified |
| retro/no-change | fix | 1 | 1 | 0 | r5 | the chart changed: orchestrator, tester, -researcher |
| recommend/no-top | tiering | 1 | 2 | 50 | c1 | top tier on Architect |
| recommend/readonly-no-write | least-privilege | 1 | 2 | 50 | c1 | read-only roles with Edit/Write/NotebookEdit: Code Reviewer, Researcher |
| recommend/deep-share | tiering | 1 | 3 | 67 | c1 | 100% of non-root roles are deep or top (at most 67%) |
| recommend/messaging-matches | least-privilege | 1 | 3 | 67 | c1 | 6 of 6 roles hold SendMessage/ListAgents; the scenario wants none |
| retro/no-collateral | minimality | 1 | 3 | 67 | r5 | unrelated roles changed: orchestrator[spawnable], tester[tier] |
| recommend/no-role-has-every-tool | least-privilege | 1 | 3 | 67 | c1 | holds every tool: Chief Orchestrator, Architect, Frontend Lead, Researcher, QA Lead |
| recommend/no-vendor-model-ids | tiering | 1 | 3 | 67 | c1 | concrete model ids on Chief Orchestrator (claude-opus-4) |
| recommend/prompt-length | prompt-quality | 1 | 3 | 67 | c1 | outside 60-160 words: Chief Orchestrator (11), Architect (2), Frontend Lead (2), Code Reviewer (2), Researcher (2), QA Lead (2) |
| recommend/prompt-refs-document | prompt-quality | 1 | 3 | 67 | c1 | no reference to the architecture document: Chief Orchestrator, Architect, Frontend Lead, Code Reviewer, Researcher, QA Lead |
| recommend/role-count | right-sizing | 1 | 3 | 67 | c1 | 6 roles, expected 1-3 |
| recommend/root-deep | tiering | 1 | 3 | 67 | c1 | root Chief Orchestrator runs on other |
| recommend/root-no-delegate-all | prompt-quality | 1 | 3 | 67 | c1 | the root's prompt tells it to delegate everything |
| recommend/writers-report-files | prompt-quality | 1 | 3 | 67 | c1 | writers not told to report the files they touched: Architect, Frontend Lead, Code Reviewer, Researcher, QA Lead |
| recommend/writers-stay-in-brief | prompt-quality | 1 | 3 | 67 | c1 | writers not told to stay within their brief's files: Architect, Frontend Lead, Code Reviewer, Researcher, QA Lead |
| recommend/prompt-second-person | prompt-quality | 1 | 3 | 72 | c1 | not in the second person: Architect, Frontend Lead, Code Reviewer, Researcher, QA Lead |
| recommend/chart-produced | validity | 1 | 4 | 75 | c2 | no org chart was proposed (noChart) |
| recommend/depth | right-sizing | 1 | 3 | 83 | c1 | 2 level(s) below the root (at most 1) |
| recommend/revise-rounds | validity | 1 | 3 | 83 | c1 | 2 REVISE round(s) or tool error(s) before the chart was accepted |

## Sessions

- c1 #1: 100.0; Orchestrator (deep), Developer (everyday); revise 0; ask_user 0; question turns 1; $0.21
- c1 #2: 44.5; Chief Orchestrator (claude-opus-4), Architect (top), Frontend Lead (deep), Code Reviewer (deep), Researcher (deep), QA Lead (deep); revise 2; ask_user 3; question turns 2; $0.64
- c4 #1: 100.0; Orchestrator (deep), Product Lead (deep), Web Implementer (everyday), Mobile Implementer (everyday), Platform Lead (deep), Services Implementer (everyday), Infra Engineer (everyday), Data Pipeline Engineer (everyday), Compliance Reviewer (everyday), QA Engineer (everyday); revise 0; ask_user 0; question turns 1; $0.93
- c2 #1 [noChart]: 0.0; no chart; revise 0; ask_user 2; question turns 3; $0.31
- c3 #1 [skipped]: skipped; no chart; revise 0; ask_user 0; question turns 0; -
- r2 #1: 100.0; changed tester[tools]; ending propose; revise 0; 3 turns, $0.12, 19s
- r3 #1: 100.0; changed web-implementer[prompt]; ending propose; revise 0; 5 turns, $0.40, 33s
- r5 #1: 37.5; changed orchestrator[spawnable], tester[tier]; removed researcher; ending propose; revise 0; 6 turns, $0.55, 41s
- r6 #1: 100.0; changed none; ending noChange; revise 0; 2 turns, $0.07, 11s

Model output is data: role names and rationales above are shown as the model wrote them.
