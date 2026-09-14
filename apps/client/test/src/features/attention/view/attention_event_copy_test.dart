import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/attention/view/attention_event_copy.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('uses localized names for non-command agent brands', () async {
    final l10n = await AppLocalizations.delegate.load(const Locale('en'));

    expect(attentionToolDisplayName('reasonix', l10n), 'Reasonix');
    expect(attentionToolDisplayName('ReAsOnIx', l10n), 'Reasonix');
    expect(attentionToolDisplayName('grok', l10n), 'Grok Build');
    expect(attentionToolDisplayName('GrOk', l10n), 'Grok Build');
  });
}
