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

  // P2/P8. A provider-qualified id is a raw id even without a digit, so it must
  // never reach the roster as if it were a name, and the family/version guess
  // must not invent one from it either. The adapter authors the label.
  test('never shows a provider-qualified id as a human label', () {
    // Exactly what the kimi adapter reports today: the bare `/status.model`
    // string in the legacy slot and no authored label at all.
    final kimi = _session(model: 'kimi-code/kimi-for-coding');

    expect(sessionModelLabel(kimi), isNull);
    expect(sessionModelTechnicalId(kimi), 'kimi-code/kimi-for-coding');

    final claude = _session(
      currentModel: const SessionCurrentModel(
        providerID: 'anthropic',
        modelID: 'claude-fable-5',
      ),
    );

    expect(sessionModelLabel(claude), isNull);
    expect(sessionModelTechnicalId(claude), 'anthropic/claude-fable-5');
  });

  test('shows the adapter-authored label for a provider-qualified id', () {
    final coding = _session(
      currentModel: const SessionCurrentModel(
        providerID: 'managed:kimi-code',
        modelID: 'kimi-code/kimi-for-coding',
        label: 'K2.7 Coding',
      ),
    );

    expect(sessionModelLabel(coding), 'K2.7 Coding');

    final k3 = _session(
      currentModel: const SessionCurrentModel(
        providerID: 'managed:kimi-code',
        modelID: 'kimi-code/k3-256k',
        label: 'K3-256k',
      ),
    );

    expect(sessionModelLabel(k3), 'K3-256k');
    // The tooltip keeps the provider-qualified identity the roster refuses to
    // print inline.
    expect(sessionModelTechnicalId(k3), contains('kimi-code/k3-256k'));

    final fable = _session(
      currentModel: const SessionCurrentModel(
        providerID: 'anthropic',
        modelID: 'claude-fable-5',
        label: 'Fable 5',
      ),
    );

    expect(sessionModelLabel(fable), 'Fable 5');
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
