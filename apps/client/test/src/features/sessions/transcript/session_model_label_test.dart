import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_presentation.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('prefers an adapter-authored human label', () {
    final session = _session(
      currentModel: const SessionCurrentModel(
        providerID: 'anthropic',
        modelID: 'claude-opus-4-8-20260701',
        label: 'Opus 4.8',
      ),
    );

    expect(sessionModelLabel(session), 'Opus 4.8');
  });

  test('derives a compact known-family label from a technical id', () {
    final session = _session(
      currentModel: const SessionCurrentModel(
        providerID: 'openai',
        modelID: 'gpt-5.4-codex',
      ),
    );

    expect(sessionModelLabel(session), 'GPT-5.4');
    expect(sessionModelTechnicalId(session), 'openai/gpt-5.4-codex');
  });

  test('finds family versions on either side and ignores release dates', () {
    final cases = <String, String>{
      'claude-3-7-sonnet-20250219': 'Sonnet 3.7',
      'claude-opus-4-8-20260701': 'Opus 4.8',
      'gpt-5.4-codex': 'GPT-5.4',
    };

    for (final entry in cases.entries) {
      expect(
        sessionModelLabel(
          _session(
            currentModel: SessionCurrentModel(
              providerID: 'provider',
              modelID: entry.key,
            ),
          ),
        ),
        entry.value,
        reason: entry.key,
      );
    }
  });

  test('derives and exposes a legacy model id without currentModel', () {
    final session = _session(model: 'claude-3-7-sonnet-20250219');

    expect(sessionModelLabel(session), 'Sonnet 3.7');
    expect(
      sessionModelTechnicalId(session),
      'claude-3-7-sonnet-20250219',
    );
  });

  test('omits an unknown raw id instead of showing debug text inline', () {
    final session = _session(
      currentModel: const SessionCurrentModel(
        providerID: 'private-provider',
        modelID: 'vendor-model-123-build-9',
      ),
    );

    expect(sessionModelLabel(session), isNull);
    expect(
      sessionModelTechnicalId(session),
      'private-provider/vendor-model-123-build-9',
    );
  });
}

SessionInfo _session({SessionCurrentModel? currentModel, String? model}) =>
    SessionInfo(
      id: 'session-1',
      tool: 'codex',
      title: 'Model session',
      status: SessionStatus.idle,
      attachMode: AttachMode.observe,
      currentModel: currentModel,
      model: model,
    );
