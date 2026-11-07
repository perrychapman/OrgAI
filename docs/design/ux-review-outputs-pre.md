# UX review: Outputs (pre-feature walk)

Reviewer: UX Researcher. Build: 6c36046d (`npm run build`, dev 0.1.7-dev1). Ran with `ORGAI_MOCK=1`, throwaway data dirs, 1600x1000 and 1024x640, dark and light, plus a Tab pass at 1024x640. Method: ux-walkthrough, limited to the Live run view, an engagement (Knowledge tab, Settings > General), a code project, History and the Dashboard. No spec exists yet; the Outputs feature is not built. Shots: `docs/design/ux-review-outputs-pre-shots/`.

Scenario: a first-time user asks a team for "a project plan as a Word document, a budget as an Excel sheet and an architecture diagram". A custom `ORGAI_MOCK_SCRIPT` made a report agent `Write` `docs/project-plan.docx`, `docs/budget.xlsx` and `docs/architecture.mmd` (each asks permission). Engagement runs used the default script with `[mock:knowledge]`.

## Verdict: NOT SUPPORTED TODAY

A file an agent writes is only a line of plain text in that agent's own transcript. The user cannot open, find or preview it from anywhere. The nearest patterns (Knowledge, "Recorded N changes") are good models.

## Findings

### H1. Produced files are invisible outside one agent's transcript (shots 12, k42)
Steps: start the run, "Allow for session", click the Implementer node. The panel shows "Wrote docs/project-plan.docx", "File created successfully at: docs/project-plan.docx", and so on.
- The orchestrator's transcript (the default selection, and what the user reads) says only "Handed work to implementer-1" and a prose summary. It never lists the files, so a user who does not click the right node never learns they exist.
- Paths are relative and are plain text. No link, no button, no folder. The transcript has no buttons or links at all on these rows (checked in the DOM).
- At 1024x640 the finished agent folds into "1 done" (shot 16), so the author of the files is one more click away.
- Fix: Outputs must be derived per run from the whole run (every agent), not from the selected agent's transcript, and must be reachable without selecting a node.

### H2. No way to open or reveal a file, and no folder context (shots 31, 02)
- The only file-opening affordance is Dashboard tile menu > "Open folder" (opens the project root, not `docs/`). The topbar folder chip is a non-interactive `span` (title shows the full path). History rows offer only "Open" and "Open in Live" (the run).
- The permission card says "In the project docs/project-plan.docx" and shows the raw tool input, including `PK binary docx` as content. A non-developer sees binary junk and a path with no way to see the file.
- Fix: Open (OS app), Reveal in folder, Save as, Copy path on every output, using the existing `app.openPath` rules (project folder, allowed directories, data dir). Outputs outside those roots (agent wrote to a sibling or temp path) must say so rather than offer a button that is refused.

### H3. Permission card is the only moment the user is told a file will exist (shot 02)
The card title is "Write project-plan.docx" and its body is code-flavoured. For an output kind the card should read "Create Word document project-plan.docx" with no raw content dump for binary types. It still must be a normal permission decision; the output is announced after it, not instead of it.

### M1. Place Outputs in three spots, one source of truth
Recommendation (answers Q2):
1. Run side-panel tab "Outputs" (next to Usage / Knowledge; `side-tab-outputs`). Shown only when the run has at least one output, as Knowledge is shown only for engagements. Quick, per-run, matches where users already look.
2. A project tab "Outputs" between History and Knowledge (Knowledge is the precedent for a list-first page with filter column, listbox and `SidePanel` detail). This is the home for engagement users: they want "the Word doc", not a run. Group by newest, filter by type, show the run and agent as a provenance line ("Analyst · R1 · 6 Nov 2026", the Knowledge format).
3. RunMeta chip "N outputs" (like "Recorded 8 changes", which opens the Knowledge tab) and a Dashboard line on the project tile ("3 new outputs"), nothing larger. Do not add a Dashboard section; the Dashboard is already attention-first (Needs you, Running, Since).
Code projects get the run tab and RunMeta chip always; the project tab can follow the same rule as Team files (hidden until there is something), to avoid an empty tab for developers whose agents only edit source. Edits to existing source files must not count as outputs (a `src/example.ts` Edit would otherwise flood the list); define outputs as files the agent declares or new non-source files in a deliverable folder.

### M2. RunMeta will clip at 1024x640 (shot k45)
With "Recorded 8 changes" present, the cost already clips to "$0.0114" at 1024x640 (dark and light). A further "3 outputs" chip will worsen it. Make the chip an icon plus count under 1100 px, or put it at the end of the row with the label in the tooltip and an sr-only sentence.

### M3. Announcing an output (answers Q3)
- Transcript: use the harness-row pattern of Knowledge ("Recorded organisation Acme Corp" with an inner "Open" link, `knowledge-write-row`). Proposed row: "Created project-plan.docx" with inline "Open" and "Show in Outputs"; the paired `Write` call and its "File created successfully" result rows should fold into it as `collapseKnowledgeWrites` does, so the transcript no longer shows the raw JSON input and a duplicated result sentence (shot 60).
- Live region: one polite, throttled announcement ("The team produced 3 outputs"), like the Knowledge tab's once-per-5-seconds message. Never a Needs-you item, bell badge or Dashboard attention row; those count decisions only.
- A run that finishes with outputs may say so once in the final status line ("Finished, 3 outputs"), not as a card.
- Reuse status words only (Running, Needs you, Idle, Paused, Finished, Stopped, Failed). Do not invent "Ready" or "Delivered".

### M4. Previews (answers Q4)
360 px side panel (list mode): one row per output: type icon, file name (middle-clipped), size and kind ("Word document · 38 KB"), provenance line, and a single "Preview" disclosure; Open is the row's primary button, Reveal, Save as, Copy path in a "More actions for <name>" popover (the Skills row pattern). No inline rendering in 360 px except images (fit to width) and short text (ClampText, about 12 lines).
Wide panel (480 px and over, `data-side-wide`) or project tab detail pane:
- docx: rendered headings and paragraphs as read-only text, first pages only, "Open in Word" for fidelity; say plainly that the preview is simplified.
- xlsx: first sheet as a native table (caption, `th scope`), at most about 50 rows by 12 columns with "Showing 50 of 312 rows"; sheet tabs as a native tablist.
- Mermaid: rendered SVG with the source under "Show source"; a diagram that fails to parse shows the source and the parser message, never a blank panel. Zoom/fit with the canvas IconButton pattern.
- markdown/text: the transcript's `.md` renderer; images: fit, click to zoom.
All previews must be inert (no scripts, no external loads, sandboxed render; agent files are untrusted data like repo config) and have a text alternative and a keyboard path. Do not render at all above a size cap; show "Too large to preview" with Open.

### M5. Cards without a file on disk (mock limitation and real risk)
The mock `Write` step creates no file, so I could not see missing-file states. The real feature needs rows for "File moved or deleted" (Open disabled with the reason as a title on the wrapper span, as the scratch Save as project does) and for a run that ended before an output was finished.

### L1. Hero says "1 running" for an Idle run (shot 31)
The Dashboard hero reads "1 running" while the run row says "Idle". Pre-existing and unrelated, but it will show again when outputs make idle runs the normal state ("Your turn"). The project tile also says "1 open".

### L2. Folder chip is not a control (shot 12)
The topbar folder chip looks clickable but is a `span`. Making it a button that reveals the folder (after the Outputs work) would close the cheapest gap for code users.

## Keyboard pass (1024x640, engagement run view)
Tab order: skip links, sidebar, tabs, run tab, New run, End session, Hide finished, zoom controls, canvas style, legend, layout toggle, canvas nodes, composer, Hide run panel, panel resize, side tabs, panel body. Good, logical. For Outputs: the tab must join the roving side-tab order; the list must be one listbox Tab stop with Enter to open the detail (as the Knowledge list), the preview region must be focusable only if it scrolls, and Esc must return to the row. Focus after Save as / Open should stay on the row; failures speak through the panel's single live region.

## Reuse list (answers Q5)
- `SidePanel` and `persistKey`, rail-collapsed under 1100 px; `side-tab-*` tab ids; `data-side-wide` for the preview switch.
- Knowledge list: listbox, kind chips with counts, provenance line, `knowledge-status` throttled announcements, deep link through a store request like `openKnowledgeItem`.
- `collapseKnowledgeWrites` / harness rows for the transcript; RunMeta chip with `recordedBreakdownText` for the sr-only sentence.
- `ClampText` plus `showHidden` (hidden-character badge) for any file name or text preview shown from agent output.
- `Banner` for the "Saved to ..." notice with focus-safe timing (Knowledge notice 8 s), `useConfirm` for any delete.
- `FinishedList` pattern for the per-agent "N outputs" in the side panel when an agent is selected; the "Folded finished agents" group should carry an outputs count so folding never hides authorship.
- Copy rules: plain words (file, document, spreadsheet, diagram), "Reveal in folder" on Windows/Linux wording differences to be decided (macOS "Reveal in Finder"), no vendor names, unknown size never "0 KB".
- Both themes: file-type icons must not rely on colour alone (kind badge text), as Knowledge's `kindMark`.

## Not driven
- Real files: the mock writes none, so Open, Reveal, preview, missing-file and big-file states could not be seen. Only the transcript text and cards were.
- Native Open folder / Reveal behaviour, the Save as dialog, drag-out.
- Chat/assistant runs and run-scoped windows, History of a relaunched run (outputs after relaunch), screen reader output, macOS and Linux.
- Whether `[mock:knowledge]` plus a custom `ORGAI_MOCK_SCRIPT` combine: with a custom `work` script the knowledge steps did not run (the Knowledge tab was empty), so engagement shots with writes and knowledge together were taken from two separate runs.
- Walk scripts are in `e2e/shots/ux/outputs/` (gitignored); no source file was changed.
