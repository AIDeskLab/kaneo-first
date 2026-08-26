import { and, eq, inArray, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import {
  projectTable,
  taskRelationTable,
  taskTable,
} from "../../database/schema";
import type { DbOrTx } from "./workspace-assignee-lock";

/**
 * Workspace advisory-lock namespace for subtask-graph mutations.
 *
 * Encoding: PostgreSQL `pg_advisory_xact_lock(classid, objid)` uses the
 * two-int form equivalent to `classid * 2^32 + objid` in the single-bigint
 * lock space. We pass classid=1540 and objid=hashtext(workspaceId) so every
 * relation create/delete and cascade hierarchy resolve in the same workspace
 * serializes on one transaction-scoped lock.
 *
 * The lock is intentionally blocking so concurrent hierarchy mutations
 * serialize (this is what prevents deadlocks and relation cycles). To keep a
 * stuck/abandoned lock from hanging callers into the Cloudflare 120s proxy
 * window (HTTP 524), the wait is bounded with a transaction-local
 * `statement_timeout`; `lock_timeout` is deliberately not used because
 * PostgreSQL does not apply it to advisory locks.
 */
export const WORKSPACE_TASK_HIERARCHY_LOCK_NAMESPACE = 1540;

export type HierarchyTask = {
  id: string;
  projectId: string;
  status: string;
  columnId: string | null;
};

type HierarchyTaskRow = HierarchyTask & {
  workspaceId: string;
};

export async function lockWorkspaceTaskHierarchy(
  tx: DbOrTx,
  workspaceId: string,
) {
  await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${WORKSPACE_TASK_HIERARCHY_LOCK_NAMESPACE}, hashtext(${workspaceId}))`,
  );
  await tx.execute(sql`SET LOCAL statement_timeout = DEFAULT`);
}

/**
 * Resolve a workspace-scoped subtask hierarchy.
 *
 * - Includes every root id.
 * - Traverses only `task_relation` rows where relationType="subtask"
 *   with sourceTaskId=parent and targetTaskId=child.
 * - Dedupes across multi-root input and diamond edges.
 * - Terminates cleanly if corrupted cycles revisit a node.
 * - Fail-closed when any reached task is outside `workspaceId`.
 *
 * Acquires the workspace hierarchy advisory lock (namespace 1540) for the
 * duration of the surrounding transaction.
 */
export async function resolveTaskHierarchy(
  tx: DbOrTx,
  workspaceId: string,
  rootTaskIds: string[],
): Promise<HierarchyTask[]> {
  await lockWorkspaceTaskHierarchy(tx, workspaceId);

  const uniqueRoots = [...new Set(rootTaskIds.filter(Boolean))];
  if (uniqueRoots.length === 0) {
    return [];
  }

  const rootRows = await tx
    .select({
      id: taskTable.id,
      projectId: taskTable.projectId,
      status: taskTable.status,
      columnId: taskTable.columnId,
      workspaceId: projectTable.workspaceId,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .where(inArray(taskTable.id, uniqueRoots));

  if (rootRows.length !== uniqueRoots.length) {
    throw new HTTPException(404, { message: "Task not found" });
  }

  for (const row of rootRows) {
    assertSameWorkspace(row, workspaceId);
  }

  const ordered: HierarchyTask[] = [];
  const visited = new Set<string>();
  const byId = new Map<string, HierarchyTaskRow>(
    rootRows.map((row) => [row.id, row]),
  );

  let frontier = [...uniqueRoots];

  while (frontier.length > 0) {
    for (const id of frontier) {
      if (visited.has(id)) {
        continue;
      }
      visited.add(id);

      const row = byId.get(id);
      if (!row) {
        throw new HTTPException(500, {
          message: "Failed to resolve task hierarchy",
        });
      }
      assertSameWorkspace(row, workspaceId);
      ordered.push({
        id: row.id,
        projectId: row.projectId,
        status: row.status,
        columnId: row.columnId,
      });
    }

    const childRows = await tx
      .select({
        id: taskTable.id,
        projectId: taskTable.projectId,
        status: taskTable.status,
        columnId: taskTable.columnId,
        workspaceId: projectTable.workspaceId,
      })
      .from(taskRelationTable)
      .innerJoin(taskTable, eq(taskRelationTable.targetTaskId, taskTable.id))
      .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
      .where(
        and(
          inArray(taskRelationTable.sourceTaskId, frontier),
          eq(taskRelationTable.relationType, "subtask"),
        ),
      );

    const nextFrontier: string[] = [];
    for (const child of childRows) {
      // Already queued/visited → multi-root overlap, diamond, or cycle.
      if (visited.has(child.id) || byId.has(child.id)) {
        continue;
      }
      assertSameWorkspace(child, workspaceId);
      byId.set(child.id, child);
      nextFrontier.push(child.id);
    }
    frontier = nextFrontier;
  }

  return ordered;
}

function assertSameWorkspace(row: HierarchyTaskRow, workspaceId: string) {
  if (row.workspaceId !== workspaceId) {
    throw new HTTPException(400, {
      message: "Task hierarchy spans multiple workspaces",
    });
  }
}
