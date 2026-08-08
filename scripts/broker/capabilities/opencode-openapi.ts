export interface NormalizedEndpoint {
  method: string;
  path: string;
  nativeId: string;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

export function normalizeOpenCodeOpenApiEndpoints(doc: unknown): NormalizedEndpoint[] {
  const paths = (doc as { paths?: Record<string, unknown> })?.paths;
  if (!paths || typeof paths !== 'object') throw new Error('OpenAPI document is missing paths');
  const endpoints: NormalizedEndpoint[] = [];
  for (const [path, methods] of Object.entries(paths)) {
    if (!path.startsWith('/') || !methods || typeof methods !== 'object') continue;
    for (const method of Object.keys(methods as Record<string, unknown>)) {
      const lower = method.toLowerCase();
      if (!HTTP_METHODS.has(lower)) continue;
      const upper = lower.toUpperCase();
      endpoints.push({ method: upper, path, nativeId: `opencode:server:${upper}:${path}` });
    }
  }
  endpoints.sort((a, b) => a.nativeId.localeCompare(b.nativeId));
  return endpoints;
}
