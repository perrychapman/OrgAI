# Split execution: making a fan-out beat one agent

Status: draft 1, 2026-11-10. Nothing here is built. Follow-up to `orchestration-efficiency.md`, whose phase 6
comparison (its 1.1c) ended with one part of the goal undelivered: no run that split its work beat the native
session on time. This document says why, from those runs, and what to build and measure next.

## 1. Evidence

All from `~/orca/projects/orgai-performance-lab`, campaigns `phase2-20261110T093906Z`, `phase2d-…T105108Z`,
`phase2e-…T113308Z`. One run per cell.

**The module task** (four independent modules behind a fixed contract; native Codex 109.9 s, native Claude Code
83.5 s):

| Run | Shape | First spawn | Reports ran | After the last report | Total |
|---|---|---|---|---|---|
| Codex, P2c | one implementer does all four, lead waits | 39 s | one, about 40 s | about 67 s | 146.2 s |
| Codex, P2d | three implementers at once, lead takes the fourth | 24 s | 24 to 67 s (30 to 43 s each) | 49 s | 117.8 s |
| Codex, P2e | lead takes two modules, one implementer takes two | 20 s | 20 to 61 s | 66 s | 128.4 s |
| Claude, P2 and P2d | the lead alone | none | none | none | 72.8 s, 65.2 s |

**The dashboard** (native Codex 455.9 s): in all three unforced Codex runs the lead gave an implementer one slice
(55 to 64 s of work) at about 20 s and built everything else itself: 814, 522 and 686 s.

What the plans say. On P2d the lead wrote the split as the plan graph intends: four steps `after: [p1]`, one path
each, three with `staff`, and a verify step after all four. So the graph, the staffing fields and the one-message
fan-out all work. The run still lost to native by 8 s.

## 2. Why no split won

1. **The tasks are below break-even.** Native finishes the module task in 84 to 110 s, about 20 s a module. A
   report took 30 to 43 s for one module, because it starts cold: an 11k-token first call, then it reads the brief,
   the contract and the tests before it writes. Three reports in parallel therefore finished at 67 s, when a lone
   agent is nearly done. The lab has no task on which a correct split could win, so the comparison could only
   show a loss or a tie.
2. **Everything around the fan-out is serial.** 20 to 39 s pass before the first spawn (the lead inspects, plans,
   then spawns), and 49 to 67 s after the last report (the lead reads the results and verifies the whole). On the
   best run that is 73 s of a 118 s run in which only one agent works.
3. **The lead cannot tell how long a piece will take.** The sizing rule says "independent pieces of more than a
   couple of minutes each". The lead split pieces of 20 s, and on the dashboard, where pieces of minutes exist, it
   handed out one minute and kept seven.
4. **One report while the lead waits** (Codex, P2c) is the shape the rule calls slower than working alone, and it
   was: 146 s.
5. **On Claude the lead never splits.** At these sizes that is the right call, and it is why the Claude adapter
   beat native on the module task. Whether it splits when it should is unknown: nothing in the lab should be
   split. A Claude lead also cannot work beside its reports today: spawns run in the foreground and the lead
   blocks until all of them return.

A working estimate from the three runs, to be replaced by measurement: a split of `n` pieces of `p` seconds
costs about 45 to 60 s of overhead (20 s to the first spawn, 15 to 25 s of cold start per report on the critical
path, 10 to 20 s of extra tail) and saves `(n - 1) * p`. Four pieces need more than about 20 s each to break even
and more than a minute each to win by a third. Tokens always go up: every report reads the context again.

## 3. Design

In order of expected effect. Each item names how it is checked.

### 3.1 A lab task that can be won (first, blocks the rest)

A task with a native time of 10 to 20 minutes, three or four pieces of at least three minutes each behind a
contract the brief states, and hidden tests per piece plus an integration test. Run native on both adapters, the
lead alone, and the split. Until this exists no item below can be accepted or rejected. The dashboard stays as the
task that looks splittable and is hard to cut.

### 3.2 A warm start for reports

A report's cold start is on the critical path of every split. Two changes:

- **Context pack.** The spawn tools take `files: string[]` (paths the lead has already read). The harness puts
  their content into the report's first message, within a size limit, so the report does not spend its first two
  or three round trips reading them. Harness mechanics in `harnessTools.ts` and the adapters' spawn paths; a
  protected path is refused by the same checks as a read.
- **The contract in the brief.** One sentence in the sizing paragraph: when you hand out pieces that share an
  interface, put the interface and the acceptance check in each brief.

Check: `reportStartMs`, the time from a report's start to its first write, joins `RunEfficiency`. Target: half of
today's value on the module task.

### 3.3 The lead works beside its reports

- **Codex:** `spawn_report` already returns at once. The P2e run shows the lead taking a piece itself. Add to the
  paragraph: when you fan out, take a piece yourself unless every piece needs a report's tools.
- **Claude:** allow `run_in_background: true` for a report that is not required, with its result delivered as a
  harness message, as bridged reports already work through `delegate_agent`. Required reports stay in the
  foreground (the receipt reads the tool result). Unverified: whether a background report's hand-back reaches
  `SubagentStop` with its text on SDK 0.3.318; a smoke check in `scripts/smoke-staffing.mjs` decides before
  anything is built.

Check: lead idle time while reports run (`leadActiveMs` is already in the lab's analysis) falls to near zero.

### 3.4 Verification where the work is

Each report runs its piece's checks before it reports and says what it ran. The lead runs the integration check
once and does not repeat the pieces' checks. This is a prompt rule for reports (`prompts.ts`) and one clause for
the lead. Check: time after the last report, as a share of the run. This also needs the tail metric restated on
"after the last report" (`orchestration-efficiency.md` section 10).

### 3.5 Telling the lead what a split costs

The lead decides with no numbers. The project profile (`store/staffingProfile.ts`) already records runs; it gains
the median `reportStartMs` and the median time after the last report, and the staffing brief gets one line:
"Here a report produces nothing for about N s and a fan-out adds about M s at the end; split when the pieces you
hand out are each well above that." Without history the line uses the defaults measured in 3.1.

### 3.6 One report and a waiting lead

When a spawn leaves exactly one report running and the plan has no step the lead itself is working on, the spawn
tool's result carries one line: "You are waiting on one report. Take a ready step yourself, or hand out the rest;
waiting is slower than doing this alone." It is a note, never a refusal, and never shown for a required report.
Mechanics in `harnessTools.ts` from `planGraph.ts`; Claude delivers it through the hook's additional context,
which is unverified on SubagentStart and needs its own smoke check.

## 4. Acceptance

On the task of 3.1, medium effort, three runs per cell:

- the split run takes at most 0.8x the native time of the same adapter and at most 1.5x its cost;
- reports overlap (ratio at least 2 with three or more pieces) and the lead is active while they run;
- time after the last report is under 20% of the run;
- on the ledger, the inventory and the module task the lead still works alone or ties its own solo time, and no
  run has one report with a waiting lead.

If 3.1 shows that a correct split cannot reach 0.8x even by hand (a scripted split), the conclusion is that
splitting pays only above some task size, the sizing rule gets that size, and the rest is dropped.

## 5. Phases

1. The lab task and the scripted-split ceiling (3.1). Gate: is there a win to be had, and at what piece size.
2. Warm start and `reportStartMs` (3.2); verification rules (3.4). Prompt and harness-tool work, no contract
   change beyond one metric field.
3. The lead beside its reports (3.3): the Claude smoke check first, then the background path if it holds.
4. The cost line and the waiting note (3.5, 3.6).
5. Rerun against section 4.

## 6. Decisions for the owner

| Decision | Recommended | Alternative |
|---|---|---|
| S1. A split always costs more tokens. Under `balanced`, how much more for how much faster? | Up to 1.5x cost for at least 20% less time | Never above native cost: then splitting is for the `speed` goal only |
| S2. Background reports on Claude for reports that are not required | Yes, if the smoke check passes | Keep every Claude spawn in the foreground: the lead cannot work beside its reports |
| S3. Inlining files the lead names into a report's first message | Yes, with a size limit and the read checks | Leave reports to read for themselves: no new surface, the cold start stays |

## 7. Risks

- Three runs, one model family per adapter, one task. The break-even estimate in section 2 is arithmetic on
  them, not a measurement.
- A context pack that is too large moves the cost from round trips to input tokens and can exceed what the report
  needed.
- Background reports on Claude change how a report's result reaches the lead; the delegation ledger and the
  receipts were built on the foreground path and must be shown to hold.
- Every change to the sizing paragraph can undo the phase 6 result (the lead keeping contained work). Its
  sentences and sizes are pinned in `prompts.test.ts`, and the small tasks are part of the acceptance run.
