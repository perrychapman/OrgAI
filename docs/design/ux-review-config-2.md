# UX review: settings restructure re-walk (config review 2)

Method: `npm run build` at edb3e95 (the settings restructure merge on dev). The built app was driven with playwright-core
through `e2e/lib.mjs` (`ORGAI_MOCK=1`, a fresh temp `ORGAI_DATA_DIR` per script, no tokens spent). The walk covered first
launch, the New project form on a fixture git repo ("Notes API", Existing repository, default chart, mock adapter) and
one short mock work run ("Add a health check endpoint...") ended with End session. Two more mock runs followed, one with
`[mock:no-price]` for "Set a price" and one with `[mock:fatigue]` for the permission card link. Then every App settings and
Project settings pane at 1600x1000 and 1024x640 in dark and light, at rest and with Advanced open. Also covered: the Team
tab role panel and Catalog, the MCP assist dialog, the three assistant start pages, every deep link listed in spec
section 6, and a keyboard pass (Tab order at rest, Enter and Space on the disclosures, the focus ring, reload memory).
Heights are the `.settings-scroll` `scrollHeight` against its `clientHeight`; words are the `innerText` of `.settings-col`.
Tab stops run from the pane h2 until focus leaves the settings column.

Screenshots: `docs/design/ux-review-config-2-shots/NN-*.png`. The scratch scripts (`walk.mjs`, `walk2.mjs`, `walk3.mjs`)
and the full set (about 100 shots plus `notes.json` dumps) are in the gitignored `e2e/shots/cfg2/`.

Read first: `ux-review-config.md` (the audit: H1-H3, M1-M6, L1-L6, click counts) and `config-review.md` (the spec,
including its Implementation notes).

## Verdict

The restructure delivers most of what the audit asked for. Defaults is gone. App General at rest is 3 short sections
(77 words, down from 344 on Defaults). The project Permissions pane fits 1024x640 at rest with 3 tab stops, and Limits
at rest is one line and one disclosure. The Advanced disclosure behaves well with the keyboard and is remembered across a
reload. Plugins moved to Team > Catalog, and the connection is named on the New project form and on every assistant
start page. The "Runs on <connection>" line and the automatic default close the OpenAI-only gap in code (not drivable on
the mock).

Two problems block calling it done:

- **N1 (High).** Every deep link into Assistant models scrolls the whole window. These are the Chat, MCP assistant and
  Skill assistant "Change in App settings" links and the MCP assist dialog hint. The topbar and the top of the sidebar
  leave the screen, and a blank band covers the bottom 40-50% of the window, at both sizes (shots 17, 19). This is the
  audit's unconfirmed L6, now reproduced on the restructure's main new link target.
- **N2 (High).** The one visible line on Limits promises a five-hour stop that the harness does not make. "Plan guard:
  automatic. Stops near your five-hour limit..." shows while "Stop at a share of the five-hour window" is Off (shots 12,
  13), and `planGuardOf` 'auto' only steers the weekly tier.

Everything else is Medium or Low polish.

## Status of earlier findings (ux-review-config.md)

| Finding | Status | Evidence (this walk) |
| --- | --- | --- |
| H1 Connecting a provider does not make OrgAI use it | Fixed in code, not drivable | The New project form says "Runs on Anthropic (Claude Code login). Change" with the mock off, and "Runs on the mock adapter (no tokens)." with it on (shot 01). Change lands on Connections with focus on the h2, and the typed folder survives the detour (shot 02). Connections shows the single default badge "Default for new projects and assistants" plus "Automatic" (shot 06). The Chat, MCP and Skill start pages read "via Anthropic" (shot 18). `effectiveDefaultConnection` (`src/shared/defaults.ts` 588) picks the first connected connection when the stored one is 'disconnected'. The mock connects only Anthropic, so make-default, Back to automatic and an OpenAI-only default were not driven. One edge remains (N9). |
| H2 App Defaults mixes three kinds and outgrew its pane | Fixed | No Defaults tab. The nav is General, Connections, Connectors, Skill library, About. No "App settings > Defaults" text in `src/renderer/src` or `out/renderer` (grep). General at rest is 77 words and 952/952 px at 1600x1000 (no scroll), but 684/593 at 1024x640 (shot 03, see N7). The copy-once duplicates are gone, and assistant models sit in Advanced under "Assistant models (used now by every project)" (shot 04). |
| H3 Plan-window options shown to every user | Partly | A subscription project's Limits at rest is the `plan-guard-line` plus Advanced: 22 words, 1 tab stop, no percent input (shot 12). `LimitsSection.tsx` hides the plan rows when `isMeteredProject` (code read; the mock project is a subscription, so a metered pane was not driven). The line itself overclaims (N2). |
| M1 Model choice in four places, two vocabularies | Partly | No model select in App General at rest. App Advanced selects read "Deep tier (opus)", with concrete ids only after the tiers (shot 04), in the sans face at 240 px. The role panel shows one Model select with "Deep (opus)" and Exact model and Effort behind Advanced (shot 14). Still open: the role panel shows the word "Model" twice (fold title "Model Deep" and the select label "Model"). Exact model mirrors the tier's model as if pinned (N4). |
| M2 Two "AI reviews your runs" features with raw token budgets | Fixed (settings) | One "Team assistant" select (Off / Free checks / AI suggestions) in Permissions > Advanced. No token or every-N fields remain in settings (shot 11). The Team tab still has its own "Evaluate skills" button with "Evaluate may use up to 20k tokens" (shot 15), which is outside this pass. Placement: see N6. |
| M3 "Plugins and skill settings" pane is a leftover | Fixed | Project settings has 4 panes: General, Permissions, Limits, Maintenance. Team > Catalog has "Plugins . 0" with Add plugin folder (shot 15). |
| M4 Behaviour switches state choices the harness makes | Fixed | Worktrees reads "Automatic: git repository found." and "Off for this project." when turned off (shots 11, 23). Keep going is gone. Messaging and max continues sit in Advanced. Permissions at rest is 593/593 at 1024x640 (shot 09). |
| M5 Effort offers values the connection ignores | Fixed in code, not driven | On this Anthropic project Effort lists low to max (correct for Claude). `effortOptionsFor('codex')` returns low, medium and high (`defaults.ts` 263). No OpenAI project could be made on the mock. |
| M6 Permission mode copy names Claude | Fixed (one leftover) | The mode trade-off reads "The model's safety check approves routine calls and asks when unsure. Fewest prompts." (shots 03, 09). The `MODE_MORE` paragraph has no "Claude" (shot 10). One leftover: the rules panel's `SINGLE_SLASH_REASON` (`lib/permissionCopy.ts` 444) still says "Claude Code reads a single leading /..." on every connection (L4). |
| L1 Mono model selects, uneven widths | Fixed | Sans face, all 240 px (shots 04, 05). |
| L2 Skill evaluation budget input narrow and enabled when off | Fixed (control removed) | No such input in settings. |
| L3 "Team assistant: review" small-caps group repeating its name | Fixed | Now one row "Team assistant" in the "Runs" card (shot 11). |
| L4 New project form keeps "Found ..." after switching to New idea | Not re-walked | No agent fixture in this walk. |
| L5 About "Mock adapter" chip unexplained | Open | Still "0.1.6-dev1 Dev build Mock adapter" with no explanation (shot 25). |
| L6 Window shifted up after the Model prices form | Open, now confirmed and worse (N1) | "Set a price" no longer shifts anything: it lands with focus in the Input field and no element other than the settings scroller is scrolled (shot 20). But every Assistant models deep link scrolls `html` (overflow hidden) by 130 px at 1024x640 and 489 px at 1600x1000 (shots 17, 19). |
| settings-1 #7 "Default: X" on project rows | Partly | Permission mode shows "App default for new projects: Unattended" (shot 09). No other project row shadows an app value any more, so nothing else needs it. |
| settings-2 N8 no settings search | Open | Out of scope (spec 9). |

## Acceptance checks (spec section 8), re-scored

| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| 1 | No Defaults tab; no "App settings > Defaults" text | Pass | Nav lists 5 panes. Grep of `src/renderer/src` and `out/renderer` is empty. A pending request for the removed `appsettings-section-defaults` opens General. |
| 2 | Permissions fits 1024x640 at rest | Pass | 593/593 in dark and light (shot 09). Summary open: 937/593. Advanced open: 744/593. |
| 3 | No visible select at rest lists a concrete id; App General at rest has no model select | Pass | App General at rest has only `default-mode-select`. Project Limits Advanced selects read "Automatic (2 from the chart)" and "Automatic (8)". The role Model select reads "Deep (opus)". Concrete ids appear only in Advanced. |
| 4 | Metered project: no five-hour or weekly text; subscription: plan line, no percent input at rest | Half driven | Subscription: pass (shot 12). Metered: code read only (`LimitsSection.tsx` 68, 118). |
| 5 | Tab stops at rest: General <= 4, Permissions <= 3, Limits <= 2 | Pass | General 4 (Name, Change folder, Brief, "App settings > Connections"; the mock toggle is the 5th and does not count). Permissions 3 (mode select, Show, Advanced). Limits 1 (Advanced). App General is 11 (7 accent swatches) and is not budgeted. |
| 6 | Advanced summary: name, Enter and Space, focus ring, remembered | Pass | Name "Advanced settings". Enter opens, Space closes and reopens, and focus stays on the summary. Ring: `:focus-visible`, solid 2 px accent outline (shot 28). After a reload, app-general and project-permissions are still open. Opening never moves focus. |
| 7 | Every deep link lands on the right pane with focus | Partly. Focus is right, but the layout breaks on 4 of them (N1) | Assistant models links (MCP dialog hint, Chat `chat-model-change`, MCP and Skill start pages): General with Advanced open, focus on h4 "Assistant models (used now by every project)", and the window shifted (shots 17, 19). New project "Change": Connections h2. "Set a price": Connections with Advanced open, focus in the model price Input (shot 20). Permission card "Fewer prompts: permission settings": the Permissions pane, focus on h2 "Permissions" (shot 21). |
| 8 | No "Claude" in permission copy on an OpenAI project | Mostly | Mode labels, trade-off and `MODE_MORE` are clean. `SINGLE_SLASH_REASON` still says "Claude Code" (L4). No OpenAI project was driven. |

## New findings

### High

**N1. Assistant model deep links scroll the whole window off its frame.**
Flow: Chat start page > "Change in App settings" (also the MCP assistant and Skill assistant start pages, and the MCP
assist dialog's "Runs on Deep tier. Change in App settings"). Shots 16 to 17 (1600x1000) and 19 (1024x640), in both themes.
The pane opens on General with Advanced open and focus on the group heading. The `<html>` element (overflow hidden),
though, is scrolled by 489 px at 1600x1000 and 130 px at 1024x640. The topbar is gone, the sidebar shows only its
bottom, and the lower half of the window is an empty band. Switching to another settings pane resets it. A
first-time user sees a broken app.
Cause: `AppSettingsView.tsx` 147 `land()` calls `scrollIntoView({ block: 'start' })` three times (0, 350, 900 ms) on
`appsettings-section-assistant-models`, which sits near the end of the scroller. The scroller cannot put it at the top,
so the browser scrolls the next ancestors too, including `html` even though it is `overflow: hidden`. "Set a price"
lands on a form near the bottom without this, because there the scroller has room.
Owner: `src/renderer/src/views/AppSettingsView.tsx` (the deep-link effect). The same pattern may exist in
`PermissionsSection` / `useSectionTarget`.
Fix: scroll only the settings scroller. Either set `scroller.scrollTop` to the target's offset (clamped), or call
`scrollIntoView({ block: 'nearest' })`. As a guard, reset `document.documentElement.scrollTop = 0` after landing.
Check: after each of the 4 links at 1024x640 and 1600x1000, `document.documentElement.scrollTop === 0` and
`.topbar.getBoundingClientRect().top === 0`, with focus on the Assistant models heading. Add this to the deep-link block
in `e2e/connections.mjs` and `e2e/assistants.mjs`.

**N2. The plan guard line promises a five-hour stop that does not happen.**
Flow: Project settings > Limits on a subscription project (shot 12). The only visible text is "Plan guard: automatic.
Stops near your five-hour limit and uses the everyday tier when the weekly window passes 80%." Under Advanced, "Stop at
a share of the five-hour window (%)" reads Off (shot 13). In code, 'auto' only arms the weekly everyday-tier switch
(`planGuardArmed` in `claude.ts` 1383). A five-hour interrupt happens only when `maxWindowShare` is set
(`checkWindowShare`, 1396). Spec section 9 lists "An automatic five-hour window share" as not built, yet spec 4.3 kept
it in the line. A user reads this as a safety guarantee and skips the manual cap.
Owner: `src/renderer/src/lib/settingsCopy.ts` `PLAN_GUARD_LINE` (and `LimitsSection.tsx` if the line should reflect
`maxWindowShare`).
Fix: say only what runs. auto: "Plan guard: automatic. Uses the everyday tier when your weekly window passes 80%." Then
add one clause from the share setting: "Runs are not stopped near the five-hour limit (set a share under Advanced)."
when unset, or "Stops a run that uses more than N% of the five-hour window." when set.
Check: with `maxWindowShare` unset, the Limits text contains no "Stops near your five-hour limit". With it set to 30,
the line names 30%.

### Medium

**N3. "Not set (use Model above)" in Exact model silently changes Model above to Inherit.**
Flow: Team > a role > Model > Advanced > Exact model (shots 14, 24). For a tier role the Exact model select shows the
tier's concrete model ("opus" under "Deep (opus)"), with the description "Pins this role to one model". So every role
looks pinned. Picking "Not set (use Model above)" calls `applyExactModel('')`, which writes `model: 'inherit'`
(`lib/roleModels.ts` 47). The Model select then jumps from "Deep (opus)" to "Use the connection default" or "Inherit from
parent", which is not "use Model above". (Code read; the pin and Custom states were driven: picking mock-lyric shows
"Custom (set under Advanced)", picking haiku shows "Fast (haiku)".)
Owner: `src/renderer/src/components/RoleModelPicker.tsx`, `lib/roleModels.ts`.
Fix: show Exact model as "Not set (use Model above)" whenever `roleModelChoice` is a tier, and use the concrete id only
for 'custom'. Picking "Not set" on a custom role writes the tier the id maps to, or the role's saved tier, never
'inherit' on its own.
Check: on a Deep role with Advanced open, Exact model reads "Not set (use Model above)". Picking it leaves Model on
"Deep (opus)".

**N4. Role panel still says "Model" twice and the canvas still shows concrete ids.**
Flow: Team > Orchestrator (shot 14). The fold title reads "Model Deep" and the select inside is labelled "Model" again.
The audit's M1 check ("the role panel shows the word Model once") fails. The canvas node chips say "opus" / "sonnet" /
"mock-lyric" while the panel speaks tiers.
Owner: `components/RoleInspector.tsx` (fold title), `RoleModelPicker.tsx`, the role node component.
Fix: give the inner select a visually hidden label (the fold title names it), or title the fold "Model tier". Node
chips show the tier word with the id in the title.
Check: the visible text of `role-model-fold` contains "Model" once.

**N5. The Chat / MCP / Skill assistant model lines and the hint disagree with the options.**
Chat says "Runs on Everyday tier via Anthropic" (shot 18), and the MCP dialog hint says "Runs on Deep tier." with no
connection (shot 16; spec section 5 gave the assistant lines "via <Connection>"). The App Advanced options say
"Everyday tier (sonnet)", and the note under them says "Tiers resolve through each project's connection." (shot 04).
These assistants do not run in a project. They resolve on the default connection, which is what the option labels show.
Owner: `components/mcp/McpAssistDialog.tsx`, `lib/assistants.ts` `chatSummaryLine`, `AppSettingsView.tsx` (note).
Fix: one shared helper that renders "Runs on Everyday tier (sonnet) via Anthropic." for all four places. Change the note
to "The Setup model resolves through each project's connection; Chat and the assistants use the default connection."
Check: the four lines all contain " via " and the resolved model in brackets.

**N6. The Team assistant switch is filed under Permissions.**
Flow: a user who wants to stop the Team assistant asking the model (it spends usage) starts on Team, where the feature
lives (shot 15). The control is in Settings > Permissions > Advanced > Runs (shot 11), which is not a permission. Team
offers no link to it.
Owner: `components/team/TeamCatalog.tsx` or the Team assistant panel; `PermissionsSection.tsx`.
Fix: add a quiet "Team assistant: AI suggestions. Change" line in the Team assistant panel that deep-links to the select
(focus on it). Or move the select into the Team assistant panel's header and keep a read-only line in Settings.
Check: from the Team tab, the Team assistant mode is reachable in 1 click.

### Low

- **N7.** App General at 1024x640 scrolls 91 px at rest (684/593; shot 03). "Advanced settings" is below the fold, so a
  user at that size does not see that Motion, canvas and assistant models exist. Owner `AppSettingsView.tsx` /
  `styles/settings.css`. Fix: tighten the section gaps (the 32 px gap plus hairlines between three one-card sections),
  or put Notifications in the Appearance card. Check: 1024x640 General at rest has `scrollHeight <= clientHeight`.
- **N8.** Mode short names differ between the two pages. App reads "Ask for risky actions" (`AppSettingsView.tsx` 61),
  while the project select and `MODE_MORE` read "Ask for everything risky" (`PermissionsSection.tsx` 29, `types.ts` 434),
  and `permissionCopy.ts` 302 says "Auto-accept file edits" against "Auto-accept edits" in both selects. Fix: one shared
  short-name map in `lib/settingsCopy.ts`. Check: the option texts of `default-mode-select` and the project mode select
  are equal.
- **N9.** An OpenAI-only user whose bundled Claude CLI times out or answers no JSON keeps Anthropic as the default:
  `anthropicStatus` returns 'error', and `effectiveDefaultConnection` keeps a stored value whose state is 'error'. Code
  read only; the bundled CLI normally answers 'disconnected'. Owner `src/shared/defaults.ts` 588 (main). Fix: when the
  stored connection was never chosen and has never been 'connected' in this install, treat 'error' like 'disconnected'.
- **N10.** With worktrees off, "Review each report's changes before merge" is greyed out and still says "You merge, hold
  or discard each diff." with no reason (shot 23). Owner `PermissionsSection.tsx`. Fix: the description becomes
  "Needs worktree isolation." while disabled.
- **N11.** The "Fewer prompts: permission settings" link (shot 21) lands on Permissions with the rules and folders list
  closed. The user came to reduce prompts and still has to press Show. Owner `PermissionsSection.tsx` (deep-link
  handler). Fix: a link from a permission card opens the summary disclosure (spec section 4.2 already does this for
  `allowedFolders` / `rules`). Point `perm-settings-link` at `rules`, or open it for `permissions` too.
- **N12.** Heading tiers are uneven inside Advanced. General Advanced uses small h4 captions ("Motion and canvas"), while
  Connections Advanced uses full h3 sections ("Costs", "Model prices"; shot 07). Limits Advanced repeats "Limits" as its
  group caption (shot 13). This is the implementation notes' L8, still open.
- **N13.** L5 carried: About's "Mock adapter" chip has no explanation (shot 25).

## Things the restructure made worse

- The window shift (N1) now sits on the four new deep links the spec added. The old Defaults links did not have it in
  the first audit (its L6 was seen once, after a scripted scroll).
- The Team assistant control moved further from its feature (N6).
- Nothing else regressed. No focus was lost after toggles: the Show/Hide toggle keeps focus and flips its name, a switch
  keeps focus after Space, and the Advanced summary keeps focus. No copy was orphaned (no "Defaults" anywhere). The
  "App settings > Connections" link in project General names its destination.

## Click counts

| Scenario | Audit (before) | Now | How measured |
| --- | --- | --- | --- |
| Claude Code user, first launch to first run | 4 | 4 (Existing repository, type or Browse, Create project, Start) | Driven |
| OpenAI-only user, first launch to first run | 11+, and a missed Defaults step left the project on Anthropic | 6 to 7: "Connect" on the form's "Nothing is connected yet." line (or gear plus Connections), OpenAI Connect (expands the card), Sign in with ChatGPT (+ browser), Projects (the draft is kept), Create project, Start. No settings choice is needed: `effectiveDefaultConnection` picks OpenAI as the only connected connection. | Code read (`ConnectionCard.tsx` 200, 576; `defaults.ts` 588; the `ProjectsView.tsx` parked draft). The form detour and draft survival were driven. |
| Change how long runs are kept | 2 | 3 the first time (Settings, Limits, Advanced), 2 after (Advanced remembered) | Driven |
| Find why a run switched to the everyday tier | 4 | 2 (Settings, Limits; the line explains it, see N2 for its wording) | Driven |
| Change the Chat model from Chat | 3+ (Change in App settings > Defaults, find the row) | 1 (lands on the group; layout broken by N1) | Driven |
| Price an unpriced model from the Usage tab | 1 plus finding the row | 1 (Set a price lands in the Input field with the model filled in) | Driven |
| Tab stops at rest: project General / Permissions / Limits | 19 on the old Agents pane | 4 / 3 / 1 | Driven, 1024x640 dark |

## Suggested order of work

1. N1: scroll only the settings scroller on deep links, and add the `scrollTop === 0` check to e2e (UI, small).
2. N2: rewrite `PLAN_GUARD_LINE` so it states only what runs, plus the share clause (copy, small).
3. N3 and N4: Exact model shows "Not set" for tier roles, "Not set" never writes inherit, one "Model" label.
4. N5: one assistant model line helper, and fix the note.
5. N6: a Team assistant mode line with a link on the Team tab.
6. N7, N8, N10, N11, then N9 (main), N12, N13.

## Not driven

- Any non-Anthropic connection. The mock connects only Anthropic, so these were not driven: "Use for new projects", Back
  to automatic, a refused setDefault, the multi-connection project cards, a metered Limits pane, Effort on an OpenAI
  project, and the OpenAI-only scenario (code read above).
- Real sign-ins, the native folder pickers (Change folder, Browse), and the accent hex field.
- L4 (New project form with a found agent).
- Plan windows (the mock reports none), so the live plan guard behaviour behind N2 is from a code read.
- The Settings tablist arrow keys were spot-checked only: ArrowDown moved focus from Permissions to Limits.
