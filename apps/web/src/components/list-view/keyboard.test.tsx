import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeyboardShortcutsProvider } from "@/hooks/use-keyboard-shortcuts";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { writeExpandedRows } from "@/lib/expanded-rows-storage";
import { shortcutRegistry } from "@/lib/shortcuts/registry";
import { ShortcutTestWrapper } from "@/lib/shortcuts/shortcut-test-wrapper";
import useBulkSelectionStore from "@/store/bulk-selection";
import type { ProjectWithTasks } from "@/types/project";
import ListView from ".";

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), setProject: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => ({ preloadRoute: () => Promise.resolve() }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/mutations/task/use-update-task", () => ({
  useUpdateTask: () => ({ mutate: mocks.mutate }),
}));
vi.mock("@/store/project", () => ({
  default: () => ({ setProject: mocks.setProject }),
}));
vi.mock("@/hooks/queries/task-relation/use-get-project-task-relations", () => ({
  default: () => ({
    data: [
      {
        sourceTaskId: "parent",
        targetTaskId: "child",
        relationType: "subtask",
      },
    ],
    isLoading: false,
    isError: false,
  }),
}));
vi.mock("./task-row", () => ({
  default: ({ task }: { task: { id: string } }) => (
    <button
      type="button"
      data-task-id={task.id}
      data-task-row-id={task.id}
      onFocus={() =>
        useBulkSelectionStore.getState().setFocusedTask(task.id, task.id)
      }
    />
  ),
}));
vi.mock("../bulk-selection/bulk-toolbar", () => ({ default: () => null }));
vi.mock("../shared/modals/create-task-modal", () => ({ default: () => null }));
vi.mock("../shared/modals/archive-tasks-modal", () => ({
  ArchiveTasksModal: () => null,
}));

function mount() {
  writeExpandedRows("keyboard-project", { parent: true });
  const project = {
    id: "keyboard-project",
    workspaceId: "workspace",
    columns: [
      {
        id: "todo",
        slug: "todo",
        name: "To do",
        tasks: [
          { id: "parent", status: "todo", position: 0 },
          { id: "sibling", status: "todo", position: 1 },
        ],
      },
      {
        id: "doing",
        slug: "doing",
        name: "Doing",
        tasks: [
          { id: "child", status: "doing", position: 0 },
          { id: "last", status: "doing", position: 1 },
        ],
      },
    ],
  } as ProjectWithTasks;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <KeyboardShortcutsProvider>
        <ShortcutTestWrapper>
          <ListView project={project} />
        </ShortcutTestWrapper>
      </KeyboardShortcutsProvider>
    </QueryClientProvider>,
  );
}
const press = (key: string, code: string, altKey = false) =>
  fireEvent.keyDown(document.body, { key, code, altKey });

afterEach(() => {
  cleanup();
  shortcutRegistry.reset();
  localStorage.clear();
  useBulkSelectionStore.getState().clearFocus();
  useBulkSelectionStore.getState().clearSelection();
  vi.clearAllMocks();
});

it("visits each rendered task in column order and wraps", () => {
  mount();
  const visited: (string | null)[] = [];
  for (let index = 0; index < 6; index++) {
    press("j", "KeyJ");
    visited.push(useBulkSelectionStore.getState().focusedTaskId);
  }
  expect(visited).toEqual([
    "parent",
    "sibling",
    "child",
    "last",
    "parent",
    "sibling",
  ]);
});

it("continues from the focused row", () => {
  mount();
  const row = document.querySelector<HTMLElement>(
    '[data-task-row-id="child"]',
  )!;
  act(() => row.focus());
  press("j", "KeyJ");
  expect(useBulkSelectionStore.getState().focusedTaskId).toBe("last");
  act(() => row.focus());
  press("k", "KeyK");
  expect(useBulkSelectionStore.getState().focusedTaskId).toBe("sibling");
});

it("skips tasks in a collapsed status group", () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: /^To do/ }));
  press("j", "KeyJ");
  expect(useBulkSelectionStore.getState().focusedTaskId).toBe("child");
  press("j", "KeyJ");
  expect(useBulkSelectionStore.getState().focusedTaskId).toBe("last");
  expect(screen.getByRole("button", { name: /^To do/ })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(screen.getByRole("button", { name: /^Doing/ })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
});

it("does not reorder from alt+arrow; j and k move focus only", () => {
  mount();
  const row = document.querySelector<HTMLElement>(
    '[data-task-row-id="child"]',
  )!;
  act(() => row.focus());
  press("ArrowDown", "ArrowDown", true);
  expect(mocks.mutate).not.toHaveBeenCalled();
  expect(useBulkSelectionStore.getState().focusedTaskId).toBe("child");
});
