// F02 — Starting a new session, through the real App.
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_harness_logo.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/feature/cosyncing_app.dart';
import '../support/feature/fake_broker.dart';
import '../support/feature/roster_driver.dart';
import '../support/feature/session_driver.dart';

final AppLocalizations en = lookupAppLocalizations(const Locale('en'));

const _gpt = ModelOption(
  providerID: 'openai',
  modelID: 'gpt-test',
  label: 'GPT Test',
  reasoningEfforts: [
    ReasoningEffort(effort: 'low', label: 'Low'),
    ReasoningEffort(effort: 'high', label: 'High'),
  ],
  defaultReasoningEffort: 'low',
);

FakeBroker studioWithAgents(FeatureContext f) {
  final studio = f.network.add('http://studio.test:7734')
    ..addSession('a1', 'Fix login', cwd: '/work/app')
    ..agents = [
      fakeAgent(
        canSelectModelAtCreation: true,
        canSelectPermissionModeAtCreation: true,
      ),
      fakeAgent(id: 'claude', displayName: 'Claude'),
      fakeAgent(id: 'cline', displayName: 'Cline', canCreateSession: false),
    ];
  studio.modelCatalogs['codex'] = const [_gpt];
  studio.modeCatalogs['codex'] = const [
    ModeOption(value: 'default', label: 'Ask first'),
    ModeOption(value: 'auto', label: 'Auto approve'),
  ];
  return studio;
}

void main() {
  group('the sheet', () {
    featureTest(
      'offers only agents that can create sessions, with the exact model '
      'and mode catalogs of the chosen one',
      (f) async {
        final studio = studioWithAgents(f);
        final extraAgents = [
          'opencode',
          'pi',
          'omp',
          'reasonix',
          'grok',
          'kilo',
        ];
        studio.agents!.addAll([
          for (final tool in extraAgents)
            fakeAgent(id: tool, displayName: tool),
        ]);
        await f.storage.seedServer(
          f.network.brokerFor(Uri.parse('http://studio.test:7734'))!,
        );
        final app = await f.launch();
        await app.openNewSession();

        expect(app.optionsOf(app.agentPicker), [
          'Codex',
          'Claude',
          ...extraAgents,
        ]);
        expect(
          find.descendant(
            of: app.agentPicker,
            matching: find.byType(SessionHarnessLogo),
          ),
          findsOneWidget,
        );
        await app.tap(app.agentPicker);
        final popup = find.byKey(const Key('adaptive-picker-popup'));
        expect(
          find.descendant(of: popup, matching: find.byType(TextField)),
          findsNothing,
        );
        expect(
          find.descendant(of: popup, matching: find.byType(SessionHarnessLogo)),
          findsWidgets,
        );
        await app.dismissModal();
        expect(app.optionsOf(app.modelPicker), [
          en.newSessionModelDefault,
          'GPT Test',
        ]);
        expect(app.optionsOf(app.modePicker), [
          en.newSessionModelDefault,
          'Ask first',
          'Auto approve',
        ]);

        await app.choose(app.agentPicker, 'Claude');
        expect(
          find.byKey(const Key('new-session-model-refresh')),
          findsNothing,
        );
        expect(app.modePicker, findsNothing, reason: 'no create-time modes');
      },
    );
  });

  group('creating', () {
    featureTest(
      'what was chosen is exactly what the broker is asked for, the new '
      'session opens in a tab attached as a resume, and the next sheet '
      'remembers the model for that agent',
      (f) async {
        final studio = studioWithAgents(f);
        await f.storage.seedServer(studio);
        final app = await f.launch();
        await app.openNewSession();

        await app.choose(app.modelPicker, 'GPT Test');
        await app.choose(app.modePicker, 'Auto approve');
        await app.enterText(
          find.byKey(const Key('new-session-directory')),
          '/work/shop',
        );
        await app.enterText(
          find.byKey(const Key('new-session-title')),
          'Checkout flow',
        );
        await app.submitNewSession();
        await app.pumpUntil(
          () => app.tab('created-1').evaluate().isNotEmpty,
          reason: 'the created session opens in a tab',
        );

        final create = studio.requestsTo('/api/sessions/codex', method: 'POST');
        expect(create, hasLength(1));
        expect(create.single.body, {
          'directory': '/work/shop',
          'title': 'Checkout flow',
          'model': {
            'providerID': 'openai',
            'modelID': 'gpt-test',
            'reasoningEffort': 'low',
          },
          'permissionMode': 'auto',
        });
        final socket = f.network.sockets.singleWhere(
          (s) => s.url.path.contains('created-1'),
        );
        expect(socket.url.queryParameters['mode'], 'resume');
        expect(socket.url.queryParameters['reason'], 'create');
        expect(find.byKey(const Key('new-session-launch-page')), findsNothing);

        await app.openNewSession();
        expect(
          find.descendant(of: app.modelPicker, matching: find.text('GPT Test')),
          findsOneWidget,
          reason: 'the last model for this agent comes back',
        );
      },
    );

    featureTest(
      'New session on a project starts in its directory; the global button '
      'starts blank',
      (f) async {
        final studio = studioWithAgents(f);
        await f.storage.seedServer(studio);
        final app = await f.launch();

        await app.openProjectMenu('/work/app');
        await app.tap(find.byKey(const Key('project-menu-new-/work/app')));
        expect(
          find.byKey(const Key('new-session-project-context')),
          findsOneWidget,
        );
        final field = app.tester.widget<TextField>(
          find.byKey(const Key('new-session-directory')),
        );
        expect(field.controller!.text, '/work/app');
        await app.tester.tap(find.text('Cancel'));
        await app.settle();

        await app.openNewSession();
        expect(
          app.tester
              .widget<TextField>(find.byKey(const Key('new-session-directory')))
              .controller!
              .text,
          isEmpty,
        );
        expect(
          find.byKey(const Key('new-session-project-context')),
          findsNothing,
        );
      },
    );

    featureTest(
      'a model catalog that fails says so and can be refreshed; an agent '
      'with no catalog offers only its default',
      (f) async {
        final studio = studioWithAgents(f);
        await f.storage.seedServer(studio);
        studio.respondNext(
          'GET',
          '/api/agents/codex/models',
          FakeBrokerResponse.error(
            503,
            'UNAVAILABLE',
            'catalog $rawLeakSentinel',
          ),
        );
        final app = await f.launch();
        await app.openNewSession();

        expect(find.text(en.newSessionModelRefresh), findsWidgets);
        app.expectNoRawErrorLeak();
        await app.tapKey('new-session-model-refresh');
        expect(app.optionsOf(app.modelPicker), contains('GPT Test'));
        expect(
          find.byKey(const Key('new-session-model-refresh')),
          findsNothing,
        );
      },
    );

    featureTest(
      'a creation the broker refuses stays on the launch page with Retry '
      'and Back; retrying creates it once it can',
      (f) async {
        final studio = studioWithAgents(f);
        await f.storage.seedServer(studio);
        studio.respondNext(
          'POST',
          '/api/sessions/codex',
          FakeBrokerResponse.error(500, 'CREATE_FAILED', 'no $rawLeakSentinel'),
        );
        final app = await f.launch();
        await app.openNewSession();
        await app.submitNewSession();
        await app.waitFor(find.byKey(const Key('new-session-launch-failed')));
        app.expectNoRawErrorLeak();
        expect(find.byKey(const Key('new-session-launch-back')), findsOne);

        await app.tapKey('new-session-launch-retry');
        await app.pumpUntil(
          () => app.tab('created-1').evaluate().isNotEmpty,
          reason: 'the retried creation opens',
        );
        expect(
          studio.requestsTo('/api/sessions/codex', method: 'POST'),
          hasLength(2),
        );
      },
    );
  });

  group('readiness', () {
    featureTest(
      'with no agent able to create sessions the app says so and offers no '
      'New session; once one is registered, Refresh makes it available',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..agents = [
            fakeAgent(
              id: 'cline',
              displayName: 'Cline',
              canCreateSession: false,
            ),
          ];
        await f.storage.seedServer(studio);
        final app = await f.launch();
        // An empty seven-day window says so first; widen it to read the
        // server's own state.
        await app.tapKey('workspace-empty-show-all');

        expect(
          find.text(en.sessionsWorkspaceEmptyCreationUnavailable),
          findsOneWidget,
        );
        await app.openNewSession();
        expect(find.byKey(const Key('new-session-agent')), findsNothing);

        studio.agents = [fakeAgent()];
        await app.tapKey('roster-freshness-refresh');
        await app.pumpUntil(
          () => find.text(en.sessionsWorkspaceEmpty).evaluate().isNotEmpty,
          reason: 'creation becomes available',
        );
        await app.openNewSession();
        expect(app.optionsOf(app.agentPicker), ['Codex']);
      },
    );

    featureTest(
      'when the agent list cannot be read the app says it could not check, '
      'rather than that there are no agents',
      (f) async {
        final studio = f.network.add('http://studio.test:7734');
        await f.storage.seedServer(studio);
        studio.respondNext(
          'GET',
          '/api/agents',
          FakeBrokerResponse.error(500, 'AGENTS', 'down $rawLeakSentinel'),
        );
        final app = await f.launch();
        await app.tapKey('workspace-empty-show-all');
        expect(
          find.text(en.sessionsWorkspaceEmptyCreationCheckFailed),
          findsOneWidget,
        );
        app.expectNoRawErrorLeak();
      },
    );
  });
}
