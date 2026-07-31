import { asc, count, eq, inArray } from "drizzle-orm";
import db, { schema } from "../../database";

export default async function listInstanceUsers(limit: number, offset: number) {
  const [totalRow] = await db.select({ value: count() }).from(schema.userTable);
  const users = await db
    .select()
    .from(schema.userTable)
    .orderBy(asc(schema.userTable.createdAt))
    .limit(limit)
    .offset(offset);
  const allMemberships = users.length
    ? await db
        .select({
          userId: schema.workspaceUserTable.userId,
          role: schema.workspaceUserTable.role,
          id: schema.workspaceTable.id,
          name: schema.workspaceTable.name,
          slug: schema.workspaceTable.slug,
        })
        .from(schema.workspaceUserTable)
        .innerJoin(
          schema.workspaceTable,
          eq(schema.workspaceUserTable.workspaceId, schema.workspaceTable.id),
        )
        .where(
          inArray(
            schema.workspaceUserTable.userId,
            users.map((user) => user.id),
          ),
        )
    : [];
  const grouped = new Map<string, typeof allMemberships>();
  for (const membership of allMemberships) {
    const current = grouped.get(membership.userId) ?? [];
    current.push(membership);
    grouped.set(membership.userId, current);
  }

  return {
    users: users.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      locale: user.locale,
      role: user.role,
      banned: user.banned ?? false,
      banReason: user.banReason,
      banExpires: user.banExpires?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
      workspaces: (grouped.get(user.id) ?? []).map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        role: workspace.role,
      })),
    })),
    total: totalRow?.value ?? 0,
    limit,
    offset,
  };
}
