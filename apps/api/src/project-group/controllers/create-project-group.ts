import db, { schema } from "../../database";

async function createProjectGroup(workspaceId: string, name: string) {
  const [group] = await db
    .insert(schema.projectGroupTable)
    .values({ workspaceId, name })
    .returning();
  return group;
}

export default createProjectGroup;
