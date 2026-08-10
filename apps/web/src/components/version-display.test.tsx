import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import packageJson from "../../../../package.json";
import { VersionDisplay } from "./version-display";

beforeEach(() => {
  vi.stubGlobal("__APP_VERSION__", packageJson.version);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("links the canonical fork version to the fork changelog", () => {
  render(<VersionDisplay />);

  expect(
    screen.getByRole("link", { name: `v${packageJson.version}` }),
  ).toHaveAttribute(
    "href",
    "https://github.com/AIDeskLab/kaneo-first/blob/main/CHANGELOG.md",
  );
});
