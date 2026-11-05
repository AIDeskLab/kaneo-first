import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { projectGroupTable, projectTable } from "../../database/schema";
import { isSameProjectKey } from "../project-key";
import {
  assertProjectKeyAvailable,
  lockProjectOrdering,
} from "./project-placement";

async function updateProject(
  id: string,
  name: string,
  icon: string,
  slug: string,
  description: string,
  isPublic: boolean,
  workspaceId: string,
  projectGroupId?: string | null,
) {
  const [existingProject] = await db
    .select()
    .from(projectTable)
    .where(
      and(eq(projectTable.id, id), eq(projectTable.workspaceId, workspaceId)),
    );

  if (!existingProject) {
    throw new HTTPException(404, {
      message:
        "Project doesn't exist or doesn't belong to the specified workspace",
    });
  }

  if (projectGroupId) {
    const [projectGroup] = await db
      .select({ id: projectGroupTable.id })
      .from(projectGroupTable)
      .where(
        and(
          eq(projectGroupTable.id, projectGroupId),
          eq(projectGroupTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (!projectGroup) {
      throw new HTTPException(404, {
        message: "Project group not found in this workspace",
      });
    }
  }

  // Omitted projectGroupId leaves the current group. null still clears it.
  const nextProjectGroupId =
    projectGroupId === undefined
      ? existingProject.projectGroupId
      : projectGroupId;

  const [updatedWorkspace] = await db.transaction(async (tx) => {
    await lockProjectOrdering(tx, workspaceId);
    if (!isSameProjectKey(existingProject.slug, slug)) {
      await assertProjectKeyAvailable(tx, workspaceId, slug, id);
    }
    return tx
      .update(projectTable)
      .set({
        name,
        icon,
        slug,
        description,
        isPublic,
        projectGroupId: nextProjectGroupId,
      })
      .where(
        and(eq(projectTable.id, id), eq(projectTable.workspaceId, workspaceId)),
      )
      .returning();
  });

  return updatedWorkspace;
}

export default updateProject;
