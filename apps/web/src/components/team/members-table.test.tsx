import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceUserInvitation } from "@/types/workspace-user";
import MembersTable from "./members-table";

const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
const mockWriteText = vi.fn();
const mockCopyInvitationLink = vi.fn();
const permissions = { canInvite: true };

vi.mock("@kaneo/permissions", () => ({
  DEFAULT_ROLE_NAMES: ["viewer", "member", "admin"],
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({
    canManageTeam: () => false,
    canRemoveMembers: () => false,
    canInviteUsers: () => permissions.canInvite,
  }),
}));

vi.mock("@/hooks/use-copy-invitation-link", () => ({
  useCopyInvitationLink: () => ({ copy: mockCopyInvitationLink }),
}));

vi.mock("@/hooks/mutations/workspace-user/use-cancel-invitation", () => ({
  default: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/mutations/workspace-user/use-delete-workspace-user", () => ({
  default: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock(
  "@/hooks/mutations/workspace-user/use-update-workspace-user-role",
  () => ({ default: () => ({ mutateAsync: vi.fn(), isPending: false }) }),
);

vi.mock("@/hooks/queries/workspace/use-workspace-roles", () => ({
  default: () => ({ data: [] }),
}));

vi.mock("@/hooks/queries/config/use-get-config", () => ({
  default: () => ({ data: { clientUrl: "https://app.example.com" } }),
}));

vi.mock("../providers/auth-provider/hooks/use-auth", () => ({
  useAuth: () => ({ user: null }),
}));

vi.mock("@/lib/toast", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock("@/lib/format", () => ({
  formatDateMedium: () => "Aug 1, 2026",
}));

const pendingInvitation = {
  id: "inv-123",
  email: "guest@example.com",
  role: "member",
  status: "pending",
  expiresAt: "2026-08-01T00:00:00.000Z",
} as WorkspaceUserInvitation;

function renderMembersTable() {
  return render(
    <MembersTable
      workspaceId="ws-1"
      users={[]}
      invitations={[pendingInvitation]}
    />,
  );
}

describe("MembersTable pending invitation actions", () => {
  beforeEach(() => {
    permissions.canInvite = true;
    mockToastSuccess.mockReset();
    mockToastError.mockReset();
    mockWriteText.mockReset();
    mockWriteText.mockResolvedValue(undefined);
    mockCopyInvitationLink.mockReset();
    mockCopyInvitationLink.mockResolvedValue(true);

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: mockWriteText },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("copies the invitation URL from the pending badge", async () => {
    renderMembersTable();

    fireEvent.click(
      screen.getByRole("button", {
        name: "team:membersTable.copyInviteLinkAria",
      }),
    );

    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith(
        "https://app.example.com/invitation/accept/inv-123",
      );
    });
    expect(mockToastSuccess).toHaveBeenCalledWith(
      "team:membersTable.copyInviteLinkSuccess",
    );
  });

  it("copies the invitation URL from the row menu", async () => {
    renderMembersTable();

    fireEvent.click(
      screen.getByRole("button", {
        name: "team:membersTable.ariaInvitationActions",
      }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "team:invitations.copyLink",
      }),
    );

    expect(mockCopyInvitationLink).toHaveBeenCalledWith("inv-123");
  });

  it("opens confirmation before cancelling an invitation", async () => {
    renderMembersTable();

    fireEvent.click(
      screen.getByRole("button", {
        name: "team:membersTable.ariaInvitationActions",
      }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "team:membersTable.cancelInvitation",
      }),
    );

    expect(
      await screen.findByText("team:membersTable.cancelDialogTitle"),
    ).toBeVisible();
  });

  it("hides invitation actions when the user cannot invite", () => {
    permissions.canInvite = false;
    renderMembersTable();

    expect(
      screen.queryByRole("button", {
        name: "team:membersTable.copyInviteLinkAria",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "team:membersTable.ariaInvitationActions",
      }),
    ).not.toBeInTheDocument();
  });

  it("shows an error when clipboard access fails", async () => {
    mockWriteText.mockRejectedValueOnce(new Error("clipboard denied"));
    renderMembersTable();

    fireEvent.click(
      screen.getByRole("button", {
        name: "team:membersTable.copyInviteLinkAria",
      }),
    );

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("clipboard denied");
    });
  });
});
