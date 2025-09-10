import { mkdir, writeFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

type JsonRecord = Record<string, unknown>;

type ManagedProcessState =
  | { status: "running"; pid: number; startedAt: number }
  | {
      status: "exited";
      startedAt: number;
      exitedAt: number;
      exitCode: number | null;
      signal: string | null;
    };

type ManagedProcessMeta = {
  id: string;
  binaryPath: string;
  configPath: string;
  workDir: string;
  args: string[];
  env: Record<string, string>;
  state: ManagedProcessState;
  logBuffer: RingBuffer;
};

class RingBuffer {
  private readonly capacity: number;
  private buffer: string[];
  private index: number;
  private filled: boolean;

  constructor(capacity: number) {
    this.capacity = Math.max(10, Math.min(capacity, 10000));
    this.buffer = new Array(this.capacity);
    this.index = 0;
    this.filled = false;
  }

  push(line: string) {
    this.buffer[this.index] = line;
    this.index = (this.index + 1) % this.capacity;
    if (this.index === 0) this.filled = true;
  }

  toArray(limit?: number): string[] {
    const data = this.filled
      ? [...this.buffer.slice(this.index), ...this.buffer.slice(0, this.index)]
      : this.buffer.slice(0, this.index);
    if (typeof limit === "number" && limit > 0) {
      return data.slice(Math.max(0, data.length - limit));
    }
    return data;
  }
}

class FrpsManager {
  private readonly processes = new Map<string, ManagedProcessMeta>();
  private readonly runtimeRoot: string;

  constructor(runtimeRoot: string) {
    this.runtimeRoot = runtimeRoot;
  }

  list(): Array<ManagedProcessMeta> {
    return [...this.processes.values()].map((p) => ({ ...p }));
  }

  get(id: string): ManagedProcessMeta | undefined {
    return this.processes.get(id);
  }

  async stop(
    id: string,
    options?: { force?: boolean; timeoutMs?: number }
  ): Promise<boolean> {
    const meta = this.processes.get(id);
    if (!meta) return false;

    if (meta.state.status !== "running") {
      return true;
    }

    const { force = false, timeoutMs = 3000 } = options ?? {};
    try {
      // Send SIGTERM first
      process.kill(meta.state.pid, "SIGTERM");
    } catch {}

    const startWait = Date.now();
    while (Date.now() - startWait < timeoutMs) {
      const current = this.processes.get(id);
      if (!current || current.state.status === "exited") break;
      await Bun.sleep(50);
    }

    const current = this.processes.get(id);
    if (current && current.state.status === "running" && force) {
      try {
        process.kill(current.state.pid, "SIGKILL");
      } catch {}
    }

    return true;
  }

  async create(input: {
    id?: string;
    binaryPath?: string;
    configToml?: string;
    config?: JsonRecord;
    env?: Record<string, string>;
    args?: string[];
    logLines?: number;
    replaceIfExists?: boolean;
  }): Promise<ManagedProcessMeta> {
    const id = input.id ?? crypto.randomUUID();

    if (this.processes.has(id)) {
      if (input.replaceIfExists) {
        await this.stop(id, { force: true, timeoutMs: 1000 });
      } else {
        throw new HttpError(409, `frps with id ${id} already exists`);
      }
    }

    const binaryPath = input.binaryPath ?? "frps";
    await assertBinaryExists(binaryPath);

    const workDir = path.join(this.runtimeRoot, `frps-${id}`);
    await mkdir(workDir, { recursive: true });

    const configPath = path.join(workDir, "frps.toml");
    if (input.configToml) {
      await writeFile(configPath, input.configToml, "utf8");
    } else {
      const configToml = generateToml(input.config ?? {});
      await writeFile(configPath, configToml, "utf8");
    }

    const args =
      input.args && input.args.length > 0 ? input.args : ["-c", configPath];
    const env = { ...process.env, ...(input.env ?? {}) } as Record<
      string,
      string
    >;

    const child = Bun.spawn([binaryPath, ...args], {
      cwd: workDir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const logBuffer = new RingBuffer(input.logLines ?? 1000);
    const startedAt = Date.now();

    const meta: ManagedProcessMeta = {
      id,
      binaryPath,
      configPath,
      workDir,
      args,
      env,
      state: { status: "running", pid: child.pid, startedAt },
      logBuffer,
    };
    this.processes.set(id, meta);

    // Stream logs
    void streamLines(child.stdout, (line) =>
      logBuffer.push(`[stdout] ${line}`)
    );
    void streamLines(child.stderr, (line) =>
      logBuffer.push(`[stderr] ${line}`)
    );

    // Track exit
    child.exited.then(() => {
      const exitedAt = Date.now();
      const exitCode = child.exitCode;
      const prev = this.processes.get(id);
      if (!prev) return;
      prev.state = {
        status: "exited",
        startedAt,
        exitedAt,
        exitCode,
        signal: null,
      };
    });

    return meta;
  }
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function streamLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void
) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      onLine(line);
      buf = buf.slice(idx + 1);
    }
  }
  if (buf) onLine(buf);
}

function generateToml(config: JsonRecord): string {
  // Minimal best-effort TOML generator for flat objects and simple nested tables.
  // For production, users can pass configToml for full fidelity.
  const lines: string[] = [];
  const flatEntries: [string, unknown][] = [];
  const tables: Record<string, Record<string, unknown>> = {};

  for (const [key, value] of Object.entries(config)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      tables[key] = value as Record<string, unknown>;
    } else {
      flatEntries.push([key, value]);
    }
  }

  for (const [k, v] of flatEntries) {
    lines.push(`${k} = ${tomlValue(v)}`);
  }
  for (const [tbl, obj] of Object.entries(tables)) {
    lines.push("");
    lines.push(`[${tbl}]`);
    for (const [k, v] of Object.entries(obj)) {
      lines.push(`${k} = ${tomlValue(v)}`);
    }
  }

  return lines.join("\n") + "\n";
}

function tomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (value && typeof value === "object") {
    return `{ ${Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k} = ${tomlValue(v)}`)
      .join(", ")} }`;
  }
  return "null";
}

async function assertBinaryExists(binaryPath: string) {
  // If absolute/relative path provided
  if (binaryPath.includes("/") || binaryPath.includes("\\")) {
    try {
      await stat(binaryPath);
      return;
    } catch {
      throw new HttpError(400, `binary not found at path: ${binaryPath}`);
    }
  }
  // Resolve from PATH using `which` via Bun.which when available
  const resolved = Bun.which(binaryPath);
  if (!resolved)
    throw new HttpError(400, `binary not found in PATH: ${binaryPath}`);
}

function requireAuth(req: Request, apiSecret: string) {
  const auth =
    req.headers.get("authorization") || req.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer "))
    throw new HttpError(401, "missing bearer token");
  const token = auth.slice("Bearer ".length).trim();
  if (token !== apiSecret) throw new HttpError(403, "invalid token");
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

function readJson(req: Request): Promise<any> {
  return req.json().catch(() => {
    throw new HttpError(400, "invalid JSON body");
  });
}

async function ensureRuntimeDir(): Promise<string> {
  const root = path.join(process.cwd(), "runtime");
  if (!existsSync(root)) await mkdir(root, { recursive: true });
  return root;
}

const apiSecret = process.env.API_SECRET;
if (!apiSecret) {
  console.error("ERROR: API_SECRET is not set. Refusing to start.");
  process.exit(1);
}

const runtimeRoot = await ensureRuntimeDir();
const manager = new FrpsManager(runtimeRoot);

// Graceful shutdown of all managed processes
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal as NodeJS.Signals, async () => {
    console.log(`Received ${signal}, stopping managed frps processes...`);
    const ids = manager.list().map((p) => p.id);
    await Promise.all(ids.map((id) => manager.stop(id, { force: true })));
    process.exit(0);
  });
}

const server = Bun.serve({
  port: Number(process.env.PORT || 3000),
  fetch: async (req) => {
    try {
      const url = parseUrl(req);
      if (url.pathname === "/healthz") return textResponse("ok");

      // Authenticate all other endpoints
      requireAuth(req, apiSecret);

      if (req.method === "GET" && url.pathname === "/frps") {
        const list = manager.list().map((p) => serializeMeta(p));
        return jsonResponse(list);
      }

      if (req.method === "POST" && url.pathname === "/frps") {
        const body = await readJson(req);
        const meta = await manager.create(validateCreateBody(body));
        return jsonResponse(serializeMeta(meta), { status: 201 });
      }

      // /frps/:id and /frps/:id/logs
      const frpsMatch = url.pathname.match(/^\/frps\/([^\/]+)(?:\/(logs))?$/);
      if (frpsMatch) {
        const id = decodeURIComponent(frpsMatch[1]!);
        const sub = frpsMatch[2];
        const meta = manager.get(id);
        if (!meta) throw new HttpError(404, "not found");

        if (!sub) {
          if (req.method === "GET") {
            return jsonResponse(serializeMeta(meta));
          }
          if (req.method === "DELETE") {
            const force = url.searchParams.get("force") === "true";
            const timeoutMs = Number(url.searchParams.get("timeoutMs") || 3000);
            await manager.stop(id, { force, timeoutMs });
            return jsonResponse({ ok: true });
          }
        } else if (sub === "logs") {
          if (req.method === "GET") {
            const n = url.searchParams.get("n");
            const limit = n
              ? Math.max(1, Math.min(10000, Number(n)))
              : undefined;
            const lines = meta.logBuffer.toArray(limit);
            return textResponse(lines.join("\n"));
          }
        }
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
  `frps management server listening on http://localhost:${server.port}`
);

function serializeMeta(p: ManagedProcessMeta) {
  return {
    id: p.id,
    binaryPath: p.binaryPath,
    configPath: p.configPath,
    workDir: p.workDir,
    args: p.args,
    envKeys: Object.keys(p.env),
    state: p.state,
  };
}

function validateCreateBody(body: any) {
  if (!body || typeof body !== "object")
    throw new HttpError(400, "body must be object");
  const out: any = {};
  if (body.id !== undefined) {
    if (typeof body.id !== "string" || !body.id)
      throw new HttpError(400, "id must be non-empty string");
    out.id = body.id;
  }
  if (body.binaryPath !== undefined) {
    if (typeof body.binaryPath !== "string" || !body.binaryPath)
      throw new HttpError(400, "binaryPath must be string");
    out.binaryPath = body.binaryPath;
  }
  if (body.configToml !== undefined) {
    if (typeof body.configToml !== "string" || !body.configToml)
      throw new HttpError(400, "configToml must be string");
    out.configToml = body.configToml;
  }
  if (body.config !== undefined) {
    if (typeof body.config !== "object")
      throw new HttpError(400, "config must be object");
    out.config = body.config;
  }
  if (body.env !== undefined) {
    if (typeof body.env !== "object")
      throw new HttpError(400, "env must be object");
    out.env = body.env;
  }
  if (body.args !== undefined) {
    if (
      !Array.isArray(body.args) ||
      !body.args.every((v: any) => typeof v === "string")
    )
      throw new HttpError(400, "args must be string[]");
    out.args = body.args;
  }
  if (body.logLines !== undefined) {
    const n = Number(body.logLines);
    if (!Number.isFinite(n) || n < 10)
      throw new HttpError(400, "logLines must be number >= 10");
    out.logLines = Math.floor(n);
  }
  if (body.replaceIfExists !== undefined) {
    out.replaceIfExists = Boolean(body.replaceIfExists);
  }
  if (!out.configToml && !out.config) {
    // Provide a minimal default to avoid starting frps without required ports
    throw new HttpError(400, "either configToml or config must be provided");
  }
  return out;
}
