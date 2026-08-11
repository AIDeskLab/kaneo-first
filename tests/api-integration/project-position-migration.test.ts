import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { asc, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

describe("project position migration", () => {
  beforeEach(resetTestDatabase);

  it("executes the actual 0036 backfill deterministically per workspace", async () => {
    const firstWorkspace = await createWorkspaceMember();
    const secondWorkspace = await createWorkspaceMember();
    const projects = await Promise.all([
      createProjectFixture({ workspaceId: firstWorkspace.workspace.id }),
      createProjectFixture({ workspaceId: firstWorkspace.workspace.id }),
      createProjectFixture({ workspaceId: firstWorkspace.workspace.id }),
      createProjectFixture({ workspaceId: secondWorkspace.workspace.id }),
      createProjectFixture({ workspaceId: secondWorkspace.workspace.id }),
    ]);
    const tiedCreatedAt = new Date("2025-01-01T00:00:00.000Z");
    await db
      .update(schema.projectTable)
      .set({ createdAt: tiedCreatedAt, position: 99 });

    const migration = await readFile(
      resolve(process.cwd(), "drizzle/0036_young_albert_cleary.sql"),
      "utf8",
    );
    const statement = migration
      .split("--> statement-breakpoint")
      .find((part) => part.includes('UPDATE "project" p SET "position"'))
      ?.trim();
    expect(statement).toBeDefined();
    await db.execute(sql.raw(statement ?? ""));

    for (const workspace of [
      firstWorkspace.workspace,
      secondWorkspace.workspace,
    ]) {
      const actual = await db
        .select({
          id: schema.projectTable.id,
          position: schema.projectTable.position,
        })
        .from(schema.projectTable)
        .where(eq(schema.projectTable.workspaceId, workspace.id))
        .orderBy(asc(schema.projectTable.id));
      expect(actual.map(({ position }) => position)).toEqual(
        actual.map((_, index) => index),
      );
    }
    expect(projects).toHaveLength(5);
  });
});
