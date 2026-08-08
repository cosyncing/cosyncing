# Brand Handover — cosyncing client

Copied here 2026-07-20 from the working repository where the identity was designed and
locked. Full rationale: `reference/19-brand-symbol-decision-record.md`.

## What is here

- `source/` — SVG masters (generated, do not hand-edit): R4 "squared arcs" mark in seven
  colorways, M1/M3 micro-marks, outlined Inter Medium wordmark (W3 `sync` accent), four
  lockups, and `cosyncing-icon-layers/` (app-icon tile, Android adaptive fg/bg/monochrome,
  notification, favicon + 16 px pixel-hinted, maskable, PWA monochrome).
- `exports/` — platform-ready rasters: Apple 1024, Play 512, Android adaptive five densities
  (mdpi–xxxhdpi, 108/162/216/324/432 px for the 108 dp layer) + monochrome + notification
  set, web favicon ICO/SVG + touch 180 + PWA any/maskable/monochrome, Windows `.ico` 16–256.
- `marketing/` — locked marketing art: social/OG banner (EN + zh-CN), Play feature graphics
  (light, dark-teal, both EN + zh-CN), Microsoft Store super-hero (V2, focal centered),
  motion ident ("the chase" spin: GIF, SMIL preview, storyboard).
- `reference/` — governing docs: brand brief (14), prompt pack + tagline systems (15),
  decision record (19).
- `../../scripts/wire_brand_icons.{py,sh}` — copies `exports/` into the platform build trees
  and renders the remaining sizes from `source/` (see below), using a pinned CairoSVG venv
  under `output/`. Installed copies are guarded by
  `scripts/ci/public-binary-allowlist.sha256` and structurally checked by `test/brand`.

`source/` and `exports/` are the canonical inputs held in this repo; the tooling that produced
them is maintained outside it. Everything under `source/`, `exports/` and `marketing/` is
locked — treat it as read-only input, not as something to regenerate here.

## Platform wiring (completed 2026-07-31, B1)

`exports/` is wired into the platform build trees; Flutter scaffold artwork is gone. To
re-wire after any change to `source/` or `exports/`, run from the repository root:

```bash
bash apps/client/scripts/wire_brand_icons.sh
```

What is wired:

1. **Android** (`android/app/src/main/res/`): `mipmap-anydpi-v26/ic_launcher.xml` adaptive
   icon referencing `@mipmap/ic_launcher_foreground` + `@mipmap/ic_launcher_background` +
   `@mipmap/ic_launcher_monochrome`, all five densities (108/162/216/324/432 px) copied from
   `exports/android/`; legacy `ic_launcher.png` mipmaps re-rendered from the app-icon master
   for pre-API-26; `ic_notification` white-alpha set in `drawable-mdpi…xxxhdpi`, referenced
   by the session notification adapter. Launch background is scheme-aware by accepted
   decision: light `#F2F5F4` canvas / dark `#0B0E14` obsidian (`values/colors.xml`,
   `values-night/colors.xml`), held through the whole handoff — LaunchTheme sets
   `windowSplashScreenBackground` and both NormalThemes keep
   `windowBackground=@drawable/launch_background`.
2. **iOS/macOS** (`ios/Runner/Assets.xcassets`, `macos/Runner/Assets.xcassets`): AppIcon sets
   rendered from `source/cosyncing-icon-layers/app-icon.svg` (square, unmasked — Xcode
   applies masks). Smallest slots use the micro forms instead of downscaling the full mark:
   macOS 16/32 px render the M3 pixel-hinted mono form at integer scale, iOS 20×20@1x
   composites the M1 micro-mark on the obsidian tile. iOS launch uses a `LaunchBackground`
   colorset with the same scheme-aware pair; `LaunchImage.imageset` is deleted.
3. **Web** (`web/`): `favicon.ico` (16/32/48 layers) + `favicon.svg`, PWA any/maskable/
   monochrome icon set, `manifest.json` purposes and theme/background `#0B0E14`,
   `apple-touch-icon-180.png`; service-worker precache covers both favicons.
4. **Windows** (`windows/runner/resources/`): scaffold `.ico` replaced with the brand
   16–256 multi-layer ICO.
5. **Launch screens**: minimal per doc 14 — flat scheme-aware background, no imagery.

Rules that must survive wiring (from the decision record):

- Two-tone only ≥32 px, **except** on the obsidian tile where it holds to 16 px (favicon/ICO
  exception); the 16 px ICO layers use the M3 pixel-hinted mono form — do not downscale the
  full mark for 16 px.
- Android mark stays inside the 66 dp safe zone; Play icon PNG gets no baked corner mask or
  shadow; maskable content inside the centered 80%.
- Colors: obsidian `#0B0E14`, off-white `#F2F5F4`, deep teal `#0F766E`, bright teal `#2DD4BF`.

After any re-wire: run `flutter test test/brand` (durable validation of dimensions, catalog/
manifest references, purposes, alpha/monochrome requirements, and scaffold absence) plus
`flutter analyze` + the full `flutter test`, and eyeball each platform's icon at smallest
display size. Treat everything here as locked; exploration evidence and alternates were not
carried over with this snapshot.

## Also open (not part of wiring)

- Store-listing copy (EN + zh-CN) for the submission pass; tagline systems are in
  `reference/15`.
- Website/README hero and store screenshot campaign: real-app captures are produced in this
  repo (they moved here from the old one).
- A brand-asset change means replacing the files under `source/`/`exports/` wholesale and
  re-running `wire_brand_icons.sh`; the assets here are a locked snapshot, not an editable
  working copy.
