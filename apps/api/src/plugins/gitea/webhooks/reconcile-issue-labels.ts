import { and, eq, inArray, notInArray } from "drizzle-orm";
import db from "../../../database";
import {
  labelTable,
  type labelTable as labelTableType,
} from "../../../database/schema";
import {
  lockWorkspaceLabels,
  normalizeLabelIdentity,
} from "../../../label/controllers/workspace-label-lock";

type LabelRow = typeof labelTableType.$inferSelect;

export type GiteaLabelInput = string | { name?: string; color?: string };

export type GiteaLabelLoader = () => Promise<GiteaLabelInput[]>;

export type GiteaLabelReconciliationResult = {
  assigned: LabelRow[];
  unassigned: LabelRow[];
};

class GiteaLabelLockExpansion extends Error {
  constructor(readonly expandedNames: string[]) {
    super("Gitea label lock expansion required");
    this.name = "GiteaLabelLockExpansion";
  }
}

function extractNonSystemGiteaLabels(
  issueLabels: GiteaLabelInput[] | null | undefined,
): Array<{ name: string; color: string }> {
  return (issueLabels ?? [])
    .map((label) => {
      if (typeof label === "string") {
        return { name: label, color: "#6B7280" };
      }
      return {
        name: label.name,
        color: label.color
          ? `#${String(label.color).replace(/^#/, "")}`
          : "#6B7280",
      };
    })
    .filter(
      (label) =>
        label.name &&
        !label.name.startsWith("priority:") &&
        !label.name.startsWith("status:"),
    ) as Array<{ name: string; color: string }>;
}

function unionLabelNames(...nameSets: string[][]): string[] {
  return [...new Set(nameSets.flat())];
}

function namesMissingFromLockSet(
  names: string[],
  lockNames: string[],
): string[] {
  const locked = new Set(lockNames.map(normalizeLabelIdentity));
  return names.filter((name) => !locked.has(normalizeLabelIdentity(name)));
}

export async function reconcileGiteaIssueLabels(
  taskId: string,
  workspaceId: string,
  payloadLabelNames: string[],
  loader: GiteaLabelLoader,
): Promise<GiteaLabelReconciliationResult> {
  const snapshotNames = payloadLabelNames;
  let lockNamesSeed = snapshotNames;

  while (true) {
    try {
      return await db.transaction(async (tx) => {
        const existingGiteaRows = await tx
          .select()
          .from(labelTable)
          .where(
            and(eq(labelTable.taskId, taskId), eq(labelTable.source, "gitea")),
          );
        const existingGiteaNames = existingGiteaRows.map((row) => row.name);
        const lockNames = unionLabelNames(
          lockNamesSeed,
          snapshotNames,
          existingGiteaNames,
        );

        await lockWorkspaceLabels(tx, workspaceId, lockNames);

        const currentLabels = extractNonSystemGiteaLabels(await loader());
        const currentNames = currentLabels.map((label) => label.name);
        const unheldNames = namesMissingFromLockSet(currentNames, lockNames);
        if (unheldNames.length > 0) {
          throw new GiteaLabelLockExpansion(
            unionLabelNames(lockNames, currentNames),
          );
        }

        const unassigned =
          currentNames.length > 0
            ? await tx
                .delete(labelTable)
                .where(
                  and(
                    eq(labelTable.taskId, taskId),
                    eq(labelTable.source, "gitea"),
                    notInArray(labelTable.name, currentNames),
                  ),
                )
                .returning()
            : await tx
                .delete(labelTable)
                .where(
                  and(
                    eq(labelTable.taskId, taskId),
                    eq(labelTable.source, "gitea"),
                  ),
                )
                .returning();

        const existingLabelsOnTask = await tx
          .select()
          .from(labelTable)
          .where(
            currentNames.length > 0
              ? and(
                  eq(labelTable.taskId, taskId),
                  inArray(labelTable.name, currentNames),
                )
              : eq(labelTable.taskId, taskId),
          );

        const assigned: LabelRow[] = [];
        for (const labelData of currentLabels) {
          const existingLabelOnTask = existingLabelsOnTask.find(
            (label) => label.name === labelData.name,
          );

          if (existingLabelOnTask) continue;

          const [existingWorkspaceLabel] = await tx
            .select()
            .from(labelTable)
            .where(
              and(
                eq(labelTable.workspaceId, workspaceId),
                eq(labelTable.name, labelData.name),
              ),
            )
            .limit(1);

          const colorToUse = existingWorkspaceLabel?.color || labelData.color;

          const [inserted] = await tx
            .insert(labelTable)
            .values({
              name: labelData.name,
              color: colorToUse,
              source: "gitea",
              taskId,
              workspaceId,
            })
            .onConflictDoNothing({
              target: [labelTable.taskId, labelTable.name],
            })
            .returning();

          if (inserted) {
            assigned.push(inserted);
          }
        }

        return { assigned, unassigned };
      });
    } catch (error) {
      if (error instanceof GiteaLabelLockExpansion) {
        lockNamesSeed = error.expandedNames;
        continue;
      }
      throw error;
    }
  }
}
