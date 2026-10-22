import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentMessage } from "@cosyncing/protocol";
import {
  ensureOwnerOnlyDirectory,
  enforceOwnerOnlyFile,
  assertNoSymlinkComponents,
} from "../security/secure-files.ts";

type ArtifactMessage = Extract<AgentMessage, { type: "file-artifact" }>;
export interface RemovedArtifact {
  key: string;
  tool: string;
  sessionId: string;
  artifactKey: string;
  contentHash: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: number;
  removedAt: number;
  qualified: boolean;
  proactive?: boolean;
  transcriptAnchor?: ArtifactMessage["transcriptAnchor"];
}
export interface ArtifactRemovalRemainder {
  path: string;
  source: string;
  contentHash: string;
  version: string;
  size: number;
}

/** Lazy durable tombstones and observable unlink remainders. No artifact bodies,
 * source URLs or auth material are stored here. A retired version stays retired
 * even if a crash leaves its former JSON index entry on disk. */
export class ArtifactDeletionJournal {
  private database?: Database;
  constructor(
    private readonly path: string,
    private readonly sources: readonly string[],
  ) {
    if (existsSync(path)) this.open();
  }
  private open(): Database {
    if (this.database) return this.database;
    ensureOwnerOnlyDirectory(dirname(this.path));
    assertNoSymlinkComponents(this.path);
    const db = new Database(this.path, { create: true });
    enforceOwnerOnlyFile(this.path);
    const version = db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()!.user_version;
    if (version > 1) {
      db.close();
      throw new Error("Unsupported artifact retirement schema");
    }
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS removed (key TEXT PRIMARY KEY,tool TEXT NOT NULL,session TEXT NOT NULL,artifact TEXT NOT NULL,created INTEGER NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS removed_session ON removed(tool,session,created);
      CREATE INDEX IF NOT EXISTS removed_artifact ON removed(tool,session,artifact,created);
      CREATE TABLE IF NOT EXISTS remainder (path TEXT PRIMARY KEY,body TEXT NOT NULL);`);
    db.exec("PRAGMA user_version=1");
    this.database = db;
    return db;
  }
  get(
    tool: string,
    session: string,
    artifact: string,
  ): RemovedArtifact | undefined {
    if (!this.database) return;
    const keys = this.sources.map((source) =>
      [source, tool, session, artifact].join("\0"),
    );
    const row = this.database
      .query<
        { body: string },
        string[]
      >(`SELECT body FROM removed WHERE key IN (${keys.map(() => "?").join(",")}) ORDER BY created DESC LIMIT 1`)
      .get(...keys);
    return row ? JSON.parse(row.body) : undefined;
  }
  session(tool: string, session: string, limit: number): RemovedArtifact[] {
    return (
      this.database
        ?.query<{ body: string }, Array<string | number>>(
          `SELECT body FROM removed WHERE tool=? AND session=? AND (${this.sources.map(() => "key=? || char(0) || tool || char(0) || session || char(0) || artifact").join(" OR ")}) ORDER BY created DESC LIMIT ?`,
        )
        .all(tool, session, ...this.sources, limit)
        .map((row) => JSON.parse(row.body)) ?? []
    );
  }
  retire(
    records: RemovedArtifact[],
    remainders: ArtifactRemovalRemainder[],
  ): void {
    const db = this.open();
    db.transaction(() => {
      const insert = db.prepare(
        "INSERT OR IGNORE INTO removed VALUES (?,?,?,?,?,?)",
      );
      for (const record of records)
        insert.run(
          record.key,
          record.tool,
          record.sessionId,
          record.artifactKey,
          record.createdAt,
          JSON.stringify(record),
        );
      const remainder = db.prepare(
        "INSERT OR IGNORE INTO remainder VALUES (?,?)",
      );
      for (const item of remainders)
        remainder.run(item.path, JSON.stringify(item));
    })();
  }
  remainders(after = "", limit = 100): ArtifactRemovalRemainder[] {
    return (
      this.database
        ?.query<{ body: string }, Array<string | number>>(
          `SELECT body FROM remainder WHERE path>? AND json_extract(body,'$.source') IN (${this.sources.map(() => "?").join(",")}) ORDER BY path LIMIT ?`,
        )
        .all(after, ...this.sources, limit)
        .map((row) => JSON.parse(row.body)) ?? []
    );
  }
  resolve(path: string): void {
    this.resolveBatch([path]);
  }
  /** Retire physical-unlink bookkeeping in one commit per cleanup batch. */
  resolveBatch(paths: Iterable<string>): void {
    const db = this.database;
    if (!db) return;
    db.transaction(() => {
      const remove = db.query(
        `DELETE FROM remainder WHERE path=? AND json_extract(body,'$.source') IN (${this.sources.map(() => "?").join(",")})`,
      );
      for (const path of new Set(paths)) remove.run(path, ...this.sources);
    })();
  }
  close(): void {
    this.database?.close();
    this.database = undefined;
  }
}

/** The conversation keeps its position and identity, but no actionable URL. */
export function removedArtifactMessage(
  record: RemovedArtifact,
): ArtifactMessage {
  return {
    type: "file-artifact",
    path: "",
    name: record.name,
    mimeType: record.mimeType,
    size: record.size,
    artifactKey: record.artifactKey,
    contentHash: record.contentHash,
    removedAt: record.removedAt,
    ...(record.proactive ? { proactive: true } : {}),
    ...(record.transcriptAnchor
      ? { transcriptAnchor: record.transcriptAnchor }
      : {}),
    interactionPolicy: {
      mode: "display-only",
      bridgeVersion: 1,
      schemaVersion: 1,
      allowedActions: [],
    },
  };
}
