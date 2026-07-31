import { createId } from "@paralleldrive/cuid2";
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../../database";
import { isWorkspaceRoleValid } from "./role-utils";

export default async function addUserToWorkspace(
  userId: string,
  workspaceId: string,
  role: string,
) {
  const [user] = await db
    .select()
    .from(schema.userTable)
    .where(eq(schema.userTable.id, userId))
    .limit(1);
  if (!user) throw new HTTPException(404, { message: "User not found" });
  const [workspace] = await db
    .select()
    .from(schema.workspaceTable)
    .where(eq(schema.workspaceTable.id, workspaceId))
    .limit(1);
  if (!workspace)
    throw new HTTPException(404, { message: "Workspace not found" });
  if (!(await isWorkspaceRoleValid(workspaceId, role))) {
    throw new HTTPException(400, { message: "Invalid workspace role" });
  }
  const [existing] = await db
    .select()
    .from(schema.workspaceUserTable)
    .where(
      and(
        eq(schema.workspaceUserTable.userId, userId),
        eq(schema.workspaceUserTable.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (existing)
    throw new HTTPException(409, { message: "Membership already exists" });
  const [membership] = await db
    .insert(schema.workspaceUserTable)
    .values({ id: createId(), userId, workspaceId, role, joinedAt: new Date() })
    .returning();
  return {
    ...membership,
    user: { id: user.id, name: user.name, email: user.email },
    workspace,
  };
}
