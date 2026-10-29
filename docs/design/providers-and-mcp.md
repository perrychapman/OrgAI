# Providers, model remap and MCP: UI spec

Status: proposal for the UI Engineers. Extends `spec.md` (sections 2.3, 2.5, 2.7, 3, 4); where this file is silent, `spec.md` and its adaptation of the frontend-design skill apply (dense tool, restraint, no hero sections).

Rules that apply to every screen below:

- Tokens and the type scale only (`--text-caption|small|body|body-strong|title-sm|title`, `--text-mono` for ids, URLs, commands, env var names). No off-scale px, hex or shadow literals. Both themes.
- Components come from `components/ui` and `components/layout` (Button, IconButton, Switch, RadioGroup, SegmentedControl, Tabs, Badge, StatusDot, Card, ListRow, Dialog, ConfirmDialog, Popover, DropdownMenu, Tooltip, Banner, EmptyState, Field, SettingRow, Progress, Code, DecisionCard). Views never import radix-ui. Icons are lucide through `Icon`, with `aria-label` when alone. No new primitive is needed except `ModelSelect` and `SecretField` (section 9).
- Sentence case. At most one primary action per region. Status is icon plus text, never color alone.
- Nothing floats over the canvas. Notices and approvals are in-flow regions (a Banner or DecisionCard stack in the region above the canvas or at the top of the settings column).
- Layout responds to the container (`container-type: inline-size` on the settings column, the side panel, the live card region), not the window. Breakpoints (container width): `compact` < 480, `regular` 480 to 719, `wide` >= 720. At 1024x640 the settings column is about 700 px wide with the sidebar expanded and about 770 with it collapsed, so `regular` is the design target; `wide` is reached on 1920+. The inspector (side panel, 320 to 400 px) is always `compact`.

## 1. App settings > Connections

The App settings page `Claude and usage` becomes `Connections` (same sub-nav slot) and its plan usage block moves under the Anthropic card. Page title `Connections`, description "Where agents get their models. Each project picks one connection."

Page header right side: one secondary `Refresh all` button (tooltip: "Reload status and model lists"). There is no primary action on the page; each card has its own primary action, which is allowed because they are separate regions.

Cards stack in one column, `--space-4` gap, order Anthropic, OpenAI, LiteLLM proxy. Each is a `Card` with this anatomy:

```
+----------------------------------------------------------------------------+
| [mark] Anthropic                      (o) Connected   [Refresh]  [v]       |
|        you@example.com · Claude Max                                         |
+----------------------------------------------------------------------------+
| Authentication  ( ) Claude Code login  ( ) API key from environment variable|
|                 [ANTHROPIC_API_KEY________]                                 |
+----------------------------------------------------------------------------+
| Models (14)   [Search models________]  [All] [Claude] [OpenAI] [Other]      |
|  Claude                                                                     |
|   claude-fable-5-5         context 1M                                       |
|  ...                                                                        |
+----------------------------------------------------------------------------+
| Tier mapping                                                    [Reset]     |
|  Top      [claude-fable-5-5      v]                                         |
|  Deep     [claude-opus-4-7       v]                                         |
|  Everyday [claude-sonnet-5-5     v]                                         |
|  Fast     [claude-haiku-4-5      v]                                         |
+----------------------------------------------------------------------------+
```

### 1.1 Card header (always visible)

- Provider mark (lucide `Sparkles` for Anthropic, `Bot` for OpenAI, `Network` for LiteLLM, 20 px in a `--surface-3` rounded tile; no vendor logos), name in `title-sm`, and under it one line of `--text-secondary` `small`: account (email or plan, or the proxy host) or the reason when not connected.
- Status badge, right-aligned, always icon plus label:

| Status | Badge | Icon | Detail line |
| --- | --- | --- | --- |
| `disconnected` | neutral `Not connected` | `CircleDashed` | What to do: "Sign in to use ChatGPT models." |
| `connecting` | info `Connecting` | `Loader` (spins; static `Loader` under reduced motion) | "Waiting for the browser sign-in" / "Testing the proxy" |
| `connected` | success `Connected` | `CircleCheck` | Account, plan, "Updated 2 min ago" (relative with absolute tooltip) |
| `error` | danger `Error` | `CircleAlert` | The error detail verbatim from the contract, wrapped, selectable, plus `Copy details` ghost button |

- Actions in the header trailing cluster: `Refresh` IconButton (`RefreshCw`, label "Refresh Anthropic status and models"; disabled with spinner while loading) and a chevron IconButton toggling the card body (`aria-expanded`). A connected card defaults to expanded; a disconnected one shows its connect controls and hides Models and Tier mapping (they would be empty).
- The status region has `role="status"` `aria-live="polite"` so a change from connecting to connected or error is announced.

### 1.2 Anthropic body

- Authentication: the existing `RadioGroup` (`list` variant): `Claude Code login` and `API key from environment variable`. With the second selected, a mono Input for the variable name (default `ANTHROPIC_API_KEY`, characters limited to `[A-Za-z0-9_]`) and the existing hint that the key itself is never stored by OrgAI.
- Primary action (only when not connected): `Connect`. When connected, no primary; secondary `Disconnect` is in the card's `...` DropdownMenu.
- Plan usage bars (existing component) appear below, `Progress` rows, only when connected with subscription auth.

### 1.3 OpenAI body

Two methods in a `RadioGroup` (`list`): `Sign in with ChatGPT` (description: "Uses your ChatGPT plan through Codex. No API key needed.") and `API key from environment variable` (mono Input, default `OPENAI_API_KEY`).

Sign in with ChatGPT has two sub-flows in a `SegmentedControl` (`Browser` / `Device code`), default `Browser`:

- Browser: primary `Sign in with ChatGPT` opens the system browser. While `connecting`, the button becomes loading, and a secondary `Cancel` appears next to it. Helper text: "Finish signing in in your browser. This page updates when you are done."
- Device code (for remote or locked-down machines): primary `Get a code`. When the contract returns the code, a **device code panel** replaces the button, inside the card (not a popover or dialog):

```
Go to   https://auth.openai.com/codex/device   [Copy] [Open]
Enter   ABCD-EFGH                              [Copy]
Code expires in 14:32 · Waiting for approval…            [Cancel]
```

  The verification URL and user code are `--text-mono` in a `--code-bg` inset; the user code is `--text-title` mono with letter spacing from the existing mono scale only (no custom tracking), selectable, `aria-label="User code A B C D, E F G H"`. `Open` opens the URL in the system browser (never in an Electron window). The countdown is a `tabular` text updated each second but announced only at start and on expiry (the live region is not the ticking element). On expiry the panel shows a warning Banner "The code expired" with primary `Get a new code`.

Errors: user closed or denied the browser sign-in -> status `error`, detail "Sign-in was cancelled" with `Try again` primary.

### 1.4 LiteLLM proxy body

- Fields (`Field`, stacked at `compact`, two columns of equal width at `wide`): `Base URL` (mono, placeholder `http://localhost:4000`, validated as http or https URL; inline invalid message "Enter a full URL starting with http:// or https://") and `API key` (`SecretField`, section 9).
- Helper under the fields: "The key is stored encrypted on this machine. It is never written to your project or shown again."
- Primary `Test and connect`. Flow: loading state (button `aria-busy`, label kept, status `connecting` "Testing the proxy"), then `connected` with "N models found", or `error` with the detail (for example "401 from /v1/models: invalid key", "Could not reach localhost:4000"). The key field is unchanged after an error (still `set`). Editing the URL or replacing the key sets the card back to `disconnected` with a neutral hint "Changed. Test and connect to apply." while the previous catalog is kept dimmed until the new test succeeds.
- Secondary `Remove connection` in the `...` menu (ConfirmDialog; body names the projects that currently use it, which then fall back per the remap notice in section 2).

### 1.5 Discovered models (all cards, connected only)

- A collapsible group `Models (n)`. Header row: a search Input with `Search` icon (`type="search"`, label "Search models", filters by id substring as you type, `Esc` clears) and a `SegmentedControl` filter `All / Claude / OpenAI / Other` with counts (`Claude 6`). At `compact` the segmented control wraps under the search field.
- The list is grouped by family: `Claude`, `OpenAI`, `Other` (sentence-case group headings in `body-strong` with a count in `--text-tertiary`). Rows: `ListRow` with the model id in mono, a short display name as secondary text, optional meta badges (context window `tabular`, `reasoning`), and a trailing tier chip if the model is assigned to a tier ("Everyday"). Rows are not interactive (informational); keyboard users scroll the list container (`tabindex="0"`, `role="list"`, labelled "Models").
- The list has a fixed max height (about 8 rows, then scroll) so it never pushes the tier editor out of view.
- States: loading is 5 `Skeleton` rows; empty after search is `EmptyState` (icon `SearchX`, "No models match "foo"", ghost `Clear search`); empty catalog from a connected provider is a warning Banner "This connection returned no models" with `Refresh`; list error is a danger Banner with the detail and `Retry`.

### 1.6 Tier mapping editor

Four rows, labels and meaning (descriptions in `small` secondary), each with a `ModelSelect` (native select grouped with `optgroup` by family, populated from this connection's catalog only):

| Tier | Description |
| --- | --- |
| Top | Most capable. Orchestrators and hard problems. |
| Deep | Strong reasoning for senior roles. |
| Everyday | Default for most roles. |
| Fast | Cheap and quick. Lookups and simple edits. |

- Layout: `SettingRow` at `regular` and `wide` (label and description left, select right, select min 240 px); at `compact` the select goes below the label (`stack`).
- Unmapped or stale entries (the mapped model is no longer in the catalog) show the select with invalid styling and the message "claude-x is no longer available. Pick another." and the card shows a warning dot on the Tier mapping heading.
- Editing is deliberate, not auto-saved: a row change marks the group dirty and shows a footer inside the group with primary `Apply mapping` and secondary `Discard`. `Apply` runs the remap preview (section 2.2) when any project uses this connection, otherwise saves directly with a toast "Tier mapping saved". `Reset` (ghost, in the group header) restores the defaults suggested by the contract, also staged until `Apply`.
- If the same model is chosen for two tiers, show an info hint on the second row ("Same model as Deep"); it is allowed.

### 1.7 Page states

- Loading (first open): three card skeletons (header plus two lines). Statuses load independently; a card's skeleton is replaced as soon as its own status arrives.
- Offline or all providers failed: each card shows its own error; there is no page-level banner except when the IPC call itself failed (danger Banner "Could not load connections" with `Retry`).
- Empty (nothing connected): a neutral Banner at the top of the page, "No connection is set up. Connect one so projects can run." and no other special treatment. The cards already are the call to action.

## 2. Model remap feedback

Connecting a provider, switching a project's connection and changing a tier mapping can all change which models roles use. Roles store a tier or `Inherit` where possible; when a role holds a concrete model that is not in the new catalog, the main process picks the tier equivalent. The UI never silently changes models.

### 2.1 Non-blocking notice

After the change is applied, an in-flow `Banner` (tone `info`; tone `warning` if any role could not be mapped) appears at the top of the content column of the page where the user is (Connections, project Settings, Org chart tab). It does not steal focus, announces politely, and persists until dismissed or until all its undo entries are resolved. Several notices stack, newest on top, at most three visible, then a `+n more` toggle.

Content, per notice:

```
(i) Models updated for 2 projects after connecting OpenAI                [Dismiss]
    v Notes API   4 roles                                       [Undo]
        Orchestrator   claude-fable-5-5  ->  gpt-5.5
        Implementer    claude-sonnet-5-5 ->  gpt-5.5-mini
        ...
    v OrgAI       3 roles                                       [Undo]
```

- Title in `body-strong`, one sentence stating the cause ("after connecting OpenAI", "after changing the Anthropic tier mapping", "after switching Notes API to LiteLLM").
- One `Collapsible` per project (collapsed when more than 2 projects, expanded otherwise). The header shows the project name, the count of changed roles and a ghost `Undo` button. `Undo` restores that project's previous models and connection assignment, then the entry becomes a one-line "Reverted" text with the check icon for 5 seconds and disappears. Undo is available until the notice is dismissed or the app restarts; after that the entry shows nothing (the remap stays recorded in project history by the runtime).
- Role rows are `--text-mono` `small`: role name (sans, `--text-secondary`), then `from -> to` with an `ArrowRight` icon (not the characters). `from` is struck-through-free, just `--text-tertiary`; `to` is `--text-primary`. Roles that could not be mapped show `from -> Inherit` with a warning icon and the reason tooltip.
- Dismiss is an IconButton (`X`, label "Dismiss notice"). Toasts are used only as a confirmation after Undo ("Reverted Notes API"), never as the primary vehicle, because the list needs to stay readable.
- Project-scoped surfaces show only their own project's entry; App settings shows all.
- Compact: the `from -> to` pair wraps onto two lines (from above to) with the arrow icon rotated down.
- Loading: the Banner appears only when the result is known. While the main process computes, the triggering button is loading.
- Error: if Undo fails, the entry turns danger with the detail and `Retry`.

### 2.2 Preview before applying (tier mapping and connection switch)

The preview uses the same row layout as the notice but is in a `Dialog` (`md`, 560 px) because it blocks a destructive-ish decision made from a button the user just pressed; it is not shown for connect events, which are non-blocking. Title "Apply this mapping?", body "These roles will use different models:", the per-project grouped list (all expanded, scrollable), footer `Cancel` and primary `Apply and update roles`. If nothing changes: the dialog is skipped and the change applies with a toast. Focus starts on `Cancel`. Empty and loading: skeleton rows while the preview is computed; error shows a danger Banner in the dialog with `Retry` and the primary disabled.

## 3. Project settings > Connection

New section `Connection`, replacing the read-only `Provider` section from `spec.md` 2.3 (the sub-nav entry and the `settings-section-provider` anchor become `connection` / `settings-section-connection`). Contains:

- `Connection` row (`SettingRow`): a `RadioGroup` of `cards` variant at `regular` and `wide` (three option cards in a row: Anthropic, OpenAI, LiteLLM, each with mark, name and the status badge of that connection), a vertical `list` at `compact`. Disconnected connections are selectable but show their Not connected badge and, below the group, a warning Banner "OpenAI is not connected. Connect it to run this project." with a secondary `Open connections` button. The project can be saved against a disconnected connection (it is a preference); the Run tab's start button is disabled with reason when the connection is not `connected`.
- Authentication details are no longer per project; the row `Authentication` is removed and the row's description links to `Settings > Connections`.
- Changing the selection never applies immediately. The group shows a pending state (the newly chosen card gets a `selected` outline, the old one `current`) and a footer: primary `Review changes`, secondary `Cancel`. `Review changes` opens the remap preview dialog (section 2.2) listing the project's roles, `from -> to`, computed against the new connection's tier mapping. Primary `Apply and update roles` writes it, then the info notice (section 2.1) shows with Undo.
- Under the picker, a read-only line: "Roles on this connection: 5 · Everyday: gpt-5.5-mini" (summary, `small`, secondary).
- **LiteLLM explanation.** When LiteLLM is the selected or pending connection, an info Banner (not dismissible, in the section) reads: "LiteLLM runs through one adapter per model family. The orchestrator's model decides which adapter this project uses (Claude models use the Claude adapter, OpenAI models use the OpenAI adapter). Every role must use a model from that same family." Beneath it, the `Root model family` row shows a read-only Badge (`Claude` or `OpenAI`) derived from the orchestrator role's model, with a tooltip "Change the orchestrator's model to change the family." Roles whose model belongs to another family appear in a list "Roles that must change (2)" with `from -> to` suggestions; the preview treats these as part of the change set, and `Apply and update roles` is the only way forward (primary disabled with reason "Choose a model for the orchestrator first" if the root has `Inherit` and the tier mapping has no model for the Top tier).
- States: loading (skeleton cards), the connection list failing to load (danger Banner with `Retry`; picker disabled), no connection connected at all (warning Banner linking to Connections).

## 4. Role inspector: model picker

Replaces the model `<select>` and its hint in `RoleInspector.tsx` (General tab).

- A `ModelSelect` (native select with `optgroup`s) labelled `Model`. Options come from the project's connection catalog only. Groups in this order, with group labels that name the tier: `Inherit`, `Top`, `Deep`, `Everyday`, `Fast`, `Other models`.
  - `Inherit` is first and standalone: label "Inherit from parent" (for the root role: "Use the connection default"), described by the resolved model on a second line of the field description ("Resolves to gpt-5.5 (Top)").
  - Each tier group contains the model currently mapped to that tier on this connection, labelled `gpt-5.5 · Top`; the other catalog models follow under `Other models`, grouped by family when more than 8 (nested `optgroup` names `Other models: Claude`). This keeps the common choice one keystroke away while still allowing any model.
  - A stored model that is not in the catalog appears as a disabled first option "claude-x (unavailable)" with the field invalid and the message "Not available on OpenAI. Choose another model or Inherit."
- **Tier display.** Next to the label, a `Badge` (neutral, `sm`) with the role's tier: "Tier: Everyday". Rules: if the selected value is a tier (Inherit resolves to tier through ancestors) the badge shows that tier; if it is a catalog model mapped to a tier, that tier; otherwise `Custom model`. The badge has a tooltip with the full resolution chain ("Inherits from Orchestrator -> Top -> gpt-5.5").
- Under the select, a `small` secondary description of the selected model (context window, `reasoning`). Disabled with reason when the project has no connected connection: "Connect OpenAI to choose a model." with a link button `Open connections`.
- Loading: select disabled with a `Skeleton` bar; error: danger text "Could not load models" and an inline `Retry` ghost button.
- Compact (always in the inspector): label above, select full width, badge on the label line right-aligned.
- Keyboard: the native select; type-ahead works within the `optgroup`s. The tier badge is not focusable but its tooltip text is also in the select's `aria-describedby`.

## 5. Project settings > MCP servers and plugins

New sections in project Settings, after `Agents and permissions`: `MCP servers` (anchor `settings-section-mcp`) and `Plugins` (anchor `settings-section-plugins`). Section header for MCP servers: title, description "Tools agents can call. Servers run code on this machine." and a trailing cluster: primary `Add from registry`, secondary `Add manually`, secondary `Configure with AI`. This is the only region with a primary action in the section; `Plugins` has a secondary `Add plugin`.

At `compact` the three buttons collapse: `Add from registry` stays visible, the others move to a `...` DropdownMenu.

### 5.1 Server list

A `Card` of `ListRow`s, one per server, `--space-3` row padding. Each row (`wide` shows all columns on one line; `regular` wraps meta to a second line; `compact` stacks and moves actions into a `...` menu):

```
[switch] filesystem          [stdio]  [Registry]   Roles: 3 of 5   [Test] [...]
         @modelcontextprotocol/server-filesystem@2.1.4
         Env: ALLOWED_DIR set · TOKEN not set
```

- Enable `Switch` first in tab order with `aria-label="Enable filesystem"`. Disabled servers dim everything except the Switch.
- Name in `body-strong`. Under it the launch target in `--text-mono` `small`, middle-truncated with tooltip: for stdio `command args` or `package@version`; for http and sse the URL.
- Transport `Badge` (neutral): `stdio`, `http`, `sse`. Source `Badge`: `You` (neutral, icon `User`), `Registry` (info, icon `Package`), `Agent` (warning, icon `Bot`, meaning an agent requested it and the user approved; tooltip names the agent and date).
- Role access: a text button "Roles: 3 of 5" opening a `Popover` with a checkbox list of roles (avatar, name) and `All roles` toggle at the top. `Esc` closes and returns focus. Default for new servers is the roles the contract proposes, shown as checked, never silently "all".
- Secrets summary: one `small` line "ALLOWED_DIR set · TOKEN not set" using `Check`/`Minus` icons and text, in `--warning-text` if a required one is not set (and a warning dot on the row).
- `Test` secondary small button: runs a connection test (spawn/connect, list tools). States: idle, `Testing` (loading, cancellable with `Esc`/`Cancel`), result. The result opens inline under the row in a collapsible **test result panel** (not a popover): success `Badge` "Connected in 1.2 s" and the tool list as a two column mono list at `wide`, one column below (tool name, then description truncated to one line with tooltip), count in the heading ("12 tools"); failure danger Banner with the exit code or HTTP status and the last stderr lines in a `--code-bg` block (max 8 lines, scroll) plus `Copy output`. The panel has `role="region"` labelled "Test result for filesystem" and takes focus on completion only if the user started the test with the keyboard.
- `...` menu: `Edit`, `Duplicate`, `Remove server...` (ConfirmDialog; body states which roles lose tools).
- `Edit` expands the row into the edit form (section 5.3) in place.

### 5.2 Add from registry

A `Dialog` `lg` (720 px) titled "Add MCP server from registry". At `compact` window sizes the dialog is full width minus `--space-4`.

- Search field (autofocus, label "Search registry", debounced, `Enter` searches immediately). Results list below, `role="listbox"` with roving focus, `ArrowUp/ArrowDown`, `Enter` selects.
- Result row: name, publisher, one-line description, `Badge`s for transport, and a **package line**: "npm @scope/pkg" or "pypi pkg" or "remote https://..." in mono, with the **exact pinned version** ("@2.1.4") and a `Badge` "Pinned" (never `latest` or a range; if the registry offers only a range the row shows a danger Badge "Version not pinned" and Select is disabled with reason). Required environment variables are listed as mono chips ("ALLOWED_DIR", "GITHUB_TOKEN") with a `Key` icon for secrets.
- Selecting a result shows a detail pane (side by side at `wide`, a second step with a `Back` button below that): exact command or URL that will run (copyable), pinned version, required env vars with inputs (`SecretField` for secret ones, plain mono Inputs for non-secret), roles access (default checked as proposed), a security note (section 7.1 phrasing) and primary `Add server`. Missing required env vars do not block adding (it can be added with "not set" and tested later) but are shown as a warning.
- States: empty before search ("Search the registry for servers by name or capability."), loading (Skeleton rows), no results ("No servers match "foo"." with link `Add manually`), error (danger Banner "Registry unavailable" with detail and `Retry`; `Add manually` still offered).

### 5.3 Add manually (and Edit)

Same dialog size, a form (`Field`s): `Name` (unique, slug-validated), `Transport` (`SegmentedControl`: stdio, http, sse), then stdio: `Command` (mono), `Arguments` (one per line textarea, mono), `Working directory` (optional); http/sse: `URL`, optional `Headers` (name/value rows; value is a `SecretField`). `Environment variables` is a repeatable row (`Name` mono input, `Value` `SecretField`, `Remove` IconButton) with `Add variable`. `Role access` as in 5.1. Primary `Add server` (`Save changes` when editing), secondary `Cancel`; inline validation on blur; `Test` is available before saving ("Save and test" is not offered; test works on the unsaved form).

### 5.4 Secret fields (write-only)

`SecretField` never receives or displays a stored value.

- State `not set`: empty password-type input, placeholder "Not set", a `Badge` (neutral, `Minus` icon) "Not set" to its right.
- State `set`: the field renders as a disabled-looking read-only box with bullets (fixed number, not the length) and a success Badge (`Check` icon) "Set". Buttons: `Replace` (secondary small) turns the box into an empty password input with `Save`/`Cancel` (`Enter` saves, `Esc` cancels, focus on the input), and `Clear` (ghost, danger text), which uses a ConfirmDialog "Clear TOKEN?".
- No reveal or copy button, by design. `autocomplete="off"`. The input's value is cleared from state immediately after the IPC call resolves. The `set`/`not set` state is read from the contract and announced by the Badge text (not an icon alone).
- Screen reader label: "GITHUB_TOKEN, secret, set" / "not set".

### 5.5 Configure with AI

`Configure with AI` (secondary, `Sparkles` icon) opens a `Dialog` `sm` with a single textarea "What should agents be able to do?" (placeholder "Search the web, read GitHub issues...") and primary `Start assistant run`. It then closes and switches to the Run tab with a new `setup`-kind run labelled "Configure MCP servers". Proposals from that assistant appear in the live run as `DecisionCard`s using the same layout as the install approval card in section 6 (kind `mcp-proposal`: "Add server X", exact command, pinned version, env var inputs, role access, Approve / Request changes / Deny). Approved ones land in the list above with source `Agent`. Back in Settings, a neutral Banner "An assistant run is configuring MCP servers. Open the run." with `Open run` persists while that run is open.

### 5.6 Plugins

`Plugins` (Claude only) is a `Card` of `ListRow`s: name, local path in mono (middle-truncated, tooltip), enable `Switch`, version if declared, `...` menu (`Reveal in folder`, `Remove`). `Add plugin` opens the native folder picker (via the contract), validates, and adds the row (invalid path -> inline danger text on the row "No plugin manifest found"). If the project's connection is not Anthropic (or LiteLLM with a non-Claude root), the whole section shows an info Banner "Plugins work with Claude only. They are ignored on this connection." and every Switch is disabled with that reason.

### 5.7 MCP and plugin states

- Empty: `EmptyState` (icon `Plug`, "No MCP servers", "Add one from the registry, set one up by hand, or ask an assistant.") with the same three actions; `Plugins` empty: "No plugins".
- Loading: three `Skeleton` rows. Error: danger Banner "Could not load MCP servers" with `Retry`.
- Per-row error (server fails to start in a run): danger dot, danger-text line "Failed to start: spawn ENOENT" and a `Test` shortcut.
- Not supported on the selected connection: the OpenAI adapter's MCP support is whatever the contract says; unsupported servers or transports show a warning Badge "Not supported on OpenAI" and are excluded from the "Roles: n of m" access count.

## 6. Live run: MCP install approval card

In-flow `DecisionCard` of kind `mcp-install`, rendered in the live run's card region above the canvas (the same region as proposals; at most one expanded, others collapse to a one-line header, with an `Inbox` badge). It also appears in the Inbox tab. The agents remain blocked on it, and the run bar shows the existing waiting banner.

```
+------------------------------------------------------------------------------+
| [shield] Implementer wants to install an MCP server                          |
|          Requested 12:04 · waiting                                           |
+------------------------------------------------------------------------------+
| Why   "I need to read GitHub issues to triage the backlog."                  |
|                                                                              |
| (!) This runs code on this machine with your permissions. It can read and    |
|     write files and use the network. Only approve servers you trust.         |
|                                                                              |
| Will run     npx -y @modelcontextprotocol/server-github@1.4.2    [Copy]      |
| Version      1.4.2 · pinned     Source  npm registry                         |
| Transport    stdio                                                           |
|                                                                              |
| Secrets      GITHUB_TOKEN  [ set / enter value ........ ]  (write-only)      |
| Scope        ( ) This run only   ( ) This project  (default: this run)       |
| Roles        Implementer, Reviewer  [Change]                                 |
|                                                                              |
| Note to the agent (optional)  [..................................]           |
|                                         [Deny]            [Approve]          |
+------------------------------------------------------------------------------+
```

- Header: `ShieldAlert` icon in a `--warning-soft` tile (icon plus the words "runs code on this machine"; not color alone), title "<Agent name> wants to install an MCP server" (`title-sm`; agent shown with its `Avatar` and role), meta line with time and the card's state Badge (`Waiting for you`).
- **Why**: the agent's stated reason, quoted, `body`, max 4 lines with `Show more`. Agent-provided text is rendered as plain text (no Markdown, no links activated); it is untrusted.
- **Security cue**: a `Banner` (tone `warning`, `TriangleAlert`) inside the card, not dismissible: "This runs code on this machine with your permissions. Only approve servers you trust." For http/sse: "This connects to a remote server that will receive the data the agent sends it." Both cues are present in the DOM text for screen readers.
- **Exact command and URL**: `--code-bg` block, `--text-mono`, full text, wrapping (never truncated), selectable, with a `Copy` IconButton. Below it labelled facts: pinned version (exact; if not pinned, danger Badge "Not pinned" and `Approve` is disabled with the reason "Only pinned versions can be approved"), source (registry/package name, or "Typed by the agent" in warning tone when it is not from the registry), transport. If the command differs from what the registry resolves, show a diff-free warning line "Command does not match the registry entry".
- **Secrets**: one `SecretField` per required env var, write-only as in 5.4. Required ones left unset do not block approval but show "Not set. The server may not work." in warning text; the user can also approve and set them later in Settings.
- **Scope**: `RadioGroup` `list` with two options, "This run only" (default; description "Removed when the run ends") and "This project" (description "Saved to MCP servers in project settings, source Agent"). Roles access: summary "Roles: Implementer" and `Change` opening the same Popover as 5.1; default is the requesting role only.
- **Note**: optional `Textarea` `sm`, label "Note to the agent (optional)", placeholder "Tell the agent why or what to do instead".
- **Actions**: right-aligned footer. Primary `Approve` (the name is kept verbatim for e2e), secondary `Deny`. Exactly one primary. `Approve` becomes loading ("Installing..."), then the card collapses into a resolved summary ("Approved for this run · github 1.4.2 connected, 9 tools") with a `Test result` expander. An install or connect failure shows a danger Banner in the card and the card stays open with `Retry` and `Deny`.
- **Denial**: `Deny` sends the note (if any) and the agent is told to find another route: the contract's denial message is "The user denied installing this server. <note> Find another way to complete the task without it." The note text shows in the card's resolved summary ("Denied. Note sent: ..."). Denial needs no ConfirmDialog.
- Keyboard and focus: the card region is announced by a polite live region ("Implementer is asking to install an MCP server"); the card does not steal focus. Tab order: card header (collapse toggle) -> Why `Show more` -> command `Copy` -> secret fields (each: `Replace`) -> scope radios (arrow keys inside) -> `Change` roles -> Note -> `Deny` -> `Approve`. `Approve` is last in the DOM so a keyboard user passes over all details before it; neither button has autofocus. `Esc` does nothing in the card (it never dismisses a decision).
- States: pending (above), busy (Approve loading, controls disabled), resolved (summary), error (Banner), stale (the agent was interrupted or the run ended: Badge "No longer needed" and buttons disabled with `Dismiss`).
- Container behavior (card region width): `wide` shows facts as a two-column definition grid and the Secret/Scope blocks side by side; `regular` single column with the grid collapsed to one column; `compact` stacks everything and makes `Deny` and `Approve` full-width buttons in a column (Approve last). The card scrolls internally (max height of the region, `overflow: auto`) so the canvas keeps at least 200 px at 1024x640.

## 7. Security and copy rules

7.1 Standard phrases (reuse verbatim): "Runs code on this machine with your permissions." (stdio), "Connects to a remote server that receives what the agent sends it." (http, sse), "Secrets are stored encrypted on this machine and are never shown again."

7.2 Never render a stored secret. Never log typed secrets. URLs and commands are shown exactly as they will be executed, including args.

7.3 Agent-provided strings (reason, names, descriptions) are plain text, length-clamped with `Show more`, and never rendered as links or Markdown.

## 8. Keyboard and focus order, summary

- Connections page: page heading -> `Refresh all` -> per card in order: header `Refresh`, chevron, `...` menu -> auth radios (arrow keys within group) -> env var or fields -> primary connect action -> Models search -> family segmented control -> models list (one tab stop) -> tier selects -> `Reset` -> `Apply mapping`/`Discard`. The device code panel receives focus on its `Copy` code button when it first appears from a keyboard-initiated `Get a code`. Dialog focus trap and restore apply to every Dialog here; ConfirmDialog starts on Cancel.
- Remap notice: Banner is a `region` labelled "Model changes"; inside, project collapsibles are buttons (Enter/Space), then each project's `Undo`, then `Dismiss`. It sits first in DOM order of the content column but is inserted without moving focus.
- Project settings Connection: radio cards form one tab stop (arrows move selection), then `Review changes`, `Cancel`.
- MCP list: per row, tab order is Switch -> roles button -> `Test` -> `...`; results panel follows the row in DOM order.
- Registry dialog: search -> results listbox (one tab stop, arrows) -> detail pane controls -> `Add server`/`Cancel`.
- All focus rings are the global `:focus-visible` ring. Switches and radios keep their native or Radix semantics and a 24 px minimum target.

## 9. New shared pieces (for the shell/primitives pass)

- `ModelSelect`: wrapper over native select (`optgroup`s, invalid and disabled states, mono option text). Lives in `components/ui` so the Role inspector, tier editor and settings share it.
- `SecretField`: props `state: 'set' | 'notSet'`, `onSave(value)`, `onClear?`; owns the Replace/Save/Cancel interaction and the write-only rules in 5.4.
- `ConnectionStatusBadge`: maps the four statuses to Badge tone, icon and label (table in 1.1); used on cards, the project picker and the role inspector.
- `RemapNotice`: the Banner composition in 2.1, taking the project/role change list; also reused (read-only, no Undo) by the preview dialog.
- All other pieces are compositions of existing primitives (`DecisionCard` for section 6).

## 10. Container-query summary

| Container | Class | `compact` < 480 | `regular` 480 to 719 | `wide` >= 720 |
| --- | --- | --- | --- | --- |
| Settings content column | `settings-col` | Fields stacked; tier rows stacked; connection radio `list`; MCP row actions in `...`; segmented controls wrap | Tier rows side by side; MCP meta on second line; connection cards in a row | Two-column LiteLLM fields; test tool list in two columns; MCP row on one line |
| Live card region | `live-cards` | Approval actions stacked full width; facts one column | Facts one column | Facts two-column grid; Secret and Scope side by side |
| Side panel (inspector) | `side` | Always this layout | | |
| Registry dialog | `dialog-lg` | Results then detail as two steps | Same | Results left, detail right (40/60) |

Heights: at 640 px window height the Connections cards collapse their Models group by default (header shows "Models (14)" and a toggle), and the live card region caps at 40% of the height, scrolling internally.

## 11. e2e hooks to provide

`data-testid`: `connection-card` with `data-provider="anthropic|openai|litellm"`, `connection-status` (text), `connection-refresh`, `tier-select` with `data-tier`, `remap-notice`, `remap-undo` with `data-project`, `project-connection` (radio cards), `role-model-select`, `role-tier-badge`, `mcp-row` with `data-server`, `mcp-test`, `mcp-test-result`, `secret-field` with `data-name` and `data-state="set|notSet"`, `mcp-install-card`, `mcp-install-command`. Button names kept verbatim: `Connect`, `Test and connect`, `Apply mapping`, `Review changes`, `Apply and update roles`, `Undo`, `Add from registry`, `Add manually`, `Configure with AI`, `Test`, `Approve`, `Deny`.
