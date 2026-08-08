# Brand and Marketing Generation Prompt Pack

- **Status:** concept exploration completed off-model (hand-authored SVG); a direction is selected
  in review — see [`19-brand-symbol-decision-record.md`](19-brand-symbol-decision-record.md).
  Prompts 0–5 were superseded by that SVG pipeline; 8/9/10/11 ran deterministically (social
  banner + Play graphics locked, MS super-hero in review, motion ident locked as "the chase");
  Prompt 6 illustrations are parked; Prompts 7/12 (hero, screenshot campaign) are owned by the
  other repo. This file remains the constraint reference for those assets.
- **Last updated:** 2026-07-18.
- **Governing brief:**
  [`14-brand-identity-and-release-visuals.md`](14-brand-identity-and-release-visuals.md).

This is the copy-paste file for Gemini, GPT Image, or another capable design model. It does **not**
contain a prompt to fabricate app screenshots. Capture screenshots from the real app using the
governing brief; use Prompt 12 only to critique or arrange those locked captures.

## Run Order

| Step | Prompt | Suggested tool | Keep as final? |
|---|---|---|---|
| 0 | Creative-direction review | Gemini/reasoning model | Decision notes only |
| 1 | Symbol exploration | Image model | No; concept reference |
| 2 | Selected-symbol refinement | Image model | No; trace as SVG |
| 3 | Wordmark and lockups | Gemini/image model | No; typeset and kern manually |
| 4 | App-icon appearance system | Image model | No; rebuild as layers |
| 5 | Micro-mark | Image model plus manual pixel review | No; trace and hand-tune |
| 6 | Spot-illustration family | Image model | Selected raster/vectorized output |
| 7 | Website/README hero | Image model with real screenshot references | Background/composition only if UI drifts |
| 8 | Social preview background | Image model | Yes after deterministic logo/copy overlay |
| 9 | Google Play feature background | Image model | Yes after deterministic logo/copy overlay |
| 10 | Microsoft Store hero | Image model | Yes after review |
| 11 | Motion storyboard | Image/reasoning model | No; implement in Rive/Lottie/Flutter |
| 12 | Real-screenshot campaign direction | Gemini/reasoning model | Layout plan; final assembled manually |

Generate one asset or one family per call. Do not ask for unrelated deliverables in the same image.
For revisions, make one targeted change and repeat every invariant that must remain fixed.

## Shared Brand Context

Prepend this block to Prompts 0–12:

```text
Brand: cosyncing — exact spelling c-o-s-y-n-c-i-n-g; use lowercase only in the wordmark.

Product: a local-first, self-hosted, vendor-neutral interface for viewing and steering existing CLI coding-agent sessions from phone, tablet, desktop, and browser through the user's own network. Current registered agents are OpenCode, Pi, Codex, and Claude Code.

Core idea: two independently operating surfaces come into alignment around one shared channel. The client is a calm window onto an agent; the broker is the brain behind it.

Audience: developers.

Personality: calm, precise, trustworthy, quietly technical, compact, mature, and human. Not consumer-flashy, corporate-cloudy, gamer-like, or sci-fi theatrical.

Brand palette: obsidian #0B0E14, deep teal #0F766E, bright teal #2DD4BF, off-white #F2F5F4. Status colors are separate and must not become part of the logo.

Avoid: Flutter's logo or blue palette; robot heads; brains; clouds; Wi-Fi symbols; chain links; infinity symbols; circular sync arrows; arrowheads; terminal prompts; literal </> code symbols; vendor logos; sparkles; purple-blue gradients; glossy 3D; glass effects; tiny details; fake UI; watermarks.
```

## Prompt 0 — Creative-Direction Review

Run this in Gemini or another reasoning/design model before generating marks.

```text
Act as a senior identity designer reviewing a cross-platform developer-product brief.

Develop three distinct symbol territories for cosyncing:

A. Paired aperture — two independent geometric planes align around one narrow shared negative-space channel; bilateral but not perfectly mirrored; no arrows.
B. Synchronized phases — two offset signal bands settle into one shared rhythm; compact and calm; no waveform, radio, or circular-sync cliché.
C. Shared window — two overlapping planes form one clear central aperture; negative space may subtly suggest a lowercase c without becoming a literal lettermark.

For each territory, return:
- the central visual idea in one sentence;
- what the silhouette should look like at 16 px;
- likely confusion or similarity risks;
- how it adapts to an app icon, notification icon, and monochrome favicon;
- a specific recommendation: pursue, revise, or reject.

Then rank the three territories against distinctiveness, small-size survival, product fit, cross-platform adaptability, and distance from common AI/cloud/sync clichés.

Do not draw a final logo and do not propose extra brand names, slogans, mascots, or colors.
```

## Prompt 1 — Symbol Exploration

Run this separately for directions A, B, and C by replacing `[DIRECTION]`.

```text
Use case: logo-brand
Asset type: symbol-mark exploration

Primary request: create four distinct variations of this direction:
[DIRECTION]

Style/medium: flat black-and-white vector-style logo exploration; geometric but not sterile; strong negative space; precise optical balance.

Composition/framing: four isolated marks of equal visual size on an off-white background with generous separation; no presentation mockups.

Small-size requirement: every concept must remain recognizable as a one-color silhouette at 16×16 px and must not depend on a tiny central dot or thin gap.

Constraints: symbol only; no letters, wordmark, captions, labels, gradients, shadows, bevels, 3D, rounded-square app-icon container, or watermark.
```

Direction replacements:

```text
A — Paired aperture: two separate geometric planes align around a narrow shared negative-space channel; bilateral but not perfectly mirrored; no arrowheads.
```

```text
B — Synchronized phases: two offset signal bands settle into one shared rhythm; compact and calm; no waveform, radio, or circular-sync cliché.
```

```text
C — Shared window: two overlapping planes create one clear central aperture; the negative space may subtly suggest a lowercase c, but must not become a literal lettermark.
```

## Prompt 2 — Refine the Selected Symbol

Attach the selected mark as Image 1.

```text
Use case: logo-brand
Asset type: production mark refinement
Input images: Image 1 is the selected cosyncing symbol and is the only design to refine.

Primary request: preserve the symbol's topology and identity while simplifying its geometry, strengthening weak gaps, balancing the negative space, and making its silhouette work at very small sizes.

Show the same mark in:
- black on white;
- white on black;
- bright teal on obsidian;
- one-color previews at 64, 32, 24, and 16 px.

Composition/framing: a clean validation board, not a marketing mockup.

Constraints: change only proportion, spacing, shape weight, and optical balance. Do not add elements, letters, circles, arrows, shadows, gradients, text, or an app-icon container.
```

Trace the winner as SVG. Do not treat the generated sheet as a vector master.

## Prompt 3 — Wordmark and Lockups

Attach the approved symbol as Image 1.

```text
Use case: logo-brand
Asset type: wordmark and logo lockup exploration
Input images: Image 1 is the approved cosyncing symbol; preserve it exactly.

Primary request: design a lowercase wordmark using the exact text "cosyncing". Spell it exactly c-o-s-y-n-c-i-n-g.

Typography: calm contemporary grotesk or humanist sans; open counters; compact but readable; careful rhythm around "sync"; no futuristic extended lettering and no novelty coding font.

Create:
1. wordmark only;
2. horizontal mark-left lockup;
3. compact stacked lockup;
4. monochrome reverse lockup.

Color palette: black/white first, then deep teal and obsidian.

Constraints: render no words other than "cosyncing"; do not alter the symbol; no slogan, mockup, gradients, 3D, shadows, or watermark.
```

Models can misspell or distort type. Rebuild and kern the final wordmark manually.

## Prompt 4 — App-Icon Appearance System

Attach the approved symbol as Image 1.

```text
Use case: logo-brand
Asset type: cross-platform app-icon appearance exploration
Input images: Image 1 is the approved symbol; preserve its defining geometry.

Primary request: adapt the mark into a compact app-icon system with one unmistakable silhouette.

Create concept treatments for:
- default full-color;
- dark;
- light monochrome;
- dark monochrome;
- system-tinted light;
- system-tinted dark.

Style/medium: flat layered artwork; full-bleed opaque background; bright-teal mark on obsidian as the primary treatment. Every appearance must remain recognizably the same icon.

Composition/framing: centered symbol with enough breathing room for platform masking.

Constraints: no text, letter monogram, UI screenshot, pre-rounded corners, external drop shadow, bevel, highlight, glow, device frame, or platform logo.
```

Rebuild the result as separate vector layers and apply the exact Apple, Android, Windows, and web
exports in the governing brief.

## Prompt 5 — Micro-Mark

Attach the approved symbol as Image 1.

```text
Use case: logo-brand
Asset type: small-size monochrome icon family
Input images: Image 1 is the approved cosyncing symbol.

Primary request: derive a micro-mark from the approved symbol for extremely small system surfaces. Preserve its identity while reducing internal edges and widening fragile negative-space gaps.

Show:
- solid black on white;
- solid white on black;
- pixel previews at 48, 32, 24, 20, and 16 px.

The 16 px version must read as one intentional silhouette, not disconnected fragments.

Constraints: one color only; no text, outline container, circle, rounded square, shadow, gray antialiasing simulation, gradients, or new symbolism.
```

Use the traced micro-mark for Android notifications, the smallest favicon layers, Safari pinned
tabs, optional PWA monochrome icons, and later tray/menu-bar surfaces.

## Prompt 6 — Spot-Illustration Family

Generate the first scene, then attach it as Image 2 for every following scene to preserve style.

```text
Use case: illustration-story
Asset type: small in-product spot illustration
Input images: Image 1 is the approved cosyncing mark; Image 2, when supplied, is the previous illustration and style anchor.

Primary request: [SCENE]

Style/medium: minimal geometric editorial illustration; quiet developer-tool aesthetic; mostly flat shapes with subtle tonal depth; no characters or mascots.

Composition/framing: 4:3 canvas, subject inside the central 70%, generous whitespace, readable when displayed around 240×180 logical pixels.

Color palette: obsidian, deep teal, bright teal, off-white, and restrained neutral gray.

Constraints: no words, code, fake UI, vendor logos, robot, cloud, Wi-Fi, padlock cliché, gradients, watermark, or cast shadow. Use a perfectly flat #FF00FF background if native transparency is unavailable; no #FF00FF inside the subject.
```

Scene replacements:

```text
Connect to your broker: two devices and one self-hosted machine align around a private shared channel.
```

```text
Pair securely: a phone scans a neutral QR-like tile and establishes a direct trusted connection. Do not generate a functional QR code.
```

```text
No sessions yet: an open viewing aperture is ready, but no active work has entered it.
```

```text
All caught up: several previously active signals have settled into a quiet aligned state.
```

```text
No transfers: two endpoints are ready for bidirectional files, with the channel currently empty.
```

```text
Select a session: several slim session planes sit beside one larger empty detail pane.
```

## Prompt 7 — Website and README Hero

Attach the approved mark and real screenshots. The screenshots are references to preserve, not targets
to redraw.

```text
Use case: compositing
Asset type: website and repository hero artwork
Input images:
- Image 1: approved cosyncing mark;
- Image 2: real desktop app screenshot;
- Image 3: real phone app screenshot.

Primary request: create a refined hero composition showing the real cosyncing interface across desktop and phone, linked by one subtle private synchronization channel.

Composition/framing: 3840×2160 landscape. Place the product composition in the right 55–60% and retain calm negative space on the left for manually added copy.

Style/medium: premium developer-product editorial art; understated, precise, mostly flat; abstract self-hosted-machine context rather than a public cloud.

Constraints: preserve every UI pixel and all screenshot text exactly; do not redraw, restyle, or hallucinate the app. No Apple-specific hardware, logos, fake terminal text, extra devices, wordmark, tagline, watermark, or exaggerated neon effects.
```

If the model changes any UI, keep only its background/composition and place the real screenshots in a
deterministic design tool.

## Prompt 8 — Social/Open Graph Background

```text
Use case: ads-marketing
Asset type: social-link preview background

Primary request: create an abstract cosyncing brand composition based on two planes aligning around a shared channel.

Composition/framing: 2400×1260, designed to crop cleanly to 1200×630 and 1280×640. Use one clear focal form slightly right of center and keep the central-left region calm for a manually placed logo and headline.

Style/medium: flat geometric editorial artwork; quiet depth; obsidian, teal, off-white, and muted graphite.

Constraints: no text, logo, app UI, devices, arrows, cloud, robot, terminal, gradients, watermark, or tiny details.
```

Add the reviewed SVG wordmark and editable copy manually. Approved tagline system (2026-07-19,
supersedes the 2026-07-18 single line):

```text
Code anywhere. Sync everywhere.
Your agents keep working. You keep moving.
```

- Hero: `Code anywhere. Sync everywhere.` — the only line on the tightest surfaces (store
  headers). The Play feature graphic also carries the support line (added 2026-07-19).
- Support: `Your agents keep working. You keep moving.` — stacked under the hero where space
  allows (social banner, hero art, landing).
- Merged one-liner for short descriptions: `Code anywhere, sync everywhere — your agents keep
  working, you keep moving.`
- The hero's `Sync` may take the wordmark's W3 accent (deep teal on light, bright teal on dark);
  optional, decide per surface.

Simplified Chinese copy layer (locked 2026-07-20, `output/brand/final/marketing/*-zh-*`):

```text
代码随处。同步无界。
智能体照常运转，你持续前行。
```

- Hero: `代码随处。同步无界。` — accent on `同步无界。` (mirrors the English `Sync` accent).
- Support: `智能体照常运转，你持续前行。`
- Wordmark stays Latin `cosyncing` in all locales; CJK renders in the platform sans fallback
  (Droid Sans Fallback on Linux; PingFang SC / Microsoft YaHei / Noto Sans CJK elsewhere).

## Prompt 9 — Google Play Feature-Graphic Background

```text
Use case: ads-marketing
Asset type: Google Play feature-graphic background

Primary request: create distinctive cosyncing brand key art using the paired-aperture idea: two calm geometric surfaces aligning around one private shared channel.

Composition/framing: exactly 1024×500. Keep the main focal form near the center; edges must remain expendable for cropping. Reserve a clean central area for a manually placed wordmark and one short tagline.

Style/medium: opaque RGB artwork; teal, off-white, and softened graphite. Do not make pure black or near-black dominate the whole canvas.

Constraints: no text, app icon, app UI, device mockup, store badge, ranking, award, testimonial, price, promotion, call to action, vendor logo, cloud, robot, transparency, or watermark.
```

Add the exact wordmark and localized tagline manually after generation.

## Prompt 10 — Microsoft Store Super-Hero Art

```text
Use case: ads-marketing
Asset type: Microsoft Store super-hero artwork

Primary request: create a wide abstract scene expressing several coding-agent sessions converging through one self-hosted cosyncing channel.

Composition/framing: 3840×2160. Use one strong focal area near the center; keep defining content in the upper two-thirds; the bottom third and extreme edges must remain safe to crop or cover.

Style/medium: opaque mature geometric editorial art; layered planes, restrained depth, calm teal and graphite palette.

Constraints: no product title, wordmark, tagline, UI screenshot, computer, phone, device silhouette, robot, cloud, arrows, terminal text, vendor marks, stock-photo aesthetic, transparency, watermark, or excessive empty space.
```

## Prompt 11 — Motion-Ident Storyboard

Attach the approved mark as Image 1.

```text
Use case: stylized-concept
Asset type: logo-motion storyboard
Input images: Image 1 is the approved cosyncing mark.

Primary request: storyboard an understated 900 ms logo animation.

Motion:
1. the two parts begin slightly out of alignment;
2. they move into alignment using one calm ease-out;
3. a restrained teal signal passes once through the shared channel;
4. the mark settles completely still.

Composition/framing: eight equally spaced frames on a neutral storyboard sheet.

Constraints: preserve the final mark exactly; no rotation, bouncing, elastic overshoot, particles, glow, text, loading spinner, infinite loop, or extra elements. Include a reduced-motion version that simply fades in the completed mark.
```

Implement the motion in Rive, Lottie, SVG, or Flutter rather than shipping generated frames.

## Prompt 12 — Real-Screenshot Campaign Direction

This is a layout-review prompt for Gemini, not permission to generate UI. Attach six real captures in
the order defined by the governing brief.

```text
Act as a senior app-store art director.

Input images: Images 1–6 are real cosyncing screenshots. Treat every screenshot as locked artwork. You may crop or scale a screenshot as one intact rectangle, but you may not redraw, retouch, replace, relabel, or invent any UI pixel.

Design a coherent six-frame campaign around these exact headlines:
1. "Every session, one calm view."
2. "See what needs your attention."
3. "Read, steer, and approve."
4. "Move files. Inspect artifacts."
5. "Pair with your own broker."
6. "One workspace, every screen."

Visual system: bright off-white or quiet obsidian backgrounds, restrained teal accents, large concise sans-serif headlines, consistent alignment, generous whitespace. The real app must dominate each frame. Do not use a decorative device bezel.

Return:
- one shared grid and type system;
- crop/scale/position instructions for each screenshot;
- safe areas for Apple iPhone, iPad, and Google phone exports;
- an English copy layer and a separate Simplified Chinese copy layer;
- a list of any screenshot whose real UI is too dense or unclear and should be recaptured.

Constraints: no generated screenshots; no UI edits; no unsupported features or agents; no real credentials, personal paths, ranking claims, calls to action, store badges, testimonials, or watermarks.
```

Microsoft Store screenshots should skip this marketing layout and remain real unadorned captures.

## Targeted Revision Prompts

Use these after selecting a direction instead of rewriting the full prompt.

### Simplify without redesigning

```text
Change only the selected mark's small-size geometry: widen the narrowest negative-space gap and remove one nonessential internal edge. Preserve the silhouette, topology, proportions, palette, and all other elements exactly. Add nothing.
```

### Correct composition without changing style

```text
Change only the composition: increase the usable negative space for copy to 42% of the canvas. Preserve the subject, visual style, colors, lighting, texture, screenshot pixels, and all other elements exactly. Add no text.
```

### Remove generated UI drift

```text
Replace the altered interface with Image 2 exactly as supplied. Preserve every pixel, word, control, color, crop, and aspect ratio from Image 2. Change only the surrounding background and composition; do not redraw the interface.
```

## Handoff Checklist

Before an output becomes a project asset:

- record the final prompt and input-image roles;
- keep the selected concept separate from discarded variants;
- rebuild logos, wordmarks, app icons, and micro-icons as deterministic vector sources;
- verify exact spelling outside the image model;
- compare 16/20/24/32/48 px renders on light and dark backgrounds;
- remove chroma-key backgrounds and inspect every alpha edge if transparency was requested;
- assemble real screenshots and editable text in a deterministic design tool;
- export against the platform matrix in the governing brief;
- save generated intermediates under `output/brand/`, not beside raw product source.
