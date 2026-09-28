# `lib/src/design/` — the design system

The single source of visual truth for the app. Feature code never hard-codes a
color, radius, or hue — it asks for a **semantic role** and the active theme
resolves it. Re-skinning the whole app is a one-line theme switch; no feature
edits required. This isolation is deliberate: themes are pluggable modules that
must not leak into (or depend on) feature code.

## Layout

```
lib/src/design/
├── app_tokens.dart        # AppTokens: the semantic token contract (ThemeExtension)
├── theme_spec.dart        # ThemeSpec: one theme = id + name + light/dark tokens
├── app_theme.dart         # buildAppTheme(tokens, brightness, {density}) -> ThemeData
├── ui_scale.dart          # UiTextScale / UiDensity tokens + UiScaleSettings (Appearance)
├── window_size_class.dart # Compact/Medium/Expanded from logical width (layout policy)
├── components.dart        # widget-kit barrel — import this to get the components below
├── components/            # shared token-consuming widgets (the widget kit)
│   ├── status_dot.dart    # StatusDot: colored dot, optional attention ring
│   ├── status_pill.dart   # StatusPill: color-coded status badge (label + semantic color)
│   ├── stroke_icon.dart   # StrokeIcon: the workspace's line-icon family (StrokeGlyph)
│   ├── metadata_chip.dart # MetadataChip: neutral surface-2 chip for quiet metadata
│   ├── section_header.dart# SectionHeader: accent-tinted section title
│   ├── copyable_code_line.dart # selectable, exact-copy command or path
│   ├── command_output_block.dart # bounded monospace command output + dropped-bytes marker
│   ├── selectable_tap_region.dart # selectable text in an activating row
│   └── transcript_box.dart # compact tinted shell for boxed transcript content
├── themes/                # one isolated module per theme
│   ├── <slug>_theme.dart  # reviewed public ThemeSpec source
│   └── theme_registry.dart# kAppThemes, kDefaultThemeId, themeSpecById()
└── README.md              # this file
```

The eight theme modules and `theme_registry.dart` are reviewed public source.
Their predecessor design explorations were intentionally excluded from the
open-source tree. Change token values and registry entries together, then run
formatting, analysis, and theme tests.

## Consuming tokens in a widget

```dart
final t = context.tokens;            // AppTokens for the active theme + brightness
Container(color: t.surface, ...);
Text('Working', style: TextStyle(color: t.statusWorking));
Icon(Icons.circle, color: t.toolColor(session.tool)); // per-tool identity color
```

`context.tokens` (see `app_tokens.dart`) reads the `AppTokens` theme extension
that `buildAppTheme` attaches, so it is non-null anywhere under the app's
`MaterialApp`. Because the lookup is non-null (fail-fast, so a mis-built theme
is caught loudly), a **widget test** that renders a token-consuming surface must
attach the extension to its theme:

```dart
theme: ThemeData(extensions: [themeSpecById(kDefaultThemeId).light]),
```

## The component kit (`components.dart`)

Feature code should not re-roll status chips, dots, or section titles — those
patterns diverged (different padding/radius/alpha) and hard-coded `Colors.*`
that froze in dark mode. Import `components.dart` and use the shared widgets:

```dart
import 'package:cosyncing_client/src/design/components.dart';

StatusDot(
  color: t.toolColor(tool),
  ringColor: needsInput ? t.statusNeedsInput : null,
  ringGapColor: needsInput ? t.surface : null,
);
StatusPill(label: 'Connected', color: t.statusWorking);   // severity via a token
StatusPill(label: 'Working', color: t.statusWorking, dense: true); // roster row
StrokeIcon(StrokeGlyph.folder);                           // line icon, 18dp
MetadataChip(label: model, maxWidth: 160);                // quiet neutral chip
SectionHeader('Appearance');                              // accent-tinted title
CopyableCodeLine(                                        // literal command/path
  text: 'cosy pair',
  copyTooltip: l10n.copyCommand,
  copiedMessage: l10n.copyCommandCopied,
);
```

The kit widgets read `AppTokens` for shape (radius, surfaces) but take a
**resolved semantic color** for status — the caller maps its own enum
(`SessionStatus`, connection state, schedule state, …) to a token
(`statusWorking` / `statusNeedsInput` / `statusError` / `statusIdle` / `accent`).
That keeps the design layer free of feature types while every surface reskins
with the theme and reads correctly in dark mode.

Status is shown statically. Do not add a perpetual animation (a pulsing dot, a
looping shimmer) to anything that can be on screen for long: on the web
renderer every animation frame repaints and presents on the main thread, and a
few of them made the whole workspace lag. `StatusDot.pulse` remains for a
short-lived surface only; the roster, tabs, and detail chrome never use it.

Navigation, roster, and tab chrome use `StrokeIcon` rather than Material's
filled glyphs, so every icon on those surfaces reads as one set. On the web it
draws each glyph, color, size and pixel ratio from a cached raster: the web
renderer has no raster cache and would otherwise re-stroke every icon on every
frame. Draw new line icons through it rather than a bare `CustomPaint`.

The sidebar paints the `sidebar` token (the theme's `surface`, unless that
equals `canvas`), and its hover and selected fills use `surfaceHover`, one step
darker.

## Adding a token

1. Add the field to `AppTokens` (constructor, field, `copyWith`, `lerp`).
2. Add the token to each public theme module.
3. Map it into `ColorScheme` in `app_theme.dart` if Material widgets need it.

## Adding a theme

Add a public theme module and register it in `theme_registry.dart`. It then
appears in the Settings → Appearance picker. All eight current themes are
user-selectable and persisted (see
`features/settings/controller/theme_controller.dart`).

## Public source of truth

The Dart modules are the source of truth shipped to contributors. This keeps
the build reproducible without depending on internal design notes.

The default Quiet Workspace palette uses neutral light/dark surfaces. Existing
selected palettes remain available. Lato is bundled for consistent typography
on native and web clients; its license ships in `assets/fonts/OFL.txt`.
