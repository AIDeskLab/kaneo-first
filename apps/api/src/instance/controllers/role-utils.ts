import { DEFAULT_ROLE_NAMES } from "@kaneo/permissions";
import { and, eq } from "drizzle-orm";
import db, { schema } from "../../database";

export async function isWorkspaceRoleValid(
  workspaceId: string,
  role: string,
): Promise<boolean> {
  if (
    (DEFAULT_ROLE_NAMES as readonly string[]).includes(role) ||
    role === "owner"
  ) {
    return true;
  }
  const [customRole] = await db
    .select({ id: schema.workspaceRoleTable.id })
    .from(schema.workspaceRoleTable)
    .where(
      and(
        eq(schema.workspaceRoleTable.workspaceId, workspaceId),
        eq(schema.workspaceRoleTable.role, role),
      ),
    )
    .limit(1);
  return Boolean(customRole);
}
