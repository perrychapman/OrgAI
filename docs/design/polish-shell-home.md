# UI polish pass: shell, Home, Inbox, first launch, decision cards

Scope: the sidebar and rail, project header, Ctrl/Cmd+K palette, app banners, Home (dashboard), the project Home tab
(code and engagement), the Inbox, first launch (three steps, start choice, inline form), the New project dialog and form,
and every decision card in the run tray and the Inbox. Method: the built app on the mock adapter with a throwaway data
dir, 30 projects (two with very long names, six engagements), seven decisions waiting at once (a 344-character compound
command, an Edit on a very long path, a question with six options and a 400-character body, an org-chart proposal, an MCP
install, a worktree command), screenshots at 1024x640 and 1600x1000 in dark and light, plus a DOM audit at 1024x640,
1280x800 and 1600x1000 (clipped text without an ellipsis, sideways scrollbars, pointer targets under 24 px).
Screenshots are scratch files in `e2e/shots/polish/` (gitignored); the names below say which one showed the defect.

Severity: High = a user cannot read or reach something; Medium = visible and wrong on a common screen; Low = polish.

## Findings

| # | What | Where | Screenshot | Sev | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | A long question is cut mid-sentence in the card title (two lines or one) and its whole text sat after the options and the note field, behind a scroll. | QuestionCard in the Inbox detail and the run tray | `inbox-detail2-1600-dark`, `tray-question-1600-dark` | High | Fixed: the full text leads the body (`.question-full`), hidden only while a compact tray folds the body behind Details. |
| 2 | The question body was capped at 40 % of the container, so the options list scrolled inside and the "Or answer in your own words" field was cut off mid-box above Submit. | `.decision-card.kind-question .decision-body` | `inbox-detail2-1600-dark` | High | Fixed: cap is min(55cqh, 480px) for questions. |
| 3 | A white square at the corner of the sidebar project list (dark theme) and a grey sideways scrollbar in the rail and at the narrowest sidebar: the list scrolled on both axes. | `.sidebar-projects`, global scrollbar | `h1-home-decisions-1024-dark`, `sidebar-w200-1600-dark` | High | Fixed: list is `overflow-x: hidden`; global `::-webkit-scrollbar-corner` is transparent (foundation, see below). |
| 4 | The sidebar rail's Needs-you bell was 16x32 (the Popover wrapper shrink-wrapped it): a target under 24 px. | `.nav-split` in the rail | audit 1024x640 | Medium | Fixed: the wrapper fills the rail. The DOM audit after the fix no longer lists it (nor the chevrons). |
| 5 | "Code project" chip in the project header was squeezed to its icon plus half a word ("Code") at 1024 when the name was long. | `.kind-chip` | `proj-code-busy-1024-dark-s0` | Medium | Fixed: the code chip keeps its width; the name and folder give way. |
| 6 | A short project name ("A") sat in a 64 px box, so the kind chip floated 75 px away from it. | `.project-topbar h1` | `tray-question-1600-dark` | Low | Fixed: the 64 px floor only applies to a name long enough to need it (`--name-min`). |
| 7 | The sidebar search placeholder was cut mid-letter ("Search or jump tc") at the narrowest width. | `.sidebar-search-btn .nav-text` | `sidebar-w200-1600-dark` | Medium | Fixed: it is a block, so the ellipsis works. |
| 8 | Org-chart proposal showed its count twice ("1 added, 1 changed" under the title and again, bold, in the body). | ProposalCard OrgChartBody | `inbox-detail4-1600-dark` | Low | Fixed: the body no longer repeats the summary line. |
| 9 | Welcome step options and the New project kind cards: the card stretches to its row, and the spare height was shared between title and description, pushing a short description away from its title. Mono (Code) and serif (Engagement) titles also sat on different lines. | `.welcome-option`, `.project-kind-option` | `w3-step3-1600-dark`, `f-start-1600-dark` | Medium | Fixed: `align-content: start`, one title row height. |
| 10 | First-launch "Mock adapter / connection" card: the status dot sat alone on a row above its title in the 240 to 360 px aside. | `.welcome-connect` | `f-start-1600-dark`, `f-form-eng-1024-light` | Medium | Fixed: grid, dot beside the words, action underneath. |
| 11 | First-launch greeting took a third of a 1024x640 window, so Back / Continue sat on the bottom edge. | `.dash-salutation` | `w3-step3-1024-light` | Low | Fixed: one size down below 720 px height. |
| 12 | Palette: a run's title was squeezed to "Run the le..." by a long project name; the footer said "Ctrl K to open" while the palette was already open. | palette rows and footer | `palette-1024-light` | Low | Fixed: the project name gives way first; the footer now says Esc closes. |
| 13 | Pointer targets under 24 px: `.nav-chevron` 20x28, Home section links ("Edit", "All runs", "Limits") 21 high, the header "Needs you" button 21 high, the "Command" and "Show details" disclosures 17 high, the "Fewer prompts" link 17 high, the shared Switch 32x20. | sidebar, Home, header, cards, `ui.css` | audit | Medium | Fixed (hit areas; drawn sizes unchanged; Switch through an invisible `::after`). |
| 14 | Home `home-target-select` measures 159x19 (the inner select of a styled chip, whose wrapper is 32 high). | Home task box | audit | Low | Left: the chip around it is the target; no visual defect. |
| 15 | Brand row on a dev build: "MOCK" and "Dev" stack in two lines at the default width and "MOCK" clips to "MO" at 200 px. | `.brand-lockup-tags` | `sidebar-w200-1600-dark` | Low | Left: dev-build chips only (never in a shipped build), intentionally wrapped then clipped by the lockup's own rule. |
| 16 | Sidebar group labels: Engagements has a chevron and a count, "Code" has neither. | Sidebar | `h1-home-decisions-1600-dark` | Low | Left: `e2e/engagement.mjs` lines 246 and 281 assert the label text is exactly "Code". Owner decision whether to fold it too. |
| 17 | Sticky submit row of the New project form covers the lower half of the field under it at the top of the scroll at 1024x640. | `.project-form` | `f-form-eng-1024-light` | Low | Left: standard sticky footer; the field is reachable by scrolling and by Tab. |
| 18 | The first-launch setup choice uses native round radios that differ from the card radios above (ux-review L2). | NewProjectForm setup choice | `f-form-eng-1024-light` | Low | Left: native radios are intentional (keyboard and accessible name); restyling is a design decision. |
| 19 | A "Working now" run card on Home showed only its avatar and a dot once (no title). | Home Working now | `home-1600-dark-s1` | Low | Not reproduced in four later captures; looks like a mid-animation frame. Left, watch for it. |
| 21 | Folder trust review: the single "Show all text" toggle centred itself while everything above it is left-aligned. | FolderTrustSection dialog | `folder-trust-1024-light-dialog` | Low | Fixed (`.trust-files-toggle` aligns to the start). Not re-shot after the fix. |
| 20 | `.run-tab-close` is 20x20 and the run composer chips scroll sideways at 1024. | run view | audit | Medium | Left: run view belongs to polish-run (told). |

Checked and found fine at both sizes and in both themes (no change): Home task box, Briefing card, Working now, Waiting
on you (long command, long path, mid-line truncation with a visible ellipsis), Your week, activity map, Pick up, project
tiles (long names ellipsised, run bars, role dots), the dashed New project tile, engagement and code Home tabs (including
the empty engagement first-use state), Inbox list, filters, Answer in order, every detail kind (permission, question,
proposal, MCP install), Inbox empty state, the offline banner, bell and account popovers, New project dialog (code and
engagement), first launch steps 1 to 3 and the start choice, decision card focus rings and hover states.

## Foundation files touched

- `styles/global.css`: `::-webkit-scrollbar-corner { background: transparent }`. Affects every box that scrolls on both axes
  (the white square is gone in dark; nothing changes in light). Suggested independently by polish-team.
- `styles/ui.css`: `.switch::after`, an invisible 24 px-tall hit area centred on the track (the drawn 32x20 track and thumb
  are unchanged). Suggested by polish-team and polish-settings. Every Switch (Settings, Team catalog rows, MCP rows).
- Re-checked after these: Settings (App settings, project settings) and the Team catalog rows by the e2e gate below, the
  run view's tray and the Pocket Office stage by screenshot (corner), and the Inbox and Home screens listed above.

Messages sent to polish-run, polish-settings, polish-team and polish-data with what changed.

## Left for the owner

1. Whether the "Code" sidebar label should get a count and a fold like Engagements (breaks `e2e/engagement.mjs`; the board
   shows a quiet label).
2. Whether the dev-build MOCK and Dev chips should collapse to the existing rail pip below a width.
3. Whether the New project setup choice should use card radios like the kind cards (native radios are accessible today).
4. A shared target-size rule: several shared drawn controls (Switch 20 px, Badge buttons 21 px, text links) are under 24 px and
   only hit areas were enlarged, not the drawn size.

## Verification

Typecheck clean; `npx vitest run src/renderer` 247 files, 3401 tests passed; build clean; e2e layout, dashboard,
per-project, permissions, proposals and folder-trust all passed (run one after another, one Electron at a time). Not verified: macOS and Windows scale factors above 100 %,
screen-reader speech, a real provider sign-in banner and the update-ready banner (the mock adapter cannot raise them),
reduced-motion behaviour of the changed rules (none of them add motion), and the Finished section of the Inbox (mock runs stay
live).
