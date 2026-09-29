# Agent brand assets

Small local marks identifying coding-tool rows on the cosyncing client's usage
surfaces (report page, share cards). Bundled with the app so it makes no
runtime requests to brand websites. Provenance is shared with Tokdash, whose
icon set these are taken from (`src/tokdash/static/icons/agents/` in the
Tokdash source tree). Of the original 26 marks, 14 are byte-identical copies,
2 are copies of Tokdash's normalized transparent derivatives, and 10 are
rasterized from SVG sources at 64x64. Additional identities are listed below.

- Byte-identical PNG copies: Antigravity, Cline, Crush, Hermes, Kilocode,
  Kimi, OMP, OpenClaw, OpenCode, Pi, Qoder, Qoder CLI, WorkBuddy, and ZCode
  (ZCode's mark is the official app icon). `qoder_cli.png` is a byte-identical
  duplicate of `qoder.png` — the same mark served under a second tool id, not
  a distinct mark. The WorkBuddy and Qoder marks are resized copies of the
  official icons installed with their Windows apps. Crush is a 32x32
  downscale of the official icon (`crush-icon-solo.png`) from the
  [Crush repository](https://github.com/charmbracelet/crush).
- Copies of Tokdash's transparent derivatives: Codex and Grok. Both files are
  byte-identical to Tokdash's locally normalized transparent variants
  (`codex-transparent.png`, `grok-transparent.png`), shipped here under the
  plain names `codex.png` and `grok.png`; they are not copies of the brand
  PNGs.
- Rasterized from SVG sources at 64x64: Amp
  ([amp-mark-color.svg](https://ampcode.com/amp-mark-color.svg)), Claude,
  GitHub Copilot (`copilot.svg`), Cursor (cube,
  [Cursor brand assets](https://cursor.com/brand); Cursor is registered for
  future compatibility, not a current data source), DeepSeek (brand blue
  `#4D6BFE`, which reads on both themes and is therefore excluded from the
  client's dark-mode inversion set), Gemini (`gemini.svg`), MiMo, Qwen Code
  (Qwen hexagon logo, Qwen purple `#6D44E8`), Reasonix, and Zed (official
  logo from the [Zed repository](https://github.com/zed-industries/zed),
  black fill). Tokdash ships only SVG for these marks, so no PNG exists to
  copy; these PNGs are derivatives, not byte-identical copies of their
  sources. Regenerate them from the source SVGs rather than editing them.

All marks remain the property of their respective owners.

## Additional quota and usage identities

- `commandcode.png` is the [official Command Code application icon](https://commandcode.ai/favicon/2024/android-chrome-512x512.png),
  used to identify its quota provider.
- `minimax.png` is copied unmodified from Tokdash revision
  `d7a77322b70d034df6910ba826d1ac9ff9f2e247`, under
  `src/tokdash/static/icons/agents/`, for the MiniMax Code usage source.
- `zai.svg` is the original mark linked by [Z.ai](https://z.ai/), from
  <https://z-cdn.chatglm.cn/z-ai/static/logo.svg>. `zai.png` is a 128×128 raster
  rendering made with `convert -background none zai.svg -resize 128x128 zai.png`.
  It identifies a quota provider, separate from the ZCode usage source.
- OpenCode Go quota reuses the OpenCode mark. Muse Code and Devin CLI retain
  neutral initial fallbacks because the upstream usage catalog has no artwork.

Brand marks do not imply a configured provider or a supported session adapter.
