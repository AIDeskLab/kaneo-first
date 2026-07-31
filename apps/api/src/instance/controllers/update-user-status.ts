import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../../database";

export default async function updateUserStatus(
  userId: string,
  currentUserId: string,
  banned: boolean,
  banReason?: string | null,
  banExpires?: string | null,
) {
  if (userId === currentUserId && banned) {
    throw new HTTPException(400, { message: "You cannot ban yourself" });
  }
  const [user] = await db
    .select()
    .from(schema.userTable)
    .where(eq(schema.userTable.id, userId))
    .limit(1);
  if (!user) throw new HTTPException(404, { message: "User not found" });
  let expires: Date | null = null;
  if (banned && banExpires) {
    expires = new Date(banExpires);
    if (Number.isNaN(expires.getTime())) {
      throw new HTTPException(400, { message: "Invalid ban expiration date" });
    }
  }
  const [updated] = await db
    .update(schema.userTable)
    .set({
      banned,
      banReason: banned ? (banReason ?? null) : null,
      banExpires: banned ? expires : null,
    })
    .where(eq(schema.userTable.id, userId))
    .returning();
  return {
    ...updated,
    banExpires: updated.banExpires?.toISOString() ?? null,
  };
}
