import { compareSemanticVersions } from '@cosyncing/adapter-api';
import { opencodeGeneration } from './generation.ts';
import { OPENCODE_V2_MINIMUM_VERSION, readRegistration, registrationAuthorization, type V2Registration } from './v2/registration.ts';
import { V2Error, V2Transport } from './v2/transport.ts';

export type BindingReason = 'v2-service-not-running' | 'v2-service-starting' | 'registration-invalid' | 'credential-required' | 'credential-rejected' | 'v2-below-floor' | 'future-major';
export type V2Binding = Readonly<{
  generation: 2;
  baseUrl: string;
  auth?: string;
  identity: string;
  source: 'registration' | 'explicit';
  version: string;
  pid: number;
}>;
export type OpenCodeBinding = { generation: 1; baseUrl: string; explicit: boolean } | V2Binding | { generation: 'none'; reason: BindingReason; detail?: string };

export class BindingResolver {
  private cached?: { key: string; at: number; binding: OpenCodeBinding };
  private pending?: { key: string; promise: Promise<OpenCodeBinding> };
  constructor(private readonly baseUrl: string, private readonly explicit: boolean, private readonly ownedV1: () => boolean = () => false) {}

  invalidate(): void { this.cached = undefined; }

  async resolve(fresh = false): Promise<OpenCodeBinding> {
    const generation = opencodeGeneration();
    const registration = readRegistration();
    const legacy = { generation: 1 as const, baseUrl: this.baseUrl, explicit: this.explicit };
    if (!this.explicit) {
      if (generation.kind === 'v1' || generation.kind === 'unparsable' || (generation.kind === 'absent' && registration.kind === 'absent')) return legacy;
      if (generation.kind === 'future') return { generation: 'none', reason: 'future-major' };
      if (registration.kind !== 'valid') {
        if (this.ownedV1()) return legacy;
        return { generation: 'none', reason: registration.kind === 'invalid' ? 'registration-invalid' : 'v2-service-not-running', ...(registration.kind === 'invalid' ? { detail: registration.detail } : {}) };
      }
    }
    let record: V2Registration | undefined = registration.kind === 'valid' ? registration.registration : undefined;
    let base = this.baseUrl;
    if (!this.explicit) base = record!.url;
    else {
      try {
        const url = new URL(base);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search || url.pathname !== '/') return { generation: 'none', reason: 'registration-invalid', detail: 'Configured URL must be an HTTP(S) origin without credentials or a path.' };
        base = url.origin;
        if (record?.url !== base) record = undefined;
      } catch { return { generation: 'none', reason: 'registration-invalid', detail: 'Configured URL is invalid.' }; }
    }
    // This key stays private: it contains a credential and must never enter logs or diagnostics.
    const key = JSON.stringify([base, this.explicit, record]);
    if (!fresh && this.cached?.key === key && Date.now() - this.cached.at < 5000) return this.cached.binding;
    if (this.pending?.key === key) return this.pending.promise;
    const promise = this.probe(base, record, legacy).then((binding) => {
      this.cached = { key, at: Date.now(), binding };
      return binding;
    }).finally(() => { if (this.pending?.promise === promise) this.pending = undefined; });
    this.pending = { key, promise };
    return promise;
  }

  private async probe(base: string, registration: V2Registration | undefined, legacy: Extract<OpenCodeBinding, { generation: 1 }>): Promise<OpenCodeBinding> {
    const auth = registrationAuthorization(registration);
    try {
      const info = await new V2Transport(base, auth).json('/api/info', { timeoutMs: 1500, maxBytes: 64 * 1024 });
      if (typeof info?.version !== 'string' || !Number.isSafeInteger(info.pid) || info.pid <= 0 || compareSemanticVersions(info.version, info.version) === undefined) {
        if (this.explicit) return legacy;
        return { generation: 'none', reason: 'v2-service-not-running' };
      }
      const major = Number(info.version.split('.')[0]);
      if (major > 2) return { generation: 'none', reason: 'future-major' };
      if (major !== 2) return this.explicit ? legacy : { generation: 'none', reason: 'v2-service-not-running' };
      if (registration && (info.pid !== registration.pid || (registration.version !== undefined && info.version !== registration.version))) return { generation: 'none', reason: 'registration-invalid', detail: 'Registration PID or version does not match the service.' };
      if ((compareSemanticVersions(info.version, OPENCODE_V2_MINIMUM_VERSION) ?? -1) < 0) return { generation: 'none', reason: 'v2-below-floor' };
      return Object.freeze({ generation: 2, baseUrl: base, ...(auth ? { auth } : {}), identity: JSON.stringify([registration?.id, info.pid, info.version, base]), source: this.explicit ? 'explicit' : 'registration', version: info.version, pid: info.pid });
    } catch (error) {
      if (error instanceof V2Error) {
        if (error.reason === 'redirect') return { generation: 'none', reason: 'registration-invalid', detail: 'The identity endpoint redirected instead of identifying its service.' };
        if (error.reason === 'credential-required' || error.reason === 'credential-rejected' || error.reason === 'v2-service-starting') return { generation: 'none', reason: error.reason };
        if (this.explicit) return legacy;
      }
      if (this.ownedV1()) return legacy;
      return { generation: 'none', reason: 'v2-service-not-running' };
    }
  }
}
