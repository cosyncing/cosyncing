import 'dart:ui' as ui;

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/settings/data/ui_preferences_store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Locales the UI ships translations for. Keep in sync with the ARB files under
/// `lib/l10n/` and the generated `AppLocalizations.supportedLocales`.
const List<Locale> kSupportedLocales = <Locale>[
  Locale('en'),
  Locale('zh'),
  Locale('ja'),
  Locale('ko'),
  Locale('es'),
];

/// The app's strings outside the widget tree: for [selected], or when the user
/// follows the system (null), for the first of [systemLocales] the app ships;
/// English when it ships none of them. This is the choice the widget tree's
/// own locale resolution makes. `lookupAppLocalizations` throws for any other
/// language, so a background worker must not hand it a system locale directly.
AppLocalizations resolveAppLocalizations(
  Locale? selected, {
  Iterable<Locale>? systemLocales,
}) {
  final candidates = [
    ?selected,
    ...systemLocales ?? ui.PlatformDispatcher.instance.locales,
  ];
  for (final candidate in candidates) {
    if (AppLocalizations.delegate.isSupported(candidate)) {
      return lookupAppLocalizations(candidate);
    }
  }
  return lookupAppLocalizations(kSupportedLocales.first);
}

/// Durable UI locale selection. `null` means "follow the system locale".
final localeControllerProvider =
    AsyncNotifierProvider<LocaleController, Locale?>(LocaleController.new);

/// Loads and persists the user's language choice.
class LocaleController extends AsyncNotifier<Locale?> {
  UiPreferencesStore get _store => ref.read(uiPreferencesStoreProvider);

  @override
  Future<Locale?> build() async {
    final tag = await _store.getLocaleTag();
    if (tag == null || tag.isEmpty) {
      return null;
    }
    return _localeFromTag(tag);
  }

  /// Selects a UI locale, or `null` to follow the system locale; persists it.
  Future<void> setLocale(Locale? locale) async {
    state = AsyncData(locale);
    await _store.setLocaleTag(locale?.languageCode ?? '');
  }

  static Locale _localeFromTag(String tag) {
    final parts = tag.split('-');
    if (parts.length >= 2) {
      return Locale(parts[0], parts[1]);
    }
    return Locale(parts[0]);
  }
}
