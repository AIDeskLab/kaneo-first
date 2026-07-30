import { and, count, eq, isNull, min, notInArray } from "drizzle-orm";
import db from "../../database";
import { projectTable, taskTable } from "../../database/schema";

const EXCLUDED_TASK_STATUSES = ["archived", "deleted"];

type ProjectStatistics = {
  completionPercentage: number;
  totalTasks: number;
  dueDate: Date | null;
};

type ProjectSummary = {
  statistics: ProjectStatistics;
  taskCountByStatus: Record<string, number>;
  totalActiveTasks: number;
};

function createEmptySummary(): ProjectSummary {
  return {
    statistics: {
      completionPercentage: 0,
      totalTasks: 0,
      dueDate: null,
    },
    taskCountByStatus: {},
    totalActiveTasks: 0,
  };
}

async function getProjectSummaries(
  workspaceId: string,
  includeArchived: boolean,
) {
  const summariesByProject = new Map<string, ProjectSummary>();
  const projectScope = includeArchived
    ? eq(projectTable.workspaceId, workspaceId)
    : and(
        eq(projectTable.workspaceId, workspaceId),
        isNull(projectTable.archivedAt),
      );

  const rows = await db
    .select({
      projectId: taskTable.projectId,
      status: taskTable.status,
      totalTasks: count(),
      dueDate: min(taskTable.dueDate),
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .where(
      and(
        projectScope,
        notInArray(taskTable.status, EXCLUDED_TASK_STATUSES),
      ),
    )
    .groupBy(taskTable.projectId, taskTable.status);

  for (const row of rows) {
    const summary =
      summariesByProject.get(row.projectId) ?? createEmptySummary();
    const statusCount = Number(row.totalTasks);

    summary.taskCountByStatus[row.status] = statusCount;
    summary.totalActiveTasks += statusCount;
    summary.statistics.totalTasks += statusCount;

    if (
      row.dueDate &&
      (!summary.statistics.dueDate || row.dueDate < summary.statistics.dueDate)
    ) {
      summary.statistics.dueDate = row.dueDate;
    }

    summariesByProject.set(row.projectId, summary);
  }

  for (const summary of summariesByProject.values()) {
    const completedTasks = summary.taskCountByStatus.done ?? 0;
    summary.statistics.completionPercentage =
      summary.totalActiveTasks > 0
        ? Math.round((completedTasks / summary.totalActiveTasks) * 100)
        : 0;
  }

  return summariesByProject;
}

async function getProjects(workspaceId: string, includeArchived = false) {
  const projects = await db.query.projectTable.findMany({
    where: includeArchived
      ? eq(projectTable.workspaceId, workspaceId)
      : and(
          eq(projectTable.workspaceId, workspaceId),
          isNull(projectTable.archivedAt),
        ),
  });

  const summariesByProject = await getProjectSummaries(
    workspaceId,
    includeArchived,
  );

  return projects.map((project) => {
    const summary = summariesByProject.get(project.id) ?? createEmptySummary();

    return {
      ...project,
      ...summary,
      archivedTasks: [],
      plannedTasks: [],
      columns: [],
    };
  });
}

export default getProjects;
