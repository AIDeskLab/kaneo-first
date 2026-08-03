import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../../database";

async function deleteProjectGroup(id: string) {
  const [group] = await db
    .delete(schema.projectGroupTable)
    .where(eq(schema.projectGroupTable.id, id))
    .returning();

  if (!group) {
    throw new HTTPException(404, {
      message: "Project group not found",
    });
  }

  return group;
}

export default deleteProjectGroup;
