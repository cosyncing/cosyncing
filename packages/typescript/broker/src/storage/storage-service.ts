import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  StorageCleanupJob,
  StorageCleanupPlan,
  StorageInventory,
  StorageReviewItem,
  StorageCategoryId,
} from "@cosyncing/protocol";
import type { UploadStaging } from "../artifacts/upload-staging.ts";
import {
  ArtifactStore,
  type ArtifactStorageObject,
} from "../artifacts/artifact-store.ts";
import {
  ensureOwnerOnlyDirectory,
  assertNoSymlinkComponents,
  enforceOwnerOnlyFile,
} from "../security/secure-files.ts";

const yieldWork = () => new Promise<void>((resolve) => setImmediate(resolve));
const PLAN_MS = 5 * 60_000;
const RETENTION_MS = 24 * 60 * 60_000;
type Row = Record<string, any>;
interface Filter {
  category?: string;
  olderThanDays?: number;
  search?: string;
  sort?: string;
  failedJob?: string;
}

export class StorageOperationError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Owner-only storage operations, with a lazy durable journal and bounded workers.
 * No constructor scan, timer, workspace walk or content hashing is introduced. */
export class StorageService {
  private database?: Database;
  private scan?: {
    scanId: string;
    state: string;
    inventoryId?: string;
    error?: string;
    processed: number;
  };
  private work?: Promise<void>;
  private readonly jobs = new Map<string, Promise<void>>();
  private closed = false;
  constructor(
    private readonly options: {
      home: string;
      serverIdentity: string;
      artifacts: ArtifactStore;
      uploads?: () => UploadStaging;
      liveCwds?: () => Iterable<string>;
      protectedSession: (tool: string, id: string, artifact: string) => boolean;
      principalActive: (principal: string) => boolean;
      changed: (tool: string, id: string, artifactKey: string) => void;
      now?: () => number;
    },
  ) {}
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private db(): Database {
    if (this.database) return this.database;
    ensureOwnerOnlyDirectory(this.options.home);
    const path = join(this.options.home, "storage-operations.sqlite");
    assertNoSymlinkComponents(path);
    const db = new Database(path, { create: true });
    enforceOwnerOnlyFile(path);
    const version = db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()!.user_version;
    if (version > 1) {
      db.close();
      throw new Error("Unsupported storage operation schema");
    }
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS inventory(id TEXT PRIMARY KEY,measured INTEGER NOT NULL,body TEXT);
      CREATE TABLE IF NOT EXISTS object_ids(source TEXT PRIMARY KEY,id TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS items(inventory TEXT NOT NULL,id TEXT NOT NULL,version TEXT NOT NULL,category TEXT NOT NULL,label TEXT NOT NULL,created INTEGER NOT NULL,size INTEGER,eligible INTEGER NOT NULL,reason TEXT,session TEXT NOT NULL,blob TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(inventory,id));
      CREATE INDEX IF NOT EXISTS inventory_items ON items(inventory,category,created);
      CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY,inventory TEXT NOT NULL,principal TEXT NOT NULL,server TEXT NOT NULL,expires INTEGER NOT NULL,state TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plan_items(plan TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',outcome TEXT,reclaimed INTEGER,PRIMARY KEY(plan,id));
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,plan TEXT NOT NULL UNIQUE,principal TEXT NOT NULL,idempotency TEXT NOT NULL,state TEXT NOT NULL,cancel INTEGER NOT NULL DEFAULT 0,retained INTEGER NOT NULL,uncertain INTEGER NOT NULL DEFAULT 0,UNIQUE(principal,idempotency));
      UPDATE jobs SET state='interrupted',uncertain=1 WHERE state IN ('pending','running');`);
    db.exec("PRAGMA user_version=1");
    this.database = db;
    // A restarted owner credential cannot resume another caller's accepted
    // work. Retain its private result, but release global cleanup admission.
    db.transaction(() => {
      for (const job of db
        .query<Row, []>("SELECT * FROM jobs WHERE state='interrupted'")
        .all()) {
        if (this.options.principalActive(job.principal)) continue;
        db.run(
          "UPDATE plan_items SET state='done',outcome='PERMISSION_CHANGED',reclaimed=0 WHERE plan=? AND outcome IS NULL",
          [job.plan],
        );
        db.run(
          "UPDATE jobs SET state='partial',retained=max(retained,?) WHERE id=?",
          [this.now() + RETENTION_MS, job.id],
        );
      }
    })();
    return db;
  }
  latest(): StorageInventory | undefined {
    const row = this.db()
      .query<
        Row,
        []
      >("SELECT body FROM inventory WHERE body IS NOT NULL ORDER BY measured DESC LIMIT 1")
      .get();
    return row ? JSON.parse(row.body) : undefined;
  }
  startScan(): Row {
    if (this.scan?.state === "running") return { ...this.scan };
    this.scan = { scanId: randomUUID(), state: "running", processed: 0 };
    const scan = this.scan;
    this.work = this.scanOnce(scan).catch(() => {
      scan.state = "failed";
      scan.error = "Storage inspection unavailable";
    });
    return { ...scan };
  }
  scanStatus(id: string): Row {
    if (this.scan?.scanId !== id)
      throw new StorageOperationError("NOT_FOUND", 404, "Scan not found");
    return { ...this.scan };
  }
  async waitForScan(id: string, waitMs: number): Promise<Row> {
    this.scanStatus(id);
    if (this.scan?.state === "running")
      await this.waitForWork(this.work, waitMs);
    return this.scanStatus(id);
  }
  async waitForJob(
    principal: string,
    id: string,
    waitMs: number,
  ): Promise<StorageCleanupJob> {
    this.job(principal, id);
    await this.waitForWork(this.jobs.get(id), waitMs);
    return this.job(principal, id);
  }
  private async waitForWork(
    work: Promise<void> | undefined,
    milliseconds: number,
  ): Promise<void> {
    if (!work || !Number.isFinite(milliseconds) || milliseconds <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.min(10000, milliseconds));
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private async scanOnce(
    scan: NonNullable<StorageService["scan"]>,
  ): Promise<void> {
    const db = this.db(),
      id = randomUUID(),
      measured = this.now();
    db.run("INSERT INTO inventory(id,measured) VALUES (?,?)", [id, measured]);
    const options = this.options;
    const source = (async function* () {
      yield* options.artifacts.storageObjects(options.protectedSession);
      if (options.uploads)
        yield* options.uploads().storageObjects(options.liveCwds ?? (() => []));
    })();
    const store = db.transaction((batch: ArtifactStorageObject[]) => {
      for (const object of batch) {
        db.run("INSERT OR IGNORE INTO object_ids VALUES (?,?)", [
          object.key,
          randomUUID(),
        ]);
        const key = db
          .query<Row, [string]>("SELECT id FROM object_ids WHERE source=?")
          .get(object.key)!.id as string;
        db.run("INSERT INTO items VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", [
          id,
          key,
          object.version,
          object.category,
          object.label,
          object.createdAt,
          object.size,
          object.eligible ? 1 : 0,
          object.reason ?? null,
          `${object.tool}:${object.sessionId}`,
          object.contentHash,
          JSON.stringify(object),
        ]);
      }
    });
    try {
      for (;;) {
        if (this.closed) throw new Error("Canceled");
        const batch: ArtifactStorageObject[] = [];
        for (let i = 0; i < 64; i++) {
          const next = await source.next();
          if (next.done) break;
          batch.push(next.value);
        }
        if (!batch.length) break;
        store(batch);
        scan.processed += batch.length;
        await yieldWork();
      }
    } finally {
      await source.return(undefined);
    }
    if (
      db
        .query<
          Row,
          [string]
        >("SELECT 1 FROM items WHERE inventory=? AND json_extract(body,'$.key')='upload-inspection-incomplete'")
        .get(id)
    ) {
      db.run(
        "UPDATE items SET eligible=0,reason='UNAVAILABLE' WHERE inventory=? AND json_extract(body,'$.storageSource')='upload'",
        [id],
      );
    }
    const categories: StorageInventory["categories"] = [];
    for (const category of ["stored-files", "staging"] as const) {
      const counts = db
        .query<
          Row,
          [string, string]
        >(`SELECT count(*) AS n,sum(eligible) AS eligible,sum(CASE WHEN reason='UNAVAILABLE' THEN 1 ELSE 0 END) AS unknown FROM items WHERE inventory=? AND category=?`)
        .get(id, category)!;
      const sizes = db
        .query<Row, [string, string]>(
          // Attribute a shared blob to stored content before staging, so the
          // category totals never count the same physical bytes twice. A
          // category action can reclaim it only when every reference belongs
          // to that category and every reference is eligible.
          `SELECT coalesce(sum(size),0) AS bytes,
          coalesce(sum(CASE WHEN eligible=1 AND categories=1 THEN size ELSE 0 END),0) AS eligibleBytes FROM
          (SELECT blob,max(size) AS size,min(eligible) AS eligible,count(DISTINCT category) AS categories,
            CASE WHEN max(category='stored-files')=1 THEN 'stored-files' ELSE 'staging' END AS category
            FROM items WHERE inventory=? GROUP BY blob)
          WHERE category=?`,
        )
        .get(id, category)!;
      categories.push({
        id: category,
        bytes: counts.unknown ? null : sizes.bytes,
        itemCount: counts.n,
        eligibleCount: counts.eligible ?? 0,
        eligibleBytes: counts.unknown ? null : sizes.eligibleBytes,
        quality: counts.unknown ? "partial" : "measured",
      });
    }
    const inventory: StorageInventory = {
      capability: "storage-v1",
      inventoryId: id,
      serverIdentity: this.options.serverIdentity,
      measuredAt: measured,
      status: categories.some((category) => category.quality === "partial")
        ? "partial"
        : "complete",
      categories,
      actions: ["cache", "stored-files"],
    };
    db.run("UPDATE inventory SET body=? WHERE id=?", [
      JSON.stringify(inventory),
      id,
    ]);
    scan.state = "completed";
    scan.inventoryId = id;
    this.prune();
  }
  private filter(
    principal: string,
    inventory: string,
    filter: Filter,
    mode?: string,
  ): { where: string; args: Array<string | number> } {
    const row = this.db()
      .query<
        Row,
        [string]
      >("SELECT measured FROM inventory WHERE id=? AND body IS NOT NULL")
      .get(inventory);
    if (!row)
      throw new StorageOperationError(
        "INVENTORY_EXPIRED",
        409,
        "Refresh storage before reviewing files",
      );
    const days = Number(filter.olderThanDays ?? 0);
    if (![0, 7, 30].includes(days))
      throw new StorageOperationError(
        "BAD_PARAM",
        400,
        "Unsupported age filter",
      );
    const category =
      filter.category ?? (mode === "cache" ? "staging" : "stored-files");
    if (
      !["stored-files", "staging"].includes(category) ||
      (mode === "cache" && category !== "staging")
    )
      throw new StorageOperationError(
        "BAD_PARAM",
        400,
        "Unsupported cleanup category",
      );
    if (
      typeof filter.search !== "undefined" &&
      (typeof filter.search !== "string" || filter.search.length > 200)
    )
      throw new StorageOperationError("BAD_PARAM", 400, "Search is too long");
    let where = "inventory=? AND created<=? AND instr(lower(label),lower(?))>0";
    const args: Array<string | number> = [
      inventory,
      row.measured - days * 86400_000,
      filter.search ?? "",
    ];
    if (filter.failedJob !== undefined) {
      if (typeof filter.failedJob !== "string")
        throw new StorageOperationError(
          "BAD_PARAM",
          400,
          "Invalid cleanup result",
        );
      const prior = this.db()
        .query<
          Row,
          [string, string]
        >("SELECT plan FROM jobs WHERE id=? AND principal=? AND state IN ('completed','partial','canceled')")
        .get(filter.failedJob, principal);
      if (!prior)
        throw new StorageOperationError(
          "NOT_FOUND",
          404,
          "Cleanup result not found",
        );
      // A failed unlink has already retired its conversation reference. Its
      // retry is the journaled physical remainder, with the same file version.
      // Keep this finite join server-side instead of loading every failure ID.
      where += ` AND EXISTS (SELECT 1 FROM plan_items AS failed WHERE failed.plan=? AND failed.outcome='FAILED'
        AND (failed.id=items.id OR (json_extract(items.body,'$.remainder')=1
          AND json_extract(failed.body,'$.filePath')=json_extract(items.body,'$.filePath')
          AND json_extract(failed.body,'$.blobVersion')=json_extract(items.body,'$.blobVersion'))))`;
      args.push(prior.plan);
      if (mode === "cache") {
        where += " AND category=?";
        args.push("staging");
      }
    } else {
      where += " AND category=?";
      args.push(category);
    }
    return { where, args };
  }
  items(
    principal: string,
    inventory: string,
    filter: Filter & { cursor?: string; limit?: number },
  ): {
    items: StorageReviewItem[];
    nextCursor?: string;
    eligibleCount: number;
  } {
    const { where, args } = this.filter(principal, inventory, filter);
    const fingerprint = JSON.stringify([
      filter.category ?? "stored-files",
      Number(filter.olderThanDays ?? 0),
      filter.search ?? "",
      filter.sort ?? "date",
      filter.failedJob ?? null,
    ]);
    const limit = Math.min(200, Math.max(1, Number(filter.limit) || 100));
    let offset = 0;
    if (filter.cursor) {
      try {
        const value = JSON.parse(
          Buffer.from(filter.cursor, "base64url").toString(),
        );
        if (
          value.inventory !== inventory ||
          value.filter !== fingerprint ||
          !Number.isSafeInteger(value.offset) ||
          value.offset < 0
        )
          throw new Error();
        offset = value.offset;
      } catch {
        throw new StorageOperationError(
          "BAD_PARAM",
          400,
          "Invalid inventory cursor",
        );
      }
    }
    const order = filter.sort === "size" ? "size DESC,id" : "created DESC,id";
    const rows = this.db()
      .query<Row, Array<string | number>>(
        `SELECT * FROM items WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...args, limit + 1, offset);
    const page = rows.slice(0, limit);
    const eligibleCount = this.db()
      .query<Row, Array<string | number>>(
        `SELECT count(*) AS n FROM items WHERE ${where} AND eligible=1`,
      )
      .get(...args)!.n;
    return {
      items: page.map((row) => {
        const object = JSON.parse(row.body) as ArtifactStorageObject;
        return {
          id: row.id,
          version: row.version,
          category: row.category as StorageCategoryId,
          label: row.label,
          size: row.size,
          createdAt: row.created,
          tool: object.tool,
          sessionId: object.sessionId,
          eligible: row.eligible === 1,
          ...(row.reason ? { reason: row.reason } : {}),
        };
      }),
      eligibleCount,
      ...(rows.length > limit
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({
                inventory,
                offset: offset + limit,
                filter: fingerprint,
              }),
            ).toString("base64url"),
          }
        : {}),
    };
  }
  plan(principal: string, input: Row): StorageCleanupPlan {
    if (
      !["cache", "stored-files"].includes(input.mode) ||
      typeof input.inventoryId !== "string"
    )
      throw new StorageOperationError(
        "BAD_PARAM",
        400,
        "Cleanup mode and inventory are required",
      );
    if (
      input.itemIds !== undefined &&
      (!Array.isArray(input.itemIds) ||
        input.itemIds.length > 20_000 ||
        !input.itemIds.every((id: unknown) => typeof id === "string"))
    )
      throw new StorageOperationError("BAD_PARAM", 400, "Invalid selection");
    if (input.itemIds === undefined && input.selectAll !== true)
      throw new StorageOperationError(
        "BAD_PARAM",
        400,
        "An explicit selection is required",
      );
    const { where, args } = this.filter(
      principal,
      input.inventoryId,
      input.filter ?? {},
      input.mode,
    );
    const id = randomUUID(),
      expires = this.now() + PLAN_MS,
      db = this.db();
    return db.transaction(() => {
      const selection = `SELECT ?,id,body FROM items WHERE ${where} AND eligible=1`;
      if (input.itemIds !== undefined)
        for (const item of new Set<string>(input.itemIds))
          db.run(`INSERT INTO plan_items(plan,id,body) ${selection} AND id=?`, [
            id,
            ...args,
            item,
          ]);
      else
        db.run(`INSERT INTO plan_items(plan,id,body) ${selection}`, [
          id,
          ...args,
        ]);
      const summary = db
        .query<
          Row,
          [string, string]
        >(`SELECT count(*) AS n,coalesce(sum(size),0) AS bytes,count(DISTINCT NULLIF(session,':')) AS sessions FROM items WHERE inventory=? AND id IN (SELECT id FROM plan_items WHERE plan=?)`)
        .get(input.inventoryId, id)!;
      // A blob shared with any unselected reference is not reclaimable.
      const reclaim = db
        .query<Row, [string, string, string, string]>(
          `SELECT coalesce(sum(size),0) AS bytes FROM
        (SELECT blob,max(size) AS size FROM items WHERE inventory=? AND id IN (SELECT id FROM plan_items WHERE plan=?)
        AND blob NOT IN (SELECT blob FROM items WHERE inventory=? AND id NOT IN (SELECT id FROM plan_items WHERE plan=?)) GROUP BY blob)`,
        )
        .get(input.inventoryId, id, input.inventoryId, id)!.bytes;
      const plan: StorageCleanupPlan = {
        planId: id,
        inventoryId: input.inventoryId,
        expiresAt: expires,
        itemCount: summary.n,
        affectedSessions: summary.sessions,
        logicalBytes: summary.bytes,
        reclaimableBytes: reclaim,
        skippedCount: input.itemIds
          ? new Set(input.itemIds).size - summary.n
          : db
              .query<
                Row,
                Array<string | number>
              >(`SELECT count(*) AS n FROM items WHERE ${where} AND eligible=0`)
              .get(...args)!.n,
      };
      db.run("INSERT INTO plans VALUES (?,?,?,?,?,'pending',?)", [
        id,
        input.inventoryId,
        principal,
        this.options.serverIdentity,
        expires,
        JSON.stringify(plan),
      ]);
      return plan;
    })();
  }
  accept(
    principal: string,
    planId: string,
    idempotency: string,
  ): StorageCleanupJob {
    if (
      typeof idempotency !== "string" ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(idempotency)
    )
      throw new StorageOperationError(
        "BAD_PARAM",
        400,
        "A client-generated idempotency key is required",
      );
    const db = this.db();
    const existing = db
      .query<
        Row,
        [string, string]
      >("SELECT * FROM jobs WHERE principal=? AND idempotency=?")
      .get(principal, idempotency);
    if (existing) {
      if (existing.plan !== planId)
        throw new StorageOperationError(
          "IDEMPOTENCY_CONFLICT",
          409,
          "Key already names another plan",
        );
      return this.job(principal, existing.id);
    }
    const id = db.transaction(() => {
      const plan = db
        .query<
          Row,
          [string, string]
        >("SELECT * FROM plans WHERE id=? AND principal=?")
        .get(planId, principal);
      if (!plan || plan.server !== this.options.serverIdentity)
        throw new StorageOperationError("NOT_FOUND", 404, "Plan not found");
      if (plan.state !== "pending")
        throw new StorageOperationError(
          "PLAN_CONSUMED",
          409,
          "Plan already consumed",
        );
      if (plan.expires <= this.now())
        throw new StorageOperationError(
          "PLAN_EXPIRED",
          409,
          "Review files again before removing them",
        );
      if (
        db
          .query(
            "SELECT 1 FROM jobs WHERE state IN ('pending','running','interrupted')",
          )
          .get()
      )
        throw new StorageOperationError(
          "BUSY",
          409,
          "Another cleanup is in progress",
        );
      const id = randomUUID();
      db.run(
        "INSERT INTO jobs(id,plan,principal,idempotency,state,retained) VALUES (?,?,?,?,'pending',?)",
        [id, planId, principal, idempotency, this.now() + RETENTION_MS],
      );
      db.run("UPDATE plans SET state='consumed' WHERE id=?", [planId]);
      return id;
    })();
    this.resume(id);
    return this.job(principal, id);
  }
  job(principal: string, id: string): StorageCleanupJob {
    const row = this.db()
      .query<
        Row,
        [string, string]
      >("SELECT * FROM jobs WHERE id=? AND principal=?")
      .get(id, principal);
    if (!row)
      throw new StorageOperationError(
        "NOT_FOUND",
        404,
        "Cleanup result not found",
      );
    const counts = this.db()
      .query<Row, [string]>(
        `SELECT count(*) AS total,sum(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END) AS processed,
      sum(CASE WHEN outcome IN ('REMOVED','REFERENCE_REMOVED') THEN 1 ELSE 0 END) AS removed,
      sum(CASE WHEN outcome='ALREADY_MISSING' THEN 1 ELSE 0 END) AS missing,
      sum(CASE WHEN outcome IN ('IN_USE','OBJECT_CHANGED','PERMISSION_CHANGED') THEN 1 ELSE 0 END) AS skipped,
      sum(CASE WHEN outcome='FAILED' THEN 1 ELSE 0 END) AS failed,coalesce(sum(reclaimed),0) AS bytes FROM plan_items WHERE plan=?`,
      )
      .get(row.plan)!;
    if (row.state === "interrupted" && this.options.principalActive(principal))
      this.resume(id);
    return {
      jobId: id,
      planId: row.plan,
      state: row.state,
      total: counts.total,
      processed: counts.processed ?? 0,
      removed: counts.removed ?? 0,
      missing: counts.missing ?? 0,
      skipped: counts.skipped ?? 0,
      failed: counts.failed ?? 0,
      reclaimedBytes: row.uncertain ? null : counts.bytes,
      retainedUntil: row.retained,
    };
  }
  outcomes(principal: string, id: string, offset = 0): Row[] {
    const job = this.job(principal, id);
    return this.db()
      .query<
        Row,
        [string, number]
      >("SELECT id,outcome,reclaimed AS reclaimedBytes FROM plan_items WHERE plan=? AND outcome IS NOT NULL ORDER BY id LIMIT 100 OFFSET ?")
      .all(job.planId, Math.max(0, offset));
  }
  cancel(principal: string, id: string): StorageCleanupJob {
    this.job(principal, id);
    this.db().run("UPDATE jobs SET cancel=1 WHERE id=?", [id]);
    return this.job(principal, id);
  }
  private resume(id: string): void {
    if (this.jobs.has(id) || this.closed) return;
    const pending = this.run(id)
      .catch(() => {
        // Unexpected worker failures stop here. Only a process interruption is
        // resumed automatically; a broken filesystem/database operation cannot
        // create an unbounded retry loop on every progress request.
        const db = this.db();
        db.transaction(() => {
          db.run(
            "UPDATE plan_items SET state='done',outcome='FAILED',reclaimed=NULL WHERE plan=(SELECT plan FROM jobs WHERE id=?) AND outcome IS NULL",
            [id],
          );
          db.run(
            "UPDATE jobs SET state='partial',uncertain=1,retained=max(retained,?) WHERE id=?",
            [this.now() + RETENTION_MS, id],
          );
        })();
      })
      .finally(() => this.jobs.delete(id));
    this.jobs.set(id, pending);
  }
  private async run(id: string): Promise<void> {
    const db = this.db();
    // Yield so acceptance is durable and the response can leave before deletion.
    await yieldWork();
    db.run("UPDATE jobs SET state='running' WHERE id=?", [id]);
    for (;;) {
      const job = db
        .query<Row, [string]>("SELECT * FROM jobs WHERE id=?")
        .get(id)!;
      if (this.closed) {
        db.run("UPDATE jobs SET state='interrupted' WHERE id=?", [id]);
        return;
      }
      if (job.cancel) {
        db.run(
          "UPDATE jobs SET state='canceled',retained=max(retained,?) WHERE id=?",
          [this.now() + RETENTION_MS, id],
        );
        return;
      }
      const rows = db
        .query<
          Row,
          [string]
        >("SELECT * FROM plan_items WHERE plan=? AND outcome IS NULL ORDER BY id LIMIT 64")
        .all(job.plan);
      if (!rows.length) {
        db.run(
          "UPDATE jobs SET state=CASE WHEN EXISTS(SELECT 1 FROM plan_items WHERE plan=? AND outcome IN ('FAILED','IN_USE','OBJECT_CHANGED','PERMISSION_CHANGED')) THEN 'partial' ELSE 'completed' END,retained=max(retained,?) WHERE id=?",
          [job.plan, this.now() + RETENTION_MS, id],
        );
        return;
      }
      if (!this.options.principalActive(job.principal)) {
        db.run(
          "UPDATE plan_items SET state='done',outcome='PERMISSION_CHANGED',reclaimed=0 WHERE plan=? AND outcome IS NULL",
          [job.plan],
        );
        continue;
      }
      const objects = rows.map(
        (row) => JSON.parse(row.body) as ArtifactStorageObject,
      );
      db.transaction(() => {
        for (const row of rows)
          db.run(
            "UPDATE plan_items SET state='processing' WHERE plan=? AND id=?",
            [job.plan, row.id],
          );
      })();
      const artifactObjects = objects.filter((object) => !object.storageSource);
      const uploadObjects = objects.filter((object) => object.storageSource);
      const allOutcomes = [
        ...this.options.artifacts.storageRemoveBatch(
          artifactObjects,
          this.options.protectedSession,
        ),
        ...(this.options
          .uploads?.()
          .storageRemoveBatch(
            uploadObjects,
            this.options.liveCwds ?? (() => []),
          ) ?? []),
      ];
      const byKey = new Map(
        allOutcomes.map((outcome) => [outcome.key, outcome]),
      );
      const outcomes = objects.map(
        (object) =>
          byKey.get(object.key) ?? {
            key: object.key,
            outcome: "IN_USE" as const,
            reclaimedBytes: 0,
          },
      );
      db.transaction(() => {
        for (let i = 0; i < rows.length; i++) {
          const outcome = outcomes[i]!;
          db.run(
            "UPDATE plan_items SET state='done',outcome=?,reclaimed=? WHERE plan=? AND id=?",
            [outcome.outcome, outcome.reclaimedBytes, job.plan, rows[i]!.id],
          );
        }
      })();
      for (const object of artifactObjects) {
        if (!object.remainder) {
          this.options.changed(
            object.tool,
            object.sessionId,
            object.key.split("\0").at(-1)!,
          );
        }
      }
      await yieldWork();
    }
  }
  private prune(): void {
    const db = this.db(),
      now = this.now();
    db.transaction(() => {
      db.run(
        "DELETE FROM plan_items WHERE plan IN (SELECT plan FROM jobs WHERE retained<? AND state IN ('completed','partial','canceled'))",
        [now],
      );
      db.run(
        "DELETE FROM jobs WHERE retained<? AND state IN ('completed','partial','canceled')",
        [now],
      );
      db.run(
        "DELETE FROM plan_items WHERE plan IN (SELECT id FROM plans WHERE expires<? AND id NOT IN (SELECT plan FROM jobs))",
        [now],
      );
      db.run(
        "DELETE FROM plans WHERE expires<? AND id NOT IN (SELECT plan FROM jobs)",
        [now],
      );
      db.run(
        "DELETE FROM items WHERE inventory IN (SELECT id FROM inventory WHERE measured<? AND id NOT IN (SELECT inventory FROM plans))",
        [now - RETENTION_MS],
      );
      db.run(
        "DELETE FROM inventory WHERE measured<? AND id NOT IN (SELECT inventory FROM plans)",
        [now - RETENTION_MS],
      );
      db.run(
        "DELETE FROM object_ids WHERE source NOT IN (SELECT json_extract(body,'$.key') FROM items UNION SELECT json_extract(body,'$.key') FROM plan_items)",
      );
    })();
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([this.work, ...this.jobs.values()]);
    this.database?.close();
    this.database = undefined;
  }
}
