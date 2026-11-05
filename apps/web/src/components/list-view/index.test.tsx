import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { KeyboardShortcutsProvider } from "@/hooks/use-keyboard-shortcuts";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { DragEndEvent } from "@dnd-kit/core";
import type { ProjectWithTasks } from "@/types/project";
import useBulkSelectionStore from "@/store/bulk-selection";
import useHierarchyExpansionStore from "@/store/hierarchy-expansion";
import { useUserPreferencesStore } from "@/store/user-preferences";
import ListView from "./index";

const queryClient = new QueryClient();

function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <KeyboardShortcutsProvider>{children}</KeyboardShortcutsProvider>
    </QueryClientProvider>
  );
}
const m = vi.hoisted(() => ({
  props: {} as {
    sensors?: unknown[];
    onDragEnd?: (event: DragEndEvent) => void;
  },
  archive: {} as {
    onConfirm?: () => void;
    disabled?: boolean;
    taskCount?: number;
  },
  mutate: vi.fn(),
  bulkArchive: vi.fn(),
  setProject: vi.fn(),
  relations: { data: [] as unknown[], isLoading: false, isError: false },
  refetchRelations: vi.fn(),
}));
vi.mock("@dnd-kit/core", async (original) => ({
  ...(await original<typeof import("@dnd-kit/core")>()),
  DndContext: (props: typeof m.props & { children: React.ReactNode }) => {
    m.props = props;
    return props.children;
  },
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => ({ preloadRoute: () => Promise.resolve() }),
}));
vi.mock("@/hooks/mutations/task/use-update-task", () => ({
  useUpdateTask: () => ({ mutate: m.mutate }),
}));
vi.mock("@/hooks/mutations/task/use-bulk-operations", () => ({
  useBulkOperations: () => ({
    bulkArchive: m.bulkArchive,
    bulkArchivePending: false,
  }),
}));
vi.mock("@/store/project", () => ({
  default: () => ({ setProject: m.setProject }),
}));
// This view groups subtasks under their parents, so it reads the project's
// relations. The suite mounts ListView without a QueryClientProvider.
vi.mock("@/hooks/queries/task-relation/use-get-project-task-relations", () => ({
  default: () => ({ ...m.relations, refetch: m.refetchRelations }),
}));
vi.mock("./task-row", () => ({ default: () => null }));
vi.mock("../bulk-selection/bulk-toolbar", () => ({ default: () => null }));
vi.mock("../shared/modals/create-task-modal", () => ({ default: () => null }));
vi.mock("../shared/modals/archive-tasks-modal", () => ({
  ArchiveTasksModal: (props: typeof m.archive) => {
    m.archive = props;
    return null;
  },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  m.relations = { data: [], isLoading: false, isError: false };
  window.localStorage.clear();
});
it("disables keyboard sensors and rejects drag completion on a partial board", () => {
  const project = {
    id: "p",
    workspaceId: "w",
    columns: [
      {
        id: "todo",
        slug: "todo",
        name: "To do",
        tasks: [
          { id: "a", position: 0 },
          { id: "b", position: 1 },
        ],
      },
    ],
    plannedTasks: [],
    archivedTasks: [],
  } as unknown as ProjectWithTasks;
  const { rerender } = render(<ListView project={project} />, {
    wrapper: Providers,
  });
  expect(m.props.sensors?.length).toBeGreaterThan(0);
  rerender(<ListView project={project} disableDragDrop />);
  expect(m.props.sensors).toEqual([]);
  act(() =>
    m.props.onDragEnd?.({
      active: { id: "a" },
      over: { id: "b" },
    } as DragEndEvent),
  );
  expect(m.mutate).not.toHaveBeenCalled();
  expect(m.setProject).not.toHaveBeenCalled();
});

it("blocks archive-all during pagination or errors, including an already-open confirmation", () => {
  const column = {
    id: "done",
    name: "Done",
    slug: "done",
    isFinal: true,
    tasks: [{ id: "a" }],
  };
  const project = {
    id: "p",
    workspaceId: "w",
    columns: [column],
    plannedTasks: [],
    archivedTasks: [],
  } as unknown as ProjectWithTasks;
  const { rerender } = render(<ListView project={project} />, {
    wrapper: Providers,
  });
  fireEvent.click(screen.getByTitle(/archiveAllTooltip/));
  const complete = {
    ...project,
    columns: [
      {
        ...project.columns[0],
        tasks: [...project.columns[0].tasks, { id: "b" }],
      },
    ],
  } as unknown as ProjectWithTasks;
  rerender(<ListView project={complete} disableCollectionActions />);
  expect(screen.getByTitle(/archiveAllTooltip/).hasAttribute("disabled")).toBe(
    true,
  );
  expect(m.archive.disabled).toBe(true);
  act(() => m.archive.onConfirm?.());
  expect(m.bulkArchive).not.toHaveBeenCalled();
  expect(m.setProject).not.toHaveBeenCalled();
  rerender(<ListView project={complete} />);
  expect(m.archive.taskCount).toBe(2);
  act(() => m.archive.onConfirm?.());
  expect(m.bulkArchive).toHaveBeenCalledTimes(1);
  expect(m.bulkArchive).toHaveBeenCalledWith(["a", "b"]);
  expect(m.setProject).not.toHaveBeenCalled();
});

// Subtasks come from parent links on the tasks themselves. A missing
// relations response is not a separate failure the list has to announce.
it("does not announce a relations error for an empty column", () => {
  m.relations = {
    data: undefined as unknown as unknown[],
    isLoading: false,
    isError: true,
  };
  const project = {
    id: "p",
    workspaceId: "w",
    columns: [{ id: "todo", slug: "todo", name: "To do", tasks: [] }],
    plannedTasks: [],
    archivedTasks: [],
  } as unknown as ProjectWithTasks;

  render(<ListView project={project} />, { wrapper: Providers });

  expect(screen.queryByRole("alert")).toBeNull();
  expect(m.refetchRelations).not.toHaveBeenCalled();
});

it("shows no notice when subtasks load", () => {
  const project = {
    id: "p",
    workspaceId: "w",
    columns: [{ id: "todo", slug: "todo", name: "To do", tasks: [] }],
    plannedTasks: [],
    archivedTasks: [],
  } as unknown as ProjectWithTasks;

  render(<ListView project={project} />, { wrapper: Providers });

  expect(screen.queryByRole("alert")).toBeNull();
});

// j and k follow this order. Built from the top-level tasks alone, it jumped
// past an expanded parent's subtasks to the next top-level row.
it("orders keyboard navigation by the rows as shown, subtasks included", () => {
  useUserPreferencesStore.setState({ hierarchyMode: "nested" });
  useHierarchyExpansionStore.setState({
    expandedTaskIds: { p: ["a"] },
  });
  const project = {
    id: "p",
    workspaceId: "w",
    columns: [
      {
        id: "todo",
        slug: "todo",
        name: "To do",
        tasks: [
          { id: "a", position: 0 },
          { id: "b", position: 1, parentId: null },
          { id: "c", position: 2, parentId: "a" },
        ],
      },
    ],
    plannedTasks: [],
    archivedTasks: [],
  } as unknown as ProjectWithTasks;

  render(<ListView project={project} />, { wrapper: Providers });

  // c follows its parent; its own top-level row is not listed a second time.
  expect(useBulkSelectionStore.getState().availableTaskIds).toEqual([
    "a",
    "c",
    "b",
  ]);
  useUserPreferencesStore.setState({ hierarchyMode: "flat" });
  useHierarchyExpansionStore.setState({ expandedTaskIds: {} });
});

it("keeps collapsed lanes per project after the list view unmounts", () => {
  const makeProject = (id: string) =>
    ({
      id,
      workspaceId: "w",
      columns: [
        { id: "todo", slug: "todo", name: "To do", tasks: [] },
        { id: "done", slug: "done", name: "Done", tasks: [] },
      ],
      plannedTasks: [],
      archivedTasks: [],
    }) as unknown as ProjectWithTasks;
  const lane = (name: string) =>
    screen.getByRole("button", { name: new RegExp(`^${name}`) });

  const { unmount } = render(<ListView project={makeProject("p")} />, {
    wrapper: Providers,
  });
  fireEvent.click(lane("To do"));
  expect(lane("To do")).toHaveAttribute("aria-expanded", "false");
  // Visiting the backlog unmounts the list view.
  unmount();

  render(<ListView project={makeProject("p")} />, { wrapper: Providers });
  expect(lane("To do")).toHaveAttribute("aria-expanded", "false");
  expect(lane("Done")).toHaveAttribute("aria-expanded", "true");
  cleanup();

  render(<ListView project={makeProject("other")} />, { wrapper: Providers });
  expect(lane("To do")).toHaveAttribute("aria-expanded", "true");
});
