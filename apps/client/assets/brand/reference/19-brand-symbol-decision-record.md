# Brand Symbol Decision Record

- **Status:** promoted to `assets/brand/source/` (2026-07-20); platform exports in
  `assets/brand/exports/`; wiring into platform build trees is the remaining step.
- **Last updated:** 2026-07-20.
- **Governing brief:** [`14-brand-identity-and-release-visuals.md`](14-brand-identity-and-release-visuals.md).
- **Prompt pack:** [`15-brand-and-marketing-generation-prompts.md`](15-brand-and-marketing-generation-prompts.md).
- **Review evidence:** approved copies, working boards, and archived exploration rounds stayed
  in the working repository; only the locked masters and marketing art were carried over.

This records every symbol/identity decision made during the 2026-07-18 exploration so the
reasoning survives context switches. Production masters now live in `assets/brand/source/`
(see "Promotion" below).

## The selected mark

**R4 "squared arcs"** — two rectilinear ring segments facing each other across two diagonal
negative-space channels (master: [`../source/cosyncing-mark.svg`](../source/cosyncing-mark.svg)).

Reading: two independent surfaces in dialogue around one shared channel; a closed-loop feeling
without circular sync arrows, infinity, chain links, Wi-Fi, or letterforms. Selected from the
L4 "open arcs" loop concept and refined into rectilinear form to escape the
sync-circle/loading-spinner cliché of the round version.

## How it was reached

1. **Round 1 — prompt-pack territories as SVG**: the prompt pack's territories A/B/C executed
   as hand-authored SVG instead of image-model generation, on the grounds that final marks must
   be deterministic vectors anyway. 12 marks; survivors A1 (offset slabs), A2 (raked channel),
   B2 (interlocking steps).
2. **Round 2 — from-scratch brainstorm**: fresh territories off the product themes (connection
   between devices, code anywhere, sync anywhere): span, route, dock, reflection, transfer,
   backbone. 12 marks; survivors D1, I1, O1.
3. **Loop territory** (reviewer request): L1–L4. L1 (loop + core) survived; **L4 (open arcs) was
   selected by the reviewer** despite the flagged sync-circle adjacency.
4. **Refinement**: R1 control, R2 unequal gaps, R3 bold band, R4 squared arcs. R1–R3 all kept
   the spinner reading; **R4 selected** — it preserves L4's loop topology while removing the
   cliché.

## Approved decisions

### Symbol geometry

- Production candidate: **R4**, band 12 on a 100 grid, corner radii 18/8, gaps ≈30°-equivalent.
- Rejected variants: R1 (spinner), R2 (asymmetry invisible), R3 (reads as loading indicator).

### Color system

| Treatment | Decision |
|---|---|
| Obsidian `#0B0E14` on off-white `#F2F5F4` | approved — primary on light |
| Deep teal `#0F766E` on off-white | approved — secondary on light |
| Bright teal `#2DD4BF` on off-white | **rejected** — washes out |
| Off-white on obsidian (reverse) | approved |
| Bright teal on obsidian | approved — primary on dark / app icon |
| Deep teal on obsidian | **rejected** — muddy at small sizes |
| Two-tone A: obsidian + deep teal arcs, on light | approved for ≥32 px display |
| Two-tone C / C⁻¹: off-white + bright teal arcs, on obsidian | approved; **C⁻¹ (teal leads) preferred** |
| Two-tone D: deep teal + bright teal on obsidian | **rejected** — deep-teal arc dies at 16 px |
| Accent tiles: obsidian on bright teal; off-white on deep teal | approved as bounded specials |

Rule: below 24 px the mark renders in one color — **except** on an obsidian tile, where two-tone
stays legible to 16 px (favicon exception).

### Wordmark

- **Inter Medium**, −1% tracking, lowercase `cosyncing` (spelling verified c-o-s-y-n-c-i-n-g).
- **W3 color treatment approved:** `sync` segment in deep teal (light) / bright teal (reverse).
- Descriptor `cosyncing broker`: same wordmark, `broker` in regular gray; secondary contexts only.
- Legible at 12 px rendered. Production masters must be outlined paths with manual kerning.

### Tagline (decided 2026-07-19)

Two-line system replacing the 2026-07-18 single line
(`All your agents. All your work. All your ideas. In sync.`):

- Hero: `Code anywhere. Sync everywhere.` — sole line on tight surfaces (Play feature graphic,
  store headers). Echoes the round-2 exploration themes and the `sync` in the name.
- Support: `Your agents keep working. You keep moving.` — stacked under the hero where space
  allows (social banner, hero art, landing).
- Merged one-liner for short descriptions: `Code anywhere, sync everywhere — your agents keep
  working, you keep moving.`
- Rationale: the hero says what it is but not who it's for; the support says the benefit but not
  the product — each covers the other's gap. Both are idiom-free and localize cleanly.
- The hero's `Sync` may take the wordmark's W3 accent color; optional, per surface.

### Lockups — all four approved

| Form | Mark | Wordmark |
|---|---|---|
| Horizontal, light | two-tone A (obsidian + deep teal) | `sync` deep teal |
| Stacked, light | two-tone A | `sync` deep teal |
| Horizontal, obsidian | two-tone C⁻¹ (bright teal leads) | `sync` bright teal |
| Stacked, obsidian | two-tone C⁻¹ | `sync` bright teal |

System rule: the `sync` color always echoes the mark's accent arc. Mono and monochrome-reverse
forms from the Prompt 3 board remain valid where two-tone is not.

### Micro-mark

A simplified derivative for 16–32 px system surfaces (Android notification icon, smallest favicon
layers, Safari pinned tab, later tray) — redrawn, never blindly downscaled.

- **M3 pixel-hinted** (16×16 integer grid): master for fixed 16/32/48 exports; crispest edges.
- **M1 squared R4** (corner radius removed, band 12): vector for arbitrary sizes (20/24 px).
- M2 (bold bracket) rejected — muddy at 16 px.

### App icon and favicon direction

- Two-tone C⁻¹ on a full-bleed obsidian tile, mark at 62% of the tile; survives squircle, circle,
  and square masks inside the Android 66 dp safe zone.
- Favicon: two-tone on the obsidian tile at 48/32; 16 px layer uses the M3 pixel-hinted mono form.

### Marketing assets (locked 2026-07-19)

- **Tagline system:** hero `Code anywhere. Sync everywhere.` (standalone on tight surfaces);
  support `Your agents keep working. You keep moving.` (stacked where space allows). Usage rules
  live in doc 15; Simplified Chinese layer still open.
- **Social/OG banner** locked: obsidian ground, one deep-teal plane, C⁻¹ focal mark, hero +
  support lines. `2400×1260` master, `1200×630`, `1280×640`.
- **Play feature graphic** locked: light (two-tone A) and dark-teal (`#0C1E22`, C⁻¹) versions,
  hero + support. Dark-obsidian kept as alternate. Store-thumbnail check done 2026-07-20: at
  256 px the support line was marginal, so the EN tag/support were enlarged to 31/23 px and the
  zh support to 23 px; both lines now survive search-result scale.
- **Microsoft Store super-hero** locked 2026-07-20 (V2): focal mark centered (650,230 on the
  1920×1080 grid), three session mini-marks converging by position; `3840×2160` master.
- **Motion ident** locked: **"the chase"** — 360° spin over 700 ms, cubic ease-in-out, constant
  colors, seamless loop; reduced-motion = 300 ms fade-in. `motion-spin.gif` + SMIL preview +
  8-frame storyboard.
- **Simplified Chinese copy layer** locked 2026-07-20: hero `代码随处。同步无界。` (accent on
  `同步无界。`), support `智能体照常运转，你持续前行。`; rendered for the social banner and both
  Play graphics (`*-zh-*` in `../marketing/`). Wordmark stays Latin in all locales.

## Promotion (2026-07-20)

- `assets/brand/source/` holds the masters: R4 mark (mono obsidian/reverse/teal/deep-teal,
  two-tone A/C/C⁻¹), M1 + M3 micro-marks, the wordmark as outlined Inter Medium paths (−1%
  tracking, W3 `sync` split, mono + reverse), and all four lockups. Icon layers (app-icon tile,
  Android adaptive fg/bg/monochrome, notification, favicon, maskable, PWA monochrome, 16 px
  pixel-hinted favicon) live under `source/cosyncing-icon-layers/`.
- Every master is generated deterministically; the wordmark is outlined from Inter Medium
  rather than set as live text.
- `assets/brand/exports/` carries the matching platform set (Apple 1024, Play 512, Android
  adaptive four densities + monochrome + notification set, web favicon ICO/SVG + touch 180 +
  PWA any/maskable/monochrome, Windows `.ico` 16–256), rasterized with cairosvg.
- Not wired yet: platform build trees (`android/app/`, `ios/`, `web/`, `windows/`) still carry
  scaffold icons; swapping them in is a separate, app-visible change.

## Not yet done

- Wiring the exported icons into the platform build trees (`android/app/` mipmaps + adaptive
  XML, `ios/` asset catalog, `web/` favicon/manifest/icons, `windows/` `.ico`, launch screens).
  **Handed over 2026-07-20** to this repository (`apps/client/`) — see
  [`../HANDOVER.md`](../HANDOVER.md).
- Website/README hero (Prompt 7) and store screenshot campaign (Prompt 12): real-app captures
  are owned by this repository (consolidated 2026-07-19).
- Spot illustrations (Prompt 6): completed as review assets, **parked** by the reviewer — no
  integration scheduled.
- Final-publication step: the masters, locked marketing art, and brand docs were copied into
  `apps/client/assets/brand/` here on 2026-07-20 with a HANDOVER.md for the agent doing
  platform wiring. Any future brand change must re-sync that copy.

## Where the evidence lives

Approved review copies, working boards (variant validation, color, icon, wordmark, lockups,
micro pixel-check) with their rejected candidates, the archived exploration rounds, the
marketing workshop sources and the parked spot illustrations all stayed in the working
repository; none of them are needed to rebuild what is here. The carried-over tree is
[`../source/`](../source) (masters), [`../exports/`](../exports) (platform rasters) and
[`../marketing/`](../marketing) (locked marketing art).
