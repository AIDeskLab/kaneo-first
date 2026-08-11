import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  projectTable,
  userTable,
  workspaceUserTable,
} from "../../database/schema";

export async function getProjectWorkspaceAssignee(
  projectId: string,
  userId: string,
): Promise<{ id: string; name: string }> {
  const [assignee] = await db
    .select({ id: userTable.id, name: userTable.name })
    .from(projectTable)
    .innerJoin(
      workspaceUserTable,
      eq(workspaceUserTable.workspaceId, projectTable.workspaceId),
    )
    .innerJoin(userTable, eq(userTable.id, workspaceUserTable.userId))
    .where(
      and(
        eq(projectTable.id, projectId),
        eq(workspaceUserTable.userId, userId),
      ),
    )
    .limit(1);

  if (!assignee) {
    throw new HTTPException(404, { message: "Assignee not found" });
  }
  return assignee;
}
