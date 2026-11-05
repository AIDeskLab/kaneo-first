import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import PageTitle from "./page-title";

describe("PageTitle", () => {
  beforeEach(() => {
    document.title = "Kaneo";
  });

  afterEach(() => {
    cleanup();
    document.title = "Kaneo";
  });

  it("appends the default app name", () => {
    render(<PageTitle title="Settings" />);
    expect(document.title).toBe("Settings — Kaneo");
  });

  it("uses a custom suffix", () => {
    render(<PageTitle title="Settings" suffix="Acme" />);
    expect(document.title).toBe("Settings — Acme");
  });

  it("omits the app name when asked", () => {
    render(<PageTitle title="Website / Board" hideAppName />);
    expect(document.title).toBe("Website / Board");
  });

  it("leaves the current title alone until a title is available", () => {
    render(<PageTitle title={undefined} />);
    expect(document.title).toBe("Kaneo");
  });
});
