import 'package:cosyncing_client/src/features/settings/data/conversation_display_store.dart';
import 'package:cosyncing_client/src/features/settings/model/conversation_display_preferences.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

export 'package:cosyncing_client/src/features/settings/data/conversation_display_store.dart'
    show ConversationDisplayStore, conversationDisplayStoreProvider;
export 'package:cosyncing_client/src/features/settings/model/conversation_display_preferences.dart'
    show ConversationDisplayPreferences;

/// Persisted conversation appearance, independent of app text/density choices.
final conversationDisplayControllerProvider =
    AsyncNotifierProvider<
      ConversationDisplayController,
      ConversationDisplayPreferences
    >(ConversationDisplayController.new);

/// Hydrates preferences before merging changes, so early edits retain choices.
class ConversationDisplayController
    extends AsyncNotifier<ConversationDisplayPreferences> {
  Future<void> _writes = Future<void>.value();

  @override
  Future<ConversationDisplayPreferences> build() =>
      ref.watch(conversationDisplayStoreProvider).read();

  /// Updates only the requested fields and saves writes in interaction order.
  Future<void> updatePreferences({
    double? fontSize,
    double? messageSpacing,
    bool? readingWidth,
  }) async {
    if (state.valueOrNull == null) await future;
    final current = state.requireValue;
    final next = current.copyWith(
      fontSize: fontSize,
      messageSpacing: messageSpacing,
      readingWidth: readingWidth,
    );
    state = AsyncData(next);
    final store = ref.read(conversationDisplayStoreProvider);
    _writes = _writes.catchError((Object _) {}).then((_) => store.write(next));
    await _writes;
  }
}
