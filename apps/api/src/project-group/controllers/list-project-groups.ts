import { and, eq } from "drizzle-orm";
import db from "../../database";
import { projectGroupTable } from "../../database/schema";

async function listProjectGroups(workspaceId: string) {
  return db
    .select()
    .from(projectGroupTable)
    .where(eq(projectGroupTable.workspaceId, workspaceId))
    .orderBy(projectGroupTable.createdAt);
}

export default listProjectGroups;
