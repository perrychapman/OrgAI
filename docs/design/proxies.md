# Proxy connections (renderer spec)

Source: the pre-change walk `ux-review-proxies-pre.md` (H1-H3, M1-M7). Contract: `ProxyConnection`, `ProxyCreateInput`,
`ProxyRemoveResult`, `ConnectionInfo.usedBy`, `ConnectionStatus.checks`, `ProviderModel.family/adapter/baseUrl`,
`PROXIES_MAX` 20, `PROXY_NAME_MAX` 40 (src/shared/types.ts). Never put a real host or key in code, tests or docs.

## 1. Naming

One helper, `lib/connectionLabel.ts`: `connectionLabel(id)` (Anthropic, OpenAI, a proxy's own name, "Removed proxy" for a
proxy id that is not in the loaded list, "Proxy" before the list has loaded), `connectionKindLabel(record)` ("LiteLLM
proxy" / "OpenAI-compatible proxy", shown only as a badge or subtitle), `isProxyId`. The store feeds the registry
(`setConnectionRegistry`) whenever `connections` changes. No surface writes "LiteLLM" for a proxy, and "Claude" is no
synonym for the Anthropic connection. Plan-usage sections keep "Claude" / "Codex" only as plan names.

## 2. App settings > Connections

Anthropic and OpenAI cards, then a "Proxies (N)" group: heading, count, `proxy-add` button (disabled with a reason at
PROXIES_MAX), one collapsed card per proxy, empty state `proxies-empty`. A collapsed proxy card is one header control plus
one action. Add proxy is a dialog (`proxy-dialog`): name, kind, Anthropic URL, OpenAI URL (optional, shows its default),
models endpoint (optional, shows its default), API key (named "API key for <name>"). It ends in Test and connect and moves
focus to the new card, announced through `connections-live`. A models endpoint on another host than the base URL gets a
note: that host receives the key. Edit = the same fields on the expanded card; main removes the stored key when a URL moves
to another origin and the card says so. Test and connect shows three outcomes from `status.checks` (reached, key accepted,
models listed) and what the proxy reports (`proxy-reports-note`). Delete key and Remove ask first and name the projects
that use the proxy (`usedBy`); Remove is refused plainly while any exist (main refuses too).

## 3. Model pickers

Grouped by connection (optgroup = connection name) with each model's family (Claude, GPT, Other) when a connection serves
more than one. Covers the four Assistant models selects, Default root / report models, the tier mapping on a card and the
Team role Model select. For a project on a proxy, Exact model is visible in the role panel, not under Advanced.

## 4. Projects

New project: a Connection select when two or more connections are connected. Project settings > General > Connection: one
radio list (name, kind, status, model count) that scrolls inside its region past 5 entries; not-connected entries are
marked and inert. The mapping dialog lists what each tier maps to and what could not be mapped.

## 5. Spend and prices

A proxy that reports no spend or prices says "not reported by this proxy", never "yet", never $0. Dashboard Usage lists only
connections that have something to show. Model prices groups proxy models under the proxy's name.

## Implementation notes

Built as specced; see CLAUDE.md "Proxy connections (renderer)" for testids and what was verified. Contract gap: `ProjectCreateInput`
has no connection field, so New project creates on the default and then calls `projects:remapModels`. Open: the lows from
the review (dialog closable while busy, no focus move on an invalid submit, cards are landmark sections, a removed proxy's
store entries linger, key-removal wording of Delete key vs Clear).
