import 'package:cosyncing_client/src/design/window_size_class.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('WindowSizeClass.fromWidth', () {
    test('classifies compact below 600dp', () {
      expect(WindowSizeClass.fromWidth(0), WindowSizeClass.compact);
      expect(WindowSizeClass.fromWidth(599.9), WindowSizeClass.compact);
    });

    test('classifies medium in [600, 840)', () {
      expect(WindowSizeClass.fromWidth(600), WindowSizeClass.medium);
      expect(WindowSizeClass.fromWidth(839.9), WindowSizeClass.medium);
    });

    test('classifies expanded at or above 840dp', () {
      expect(WindowSizeClass.fromWidth(840), WindowSizeClass.expanded);
      expect(WindowSizeClass.fromWidth(1440), WindowSizeClass.expanded);
    });
  });

  group('showListDetail', () {
    test('only expanded shows the two-pane workspace', () {
      expect(WindowSizeClass.compact.showListDetail, isFalse);
      expect(WindowSizeClass.medium.showListDetail, isFalse);
      expect(WindowSizeClass.expanded.showListDetail, isTrue);
    });
  });

  group('WindowSizeClass.of', () {
    testWidgets('reads the MediaQuery width', (tester) async {
      late WindowSizeClass observed;
      await tester.pumpWidget(
        MediaQuery(
          data: const MediaQueryData(size: Size(1000, 800)),
          child: Builder(
            builder: (context) {
              observed = WindowSizeClass.of(context);
              return const SizedBox.shrink();
            },
          ),
        ),
      );
      expect(observed, WindowSizeClass.expanded);
    });
  });
}
