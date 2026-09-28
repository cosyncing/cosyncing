import 'dart:async';

import 'package:cosyncing_client/src/features/settings/controller/conversation_display_controller.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('malformed choices fall back independently', () {
    final prefs = ConversationDisplayPreferences.fromJson({
      'fontSize': 'bad',
      'messageSpacing': 20,
      'readingWidth': true,
      // Written by the withdrawn indicator-animation toggle; ignored.
      'animateIndicators': false,
    });
    expect(prefs.fontSize, 15);
    expect(prefs.messageSpacing, 20);
    expect(prefs.readingWidth, isTrue);
    expect(prefs.toJson().containsKey('animateIndicators'), isFalse);
  });

  test(
    'concurrent early changes retain hydrated independent choices',
    () async {
      final store = _Store();
      final container = ProviderContainer(
        overrides: [conversationDisplayStoreProvider.overrideWithValue(store)],
      );
      addTearDown(container.dispose);
      final controller = container.read(
        conversationDisplayControllerProvider.notifier,
      );
      final font = controller.updatePreferences(fontSize: 19);
      final width = controller.updatePreferences(readingWidth: true);
      store.loaded.complete(
        const ConversationDisplayPreferences(messageSpacing: 20),
      );
      await Future.wait([font, width]);
      final prefs = container
          .read(conversationDisplayControllerProvider)
          .requireValue;
      expect(prefs.fontSize, 19);
      expect(prefs.readingWidth, isTrue);
      expect(prefs.messageSpacing, 20);
      expect(store.saved.last.toJson(), prefs.toJson());
    },
  );
}

class _Store implements ConversationDisplayStore {
  final loaded = Completer<ConversationDisplayPreferences>();
  final saved = <ConversationDisplayPreferences>[];
  @override
  Future<ConversationDisplayPreferences> read() => loaded.future;
  @override
  Future<void> write(ConversationDisplayPreferences preferences) async {
    saved.add(preferences);
  }
}
