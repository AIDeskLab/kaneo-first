import { HTTPException } from "hono/http-exception";
import { isInstanceAdmin } from "../../utils/is-instance-admin";

export async function requireInstanceAdmin(
  c: Parameters<typeof isInstanceAdmin>[0],
  next: () => Promise<void>,
) {
  if (!c.get("userId")) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }
  if (!(await isInstanceAdmin(c))) {
    throw new HTTPException(403, {
      message: "Instance administrator access required",
    });
  }
  await next();
}
