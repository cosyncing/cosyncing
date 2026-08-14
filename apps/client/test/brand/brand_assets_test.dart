import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

/// B1: durable validation of the wired cosyncing brand assets.
///
/// Reads the real platform trees (Android res/, iOS/macOS asset catalogs,
/// web/, windows/) and fails if any Flutter scaffold artwork or Flutter-blue
/// manifest colour creeps back in, if a catalog/manifest references a missing
/// or wrongly-sized raster, if an opaque asset is not opaque, or if the
/// one-color layers (Android monochrome, notification silhouette, PWA
/// monochrome) are not actually one hue with a real alpha channel.
///
/// The rasters themselves are produced deterministically by
/// `scripts/wire_brand_icons.sh` from the locked masters in
/// `assets/brand/source/` (see assets/brand/HANDOVER.md).
void main() {
  group('web branding', () {
    test('manifest uses brand colours, never Flutter blue', () {
      final manifest = File('web/manifest.json').readAsStringSync();
      expect(manifest, isNot(contains('0175C2')));
      final decoded = jsonDecode(manifest) as Map<String, dynamic>;
      expect(decoded['background_color'], '#0B0E14');
      expect(decoded['theme_color'], '#0B0E14');
    });

    test('manifest icons exist at their declared size and purpose', () {
      final decoded =
          jsonDecode(File('web/manifest.json').readAsStringSync())
              as Map<String, dynamic>;
      final icons = (decoded['icons'] as List).cast<Map<String, dynamic>>();
      final seen = <String, String>{};
      for (final icon in icons) {
        final src = icon['src'] as String;
        final purpose = icon['purpose'] as String? ?? 'any';
        final size = (icon['sizes'] as String).split('x').first;
        seen['$purpose-$size'] = src;
        final file = File('web/$src');
        expect(file.existsSync(), isTrue, reason: 'missing $src');
        final png = PngImage.read(file);
        expect(png.width, int.parse(size), reason: src);
        expect(png.height, int.parse(size), reason: src);
      }
      for (final size in ['192', '512']) {
        for (final purpose in ['any', 'maskable', 'monochrome']) {
          expect(
            seen.containsKey('$purpose-$size'),
            isTrue,
            reason: 'manifest lacks a $purpose $size icon',
          );
        }
      }
      // The maskable set must be opaque full-bleed (doc 14).
      for (final key in ['maskable-192', 'maskable-512']) {
        final png = PngImage.read(File('web/${seen[key]}'));
        expect(png.minAlpha, 255, reason: '$key must be opaque full-bleed');
      }
    });

    test('monochrome PWA icons are a single hue with a real alpha channel', () {
      for (final size in [192, 512]) {
        final png = PngImage.read(File('web/icons/pwa-monochrome-$size.png'));
        expect(png.opaqueHues.length, 1, reason: 'monochrome $size');
        expect(png.hasTransparency, isTrue, reason: 'monochrome $size');
        expect(png.hasFullOpacity, isTrue, reason: 'monochrome $size');
      }
    });

    test('favicon.ico carries the 16/32/48 layers', () {
      final sizes = icoSizes(File('web/favicon.ico'));
      expect(sizes, containsAll([16, 32, 48]));
    });

    test('apple touch icon is the 180px opaque tile', () {
      final png = PngImage.read(File('web/icons/apple-touch-icon-180.png'));
      expect(png.width, 180);
      expect(png.height, 180);
      expect(png.minAlpha, 255);
    });

    test('index.html references only the brand favicon set', () {
      final html = File('web/index.html').readAsStringSync();
      expect(html, contains('href="favicon.ico"'));
      expect(html, contains('href="favicon.svg"'));
      expect(html, contains('href="icons/apple-touch-icon-180.png"'));
      expect(html, isNot(contains('favicon.png')));
      expect(html, isNot(contains('icons/Icon-')));
    });

    test('scaffold PWA artwork is gone', () {
      expect(File('web/favicon.png').existsSync(), isFalse);
      for (final name in [
        'Icon-192.png',
        'Icon-512.png',
        'Icon-maskable-192.png',
        'Icon-maskable-512.png',
      ]) {
        expect(File('web/icons/$name').existsSync(), isFalse, reason: name);
      }
    });
  });

  group('android branding', () {
    const densities = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];
    // A 108dp adaptive layer maps to exactly these pixel sizes per density;
    // anything larger makes Android treat the bitmap as a bigger intrinsic
    // asset than the density bucket declares.
    const adaptivePixels = {
      'mdpi': 108,
      'hdpi': 162,
      'xhdpi': 216,
      'xxhdpi': 324,
      'xxxhdpi': 432,
    };
    const legacyPixels = {
      'mdpi': 48,
      'hdpi': 72,
      'xhdpi': 96,
      'xxhdpi': 144,
      'xxxhdpi': 192,
    };
    const notificationPixels = {
      'mdpi': 24,
      'hdpi': 36,
      'xhdpi': 48,
      'xxhdpi': 72,
      'xxxhdpi': 96,
    };

    test('adaptive descriptor wires foreground, background and monochrome', () {
      final xml = File(
        'android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml',
      ).readAsStringSync();
      for (final layer in ['foreground', 'background', 'monochrome']) {
        expect(xml, contains('@mipmap/ic_launcher_$layer'));
      }
    });

    test('adaptive layers exist in every density at the pipeline sizes', () {
      for (final density in densities) {
        for (final layer in ['foreground', 'background', 'monochrome']) {
          final file = File(
            'android/app/src/main/res/mipmap-$density/ic_launcher_$layer.png',
          );
          expect(file.existsSync(), isTrue, reason: file.path);
          final png = PngImage.read(file);
          expect(png.width, adaptivePixels[density], reason: file.path);
          expect(png.height, adaptivePixels[density], reason: file.path);
        }
      }
    });

    test('monochrome layer is one hue and keeps the 66dp safe zone', () {
      for (final density in densities) {
        final png = PngImage.read(
          File(
            'android/app/src/main/res/mipmap-$density/ic_launcher_monochrome.png',
          ),
        );
        expect(png.opaqueHues.length, 1, reason: density);
        expect(png.hasTransparency, isTrue, reason: density);
        expect(png.hasFullOpacity, isTrue, reason: density);
        expect(
          png.isContentWithinCentralFraction(66 / 108),
          isTrue,
          reason: '$density escapes the 66dp adaptive safe zone',
        );
      }
    });

    test('foreground keeps the defining mark inside the 66dp safe zone', () {
      for (final density in densities) {
        final png = PngImage.read(
          File(
            'android/app/src/main/res/mipmap-$density/ic_launcher_foreground.png',
          ),
        );
        expect(
          png.isContentWithinCentralFraction(66 / 108),
          isTrue,
          reason: '$density escapes the 66dp adaptive safe zone',
        );
      }
    });

    test('legacy launcher icons are the brand tile at scaffold sizes', () {
      for (final density in densities) {
        final file = File(
          'android/app/src/main/res/mipmap-$density/ic_launcher.png',
        );
        expect(file.existsSync(), isTrue, reason: file.path);
        final png = PngImage.read(file);
        expect(png.width, legacyPixels[density], reason: file.path);
        expect(png.height, legacyPixels[density], reason: file.path);
        // The brand tile is full-bleed obsidian; a scaffold icon would have
        // transparent or white corners.
        expect(png.pixelRgb(0, 0), 0x0B0E14, reason: file.path);
      }
    });

    test('notification icons are white alpha silhouettes', () {
      for (final density in densities) {
        final file = File(
          'android/app/src/main/res/drawable-$density/ic_notification.png',
        );
        expect(file.existsSync(), isTrue, reason: file.path);
        final png = PngImage.read(file);
        expect(png.width, notificationPixels[density], reason: file.path);
        expect(png.height, notificationPixels[density], reason: file.path);
        expect(png.opaqueHues, {0xFFFFFF}, reason: file.path);
        expect(png.hasTransparency, isTrue, reason: file.path);
        expect(png.hasFullOpacity, isTrue, reason: file.path);
      }
    });

    test('the notification sink uses the dedicated silhouette', () {
      final adapter = File(
        'lib/src/features/sessions/detail/session_local_notification_adapter.dart',
      ).readAsStringSync();
      expect(adapter, contains("androidDefaultIcon: 'ic_notification'"));
    });

    test('launch backgrounds use the scheme-aware brand canvas colour', () {
      for (final dir in ['drawable', 'drawable-v21']) {
        final xml = File(
          'android/app/src/main/res/$dir/launch_background.xml',
        ).readAsStringSync();
        expect(xml, contains('@color/launch_background'), reason: dir);
        expect(xml, isNot(contains('@android:color/white')), reason: dir);
      }
      expect(
        File('android/app/src/main/res/values/colors.xml').readAsStringSync(),
        contains('#F2F5F4'),
      );
      expect(
        File(
          'android/app/src/main/res/values-night/colors.xml',
        ).readAsStringSync(),
        contains('#0B0E14'),
      );
    });

    test('the brand background survives the whole launch handoff', () {
      for (final dir in ['values', 'values-night']) {
        final styles = File(
          'android/app/src/main/res/$dir/styles.xml',
        ).readAsStringSync();
        final launchTheme = styles.substring(
          styles.indexOf('name="LaunchTheme"'),
          styles.indexOf('name="NormalTheme"'),
        );
        final normalTheme = styles.substring(
          styles.indexOf('name="NormalTheme"'),
        );
        // The Android 12+ system splash draws the window background before
        // the activity's launch drawable exists.
        expect(
          launchTheme,
          contains(
            'name="android:windowSplashScreenBackground">'
            '@color/launch_background',
          ),
          reason: '$dir system splash must use the brand background',
        );
        // NormalTheme owns the window between the launch splash and
        // Flutter's first frame; the platform default would flash an
        // unrelated colour there.
        expect(
          normalTheme,
          contains(
            'name="android:windowBackground">@drawable/launch_background',
          ),
          reason: '$dir NormalTheme must retain the brand background',
        );
        expect(
          normalTheme,
          isNot(contains('?android:colorBackground')),
          reason: '$dir NormalTheme must not fall back to the platform default',
        );
      }
    });
  });

  group('apple branding', () {
    test('every iOS AppIcon slot resolves to the exact pixel size', () {
      final catalog = Directory(
        'ios/Runner/Assets.xcassets/AppIcon.appiconset',
      );
      final contents =
          jsonDecode(File('${catalog.path}/Contents.json').readAsStringSync())
              as Map<String, dynamic>;
      final images = (contents['images'] as List).cast<Map<String, dynamic>>();
      expect(images, isNotEmpty);
      for (final image in images) {
        final filename = image['filename'] as String;
        final points = double.parse(
          (image['size'] as String).split('x').first,
        );
        final scale = int.parse(
          (image['scale'] as String).replaceAll('x', ''),
        );
        final file = File('${catalog.path}/$filename');
        expect(file.existsSync(), isTrue, reason: filename);
        final png = PngImage.read(file);
        expect(png.width, (points * scale).round(), reason: filename);
        expect(png.height, (points * scale).round(), reason: filename);
        // Apple applies the system mask: the source tile is square, unmasked
        // and fully opaque.
        expect(png.minAlpha, 255, reason: filename);
        expect(png.pixelRgb(0, 0), 0x0B0E14, reason: filename);
      }
    });

    test('every macOS AppIcon slot resolves to the exact pixel size', () {
      final catalog = Directory(
        'macos/Runner/Assets.xcassets/AppIcon.appiconset',
      );
      final contents =
          jsonDecode(File('${catalog.path}/Contents.json').readAsStringSync())
              as Map<String, dynamic>;
      final images = (contents['images'] as List).cast<Map<String, dynamic>>();
      expect(images, isNotEmpty);
      for (final image in images) {
        final filename = image['filename'] as String;
        final points = double.parse(
          (image['size'] as String).split('x').first,
        );
        final scale = int.parse(
          (image['scale'] as String).replaceAll('x', ''),
        );
        final file = File('${catalog.path}/$filename');
        expect(file.existsSync(), isTrue, reason: filename);
        final png = PngImage.read(file);
        expect(png.width, (points * scale).round(), reason: filename);
        expect(png.height, (points * scale).round(), reason: filename);
        expect(png.minAlpha, 255, reason: filename);
      }
    });

    test('smallest Apple icons use the corrected micro-mark forms', () {
      const obsidian = 0x0B0E14;
      const offWhite = 0xF2F5F4;
      // macOS 16/32 px: the M3 pixel-hinted mono micro-mark on the tile at
      // integer scale — every pixel is exactly one brand colour, never the
      // anti-aliased mush a downscaled full tile produces.
      for (final name in ['app_icon_16.png', 'app_icon_32.png']) {
        final png = PngImage.read(
          File(
            'macos/Runner/Assets.xcassets/AppIcon.appiconset/$name',
          ),
        );
        expect(png.opaqueHues, {obsidian, offWhite}, reason: name);
        expect(png.minAlpha, 255, reason: name);
      }
      // iOS 20 px: the M1 squared micro-mark on the tile. Edge anti-aliasing
      // may blend the two brand colours, but nothing else — a downscaled
      // full tile would drag in teal blends.
      final png = PngImage.read(
        File(
          'ios/Runner/Assets.xcassets/AppIcon.appiconset/'
          'Icon-App-20x20@1x.png',
        ),
      );
      expect(png.pixelRgb(0, 0), obsidian);
      expect(png.minAlpha, 255);
      expect(png.opaqueHues, contains(offWhite));
      for (final hue in png.opaqueHues) {
        final r = (hue >> 16) & 0xFF;
        final g = (hue >> 8) & 0xFF;
        // Obsidian (11,14,20) and off-white (242,245,244) both have
        // g - r == 3, and every blend between them keeps it; teal breaks it.
        expect(
          (g - r - 3).abs(),
          lessThanOrEqualTo(2),
          reason: '0x${hue.toRadixString(16)}',
        );
      }
    });

    test('the launch screen is a scheme-aware brand colour, no bitmap', () {
      final storyboard = File(
        'ios/Runner/Base.lproj/LaunchScreen.storyboard',
      ).readAsStringSync();
      expect(storyboard, contains('name="LaunchBackground"'));
      expect(storyboard, isNot(contains('LaunchImage')));
      expect(
        Directory(
          'ios/Runner/Assets.xcassets/LaunchImage.imageset',
        ).existsSync(),
        isFalse,
      );
      final colorset =
          jsonDecode(
                File(
                  'ios/Runner/Assets.xcassets/LaunchBackground.colorset/Contents.json',
                ).readAsStringSync(),
              )
              as Map<String, dynamic>;
      final colors = (colorset['colors'] as List).cast<Map<String, dynamic>>();
      expect(colors.length, 2);
      final byAppearance = <String, Map<String, dynamic>>{
        for (final entry in colors)
          (entry['appearances'] == null) ? 'light' : 'dark': entry,
      };
      expect(_srgbHex(byAppearance['light']!), '#F2F5F4');
      expect(_srgbHex(byAppearance['dark']!), '#0B0E14');
    });
  });

  group('windows branding', () {
    test('runner icon is the multi-resolution brand .ico', () {
      final sizes = icoSizes(File('windows/runner/resources/app_icon.ico'));
      expect(sizes, containsAll([16, 24, 32, 48, 64, 128, 256]));
    });
  });
}

String _srgbHex(Map<String, dynamic> entry) {
  final components =
      (entry['color'] as Map<String, dynamic>)['components']
          as Map<String, dynamic>;
  int channel(String name) =>
      (double.parse(components[name] as String) * 255).round();
  final r = channel('red').toRadixString(16).padLeft(2, '0');
  final g = channel('green').toRadixString(16).padLeft(2, '0');
  final b = channel('blue').toRadixString(16).padLeft(2, '0');
  return '#$r$g$b'.toUpperCase();
}

/// Parses an .ico directory and returns the pixel size of every image layer.
Set<int> icoSizes(File file) {
  final bytes = file.readAsBytesSync();
  final data = ByteData.sublistView(bytes);
  expect(data.getUint16(0, Endian.little), 0, reason: '${file.path} reserved');
  expect(data.getUint16(2, Endian.little), 1, reason: '${file.path} type');
  final count = data.getUint16(4, Endian.little);
  final sizes = <int>{};
  for (var i = 0; i < count; i++) {
    final offset = 6 + i * 16;
    final width = data.getUint8(offset);
    final height = data.getUint8(offset + 1);
    // A zero byte encodes 256 in the ICO directory.
    sizes.add(width == 0 ? 256 : width);
    expect(
      height == 0 ? 256 : height,
      width == 0 ? 256 : width,
      reason: '${file.path} layer $i is not square',
    );
  }
  return sizes;
}

/// Minimal PNG reader for the validation above: IHDR geometry plus fully
/// decoded 8-bit RGB/RGBA pixels (zlib via dart:io, all five row filters).
/// Interlaced files and other bit depths fail loudly rather than guessing.
class PngImage {
  PngImage._(this.width, this.height, this._channels, this._pixels);

  factory PngImage.read(File file) {
    final bytes = file.readAsBytesSync();
    final signature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    for (var i = 0; i < signature.length; i++) {
      if (bytes[i] != signature[i]) {
        fail('${file.path} is not a PNG');
      }
    }
    var offset = 8;
    var width = 0;
    var height = 0;
    var bitDepth = 0;
    var colorType = 0;
    var interlace = 0;
    final idat = BytesBuilder();
    while (offset < bytes.length) {
      final data = ByteData.sublistView(bytes, offset);
      final length = data.getUint32(0);
      final type = String.fromCharCodes(bytes.sublist(offset + 4, offset + 8));
      final body = offset + 8;
      if (type == 'IHDR') {
        final ihdr = ByteData.sublistView(bytes, body);
        width = ihdr.getUint32(0);
        height = ihdr.getUint32(4);
        bitDepth = ihdr.getUint8(8);
        colorType = ihdr.getUint8(9);
        interlace = ihdr.getUint8(12);
      } else if (type == 'IDAT') {
        idat.add(bytes.sublist(body, body + length));
      } else if (type == 'IEND') {
        break;
      }
      offset = body + length + 4;
    }
    if (bitDepth != 8 || (colorType != 6 && colorType != 2) || interlace != 0) {
      fail(
        '${file.path}: unsupported PNG form '
        '(bitDepth=$bitDepth colorType=$colorType interlace=$interlace)',
      );
    }
    final channels = colorType == 6 ? 4 : 3;
    final raw = Uint8List.fromList(
      ZLibDecoder().convert(idat.toBytes()),
    );
    final stride = width * channels;
    if (raw.length != (stride + 1) * height) {
      fail('${file.path}: unexpected scanline payload length');
    }
    final pixels = Uint8List(stride * height);
    for (var y = 0; y < height; y++) {
      final filter = raw[y * (stride + 1)];
      final rowIn = y * (stride + 1) + 1;
      final rowOut = y * stride;
      for (var x = 0; x < stride; x++) {
        final current = raw[rowIn + x];
        final left = x >= channels ? pixels[rowOut + x - channels] : 0;
        final up = y > 0 ? pixels[rowOut - stride + x] : 0;
        final upLeft = y > 0 && x >= channels
            ? pixels[rowOut - stride + x - channels]
            : 0;
        final value = switch (filter) {
          0 => current,
          1 => current + left,
          2 => current + up,
          3 => current + ((left + up) >> 1),
          4 => current + _paeth(left, up, upLeft),
          _ => fail('${file.path}: unknown row filter $filter'),
        };
        pixels[rowOut + x] = value & 0xFF;
      }
    }
    return PngImage._(width, height, channels, pixels);
  }

  final int width;
  final int height;

  /// 3 for RGB, 4 for RGBA.
  final int _channels;
  final Uint8List _pixels;

  static int _paeth(int a, int b, int c) {
    final p = a + b - c;
    final pa = (p - a).abs();
    final pb = (p - b).abs();
    final pc = (p - c).abs();
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
  }

  int _alpha(int x, int y) =>
      _channels == 4 ? _pixels[(y * width + x) * 4 + 3] : 255;

  /// 0xRRGGBB at (x, y).
  int pixelRgb(int x, int y) {
    final base = (y * width + x) * _channels;
    return (_pixels[base] << 16) | (_pixels[base + 1] << 8) | _pixels[base + 2];
  }

  int get minAlpha {
    var min = 255;
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        final alpha = _alpha(x, y);
        if (alpha < min) min = alpha;
      }
    }
    return min;
  }

  bool get hasTransparency {
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        if (_alpha(x, y) < 255) return true;
      }
    }
    return false;
  }

  bool get hasFullOpacity {
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        if (_alpha(x, y) == 255) return true;
      }
    }
    return false;
  }

  /// The distinct 0xRRGGBB hues of pixels with any coverage.
  Set<int> get opaqueHues {
    final hues = <int>{};
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        if (_alpha(x, y) > 0) hues.add(pixelRgb(x, y));
      }
    }
    return hues;
  }

  /// True when every pixel with coverage sits inside the centered square
  /// occupying [fraction] of the canvas (the Android 66/108 safe zone).
  bool isContentWithinCentralFraction(double fraction) {
    final marginX = width * (1 - fraction) / 2;
    final marginY = height * (1 - fraction) / 2;
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        if (_alpha(x, y) > 8 &&
            (x < marginX ||
                x >= width - marginX ||
                y < marginY ||
                y >= height - marginY)) {
          return false;
        }
      }
    }
    return true;
  }
}
