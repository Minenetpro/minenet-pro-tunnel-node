type JsonRecord = Record<string, unknown>;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function textResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    headers: { "content-type": "text/plain" },
    ...init,
  });
}

function parseUrl(req: Request): URL {
  return new URL(req.url);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function requireAuth(req: Request, apiSecret: string) {
  const auth =
    req.headers.get("authorization") || req.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer "))
    throw new HttpError(401, "missing bearer token");
  const token = auth.slice("Bearer ".length).trim();
  if (!timingSafeEqual(token, apiSecret))
    throw new HttpError(403, "invalid token");
}

async function readJson(req: Request): Promise<any> {
  return req.json().catch(() => {
    throw new HttpError(400, "invalid JSON body");
  });
}

type CreateProxyBody = {
  id?: string;
  server: string;
  hosts: string[] | string;
  upstreams: string[];
  terminal?: boolean;
};

function validateCreateProxyBody(body: any): CreateProxyBody {
  if (!body || typeof body !== "object")
    throw new HttpError(400, "body must be object");
  const out: CreateProxyBody = {
    id: undefined,
    server: "",
    hosts: [],
    upstreams: [],
    terminal: true,
  };
  if (body.id !== undefined) {
    if (typeof body.id !== "string" || !body.id)
      throw new HttpError(400, "id must be non-empty string");
    out.id = body.id;
  }
  if (typeof body.server !== "string" || !body.server)
    throw new HttpError(400, "server must be non-empty string");
  out.server = body.server;

  if (Array.isArray(body.hosts)) {
    if (!body.hosts.every((h: unknown) => typeof h === "string" && h))
      throw new HttpError(400, "hosts must be non-empty string[]");
    out.hosts = body.hosts;
  } else if (typeof body.hosts === "string" && body.hosts) {
    out.hosts = [body.hosts];
  } else {
    throw new HttpError(400, "hosts must be string or string[]");
  }

  if (!Array.isArray(body.upstreams) || body.upstreams.length === 0)
    throw new HttpError(400, "upstreams must be non-empty string[]");
  if (!body.upstreams.every((u: any) => typeof u === "string" && u))
    throw new HttpError(400, "upstreams must be non-empty string[]");
  out.upstreams = body.upstreams;

  if (body.terminal !== undefined) out.terminal = Boolean(body.terminal);

  return out;
}

class CaddyClient {
  private readonly baseUrl: string;
  private readonly adminToken: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, adminToken: string, timeoutMs = 3000) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.adminToken = adminToken;
    this.timeoutMs = timeoutMs;
  }

  private async fetchJson(
    path: string,
    init?: RequestInit & { expect?: number | number[] }
  ) {
    const res = await this.fetch(path, init);
    const expect = init?.expect;
    if (expect) {
      const expected = Array.isArray(expect) ? expect : [expect];
      if (!expected.includes(res.status)) {
        const text = await res.text().catch(() => "");
        throw new HttpError(res.status, text || `caddy error ${res.status}`);
      }
    }
    const text = await res.text();
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return text as unknown as JsonRecord;
    }
  }

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.adminToken}`,
          "content-type": "application/json",
          ...(init?.headers || {}),
        },
        signal: controller.signal,
      });
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  async getHttpServers(): Promise<Record<string, any>> {
    const res = await this.fetch("/config/apps/http/servers");
    if (res.status === 404) return {};
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      throw new HttpError(res.status, msg || "failed to read caddy servers");
    }
    return (await res.json()) as Record<string, any>;
  }

  async getHttpServer(name: string): Promise<any | null> {
    const res = await this.fetch(
      `/config/apps/http/servers/${encodeURIComponent(name)}`
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      throw new HttpError(
        res.status,
        msg || `failed to read caddy server ${name}`
      );
    }
    return await res.json();
  }

  async ensureRoutesArray(name: string): Promise<void> {
    const server = await this.getHttpServer(name);
    if (!server) {
      throw new HttpError(400, `caddy http server '${name}' not found`);
    }
    const hasArray = Array.isArray(server.routes);
    if (!hasArray) {
      const putRes = await this.fetch(
        `/config/apps/http/servers/${encodeURIComponent(name)}/routes`,
        { method: "PUT", body: JSON.stringify([]) }
      );
      if (!putRes.ok) {
        const text = await putRes.text().catch(() => "");
        throw new HttpError(
          putRes.status,
          text || `failed to init routes for server '${name}'`
        );
      }
    }
  }

  async listReverseProxies(targetServer?: string) {
    const servers = await this.getHttpServers();
    const items: Array<{
      id?: string;
      server: string;
      hosts?: string[];
      upstreams?: string[];
      route?: any;
    }> = [];
    for (const [serverName, serverCfg] of Object.entries(servers)) {
      if (targetServer && serverName !== targetServer) continue;
      const routes: any[] = Array.isArray((serverCfg as any).routes)
        ? (serverCfg as any).routes
        : [];
      for (const route of routes) {
        const handles: any[] = Array.isArray(route.handle) ? route.handle : [];
        for (const h of handles) {
          if (h && h.handler === "reverse_proxy") {
            const id: string | undefined = route["@id"];
            const hosts: string[] | undefined = Array.isArray(route.match)
              ? route.match.flatMap((m: any) =>
                  Array.isArray(m.host) ? m.host : []
                )
              : undefined;
            const upstreams: string[] | undefined = Array.isArray(h.upstreams)
              ? h.upstreams
                  .map((u: any) =>
                    typeof u?.dial === "string" ? u.dial : undefined
                  )
                  .filter((v: any) => typeof v === "string")
              : undefined;
            items.push({ id, server: serverName, hosts, upstreams, route });
          }
        }
      }
    }
    return items;
  }

  async createReverseProxy(input: CreateProxyBody) {
    await this.ensureRoutesArray(input.server);
    const route = {
      "@id": input.id ?? `rp-${crypto.randomUUID()}`,
      match: [
        {
          host: Array.isArray(input.hosts) ? input.hosts : [input.hosts],
        },
      ],
      handle: [
        {
          handler: "reverse_proxy",
          upstreams: input.upstreams.map((dial) => ({ dial })),
        },
      ],
      terminal: input.terminal ?? true,
    };

    // Append route to server routes
    await this.fetchJson(
      `/config/apps/http/servers/${encodeURIComponent(input.server)}/routes`,
      {
        method: "POST",
        body: JSON.stringify(route),
        expect: [200, 201],
      }
    );
    return route;
  }

  async deleteById(id: string): Promise<boolean> {
    const res = await this.fetch(`/id/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (res.status === 404) return false;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new HttpError(res.status, text || "failed to delete");
    }
    return true;
  }
}

const caddyToken = process.env.CADDY_API_SECRET;
if (!caddyToken) {
  console.error("ERROR: CADDY_API_SECRET is not set. Refusing to start.");
  process.exit(1);
}

const caddyUrl = process.env.CADDY_API_URL || "http://127.0.0.1:2019";
const caddy = new CaddyClient(caddyUrl, caddyToken);

const server = Bun.serve({
  hostname: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 3001),
  fetch: async (req) => {
    try {
      const url = parseUrl(req);
      if (url.pathname === "/healthz") return textResponse("ok");

      // API is protected by the same CADDY_API_SECRET
      requireAuth(req, caddyToken);

      // GET /proxies?server=srv0
      if (req.method === "GET" && url.pathname === "/proxies") {
        const serverName = url.searchParams.get("server") || undefined;
        const list = await caddy.listReverseProxies(serverName || undefined);
        return jsonResponse(list);
      }

      // POST /proxies
      if (req.method === "POST" && url.pathname === "/proxies") {
        const body = validateCreateProxyBody(await readJson(req));
        const route = await caddy.createReverseProxy(body);
        return jsonResponse({ ok: true, route }, { status: 201 });
      }

      // DELETE /proxies/:id
      const delMatch = url.pathname.match(/^\/proxies\/([^\/]+)$/);
      if (req.method === "DELETE" && delMatch) {
        const id = decodeURIComponent(delMatch[1]!);
        const deleted = await caddy.deleteById(id);
        if (!deleted) throw new HttpError(404, "not found");
        return jsonResponse({ ok: true });
      }

      return jsonResponse({ error: "not found" }, { status: 404 });
    } catch (e) {
      if (e instanceof HttpError) {
        return jsonResponse({ error: e.message }, { status: e.status });
      }
      console.error(e);
      return jsonResponse({ error: "internal error" }, { status: 500 });
    }
  },
});

console.log(
  `caddy manager listening on http://localhost:${server.port} (admin: ${caddyUrl})`
);
