import { createFileRoute } from "@tanstack/react-router";
import { FolderTree } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import WorkspaceLayout from "@/components/common/workspace-layout";
import PageTitle from "@/components/page-title";
import { CreateProjectGroupModal } from "@/components/project-group/CreateProjectGroupModal";
import { ProjectGroupsTable } from "@/components/project-group/ProjectGroupsTable";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import useGetProjectGroups from "@/hooks/queries/project-group/use-get-project-groups";
import useActiveWorkspace from "@/hooks/queries/workspace/use-active-workspace";

export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/workspace/$workspaceId/project-groups",
)({
  component: RouteComponent,
});

function RouteComponent() {
  const { t } = useTranslation();
  const { workspaceId } = Route.useParams();
  const { data: workspace } = useActiveWorkspace();
  const { data: groups } = useGetProjectGroups(workspaceId);
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  return (
    <>
      <PageTitle title={t("project-groups:pageTitle")} />
      <WorkspaceLayout
        title={t("project-groups:pageTitle")}
        headerActions={
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs"
            onClick={() => setIsCreateOpen(true)}
          >
            {t("project-groups:create")}
          </button>
        }
      >
        {!groups || groups.length === 0 ? (
          <Empty>
            <EmptyMedia variant="icon">
              <FolderTree className="size-4.5" />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>{t("project-groups:emptyTitle")}</EmptyTitle>
              <EmptyDescription>
                {t("project-groups:emptyDescription")}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded border border-border px-3 py-1.5 text-sm"
                onClick={() => setIsCreateOpen(true)}
              >
                {t("project-groups:create")}
              </button>
            </EmptyContent>
          </Empty>
        ) : (
          <ProjectGroupsTable workspaceId={workspaceId} groups={groups} />
        )}
        <CreateProjectGroupModal
          open={isCreateOpen}
          onClose={() => setIsCreateOpen(false)}
          workspaceId={workspaceId}
        />
      </WorkspaceLayout>
    </>
  );
}
