# Brand Source Masters

Approved cosyncing identity masters. **Do not hand-edit these files** — they are machine
generated, and `../../../scripts/wire_brand_icons.sh` consumes them (together with
`../exports/`) to produce the platform build-tree artwork.

- Mark: R4 "squared arcs" — mono (`cosyncing-mark.svg` + `-reverse`/`-teal`/`-deep-teal`) and
  two-tone (`-two-tone-light` A, `-two-tone-dark` C, `-two-tone-dark-teal-leads` C⁻¹).
- Micro-marks for 16–32 px surfaces: `cosyncing-mark-micro.svg` (M1 vector, arbitrary sizes) and
  `cosyncing-mark-micro-pixel.svg` (M3 pixel-hinted, 16/32/48 exports).
- Wordmark: `cosyncing-wordmark.svg` — Inter Medium outlined to paths, −1% tracking, W3 `sync`
  accent (deep teal light / bright teal reverse); mono variants alongside.
- Lockups: horizontal + stacked, each in light and reverse.
- `cosyncing-icon-layers/`: app-icon tile (two-tone C⁻¹ at 62% on obsidian), favicon (+16 px
  pixel-hinted), maskable, Android adaptive foreground/background + monochrome, notification
  icon, PWA monochrome.

Color system: obsidian `#0B0E14`, off-white `#F2F5F4`, deep teal `#0F766E`, bright teal
`#2DD4BF`. Two-tone only ≥32 px, except on the obsidian tile where it holds to 16 px.
