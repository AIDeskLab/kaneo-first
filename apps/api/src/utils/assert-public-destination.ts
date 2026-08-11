import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent } from "undici";

type PublicDestinationOptions = {
  allowPrivate?: boolean;
  maxResponseBytes?: number;
};

const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

type DispatcherRequestInit = RequestInit & { dispatcher?: Agent };

function fetchWithDispatcher(
  input: string | URL | Request,
  init?: DispatcherRequestInit,
): Promise<Response> {
  const fetchImplementation = globalThis.fetch as (
    request: string | URL | Request,
    options?: DispatcherRequestInit,
  ) => Promise<Response>;
  return fetchImplementation(input, init);
}

async function copyBoundedResponse(
  response: Response,
  label: string,
  maxResponseBytes: number,
): Promise<Response> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxResponseBytes) {
    await response.body?.cancel();
    throw new Error(`${label} response exceeds ${maxResponseBytes} bytes`);
  }

  if (!response.body) {
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxResponseBytes) {
        await reader.cancel();
        throw new Error(`${label} response exceeds ${maxResponseBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function isDisallowedAddress(address: string): boolean {
  // URL.hostname keeps brackets on IPv6 literals, while ipaddr expects the
  // bare address.
  const bare = address.replace(/^\[|\]$/g, "");
  if (bare.toLowerCase() === "localhost") {
    return true;
  }
  if (!ipaddr.isValid(bare)) {
    // Hostnames are resolved and each returned address is checked below.
    return false;
  }

  const parsed = ipaddr.parse(bare);
  if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) {
    return parsed.toIPv4Address().range() !== "unicast";
  }
  return parsed.range() !== "unicast";
}

async function resolvePublicDestination(
  destinationUrl: string,
  label: string,
  options: PublicDestinationOptions = {},
): Promise<LookupAddress[] | null> {
  const url = new URL(destinationUrl);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${label} URL must use http or https`);
  }

  if (options.allowPrivate) {
    return null;
  }

  if (isDisallowedAddress(url.hostname)) {
    throw new Error(`${label} destination resolves to a non-routable address`);
  }

  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new Error(`${label} destination could not be resolved`);
  }

  if (addresses.some((entry) => isDisallowedAddress(entry.address))) {
    throw new Error(`${label} destination resolves to a non-routable address`);
  }

  return addresses;
}

export async function assertPublicDestination(
  destinationUrl: string,
  label: string,
  options: PublicDestinationOptions = {},
): Promise<void> {
  await resolvePublicDestination(destinationUrl, label, options);
}

export function createPinnedLookup(addresses: LookupAddress[]): LookupFunction {
  let nextAddress = 0;

  return (_hostname, options, callback) => {
    const requestedFamily =
      typeof options === "number" ? options : options.family;
    const candidates = addresses.filter(
      (entry) => !requestedFamily || entry.family === requestedFamily,
    );

    if (candidates.length === 0) {
      const error = Object.assign(
        new Error("No validated address for family"),
        {
          code: "ENOTFOUND",
        },
      );
      callback(error, [], 0);
      return;
    }

    if (typeof options === "object" && options.all) {
      callback(null, candidates);
      return;
    }

    const address = candidates[nextAddress % candidates.length];
    nextAddress += 1;
    if (!address) {
      const error = Object.assign(
        new Error("No validated destination address"),
        {
          code: "ENOTFOUND",
        },
      );
      callback(error, [], 0);
      return;
    }
    callback(null, address.address, address.family);
  };
}

export async function fetchPublicDestination(
  destinationUrl: string,
  label: string,
  init: RequestInit = {},
  options: PublicDestinationOptions = {},
): Promise<Response> {
  const addresses = await resolvePublicDestination(
    destinationUrl,
    label,
    options,
  );

  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 0) {
    throw new Error(
      `${label} max response size must be a non-negative integer`,
    );
  }

  if (!addresses) {
    const response = await fetchWithDispatcher(destinationUrl, {
      ...init,
      redirect: "manual",
    });
    return copyBoundedResponse(response, label, maxResponseBytes);
  }

  // Bind the actual socket connection to the addresses validated above. A
  // second DNS lookup between validation and connect would permit rebinding.
  const dispatcher = new Agent({
    connect: { lookup: createPinnedLookup(addresses) },
  });

  try {
    const response = await fetchWithDispatcher(destinationUrl, {
      ...init,
      redirect: "manual",
      dispatcher,
    });
    return await copyBoundedResponse(response, label, maxResponseBytes);
  } finally {
    await dispatcher.close();
  }
}
