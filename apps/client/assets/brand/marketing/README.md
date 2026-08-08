# Marketing masters — destinations

Locked art from the 2026-07-19/20 review (see `../reference/19-brand-symbol-decision-record.md`).
These files are reused, not regenerated: the `.html` sources beside each raster are the
deterministic composition inputs, and re-rendering them is only correct when a source decision
changes.

Each entry below names a destination that **already exists** in this repository or in a console we
already publish to. Nothing here assumes a marketing website; there isn't one, and B2 did not
invent one.

| Asset | Size | Destination | Status |
|---|---|---|---|
| `social-banner-1280x640.png` | 1280×640 | Repository README hero (`README.md`) | wired |
| `social-banner-1280x640.png` | 1280×640 | GitHub repository social preview (Settings → General → Social preview) | manual, console step |
| `social-banner-1200x630.png` | 1200×630 | Open Graph / link preview, if an `og:image` host is ever added | held |
| `social-banner-2400x1260.png` | 2400×1260 | Master for the two crops above | source |
| `social-banner-zh-*.png` | as above | Simplified Chinese layer of the same three | held |
| `social-banner-light-*.png`, `social-banner-light-zh-*.png` | as above | Light-scheme layer (EN + zh) for `<picture>` swaps | held |
| `social-banner-white-*.png` | as above | Pure-white layer (EN) — blends into GitHub's light theme; README hero default | wired |
| `frames/` | — | Static SVG frames for the motion storyboard and `motion-preview.svg`; composition inputs, not ship assets | source |
| `play-feature-1024x500.png` | 1024×500 | Google Play feature graphic (light) | manual, console step |
| `play-feature-dark-teal-1024x500.png` | 1024×500 | Google Play feature graphic (dark-teal alternate) | manual, console step |
| `play-feature-*-zh-*.png` | 1024×500 | Simplified Chinese Play feature graphic | manual, console step |
| `ms-store-hero-3840x2160.png` | 3840×2160 | Microsoft Store super-hero art | manual, console step |
| `motion-spin.gif`, `motion-preview.svg`, `motion-storyboard.png` | — | Motion ident reference; implement in Rive/Lottie/Flutter rather than shipping frames | reference |

## Why the README hero is this file and not new art

Doc 15's Prompt 7 describes a composited hero built around real screenshots. That composition is
not needed here: the repository's first impression is a README, the locked banner already carries
the approved lockup and both tagline lines, and it is already a reviewed, hash-baselined tracked
binary. Reusing it added **no** new binary to the public tree — see
`../store/README.md` for the same discipline applied to copy.

The banner is obsidian-grounded and self-contained, so it reads correctly against both GitHub light
and dark themes without a `<picture>` swap.

## Screenshots are not here

Store screenshots are captures of the real app, not brand masters. `bash
scripts/dev/run-store-capture.sh` produces them into `output/brand/store/`, a generated tree the
public-tree gate refuses to track. Regenerate them; do not commit them. See
[`../store/README.md`](../store/README.md) for the layout.

The Apple and Google frames are composed here in the same spirit as the masters above — obsidian
ground, the teal plane, the lockup, Inter with the Droid Sans Fallback CJK layer — but they are
**not** masters. Their content is a screenshot, so they are regenerated whenever the product UI
changes, and they are never hand-edited into this directory.
