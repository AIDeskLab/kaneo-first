import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UsersTable } from "./UsersTable";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const user = {
  id: "user-1",
  name: "Ada",
  email: "ada@example.com",
  image: null,
  locale: "en",
  role: null,
  banned: false,
  banReason: null,
  banExpires: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  workspaces: [
    { id: "workspace-1", name: "Main", slug: "main", role: "member" },
  ],
};

describe("UsersTable", () => {
  it("renders memberships and opens the add action", () => {
    const onAdd = vi.fn();
    render(
      <UsersTable
        users={[user]}
        workspaces={[
          {
            id: "workspace-1",
            name: "Main",
            slug: "main",
            roles: [{ name: "member", isBuiltIn: true }],
          },
        ]}
        onAdd={onAdd}
        onRemove={vi.fn()}
        onRoleChange={vi.fn()}
        onStatusChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("Main")).toBeInTheDocument();
    fireEvent.click(screen.getByText("admin.users.addToWorkspace"));
    expect(onAdd).toHaveBeenCalledWith(user);
  });
});
