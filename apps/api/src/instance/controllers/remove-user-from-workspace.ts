import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../../database";

export default async function removeUserFromWorkspace(
  userId: string,
  workspaceId: string,
) {
  const [membership] = await db
    .select({ id: schema.workspaceUserTable.id })
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
  await db
    .delete(schema.workspaceUserTable)
    .where(eq(schema.workspaceUserTable.id, membership.id));
}
