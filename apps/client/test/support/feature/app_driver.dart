// Page-object driver over the real App: product verbs, bounded waits.
//
// All waiting is frame pumping under flutter_test's fake clock. Nothing here
// sleeps on the wall clock, and no wait is an assertion: a condition that
// never arrives fails with a named reason after a bounded number of frames.
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'cosyncing_app.dart';
import 'fake_broker.dart';

/// Drives one running App instance.
class AppDriver {
  /// Wraps an App launched by [FeatureContext.launch].
  AppDriver(
    this.tester, {
    required this.container,
    required this.router,
    required this.network,
    required this.storage,
  });

  /// The widget tester.
  final WidgetTester tester;

  /// The App's provider container (read-only use: assertions on state).
  final ProviderContainer container;

  /// The App's router.
  final GoRouter router;

  /// The fake network the App talks to.
  final FakeBrokerNetwork network;

  /// The device storage the App runs over.
  final FeatureStorage storage;

  /// Fake-time step of every bounded wait.
  static const Duration step = Duration(milliseconds: 50);

  /// Steps a bounded wait may take before it fails (20 s of fake time).
  static const int maxSteps = 400;

  /// Steps a wait takes at [step] before it widens (see [pumpUntil]).
  static const int fineSteps = 12;

  /// Fake-time step of a wait that has outlasted [fineSteps].
  static const Duration widenedStep = Duration(milliseconds: 400);

  // --- time -----------------------------------------------------------------

  /// Lets one turn of the real event loop pass (no fake time elapses).
  ///
  /// Drift closes a cancelled stream query on a timer that flutter_test's
  /// clock never fires, so anything awaiting a stream cancellation (the
  /// open-session set rebuilding on a server switch) would otherwise wait
  /// forever. One empty turn of the real loop completes it.
  Future<void> flushRealAsync() async {
    await tester.runAsync(() async {});
  }

  /// Lets pending work land: flushes microtasks, then pumps until no frame is
  /// scheduled, advancing at most [budget] of fake time.
  ///
  /// Returns quietly when an indefinite animation (a spinner over a held
  /// request) keeps scheduling frames: callers assert what they expect next.
  Future<void> settle({
    Duration budget = const Duration(milliseconds: 600),
  }) async {
    await flushRealAsync();
    await tester.pump();
    var spent = Duration.zero;
    while (spent < budget && tester.binding.hasScheduledFrame) {
      await tester.pump(const Duration(milliseconds: 100));
      spent += const Duration(milliseconds: 100);
    }
  }

  /// Pumps [every] (default [step]) until [condition] holds, then settles.
  ///
  /// Use a coarser [every] to cross long product timers (retry backoff,
  /// request timeouts) without rendering thousands of frames. A wait that is
  /// still going after [fineSteps] steps is crossing such a timer anyway, so
  /// its step then widens (to [widenedStep]) rather than paying a frame every
  /// [every] for seconds of fake time. The wait still ends on the first frame
  /// where [condition] holds and still fails after [steps] * [every] of fake
  /// time.
  Future<void> pumpUntil(
    bool Function() condition, {
    required String reason,
    int steps = maxSteps,
    Duration every = step,
  }) async {
    final limit = every * steps;
    var waited = Duration.zero;
    var taken = 0;
    while (waited < limit) {
      if (condition()) {
        await settle();
        return;
      }
      await flushRealAsync();
      final next = taken < fineSteps || every >= widenedStep
          ? every
          : widenedStep;
      await tester.pump(next);
      waited += next;
      taken++;
    }
    if (condition()) return;
    fail('Waited $limit of fake time for: $reason');
  }

  /// Pumps until [finder] matches at least one widget.
  Future<void> waitFor(Finder finder) => pumpUntil(
    () => finder.evaluate().isNotEmpty,
    reason: finder.describeMatch(Plurality.one),
  );

  /// Pumps until [finder] matches nothing.
  Future<void> waitForAbsent(Finder finder) => pumpUntil(
    () => finder.evaluate().isEmpty,
    reason: 'absence of ${finder.describeMatch(Plurality.one)}',
  );

  /// Advances fake time by [duration] (firing due timers), then settles.
  Future<void> elapse(Duration duration) async {
    await tester.pump(duration);
    await settle();
  }

  // --- generic interaction ------------------------------------------------

  /// Navigates the App's router to [location].
  Future<void> go(String location) async {
    router.go(location);
    await settle();
  }

  /// The location on top of the router's stack (pushed routes included).
  String get location =>
      router.routerDelegate.currentConfiguration.uri.toString();

  /// Scrolls lazily built content until [finder] exists, then into view.
  ///
  /// Settings pages and lists build only what is on screen, so a control
  /// below the fold does not exist until the user scrolls to it.
  Future<void> reveal(Finder finder) async {
    if (finder.evaluate().isEmpty) {
      // Start from the top: the target may sit above the current scroll.
      for (final element in find.byType(Scrollable).evaluate()) {
        final state = (element as StatefulElement).state as ScrollableState;
        if (state.position.axis == Axis.vertical) state.position.jumpTo(0);
      }
      await tester.pump();
    }
    for (var i = 0; i < 60 && finder.evaluate().isEmpty; i++) {
      final scrollables = [
        for (final element in find.byType(Scrollable).evaluate())
          if ((element as StatefulElement).state case final ScrollableState s
              when s.position.axis == Axis.vertical &&
                  s.position.extentAfter > 0)
            s,
      ];
      if (scrollables.isEmpty) break;
      for (final scrollable in scrollables) {
        final position = scrollable.position;
        position.jumpTo(
          (position.pixels + 300).clamp(0, position.maxScrollExtent),
        );
      }
      await tester.pump();
    }
    if (finder.evaluate().isEmpty) {
      fail(
        'Scrolled and never found ${finder.describeMatch(Plurality.one)}.\n'
        'On screen: ${visibleText.replaceAll('\n', ' | ')}',
      );
    }
    await tester.ensureVisible(finder.first);
    await tester.pump();
  }

  /// Taps the first widget [finder] matches, revealing it first.
  Future<void> tap(Finder finder) async {
    await reveal(finder);
    await tester.tap(finder.first);
    await settle();
  }

  /// Taps the widget with [key].
  Future<void> tapKey(String key) => tap(find.byKey(Key(key)));

  /// Types [text] into the field [finder] matches.
  Future<void> enterText(Finder finder, String text) async {
    await reveal(finder);
    await tester.enterText(finder.first, text);
    await tester.pump();
  }

  /// Text of every visible [Text]/[RichText] in the tree, joined by newlines.
  String get visibleText => [
    for (final element in find.byType(RichText).evaluate())
      (element.widget as RichText).text.toPlainText(),
    for (final element in find.byType(EditableText).evaluate())
      (element.widget as EditableText).controller.text,
  ].join('\n');

  /// Asserts [rawLeakSentinel] is nowhere on screen.
  ///
  /// The fake network plants it in every transport failure; it may appear
  /// only inside a disclosure the user explicitly opened.
  void expectNoRawErrorLeak() {
    expect(
      visibleText,
      isNot(contains(rawLeakSentinel)),
      reason: 'a raw transport error reached a user-facing surface',
    );
  }

  // --- product state --------------------------------------------------------

  /// The server the app currently treats as active.
  BrokerProfile? get activeServer =>
      container.read(activeBrokerProfileProvider);

  /// Every saved server, as the app's repository returns them.
  Future<List<BrokerProfile>> savedServers() => storage.profiles.getAll();

  // --- connection verbs ---------------------------------------------------

  /// Opens the Connection screen.
  Future<void> openConnection() => go(connectionRoute);

  /// Types [address] into the Connection screen and presses Connect.
  ///
  /// Returns once the probe has been answered (or is visibly in flight when
  /// the broker holds it).
  Future<void> connectTo(String address) async {
    await enterText(
      find.byKey(const Key('connection-server-address-field')),
      address,
    );
    await tap(find.widgetWithText(FilledButton, 'Connect'));
  }

  // --- saved servers --------------------------------------------------------

  /// Finds a control on the Saved servers page for server [id].
  ///
  /// [part] is `row`, `activate`, `edit` or `delete`; the page keys rows by a
  /// slug of the server id.
  static Finder savedServer(String id, [String part = 'row']) =>
      find.byKey(Key('broker-profile-$part-${_slug(id)}'));

  /// Presses Use on saved server [id] (Saved servers page open).
  Future<void> useSavedServer(String id) => tap(savedServer(id, 'activate'));

  /// Edits saved server [id] (Saved servers page open) and presses Save.
  Future<void> editSavedServer(
    String id, {
    String? name,
    String? address,
  }) async {
    await tap(savedServer(id, 'edit'));
    if (name != null) {
      await enterText(
        find.byKey(const Key('broker-profile-edit-display-name-field')),
        name,
      );
    }
    if (address != null) {
      await enterText(
        find.byKey(const Key('broker-profile-edit-base-uri-field')),
        address,
      );
    }
    await tapKey('broker-profile-edit-save');
  }

  /// Deletes saved server [id] (Saved servers page open), confirming.
  Future<void> deleteSavedServer(String id) async {
    await tap(savedServer(id, 'delete'));
    await tapKey('broker-profile-delete-confirm');
  }

  static String _slug(String id) {
    final slug = id
        .toLowerCase()
        .replaceAll(RegExp('[^a-z0-9]+'), '_')
        .replaceAll(RegExp(r'^_+|_+$'), '');
    return slug.isEmpty ? 'profile' : slug;
  }

  // --- connection gate ------------------------------------------------------

  /// Types [token] into the connection gate and presses Save token.
  Future<void> saveGateToken(String token) async {
    await enterText(find.byKey(const Key('broker-gate-token-field')), token);
    await tapKey('broker-gate-save-token');
  }

  /// Opens the gate's Technical details disclosure.
  Future<void> openGateTechnicalDetails() =>
      tapKey('broker-gate-technical-details');

  // --- pairing --------------------------------------------------------------

  /// Pastes [payload] (and optionally a Broker URL) into the pairing form on
  /// screen and presses Import pairing.
  Future<void> importPairing(String payload, {String? brokerUrl}) async {
    await enterText(find.byKey(const Key('pairing-payload-field')), payload);
    if (brokerUrl != null) {
      await enterText(
        find.byKey(const Key('pairing-broker-url-field')),
        brokerUrl,
      );
    }
    await tapKey('pairing-import-button');
  }
}
