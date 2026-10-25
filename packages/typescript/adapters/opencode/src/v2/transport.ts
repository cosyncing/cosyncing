export type V2Failure = 'credential-required' | 'credential-rejected' | 'not-found' | 'conflict' | 'rejected' | 'unavailable' | 'v2-service-starting' | 'invalid-response' | 'redirect';

export class V2Error extends Error {
  constructor(readonly reason: V2Failure, readonly ambiguous = false) {
    super(`OpenCode service request failed (${reason}).`);
    this.name = 'OpenCodeServiceError';
  }
}

export interface V2Event {
  type: string;
  data: Record<string, any>;
  created?: number;
  durable?: { aggregateID: string; seq: number; version?: number };
}

/** Credentials and native error bodies never appear in transport errors. */
export class V2Transport {
  constructor(readonly baseUrl: string, private readonly authorization?: string) {}

  private headers(sse = false): Record<string, string> {
    return {
      accept: sse ? 'text/event-stream' : 'application/json',
      'content-type': 'application/json',
      ...(this.authorization ? { authorization: this.authorization } : {}),
    };
  }

  private failure(status: number): V2Failure {
    if (status === 401 || status === 403) return this.authorization ? 'credential-rejected' : 'credential-required';
    if (status >= 300 && status < 400) return 'redirect';
    if (status === 404) return 'not-found';
    if (status === 409) return 'conflict';
    return status >= 500 ? 'unavailable' : 'rejected';
  }

  async json(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number } = {}): Promise<any> {
    const method = options.method ?? 'GET';
    const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 4000), ...(options.signal ? [options.signal] : [])]);
    let response: Response;
    try {
      response = await fetch(this.baseUrl + path, {
        method, headers: this.headers(), redirect: 'manual', signal,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch {
      throw new V2Error('unavailable', method !== 'GET');
    }
    const cap = options.maxBytes ?? 16 * 1024 * 1024;
    let text = '';
    try {
      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let bytes = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > cap) throw new V2Error('invalid-response', method !== 'GET' && response.ok);
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
    } catch (error) {
      if (error instanceof V2Error) throw error;
      throw new V2Error('unavailable', method !== 'GET' && response.ok);
    }
    let value: any;
    try { value = text ? JSON.parse(text) : undefined; } catch {
      if (!response.ok) throw new V2Error(this.failure(response.status));
      throw new V2Error('invalid-response', method !== 'GET');
    }
    if (response.status === 503 && value?.code === 'service_starting') throw new V2Error('v2-service-starting');
    if (!response.ok) throw new V2Error(this.failure(response.status));
    return value;
  }

  async *events(signal: AbortSignal, onOpen: () => void, idleMs: number): AsyncGenerator<V2Event> {
    const abort = new AbortController();
    const combined = AbortSignal.any([signal, abort.signal]);
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => abort.abort(), idleMs);
      timer.unref?.();
    };
    arm();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(this.baseUrl + '/api/event', { headers: this.headers(true), redirect: 'manual', signal: combined });
      if (!response.ok) throw new V2Error(this.failure(response.status));
      if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new V2Error('invalid-response');
      reader = response.body.getReader();
      onOpen();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        arm();
        buffer += decoder.decode(chunk.value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        let end: number;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (frame.length > 1024 * 1024) throw new V2Error('invalid-response');
          const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          let event: any;
          try { event = JSON.parse(data); } catch { throw new V2Error('invalid-response'); }
          if (typeof event?.type === 'string' && event.data && typeof event.data === 'object' && !Array.isArray(event.data)) yield event;
        }
        if (buffer.length > 1024 * 1024) throw new V2Error('invalid-response');
      }
    } finally {
      clearTimeout(timer!);
      abort.abort();
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
  }
}
