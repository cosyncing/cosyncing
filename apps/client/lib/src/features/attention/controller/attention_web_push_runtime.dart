import 'dart:async';
import 'dart:convert';

import 'package:broker_client/broker_client.dart';
import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_inbox_controller.dart';
import 'package:cosyncing_client/src/features/attention/controller/notification_system_controller.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_feed_settings_store.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_notification_type_settings_store.dart';
import 'package:cosyncing_client/src/features/attention/model/attention_notification_type.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_notification_hooks.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/settings/controller/locale_controller.dart';
import 'package:cosyncing_client/src/features/settings/controller/session_notification_settings_controller.dart';
import 'package:cosyncing_client/src/platform/notifications/web_push_subscriber.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// The browser's push subscription, replaceable in tests.
final webPushSubscriberProvider = Provider<WebPushSubscriber>(
  (_) => createWebPushSubscriber(),
);

/// Keeps this browser's Web Push registration in step with the settings.
final webPushRegistrarProvider = Provider<WebPushRegistrar>((ref) {
  return WebPushRegistrar(
    subscriber: ref.watch(webPushSubscriberProvider),
    createClient: (profile) => createAttentionBrokerClient(ref, profile),
    deviceId: () => ref.read(attentionClientIdProvider.future),
  );
});

/// Root-app trigger: in a browser, registers for Web Push with the Server that
/// serves this web app while notifications are on and allowed, so a
/// notification arrives with every tab closed. It withdraws the registration
/// when either goes off.
///
/// Only that one Server: a browser holds one push subscription per app, bound
/// to one server key. Other paired Servers keep notifying through the feed
/// while a tab is open.
///
/// Each return to the app checks again, so a registration that failed, or a
/// subscription the browser dropped, is restored.
final attentionWebPushRuntimeProvider = Provider<void>((ref) {
  if (!kIsWeb) return;
  final enabled = ref
      .watch(sessionNotificationSettingsControllerProvider)
      .valueOrNull;
  final permission = ref.watch(notificationPermissionControllerProvider);
  final types = ref.watch(attentionNotificationTypeSettingsControllerProvider);
  final locale = ref.watch(localeControllerProvider);
  final profiles = ref.watch(brokerProfileListProvider);
  ref.watch(attentionFeedSettingsRevisionProvider);
  if (enabled == null ||
      !permission.hasValue ||
      !types.hasValue ||
      !locale.hasValue ||
      !profiles.hasValue) {
    return;
  }
  final registrar = ref.read(webPushRegistrarProvider);
  final allowed =
      enabled &&
      permission.requireValue.state == NotificationPermissionState.granted;
  final l10n = resolveAppLocalizations(locale.value);
  Future<void> reconcile() async {
    final disabled =
        (await ref
                .read(attentionFeedSettingsStoreProvider)
                .listDisabledProfileIds())
            .toSet();
    final home = webPushHomeProfile(
      profiles.requireValue,
      pageOrigin: Uri.base,
    );
    await registrar.reconcile(
      profile: home,
      presentation: allowed && home != null && !disabled.contains(home.id)
          ? webPushPresentation(types.requireValue, l10n)
          : null,
    );
  }

  void run() => unawaited(reconcile().catchError((Object _) {}));

  run();
  final subscription = ref
      .watch(sessionNotificationLifecycleMonitorProvider)
      .stateChanges
      .listen((state) {
        if (state == BrokerAppLifecycleState.resumed) run();
      });
  ref.onDispose(() => unawaited(subscription.cancel()));
});

/// The paired Server that serves this web app, if any.
BrokerProfile? webPushHomeProfile(
  List<BrokerProfile> profiles, {
  required Uri pageOrigin,
}) {
  for (final profile in profiles) {
    if (profile.baseUri.origin == pageOrigin.origin) return profile;
  }
  return null;
}

/// The types to push and how each appears: every type the user has on, with
/// its title in the app's language, its "event type only" choice, and whether
/// it plays a sound.
Map<String, WebPushPresentation> webPushPresentation(
  AttentionNotificationTypeSettings settings,
  AppLocalizations l10n,
) => {
  for (final type in AttentionNotificationType.values)
    if (settings[type].enabled)
      type.id: WebPushPresentation(
        title: attentionNotificationTitle(type, l10n),
        typeOnly: !settings[type].showSessionTitle,
        silent: !settings[type].sound,
      ),
};

/// Registers this browser's push subscription with one Server, and withdraws
/// it. Calls are serialized, and a registration the broker already holds is
/// not sent again.
final class WebPushRegistrar {
  /// Creates a registrar over [subscriber].
  WebPushRegistrar({
    required this.subscriber,
    required this.createClient,
    required this.deviceId,
  });

  /// The browser's push subscription.
  final WebPushSubscriber subscriber;

  /// Authenticated broker client for a profile.
  final Future<BrokerClient> Function(BrokerProfile profile) createClient;

  /// This client's attention feed id: the broker skips a push for an event
  /// this id has already read or dismissed.
  final Future<String> Function() deviceId;

  Future<void> _tail = Future<void>.value();
  BrokerProfile? _registeredWith;
  String? _registered;

  /// Registers with [profile] when [presentation] is given, and withdraws
  /// otherwise. [profile] is the Server that serves this web app, if any.
  Future<void> reconcile({
    required BrokerProfile? profile,
    required Map<String, WebPushPresentation>? presentation,
  }) {
    final run = _tail.then((_) => _reconcile(profile, presentation));
    _tail = run.catchError((Object _) {});
    return run;
  }

  Future<void> _reconcile(
    BrokerProfile? profile,
    Map<String, WebPushPresentation>? presentation,
  ) async {
    if (!subscriber.supported) return;
    final previous = _registeredWith;
    if (profile == null || presentation == null || presentation.isEmpty) {
      await _withdraw(previous ?? profile);
      return;
    }
    if (previous != null && previous.id != profile.id) {
      await _withdraw(previous);
    }
    final client = await createClient(profile);
    final key = await client.getWebPushKey();
    final subscription = await subscriber.subscribe(key.publicKey);
    if (subscription == null) return;
    final request = PushWakeTokenRegistrationRequest.webPush(
      deviceId: await deviceId(),
      subscription: subscription,
      presentation: presentation,
      context: jsonEncode({
        'brokerProfileId': profile.id,
        'brokerScopeKey': RosterSource.ofProfile(profile).storageKey,
      }),
    );
    final signature = '${profile.id}\n${jsonEncode(request.toJson())}';
    if (_registered == signature) return;
    await client.registerWakeToken(request);
    _registeredWith = profile;
    _registered = signature;
  }

  /// Drops the browser's subscription and, when there was something to
  /// withdraw, [profile]'s registration of it.
  Future<void> _withdraw(BrokerProfile? profile) async {
    final hadSubscription = await subscriber.unsubscribe();
    final known = _registeredWith != null;
    _registeredWith = null;
    _registered = null;
    if (profile == null || (!hadSubscription && !known)) return;
    try {
      final client = await createClient(profile);
      await client.revokeWakeToken(await deviceId());
    } on Object {
      // The broker drops a dead subscription itself on its next push.
    }
  }
}
