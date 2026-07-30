import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(__dirname, "../public/site.webmanifest");

type WebManifestIcon = {
  sizes: string;
  purpose?: string;
};

type WebManifest = {
  name?: string;
  short_name?: string;
  start_url?: string;
  display?: string;
  icons?: WebManifestIcon[];
};

const VALID_DISPLAY_MODES = ["standalone", "fullscreen", "minimal-ui"];

describe("site.webmanifest", () => {
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf-8"),
  ) as WebManifest;

  it("includes required installability fields", () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBeTruthy();
    expect(VALID_DISPLAY_MODES).toContain(manifest.display);
    expect(manifest.icons?.length).toBeGreaterThanOrEqual(2);
  });

  it("includes 192x192 and 512x512 icons with purpose any", () => {
    const icons = manifest.icons ?? [];
    const has192Any = icons.some(
      (icon) =>
        icon.sizes === "192x192" &&
        (icon.purpose === "any" || icon.purpose?.includes("any")),
    );
    const has512Any = icons.some(
      (icon) =>
        icon.sizes === "512x512" &&
        (icon.purpose === "any" || icon.purpose?.includes("any")),
    );

    expect(has192Any).toBe(true);
    expect(has512Any).toBe(true);
  });
});
