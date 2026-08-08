import 'package:cosyncing_client/src/features/attention/controller/attention_feed_coordinator.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_feed_settings_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('AttentionFeedCoordinator', () {
    test('starts every saved profile by default (feeds are opt-out)', () async {
      final settings = _MemorySettingsStore();
      final runners = <String, _FakeRunner>{};
      final coordinator = AttentionFeedCoordinator(
        settingsStore: settings,
        createRunner: (profile) async =>
            runners.putIfAbsent(profile.id, _FakeRunner.new),
      );

      await coordinator.reconcile(
        notificationsEnabled: true,
        profiles: [_profile('one'), _profile('two')],
        activeProfileId: 'two',
      );

      expect(runners.keys, {'one', 'two'});
      expect(coordinator.runningProfileIds, {'one', 'two'});
      expect(
        await settings.listDisabledProfileIds(),
        isEmpty,
        reason: 'default-on polling must not write any explicit setting',
      );
      await coordinator.stop();
    });

    test('never starts a profile whose feed was explicitly disabled', () async {
      final settings = _MemorySettingsStore(disabled: {'one'});
      final runners = <String, _FakeRunner>{};
      final coordinator = AttentionFeedCoordinator(
        settingsStore: settings,
        createRunner: (profile) async =>
            runners.putIfAbsent(profile.id, _FakeRunner.new),
      );

      await coordinator.reconcile(
        notificationsEnabled: true,
        profiles: [_profile('one')],
        activeProfileId: 'one',
      );

      expect(runners, isEmpty);
      await coordinator.stop();
    });

    test('does not start feeds for unsaved profiles', () async {
      final settings = _MemorySettingsStore();
      final runners = <String, _FakeRunner>{};
      final coordinator = AttentionFeedCoordinator(
        settingsStore: settings,
        createRunner: (profile) async =>
            runners.putIfAbsent(profile.id, _FakeRunner.new),
      );

      await coordinator.reconcile(
        notificationsEnabled: true,
        profiles: [_profile('one')],
        activeProfileId: 'one',
      );

      expect(runners.keys, {'one'});
      await coordinator.stop();
    });

    test(
      'presentation change recreates workers without disabling feeds',
      () async {
        final settings = _MemorySettingsStore();
        final runners = <_FakeRunner>[];
        final coordinator = AttentionFeedCoordinator(
          settingsStore: settings,
          createRunner: (_) async {
            final runner = _FakeRunner();
            runners.add(runner);
            return runner;
          },
        );

        await coordinator.reconcile(
          notificationsEnabled: true,
          profiles: [_profile('one')],
          activeProfileId: 'one',
        );
        await coordinator.reconcile(
          notificationsEnabled: false,
          profiles: [_profile('one')],
          activeProfileId: 'one',
          restartExisting: true,
        );

        expect(runners, hasLength(2));
        expect(runners.first.stopCalls, 1);
        expect(runners.last.startCalls, 1);
        expect(coordinator.runningProfileIds, {'one'});
        expect(await settings.listDisabledProfileIds(), isEmpty);
        await coordinator.stop();
      },
    );

    test(
      'does not depend on active profile id for the disabled set',
      () async {
        final settings = _MemorySettingsStore(disabled: {'two'});
        final runners = <String, _FakeRunner>{};
        final coordinator = AttentionFeedCoordinator(
          settingsStore: settings,
          createRunner: (profile) async =>
              runners.putIfAbsent(profile.id, _FakeRunner.new),
        );

        await coordinator.reconcile(
          notificationsEnabled: true,
          profiles: [_profile('one'), _profile('two')],
          activeProfileId: 'two',
        );

        expect(runners, contains('one'));
        expect(runners, isNot(contains('two')));
        await coordinator.stop();
      },
    );

    test('opting a profile out stops only its runner', () async {
      final settings = _MemorySettingsStore();
      final runners = <String, _FakeRunner>{};
      final coordinator = AttentionFeedCoordinator(
        settingsStore: settings,
        createRunner: (profile) async =>
            runners.putIfAbsent(profile.id, _FakeRunner.new),
      );

      await coordinator.reconcile(
        notificationsEnabled: true,
        profiles: [_profile('one'), _profile('two')],
        activeProfileId: 'one',
      );
      await settings.setFeedEnabled(brokerProfileId: 'two', enabled: false);
      await coordinator.reconcile(
        notificationsEnabled: true,
        profiles: [_profile('one'), _profile('two')],
        activeProfileId: 'one',
      );

      expect(runners['one']!.stopCalls, 0);
      expect(runners['two']!.stopCalls, 1);
      expect(coordinator.runningProfileIds, {'one'});
      await coordinator.stop();
    });

    test('repoints an existing profile by replacing its runner', () async {
      final settings = _MemorySettingsStore();
      final runners = <_FakeRunner>[];
      final endpoints = <Uri>[];
      final coordinator = AttentionFeedCoordinator(
        settingsStore: settings,
        createRunner: (profile) async {
          endpoints.add(profile.baseUri);
          final runner = _FakeRunner();
          runners.add(runner);
          return runner;
        },
      );

      await coordinator.reconcile(
        notificationsEnabled: true,
        profiles: [_profileAt('one', 'http://alpha.test')],
        activeProfileId: 'one',
      );
      await coordinator.reconcile(
        notificationsEnabled: true,
        profiles: [_profileAt('one', 'http://beta.test')],
        activeProfileId: 'one',
      );

      expect(endpoints.map((uri) => uri.host), ['alpha.test', 'beta.test']);
      expect(runners, hasLength(2));
      expect(runners.first.stopCalls, 1);
      expect(runners.last.startCalls, 1);
      await coordinator.stop();
    });

    test('failed runner creation does not block healthy profiles', () async {
      final settings = _MemorySettingsStore();
      final errors = <String>[];
      final coordinator = AttentionFeedCoordinator(
        settingsStore: settings,
        createRunner: (profile) async {
          if (profile.id == 'bad') throw StateError('offline');
          return _FakeRunner();
        },
        onProfileError: (profileId, _) => errors.add(profileId),
      );

      await coordinator.reconcile(
        notificationsEnabled: true,
        profiles: [_profile('bad'), _profile('good')],
        activeProfileId: 'good',
      );

      expect(coordinator.runningProfileIds, {'good'});
      expect(errors, ['bad']);
      await coordinator.stop();
    });
  });
}

BrokerProfile _profile(String id) => BrokerProfile(
  id: id,
  displayName: id,
  baseUri: Uri.parse('http://127.0.0.1:7734/$id'),
  createdAt: DateTime(2026),
);

BrokerProfile _profileAt(String id, String endpoint) => BrokerProfile(
  id: id,
  displayName: id,
  baseUri: Uri.parse(endpoint),
  createdAt: DateTime(2026),
);

final class _FakeRunner implements AttentionFeedRunner {
  int startCalls = 0;
  int stopCalls = 0;

  @override
  void start() => startCalls += 1;

  @override
  Future<void> stop() async => stopCalls += 1;
}

final class _MemorySettingsStore implements AttentionFeedSettingsStore {
  _MemorySettingsStore({Set<String>? disabled}) : _disabled = {...?disabled};

  final Set<String> _disabled;

  @override
  Future<bool> isFeedEnabled(String brokerProfileId) async =>
      !_disabled.contains(brokerProfileId);

  @override
  Future<List<String>> listDisabledProfileIds() async {
    final result = _disabled.toList()..sort();
    return result;
  }

  @override
  Future<void> setFeedEnabled({
    required String brokerProfileId,
    required bool enabled,
  }) async {
    if (enabled) {
      _disabled.remove(brokerProfileId);
    } else {
      _disabled.add(brokerProfileId);
    }
  }
}
