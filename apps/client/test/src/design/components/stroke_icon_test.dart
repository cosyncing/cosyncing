import 'dart:typed_data';

import 'package:cosyncing_client/src/design/components.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  tearDown(() {
    debugStrokeIconRasterOverride = null;
    debugClearStrokeIconRasters();
  });

  Widget icons(List<Widget> children) => Directionality(
    textDirection: TextDirection.ltr,
    child: Center(
      child: RepaintBoundary(
        key: const Key('icons'),
        child: Row(mainAxisSize: MainAxisSize.min, children: children),
      ),
    ),
  );

  testWidgets('the web path caches one raster per glyph, color, size, ratio', (
    tester,
  ) async {
    debugStrokeIconRasterOverride = true;
    debugClearStrokeIconRasters();
    await tester.pumpWidget(
      icons(const [
        StrokeIcon(StrokeGlyph.folder, color: Color(0xFF202020)),
        StrokeIcon(StrokeGlyph.folder, color: Color(0xFF202020)),
        StrokeIcon(StrokeGlyph.folder, color: Color(0xFF808080)),
        StrokeIcon(StrokeGlyph.folder, size: 14, color: Color(0xFF202020)),
        StrokeIcon(StrokeGlyph.close, color: Color(0xFF202020)),
      ]),
    );
    expect(debugStrokeIconRasterCount, 4);

    // Repainting reuses them.
    await tester.pumpWidget(
      icons(const [
        StrokeIcon(StrokeGlyph.close, color: Color(0xFF202020)),
        StrokeIcon(StrokeGlyph.folder, color: Color(0xFF202020)),
      ]),
    );
    expect(debugStrokeIconRasterCount, 4);
  });

  testWidgets('the raster draws what the vector outlines draw', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.resetDevicePixelRatio);
    const row = [
      StrokeIcon(StrokeGlyph.folder, color: Color(0xFF202020)),
      StrokeIcon(StrokeGlyph.settings, size: 14, color: Color(0xFF3060A0)),
      StrokeIcon(StrokeGlyph.chevronDown, quarterTurns: 3),
    ];

    Future<Uint8List> capture({required bool raster}) async {
      debugStrokeIconRasterOverride = raster;
      await tester.pumpWidget(icons(row));
      final boundary = tester.renderObject<RenderRepaintBoundary>(
        find.byKey(const Key('icons')),
      );
      final bytes = await tester.runAsync(() async {
        final image = await boundary.toImage(pixelRatio: 2);
        final data = await image.toByteData();
        image.dispose();
        return data!.buffer.asUint8List();
      });
      return bytes!;
    }

    final vector = await capture(raster: false);
    await tester.pumpWidget(const SizedBox.shrink());
    final raster = await capture(raster: true);
    expect(raster.length, vector.length);
    int inked(Uint8List rgba) {
      var count = 0;
      for (var alpha = 3; alpha < rgba.length; alpha += 4) {
        if (rgba[alpha] > 0) count++;
      }
      return count;
    }

    expect(inked(vector), greaterThan(100), reason: 'the icons drew nothing');
    expect(inked(raster), greaterThan(100));
    var worst = 0;
    var total = 0;
    for (var index = 0; index < vector.length; index++) {
      final delta = (vector[index] - raster[index]).abs();
      total += delta;
      if (delta > worst) worst = delta;
    }
    expect(
      total / vector.length,
      lessThan(1),
      reason: 'mean channel difference, worst $worst',
    );
  });
}
