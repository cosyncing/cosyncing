import 'package:broker_contract/broker_contract.dart';
import 'package:test/test.dart';

void main() {
  group('OutboundFrame', () {
    test('prompt creates correct frame with text key', () {
      final frame = OutboundFrame.prompt('hello world');
      expect(frame['kind'], 'prompt');
      expect(frame['text'], 'hello world');
      expect(frame.containsKey('content'), isFalse);
    });

    test('prompt includes typed model and reasoning override', () {
      final frame = OutboundFrame.prompt(
        'hello',
        model: const SessionCurrentModel(
          providerID: 'openai',
          modelID: 'gpt-5.4',
          reasoningEffort: 'high',
          variant: 'codex',
        ),
      );

      expect(frame['model'], {
        'providerID': 'openai',
        'modelID': 'gpt-5.4',
        'reasoningEffort': 'high',
        'variant': 'codex',
      });
    });

    test('prompt sends inline and opaque staged files in one frame', () {
      final frame = OutboundFrame.prompt(
        'inspect both',
        clientMessageId: 'cm-attachments',
        files: const [
          PromptFileAttachment.inline(
            name: 'small.txt',
            mimeType: 'text/plain',
            size: 5,
            data: 'aGVsbG8=',
          ),
          PromptFileAttachment.staged(
            name: 'large.bin',
            mimeType: 'application/octet-stream',
            size: 300000,
            stagedRef: 'stg1.opaque',
          ),
        ],
      );

      expect(frame['clientMessageId'], 'cm-attachments');
      expect(frame['files'], [
        {
          'name': 'small.txt',
          'mimeType': 'text/plain',
          'size': 5,
          'data': 'aGVsbG8=',
        },
        {
          'name': 'large.bin',
          'mimeType': 'application/octet-stream',
          'size': 300000,
          'stagedRef': 'stg1.opaque',
        },
      ]);
      expect((frame['files'] as List).first, isNot(contains('path')));
    });

    test('prompt rejects attachment count above the retained bound', () {
      expect(
        () => OutboundFrame.prompt(
          '',
          files: List.generate(
            promptAttachmentMaxFiles + 1,
            (index) => PromptFileAttachment.inline(
              name: '$index.txt',
              mimeType: 'text/plain',
              size: 1,
              data: 'eA==',
            ),
          ),
        ),
        throwsRangeError,
      );
    });

    test('command creates correct frame', () {
      final frame = OutboundFrame.command('build');
      expect(frame['kind'], 'command');
      expect(frame['name'], 'build');
    });

    test('command includes args when provided', () {
      final frame = OutboundFrame.command(
        'run',
        args: {'model': 'claude-sonnet-4-6', 'agent': 'build'},
      );
      expect(frame['kind'], 'command');
      expect(frame['name'], 'run');
      expect(frame['model'], 'claude-sonnet-4-6');
      expect(frame['agent'], 'build');
    });

    test('command includes typed model override', () {
      final frame = OutboundFrame.command(
        'review',
        model: const SessionCurrentModel(
          providerID: 'anthropic',
          modelID: 'claude-opus-4-6',
          reasoningEffort: 'max',
        ),
      );

      expect(frame['model'], {
        'providerID': 'anthropic',
        'modelID': 'claude-opus-4-6',
        'reasoningEffort': 'max',
      });
    });

    test('command rejects a model arg that collides with typed override', () {
      expect(
        () => OutboundFrame.command(
          'review',
          args: {'model': 'legacy-model-arg'},
          model: const SessionCurrentModel(
            providerID: 'anthropic',
            modelID: 'claude-opus-4-6',
          ),
        ),
        throwsArgumentError,
      );
    });

    test('approve creates correct frame', () {
      final frame = OutboundFrame.approve('req-1', 'approve');
      expect(frame['kind'], 'approve');
      expect(frame['requestId'], 'req-1');
      expect(frame['decision'], 'approve');
    });

    test('setAgent creates correct frame', () {
      final frame = OutboundFrame.setAgent('plan');
      expect(frame['kind'], 'set-agent');
      expect(frame['agent'], 'plan');
      expect(frame.containsKey('clientMessageId'), isFalse);
      expect(
        OutboundFrame.setAgent('build', clientMessageId: 'cm-agent'),
        containsPair('clientMessageId', 'cm-agent'),
      );
    });

    test('answer creates correct frame with string[][]', () {
      final frame = OutboundFrame.answer('req-2', [
        ['yes'],
        ['option-a', 'option-b'],
      ]);
      expect(frame['kind'], 'answer');
      expect(frame['requestId'], 'req-2');
      expect(frame['answers'], [
        ['yes'],
        ['option-a', 'option-b'],
      ]);
    });

    test('rejectQuestion creates correct frame', () {
      final frame = OutboundFrame.rejectQuestion('req-3');
      expect(frame['kind'], 'reject-question');
      expect(frame['requestId'], 'req-3');
    });

    test('file creates correct frame with data key', () {
      final frame = OutboundFrame.file(
        name: 'readme.md',
        data: '# Hello',
        mimeType: 'text/markdown',
      );
      expect(frame['kind'], 'file');
      expect(frame['name'], 'readme.md');
      expect(frame['data'], '# Hello');
      expect(frame.containsKey('content'), isFalse);
      expect(frame['mimeType'], 'text/markdown');
    });

    test('file omits mimeType when null', () {
      final frame = OutboundFrame.file(
        name: 'data.txt',
        data: 'content',
      );
      expect(frame.containsKey('mimeType'), isFalse);
    });

    test('mutating frames include clientMessageId when provided', () {
      expect(
        OutboundFrame.prompt('hello', clientMessageId: 'cm-1'),
        containsPair('clientMessageId', 'cm-1'),
      );
      expect(
        OutboundFrame.command('build', clientMessageId: 'cm-2'),
        containsPair('clientMessageId', 'cm-2'),
      );
      expect(
        OutboundFrame.approve(
          'req-1',
          'approve',
          clientMessageId: 'cm-3',
        ),
        containsPair('clientMessageId', 'cm-3'),
      );
      expect(
        OutboundFrame.answer(
          'req-2',
          const [
            ['yes'],
          ],
          clientMessageId: 'cm-4',
        ),
        containsPair('clientMessageId', 'cm-4'),
      );
      expect(
        OutboundFrame.rejectQuestion('req-3', clientMessageId: 'cm-5'),
        containsPair('clientMessageId', 'cm-5'),
      );
      expect(
        OutboundFrame.file(
          name: 'data.txt',
          data: 'content',
          clientMessageId: 'cm-6',
        ),
        containsPair('clientMessageId', 'cm-6'),
      );
    });

    test('draft creates an ephemeral relay frame without idempotency id', () {
      final frame = OutboundFrame.draft('shared text');

      expect(frame, {'kind': 'draft', 'text': 'shared text'});
      expect(frame.containsKey('clientMessageId'), isFalse);
    });

    test('versioned draft carries updateId and baseRevision', () {
      final frame = OutboundFrame.draft(
        'shared text',
        updateId: 'u-42',
        baseRevision: 7,
      );

      expect(frame, {
        'kind': 'draft',
        'text': 'shared text',
        'updateId': 'u-42',
        'baseRevision': 7,
      });
      // Still outside the client-message idempotency journal.
      expect(frame.containsKey('clientMessageId'), isFalse);
    });

    test('plan action preserves semantic action and typed overrides', () {
      const request = PlanActionRequest(
        action: PlanActionKind.edit,
        planKey: 'tasks:main',
        planRevision: 'revision-7',
        title: 'Implementation plan',
        text: 'Move verification earlier',
        items: [
          PlanActionItem(
            id: '1',
            title: 'Implement',
            status: 'in-progress',
          ),
        ],
        model: SessionCurrentModel(
          providerID: 'anthropic',
          modelID: 'claude-opus-4-6',
        ),
        agent: 'plan',
        permissionMode: 'ask',
      );

      final frame = OutboundFrame.planAction(
        request,
        clientMessageId: 'cm-plan-1',
      );

      expect(frame['kind'], 'plan-action');
      expect(frame['action'], 'edit');
      expect(frame['planKey'], 'tasks:main');
      expect(frame['text'], 'Move verification earlier');
      expect(frame, isNot(contains('title')));
      expect(frame, isNot(contains('items')));
      expect(frame['model'], containsPair('modelID', 'claude-opus-4-6'));
      expect(frame['clientMessageId'], 'cm-plan-1');
      expect(
        PlanActionRequest.fromJson(request.toJson()).action,
        same(PlanActionKind.edit),
      );
    });

    test('plan actions reject malformed or incomplete authority', () {
      expect(
        () => OutboundFrame.planAction(
          const PlanActionRequest(
            action: PlanActionKind.approve,
            planKey: ' tasks:main',
            planRevision: 'revision-7',
          ),
        ),
        throwsArgumentError,
      );
      expect(
        () => PlanActionRequest.fromJson(const {
          'action': 'approve',
          'planKey': 'tasks:main',
        }),
        throwsFormatException,
      );
      expect(
        () => OutboundFrame.planAction(
          const PlanActionRequest(
            action: PlanActionKind.exit,
            planKey: 'tasks:main',
            planRevision: 'revision-7',
            text: 'not valid for exit',
          ),
        ),
        throwsArgumentError,
      );
    });

    test('artifact interaction forwards only signed trusted context', () {
      const request = ArtifactInteractionRequest(
        artifactKey: 'artifact-1',
        interactionRef: 'signed-ref-1',
        name: 'review.html',
        path: 'output/review.html',
        interaction: {
          'type': 'form_submit',
          'formId': 'decision',
          'data': {'choice': 'accept'},
        },
      );

      final frame = OutboundFrame.artifactInteraction(
        request,
        clientMessageId: 'cm-artifact-1',
      );

      expect(frame['kind'], 'artifact-interaction');
      expect(frame['artifactKey'], 'artifact-1');
      expect(frame['interactionRef'], 'signed-ref-1');
      expect(frame['interaction'], request.interaction);
      expect(frame, isNot(contains('name')));
      expect(frame, isNot(contains('path')));
      expect(frame['clientMessageId'], 'cm-artifact-1');
      expect(
        ArtifactInteractionRequest.fromJson(request.toJson()).artifactKey,
        'artifact-1',
      );
    });

    test('ack creates correct frame', () {
      final frame = OutboundFrame.ack(
        attachTicket: 't-1',
        clientMessageId: 'cm-1',
      );
      expect(frame['kind'], 'ack');
      expect(frame['attachTicket'], 't-1');
      expect(frame['clientMessageId'], 'cm-1');
    });

    test('ack omits optional fields when null', () {
      final frame = OutboundFrame.ack();
      expect(frame['kind'], 'ack');
      expect(frame.containsKey('attachTicket'), isFalse);
      expect(frame.containsKey('clientMessageId'), isFalse);
    });

    test('nack creates correct frame', () {
      final frame = OutboundFrame.nack(attachTicket: 't-2');
      expect(frame['kind'], 'nack');
      expect(frame['attachTicket'], 't-2');
      expect(frame.containsKey('clientMessageId'), isFalse);
    });
  });
}
