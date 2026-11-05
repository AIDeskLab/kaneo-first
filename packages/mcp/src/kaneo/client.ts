import type { AuthService } from "../auth/auth-service.js";
import { fetchUpstream, parseUpstreamJson } from "./upstream.js";

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export class KaneoClient {
  readonly baseUrl: string;
  private readonly auth: AuthService;

  constructor(options: { baseUrl: string; auth: AuthService }) {
    this.baseUrl = options.baseUrl;
    this.auth = options.auth;
  }

  get usingApiKey() {
    return this.auth.usingApiKey;
  }

  private async authorizedFetch(
    path: string,
    init?: RequestInit,
    didRetry = false,
  ): Promise<Response> {
    const token = await this.auth.getAccessToken();
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (init?.body != null && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const res = await fetchUpstream(url, path, init, headers);

    // With a static API key there is nothing to refresh, so surface the 401
    // instead of looping back into the interactive device flow.
    if (res.status === 401 && !didRetry && !this.auth.usingApiKey) {
      await this.auth.clearToken();
      return this.authorizedFetch(path, init, true);
    }

    return res;
  }

  async json<T = Json>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.authorizedFetch(path, init);
    return parseUpstreamJson<T>(res, path);
  }
}
