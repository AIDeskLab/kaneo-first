import { eq } from "drizzle-orm";
import type { Context, Next } from "hono";
import db from "../../database";
import { taskTable } from "../../database/schema";
import { requireWorkspacePermission } from "../../utils/require-workspace-permission";

type TaskEnv = {
  Variables: {
    userId: string;
    authorizedTaskAssignee?: { userId: string | null };
  };
};

type BulkTaskOperation =
  | "updateStatus"
  | "updatePriority"
  | "updateAssignee"
  | "delete"
  | "addLabel"
  | "removeLabel"
  | "updateDueDate";

type BulkTaskContext = Context<
  TaskEnv,
  string,
  { out: { json: { operation: BulkTaskOperation } } }
>;

type TaskAssigneeContext = Context<
  TaskEnv,
  string,
  {
    out: {
      param: { id: string };
      json: { userId?: string };
    };
  }
>;

type TaskCreateContext = Context<
  TaskEnv,
  string,
  { out: { json: { userId?: string | null } } }
>;

type TaskImportContext = Context<
  TaskEnv,
  string,
  { out: { json: { tasks: Array<{ userId?: string | null }> } } }
>;

export async function requireBulkTaskPermission(
  c: BulkTaskContext,
  next: Next,
) {
  const { operation } = c.req.valid("json");

  if (operation === "delete") {
    return requireWorkspacePermission({ task: ["delete"] })(c, next);
  }

  if (operation === "updateAssignee") {
    return requireWorkspacePermission({ task: ["assign"] })(c, next);
  }

  if (operation === "addLabel" || operation === "removeLabel") {
    return requireWorkspacePermission({ label: ["update"] })(c, next);
  }

  return requireWorkspacePermission({ task: ["update"] })(c, next);
}

export async function requireTaskAssigneePermission(
  c: TaskAssigneeContext,
  next: Next,
) {
  const { id } = c.req.valid("param");
  const { userId } = c.req.valid("json");
  const [existingTask] = await db
    .select({ userId: taskTable.userId })
    .from(taskTable)
    .where(eq(taskTable.id, id))
    .limit(1);

  if (existingTask && existingTask.userId !== (userId?.trim() || null)) {
    return requireWorkspacePermission({ task: ["assign"] })(c, next);
  }

  if (existingTask) {
    c.set("authorizedTaskAssignee", { userId: existingTask.userId });
  }

  return next();
}

export async function requireCreateTaskAssigneePermission(
  c: TaskCreateContext,
  next: Next,
) {
  const { userId } = c.req.valid("json");
  if (userId?.trim()) {
    return requireWorkspacePermission({ task: ["assign"] })(c, next);
  }
  return next();
}

export async function requireImportTaskAssigneePermission(
  c: TaskImportContext,
  next: Next,
) {
  const { tasks } = c.req.valid("json");
  if (tasks.some((task) => task.userId?.trim())) {
    return requireWorkspacePermission({ task: ["assign"] })(c, next);
  }
  return next();
}
