import type { LookupAddress } from "node:dns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  lookup: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));

import {
  createPinnedLookup,
  fetchPublicDestination,
  isDisallowedAddress,
} from "../../../apps/api/src/utils/assert-public-destination";

describe("public destination protection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    mocks.fetch.mockImplementation(
      async (_url: string, init: { redirect?: string }) => {
        expect(init.redirect).toBe("manual");
        return new Response("ok", { status: 200 });
      },
    );
    vi.stubGlobal("fetch", mocks.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    "localhost",
    "127.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "192.168.1.1",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
  ])("blocks non-global address %s", (address: string) => {
    expect(isDisallowedAddress(address)).toBe(true);
  });

  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])(
    "allows global unicast address %s",
    (address: string) => {
      expect(isDisallowedAddress(address)).toBe(false);
    },
  );

  it("pins lookup calls to the validated address set", async () => {
    const pinnedLookup = createPinnedLookup([
      { address: "8.8.8.8", family: 4 },
      { address: "1.1.1.1", family: 4 },
    ]);
    const connectedAddresses: string[] = [];

    for (let index = 0; index < 3; index += 1) {
      await new Promise<void>((resolve, reject) => {
        pinnedLookup(
          "example.com",
          {},
          (
            error: NodeJS.ErrnoException | null,
            address: string | LookupAddress[],
          ) => {
            if (error) {
              reject(error);
              return;
            }
            if (typeof address !== "string") {
              reject(new Error("Expected a single pinned address"));
              return;
            }
            connectedAddresses.push(address);
            resolve();
          },
        );
      });
    }

    expect(connectedAddresses).toEqual(["8.8.8.8", "1.1.1.1", "8.8.8.8"]);
  });

  it("returns the validated set for all-address lookup", async () => {
    const expected: LookupAddress[] = [
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ];
    const pinnedLookup = createPinnedLookup(expected);

    const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
      pinnedLookup("example.com", { all: true }, (error, address) => {
        if (error) {
          reject(error);
          return;
        }
        if (!Array.isArray(address)) {
          reject(new Error("Expected all validated addresses"));
          return;
        }
        resolve(address);
      });
    });

    expect(addresses).toEqual(expected);
  });

  it("uses a pinned dispatcher for the actual request", async () => {
    const response = await fetchPublicDestination(
      "https://example.com/resource",
      "Test",
    );

    await expect(response.text()).resolves.toBe("ok");
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://example.com/resource",
      expect.objectContaining({
        dispatcher: expect.anything(),
        redirect: "manual",
      }),
    );
  });

  it("rejects a chunked response before buffering beyond the configured limit", async () => {
    mocks.fetch.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.enqueue(new Uint8Array([4, 5, 6]));
            controller.close();
          },
        }),
      ),
    );

    await expect(
      fetchPublicDestination(
        "https://example.com",
        "Test",
        {},
        {
          maxResponseBytes: 5,
        },
      ),
    ).rejects.toThrow("response exceeds 5 bytes");
  });

  it("rejects an oversized content length before reading the response", async () => {
    const cancel = vi.fn();
    mocks.fetch.mockResolvedValue({
      body: { cancel },
      headers: new Headers({ "content-length": "6" }),
    });

    await expect(
      fetchPublicDestination(
        "https://example.com",
        "Test",
        {},
        {
          maxResponseBytes: 5,
        },
      ),
    ).rejects.toThrow("response exceeds 5 bytes");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects a hostname when any DNS answer is non-global", async () => {
    mocks.lookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);

    await expect(
      fetchPublicDestination("https://example.com", "Test"),
    ).rejects.toThrow("non-routable");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("allows an explicitly opted-in private webhook without weakening other callers", async () => {
    await fetchPublicDestination(
      "http://127.0.0.1/hook",
      "Generic webhook",
      {},
      { allowPrivate: true },
    );

    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1/hook",
      expect.objectContaining({ redirect: "manual" }),
    );
    await expect(
      fetchPublicDestination("http://127.0.0.1/hook", "Gitea"),
    ).rejects.toThrow("non-routable");
  });
});
