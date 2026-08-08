import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/errors/localized_user_facing_error.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'localized failure copy keeps raw diagnostics out of both locales',
    () async {
      final error = StateError('private platform diagnostic');
      final en = await AppLocalizations.delegate.load(const Locale('en'));
      final zh = await AppLocalizations.delegate.load(const Locale('zh'));

      final enMessage = localizedFailureMessage(
        en,
        error,
        lead: en.attentionInboxLoadFailed,
      );
      final zhMessage = localizedFailureMessage(
        zh,
        error,
        lead: zh.attentionInboxLoadFailed,
      );

      expect(enMessage, contains("Couldn't load your inbox"));
      expect(zhMessage, contains('无法加载通知中心'));
      for (final message in [enMessage, zhMessage]) {
        expect(message, isNot(contains('private platform diagnostic')));
        expect(message, isNot(contains('Bad state')));
      }
    },
  );

  test('broker failures receive classified localized advice', () async {
    final l10n = await AppLocalizations.delegate.load(const Locale('en'));

    final message = localizedFailureMessage(
      l10n,
      const BrokerException(message: 'connection refused'),
      lead: l10n.brokerProfilesLoadFailed,
    );

    expect(message, contains("broker didn't respond"));
    expect(message, isNot(contains('connection refused')));
  });
}
