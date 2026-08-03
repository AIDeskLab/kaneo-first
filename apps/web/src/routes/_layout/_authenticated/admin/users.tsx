import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { UsersManagementPage } from "@/components/admin/UsersManagementPage";
import Layout from "@/components/common/layout";
import PageTitle from "@/components/page-title";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/_layout/_authenticated/admin/users")({
  component: RouteComponent,
});

function RouteComponent() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: session, isPending } = authClient.useSession();
  useEffect(() => {
    if (!isPending && session?.user.role !== "admin") {
      void navigate({ to: "/dashboard" });
    }
  }, [isPending, navigate, session?.user.role]);
  if (isPending) return <p>{t("admin:users.loading")}</p>;
  if (session?.user.role !== "admin")
    return <p>{t("admin:users.accessDenied")}</p>;
  return (
    <Layout>
      <Layout.Header>
        <div className="flex items-center gap-1 w-full">
          <SidebarTrigger className="-ml-1 h-6 w-6" />
          <Separator
            orientation="vertical"
            className="mx-1.5 data-[orientation=vertical]:h-2.5"
          />
          <Breadcrumb className="flex items-center gap-1 text-xs w-full">
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink href="/dashboard">
                  <h1 className="text-xs text-card-foreground">
                    {t("navigation:sidebar.overview")}
                  </h1>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <h1 className="text-xs text-card-foreground">
                  {t("admin:users.navigationLabel")}
                </h1>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </Layout.Header>
      <Layout.Content>
        <div className="space-y-6 py-6">
          <PageTitle title={t("admin:users.pageTitle")} />
          <UsersManagementPage />
        </div>
      </Layout.Content>
    </Layout>
  );
}
