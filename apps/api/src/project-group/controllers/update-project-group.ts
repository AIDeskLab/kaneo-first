import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../../database";

async function updateProjectGroup(id: string, name: string) {
  const [group] = await db
    .update(schema.projectGroupTable)
    .set({ name })
    .where(eq(schema.projectGroupTable.id, id))
    .returning();

  if (!group) {
    throw new HTTPException(404, {
      message: "Project group not found",
    });
  }

  return group;
}

export default updateProjectGroup;
