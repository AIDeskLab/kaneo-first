import { and, eq, inArray, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type db from "../../database";
import { userTable, workspaceUserTable } from "../../database/schema";

export type DbOrTx =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function lockWorkspaceAssignees(
  tx: DbOrTx,
  workspaceId: string,
  assigneeIds: string[],
) {
  const keys = [...new Set(assigneeIds.map((id) => id.trim()).filter(Boolean))]
    .map((assigneeId) => `${workspaceId}:${assigneeId}`)
    .sort();

  for (const key of keys) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(1530, hashtext(${key}))`);
  }
}

export async function requireWorkspaceAssignees(
  tx: DbOrTx,
  workspaceId: string,
  assigneeIds: string[],
) {
  const normalizedIds = [
    ...new Set(assigneeIds.map((id) => id.trim()).filter(Boolean)),
  ];
  if (normalizedIds.length === 0) return new Map<string, string>();

  const users = await tx
    .select({ id: userTable.id })
    .from(userTable)
    .where(inArray(userTable.id, normalizedIds));
  const known = new Set(users.map((user) => user.id));
  if (normalizedIds.some((id) => !known.has(id))) {
    throw new HTTPException(404, { message: "Assignee not found" });
  }

  const memberships = await tx
    .select({ id: userTable.id, name: userTable.name })
    .from(workspaceUserTable)
    .innerJoin(userTable, eq(userTable.id, workspaceUserTable.userId))
    .where(
      and(
        eq(workspaceUserTable.workspaceId, workspaceId),
        inArray(workspaceUserTable.userId, normalizedIds),
      ),
    );
  const names = new Map(memberships.map(({ id, name }) => [id, name]));

  if (normalizedIds.some((id) => !names.has(id))) {
    throw new HTTPException(403, {
      message: "Assignee is not a member of this workspace",
    });
  }
  return names;
}
