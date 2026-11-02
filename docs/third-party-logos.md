# Third-party logos

Service and provider marks in the Connectors gallery and the Connections cards are bundled inline SVG path data in
`src/renderer/src/components/brand/brandMarks.ts`. Nothing is loaded from the network.

- Source: [Simple Icons](https://simpleicons.org) 16.36.0 (CC0 1.0). Only the path strings and brand colours were copied.
- The marks are trademarks of their owners (Google, Notion, Linear, GitHub, Sentry, Stripe, Figma, Atlassian, Anthropic).
  OrgAI uses them only to identify the services it connects to and does not imply endorsement.
- Anthropic uses the Claude mark. Black or near-black brands (Notion, GitHub, Sentry) are drawn in the theme text colour.
- OpenAI: [@lobehub/icons-static-svg](https://github.com/lobehub/lobe-icons) 1.101.0 `icons/openai.svg` (package.json and README say MIT; the tarball has no LICENSE file). Path data only, fill-rule evenodd, drawn in the theme text colour.
- Slack: [@iconify-json/logos](https://github.com/gilbarbara/logos) 1.2.18 `slack-icon` (CC0-1.0). Four paths with Slack's brand fills (#E01E5A, #36C5F0, #2EB67D, #ECB22E), 256x256 viewBox.
- Exa: @lobehub/icons-static-svg 1.101.0 `icons/exa-color.svg` (MIT per package.json), evenodd, brand #1F40ED.
- Amplitude: @iconify-json/logos 1.2.18 `amplitude-icon` (CC0-1.0), 256x256 viewBox, brand #10069F.
- Simple Icons 16.36.0 (CC0), path and brand colour: google-docs, google-sheets, google-slides, google-chat, intercom, supabase, cloudflare, datadog, vercel, asana, hubspot, box, paypal, neon, posthog, webflow, miro, zoom, zapier, gitlab.
  Near-black brands (Vercel, PostHog, Miro) follow the theme text colour. Brand colours under 3:1 on the dark tile get a lighter `darkHex`: Datadog, Box, PayPal (#009CDE, its light blue), Zoom, Exa, Amplitude (the tints other than PayPal are our own lighter shades; brandMarks.test.ts checks every mark at 3:1 or more on #20263a).
  Intercom's Simple Icons colour (#6AFDEF) is pale and weak on a light tile; revisit if the walkthrough flags it.
- All three packages were fetched with `npm pack` into a temp dir outside the repo and only read; no dependency was added and nothing runs from them.
- Gaps: LiteLLM has no mark in Simple Icons, Lobe Icons or SVG Logos; it keeps its lucide icon (Connections cards and project Connection settings). DeepWiki, Context7 and Granola are in none of the three sets. Microsoft Learn and AWS Knowledge have only the generic Microsoft and AWS marks available, which are not borrowed. All keep the initial tile.
- The New project form shows no provider icons, so it is unchanged.
