import { readFileSync } from 'node:fs';

export function readJsonFile<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to read JSON ${path}: ${message}`);
  }
}
