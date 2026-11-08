# Transcript media

Transcript media belongs in the conversation where it was produced. Assistant media appears in transcript order; a tool result renders its ordered text and media parts in place of the legacy textual result when parts are present. Pairing a result with its tool call and reopening history must preserve that order. Existing user image attachments continue to work.

Images use the existing transcript attachment presentation and preview interaction. A collapsed tool call must make the presence of media discoverable before expansion, including an image-only result. Missing, unsupported and unsafe sources are represented by a readable fallback; they must not appear as broken images or become navigable remote content.

Use the existing in-flow image preview and native controls. The image trigger has an accessible name, Enter and Space open it, Escape closes it, and focus stays on the trigger. The collapsed tool disclosure exposes its state and media count. Maintain visible focus and readable fallback text in both themes and at 1024×640 and 1600×1000; do not rely on color alone.

The runtime contract normalizes media before it reaches the renderer: `TranscriptMedia` is an image with an `ImageAttachment`, or unsupported media with optional type and name and a reason. `TranscriptContentPart` is ordered text or media. The renderer does not interpret provider-specific payloads.

Verification should exercise mixed text/image order, assistant media, image-only and collapsed tool results, unsupported, missing and unsafe sources, original user images, pairing, history and keyboard preview/close/focus. Run `npm run build` before the token-free mock e2e. A mock walkthrough in both themes and sizes is required; live providers, screen-reader speech, 320 px reflow and browser zoom remain unverified unless separately exercised.
