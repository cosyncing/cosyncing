import 'dart:async';
import 'dart:ui' show SemanticsAction;

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/schedules/platform/device_time_zone.dart';
import 'package:cosyncing_client/src/features/sessions/controller/new_session_controller.dart';
import 'package:cosyncing_client/src/features/sessions/controller/new_session_launch_controller.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_drive_intent_store.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_model_preference_store.dart';
import 'package:cosyncing_client/src/features/sessions/view/new_session_launch.dart';
import 'package:cosyncing_client/src/features/sessions/view/new_session_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  /// The English strings this sheet must render, read from the ARB-generated
  /// localizations rather than duplicated as literals — a copy edit should not
  /// require touching assertions.
  late AppLocalizations en;

  setUpAll(() async {
    en = await AppLocalizations.delegate.load(const Locale('en'));
  });

  testWidgets('global New starts empty and project New uses the real cwd', (
    tester,
  ) async {
    final fake = _FakeBrokerClient();
    await tester.pumpWidget(_host(fake));

    await tester.tap(find.byKey(const Key('open-global-new')));
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('new-session-directory')))
          .controller!
          .text,
      isEmpty,
    );
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('open-project-new')));
    await tester.pumpAndSettle();
    expect(find.textContaining('Friendly · /real/project'), findsOneWidget);
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('new-session-directory')))
          .controller!
          .text,
      '/real/project',
    );
  });

  testWidgets('editing project cwd changes the immediate create request', (
    tester,
  ) async {
    final fake = _FakeBrokerClient();
    await tester.pumpWidget(_host(fake));
    await tester.tap(find.byKey(const Key('open-project-new')));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const Key('new-session-directory')),
      '/edited/project',
    );
    await tester.tap(find.byKey(const Key('new-session-submit')));
    await tester.pumpAndSettle();

    expect(fake.createdDirectory, '/edited/project');
    expect(find.text('created'), findsOneWidget);
  });

  testWidgets('daily scheduled New sends edited cwd, prompt, and IANA zone', (
    tester,
  ) async {
    final fake = _FakeBrokerClient();
    await tester.pumpWidget(_host(fake));
    await tester.tap(find.byKey(const Key('open-project-new')));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const Key('new-session-directory')),
      '/scheduled/project',
    );
    await tester.tap(find.text(en.newSessionModelDefault));
    await tester.pumpAndSettle();
    await tester.tap(find.text('GPT Test').last);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('new-session-start')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Repeat daily').last);
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const Key('new-session-first-message')),
      'Start the daily review',
    );
    await tester.ensureVisible(find.byKey(const Key('new-session-submit')));
    await tester.tap(find.byKey(const Key('new-session-submit')));
    await tester.pumpAndSettle();

    final request = fake.createdSchedules.single as NewSessionScheduleCreate;
    expect(request.directory, '/scheduled/project');
    expect(request.text, 'Start the daily review');
    expect(request.repeat, ScheduleRepeat.daily);
    expect(request.timeZone, 'Europe/London');
    expect(request.model?.providerID, 'openai');
    expect(request.model?.modelID, 'gpt-test');
    expect(find.text('scheduled'), findsOneWidget);
    expect(find.byKey(const Key('new-session-launch-page')), findsNothing);
    expect(fake.createCalls, 0);
  });

  testWidgets('immediate submit hands off once to page-level creation', (
    tester,
  ) async {
    final gate = Completer<void>();
    final fake = _FakeBrokerClient(createGate: gate);
    await tester.pumpWidget(_host(fake));
    await tester.tap(find.byKey(const Key('open-project-new')));
    await tester.pumpAndSettle();

    final submit = find.byKey(const Key('new-session-submit'));
    final submitAction = tester.widget<FilledButton>(submit).onPressed!;
    submitAction();
    // The local synchronous guard rejects a duplicate tap before a rebuild.
    submitAction();
    await tester.pump();

    // Creation moved out of the sheet and onto the page-level surface.
    expect(find.byKey(const Key('new-session-launch-page')), findsOneWidget);
    expect(
      find.byKey(const Key('new-session-launch-creating')),
      findsOneWidget,
    );
    expect(find.text(en.newSessionCreatingLabel), findsOneWidget);
    expect(fake.createCalls, 1);
    expect(find.text('created'), findsNothing);

    // Completing all launch boundaries clears the page and opens the result.
    gate.complete();
    await tester.pumpAndSettle();
    expect(find.text('created'), findsOneWidget);
  });

  testWidgets('a failed create surfaces a plain-language error and retries', (
    tester,
  ) async {
    final fake = _FakeBrokerClient(failCreatesRemaining: 1);
    await tester.pumpWidget(_host(fake));
    await tester.tap(find.byKey(const Key('open-project-new')));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('new-session-submit')));
    await tester.pumpAndSettle();

    // Plain-language classified error, not a raw exception dump.
    final error = tester.widget<Text>(
      find.byKey(const Key('new-session-launch-error')),
    );
    expect(error.data, contains("Couldn't start the session."));
    expect(error.data, contains('The server ran into a problem on its end.'));
    expect(error.data, isNot(contains('BrokerException')));
    expect(error.data, isNot(contains('broker exploded')));
    // The page stays actionable with retry and back controls.
    expect(find.text('created'), findsNothing);
    expect(find.byKey(const Key('new-session-launch-retry')), findsOneWidget);
    expect(find.byKey(const Key('new-session-launch-back')), findsOneWidget);

    // Retrying succeeds and navigates.
    final retry = find.byKey(const Key('new-session-launch-retry'));
    await tester.ensureVisible(retry);
    await tester.tap(retry);
    await tester.pumpAndSettle();
    expect(find.text('created'), findsOneWidget);
  });

  testWidgets('successful immediate create clears busy state and navigates', (
    tester,
  ) async {
    final fake = _FakeBrokerClient();
    await tester.pumpWidget(_host(fake));
    await tester.tap(find.byKey(const Key('open-project-new')));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('new-session-submit')));
    await tester.pumpAndSettle();

    expect(find.text('created'), findsOneWidget);
    expect(fake.createCalls, 1);
    expect(fake.createdModel, isNull);
    expect(find.byKey(const Key('new-session-submit-progress')), findsNothing);
  });

  testWidgets('explicit model reaches immediate create exactly', (
    tester,
  ) async {
    final fake = _FakeBrokerClient();
    await tester.pumpWidget(_host(fake));
    await tester.tap(find.byKey(const Key('open-project-new')));
    await tester.pumpAndSettle();

    await tester.tap(find.text(en.newSessionModelDefault));
    await tester.pumpAndSettle();
    await tester.tap(find.text('GPT Test').last);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('new-session-submit')));
    await tester.pumpAndSettle();

    expect(fake.createdModel?.providerID, 'openai');
    expect(fake.createdModel?.modelID, 'gpt-test');
  });

  testWidgets('per-tool last-picked default preselects a catalog match', (
    tester,
  ) async {
    final store = _InMemoryModelPreferenceStore();
    await store.saveToolDefault(
      brokerProfileId: _localSourceKey(),
      tool: 'codex',
      model: const SessionCurrentModel(
        providerID: 'openai',
        modelID: 'gpt-test',
      ),
    );
    final fake = _FakeBrokerClient();
    await tester.pumpWidget(_host(fake, modelPreferenceStore: store));
    await tester.tap(find.byKey(const Key('open-project-new')));
    await tester.pumpAndSettle();

    // The dropdown must VISIBLY show the remembered label — not merely send
    // it. A programmatic prefill arrives after the field latched its initial
    // value, so this guards display/submit divergence.
    expect(find.text('GPT Test'), findsOneWidget);
    await tester.tap(find.byKey(const Key('new-session-submit')));
    await tester.pumpAndSettle();
    expect(fake.createdModel?.providerID, 'openai');
    expect(fake.createdModel?.modelID, 'gpt-test');
  });

  testWidgets('prefill in flight across a tool switch is discarded', (
    tester,
  ) async {
    final gate = Completer<void>();
    final store = _InMemoryModelPreferenceStore()..loadToolDefaultGate = gate;
    await store.saveToolDefault(
      brokerProfileId: _localSourceKey(),
      tool: 'codex',
      model: const SessionCurrentModel(
        providerID: 'openai',
        modelID: 'gpt-test',
      ),
    );
    await store.saveToolDefault(
      brokerProfileId: _localSourceKey(),
      tool: 'claude',
      model: const SessionCurrentModel(
        providerID: 'anthropic',
        modelID: 'opus',
      ),
    );
    final fake = _FakeBrokerClient(
      agents: const [
        _AgentFixture('codex', 'Codex'),
        _AgentFixture('claude', 'Claude'),
      ],
      catalogs: {
        'codex': [_model('gpt-test', 'GPT Test')],
        'claude': [_model('opus', 'Claude Opus', provider: 'anthropic')],
      },
    );
    await tester.pumpWidget(_host(fake, modelPreferenceStore: store));
    // Ignore the seeding writes above; only sheet-driven saves count.
    store.savedToolDefaults.clear();
    await tester.tap(find.byKey(const Key('open-project-new')));
    await tester.pumpAndSettle();
    // The codex prefill is still gated; nothing is displayed yet.
    expect(find.text('GPT Test'), findsNothing);

    await tester.tap(find.text('Codex').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Claude').last);
    await tester.pumpAndSettle();
    gate.complete();
    await tester.pumpAndSettle();

    // The stale codex result neither displays nor persists; the current
    // tool's own default applies.
    expect(find.text('GPT Test'), findsNothing);
    expect(find.text('Claude Opus'), findsOneWidget);
    expect(store.savedToolDefaults, isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets('prefill in flight across a broker switch is discarded', (
    tester,
  ) async {
    final gate = Completer<void>();
    final store = _InMemoryModelPreferenceStore()..loadToolDefaultGate = gate;
    await store.saveToolDefault(
      brokerProfileId: _localSourceKey(),
      tool: 'codex',
      model: const SessionCurrentModel(
        providerID: 'openai',
        modelID: 'first-model',
      ),
    );
    final first = _FakeBrokerClient(
      catalogs: {
        'codex': [_model('first-model', 'First broker model')],
      },
    );
    final second = _FakeBrokerClient(
      catalogs: {
        'codex': [_model('second-model', 'Second broker model')],
      },
    );
    await tester.pumpWidget(
      _host(first, alternateFake: second, modelPreferenceStore: store),
    );
    // Ignore the seeding writes above; only sheet-driven saves count.
    store.savedToolDefaults.clear();
    await tester.tap(find.byKey(const Key('open-project-new')));
    await tester.pumpAndSettle();
    expect(find.text('First broker model'), findsNothing);

    // Switch through the container: the launcher's switch button sits behind
    // the modal sheet and cannot be tapped while it is open.
    _switchToAlternateBroker(tester);
    await tester.pumpAndSettle();
    gate.complete();
    await tester.pumpAndSettle();

    // The previous broker's remembered model neither displays nor leaks into
    // the new broker's preference scope.
    expect(find.text('First broker model'), findsNothing);
    expect(find.text(en.newSessionModelDefault), findsOneWidget);
    expect(store.savedToolDefaults, isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'a stale catalog pick delivered after a broker switch is a full no-op',
    (
      tester,
    ) async {
      final store = _InMemoryModelPreferenceStore();
      // B has its own remembered model, so the sheet has a live selection
      // the stale callback must not disturb.
      await store.saveToolDefault(
        brokerProfileId: _alternateSourceKey(),
        tool: 'codex',
        model: const SessionCurrentModel(
          providerID: 'openai',
          modelID: 'second-model',
        ),
      );
      final first = _FakeBrokerClient(
        catalogs: {
          'codex': [_model('first-model', 'First broker model')],
        },
      );
      final second = _FakeBrokerClient(
        catalogs: {
          'codex': [_model('second-model', 'Second broker model')],
        },
      );
      await tester.pumpWidget(
        _host(first, alternateFake: second, modelPreferenceStore: store),
      );
      store.savedToolDefaults.clear();
      await tester.tap(find.byKey(const Key('open-project-new')));
      await tester.pumpAndSettle();

      // The switch disposes the dropdown field and its menu, so a stale menu
      // entry cannot be tapped afterwards. The residual race is the menu's
      // result future completing AFTER the switch — reproduced here by
      // invoking the pick callback captured while broker A's catalog was
      // rendered, with A's value (the sheet's `_modelKey` wire format).
      final staleOnChanged = tester
          .widget<DropdownButtonFormField<String>>(_modelDropdown())
          .onChanged!;
      const staleValue = 'openai\u0000first-model\u0000';
      _switchToAlternateBroker(tester);
      await tester.pumpAndSettle();
      // B's remembered model prefilled after the switch.
      expect(find.text('Second broker model'), findsOneWidget);

      staleOnChanged(staleValue);
      await tester.pumpAndSettle();
      // No write, no visible mutation: A's label never appears and B's
      // selection is unchanged.
      expect(store.savedToolDefaults, isEmpty);
      expect(find.text('First broker model'), findsNothing);
      expect(find.text('Second broker model'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'a stale Default pick delivered after a broker switch is a full no-op',
    (
      tester,
    ) async {
      final store = _InMemoryModelPreferenceStore();
      await store.saveToolDefault(
        brokerProfileId: _alternateSourceKey(),
        tool: 'codex',
        model: const SessionCurrentModel(
          providerID: 'openai',
          modelID: 'second-model',
        ),
      );
      final first = _FakeBrokerClient(
        catalogs: {
          'codex': [_model('first-model', 'First broker model')],
        },
      );
      final second = _FakeBrokerClient(
        catalogs: {
          'codex': [_model('second-model', 'Second broker model')],
        },
      );
      await tester.pumpWidget(
        _host(first, alternateFake: second, modelPreferenceStore: store),
      );
      store.savedToolDefaults.clear();
      await tester.tap(find.byKey(const Key('open-project-new')));
      await tester.pumpAndSettle();

      // Same race, but the stale callback carries the "Default" entry: it
      // must not pollute B's declined set nor clear B's selection.
      final staleOnChanged = tester
          .widget<DropdownButtonFormField<String>>(_modelDropdown())
          .onChanged!;
      _switchToAlternateBroker(tester);
      await tester.pumpAndSettle();
      expect(find.text('Second broker model'), findsOneWidget);

      staleOnChanged('');
      await tester.pumpAndSettle();
      // B's remembered model still applies and is submitted.
      expect(find.text('Second broker model'), findsOneWidget);
      await tester.tap(find.byKey(const Key('new-session-submit')));
      await tester.pumpAndSettle();
      expect(second.createdModel?.modelID, 'second-model');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('a declined default survives switching tools and back', (
    tester,
  ) async {
    final store = _InMemoryModelPreferenceStore();
    await store.saveToolDefault(
      brokerProfileId: _localSourceKey(),
      tool: 'codex',
      model: const SessionCurrentModel(
        providerID: 'openai',
        modelID: 'gpt-test',
      ),
    );
    final fake = _FakeBrokerClient(
      agents: const [
        _AgentFixture('codex', 'Codex'),
        _AgentFixture('claude', 'Claude'),
      ],
      catalogs: {
        'codex': [_model('gpt-test', 'GPT Test')],
        'claude': [_model('opus', 'Claude Opus', provider: 'anthropic')],
      },
    );
    await tester.pumpWidget(_host(fake, modelPreferenceStore: store));
    await tester.tap(find.byKey(const Key('open-project-new')));
    await tester.pumpAndSettle();
    // Prefilled from the remembered codex model.
    expect(find.text('GPT Test'), findsOneWidget);

    // Explicitly choose Default for codex.
    await tester.tap(_modelDropdown());
    await tester.pumpAndSettle();
    await tester.tap(find.text(en.newSessionModelDefault).last);
    await tester.pumpAndSettle();

    // Switch to claude and back to codex.
    await tester.tap(find.text('Codex').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Claude').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Claude').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Codex').last);
    await tester.pumpAndSettle();

    // The remembered codex model is not resurrected, and nothing is sent.
    expect(find.text('GPT Test'), findsNothing);
    expect(find.text(en.newSessionModelDefault), findsOneWidget);
    await tester.tap(find.byKey(const Key('new-session-submit')));
    await tester.pumpAndSettle();
    expect(fake.createCalls, 1);
    expect(fake.createdModel, isNull);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a failing preference read leaves the sheet on tool default', (
    tester,
  ) async {
    final store = _InMemoryModelPreferenceStore()
      ..throwOnLoadToolDefault = true;
    final fake = _FakeBrokerClient();
    await tester.pumpWidget(_host(fake, modelPreferenceStore: store));
    await tester.tap(find.byKey(const Key('open-project-new')));
    await tester.pumpAndSettle();

    expect(find.text(en.newSessionModelDefault), findsOneWidget);
    await tester.tap(find.byKey(const Key('new-session-submit')));
    await tester.pumpAndSettle();
    expect(fake.createCalls, 1);
    expect(fake.createdModel, isNull);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a retired per-tool default stays dormant', (tester) async {
    final store = _InMemoryModelPreferenceStore();
    await store.saveToolDefault(
      brokerProfileId: _localSourceKey(),
      tool: 'codex',
      model: const SessionCurrentModel(
        providerID: 'openai',
        modelID: 'gpt-retired',
      ),
    );
    final fake = _FakeBrokerClient();
    await tester.pumpWidget(_host(fake, modelPreferenceStore: store));
    await tester.tap(find.byKey(const Key('open-project-new')));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('new-session-submit')));
    await tester.pumpAndSettle();
    expect(fake.createCalls, 1);
    expect(fake.createdModel, isNull);
  });

  testWidgets("another broker's per-tool default is not applied", (
    tester,
  ) async {
    final store = _InMemoryModelPreferenceStore();
    await store.saveToolDefault(
      brokerProfileId: 'other-broker-key',
      tool: 'codex',
      model: const SessionCurrentModel(
        providerID: 'openai',
        modelID: 'gpt-test',
      ),
    );
    final fake = _FakeBrokerClient();
    await tester.pumpWidget(_host(fake, modelPreferenceStore: store));
    await tester.tap(find.byKey(const Key('open-project-new')));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('new-session-submit')));
    await tester.pumpAndSettle();
    expect(fake.createdModel, isNull);
  });

  testWidgets('an explicit tool-default choice suppresses the prefill', (
    tester,
  ) async {
    final store = _InMemoryModelPreferenceStore();
    await store.saveToolDefault(
      brokerProfileId: _localSourceKey(),
      tool: 'codex',
      model: const SessionCurrentModel(
        providerID: 'openai',
        modelID: 'gpt-test',
      ),
    );
    final fake = _FakeBrokerClient();
    await tester.pumpWidget(_host(fake, modelPreferenceStore: store));
    await tester.tap(find.byKey(const Key('open-project-new')));
    await tester.pumpAndSettle();

    await tester.tap(_modelDropdown());
    await tester.pumpAndSettle();
    await tester.tap(find.text(en.newSessionModelDefault).last);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('new-session-submit')));
    await tester.pumpAndSettle();
    expect(fake.createdModel, isNull);
  });

  testWidgets('picking a model in the sheet records the per-tool default', (
    tester,
  ) async {
    final store = _InMemoryModelPreferenceStore();
    final fake = _FakeBrokerClient();
    await tester.pumpWidget(_host(fake, modelPreferenceStore: store));
    await tester.tap(find.byKey(const Key('open-project-new')));
    await tester.pumpAndSettle();

    await tester.tap(find.text(en.newSessionModelDefault));
    await tester.pumpAndSettle();
    await tester.tap(find.text('GPT Test').last);
    await tester.pumpAndSettle();

    final saved = await store.loadToolDefault(
      brokerProfileId: _localSourceKey(),
      tool: 'codex',
    );
    expect(saved?.providerID, 'openai');
    expect(saved?.modelID, 'gpt-test');
  });

  testWidgets('model selector exposes touch semantics and keyboard dismissal', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(_host(_FakeBrokerClient()));
    await tester.tap(find.byKey(const Key('open-project-new')));
    await tester.pumpAndSettle();

    expect(
      tester
          .getSemantics(_modelDropdown())
          .getSemanticsData()
          .hasAction(SemanticsAction.tap),
      isTrue,
    );
    await tester.tap(_modelDropdown());
    await tester.pumpAndSettle();
    expect(find.text('GPT Test'), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.text('GPT Test'), findsNothing);
    semantics.dispose();
  });

  testWidgets('catalog renders loading, empty, failed, and stale honestly', (
    tester,
  ) async {
    final gate = Completer<void>();
    final fake = _FakeBrokerClient(catalogGate: gate);
    await tester.pumpWidget(_host(fake));
    await tester.tap(find.byKey(const Key('open-project-new')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text(en.newSessionModelLoading), findsOneWidget);

    gate.complete();
    await tester.pumpAndSettle();
    final container = ProviderScope.containerOf(
      tester.element(find.byType(_NewSessionLauncher)),
    );
    expect(
      container.read(newSessionControllerProvider).models.single.label,
      'GPT Test',
    );

    fake.failCatalogsRemaining = 1;
    await container
        .read(newSessionControllerProvider.notifier)
        .loadModels('codex');
    await tester.pumpAndSettle();
    expect(find.text(en.newSessionModelStale), findsOneWidget);
    expect(
      container.read(newSessionControllerProvider).models.single.label,
      'GPT Test',
    );

    fake.catalogs['codex'] = const [];
    await container
        .read(newSessionControllerProvider.notifier)
        .loadModels('codex');
    await tester.pumpAndSettle();
    expect(find.text(en.newSessionModelEmpty), findsOneWidget);
    expect(container.read(newSessionControllerProvider).models, isEmpty);
  });

  testWidgets('initial catalog failure is localized and retryable', (
    tester,
  ) async {
    final fake = _FakeBrokerClient(failCatalogsRemaining: 1);
    await tester.pumpWidget(_host(fake, locale: const Locale('zh')));
    await tester.tap(find.byKey(const Key('open-project-new')));
    await tester.pumpAndSettle();
    final zh = await AppLocalizations.delegate.load(const Locale('zh'));
    expect(find.text(zh.newSessionModelFailed), findsOneWidget);
    expect(find.text(zh.newSessionModelRefresh), findsOneWidget);

    await tester.tap(find.byKey(const Key('new-session-model-refresh')));
    await tester.pumpAndSettle();
    final container = ProviderScope.containerOf(
      tester.element(find.byType(_NewSessionLauncher)),
    );
    expect(
      container.read(newSessionControllerProvider).models.single.label,
      'GPT Test',
    );
  });

  testWidgets(
    'revision-7 agent capability stays honest default-only without a 404 probe',
    (tester) async {
      final fake = _FakeBrokerClient(
        agents: const [
          _AgentFixture(
            'codex',
            'Codex',
            canSelectModelAtCreation: false,
          ),
        ],
      );
      await tester.pumpWidget(_host(fake));
      await tester.tap(find.byKey(const Key('open-project-new')));
      await tester.pumpAndSettle();

      expect(find.text(en.newSessionModelDefault), findsOneWidget);
      expect(find.text(en.newSessionModelUnavailable), findsOneWidget);
      expect(find.text(en.newSessionModelFailed), findsNothing);
      expect(find.text(en.newSessionModelLoading), findsNothing);
      expect(fake.modelCatalogCalls, 0);
      final container = ProviderScope.containerOf(
        tester.element(find.byType(_NewSessionLauncher)),
      );
      expect(
        container.read(newSessionControllerProvider).modelCatalogPhase,
        NewSessionModelCatalogPhase.unavailable,
      );
    },
  );

  testWidgets('retired explicit selection is shown and rejected', (
    tester,
  ) async {
    final fake = _FakeBrokerClient();
    await tester.pumpWidget(_host(fake));
    await tester.tap(find.byKey(const Key('open-project-new')));
    await tester.pumpAndSettle();
    await tester.tap(find.text(en.newSessionModelDefault));
    await tester.pumpAndSettle();
    await tester.tap(find.text('GPT Test').last);
    await tester.pumpAndSettle();

    fake.catalogs['codex'] = const [];
    final container = ProviderScope.containerOf(
      tester.element(find.byType(_NewSessionLauncher)),
    );
    await container
        .read(newSessionControllerProvider.notifier)
        .loadModels('codex');
    await tester.pumpAndSettle();
    expect(find.text(en.newSessionModelRetired), findsOneWidget);
    final submit = find.byKey(const Key('new-session-submit'));
    await tester.ensureVisible(submit);
    await tester.tap(submit);
    await tester.pumpAndSettle();
    expect(fake.createCalls, 0);
    expect(find.text(en.newSessionModelRetired), findsWidgets);
  });

  testWidgets('all supported tools consume capability catalogs generically', (
    tester,
  ) async {
    final fake = _FakeBrokerClient(
      agents: const [
        _AgentFixture('codex', 'Codex'),
        _AgentFixture('claude', 'Claude'),
        _AgentFixture('opencode', 'OpenCode'),
        _AgentFixture('pi', 'Pi'),
      ],
      catalogs: {
        'codex': [_model('codex-model', 'Codex model')],
        'claude': [_model('opus', 'Opus', provider: 'anthropic')],
        'opencode': [
          _model('MiniMax-M2.5', 'MiniMax', provider: 'minimax'),
        ],
        'pi': [_model('pi-model', 'Pi model', provider: 'pi-provider')],
      },
    );
    await tester.pumpWidget(_host(fake));
    await tester.tap(find.byKey(const Key('open-project-new')));
    await tester.pumpAndSettle();

    var currentTool = 'Codex';
    for (final entry in const {
      'Claude': 'Opus',
      'OpenCode': 'MiniMax',
      'Pi': 'Pi model',
      'Codex': 'Codex model',
    }.entries) {
      await tester.tap(find.text(currentTool).first);
      await tester.pumpAndSettle();
      await tester.tap(find.text(entry.key).last);
      await tester.pumpAndSettle();
      await tester.tap(_modelDropdown());
      await tester.pumpAndSettle();
      expect(find.text(entry.value), findsOneWidget);
      await tester.tap(find.text(entry.value).last);
      await tester.pumpAndSettle();
      currentTool = entry.key;
    }
  });

  testWidgets('broker switch invalidates an open selector by incarnation', (
    tester,
  ) async {
    final first = _FakeBrokerClient(
      catalogs: {
        'codex': [_model('first-model', 'First broker model')],
      },
    );
    final second = _FakeBrokerClient(
      catalogs: {
        'codex': [_model('second-model', 'Second broker model')],
      },
    );
    await tester.pumpWidget(_host(first, alternateFake: second));
    await tester.tap(find.byKey(const Key('open-project-new')));
    await tester.pumpAndSettle();
    final container = ProviderScope.containerOf(
      tester.element(find.byType(_NewSessionLauncher)),
    );
    expect(
      container.read(newSessionControllerProvider).models.single.modelID,
      'first-model',
    );
    container.read(activeBrokerProfileProvider.notifier).state = BrokerProfile(
      id: 'alternate',
      displayName: 'Alternate',
      baseUri: Uri.parse('http://127.0.0.1:8834'),
      createdAt: DateTime(2026, 7, 24),
      incarnationId: 'incarnation-b',
    );
    await tester.pumpAndSettle();
    final switchedState = container.read(newSessionControllerProvider);
    expect(
      switchedState.modelCatalogSource?.incarnationId,
      isNot('incarnation-a'),
    );
    if (switchedState.models.isEmpty) {
      await container
          .read(newSessionControllerProvider.notifier)
          .loadModels('codex');
      await tester.pumpAndSettle();
    }
    expect(
      container.read(newSessionControllerProvider).models.single.modelID,
      'second-model',
    );
  });

  for (final fixture in const [
    ('compact-light', Size(390, 800), Brightness.light),
    ('compact-dark', Size(390, 800), Brightness.dark),
    ('roomy-light', Size(1200, 900), Brightness.light),
    ('roomy-dark', Size(1200, 900), Brightness.dark),
  ]) {
    testWidgets('model selector renders in ${fixture.$1}', (tester) async {
      tester.view.physicalSize = fixture.$2;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        _host(
          _FakeBrokerClient(),
          brightness: fixture.$3,
        ),
      );
      await tester.tap(find.byKey(const Key('open-project-new')));
      await tester.pumpAndSettle();
      expect(find.text(en.newSessionModelLabel), findsOneWidget);
      expect(find.text(en.newSessionModelDefault), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }
}

Finder _modelDropdown() => find.byWidgetPredicate(
  (widget) =>
      widget is DropdownButtonFormField<String> &&
      widget.key is ValueKey<String> &&
      (widget.key! as ValueKey<String>).value.startsWith(
        'new-session-model-',
      ),
);

/// The profile `_host` installs as active; tests compute the matching
/// preference scope from it instead of duplicating a storage-key literal.
BrokerProfile _localProfile() => BrokerProfile(
  id: 'local',
  displayName: 'Local',
  baseUri: Uri.parse('http://127.0.0.1:7734'),
  createdAt: DateTime(2026, 7, 24),
  incarnationId: 'incarnation-a',
);

String _localSourceKey() => RosterSource.ofProfile(_localProfile()).storageKey;

/// The alternate profile the broker-switch tests activate; tests compute the
/// matching preference scope from it instead of duplicating a storage-key
/// literal.
BrokerProfile _alternateProfile() => BrokerProfile(
  id: 'alternate',
  displayName: 'Alternate',
  baseUri: Uri.parse('http://127.0.0.1:8834'),
  createdAt: DateTime(2026, 7, 24),
  incarnationId: 'incarnation-b',
);

String _alternateSourceKey() =>
    RosterSource.ofProfile(_alternateProfile()).storageKey;

/// Switches the active profile to the alternate broker through the container:
/// the launcher's switch button sits behind the modal sheet and cannot be
/// tapped while it is open.
void _switchToAlternateBroker(WidgetTester tester) {
  final container = ProviderScope.containerOf(
    tester.element(find.byType(_NewSessionLauncher)),
  );
  container.read(activeBrokerProfileProvider.notifier).state =
      _alternateProfile();
}

class _InMemoryModelPreferenceStore implements SessionModelPreferenceStore {
  final _toolDefaults = <String, SessionCurrentModel>{};

  /// Every saveToolDefault call, so tests can prove a stale flow persisted
  /// nothing.
  final savedToolDefaults = <String, SessionCurrentModel>{};

  /// When set, loadToolDefault awaits it — lets a test hold a prefill in
  /// flight across tool/broker switches.
  Completer<void>? loadToolDefaultGate;

  /// When true, loadToolDefault throws like a broken database would.
  bool throwOnLoadToolDefault = false;

  @override
  Future<SessionCurrentModel?> load(SessionModelPreferenceKey key) async =>
      null;

  @override
  Future<void> save(
    SessionModelPreferenceKey key,
    SessionCurrentModel model,
  ) async {}

  @override
  Future<void> clear(SessionModelPreferenceKey key) async {}

  @override
  Future<SessionCurrentModel?> loadToolDefault({
    required String brokerProfileId,
    required String tool,
  }) async {
    if (throwOnLoadToolDefault) {
      throw StateError('preference store unavailable');
    }
    await loadToolDefaultGate?.future;
    return _toolDefaults['$brokerProfileId $tool'];
  }

  @override
  Future<void> saveToolDefault({
    required String brokerProfileId,
    required String tool,
    required SessionCurrentModel model,
  }) async {
    savedToolDefaults['$brokerProfileId $tool'] = model;
    _toolDefaults['$brokerProfileId $tool'] = model;
  }
}

Widget _host(
  _FakeBrokerClient fake, {
  _FakeBrokerClient? alternateFake,
  Locale locale = const Locale('en'),
  Brightness brightness = Brightness.light,
  SessionModelPreferenceStore? modelPreferenceStore,
}) => ProviderScope(
  overrides: [
    brokerClientProvider.overrideWith((ref) async {
      final profile = ref.watch(activeBrokerProfileProvider);
      return profile?.id == 'alternate' ? alternateFake ?? fake : fake;
    }),
    // The create flow builds an operation-owned client from the captured
    // profile through this factory; loadAgents keeps the shared provider.
    brokerClientFactoryProvider.overrideWith(
      (ref) =>
          (profile) async =>
              profile.id == 'alternate' ? alternateFake ?? fake : fake,
    ),
    // A resolved client implies an active profile in production; the create
    // flow resolves them as one pair and refuses to run without it.
    activeBrokerProfileProvider.overrideWith((ref) => _localProfile()),
    deviceTimeZoneResolverProvider.overrideWithValue(
      () async => 'Europe/London',
    ),
    // The create flow persists app-created Drive provenance; the real store
    // would open a Drift database inside the widget test.
    sessionDriveIntentStoreProvider.overrideWithValue(_NoopDriveIntentStore()),
    // The sheet reads/writes the per-tool model default; the real store would
    // open a Drift database inside the widget test.
    sessionModelPreferenceStoreProvider.overrideWithValue(
      modelPreferenceStore ?? _InMemoryModelPreferenceStore(),
    ),
  ],
  child: MaterialApp(
    locale: locale,
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    theme: buildAppTheme(themeSpecById(kDefaultThemeId).light, brightness),
    darkTheme: buildAppTheme(
      themeSpecById(kDefaultThemeId).dark,
      Brightness.dark,
    ),
    themeMode: brightness == Brightness.dark ? ThemeMode.dark : ThemeMode.light,
    home: Scaffold(
      body: _NewSessionLauncher(canSwitchBroker: alternateFake != null),
    ),
  ),
);

class _NewSessionLauncher extends ConsumerStatefulWidget {
  const _NewSessionLauncher({required this.canSwitchBroker});

  final bool canSwitchBroker;

  @override
  ConsumerState<_NewSessionLauncher> createState() =>
      _NewSessionLauncherState();
}

class _NewSessionLauncherState extends ConsumerState<_NewSessionLauncher> {
  String? result;
  NewSessionLaunchRequest? launch;

  void _beginLaunch(NewSessionLaunchRequest request) {
    if (launch != null) return;
    setState(() => launch = request);
  }

  Future<void> _open({required bool project}) async {
    final value = await showNewSessionSheet(
      context,
      initialDirectory: project ? '/real/project' : '',
      projectName: project ? 'Friendly' : null,
      onImmediateLaunch: _beginLaunch,
    );
    if (!mounted || value == null) return;
    switch (value) {
      case ImmediateNewSessionResult():
        return;
      case ScheduledNewSessionResult():
        setState(() => result = 'scheduled');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        Column(
          children: [
            TextButton(
              key: const Key('open-global-new'),
              onPressed: () => unawaited(_open(project: false)),
              child: const Text('Global'),
            ),
            TextButton(
              key: const Key('open-project-new'),
              onPressed: () => unawaited(_open(project: true)),
              child: const Text('Project'),
            ),
            if (widget.canSwitchBroker)
              TextButton(
                key: const Key('switch-broker'),
                onPressed: () {
                  ref
                      .read(activeBrokerProfileProvider.notifier)
                      .state = BrokerProfile(
                    id: 'alternate',
                    displayName: 'Alternate',
                    baseUri: Uri.parse('http://127.0.0.1:8834'),
                    createdAt: DateTime(2026, 7, 24),
                    incarnationId: 'incarnation-b',
                  );
                },
                child: const Text('Switch broker'),
              ),
            if (result != null) Text(result!),
          ],
        ),
        if (launch case final NewSessionLaunchRequest request)
          Positioned.fill(
            child: NewSessionLaunchPage(
              key: ValueKey<NewSessionLaunchRequest>(request),
              request: request,
              onCreate: (request) =>
                  ref.read(newSessionLaunchServiceProvider).create(request),
              onOpen: (_) => Future<void>.value(),
              onConnect: (_) async => NewSessionConnectionHandoff(() {}),
              onComplete: (_) => setState(() {
                launch = null;
                result = 'created';
              }),
              onBack: () => setState(() => launch = null),
            ),
          ),
      ],
    );
  }
}

AgentInfo _agent([
  String id = 'codex',
  String displayName = 'Codex',
  bool canSelectModelAtCreation = true,
]) => AgentInfo(
  id: id,
  displayName: displayName,
  capabilities: const AgentCapabilities(
    integrationKind: IntegrationKind.jsonrpcStdio,
    attachModes: [AttachMode.resume],
    supportsObserve: true,
    supportsResume: true,
    supportsLiveAttach: false,
    supportsNativeArtifact: false,
    supportsNativeFileInput: false,
    supportsModelSwitch: true,
    permissionGranularity: PermissionGranularity.perSession,
  ),
  canCreateSession: true,
  canSelectModelAtCreation: canSelectModelAtCreation,
  canRenameNative: false,
  canFork: false,
  canClone: false,
  canTranscriptExport: false,
);

class _AgentFixture {
  const _AgentFixture(
    this.id,
    this.displayName, {
    this.canSelectModelAtCreation = true,
  });

  final String id;
  final String displayName;
  final bool canSelectModelAtCreation;
}

ModelOption _model(
  String id,
  String label, {
  String provider = 'openai',
}) => ModelOption(providerID: provider, modelID: id, label: label);

ScheduleRecord _schedule(ScheduleCreate request) => ScheduleRecord(
  id: 'schedule-1',
  kind: ScheduleKind.newSession,
  tool: request.tool,
  text: request.text,
  at: request.at ?? DateTime(2026, 7, 17).millisecondsSinceEpoch,
  state: ScheduleState.scheduled,
  createdAt: DateTime(2026, 7, 16).millisecondsSinceEpoch,
  updatedAt: DateTime(2026, 7, 16).millisecondsSinceEpoch,
);

final class _FakeBrokerClient extends BrokerClient {
  _FakeBrokerClient({
    this.createGate,
    this.catalogGate,
    this.failCreatesRemaining = 0,
    this.failCatalogsRemaining = 0,
    this.agents = const [_AgentFixture('codex', 'Codex')],
    Map<String, List<ModelOption>>? catalogs,
  }) : catalogs =
           catalogs ??
           {
             'codex': const [
               ModelOption(
                 providerID: 'openai',
                 modelID: 'gpt-test',
                 label: 'GPT Test',
               ),
             ],
           },
       super(baseUrl: 'http://test');

  /// When set, `createSession` awaits this before returning so a test can
  /// observe the in-flight busy state.
  final Completer<void>? createGate;
  final Completer<void>? catalogGate;

  /// Number of leading `createSession` calls that throw before one succeeds.
  int failCreatesRemaining;
  int failCatalogsRemaining;
  final List<_AgentFixture> agents;
  final Map<String, List<ModelOption>> catalogs;

  String? createdDirectory;
  SessionCurrentModel? createdModel;
  final List<ScheduleCreate> createdSchedules = [];
  int createCalls = 0;
  int modelCatalogCalls = 0;

  @override
  Future<List<AgentInfo>> listAgents() async => agents
      .map(
        (fixture) => _agent(
          fixture.id,
          fixture.displayName,
          fixture.canSelectModelAtCreation,
        ),
      )
      .toList();

  @override
  Future<ModelCatalogResponse> listAgentModels(String tool) async {
    modelCatalogCalls += 1;
    if (catalogGate != null) await catalogGate!.future;
    if (failCatalogsRemaining > 0) {
      failCatalogsRemaining--;
      throw const BrokerException(
        message: 'model catalog unavailable',
        statusCode: 503,
      );
    }
    return ModelCatalogResponse(
      tool: tool,
      models: catalogs[tool] ?? const [],
      refreshedAt: 1,
    );
  }

  @override
  Future<CreateSessionResponse> createSession(
    String tool, {
    String? directory,
    String? title,
    SessionCurrentModel? model,
  }) async {
    createCalls += 1;
    if (createGate != null) await createGate!.future;
    if (failCreatesRemaining > 0) {
      failCreatesRemaining--;
      throw const BrokerException(message: 'broker exploded', statusCode: 500);
    }
    createdDirectory = directory;
    createdModel = model;
    return CreateSessionResponse(
      session: SessionInfo(
        id: 'created',
        tool: tool,
        title: title ?? '',
        status: SessionStatus.idle,
        attachMode: AttachMode.resume,
      ),
      attachMode: 'resume',
    );
  }

  @override
  Future<ScheduleCreateResponse> createSchedule(ScheduleCreate request) async {
    createdSchedules.add(request);
    return ScheduleCreateResponse(schedule: _schedule(request));
  }
}

class _NoopDriveIntentStore implements SessionDriveIntentStore {
  @override
  Future<SessionDriveProvenance?> read({
    required String brokerProfileId,
    required String tool,
    required String sessionId,
  }) async => null;

  @override
  Future<void> rememberAppCreated({
    required String brokerProfileId,
    required String tool,
    required String sessionId,
  }) async {}

  @override
  Future<void> rememberTakeover({
    required String brokerProfileId,
    required String tool,
    required String sessionId,
  }) async {}

  @override
  Future<void> clear({
    required String brokerProfileId,
    required String tool,
    required String sessionId,
  }) async {}
}
