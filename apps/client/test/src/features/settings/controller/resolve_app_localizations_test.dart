import 'dart:ui';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/settings/controller/locale_controller.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  String languageOf(AppLocalizations l10n) => l10n.localeName;

  test('the language the user chose wins', () {
    expect(
      languageOf(
        resolveAppLocalizations(
          const Locale('zh'),
          systemLocales: const [Locale('ja')],
        ),
      ),
      'zh',
    );
  });

  test('following the system takes the first language the app ships', () {
    expect(
      languageOf(
        resolveAppLocalizations(
          null,
          systemLocales: const [Locale('fr', 'FR'), Locale('ja', 'JP')],
        ),
      ),
      'ja',
    );
    expect(
      languageOf(
        resolveAppLocalizations(
          null,
          systemLocales: const [
            Locale.fromSubtags(
              languageCode: 'zh',
              scriptCode: 'Hant',
              countryCode: 'TW',
            ),
          ],
        ),
      ),
      'zh',
    );
  });

  test('a system with no shipped language gets English, not an error', () {
    expect(
      languageOf(
        resolveAppLocalizations(
          null,
          systemLocales: const [Locale('fr', 'FR'), Locale('de')],
        ),
      ),
      'en',
    );
    expect(
      languageOf(resolveAppLocalizations(null, systemLocales: const [])),
      'en',
    );
  });
}
