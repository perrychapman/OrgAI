# Third-party logos

Service and provider marks in the Connectors gallery and the Connections cards are bundled inline SVG path data in
`src/renderer/src/components/brand/brandMarks.ts`. Nothing is loaded from the network.

- Source: [Simple Icons](https://simpleicons.org) 16.36.0 (CC0 1.0). Only the path strings and brand colours were copied.
- The marks are trademarks of their owners (Google, Notion, Linear, GitHub, Sentry, Stripe, Figma, Atlassian, Anthropic).
  OrgAI uses them only to identify the services it connects to and does not imply endorsement.
- Anthropic uses the Claude mark. Black or near-black brands (Notion, GitHub, Sentry) are drawn in the theme text colour.
- OpenAI: [@lobehub/icons-static-svg](https://github.com/lobehub/lobe-icons) 1.101.0 `icons/openai.svg` (package.json and README say MIT; the tarball has no LICENSE file). Path data only, fill-rule evenodd, drawn in the theme text colour.
- Slack: [@iconify-json/logos](https://github.com/gilbarbara/logos) 1.2.18 `slack-icon` (CC0-1.0). Four paths with Slack's brand fills (#E01E5A, #36C5F0, #2EB67D, #ECB22E), 256x256 viewBox.
- Both packages were fetched with `npm pack` into a temp dir outside the repo and only read; no dependency was added and nothing runs from them.
- Gap: LiteLLM has no mark in Simple Icons, Lobe Icons or SVG Logos; it keeps its lucide icon (Connections cards and project Connection settings).
- The New project form shows no provider icons, so it is unchanged.
