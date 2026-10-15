import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_runtime.dart';
import 'package:cosyncing_client/src/features/attention/model/attention_inbox.dart';
import 'package:cosyncing_client/src/features/attention/view/foreground_attention_host.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

const _coalesce = Duration(milliseconds: 100);
const _lifetime = Duration(milliseconds: 500);

void main() {
  testWidgets(
    'evicts the oldest dedupe identity while retaining aggregate counters',
    (tester) async {
      await tester.pumpWidget(_host());
      final container = _container(tester);
      const total = foregroundAttentionDedupeCapacity + 1;

      for (var index = 0; index < total; index += 1) {
        _push(container, _entry('bounded-$index'));
      }
      await tester.pump(_coalesce);

      expect(find.text('$total new notifications'), findsOneWidget);
      expect(find.text('$total need input'), findsOneWidget);
      expect(
        find.byKey(const Key('foreground-attention-banner')),
        findsOneWidget,
      );

      await tester.tap(
        find.byKey(const Key('foreground-attention-close-button')),
      );
      await tester.pump();
      _push(container, _entry('bounded-${total - 1}'));
      await tester.pump(_coalesce);
      expect(
        find.byKey(const Key('foreground-attention-banner')),
        findsNothing,
      );

      _push(container, _entry('bounded-0'));
      await tester.pump(_coalesce);
      expect(
        find.byKey(const Key('foreground-attention-banner')),
        findsOneWidget,
      );

      await tester.tap(
        find.byKey(const Key('foreground-attention-close-button')),
      );
      await tester.pump();
      _push(container, _entry('bounded-0'));
      await tester.pump(_coalesce);
      expect(
        find.byKey(const Key('foreground-attention-banner')),
        findsNothing,
      );
    },
  );

  testWidgets('uses structured session copy and never exposes a fingerprint', (
    tester,
  ) async {
    for (final scenario in const [
      ('question-required', 'Named task', 'Codex: Named task needs input'),
      (
        'run-finished',
        'Named task',
        'Codex: Named task is ready to review.',
      ),
      ('run-failed', 'Named task', 'Codex: Named task failed.'),
      ('sync-degraded', 'Named task', 'Codex: Named task sync is degraded.'),
      ('question-required', null, 'Codex: Untitled session needs input'),
    ]) {
      await tester.pumpWidget(_host());
      final container = _container(tester);
      _push(
        container,
        _entry(
          scenario.$1,
          kind: scenario.$1,
          sessionTitle: scenario.$2,
          title: 'fingerprint-7b86c513',
        ),
      );
      await tester.pump(_coalesce);

      expect(find.text(scenario.$3), findsOneWidget);
      expect(find.textContaining('fingerprint-7b86c513'), findsNothing);
      await tester.pumpWidget(const SizedBox.shrink());
    }
  });

  testWidgets('uses the localized Pi display name in session identity', (
    tester,
  ) async {
    await tester.pumpWidget(_host());
    final container = _container(tester);
    _push(
      container,
      _entry(
        'pi-input',
        sessionTitle: 'Release check',
        tool: 'pi',
      ),
    );
    await tester.pump(_coalesce);

    expect(find.text('Pi: Release check needs input'), findsOneWidget);
  });

  testWidgets(
    'continuing arrivals cannot extend the first presentation limit',
    (
      tester,
    ) async {
      var nowMs = 100;
      await tester.pumpWidget(
        _host(now: () => DateTime.fromMillisecondsSinceEpoch(nowMs)),
      );
      final container = _container(tester);
      _push(container, _entry('first', kind: 'run-finished'));
      await tester.pump(_coalesce);

      await tester.pump(const Duration(milliseconds: 300));
      nowMs = 500;
      _push(container, _entry('second', kind: 'run-finished'));
      await tester.pump(_coalesce);
      expect(find.text('2 new notifications'), findsOneWidget);

      await tester.pump(const Duration(milliseconds: 99));
      expect(
        find.byKey(const Key('foreground-attention-banner')),
        findsOneWidget,
      );
      await tester.pump(const Duration(milliseconds: 2));
      expect(
        find.byKey(const Key('foreground-attention-banner')),
        findsNothing,
      );
    },
  );

  testWidgets(
    'Compact and Expanded layouts are safe, width-capped, '
    'themed, and localized',
    (tester) async {
      for (final scenario in const [
        (Size(360, 640), Brightness.light, Locale('en')),
        (Size(1200, 800), Brightness.dark, Locale('zh')),
      ]) {
        tester.view
          ..physicalSize = scenario.$1
          ..devicePixelRatio = 1;
        await tester.pumpWidget(
          _host(
            brightness: scenario.$2,
            locale: scenario.$3,
            mediaPadding: const EdgeInsets.only(top: 24),
          ),
        );
        final container = _container(tester);
        _push(
          container,
          _entry(
            'layout-${scenario.$1.width}',
            sessionTitle: 'Session',
          ),
        );
        await tester.pump(_coalesce);

        final banner = find.byKey(const Key('foreground-attention-banner'));
        final bannerRect = tester.getRect(banner);
        final closeSize = tester.getSize(
          find.byKey(const Key('foreground-attention-close-button')),
        );
        expect(bannerRect.width, lessThanOrEqualTo(560));
        expect(bannerRect.top, greaterThanOrEqualTo(24));
        expect(closeSize.width, greaterThanOrEqualTo(40));
        expect(closeSize.height, greaterThanOrEqualTo(40));
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
      }
      tester.view
        ..resetPhysicalSize()
        ..resetDevicePixelRatio();
    },
  );
}

Widget _host({
  VoidCallback? onOpen,
  ValueChanged<AttentionInboxEntry?>? onOpenEntry,
  Brightness brightness = Brightness.light,
  Locale locale = const Locale('en'),
  EdgeInsets mediaPadding = EdgeInsets.zero,
  DateTime Function()? now,
}) {
  final theme = themeSpecById(kDefaultThemeId);
  return ProviderScope(
    child: MaterialApp(
      locale: locale,
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      theme: ThemeData(
        brightness: Brightness.light,
        extensions: [theme.light],
      ),
      darkTheme: ThemeData(
        brightness: Brightness.dark,
        extensions: [theme.dark],
      ),
      themeMode: brightness == Brightness.dark
          ? ThemeMode.dark
          : ThemeMode.light,
      home: Builder(
        builder: (context) => MediaQuery(
          data: MediaQuery.of(context).copyWith(padding: mediaPadding),
          child: ForegroundAttentionHost(
            coalesceWindow: _coalesce,
            informationalLifetime: _lifetime,
            now: now ?? DateTime.now,
            onOpen: onOpen ?? () {},
            onOpenEntry: onOpenEntry,
            child: const Scaffold(body: SizedBox.expand()),
          ),
        ),
      ),
    ),
  );
}

ProviderContainer _container(WidgetTester tester) {
  return ProviderScope.containerOf(
    tester.element(find.byType(ForegroundAttentionHost)),
  );
}

void _push(ProviderContainer container, AttentionInboxEntry? entry) {
  container.read(foregroundAttentionEventProvider.notifier).state = entry;
}

AttentionInboxEntry _entry(
  String id, {
  String kind = 'question-required',
  String? sessionTitle,
  String title = 'Event',
  int presentationRevision = 1,
  String tool = 'codex',
}) {
  return AttentionInboxEntry(
    profile: BrokerProfile(
      id: 'profile',
      displayName: 'Test workstation',
      baseUri: Uri.parse('http://127.0.0.1:7734'),
      createdAt: DateTime(2026),
    ),
    event: AttentionEventView(
      id: id,
      cursor: 1,
      revision: 1,
      presentationRevision: presentationRevision,
      kind: kind,
      state: kind == 'run-finished' || kind == 'run-failed'
          ? 'resolved'
          : 'active',
      severity: kind == 'question-required'
          ? 'action-required'
          : 'informational',
      dedupeKey: id,
      createdAt: DateTime(2026).millisecondsSinceEpoch,
      updatedAt: DateTime(2026).millisecondsSinceEpoch,
      title: title,
      sessionTitle: sessionTitle,
      agent: tool,
      action: AttentionEventAction(
        kind: 'open-session',
        tool: tool,
        sessionId: 'session-$id',
      ),
    ),
  );
}
