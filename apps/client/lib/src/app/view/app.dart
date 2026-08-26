import 'dart:async';
import 'dart:convert';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/app/router/router.dart';
import 'package:cosyncing_client/src/app/router/session_routes.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/ui_scale.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_runtime.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_inbox_controller.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_remote_wake_runtime.dart';
import 'package:cosyncing_client/src/features/attention/model/attention_inbox.dart';
import 'package:cosyncing_client/src/features/attention/view/foreground_attention_host.dart';
import 'package:cosyncing_client/src/features/broker_profiles/controller/broker_profile_manager_controller.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/connection/view/broker_auth_barrier.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_notification_hooks.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/settings/controller/locale_controller.dart';
import 'package:cosyncing_client/src/features/settings/controller/theme_controller.dart';
import 'package:cosyncing_client/src/features/settings/controller/ui_scale_controller.dart';
import 'package:cosyncing_client/src/platform/startup/browser_close_protection.dart';
import 'package:cosyncing_client/src/platform/startup/startup_shell.dart';
import 'package:cosyncing_client/src/platform/update/web_client_update_provider.dart';
import 'package:cosyncing_client/src/platform/update/web_handoff_bridge.dart';
import 'package:cosyncing_client/src/platform/update/web_handoff_freeze.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Root widget for the cosyncing client.
///
/// Sets up theming and delegates routing to [goRouter].
class App extends ConsumerStatefulWidget {
  /// Creates the root [App] widget.
  const App({super.key});

  @override
  ConsumerState<App> createState() => _AppState();
}

class _AppState extends ConsumerState<App> {
  /// Guards the one-shot browser startup-shell handshake (N3).
  bool _announcedFirstFrame = false;
  Future<void> _attentionNavigationTail = Future<void>.value();

  @override
  void initState() {
    super.initState();
    // N3b: give the participant registry its browser hook before any surface
    // can register. Installing it here — rather than from the first
    // registration — keeps the whole JS-interop dependency in one place and
    // compiles to a no-op on native.
    installWebHandoffBridge();
    // The browser shell in `web/index.html` is removed by this callback and
    // nothing else. A post-frame callback runs after the frame has been built
    // and painted, so real app chrome is on screen before the shell fades;
    // signalling any earlier (loader done, engine ready, runApp returned) would
    // uncover a blank page. Native builds compile this to a no-op.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_announcedFirstFrame) return;
      _announcedFirstFrame = true;
      notifyStartupShellFirstFrame();
    });
  }

  @override
  Widget build(BuildContext context) {
    ref
      ..watch(activeBrokerProfileHydrationProvider)
      ..watch(attentionFeedRuntimeProvider)
      ..watch(attentionRemoteWakeRuntimeProvider)
      ..watch(attentionMutationDrainRuntimeProvider)
      ..watch(attentionUnreadBadgeRuntimeProvider)
      ..watch(sessionNotificationLaunchBootstrapProvider)
      ..listen(sessionNotificationTapPayloadProvider, (_, payload) {
        if (payload == null) return;
        // A tap is navigation only. Read/dismiss state changes only after an
        // explicit inbox action, as required by the attention UX contract.
        WidgetsBinding.instance.addPostFrameCallback((_) {
          final pendingPayload = ref.read(
            sessionNotificationTapPayloadProvider,
          );
          if (pendingPayload == null) return;
          _openNotificationPayload(pendingPayload);
          ref.read(sessionNotificationTapPayloadProvider.notifier).state = null;
        });
      });

    WidgetsBinding.instance.addPostFrameCallback((_) {
      final pendingPayload = ref.read(sessionNotificationTapPayloadProvider);
      if (pendingPayload == null) return;
      _openNotificationPayload(pendingPayload);
      ref.read(sessionNotificationTapPayloadProvider.notifier).state = null;
    });

    final themeSelection =
        ref.watch(themeControllerProvider).valueOrNull ??
        kFallbackThemeSelection;
    final spec = themeSelection.spec;
    final locale = ref.watch(localeControllerProvider).valueOrNull;
    final uiScale =
        ref.watch(uiScaleControllerProvider).valueOrNull ??
        kDefaultUiScaleSettings;
    final density = uiScale.density.visualDensity;
    final openSessions = ref.watch(openSessionsControllerProvider).valueOrNull;
    setBrowserCloseProtection(enabled: openSessions?.isEmpty == false);
    return MaterialApp.router(
      onGenerateTitle: (context) => AppLocalizations.of(context).appTitle,
      theme: buildAppTheme(spec.light, Brightness.light, density: density),
      darkTheme: buildAppTheme(spec.dark, Brightness.dark, density: density),
      themeMode: themeSelection.mode,
      locale: locale,
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      // WebHandoffFreeze outermost: during a web-update commit window every
      // pointer and key must be refused, including in dialogs and the global
      // overlay below, or a keystroke typed after this tab agreed to move
      // would be lost with the document (N3b).
      builder: (context, child) => WebHandoffFreeze(
        child: _TextScaleOverride(
          scale: uiScale.textScale,
          // MaterialApp's builder sits above the router Navigator. Install one
          // app-level Overlay so selectable global notices and foreground
          // notifications have the lookup ancestor they require.
          child: _AppRootOverlay(
            onOpenAttention: () => goRouter.go(attentionRoute),
            onOpenAttentionEntry: _openForegroundAttention,
            child: child,
          ),
        ),
      ),
      routerConfig: goRouter,
    );
  }

  void _openForegroundAttention(AttentionInboxEntry? entry) {
    if (entry == null) {
      goRouter.go(attentionRoute);
      return;
    }
    if (entry.event.action.kind != 'open-session') {
      _openAttentionAction(
        actionKind: entry.event.action.kind,
        tool: entry.event.action.tool,
        sessionId: entry.event.action.sessionId,
      );
      return;
    }
    _queueAttentionNavigation(() async {
      await ref
          .read(brokerProfileManagerControllerProvider)
          .setActiveProfile(
            entry.profile.id,
            expectedProfile: entry.profile,
          );
      _openAttentionAction(
        actionKind: entry.event.action.kind,
        tool: entry.event.action.tool,
        sessionId: entry.event.action.sessionId,
      );
    });
  }

  void _openNotificationPayload(String payload) {
    _queueAttentionNavigation(() async {
      try {
        final decoded = jsonDecode(payload);
        if (decoded is! Map<String, dynamic> ||
            decoded['kind'] != 'attention-event') {
          goRouter.go(attentionRoute);
          return;
        }
        final profileId = decoded['brokerProfileId'];
        final sourceKey = decoded['brokerScopeKey'];
        if (profileId is! String || sourceKey is! String) {
          goRouter.go(attentionRoute);
          return;
        }
        final profile = await ref
            .read(brokerProfileRepositoryProvider)
            .getById(profileId);
        if (profile == null ||
            RosterSource.ofProfile(profile).storageKey != sourceKey) {
          goRouter.go(attentionRoute);
          return;
        }
        await ref
            .read(brokerProfileManagerControllerProvider)
            .setActiveProfile(profile.id, expectedProfile: profile);
        _openAttentionAction(
          actionKind: decoded['actionKind'] as String?,
          tool: decoded['tool'] as String?,
          sessionId: decoded['sessionId'] as String?,
        );
      } on Object {
        goRouter.go(attentionRoute);
      }
    });
  }

  void _queueAttentionNavigation(Future<void> Function() navigation) {
    _attentionNavigationTail = _attentionNavigationTail
        .then((_) => navigation())
        .catchError((Object _) {
          goRouter.go(attentionRoute);
        });
  }

  void _openAttentionAction({
    required String? actionKind,
    required String? tool,
    required String? sessionId,
  }) {
    if (actionKind == 'open-session' && tool != null && sessionId != null) {
      goRouter.go(sessionDetailLocation(tool: tool, sessionId: sessionId));
      return;
    }
    if (actionKind == 'open-runtime-settings' ||
        actionKind == 'open-quota-settings' ||
        actionKind == 'open-broker-health') {
      goRouter.go(settingsRoute);
      return;
    }
    goRouter.go(attentionRoute);
  }
}

class _AppRootOverlay extends StatefulWidget {
  const _AppRootOverlay({
    required this.onOpenAttention,
    required this.onOpenAttentionEntry,
    required this.child,
  });

  final VoidCallback onOpenAttention;
  final ValueChanged<AttentionInboxEntry?> onOpenAttentionEntry;
  final Widget? child;

  @override
  State<_AppRootOverlay> createState() => _AppRootOverlayState();
}

class _AppRootOverlayState extends State<_AppRootOverlay> {
  late final OverlayEntry _entry = OverlayEntry(builder: _buildEntry);

  @override
  void didUpdateWidget(covariant _AppRootOverlay oldWidget) {
    super.didUpdateWidget(oldWidget);
    _entry.markNeedsBuild();
  }

  Widget _buildEntry(BuildContext context) {
    return Consumer(
      builder: (context, ref, _) {
        final webUpdate = ref.watch(webClientUpdateProvider).valueOrNull;
        return Stack(
          children: [
            ForegroundAttentionHost(
              onOpen: widget.onOpenAttention,
              onOpenEntry: widget.onOpenAttentionEntry,
              child: BrokerAuthBarrier(child: widget.child),
            ),
            // N3b: a waiting build is routine and shows nothing — the page's
            // handoff coordinator moves this tab through the swap by itself.
            // Only a handoff that was really attempted and never landed earns
            // a surface, and even then a nonblocking one.
            if (webUpdate?.handoffFailed ?? false)
              const _WebClientUpdateBanner(),
          ],
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) => Overlay(initialEntries: [_entry]);
}

/// Nonblocking recovery notice for a handoff that really did not land (N3b).
///
/// Never shown for a routine update. By the time this renders, this tab has
/// spent its bounded attempt budget moving itself out of the app scope and
/// coming back to find the previous build still in control — which happens when
/// another Cosyncing tab is frozen, is being edited, or cannot be coordinated
/// with at all. Closing the other tabs is the one thing the user can do, so
/// that is what it says.
class _WebClientUpdateBanner extends StatelessWidget {
  const _WebClientUpdateBanner();

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    final colors = Theme.of(context).colorScheme;
    return SafeArea(
      child: Align(
        alignment: Alignment.topCenter,
        child: Material(
          key: const Key('web-client-update-handoff-failed'),
          color: colors.tertiaryContainer,
          elevation: 2,
          borderRadius: BorderRadius.circular(tokens.radiusMd),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 720),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    Icons.system_update_alt,
                    size: 18,
                    color: colors.onTertiaryContainer,
                  ),
                  const SizedBox(width: 8),
                  Flexible(
                    child: SelectionArea(
                      child: Text(
                        l10n.appUpdateHandoffFailedMessage,
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: colors.onTertiaryContainer,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Applies the user's [UiTextScale] to the whole app.
///
/// A [UiTextScale.system] choice leaves the inherited (OS-driven) [TextScaler]
/// untouched; any other choice pins the app to a fixed factor. Installed once
/// at the [MaterialApp.builder] root so every screen scales together.
class _TextScaleOverride extends StatelessWidget {
  const _TextScaleOverride({required this.scale, required this.child});

  final UiTextScale scale;
  final Widget? child;

  @override
  Widget build(BuildContext context) {
    final body = child ?? const SizedBox.shrink();
    final factor = scale.factor;
    if (factor == null) {
      return body;
    }
    final media = MediaQuery.of(context);
    return MediaQuery(
      data: media.copyWith(textScaler: TextScaler.linear(factor)),
      child: body,
    );
  }
}
