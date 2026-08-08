import 'package:broker_contract/broker_contract.dart';
import 'package:test/test.dart';

void main() {
  group('SlashCommand', () {
    test('fromJson parses all fields', () {
      final json = {
        'name': 'build',
        'description': 'Build the project',
        'usage': '/build [target]',
        'kind': 'prompt',
      };

      final cmd = SlashCommand.fromJson(json);
      expect(cmd.name, 'build');
      expect(cmd.description, 'Build the project');
      expect(cmd.usage, '/build [target]');
      expect(cmd.kind, SlashCommandKind.prompt);
    });

    test('fromJson handles null optional fields', () {
      final json = {'name': 'test'};
      final cmd = SlashCommand.fromJson(json);
      expect(cmd.name, 'test');
      expect(cmd.description, isNull);
      expect(cmd.usage, isNull);
      expect(cmd.kind, SlashCommandKind.unknown);
    });

    test('parses action and fails closed for future kinds', () {
      expect(
        SlashCommand.fromJson({'name': 'goal', 'kind': 'action'}).kind,
        SlashCommandKind.action,
      );
      expect(
        SlashCommand.fromJson({'name': 'future', 'kind': 'background'}).kind,
        SlashCommandKind.unknown,
      );
    });

    test('roundtrip serialization', () {
      final json = {
        'name': 'run',
        'description': 'Run tests',
      };
      final cmd = SlashCommand.fromJson(json);
      final restored = SlashCommand.fromJson(cmd.toJson());
      expect(restored.name, 'run');
      expect(restored.description, 'Run tests');
    });
  });

  group('ModelOption', () {
    test('fromJson parses all fields', () {
      final json = {
        'providerID': 'anthropic',
        'modelID': 'claude-sonnet-4-6',
        'label': 'Claude Sonnet',
        'description': 'Fast model',
        'variant': 'default',
      };

      final model = ModelOption.fromJson(json);
      expect(model.providerID, 'anthropic');
      expect(model.modelID, 'claude-sonnet-4-6');
      expect(model.label, 'Claude Sonnet');
      expect(model.description, 'Fast model');
      expect(model.variant, 'default');
    });

    test('fromJson handles null optional fields', () {
      final json = {
        'providerID': 'openai',
        'modelID': 'gpt-4o',
        'label': 'GPT-4o',
      };
      final model = ModelOption.fromJson(json);
      expect(model.providerID, 'openai');
      expect(model.modelID, 'gpt-4o');
      expect(model.label, 'GPT-4o');
      expect(model.variant, isNull);
      expect(model.description, isNull);
      expect(model.reasoningEfforts, isNull);
    });

    test('fromJson parses reasoningEfforts', () {
      final json = {
        'providerID': 'anthropic',
        'modelID': 'claude-sonnet-4-6',
        'label': 'Claude Sonnet',
        'reasoningEfforts': [
          {'effort': 'low', 'label': 'Low'},
          {'effort': 'high', 'label': 'High', 'description': 'Deep think'},
        ],
      };

      final model = ModelOption.fromJson(json);
      expect(model.reasoningEfforts, hasLength(2));
      expect(model.reasoningEfforts!.first.effort, 'low');
      expect(model.reasoningEfforts!.last.description, 'Deep think');
    });

    test('preserves model-scoped Codex Ultra metadata as opaque strings', () {
      final sol = ModelOption.fromJson({
        'providerID': 'openai',
        'modelID': 'gpt-5.6-sol',
        'label': 'GPT-5.6 Sol',
        'defaultReasoningEffort': 'medium',
        'reasoningEfforts': [
          {'effort': 'max', 'label': 'Max'},
          {
            'effort': 'ultra',
            'label': 'Ultra',
            'description': 'Maximum reasoning with automatic task delegation',
          },
        ],
      });
      final luna = ModelOption.fromJson({
        'providerID': 'openai',
        'modelID': 'gpt-5.6-luna',
        'label': 'GPT-5.6 Luna',
        'reasoningEfforts': [
          {'effort': 'max', 'label': 'Max'},
        ],
      });

      final ultra = sol.reasoningEfforts!.last;
      expect(ultra.effort, 'ultra');
      expect(ultra.label, 'Ultra');
      expect(
        ultra.description,
        'Maximum reasoning with automatic task delegation',
      );
      expect(
        luna.reasoningEfforts,
        isNot(contains(predicate<ReasoningEffort>((e) => e.effort == 'ultra'))),
      );
    });

    test('tolerates unknown fields', () {
      final json = {
        'providerID': 'p',
        'modelID': 'm',
        'label': 'L',
        'futureField': true,
      };
      final model = ModelOption.fromJson(json);
      expect(model.providerID, 'p');
    });
  });

  group('AgentOption', () {
    test('fromJson parses all fields', () {
      final json = {
        'name': 'build',
        'description': 'Builder agent',
      };

      final agent = AgentOption.fromJson(json);
      expect(agent.name, 'build');
      expect(agent.description, 'Builder agent');
    });

    test('fromJson handles null description', () {
      final json = {'name': 'test'};
      final agent = AgentOption.fromJson(json);
      expect(agent.name, 'test');
      expect(agent.description, isNull);
    });
  });

  group('ModeOption', () {
    test('fromJson parses all fields', () {
      final json = {
        'value': 'ask-permission',
        'label': 'Ask Permission',
        'description': 'Require approval',
        'category': 'ask-permission',
      };

      final mode = ModeOption.fromJson(json);
      expect(mode.value, 'ask-permission');
      expect(mode.label, 'Ask Permission');
      expect(mode.description, 'Require approval');
      expect(mode.category, 'ask-permission');
    });

    test('fromJson handles null optional fields', () {
      final json = {
        'value': 'full-access',
        'label': 'Full Access',
      };
      final mode = ModeOption.fromJson(json);
      expect(mode.value, 'full-access');
      expect(mode.label, 'Full Access');
      expect(mode.description, isNull);
      expect(mode.category, isNull);
    });
  });
}
