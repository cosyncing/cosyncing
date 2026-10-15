// Settings verbs and readers over a running App (F09 to F11).
//
// Everything is a thin finder or a user gesture over the real App; waiting is
// bounded frame pumping under fake time (see `AppDriver`).
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'app_driver.dart';

/// Settings verbs over a running App.
extension SettingsDriver on AppDriver {
  /// The app's resolved [ThemeData] (brightness already decided).
  ThemeData get theme => Theme.of(tester.element(find.byType(Scaffold).first));

  /// The app's design tokens for the resolved theme.
  AppTokens get tokens => theme.extension<AppTokens>()!;

  /// The text scale the app applies to a 10 px run.
  double get textScale =>
      MediaQuery.of(
        tester.element(find.byType(Scaffold).first),
      ).textScaler.scale(10) /
      10;

  /// The locale the widget tree resolved.
  Locale get locale =>
      Localizations.localeOf(tester.element(find.byType(Scaffold).first));

  /// Opens the select [key], then its option labelled [option].
  Future<void> pick(String key, String option) async {
    await reveal(find.byKey(Key(key)));
    await tester.tap(find.byKey(Key(key)));
    await settle();
    // The open menu repeats the selected label; its entries come last.
    await tester.tap(find.text(option).last);
    await settle();
  }

  /// The label the select [key] currently shows.
  String selected(String key) {
    final texts = find.descendant(
      of: find.byKey(Key(key)),
      matching: find.byType(Text),
    );
    return tester.widget<Text>(texts.first).data!;
  }

  /// Whether the switch row [key] is on.
  bool isOn(String key) =>
      tester.widget<SwitchListTile>(find.byKey(Key(key))).value;

  /// Whether the switch row [key] accepts a tap.
  bool isEnabled(String key) =>
      tester.widget<SwitchListTile>(find.byKey(Key(key))).onChanged != null;

  /// Taps the switch row [key].
  Future<void> toggle(String key) => tapKey(key);

  /// Opens settings category [category] from the hub (`display`, `agents`, …).
  Future<void> openCategory(String category) =>
      tapKey('settings-category-$category');

  /// Writes a raw row of the app-settings table, like an older build, a
  /// hand edit or a corrupt write would have left it.
  Future<void> writeRawSetting(String key, String value) => storage.database
      .into(storage.database.appSettingRows)
      .insertOnConflictUpdate(
        AppSettingRowsCompanion.insert(
          key: key,
          value: value,
          updatedAt: DateTime.utc(2026, 10),
        ),
      );

  /// Presses the confirm action [label] of the dialog on screen.
  Future<void> confirm(String label) => tap(
    find.descendant(of: find.byType(AlertDialog), matching: find.text(label)),
  );

  /// Presses Cancel in the dialog on screen.
  Future<void> cancelDialog() => tap(
    find.descendant(
      of: find.byType(AlertDialog),
      matching: find.widgetWithText(TextButton, 'Cancel'),
    ),
  );
}
