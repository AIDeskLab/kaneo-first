import { DEFAULT_ROLE_NAMES } from "@kaneo/permissions";
import { asc } from "drizzle-orm";
import db, { schema } from "../../database";

export default async function listInstanceWorkspaces() {
  const workspaces = await db
    .select()
    .from(schema.workspaceTable)
    .orderBy(asc(schema.workspaceTable.name));
  const roles = await db
    .select({
      workspaceId: schema.workspaceRoleTable.workspaceId,
      role: schema.workspaceRoleTable.role,
    })
    .from(schema.workspaceRoleTable);
  const rolesByWorkspace = new Map<string, string[]>();
  for (const role of roles) {
    const current = rolesByWorkspace.get(role.workspaceId) ?? [];
    if (!current.includes(role.role)) current.push(role.role);
    rolesByWorkspace.set(role.workspaceId, current);
  }
  return workspaces.map((workspace) => {
    const names = [
      ...DEFAULT_ROLE_NAMES,
      "owner",
      ...(rolesByWorkspace.get(workspace.id) ?? []),
    ];
    return {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      roles: names
        .filter((name, index) => names.indexOf(name) === index)
        .map((name) => ({
          name,
          isBuiltIn:
            name === "owner" ||
            (DEFAULT_ROLE_NAMES as readonly string[]).includes(name),
        })),
    };
  });
}
