# Bundled fonts

| File | Font | Licence | Source | SHA-256 | Fetched |
| --- | --- | --- | --- | --- | --- |
| `SpaceGrotesk-Variable.ttf` | Space Grotesk, variable weight 300 to 700 (Florian Karsten, Copyright 2020 The Space Grotesk Project Authors) | SIL Open Font License 1.1, text in `SpaceGrotesk-OFL.txt` | `https://github.com/google/fonts/raw/main/ofl/spacegrotesk/SpaceGrotesk%5Bwght%5D.ttf` (upstream `https://github.com/floriankarsten/space-grotesk`) | `acad6de1fc93436f5c0f1f4137751ef04f1aea3063e7036535970ffcfbd79f72` | 2026-11-22 |
| `SpaceGrotesk-OFL.txt` | Licence text for the above | | `https://github.com/google/fonts/raw/main/ofl/spacegrotesk/OFL.txt` | `564ce565c371c5e5bbf286006565a7c9aa55a9f56e7ca58d56e05d649dd61a72` | 2026-11-22 |

The font is unmodified and loaded only from the app bundle through `@font-face` in `styles/global.css` (CSP
`font-src 'self' data:`); nothing is fetched at run time. It is used by `--font-display` (headings) only. The OFL allows
bundling with software; the font may not be sold on its own and the Reserved Font Name rules apply to modified
versions.
