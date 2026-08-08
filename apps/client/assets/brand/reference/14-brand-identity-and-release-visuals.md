# Brand Identity and Release Visuals

- **Status:** governing visual-asset brief; planning only.
- **Last updated:** 2026-07-18.
- **Prompt pack:**
  [`15-brand-and-marketing-generation-prompts.md`](15-brand-and-marketing-generation-prompts.md).

## Decisions

1. **One product identity.** The broker, Flutter clients, served web app, documentation, and release
   listings use one `cosyncing` mark. `cosyncing broker` is a descriptor, not a second logo.
2. **Real screenshots only.** Store, web, and documentation screenshots come from the real app with
   fictitious data. Generative models may propose art direction or backgrounds but must not redraw,
   invent, or modify the UI.
3. **Generation is exploratory.** Generated logo, icon, and wordmark images are references. Final
   marks, lockups, small icons, and platform layers are rebuilt as deterministic vector assets.
4. **Brand is independent of the selected skin.** The seven app themes remain user preferences. The
   product mark keeps one stable identity, with only approved full-color, reverse, monochrome, and
   system-tinted variants.
5. **No agent branding in the product mark.** OpenCode, Pi, Codex, and Claude Code are supported
   tools, not ingredients of the cosyncing logo. Tool identity remains the existing neutral color-dot
   treatment in product UI.
6. **Native launch surfaces are not advertisements.** Apple launch UI mirrors the first app surface;
   Android 12+ uses the system splash contract. Neither receives a generated full-screen splash image.

## Current Baseline

| Surface | Current state | Required correction |
|---|---|---|
| iOS/iPadOS app icon | Flutter scaffold artwork | Replace with the layered cosyncing icon family |
| Android launcher | Legacy Flutter mipmaps only | Add adaptive foreground/background and monochrome layers |
| Android notifications | Uses `ic_launcher` | Add a dedicated one-color notification silhouette |
| macOS app icon | Flutter scaffold artwork | Replace through the Apple icon workflow |
| Windows app icon | Flutter scaffold `.ico` | Replace with a hand-tuned multi-resolution `.ico` |
| Linux desktop identity | No product icon asset is wired | Add the selected SVG/PNG exports when packaging is defined |
| Web/PWA | Flutter favicon/icons; Flutter-blue manifest colors | Replace favicon, touch, `any`, `maskable`, and optional monochrome assets |
| Broker proof UI | No favicon or manifest in `packages/app/public/` | Reuse the product favicon; do not create a broker-only mark |
| Launch UI | Blank/default Android and iOS scaffold treatment | Implement responsive native launch colors/composition |
| Brand masters | ~~No SVG mark, wordmark, or lockup~~ **Done 2026-07-20** | ~~Create reviewed source masters and an export pipeline~~ Masters in `assets/brand/source/`, exports in `assets/brand/exports/`; platform wiring remains |
| Store/marketing | No governed release-art set | Capture real UI and create only the required surrounding artwork |

The default Teal Obsidian skin provides useful heritage colors (`#0F766E` light accent,
`#2DD4BF` dark accent), but it does not by itself define the product identity.

## Identity Architecture

Recommended public hierarchy:

- **Product name:** `cosyncing`
- **App display name:** `Cosyncing`
- **Primary wordmark:** lowercase `cosyncing`
- **Technical descriptor:** `cosyncing broker`, assembled from the same wordmark
- **Optional family endorsement:** `A Tokdash product`, limited to About, store publisher, website
  footer, or similar secondary contexts
- **Operational ownership:** Anycode remains explanatory setup copy, not a logo lockup

The working visual hypothesis was a **paired aperture**: two independent geometric planes align
around one shared negative-space channel. The concept and small-size review ran on 2026-07-18 as
hand-authored SVG exploration (not the image-model pipeline): the paired aperture survived round 1
but the reviewer selected the **R4 squared-arcs** mark from the loop exploration instead. That
direction and its color, wordmark, lockup, and micro-mark decisions are recorded in
[`19-brand-symbol-decision-record.md`](19-brand-symbol-decision-record.md); it is selected in
review and not yet promoted to `assets/brand/source/`.

Working stable brand palette:

| Role | Color |
|---|---|
| Obsidian | `#0B0E14` |
| Deep teal | `#0F766E` |
| Bright teal | `#2DD4BF` |
| Off-white | `#F2F5F4` |

Status colors are semantic UI tokens and must not become logo colors.

## Required Deliverables

### P0 — identity and install surfaces

- one-color symbol master;
- full-color symbol master;
- lowercase wordmark;
- horizontal and stacked lockups;
- reverse and monochrome variants;
- independently simplified micro-mark for 16–32 px use;
- Apple layered icon appearances;
- Android adaptive foreground/background plus monochrome layer;
- Android notification icon;
- macOS and Windows app icons;
- web favicon, SVG favicon, Apple touch icon, PWA `any`, `maskable`, and optional `monochrome` icons;
- native Apple and Android launch composition;
- shared favicon adoption by the broker proof UI and served Flutter client.

### P1 — release and communication

- real iPhone, iPad, Android phone/tablet, macOS, Windows, and web captures where distributed;
- Apple and Google screenshot campaign layouts built from those captures;
- Google Play feature graphic;
- Microsoft Store super-hero art if used;
- website/README hero;
- Open Graph/social-link preview;
- documentation and CLI wordmark treatment.

### P2 — product polish

- connection, pairing, no-session, all-caught-up, no-transfer, and select-session spot illustrations;
- optional mark motion ident with a reduced-motion form;
- tray/menu-bar and installer artwork once those product surfaces exist.

## Source and Output Layout

Tree created 2026-07-20 (direction approved; see doc 19). The masters are machine generated
outside this repo and land here as a locked snapshot; do not hand-edit them.

```text
assets/brand/
├── source/
│   ├── cosyncing-mark.svg                  # + -reverse, -teal, -deep-teal,
│   │                                       #   -two-tone-light/-dark/-dark-teal-leads
│   ├── cosyncing-mark-micro.svg            # M1 vector, + -reverse
│   ├── cosyncing-mark-micro-pixel.svg      # M3 16x16 pixel-hinted, + -reverse
│   ├── cosyncing-wordmark.svg              # outlined Inter Medium, + -reverse, -mono, -mono-reverse
│   ├── cosyncing-lockup-horizontal.svg     # + -reverse
│   ├── cosyncing-lockup-stacked.svg        # + -reverse
│   └── cosyncing-icon-layers/              # app-icon, favicon(+16), maskable, Android
│                                           #   adaptive fg/bg + monochrome, notification, PWA mono
├── exports/                                # mechanical platform export of the masters
│   ├── apple/  google-play/  android/  web/  windows/
└── reference/
    ├── concept-review/  (see output/brand/ for the review evidence)
    └── brand-guide.md   (pending)
```

Platform build files remain in their native locations. Export them mechanically from the reviewed
masters rather than drawing each size independently. Generated review images and raw screenshots go
under `output/brand/`; they are generated evidence, not source inputs.

## Screenshot Workflow — Manual Capture Only

### Rules

- Capture the real Flutter app or the real broker-served Flutter build.
- Seed a dedicated demonstration broker/profile with fictitious users, machines, paths, messages,
  files, tokens, QR payloads, and session identifiers.
- Never capture Howard's real broker URL, pairing payload, credential, project path, notification
  content, or terminal history.
- Use released functionality only. Do not advertise terminated-app remote wake until a production
  APNs/FCM path exists.
- Hide debug banners, pointer overlays, dirty status bars, test controls, and accessibility outlines
  unless the image specifically documents them.
- Capture UI without marketing text. Add headlines, backgrounds, and annotations later in a
  deterministic design tool.
- If a generative tool is used for a surrounding background, treat the screenshot as a locked input:
  every pixel, word, status, and control must remain unchanged.
- Capture light and dark where useful; include at least one Dark Mode image in the Apple set.

### Core story sequence

| Order | Real app surface | Suggested headline |
|---|---|---|
| 1 | Populated Sessions list | Every session, one calm view. |
| 2 | Attention inbox | See what needs your attention. |
| 3 | Session detail with a permission request | Read, steer, and approve. |
| 4 | Artifact or Transfer Manager | Move files. Inspect artifacts. |
| 5 | Pairing or Connection | Pair with your own broker. |
| 6 | Expanded tablet/desktop workspace | One workspace, every screen. |

The first Apple screenshots must show the core in-app experience, not only connection, login, title,
or launch UI. Microsoft Store screenshots remain unadorned real captures because Microsoft asks not
to add extra logos or marketing messages.

### Working capture targets

| Listing/surface | Working target |
|---|---|
| Apple iPhone | `1320×2868` portrait |
| Apple iPad | `2064×2752` portrait |
| Apple Mac | `2880×1800` landscape |
| Google phone | at least four `1080×1920` portrait captures |
| Google tablet | real `1920×1080` or larger 16:9 captures |
| Microsoft desktop | `3840×2160`; keep critical UI in the upper two-thirds |
| PWA install, wide | `1920×1080` |
| PWA install, narrow | one consistent portrait ratio, both dimensions `320–3840` |

The existing `integration_test/screenshot_test.dart` is a useful deterministic base but currently
covers only the Sessions surface in light and dark. Expanding the capture harness is implementation
work separate from this visual brief.

## Platform Asset Specifications

Specifications below were checked against official platform guidance on 2026-07-18.

| Asset | Production requirement |
|---|---|
| Apple app icon | `1024×1024`, square and unmasked, layered; default/dark/clear/tinted appearances; rebuild in Icon Composer/Xcode |
| Android adaptive icon | separate `108×108 dp` foreground/background layers; defining mark inside the centered `66×66 dp` safe zone |
| Android themed icon | one-color `108×108 dp` layer using the same safe zone |
| Android notification | simple one-color alpha silhouette; generate density assets with Android Studio/Image Asset Studio |
| Google Play icon | `512×512` sRGB 32-bit PNG, no baked corner mask or outer shadow, at most `1,024 KB` |
| Google Play feature graphic | exactly `1024×500`, opaque JPEG or 24-bit PNG |
| Windows `.ico` | include at least `16`, `24`, `32`, `48`, and `256` px; hand-tune small sizes |
| Microsoft Store tile | `300×300` PNG |
| Web favicon | ICO containing `16`, `32`, and `48` px; optional SVG favicon with `sizes="any"` |
| Apple touch icon | `180×180` PNG, square source, no baked rounded corners |
| PWA `any` | `192×192` and `512×512` PNG |
| PWA `maskable` | `192×192` and `512×512`, opaque/full-bleed; essential content inside the centered 80% diameter |
| PWA `monochrome` | optional one-color alpha silhouette |
| Android splash | opaque background plus system-managed icon; no conventional full-screen generated image |
| iOS/iPadOS launch | responsive native layout matching the first screen; no advertising bitmap |

## Acceptance Checklist

- The one-color mark is distinct at 16, 20, 24, 32, 48, and 64 px.
- The mark is recognizable without color, a container, animation, or wordmark.
- The wordmark spells `cosyncing` exactly and remains readable in reverse.
- No variant contains a vendor logo, robot, cloud, Wi-Fi glyph, sync arrows, terminal prompt, or
  visual similarity to Flutter's mark.
- The icon survives Apple, Android adaptive, PWA maskable, Windows taskbar, and notification masks.
- Small platform exports are visually corrected rather than blindly downscaled.
- Opaque assets are actually opaque; alpha assets have clean antialiased edges.
- No generated UI appears in store, website, documentation, or social screenshots.
- English and Simplified Chinese marketing copy are separate editable text layers.
- Every final asset has a source master, owner, version, and documented export path.

## Explicit Non-Deliverables

- no separate broker logo;
- no per-theme app icons;
- no generated or hallucinated product screenshots;
- no agent/vendor mascot family;
- no full-screen branded Apple launch advertisement;
- no Google/Apple/Microsoft store badges generated by an image model;
- no Apple editorial promotional PSD until Apple requests it.

## Sources

- [Apple app icons](https://developer.apple.com/design/human-interface-guidelines/app-icons)
- [Apple launch experience](https://developer.apple.com/design/human-interface-guidelines/launching)
- [Apple screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications)
- [Android adaptive icons](https://developer.android.com/develop/ui/compose/system/icon_design_adaptive)
- [Android splash screens](https://developer.android.com/develop/ui/views/launch/splash-screen)
- [Google Play preview assets](https://support.google.com/googleplay/android-developer/answer/9866151)
- [Windows app-icon construction](https://learn.microsoft.com/en-us/windows/apps/design/iconography/app-icon-construction)
- [Microsoft Store screenshots and images](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/screenshots-and-images)
- [W3C Web App Manifest icon masks](https://www.w3.org/TR/appmanifest/#icon-masks)
- [MDN PWA installability](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)
