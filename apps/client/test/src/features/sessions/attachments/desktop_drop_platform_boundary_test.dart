import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// The vendored `desktop_drop` fork is desktop/web only.
///
/// Upstream's Android plugin installs an `android.R.id.content` drag listener
/// that returns `true` for every drag event, so merely declaring the platform
/// consumes Android drag/drop even though this app renders no Android drop
/// target. A1b keeps mobile behavior unchanged by never registering there.
void main() {
  group('vendored desktop_drop platform boundary', () {
    final package = Directory('../../packages/dart/desktop_drop');

    setUpAll(() {
      if (!package.existsSync()) {
        fail('vendored desktop_drop not found at ${package.path}');
      }
    });

    test('the fork declares no Android platform', () {
      final pubspec = File('${package.path}/pubspec.yaml').readAsStringSync();
      final platforms = _declaredPlatforms(pubspec);

      expect(platforms, isNot(contains('android')));
      expect(platforms, isNot(contains('ios')));
      expect(
        platforms,
        containsAll(<String>['macos', 'linux', 'windows', 'web']),
        reason: 'desktop and web intake must keep working',
      );
      expect(pubspec, isNot(contains('one.mixin.desktop.drop')));
    });

    test('the fork ships no Android sources', () {
      expect(
        Directory('${package.path}/android').existsSync(),
        isFalse,
        reason: 'an android/ directory reintroduces the drag listener',
      );
      final kotlin = package
          .listSync(recursive: true)
          .whereType<File>()
          .where((file) => file.path.endsWith('.kt'))
          .map((file) => file.path);
      expect(kotlin, isEmpty);
    });

    test('the macOS drop path never materializes a file promise', () {
      final plugin = File(
        '${package.path}/macos/desktop_drop/Sources/desktop_drop/'
        'DesktopDropPlugin.swift',
      );
      expect(plugin.existsSync(), isTrue);
      // Comments explain the divergence and name the upstream APIs, so scan
      // code only.
      final code = plugin
          .readAsLinesSync()
          .where((line) => !line.trimLeft().startsWith('//'))
          .join('\n');

      // Materializing a promise writes app-owned bytes into a temporary
      // directory that no Dart owner ever cleans up, so the fork must reach
      // none of this machinery — and must not advertise the type either.
      for (final forbidden in const [
        'receivePromisedFiles',
        'NSFilePromiseReceiver',
        'createDirectory',
        'Drops',
      ]) {
        expect(
          code,
          isNot(contains(forbidden)),
          reason: 'macOS drop path must not use $forbidden',
        );
      }
    });

    test('every native drop path bounds delivery before enumerating', () {
      // Native code cannot be exercised from `flutter test`, so the boundary is
      // asserted at the source: each platform must both accept the caller's
      // bound and consult it on the delivery path. Compile evidence for these
      // files is recorded in the fork README.
      final surfaces = <String, List<String>>{
        'windows/desktop_drop_plugin.cpp': ['setFileLimit', 'file_limit'],
        'macos/desktop_drop/Sources/desktop_drop/DesktopDropPlugin.swift': [
          'setFileLimit',
          'fileLimit',
        ],
        // The Linux cut must count what Dart delivers: `LineSplitter` ends a
        // line at a bare '\r' too, and empty lines are dropped before the
        // client counts them.
        'linux/desktop_drop_plugin.cc': [
          'setFileLimit',
          'truncate_uri_list',
          r"*cursor != '\r'",
          'delivered',
        ],
      };
      for (final MapEntry(key: relative, value: required) in surfaces.entries) {
        final source = File('${package.path}/$relative').readAsStringSync();
        for (final token in required) {
          expect(
            source,
            contains(token),
            reason: '$relative must bound drop delivery via $token',
          );
        }
      }
    });

    test('the windows drop path does not print dropped paths', () {
      final source = File(
        '${package.path}/windows/desktop_drop_plugin.cpp',
      ).readAsStringSync();
      // Upstream logged every dropped file path to stdout.
      expect(source, isNot(contains('std::cout << "done')));
    });

    test('the pasteboard image bound precedes every plugin allocation', () {
      final fork = Directory('../../packages/dart/pasteboard');
      final swift = File(
        '${fork.path}/macos/pasteboard/Sources/pasteboard/'
        'PasteboardPlugin.swift',
      ).readAsStringSync();
      // `tiffRepresentation` re-encodes the whole image — an allocation as
      // large as the picture the bound exists to refuse — so the estimate must
      // come first, and it must be computed without trapping arithmetic.
      final bounded = swift.substring(
        swift.indexOf('private func image(maxBytes'),
        swift.indexOf('private static func decodedByteEstimate'),
      );
      expect(bounded, contains('decodedByteEstimate'));
      expect(
        bounded.indexOf('decodedByteEstimate'),
        lessThan(bounded.indexOf('tiffRepresentation')),
        reason: 'the bound must be applied before any encode',
      );
      // The estimate itself must not use bare `*`: Swift traps on overflow,
      // so a hostile pasteboard would crash the host instead of being refused.
      final estimate = swift.substring(
        swift.indexOf('private static func decodedByteEstimate'),
      );
      expect(estimate, contains('multipliedReportingOverflow'));
      expect(
        estimate.replaceAll(RegExp(r'\s+'), ''),
        isNot(contains(RegExp(r'pixelsWide\*|\*perPixel|\*bytesPerPixel'))),
        reason: 'sizing arithmetic must be overflow-checked',
      );
      // `samplesPerPixel` counts channels, not bytes: a 16-bit RGBA rep is 8
      // bytes per pixel and would be priced at 4. The comment above it in the
      // plugin names the API, so scan code only.
      final estimateCode = estimate
          .split('\n')
          .where((line) => !line.trimLeft().startsWith('//'))
          .join('\n');
      expect(estimateCode, isNot(contains('samplesPerPixel')));

      final windows = File(
        '${fork.path}/windows/pasteboard_plugin.cpp',
      ).readAsStringSync();
      // Two dimensions near LONG_MAX overflow width * height * 4 back into a
      // value that passes, so the comparison divides instead. Matched
      // whitespace-insensitively: a literal-string check would be satisfied by
      // reintroducing the same multiplication with different spacing.
      expect(
        windows.replaceAll(RegExp(r'\s+'), ''),
        isNot(contains(RegExp(r'width\*height\*4[<>]'))),
        reason: 'the bound must not be computed by multiplication',
      );
      expect(windows, contains('/ 4) / height'));
      // Negating a LONG before widening is UB at LONG_MIN.
      expect(windows, isNot(contains('-bitmap->bmiHeader.biHeight')));
    });

    test('the pasteboard native paths own what they allocate', () {
      final fork = Directory('../../packages/dart/pasteboard');
      final linux = File(
        '${fork.path}/linux/pasteboard_plugin.cc',
      ).readAsStringSync();
      // `fl_value_new_uint8_list` and `fl_value_new_string` both copy, so the
      // encoded PNG and each converted path have to be released. Upstream
      // released neither: one leaked a whole screenshot per paste.
      expect(linux, contains('g_autofree gchar *buffer'));
      expect(linux, contains('g_autoptr(GError) error'));
      expect(linux, contains('g_autofree gchar *file_path'));

      final windows = File(
        '${fork.path}/windows/pasteboard_plugin.cpp',
      ).readAsStringSync();
      // Scoped to the bound itself. `sizeof(BITMAPFILEHEADER)` also appears
      // in upstream's BMP writer, so an unscoped match would stay green with
      // the overhead dropped from the comparison.
      final bound = windows.substring(
        windows.indexOf('// Fork addition. The DIB header'),
        windows.indexOf('const void *bitmap_bits'),
      );
      // A non-positive dimension is not an image; letting it through skips
      // every bound on the way to GDI.
      expect(bound, contains('width <= 0 || height <= 0'));
      // The result bound prices the BMP this actually returns, headers and
      // all: 4096x4096 is exactly 64 MiB of pixels and would otherwise pass a
      // 64 MiB bound while delivering a larger file.
      expect(bound, contains('sizeof(BITMAPFILEHEADER)'));
      expect(bound, contains('sizeof(BITMAPINFOHEADER)'));
    });

    test('the fork is distinguishable from upstream and documented', () {
      final pubspec = File('${package.path}/pubspec.yaml').readAsStringSync();
      final version = RegExp(
        r'^version:\s*(\S+)$',
        multiLine: true,
      ).firstMatch(pubspec)?.group(1);

      expect(version, isNotNull);
      expect(
        version,
        contains('+cosyncing.'),
        reason: 'a bare upstream version hides that this tree is forked',
      );

      final readme = File('${package.path}/README.md');
      expect(readme.existsSync(), isTrue);
      final text = readme.readAsStringSync();
      // The whole version, not just the upstream part: a provenance table that
      // records a different suffix than the pubspec is worse than none.
      expect(text, contains(version));
      for (final topic in const [
        'Android',
        'web registrar',
        'Updating the fork',
      ]) {
        expect(text, contains(topic), reason: 'README must record $topic');
      }
    });

    test('the pasteboard fork is versioned and documented', () {
      final fork = Directory('../../packages/dart/pasteboard');
      expect(fork.existsSync(), isTrue, reason: 'pasteboard must be vendored');
      final pubspec = File('${fork.path}/pubspec.yaml').readAsStringSync();
      final version = RegExp(
        r'^version:\s*(\S+)$',
        multiLine: true,
      ).firstMatch(pubspec)?.group(1);

      expect(version, contains('+cosyncing.'));
      final readme = File('${fork.path}/README-fork.md');
      expect(readme.existsSync(), isTrue);
      final text = readme.readAsStringSync();
      expect(text, contains(version));
      for (final topic in const [
        'boundedImage',
        'files({int? limit})',
        'Verification',
        'Updating the fork',
      ]) {
        expect(text, contains(topic), reason: 'README must record $topic');
      }
    });

    test('the generated Android registrant does not register the plugin', () {
      final registrant = File(
        'android/app/src/main/java/io/flutter/plugins/'
        'GeneratedPluginRegistrant.java',
      );
      if (!registrant.existsSync()) {
        // Only produced by a local Android build; nothing to regress against.
        return;
      }

      expect(
        registrant.readAsStringSync(),
        isNot(contains('DesktopDropPlugin')),
        reason:
            'run `flutter pub get` in apps/client to refresh the registrant',
      );
    });
  });
}

/// Returns the platform keys declared under `flutter: plugin: platforms:`.
Set<String> _declaredPlatforms(String pubspec) {
  final lines = pubspec.split('\n');
  final platforms = <String>{};
  var inPlatforms = false;
  for (final line in lines) {
    if (line.trimRight() == '    platforms:') {
      inPlatforms = true;
      continue;
    }
    if (!inPlatforms) continue;
    if (line.trim().isEmpty) continue;
    final indent = line.length - line.trimLeft().length;
    if (indent <= 4) break;
    if (indent == 6 && line.trimRight().endsWith(':')) {
      platforms.add(line.trim().replaceAll(':', ''));
    }
  }
  return platforms;
}
