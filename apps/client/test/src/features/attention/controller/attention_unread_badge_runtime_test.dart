import 'package:cosyncing_client/src/features/attention/controller/attention_inbox_controller.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('attentionUnreadBadgeRuntimeProvider', () {
    test('seeds the unread count from the durable inbox on startup', () async {
      final container = ProviderContainer(
        overrides: [
          attentionUnseenBadgeCountProvider.overrideWith(
            (ref) async => 2,
          ),
        ],
      );
      addTearDown(container.dispose);

      container.read(attentionUnreadBadgeRuntimeProvider);
      expect(container.read(attentionUnreadCountProvider), 0);

      await container.read(attentionUnseenBadgeCountProvider.future);
      await Future<void>.delayed(Duration.zero);

      expect(container.read(attentionUnreadCountProvider), 2);
    });

    test('tracks inbox revisions after startup', () async {
      var unseen = 1;
      final container = ProviderContainer(
        overrides: [
          attentionUnseenBadgeCountProvider.overrideWith(
            (ref) async {
              ref.watch(attentionInboxRevisionProvider);
              return unseen;
            },
          ),
        ],
      );
      addTearDown(container.dispose);

      container.read(attentionUnreadBadgeRuntimeProvider);
      await container.read(attentionUnseenBadgeCountProvider.future);
      await Future<void>.delayed(Duration.zero);
      expect(container.read(attentionUnreadCountProvider), 1);

      unseen = 2;
      container.read(attentionInboxRevisionProvider.notifier).state += 1;
      await container.read(attentionUnseenBadgeCountProvider.future);
      await Future<void>.delayed(Duration.zero);
      expect(container.read(attentionUnreadCountProvider), 2);
    });
  });
}
