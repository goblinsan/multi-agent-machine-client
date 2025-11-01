import { fetch } from "undici";
import { logger } from "../logger.js";
import { cfg } from "../config.js";


export class DashboardClient {
  protected readonly baseUrl: string;
  protected readonly apiKey: string;

  constructor() {
    this.baseUrl = cfg.dashboardBaseUrl?.replace(/\/$/, "") || "";
    this.apiKey = cfg.dashboardApiKey || "";
  }

  
  protected async request<T = any>(
    path: string,
    options: {
      method?: string;
      body?: any;
      headers?: Record<string, string>;
    } = {}
  ): Promise<{ ok: boolean; status: number; data: T | null; error?: any }> {
    if (!this.baseUrl) {
      logger.warn("dashboard request skipped: base URL not configured");
      return { ok: false, status: 0, data: null };
    }

    const { method = "GET", body, headers = {} } = options;
    const url = `${this.baseUrl}${path}`;

    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      const status = res.status;
      let data: any = null;

      try {
        const text = await res.text();
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }

      if (!res.ok) {
        logger.warn("dashboard request failed", { url, status, method, response: data });
        return { ok: false, status, data, error: data };
      }

      return { ok: true, status, data };
    } catch (error) {
      logger.warn("dashboard request exception", { url, method, error: (error as Error).message });
      return { ok: false, status: 0, data: null, error };
    }
  }

  
  protected async get<T = any>(path: string): Promise<T | null> {
    const { ok, data } = await this.request<T>(path, { method: "GET" });
    return ok ? data : null;
  }

  
  protected async post<T = any>(path: string, body?: any): Promise<{ ok: boolean; status: number; data: T | null; error?: any }> {
    return this.request<T>(path, { method: "POST", body });
  }

  
  protected async patch<T = any>(path: string, body?: any): Promise<{ ok: boolean; status: number; data: T | null; error?: any }> {
    return this.request<T>(path, { method: "PATCH", body });
  }
}
