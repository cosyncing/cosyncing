# Agent brand assets

Small local marks identifying coding-tool rows on the cosyncing client's usage
surfaces (report page, share cards). Bundled with the app so it makes no
runtime requests to brand websites. Provenance is shared with Tokdash, whose
icon set these are taken from (`src/tokdash/static/icons/agents/` in the
Tokdash source tree). Of the 26 bundled marks, 14 are byte-identical copies,
2 are copies of Tokdash's normalized transparent derivatives, and 10 are
rasterized from SVG sources at 64x64.

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
