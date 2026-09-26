import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:broker_client/broker_client.dart';
import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations_en.dart';
import 'package:cosyncing_client/l10n/app_localizations_zh.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_web_push_runtime.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_notification_type_settings_store.dart';
import 'package:cosyncing_client/src/features/attention/model/attention_notification_type.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/platform/notifications/web_push_subscriber.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

void main() {
  setUpAll(() {
    registerFallbackValue(
      const PushWakeTokenRegistrationRequest(platform: 'fcm', token: 'x'),
    );
  });

  final home = BrokerProfile(
    id: 'profile-home',
    displayName: 'Home',
    baseUri: Uri.parse('https://broker.example:8443/cosy/'),
    createdAt: DateTime.utc(2026, 9, 23),
    incarnationId: 'inc-1',
  );
  final other = BrokerProfile(
    id: 'profile-other',
    displayName: 'Other',
    baseUri: Uri.parse('https://other.example/'),
    createdAt: DateTime.utc(2026, 9, 23),
  );
  const turns = {'turn_finished': WebPushPresentation(title: 'Turn finished')};

  late _FakeSubscriber subscriber;
  late Map<String, _MockBrokerClient> clients;
  late WebPushRegistrar registrar;

  _MockBrokerClient clientFor(BrokerProfile profile) =>
      clients.putIfAbsent(profile.id, () {
        final client = _MockBrokerClient();
        when(client.getWebPushKey).thenAnswer(
          (_) async => WebPushKeyResponse(
            ok: true,
            publicKey: 'KEY-${profile.id}',
          ),
        );
        when(() => client.registerWakeToken(any())).thenAnswer(
          (_) async => _registered(),
        );
        when(() => client.revokeWakeToken(any())).thenAnswer(
          (_) async =>
              const PushWakeTokenRevokeResponse(ok: true, revoked: true),
        );
        return client;
      });

  List<PushWakeTokenRegistrationRequest> registrations(BrokerProfile profile) =>
      verify(
        () => clientFor(profile).registerWakeToken(captureAny()),
      ).captured.cast<PushWakeTokenRegistrationRequest>();

  setUp(() {
    subscriber = _FakeSubscriber();
    clients = {};
    registrar = WebPushRegistrar(
      subscriber: subscriber,
      createClient: (profile) async => clientFor(profile),
      deviceId: () async => 'feed-client-1',
    );
  });

  group('WebPushRegistrar', () {
    test(
      "subscribes with the Server's key and registers the subscription",
      () async {
        await registrar.reconcile(profile: home, presentation: turns);

        expect(subscriber.subscribedWith, ['KEY-profile-home']);
        final [request] = registrations(home);
        expect(request.platform, 'webpush');
        expect(request.token, '');
        expect(request.deviceId, 'feed-client-1');
        expect(request.subscription?.endpoint, subscriber.endpoint);
        expect(request.subscription?.p256dh, 'P256DH');
        expect(request.subscription?.auth, 'AUTH');
        expect(
          request.presentation?.map((id, value) => MapEntry(id, value.title)),
          {'turn_finished': 'Turn finished'},
        );
        expect(jsonDecode(request.context!), {
          'brokerProfileId': 'profile-home',
          'brokerScopeKey': RosterSource.ofProfile(home).storageKey,
        });
      },
    );

    test('sends an unchanged registration once', () async {
      await registrar.reconcile(profile: home, presentation: turns);
      await registrar.reconcile(profile: home, presentation: turns);

      expect(registrations(home), hasLength(1));
      expect(
        subscriber.subscribedWith,
        hasLength(2),
        reason: 'each pass still checks the browser kept its subscription',
      );
    });

    test(
      'registers again when the types, their wording or the endpoint change',
      () async {
        await registrar.reconcile(profile: home, presentation: turns);
        await registrar.reconcile(
          profile: home,
          presentation: const {
            'turn_finished': WebPushPresentation(title: '回合结束'),
          },
        );
        subscriber.endpoint = 'https://fcm.googleapis.com/fcm/send/renewed';
        await registrar.reconcile(
          profile: home,
          presentation: const {
            'turn_finished': WebPushPresentation(title: '回合结束'),
          },
        );

        final sent = registrations(home);
        expect(sent, hasLength(3));
        expect(
          sent.last.subscription?.endpoint,
          'https://fcm.googleapis.com/fcm/send/renewed',
        );
      },
    );

    test('withdraws: unsubscribes and revokes where it registered', () async {
      await registrar.reconcile(profile: home, presentation: turns);
      await registrar.reconcile(profile: home, presentation: null);

      expect(subscriber.unsubscribed, 1);
      verify(() => clientFor(home).revokeWakeToken('feed-client-1')).called(1);

      // Registering again after a withdrawal is not "unchanged".
      await registrar.reconcile(profile: home, presentation: turns);
      expect(registrations(home), hasLength(2));
    });

    test('with no type to push it withdraws', () async {
      await registrar.reconcile(profile: home, presentation: turns);
      await registrar.reconcile(profile: home, presentation: const {});

      expect(subscriber.unsubscribed, 1);
      verify(() => clientFor(home).revokeWakeToken('feed-client-1')).called(1);
    });

    test('a subscription left by an earlier run is revoked too', () async {
      subscriber.subscribed = true;

      await registrar.reconcile(profile: home, presentation: null);

      verify(() => clientFor(home).revokeWakeToken('feed-client-1')).called(1);
    });

    test('with nothing registered and no subscription, no request', () async {
      await registrar.reconcile(profile: home, presentation: null);
      await registrar.reconcile(profile: null, presentation: null);

      expect(clients, isEmpty);
    });

    test('a failed revoke is left to the broker', () async {
      await registrar.reconcile(profile: home, presentation: turns);
      final client = clientFor(home);
      when(
        () => client.revokeWakeToken(any()),
      ).thenThrow(const SocketException('offline'));

      await registrar.reconcile(profile: home, presentation: null);

      expect(subscriber.unsubscribed, 1);
    });

    test('a new home Server takes over from the old one', () async {
      await registrar.reconcile(profile: home, presentation: turns);
      await registrar.reconcile(profile: other, presentation: turns);

      verify(() => clientFor(home).revokeWakeToken('feed-client-1')).called(1);
      expect(registrations(other), hasLength(1));
      expect(subscriber.subscribedWith.last, 'KEY-profile-other');
    });

    test('the home Server going away withdraws from it', () async {
      await registrar.reconcile(profile: home, presentation: turns);
      await registrar.reconcile(profile: null, presentation: turns);

      verify(() => clientFor(home).revokeWakeToken('feed-client-1')).called(1);
    });

    test('an unsupported browser does nothing', () async {
      subscriber.supported = false;

      await registrar.reconcile(profile: home, presentation: turns);
      await registrar.reconcile(profile: home, presentation: null);

      expect(clients, isEmpty);
      expect(subscriber.unsubscribed, 0);
    });

    test(
      'before the worker is active nothing registers; later it does',
      () async {
        subscriber.active = false;
        await registrar.reconcile(profile: home, presentation: turns);
        verifyNever(() => clientFor(home).registerWakeToken(any()));

        subscriber.active = true;
        await registrar.reconcile(profile: home, presentation: turns);
        expect(registrations(home), hasLength(1));
      },
    );

    test('a failed registration is retried by the next pass', () async {
      final client = clientFor(home);
      when(
        () => client.registerWakeToken(any()),
      ).thenThrow(const SocketException('offline'));
      await expectLater(
        registrar.reconcile(profile: home, presentation: turns),
        throwsA(isA<SocketException>()),
      );

      when(
        () => client.registerWakeToken(any()),
      ).thenAnswer((_) async => _registered());
      await registrar.reconcile(profile: home, presentation: turns);

      expect(registrations(home), hasLength(2));
    });

    test('passes run one at a time, in order', () async {
      final gate = Completer<void>();
      subscriber.gate = gate.future;
      final first = registrar.reconcile(profile: home, presentation: turns);
      final second = registrar.reconcile(profile: home, presentation: null);
      await Future<void>.delayed(Duration.zero);
      expect(subscriber.unsubscribed, 0, reason: 'the withdrawal waits');

      gate.complete();
      await Future.wait([first, second]);

      expect(registrations(home), hasLength(1));
      expect(subscriber.unsubscribed, 1);
      verify(() => clientFor(home).revokeWakeToken('feed-client-1')).called(1);
    });
  });

  group('webPushPresentation', () {
    test('lists the enabled types with their titles and choices', () {
      final settings = AttentionNotificationTypeSettings.defaults()
          .withSetting(
            AttentionNotificationType.question,
            const AttentionNotificationTypeSetting(
              enabled: true,
              sound: false,
              showSessionTitle: false,
            ),
          )
          .withSetting(
            AttentionNotificationType.turnFailed,
            const AttentionNotificationTypeSetting(
              enabled: false,
              sound: true,
              showSessionTitle: true,
            ),
          );

      final presentation = webPushPresentation(
        settings,
        AppLocalizationsEn(),
      );

      expect(
        presentation.keys.toSet(),
        {
          for (final type in AttentionNotificationType.values)
            if (settings[type].enabled) type.id,
        },
      );
      expect(presentation, isNot(contains('turn_failed')));
      expect(
        presentation,
        isNot(contains('runtime_update')),
        reason: 'off by default',
      );
      final question = presentation['question']!;
      expect(
        question.title,
        AppLocalizationsEn().notificationTypeTitleQuestion,
      );
      expect(question.typeOnly, isTrue);
      expect(question.silent, isTrue);
      final turn = presentation['turn_finished']!;
      expect(turn.typeOnly, isFalse);
      expect(
        turn.silent,
        isTrue,
        reason: 'a finished turn is quiet by default',
      );
      expect(presentation['permission_request']!.silent, isFalse);
    });

    test("titles are in the app's language", () {
      final presentation = webPushPresentation(
        AttentionNotificationTypeSettings.defaults(),
        AppLocalizationsZh(),
      );
      expect(
        presentation['turn_finished']!.title,
        AppLocalizationsZh().notificationTypeTitleTurnFinished,
      );
    });
  });

  group('webPushHomeProfile', () {
    test('is the profile at the page origin, port included', () {
      expect(
        webPushHomeProfile([
          other,
          home,
        ], pageOrigin: Uri.parse('https://broker.example:8443/cosy/#/x')),
        same(home),
      );
      expect(
        webPushHomeProfile([
          home,
        ], pageOrigin: Uri.parse('https://broker.example/cosy/')),
        isNull,
      );
      expect(
        webPushHomeProfile(const [], pageOrigin: Uri.parse('https://a.b/')),
        isNull,
      );
    });
  });

  group('shared vectors with the service worker', () {
    // scripts/client/tests/test-web-push-notification.ts reads the same file,
    // so a push and the app's own notification of one event share a tag and an
    // alert key.
    final vectors =
        jsonDecode(
              File(
                'test/fixtures/web_push_notification_vectors.json',
              ).readAsStringSync(),
            )
            as Map<String, dynamic>;

    test("every tag is the app's platform id for the slot", () {
      final tags = (vectors['tags'] as List<dynamic>)
          .cast<Map<String, dynamic>>();
      expect(tags.length, greaterThanOrEqualTo(5));
      for (final vector in tags) {
        final slot = brokerAttentionNotificationId(
          brokerProfileId: vector['brokerProfileId'] as String,
          dedupeKey: vector['collapseKey'] as String,
        );
        expect(
          '${FlutterLocalNotificationSink.derivePlatformNotificationId(slot)}',
          vector['tag'],
          reason: vector['name'] as String,
        );
      }
    });

    test('every alert key is the one the app raises', () {
      for (final vector
          in (vectors['alertKeys'] as List<dynamic>)
              .cast<Map<String, dynamic>>()) {
        expect(
          attentionNotificationAlertKey(
            eventId: vector['eventId'] as String,
            revision: vector['revision'] as int,
            stage: vector['stage'] as String,
          ),
          vector['alertKey'],
          reason: vector['name'] as String,
        );
      }
    });

    test('the worker keeps the same types on screen', () {
      final worker = File('web/sw.js').readAsStringSync();
      final declared = RegExp(
        r'const URGENT_NOTIFICATION_TYPES = \[([^\]]*)\]',
      ).firstMatch(worker);
      expect(declared, isNotNull);
      final ids = RegExp(
        "'([^']+)'",
      ).allMatches(declared!.group(1)!).map((match) => match.group(1));
      expect(ids.toSet(), {
        for (final type in AttentionNotificationType.values)
          if (type.urgent) type.id,
      });
    });
  });
}

PushWakeTokenRegistrationResponse _registered() =>
    const PushWakeTokenRegistrationResponse(
      ok: true,
      registration: PushWakeTokenRegistration(
        deviceId: 'feed-client-1',
        platform: 'webpush',
        tokenPreview: 'https://fcm.googleapis.com',
        createdAt: '2026-09-23T00:00:00.000Z',
        updatedAt: '2026-09-23T00:00:00.000Z',
      ),
    );

class _MockBrokerClient extends Mock implements BrokerClient {}

final class _FakeSubscriber implements WebPushSubscriber {
  @override
  bool supported = true;

  /// Whether the app's service worker is active.
  bool active = true;

  bool subscribed = false;
  String endpoint = 'https://fcm.googleapis.com/fcm/send/abc';
  Future<void>? gate;
  final List<String> subscribedWith = [];
  int unsubscribed = 0;

  @override
  Future<WebPushSubscription?> subscribe(String publicKey) async {
    await gate;
    if (!active) return null;
    subscribedWith.add(publicKey);
    subscribed = true;
    return WebPushSubscription(
      endpoint: endpoint,
      p256dh: 'P256DH',
      auth: 'AUTH',
    );
  }

  @override
  Future<bool> unsubscribe() async {
    await gate;
    if (!subscribed) return false;
    subscribed = false;
    unsubscribed += 1;
    return true;
  }
}
