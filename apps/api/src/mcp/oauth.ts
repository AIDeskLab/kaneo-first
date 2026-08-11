import { createHash, randomUUID } from "node:crypto";
import { createId } from "@paralleldrive/cuid2";
import db from "../database";
import { sessionTable } from "../database/schema";
import {
  consumeFixedWindowRateLimits,
  consumeState,
  getState,
  putAuthorizationRequestWithCaps,
  putStateWithCap,
} from "./oauth-store";

type RegisteredClient = {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
  issuedAt: number;
};

type AuthCode = {
  clientId: string;
  userId: string;
  codeChallenge: string;
  redirectUri: string;
};

export type AuthorizationRequest = {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  state?: string;
};

// Clients re-register on invalid_client, so the TTL only bounds table growth.
const clientTtlMs = 30 * 24 * 60 * 60 * 1000;
const codeTtlMs = 5 * 60 * 1000;
const requestTtlMs = 10 * 60 * 1000;
// Same bound the in-memory store enforced; authorize is reachable without a session.
const maxAuthorizationRequests = 10_000;
const maxAuthorizationRequestsPerClient = 100;
const maxRegisteredClients = 10_000;
// Codes are short-lived, but the cap also bounds live, abandoned grants.
const maxAuthorizationCodes = 10_000;
const clientRegistrationWindowMs = 60_000;

const clientRegistrationGlobalLimit = 600;
const authorizationSourceLimit = 120;
const authorizationClientLimit = 300;
const authorizationGlobalLimit = 3_000;

export async function consumeClientRegistrationRateLimits(source: string) {
  return consumeFixedWindowRateLimits([
    {
      key: `client-registration:source:${source}`,
      maxRequests: 20,
      windowMs: clientRegistrationWindowMs,
    },
    {
      key: "client-registration:global",
      maxRequests: clientRegistrationGlobalLimit,
      windowMs: clientRegistrationWindowMs,
    },
  ]);
}

export async function consumeAuthorizationRateLimits(
  source: string,
  clientId: string,
) {
  return consumeFixedWindowRateLimits([
    {
      key: `authorization:source:${source}`,
      maxRequests: authorizationSourceLimit,
      windowMs: 60_000,
    },
    {
      key: `authorization:client:${clientId}`,
      maxRequests: authorizationClientLimit,
      windowMs: 60_000,
    },
    {
      key: "authorization:global",
      maxRequests: authorizationGlobalLimit,
      windowMs: 60_000,
    },
  ]);
}

export async function getClient(
  clientId: string,
): Promise<RegisteredClient | null> {
  return getState<RegisteredClient>("client", clientId);
}

export async function registerClient(params: {
  redirectUris: string[];
  clientName?: string;
}): Promise<RegisteredClient> {
  const clientId = randomUUID();
  const client: RegisteredClient = {
    clientId,
    redirectUris: [...params.redirectUris],
    clientName: params.clientName,
    issuedAt: Math.floor(Date.now() / 1000),
  };
  await putStateWithCap(
    "client",
    clientId,
    client,
    new Date(Date.now() + clientTtlMs),
    maxRegisteredClients,
  );
  return client;
}

export async function createAuthCode(params: AuthCode): Promise<string> {
  const code = randomUUID();
  await putStateWithCap(
    "code",
    code,
    params,
    new Date(Date.now() + codeTtlMs),
    maxAuthorizationCodes,
  );
  return code;
}

export async function createAuthorizationRequest(
  params: AuthorizationRequest,
): Promise<string> {
  const requestId = randomUUID();
  await putAuthorizationRequestWithCaps(
    requestId,
    params,
    new Date(Date.now() + requestTtlMs),
    maxAuthorizationRequests,
    maxAuthorizationRequestsPerClient,
  );
  return requestId;
}

export async function getAuthorizationRequest(
  requestId: string,
): Promise<AuthorizationRequest | null> {
  return getState<AuthorizationRequest>("request", requestId);
}

export async function consumeAuthorizationRequest(
  requestId: string,
): Promise<AuthorizationRequest | null> {
  return consumeState<AuthorizationRequest>("request", requestId);
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  const hash = createHash("sha256").update(codeVerifier).digest();
  return base64url(hash) === codeChallenge;
}

export async function exchangeCode(
  code: string,
  clientId: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<{ accessToken: string; expiresIn: number } | null> {
  const stored = await consumeState<AuthCode>("code", code);
  if (!stored) return null;

  if (stored.clientId !== clientId) return null;
  if (stored.redirectUri !== redirectUri) return null;
  if (!verifyPkce(codeVerifier, stored.codeChallenge)) return null;

  const sessionToken = randomUUID();
  const expiresIn = 30 * 24 * 60 * 60;

  await db.insert(sessionTable).values({
    id: createId(),
    token: sessionToken,
    userId: stored.userId,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return { accessToken: sessionToken, expiresIn };
}
