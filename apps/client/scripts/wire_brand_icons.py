#!/usr/bin/env python3
"""Wire the locked brand assets into the platform build trees.

Second half of the pipeline documented in assets/brand/HANDOVER.md: the SVG
masters under assets/brand/source/ and the platform rasters under
assets/brand/exports/ arrive as locked snapshots; this script moves that
artwork (plus the extra sizes the platform trees need) into android/, ios/,
macos/, web/ and windows/.

Everything here is mechanical:

- files that exports/ already ships at the right size are copied verbatim
  (Android adaptive layers, notification set, web favicon/PWA set, Windows
  .ico, apple-touch-icon);
- files the platform tree needs at sizes exports/ does not ship are rendered
  from the same locked SVG masters with cairosvg (deterministic, same renderer
  as the export pipeline):
  * Android legacy ic_launcher.png (pre-API-26 launchers and any context
    that ignores mipmap-anydpi-v26) at the standard 48/72/96/144/192 px,
    rendered from the full app-icon tile (obsidian tile + two-tone C^-1 at
    62% — the decision record sanctions this tile down to 16 px).
  * iOS AppIcon.appiconset and macOS AppIcon.appiconset PNGs at the exact
    pixel dimensions their Contents.json declares, from the square unmasked
    app-icon tile (Xcode applies the system masks).
- the smallest Apple slots are NOT downscaled from the full tile (doc 14:
  "small platform exports are visually corrected rather than blindly
  downscaled"):
  * macOS 16 px and 32 px slots render the locked M3 pixel-hinted mono
    micro-mark on the obsidian tile (favicon-16.svg) at 1x and 2x integer
    scale, so every edge stays on the pixel grid.
  * iOS 20 px (20x20@1x) renders the locked M1 squared micro-mark
    (cosyncing-mark-micro-reverse.svg) composed on the obsidian tile at the
    approved 62% mark fraction, rasterized at the exact target size.
- scaffold artwork that nothing references any more is deleted (web
  favicon.png + Icon-*.png, iOS LaunchImage.imageset).

XML/JSON catalog files (adaptive-icon descriptor, Contents.json, manifest)
are hand-maintained source, not generated here; test/brand/brand_assets_test.dart
validates that the catalogs and these rasters agree.

Run via scripts/wire_brand_icons.sh (uses the cairosvg venv).
"""

import shutil
from pathlib import Path

import cairosvg

ROOT = Path(__file__).resolve().parent.parent
LAYERS = ROOT / "assets" / "brand" / "source" / "cosyncing-icon-layers"
EXPORTS = ROOT / "assets" / "brand" / "exports"
RES = ROOT / "android" / "app" / "src" / "main" / "res"
WEB = ROOT / "web"
IOS_APPICON = ROOT / "ios" / "Runner" / "Assets.xcassets" / "AppIcon.appiconset"
MACOS_APPICON = ROOT / "macos" / "Runner" / "Assets.xcassets" / "AppIcon.appiconset"
WINDOWS_RESOURCES = ROOT / "windows" / "runner" / "resources"

APP_ICON = LAYERS / "app-icon.svg"
FAVICON_16 = LAYERS / "favicon-16.svg"
MICRO_REVERSE = ROOT / "assets" / "brand" / "source" / "cosyncing-mark-micro-reverse.svg"

# exports/ ships the adaptive layers in all five densities at the correct
# 108dp mapping (108/162/216/324/432 px); the wiring copies them verbatim.
ADAPTIVE_DENSITIES = ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]
LEGACY_LAUNCHER = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
NOTIFICATION_DENSITIES = ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]

# Brand palette, locked (doc 14).
OBSIDIAN = "#0B0E14"

# Locked mark fraction of the app-icon tile (decision record 19).
MARK_FRACTION = 0.62

# Apple slots that must use a visually corrected micro-mark instead of a
# downscaled full tile (see header).
IOS_MICRO_PIXELS = {"Icon-App-20x20@1x.png": 20}
MACOS_MICRO_PIXELS = {"app_icon_16.png": 16, "app_icon_32.png": 32}

IOS_ICON_PIXELS = {
    "Icon-App-20x20@1x.png": 20,
    "Icon-App-20x20@2x.png": 40,
    "Icon-App-20x20@3x.png": 60,
    "Icon-App-29x29@1x.png": 29,
    "Icon-App-29x29@2x.png": 58,
    "Icon-App-29x29@3x.png": 87,
    "Icon-App-40x40@1x.png": 40,
    "Icon-App-40x40@2x.png": 80,
    "Icon-App-40x40@3x.png": 120,
    "Icon-App-60x60@2x.png": 120,
    "Icon-App-60x60@3x.png": 180,
    "Icon-App-76x76@1x.png": 76,
    "Icon-App-76x76@2x.png": 152,
    "Icon-App-83.5x83.5@2x.png": 167,
    "Icon-App-1024x1024@1x.png": 1024,
}

MACOS_ICON_PIXELS = {
    "app_icon_16.png": 16,
    "app_icon_32.png": 32,
    "app_icon_64.png": 64,
    "app_icon_128.png": 128,
    "app_icon_256.png": 256,
    "app_icon_512.png": 512,
    "app_icon_1024.png": 1024,
}

WEB_EXPORTS = [
    "favicon.ico",
    "favicon.svg",
    "apple-touch-icon-180.png",
    "pwa-icon-192.png",
    "pwa-icon-512.png",
    "pwa-maskable-192.png",
    "pwa-maskable-512.png",
    "pwa-monochrome-192.png",
    "pwa-monochrome-512.png",
]

SCAFFOLD_REMOVALS = [
    WEB / "favicon.png",
    WEB / "icons" / "Icon-192.png",
    WEB / "icons" / "Icon-512.png",
    WEB / "icons" / "Icon-maskable-192.png",
    WEB / "icons" / "Icon-maskable-512.png",
]


def render(svg, size, out):
    out.parent.mkdir(parents=True, exist_ok=True)
    cairosvg.svg2png(url=str(svg), write_to=str(out), output_width=size, output_height=size)
    print(f"rendered {out.relative_to(ROOT)} ({size}px)")


def render_micro_on_tile(size, out):
    """Rasterize the locked M1 micro-mark on the obsidian tile at [size] px.

    Composition only — the mark geometry, colour and 62% tile fraction are
    read from the locked masters, never redrawn here.
    """
    master = MICRO_REVERSE.read_text(encoding="utf-8")
    start = master.index(">", master.index("<svg")) + 1
    inner = master[start : master.index("</svg>")]
    margin = (100 - 100 * MARK_FRACTION) / 2
    composite = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
        f'<rect width="100" height="100" fill="{OBSIDIAN}"/>'
        f'<g transform="translate({margin} {margin}) scale({MARK_FRACTION})">'
        f"{inner}</g></svg>"
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    cairosvg.svg2png(
        bytestring=composite.encode("utf-8"),
        write_to=str(out),
        output_width=size,
        output_height=size,
    )
    print(f"rendered {out.relative_to(ROOT)} ({size}px, M1 micro on tile)")


def copy(src, dst):
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)
    print(f"copied   {dst.relative_to(ROOT)}")


def main():
    # Android adaptive layers + themed/monochrome layer.
    for density in ADAPTIVE_DENSITIES:
        for layer in ("foreground", "background", "monochrome"):
            copy(
                EXPORTS / "android" / f"ic_launcher_{layer}-{density}.png",
                RES / f"mipmap-{density}" / f"ic_launcher_{layer}.png",
            )

    # Android legacy launcher icon (pre-adaptive fallbacks).
    for density, size in sorted(LEGACY_LAUNCHER.items()):
        render(APP_ICON, size, RES / f"mipmap-{density}" / "ic_launcher.png")

    # Android notification silhouette (white alpha, M1 micro form).
    for density in NOTIFICATION_DENSITIES:
        copy(
            EXPORTS / "android" / f"ic_notification-{density}.png",
            RES / f"drawable-{density}" / "ic_notification.png",
        )

    # iOS / macOS AppIcon catalogs (square, unmasked; Xcode applies masks).
    # Smallest slots use the visually corrected micro-marks (see header).
    for name, size in IOS_ICON_PIXELS.items():
        if name in IOS_MICRO_PIXELS:
            render_micro_on_tile(size, IOS_APPICON / name)
        else:
            render(APP_ICON, size, IOS_APPICON / name)
    for name, size in MACOS_ICON_PIXELS.items():
        if name in MACOS_MICRO_PIXELS:
            # M3 pixel-hinted mono on the tile, at integer 1x/2x scale.
            render(FAVICON_16, size, MACOS_APPICON / name)
        else:
            render(APP_ICON, size, MACOS_APPICON / name)

    # Web favicon + PWA icon set.
    for name in WEB_EXPORTS:
        dst = WEB / name if name.startswith("favicon") else WEB / "icons" / name
        copy(EXPORTS / "web" / name, dst)

    # Windows runner icon (hand-tuned multi-resolution .ico from the pipeline).
    copy(EXPORTS / "windows" / "app.ico", WINDOWS_RESOURCES / "app_icon.ico")

    # Scaffold artwork nothing references any more.
    for path in SCAFFOLD_REMOVALS:
        if path.exists():
            path.unlink()
            print(f"removed  {path.relative_to(ROOT)}")
    launch_imageset = ROOT / "ios" / "Runner" / "Assets.xcassets" / "LaunchImage.imageset"
    if launch_imageset.exists():
        shutil.rmtree(launch_imageset)
        print(f"removed  {launch_imageset.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
