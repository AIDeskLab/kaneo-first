import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { UsersManagementPage } from "@/components/admin/UsersManagementPage";
import PageTitle from "@/components/page-title";
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
  if (isPending) return <p>{t("admin.users.loading")}</p>;
  if (session?.user.role !== "admin")
    return <p>{t("admin.users.accessDenied")}</p>;
  return (
    <>
      <PageTitle title={t("admin.users.pageTitle")} />
      <UsersManagementPage />
    </>
  );
}
