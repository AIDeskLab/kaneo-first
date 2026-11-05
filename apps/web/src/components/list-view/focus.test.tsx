import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ProjectWithTasks } from "@/types/project";
import { useUserPreferencesStore } from "@/store/user-preferences";
import useHierarchyExpansionStore from "@/store/hierarchy-expansion";
import ListView from ".";

function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => ({ preloadRoute: () => Promise.resolve() }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/mutations/task/use-update-task", () => ({
  useUpdateTask: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/hooks/use-keyboard-shortcuts", () => ({
  useRegisterShortcuts: vi.fn(),
}));
vi.mock("@/hooks/queries/task-relation/use-get-project-task-relations", () => ({
  default: () => ({
    isLoading: false,
    data: [
      {
        sourceTaskId: "parent",
        targetTaskId: "child",
        relationType: "subtask",
      },
      {
        sourceTaskId: "child",
        targetTaskId: "grandchild",
        relationType: "subtask",
      },
    ],
  }),
}));
vi.mock("../bulk-selection/bulk-toolbar", () => ({ default: () => null }));
vi.mock("../shared/modals/create-task-modal", () => ({ default: () => null }));
vi.mock("../shared/modals/archive-tasks-modal", () => ({
  ArchiveTasksModal: () => null,
}));
vi.mock("./task-row", () => ({
  default: ({
    task,
    hasChildren,
    isExpanded,
    onToggleExpand,
  }: {
    task: { id: string };
    hasChildren?: boolean;
    isExpanded?: boolean;
    onToggleExpand?: () => void;
  }) => (
    <div>
      {task.id}
      {hasChildren && (
        <button
          type="button"
          aria-label={`Toggle ${task.id}`}
          aria-expanded={isExpanded}
          onClick={() => onToggleExpand?.()}
        >
          Toggle
        </button>
      )}
    </div>
  ),
}));

const project = {
  id: "project-focus",
  slug: "FOC",
  workspaceId: "workspace-1",
  columns: [
    {
      id: "to-do",
      name: "To Do",
      isFinal: false,
      icon: null,
      tasks: ["parent", "child", "grandchild"].map((id, index) => ({
        id,
        title: id,
        status: "to-do",
        parentId:
          index === 0 ? null : ["parent", "child", "grandchild"][index - 1],
      })),
    },
  ],
} as ProjectWithTasks;

afterEach(() => {
  cleanup();
  localStorage.clear();
  useUserPreferencesStore.setState({ hierarchyMode: "flat" });
  useHierarchyExpansionStore.setState({ expandedTaskIds: {} });
});

describe("ListView focus", () => {
  it("retains the focused toggle when expanding and collapsing parent and nested rows", () => {
    useUserPreferencesStore.setState({ hierarchyMode: "nested" });
    useHierarchyExpansionStore.setState({ expandedTaskIds: {} });
    render(<ListView project={project} />, { wrapper: Providers });

    for (const rowId of ["parent", "child"]) {
      const toggle = screen.getByRole("button", { name: `Toggle ${rowId}` });
      toggle.focus();
      fireEvent.click(toggle);

      expect(toggle).toHaveFocus();
      expect(toggle).toHaveAttribute("aria-expanded", "true");
    }

    for (const rowId of ["child", "parent"]) {
      const toggle = screen.getByRole("button", { name: `Toggle ${rowId}` });
      toggle.focus();
      fireEvent.click(toggle);

      expect(toggle).toHaveFocus();
      expect(toggle).toHaveAttribute("aria-expanded", "false");
    }
  });

  it("retains header focus when collapsing and expanding a status group", () => {
    useUserPreferencesStore.setState({ hierarchyMode: "nested" });
    useHierarchyExpansionStore.setState({ expandedTaskIds: {} });
    render(<ListView project={project} />, { wrapper: Providers });
    const header = screen.getByRole("button", { name: /^To Do/ });
    header.focus();

    fireEvent.click(header);
    expect(header).toHaveFocus();
    expect(
      screen.queryByRole("button", { name: "Toggle parent" }),
    ).not.toBeInTheDocument();

    fireEvent.click(header);
    expect(header).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Toggle parent" }),
    ).toBeInTheDocument();
  });
});
