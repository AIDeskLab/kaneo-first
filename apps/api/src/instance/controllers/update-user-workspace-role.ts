import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../../database";
import { isWorkspaceRoleValid } from "./role-utils";

export default async function updateUserWorkspaceRole(
  userId: string,
  workspaceId: string,
  role: string,
) {
  if (!(await isWorkspaceRoleValid(workspaceId, role))) {
    throw new HTTPException(400, { message: "Invalid workspace role" });
  }
  const [membership] = await db
    .select()
    .from(schema.workspaceUserTable)
    .where(
      and(
        eq(schema.workspaceUserTable.userId, userId),
        eq(schema.workspaceUserTable.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!membership)
    throw new HTTPException(404, { message: "Membership not found" });
  const [updated] = await db
    .update(schema.workspaceUserTable)
    .set({ role })
    .where(eq(schema.workspaceUserTable.id, membership.id))
    .returning();
  return updated;
}
