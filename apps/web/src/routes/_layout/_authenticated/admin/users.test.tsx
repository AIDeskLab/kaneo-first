import { render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { Route } from "./users";

const session = vi.hoisted(() => ({ value: { user: { role: "admin" } } }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: session.value, isPending: false }) },
}));
vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-router")>(
    "@tanstack/react-router",
  );
  return { ...actual, useNavigate: () => vi.fn() };
});
vi.mock("@/components/admin/UsersManagementPage", () => ({
  UsersManagementPage: () => <div>admin.users.title</div>,
}));

describe("admin users route", () => {
  it("renders the management page for an instance admin", () => {
    const component = Route.options.component as () => ReactNode;
    render(createElement(component));
    expect(screen.getByText("admin.users.title")).toBeInTheDocument();
  });
});
