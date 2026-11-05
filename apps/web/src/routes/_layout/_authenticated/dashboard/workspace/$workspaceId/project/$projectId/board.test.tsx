import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { Route } from "./board";
const m = vi.hoisted(() => ({
  project: {
    id: "p",
    name: "Project",
    columns: [],
    plannedTasks: [],
    archivedTasks: [],
  } as unknown,
  retry: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({
    ...(options as object),
    useParams: () => ({ projectId: "p", workspaceId: "w" }),
    useSearch: () => ({}),
  }),
  useNavigate: () => vi.fn(),
}));
vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/queries/task/use-get-tasks", () => ({
  useGetTasks: () => ({
    data: m.project,
    isError: true,
    isFetching: false,
    refetch: m.retry,
  }),
}));
vi.mock("@/store/project", () => ({
  default: () => ({ project: m.project, setProject: vi.fn() }),
}));
vi.mock("@/store/user-preferences", () => ({
  useUserPreferencesStore: (
    selector?: (state: {
      viewMode: "board";
      hierarchyMode: "flat";
      setViewMode: () => void;
      setHierarchyMode: () => void;
    }) => unknown,
  ) => {
    const state = {
      viewMode: "board" as const,
      hierarchyMode: "flat" as const,
      setViewMode: () => undefined,
      setHierarchyMode: () => undefined,
    };
    return typeof selector === "function" ? selector(state) : state;
  },
}));
vi.mock("@/store/background", () => ({
  useBackgroundStore: () => ({ background: null }),
}));
vi.mock(
  "@/hooks/queries/workspace-users/use-get-active-workspace-users",
  () => ({
    useGetActiveWorkspaceUsers: () => ({ data: [] }),
  }),
);
vi.mock("@/hooks/queries/label/use-get-labels-by-workspace", () => ({
  default: () => ({ data: [] }),
}));
vi.mock("@/hooks/use-task-filters-with-labels-support", () => ({
  useTaskFiltersWithLabelsSupport: () => ({
    filters: {},
    updateFilter: vi.fn(),
    updateLabelFilter: vi.fn(),
    filteredProject: m.project,
    hasActiveFilters: false,
    clearFilters: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-keyboard-shortcuts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-keyboard-shortcuts")>()),
  useRegisterShortcuts: () => {},
}));
vi.mock("@/components/board/board-toolbar", () => ({ default: () => null }));
vi.mock("@/hooks/use-board-sort", () => ({
  useBoardSort: () => ({ sort: { field: "position" }, setSort: vi.fn() }),
}));
vi.mock("@/components/project/toolbar/use-project-task-view", () => ({
  useProjectTaskView: () => ({
    search: "",
    setSearch: vi.fn(),
    descriptionSearch: { isLoading: false, isError: false, retry: vi.fn() },
    filters: { filteredProject: m.project, clearFilters: vi.fn() },
    subjects: [],
  }),
}));
vi.mock("@/components/common/project-layout", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/kanban-board", () => ({
  default: ({ disableDragDrop }: { disableDragDrop: boolean }) => (
    <div aria-label="Cached board" data-drag-disabled={disableDragDrop}>
      Cached task
    </div>
  ),
}));
vi.mock("@/components/list-view", () => ({ default: () => null }));
vi.mock("@/components/page-title", () => ({ default: () => null }));
vi.mock("@/components/shared/modals/create-task-modal", () => ({
  default: () => null,
}));
vi.mock("@/components/task/task-details-sheet", () => ({
  default: () => null,
}));
afterEach(cleanup);
it("keeps cached tasks readable and disables reordering when a refresh fails", () => {
  const Component = (Route as unknown as { component: ComponentType })
    .component;
  render(<Component />);
  expect(screen.getByText("Cached task")).toBeDefined();
  expect(
    screen.getByLabelText("Cached board").getAttribute("data-drag-disabled"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "tasks:board.tryAgain" }));
  expect(m.retry).toHaveBeenCalledOnce();
});
