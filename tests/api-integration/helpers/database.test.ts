import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../../apps/api/src/database";
import {
  mcpOauthStateTable,
  taskReminderSentTable,
} from "../../../apps/api/src/database/schema";
import { resetTestDatabase } from "./database";

async function seedMcpOauthStateRow(): Promise<string> {
  const id = `mcp-oauth-${randomUUID()}`;
  await db.insert(mcpOauthStateTable).values({
    id,
    kind: "test",
    key: `key-${randomUUID()}`,
    payload: {},
    expiresAt: new Date(Date.now() + 60_000),
  });
  return id;
}

async function seedTaskReminderSentRow(): Promise<string> {
  const userId = `user-${randomUUID()}`;
  const workspaceId = `workspace-${randomUUID()}`;
  const projectId = `project-${randomUUID()}`;
  const columnId = `column-${randomUUID()}`;
  const taskId = `task-${randomUUID()}`;
  const id = `task-reminder-${randomUUID()}`;

  await db.insert(schema.userTable).values({
    id: userId,
    email: `${userId}@example.com`,
    emailVerified: true,
    name: "Reminder Test User",
  });
  await db.insert(schema.workspaceTable).values({
    id: workspaceId,
    createdAt: new Date(),
    name: "Reminder Workspace",
    slug: `workspace-${randomUUID()}`,
  });
  await db.insert(schema.workspaceUserTable).values({
    workspaceId,
    userId,
    role: "admin",
    joinedAt: new Date(),
  });
  await db.insert(schema.projectTable).values({
    id: projectId,
    workspaceId,
    name: "Reminder Project",
    icon: "Folder",
    slug: `project-${randomUUID()}`,
  });
  await db.insert(schema.columnTable).values({
    id: columnId,
    projectId,
    name: "To do",
    slug: "to-do",
    position: 1,
    isFinal: false,
  });
  await db.insert(schema.taskTable).values({
    id: taskId,
    projectId,
    title: "Reminder task",
    description: "",
    priority: "low",
    status: "to-do",
    columnId,
    number: 1,
    position: 1,
  });
  await db.insert(taskReminderSentTable).values({
    id,
    taskId,
    reminderType: "due-soon",
  });

  return id;
}

async function rowExists(tableName: string, id: string): Promise<boolean> {
  const result = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM ${sql.raw(`"${tableName}"`)}
      WHERE id = ${id}
    ) AS exists
  `);
  return result.rows[0]?.exists === true;
}

describe("resetTestDatabase", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterEach(async () => {
    await resetTestDatabase();
  });

  it("truncates mcp_oauth_state rows", async () => {
    const id = await seedMcpOauthStateRow();

    await resetTestDatabase();

    expect(await rowExists("mcp_oauth_state", id)).toBe(false);
  });

  it("truncates task_reminder_sent rows", async () => {
    const id = await seedTaskReminderSentRow();

    await resetTestDatabase();

    expect(await rowExists("task_reminder_sent", id)).toBe(false);
  });

  it("truncates tables that live outside the schema registry", async () => {
    // A raw SQL table that no module in apps/api/src/database knows about.
    // If resetTestDatabase ever reverts to deriving its list from the schema
    // registry, this table will not appear in the TRUNCATE list and the row
    // below will survive the reset.
    const tableName = `test_only_unregistered_${randomUUID().replaceAll("-", "")}`;
    const id = `row-${randomUUID()}`;
    const quoted = `"${tableName}"`;

    await db.execute(
      sql.raw(
        `CREATE TABLE ${quoted} (id text PRIMARY KEY, label text NOT NULL)`,
      ),
    );

    try {
      await db.execute(
        sql.raw(`INSERT INTO ${quoted} (id, label) VALUES ('${id}', 'seed')`),
      );

      await resetTestDatabase();

      expect(await rowExists(tableName, id)).toBe(false);
    } finally {
      await db.execute(sql.raw(`DROP TABLE ${quoted}`));
    }
  });

  it("retries a truncate that deadlocks with a concurrent reader", async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL must be defined for integration tests");
    }

    const other = new Client({ connectionString });
    await other.connect();
    let resetPromise: Promise<void> | undefined;
    try {
      // Outlive the pool's default deadlock_timeout so this session is not
      // the victim. The truncate has to notice 40P01 and retry.
      await other.query("SET deadlock_timeout = '8s'");
      await other.query("BEGIN");
      // Hold a late table so TRUNCATE, which locks alphabetically, is blocked
      // after it already owns "account". Reading "account" then deadlocks.
      await other.query('LOCK TABLE "user" IN ACCESS SHARE MODE');
      resetPromise = resetTestDatabase();
      await waitForTruncateDeadlockSetup();
      await other.query('SELECT 1 FROM "account"').catch(() => undefined);
    } finally {
      await other.query("ROLLBACK").catch(() => undefined);
      try {
        await resetPromise;
      } finally {
        await other.end();
      }
    }
  });
});

async function waitForTruncateDeadlockSetup() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await db.execute<{
      account_locked: boolean;
      user_waiting: boolean;
    }>(sql`
      SELECT
        EXISTS (
          SELECT 1
          FROM pg_locks
          WHERE relation = to_regclass('public.account')
            AND mode = 'AccessExclusiveLock'
            AND granted
        ) AS account_locked,
        EXISTS (
          SELECT 1
          FROM pg_locks
          WHERE relation = to_regclass('public.user')
            AND mode = 'AccessExclusiveLock'
            AND NOT granted
        ) AS user_waiting
    `);
    const row = result.rows[0];
    if (row?.account_locked === true && row?.user_waiting === true) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Truncate did not lock account before waiting on user");
}
