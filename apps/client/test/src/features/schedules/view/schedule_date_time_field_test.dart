import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/schedules/view/schedule_date_time_field.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  for (final fixture in const [
    ('compact-light-en', Size(390, 800), Brightness.light, Locale('en')),
    ('compact-dark-zh', Size(390, 800), Brightness.dark, Locale('zh')),
    ('roomy-light-en', Size(1200, 900), Brightness.light, Locale('en')),
    ('roomy-dark-zh', Size(1200, 900), Brightness.dark, Locale('zh')),
  ]) {
    testWidgets(
      'date says Next and time remains final OK in ${fixture.$1}',
      (tester) async {
        tester.view.physicalSize = fixture.$2;
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        DateTime? selected;
        final initial = DateTime.now().add(const Duration(days: 2));
        await tester.pumpWidget(
          MaterialApp(
            locale: fixture.$4,
            localizationsDelegates: AppLocalizations.localizationsDelegates,
            supportedLocales: AppLocalizations.supportedLocales,
            theme: buildAppTheme(
              themeSpecById(kDefaultThemeId).light,
              Brightness.light,
            ),
            darkTheme: buildAppTheme(
              themeSpecById(kDefaultThemeId).dark,
              Brightness.dark,
            ),
            themeMode: fixture.$3 == Brightness.dark
                ? ThemeMode.dark
                : ThemeMode.light,
            home: Builder(
              builder: (context) => Scaffold(
                body: ScheduleDateTimeField(
                  value: initial,
                  onChanged: (value) => selected = value,
                  label: 'When',
                ),
              ),
            ),
          ),
        );

        await tester.tap(find.byKey(const ValueKey('schedule-at-pick')));
        await tester.pumpAndSettle();
        final pickerContext = tester.element(find.byType(DatePickerDialog));
        final l10n = AppLocalizations.of(pickerContext);
        expect(find.text(l10n.scheduleDateNext), findsOneWidget);
        await tester.tap(find.text(l10n.scheduleDateNext));
        await tester.pumpAndSettle();

        final timeContext = tester.element(find.byType(TimePickerDialog));
        final localizedOk = MaterialLocalizations.of(timeContext).okButtonLabel;
        expect(find.text(localizedOk), findsOneWidget);
        await tester.tap(find.text(localizedOk));
        await tester.pumpAndSettle();

        expect(selected?.year, initial.year);
        expect(selected?.month, initial.month);
        expect(selected?.day, initial.day);
        expect(tester.takeException(), isNull);
      },
    );
  }
}
