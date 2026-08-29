import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:test/test.dart';

const _identityQuery =
    'clientVersion=0.0.0-dev&contractRevision=19&minimumBrokerRevision=16&'
    'contractSurfaceHash=fnv1a32%3A4531a029';

void main() {
  group('EndpointResolver', () {
    late EndpointResolver resolver;

    setUp(() {
      resolver = EndpointResolver(
        baseUrl: 'http://127.0.0.1:7734',
      );
    });

    test('healthEndpoint returns correct path', () {
      expect(resolver.healthEndpoint, 'http://127.0.0.1:7734/api/health');
    });

    test('agentModelsEndpoint encodes the capability owner', () {
      expect(
        resolver.agentModelsEndpoint('custom/tool'),
        'http://127.0.0.1:7734/api/agents/custom%2Ftool/models',
      );
    });

    test('agentRuntimeUpdatesEndpoint returns correct path', () {
      expect(
        resolver.agentRuntimeUpdatesEndpoint,
        'http://127.0.0.1:7734/api/agent-runtime-updates',
      );
    });

    test('runtimeUpdatePolicyEndpoint returns correct path', () {
      expect(
        resolver.runtimeUpdatePolicyEndpoint,
        'http://127.0.0.1:7734/api/agent-runtime-update-policy',
      );
    });

    test('agentRuntimeRestartEndpoint encodes agent', () {
      expect(
        resolver.agentRuntimeRestartEndpoint('codex runtime'),
        'http://127.0.0.1:7734/api/agent-runtime-updates/codex%20runtime/restart',
      );
    });

    test(
      'workspaceBrowsingSettingsEndpoint returns the owner setting path',
      () {
        expect(
          resolver.workspaceBrowsingSettingsEndpoint,
          'http://127.0.0.1:7734/api/broker/features/workspace-browsing',
        );
      },
    );

    test('agentRuntimeUpdatesEndpointFor encodes fresh=1', () {
      expect(
        resolver.agentRuntimeUpdatesEndpointFor(fresh: true),
        'http://127.0.0.1:7734/api/agent-runtime-updates?fresh=1',
      );
    });

    test('brokerHealthEndpoint returns correct path', () {
      expect(
        resolver.brokerHealthEndpoint,
        'http://127.0.0.1:7734/api/broker/health',
      );
    });

    test('brokerRestartAllEndpoint returns correct path', () {
      expect(
        resolver.brokerRestartAllEndpoint,
        'http://127.0.0.1:7734/api/broker/restart-all',
      );
    });

    test('tokdashQuotaEndpoint returns correct path', () {
      expect(
        resolver.tokdashQuotaEndpoint,
        'http://127.0.0.1:7734/api/tokdash/quota',
      );
    });

    test('tokdashQuotaPreferenceEndpoint returns correct path', () {
      expect(
        resolver.tokdashQuotaPreferenceEndpoint,
        'http://127.0.0.1:7734/api/tokdash/quota-preference',
      );
    });

    test('agentsEndpoint returns correct path', () {
      expect(resolver.agentsEndpoint, 'http://127.0.0.1:7734/api/agents');
    });

    test('sessionsEndpoint returns correct path', () {
      expect(resolver.sessionsEndpoint, 'http://127.0.0.1:7734/api/sessions');
    });

    test('sessionsEndpointFor declares the revision and explicit refresh', () {
      expect(
        resolver.sessionsEndpointFor(),
        'http://127.0.0.1:7734/api/sessions'
        '?contractRevision=$cosyncingClientContractRevision',
      );
      expect(
        resolver.sessionsEndpointFor(refresh: true),
        'http://127.0.0.1:7734/api/sessions'
        '?contractRevision=$cosyncingClientContractRevision&refresh=1',
      );
    });

    test('sessionRosterDeltasEndpointFor encodes revision and wait', () {
      expect(
        resolver.sessionRosterDeltasEndpointFor(after: 42, waitMs: 25000),
        'http://127.0.0.1:7734/api/session-roster-deltas'
        '?contractRevision=$cosyncingClientContractRevision'
        '&after=42&waitMs=25000',
      );
    });

    // EVERY roster read has to declare the SAME revision. Agents filtered at
    // one revision and sessions at another is not a smaller bug than no
    // filtering at all: it showed the agents and withheld all their work.
    //
    // The machine reads belong in this list for the same reason, and were the
    // ones missed. Aggregation returns those same rows gathered across this
    // broker and its peers, and resolution searches them, so an unstated
    // revision there contradicts the local roster the app is already showing.
    test('every roster read declares one and the same contract revision', () {
      final reads = [
        resolver.agentRosterEndpoint,
        resolver.sessionsEndpointFor(),
        resolver.sessionRosterDeltasEndpointFor(after: 0, waitMs: 0),
        resolver.machineRosterEndpoint,
        resolver.machineResolveEndpoint(
          machineId: 'peer-a',
          tool: 'kimi',
          sessionId: 'session-1',
        ),
      ];
      for (final read in reads) {
        expect(
          Uri.parse(read).queryParameters['contractRevision'],
          '$cosyncingClientContractRevision',
          reason: read,
        );
      }
    });

    test('schedule endpoints return and encode the broker paths', () {
      expect(
        resolver.schedulesEndpoint,
        'http://127.0.0.1:7734/api/schedules',
      );
      expect(
        resolver.scheduleEndpoint('schedule id/1'),
        'http://127.0.0.1:7734/api/schedules/schedule%20id%2F1',
      );
    });

    test('attentionEventsEndpoint returns attention feed path', () {
      expect(
        resolver.attentionEventsEndpoint,
        'http://127.0.0.1:7734/api/attention-events',
      );
    });

    test('attentionEventsEndpointFor encodes client and paging values', () {
      expect(
        resolver.attentionEventsEndpointFor(
          clientId: 'mobile phone',
          after: 12,
          limit: 50,
          waitMs: 1500,
        ),
        'http://127.0.0.1:7734/api/attention-events?clientId=mobile%20phone&after=12&limit=50&waitMs=1500',
      );
    });

    test('attentionEventAckEndpoint encodes event id', () {
      expect(
        resolver.attentionEventAckEndpoint('evt/1'),
        'http://127.0.0.1:7734/api/attention-events/evt%2F1/ack',
      );
    });

    test('attentionEventDismissEndpoint encodes event id', () {
      expect(
        resolver.attentionEventDismissEndpoint('evt 1'),
        'http://127.0.0.1:7734/api/attention-events/evt%201/dismiss',
      );
    });

    test('attentionEventsDismissBatchEndpoint returns bulk route', () {
      expect(
        resolver.attentionEventsDismissBatchEndpoint,
        'http://127.0.0.1:7734/api/attention-events/dismiss-batch',
      );
    });

    test('wakeTokensEndpoint returns wake-token path', () {
      expect(
        resolver.wakeTokensEndpoint,
        'http://127.0.0.1:7734/api/push/wake-tokens',
      );
    });

    test('wakeTokenEndpoint encodes deviceId', () {
      expect(
        resolver.wakeTokenEndpoint('device id/1'),
        'http://127.0.0.1:7734/api/push/wake-tokens/device%20id%2F1',
      );
    });

    test('createSessionEndpoint encodes tool name', () {
      expect(
        resolver.createSessionEndpoint('opencode'),
        'http://127.0.0.1:7734/api/sessions/opencode',
      );
    });

    test('machinesEndpoint stays a bare prefix for the resolve path', () {
      expect(
        resolver.machinesEndpoint,
        'http://127.0.0.1:7734/api/machines',
      );
    });

    test('machineRosterEndpoint declares the revision', () {
      expect(
        resolver.machineRosterEndpoint,
        'http://127.0.0.1:7734/api/machines'
        '?contractRevision=$cosyncingClientContractRevision',
      );
    });

    test(
      'machineResolveEndpoint declares the revision before its identity',
      () {
        expect(
          resolver.machineResolveEndpoint(
            machineId: 'peer a',
            tool: 'kimi',
            sessionId: 'session/1',
          ),
          'http://127.0.0.1:7734/api/machines/resolve'
          '?contractRevision=$cosyncingClientContractRevision'
          '&machineId=peer%20a&tool=kimi&sessionId=session%2F1',
        );
      },
    );

    test('renameSessionEndpoint encodes tool and id', () {
      expect(
        resolver.renameSessionEndpoint('opencode', 'session-123'),
        'http://127.0.0.1:7734/api/sessions/opencode/session-123/rename',
      );
    });

    test('renameProjectEndpoint returns the shared project path', () {
      expect(
        resolver.renameProjectEndpoint,
        'http://127.0.0.1:7734/api/projects/rename',
      );
    });

    test('clearSessionCacheEndpoint encodes tool and id', () {
      expect(
        resolver.clearSessionCacheEndpoint('opencode', 'session-123'),
        'http://127.0.0.1:7734/api/sessions/opencode/session-123/cache',
      );
    });

    test('forkSessionEndpoint encodes tool and id', () {
      expect(
        resolver.forkSessionEndpoint('opencode', 'session-123'),
        'http://127.0.0.1:7734/api/sessions/opencode/session-123/fork',
      );
    });

    test('cloneSessionEndpoint encodes tool and id', () {
      expect(
        resolver.cloneSessionEndpoint('opencode', 'session-123'),
        'http://127.0.0.1:7734/api/sessions/opencode/session-123/clone',
      );
    });

    test('exportPreflightEndpoint encodes tool and id', () {
      expect(
        resolver.exportPreflightEndpoint('opencode', 'session-123'),
        'http://127.0.0.1:7734/api/sessions/opencode/session-123/export/preflight',
      );
    });

    test('exportSessionEndpoint encodes tool and id', () {
      expect(
        resolver.exportSessionEndpoint('opencode', 'session-123'),
        'http://127.0.0.1:7734/api/sessions/opencode/session-123/export',
      );
    });

    test('artifactEndpoint encodes all segments', () {
      expect(
        resolver.artifactEndpoint('opencode', 'session-123', 'artifact-456'),
        'http://127.0.0.1:7734/api/sessions/opencode/session-123/artifact/artifact-456',
      );
    });

    test('fsDirectoryEndpoint encodes tool and id', () {
      expect(
        resolver.fsDirectoryEndpoint('opencode', 'session-123'),
        'http://127.0.0.1:7734/api/sessions/opencode/session-123/fs',
      );
    });

    test('fsReadEndpoint encodes tool and id', () {
      expect(
        resolver.fsReadEndpoint('opencode', 'session-123'),
        'http://127.0.0.1:7734/api/sessions/opencode/session-123/fs/read',
      );
    });

    test('fsDownloadEndpoint encodes tool and id', () {
      expect(
        resolver.fsDownloadEndpoint('opencode', 'session-123'),
        'http://127.0.0.1:7734/api/sessions/opencode/session-123/fs/download',
      );
    });

    test('uploadInitEndpoint encodes tool and id', () {
      expect(
        resolver.uploadInitEndpoint('opencode', 'session-123'),
        'http://127.0.0.1:7734/api/sessions/opencode/session-123/uploads',
      );
    });

    test('uploadStatusEndpoint encodes tool, id, and uploadId', () {
      expect(
        resolver.uploadStatusEndpoint('opencode', 'session-123', 'upload-456'),
        'http://127.0.0.1:7734/api/sessions/opencode/session-123/uploads/upload-456',
      );
    });

    test('uploadCompleteEndpoint encodes tool, id, and uploadId', () {
      expect(
        resolver.uploadCompleteEndpoint(
          'opencode',
          'session-123',
          'upload-456',
        ),
        'http://127.0.0.1:7734/api/sessions/opencode/session-123/uploads/upload-456/complete',
      );
    });

    group('streamEndpoint', () {
      test('converts http to ws', () {
        expect(
          resolver.streamEndpoint('opencode', 'session-123'),
          'ws://127.0.0.1:7734/api/sessions/opencode/session-123/stream?$_identityQuery',
        );
      });

      test('converts https to wss', () {
        final httpsResolver = EndpointResolver(
          baseUrl: 'https://broker.example.com',
        );
        expect(
          httpsResolver.streamEndpoint('opencode', 'session-123'),
          'wss://broker.example.com/api/sessions/opencode/session-123/stream?$_identityQuery',
        );
      });

      test('never includes the shared credential in the URL', () {
        final withToken = EndpointResolver(
          baseUrl: 'http://127.0.0.1:7734',
          token: 'test-token',
        );
        expect(
          withToken.streamEndpoint('opencode', 'session-123'),
          'ws://127.0.0.1:7734/api/sessions/opencode/session-123/stream?$_identityQuery',
        );
      });

      test('never includes the paired-device credential in the URL', () {
        final withPeerToken = EndpointResolver(
          baseUrl: 'http://127.0.0.1:7734',
          peerToken: 'peer-token',
        );
        expect(
          withPeerToken.streamEndpoint('opencode', 'session-123'),
          'ws://127.0.0.1:7734/api/sessions/opencode/session-123/stream?$_identityQuery',
        );
      });

      test(
        'legacy credential query requires an explicit old-broker branch',
        () {
          final withToken = EndpointResolver(
            baseUrl: 'https://old-broker.example.com',
            token: 'rollout-token',
          );
          expect(
            Uri.parse(
              withToken.streamEndpoint(
                'opencode',
                'session-123',
                legacyCredentialQuery: true,
              ),
            ).queryParameters['token'],
            'rollout-token',
          );
        },
      );

      test('includes mode query param', () {
        expect(
          resolver.streamEndpoint('opencode', 'session-123', mode: 'resume'),
          'ws://127.0.0.1:7734/api/sessions/opencode/session-123/stream?mode=resume&$_identityQuery',
        );
      });

      test('includes readOnly query param when declared', () {
        expect(
          resolver.streamEndpoint('opencode', 'session-123', readOnly: true),
          'ws://127.0.0.1:7734/api/sessions/opencode/session-123/stream?readOnly=1&$_identityQuery',
        );
      });

      test('omits readOnly unless declared', () {
        expect(
          resolver.streamEndpoint('opencode', 'session-123'),
          isNot(contains('readOnly')),
        );
      });

      test('includes reason query param only alongside mode=resume', () {
        expect(
          resolver.streamEndpoint(
            'opencode',
            'session-123',
            mode: 'resume',
            reason: 'app-restore',
          ),
          'ws://127.0.0.1:7734/api/sessions/opencode/session-123/stream?mode=resume&reason=app-restore&$_identityQuery',
        );
        // An Observe attach must stay reason-free (the broker rejects the
        // pair), so a stale stored reason cannot poison a bare attach.
        expect(
          resolver.streamEndpoint(
            'opencode',
            'session-123',
            reason: 'app-restore',
          ),
          'ws://127.0.0.1:7734/api/sessions/opencode/session-123/stream?$_identityQuery',
        );
      });

      test('sends only takeover as a reason on mode=live', () {
        // Takeover is the one intent a live attach can carry: it means seize
        // the running session, which is what attaching live does. A Kimi
        // demoted generation needs exactly this.
        expect(
          resolver.streamEndpoint(
            'kimi',
            'session-123',
            mode: 'live',
            reason: 'takeover',
          ),
          'ws://127.0.0.1:7734/api/sessions/kimi/session-123/stream?mode=live&reason=takeover&$_identityQuery',
        );
        // The others describe reopening a connection this app previously owned
        // — the resume path. The broker rejects them on live, so a retained
        // restore intent meeting a live session must not build a request whose
        // only possible answer is 400.
        for (final stale in [
          'app-restore',
          'lease-restore',
          'create',
          'join-existing',
        ]) {
          expect(
            resolver.streamEndpoint(
              'kimi',
              'session-123',
              mode: 'live',
              reason: stale,
            ),
            'ws://127.0.0.1:7734/api/sessions/kimi/session-123/stream?mode=live&$_identityQuery',
            reason: '$stale must not ride a live attach',
          );
        }
      });

      test('includes owner revision only for join-existing', () {
        const revision = SessionOwnerRevision(epoch: 'broker/epoch', seq: 9);
        final join = Uri.parse(
          resolver.streamEndpoint(
            'pi',
            'session-123',
            mode: 'resume',
            reason: 'join-existing',
            ownerRevision: revision,
          ),
        ).queryParameters;
        expect(join['ownerEpoch'], 'broker/epoch');
        expect(join['ownerSeq'], '9');

        final restore = Uri.parse(
          resolver.streamEndpoint(
            'pi',
            'session-123',
            mode: 'resume',
            reason: 'app-restore',
            ownerRevision: revision,
          ),
        ).queryParameters;
        expect(restore.containsKey('ownerEpoch'), isFalse);
        expect(restore.containsKey('ownerSeq'), isFalse);
      });

      test('includes since query param', () {
        expect(
          resolver.streamEndpoint('opencode', 'session-123', since: 'abc123'),
          'ws://127.0.0.1:7734/api/sessions/opencode/session-123/stream?since=abc123&$_identityQuery',
        );
      });

      test('includes ticket query param', () {
        expect(
          resolver.streamEndpoint(
            'opencode',
            'session-123',
            ticket: 'cursor-v1',
          ),
          'ws://127.0.0.1:7734/api/sessions/opencode/session-123/stream?ticket=cursor-v1&$_identityQuery',
        );
      });

      test('includes artifactMode query param', () {
        expect(
          resolver.streamEndpoint(
            'opencode',
            'session-123',
            artifactMode: 'reference',
          ),
          'ws://127.0.0.1:7734/api/sessions/opencode/session-123/stream?artifactMode=reference&$_identityQuery',
        );
      });

      test('includes initialHistory query param', () {
        expect(
          resolver.streamEndpoint(
            'opencode',
            'session-123',
            initialHistory: 77,
          ),
          'ws://127.0.0.1:7734/api/sessions/opencode/session-123/stream?initialHistory=77&$_identityQuery',
        );
      });

      test('combines all query params', () {
        final withToken = EndpointResolver(
          baseUrl: 'http://127.0.0.1:7734',
          token: 'test-token',
        );
        final url = withToken.streamEndpoint(
          'opencode',
          'session-123',
          mode: 'resume',
          ticket: 'cursor-xyz',
          initialHistory: 250,
          artifactMode: 'reference',
        );
        expect(
          url,
          startsWith(
            'ws://127.0.0.1:7734/api/sessions/opencode/session-123/stream?',
          ),
        );
        expect(url, isNot(contains('token=test-token')));
        expect(url, contains('mode=resume'));
        expect(url, contains('ticket=cursor-xyz'));
        expect(url, contains('initialHistory=250'));
        expect(url, contains('artifactMode=reference'));
        expect(url, contains(_identityQuery));
      });

      test('one-use authorization ticket is the only WebSocket query', () {
        final url =
            EndpointResolver(
              baseUrl: 'https://broker.example.com',
              token: 'long-lived-secret',
            ).streamEndpoint(
              'opencode',
              'session-123',
              mode: 'resume',
              wsAuthTicket: 'short-lived-ticket',
            );
        expect(
          url,
          'wss://broker.example.com/api/sessions/opencode/session-123/stream?wsAuthTicket=short-lived-ticket',
        );
      });

      test('encodes special characters in tool and id', () {
        expect(
          resolver.streamEndpoint('my tool', 'session/123'),
          'ws://127.0.0.1:7734/api/sessions/my%20tool/session%2F123/stream?$_identityQuery',
        );
      });
    });

    test('authHeaders is empty when no token', () {
      expect(resolver.authHeaders, isEmpty);
    });

    test('authHeaders contains token when set', () {
      final withToken = EndpointResolver(
        baseUrl: 'http://127.0.0.1:7734',
        token: 'test-token',
      );
      expect(withToken.authHeaders, {'x-cosyncing-token': 'test-token'});
    });

    test('authHeaders contains paired-device token when set', () {
      final withPeerToken = EndpointResolver(
        baseUrl: 'http://127.0.0.1:7734',
        peerToken: 'peer-token',
      );
      expect(withPeerToken.authHeaders, {
        'x-cosyncing-peer-token': 'peer-token',
      });
    });

    test('profile and incarnation scope authenticated HTTP requests', () {
      final scoped = EndpointResolver(
        baseUrl: 'http://127.0.0.1:7734',
        token: 'shared',
        clientProfileId: 'profile-a',
        clientProfileIncarnation: 'incarnation-2',
      );

      expect(scoped.authHeaders, {
        'x-cosyncing-token': 'shared',
        'x-cosyncing-client-profile': 'profile-a',
        'x-cosyncing-client-incarnation': 'incarnation-2',
      });
      final stream = scoped.streamEndpoint('codex', 'session-a');
      expect(stream, isNot(contains('clientProfileId')));
      expect(stream, isNot(contains('clientProfileIncarnation')));
    });

    test('rejects a partial client profile scope', () {
      expect(
        () => EndpointResolver(
          baseUrl: 'http://127.0.0.1:7734',
          clientProfileId: 'profile-a',
        ),
        throwsArgumentError,
      );
    });

    test('hasCredential is false when no token is configured', () {
      expect(resolver.hasCredential, isFalse);
    });

    test('hasCredential recognizes a shared token', () {
      final withToken = EndpointResolver(
        baseUrl: 'http://127.0.0.1:7734',
        token: 'test-token',
      );
      expect(withToken.hasCredential, isTrue);
    });

    test('hasCredential recognizes a paired-device token', () {
      final withPeerToken = EndpointResolver(
        baseUrl: 'http://127.0.0.1:7734',
        peerToken: 'peer-token',
      );
      expect(withPeerToken.hasCredential, isTrue);
    });

    test('shared and paired-device credentials are mutually exclusive', () {
      expect(
        () => EndpointResolver(
          baseUrl: 'http://127.0.0.1:7734',
          token: 'owner',
          peerToken: 'peer',
        ),
        throwsArgumentError,
      );
    });

    test('jsonHeaders includes content-type and auth', () {
      final withToken = EndpointResolver(
        baseUrl: 'http://127.0.0.1:7734',
        token: 'test-token',
      );
      expect(withToken.jsonHeaders, {
        'Content-Type': 'application/json',
        'x-cosyncing-token': 'test-token',
      });
    });
  });
}
