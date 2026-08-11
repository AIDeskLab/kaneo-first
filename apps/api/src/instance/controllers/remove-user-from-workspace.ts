import { and, eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../../database";
import { lockWorkspaceAssignees } from "../../task/controllers/workspace-assignee-lock";

export default async function removeUserFromWorkspace(
  userId: string,
  workspaceId: string,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceAssignees(tx, workspaceId, [userId]);
    const [membership] = await tx
      .select({ id: schema.workspaceUserTable.id })
      .from(schema.workspaceUserTable)
      .where(
        and(
          eq(schema.workspaceUserTable.userId, userId),
          eq(schema.workspaceUserTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!membership) {
      throw new HTTPException(404, { message: "Membership not found" });
    }

    const workspaceProjects = tx
      .select({ id: schema.projectTable.id })
      .from(schema.projectTable)
      .where(eq(schema.projectTable.workspaceId, workspaceId));
    await tx
      .update(schema.taskTable)
      .set({ userId: null })
      .where(
        and(
          eq(schema.taskTable.userId, userId),
          inArray(schema.taskTable.projectId, workspaceProjects),
        ),
      );
    await tx
      .delete(schema.workspaceUserTable)
      .where(eq(schema.workspaceUserTable.id, membership.id));
  });
}
