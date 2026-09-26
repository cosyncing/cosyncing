import 'dart:async';
import 'dart:js_interop';
import 'dart:js_interop_unsafe';

import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/src/platform/notifications/web_notification_protocol.dart';
import 'package:web/web.dart' as web;

/// The browser backend.
FlutterLocalNotificationBackend? createWebNotificationBackend() =>
    WebNotificationBackend();

/// Shows notifications through the app's own service worker (`sw.js`).
///
/// `flutter_local_notifications_web` registered a second worker whose click
/// handler opened the origin root and handed the click to whichever window
/// came first, which under the `/cosy/` mount is often not the app. This
/// backend shows through the registration that controls the app, whose
/// `notificationclick` routes to an app window (see `sw.js`), and retires the
/// plugin's worker together with anything it left on screen.
///
/// Without an active registration yet (the first visit, before `sw.js`
/// activates), it falls back to a page `Notification`. That works on desktop
/// browsers and lives only as long as the page.
final class WebNotificationBackend implements FlutterLocalNotificationBackend {
  FlutterLocalNotificationTapHandler? _onTap;
  JSFunction? _messageListener;
  final Map<int, web.Notification> _pageNotifications = {};

  Uri get _baseUrl => Uri.parse(web.document.baseURI);

  bool get _hasNotificationApi =>
      web.window.hasProperty('Notification'.toJS).toDart;

  web.ServiceWorkerContainer? get _workers =>
      web.window.navigator.hasProperty('serviceWorker'.toJS).toDart
      ? web.window.navigator.serviceWorker
      : null;

  @override
  bool get systemManagesChannels => false;

  @override
  Future<void> initialize({FlutterLocalNotificationTapHandler? onTap}) async {
    _onTap = onTap;
    final workers = _workers;
    if (workers == null || _messageListener != null) return;
    final listener = ((web.MessageEvent event) {
      final click = webNotificationClickFrom(event.data.dartify());
      if (click != null) _onTap?.call(click.payload);
    }).toJS;
    _messageListener = listener;
    workers
      ..addEventListener('message', listener)
      // Messages a worker posted before this listener existed are queued
      // until the page opts in.
      ..startMessages();
    unawaited(_retireLegacyPluginWorker(workers));
  }

  @override
  Future<String?> getLaunchPayload() async {
    final launch = webNotificationLaunchFrom(
      Uri.parse(web.window.location.href),
    );
    if (launch == null) return null;
    // Keep the history entry's state: Flutter's router stores its own there.
    web.window.history.replaceState(
      web.window.history.state,
      '',
      launch.cleanUrl,
    );
    return launch.payload;
  }

  @override
  Future<NotificationPermissionStatus> permissionStatus() async {
    if (!web.window.isSecureContext) {
      return const NotificationPermissionStatus(
        NotificationPermissionState.unsupported,
        reason: 'insecure-context',
      );
    }
    if (!_hasNotificationApi) {
      // Includes Safari on iOS outside a Home Screen web app.
      return const NotificationPermissionStatus(
        NotificationPermissionState.unsupported,
        reason: 'no-api',
      );
    }
    return webPermissionStatusFor(web.Notification.permission);
  }

  @override
  Future<NotificationPermissionStatus> requestPermission() async {
    final current = await permissionStatus();
    // A denied browser permission shows no prompt; only its site settings
    // can change it.
    if (current.state != NotificationPermissionState.notGranted) {
      return current;
    }
    final answer = await web.Notification.requestPermission().toDart;
    return webPermissionStatusFor(answer.toDart);
  }

  @override
  Future<void> configureChannels({
    required List<BrokerNotificationChannelGroup> groups,
    required List<BrokerNotificationChannel> channels,
    required Set<String> obsoleteChannelIds,
  }) async {}

  @override
  Future<Map<String, NotificationChannelState>> channelStates() async =>
      const {};

  @override
  Future<void> show({
    required int id,
    required String title,
    required String body,
    required String? payload,
    required BrokerNotificationRequest request,
  }) async {
    final base = _baseUrl;
    final tag = '$id';
    final registration = await _appRegistration();
    final options = web.NotificationOptions(
      body: body,
      // One tag per slot: showing it again replaces the notification.
      tag: tag,
      data: webNotificationData(
        payload: payload,
        alertKey: request.alertKey,
      ).jsify(),
      icon: base.resolve('icons/pwa-icon-192.png').toString(),
      badge: base.resolve('icons/pwa-monochrome-192.png').toString(),
      silent: !request.playSound,
      requireInteraction: request.channel.urgent,
      // A replacement is a new event (a newer turn, a reminder): alert again,
      // unless the push service worker already raised this very alert.
      renotify: !await _isShowing(registration, tag, request.alertKey),
      timestamp: request.createdAt.millisecondsSinceEpoch,
    );
    if (registration != null) {
      await registration.showNotification(title, options).toDart;
      return;
    }
    _pageNotifications.remove(id)?.close();
    final notification = web.Notification(title, options);
    notification.onclick = ((web.Event _) {
      _pageNotifications.remove(id);
      notification.close();
      web.window.focus();
      _onTap?.call(payload);
    }).toJS;
    _pageNotifications[id] = notification;
  }

  @override
  Future<void> clear(int id) async {
    _pageNotifications.remove(id)?.close();
    final registration = await _appRegistration();
    if (registration == null) return;
    final shown = await registration
        .getNotifications(web.GetNotificationOptions(tag: '$id'))
        .toDart;
    for (final notification in shown.toDart) {
      notification.close();
    }
  }

  @override
  Future<void> clearAll() async {
    for (final notification in _pageNotifications.values) {
      notification.close();
    }
    _pageNotifications.clear();
    final registration = await _appRegistration();
    if (registration == null) return;
    final shown = await registration.getNotifications().toDart;
    for (final notification in shown.toDart) {
      notification.close();
    }
  }

  /// Whether [registration] is showing [alertKey] under [tag] already.
  Future<bool> _isShowing(
    web.ServiceWorkerRegistration? registration,
    String tag,
    String? alertKey,
  ) async {
    if (registration == null || alertKey == null) return false;
    try {
      final shown = await registration
          .getNotifications(web.GetNotificationOptions(tag: tag))
          .toDart;
      return shown.toDart.any(
        (notification) =>
            webNotificationAlertKeyOf(notification.data.dartify()) == alertKey,
      );
    } on Object {
      return false;
    }
  }

  /// The registration controlling this page (`sw.js` at the app's scope),
  /// once it has an active worker.
  Future<web.ServiceWorkerRegistration?> _appRegistration() async {
    final workers = _workers;
    if (workers == null) return null;
    final registration = await workers.getRegistration().toDart;
    return registration?.active == null ? null : registration;
  }

  /// Closes what the plugin's worker showed and unregisters it. Its clicks
  /// would otherwise keep opening the origin root.
  Future<void> _retireLegacyPluginWorker(
    web.ServiceWorkerContainer workers,
  ) async {
    try {
      final base = _baseUrl;
      final registrations = await workers.getRegistrations().toDart;
      for (final registration in registrations.toDart) {
        if (!isLegacyPluginWorkerScope(registration.scope, base)) continue;
        try {
          final shown = await registration.getNotifications().toDart;
          for (final notification in shown.toDart) {
            notification.close();
          }
        } on Object {
          // Unregistering still stops its click handler.
        }
        await registration.unregister().toDart;
      }
    } on Object {
      // Best effort; retried on the next start.
    }
  }
}
