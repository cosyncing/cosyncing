/** Bounded history readers for the measured 0.142 and 0.155 protocol families.
 * No thread/read fallback: one long turn can contain an unbounded transcript. */
export async function recoverBackgroundItems(options: {
  threadId: string;
  turnIds: string[];
  request: (method: string, params: unknown) => Promise<any>;
  disabled: (method: string) => boolean;
  consume: (item: unknown, turnId: string) => void;
  needed: () => boolean;
  valid: () => boolean;
}): Promise<void> {
  let remaining = 4; // includes capability probes and legacy turn discovery
  const read = async (method: string, params: unknown): Promise<any> => {
    if (remaining-- <= 0 || !options.valid()) throw new Error('Background history budget exhausted');
    const value = await options.request(method, params);
    if (!options.valid()) throw new Error('Background observation superseded');
    if (!value || !Array.isArray(value.data) || value.data.length > 32
      || Buffer.byteLength(JSON.stringify(value)) > 128 * 1024
      || !(value.nextCursor === null || typeof value.nextCursor === 'string' && value.nextCursor.length > 0 && value.nextCursor.length <= 512)) {
      throw new Error('Invalid background history page');
    }
    return value;
  };
  if (!options.disabled('thread/items/list')) {
    let cursor: string | null = null;
    const seen = new Set<string>();
    try {
      while (remaining > 0 && options.needed()) {
        const value = await read('thread/items/list', { threadId: options.threadId, cursor, limit: 32, sortDirection: 'desc' });
        for (const entry of value.data) {
          if (entry && typeof entry.turnId === 'string') options.consume(entry.item, entry.turnId);
        }
        cursor = value.nextCursor;
        if (!cursor || seen.has(cursor)) return;
        seen.add(cursor);
      }
      return;
    } catch {
      if (!options.disabled('thread/items/list')) return; // transient failure is not a protocol-family switch
    }
  }
  if (remaining <= 0 || options.disabled('thread/turns/items/list') || !options.valid()) return;
  try {
    // Snapshot-only admissions may not yet know their turn. Discover just four recent
    // turn IDs, preferring exact IDs already learned from command notifications.
    const turns = await read('thread/turns/list', {
      threadId: options.threadId, limit: 4, sortDirection: 'desc', itemsView: 'summary',
    });
    const ids = [...new Set([...options.turnIds, ...turns.data.map((turn: any) => turn?.id)
      .filter((id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 512)])].slice(0, 4);
    for (const turnId of ids) {
      let cursor: string | null = null;
      const seen = new Set<string>();
      while (remaining > 0 && options.needed()) {
        const value = await read('thread/turns/items/list', {
          threadId: options.threadId, turnId, cursor, limit: 32, sortDirection: 'desc',
        });
        for (const item of value.data) options.consume(item, turnId);
        cursor = value.nextCursor;
        if (!cursor || seen.has(cursor)) break;
        seen.add(cursor);
      }
      if (remaining <= 0 || !options.needed()) break;
    }
  } catch { /* incomplete history establishes no absence or synthetic outcome */ }
}
