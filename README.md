# Minenet.pro frps management server

A lightweight, production-ready REST API to manage `frps` (FRP server) processes: create, list, inspect, stream logs, and terminate. Secured with Bearer auth using `API_SECRET`.

FRP repo: [fatedier/frp](https://github.com/fatedier/frp)

## Prerequisites

- Bun v1.0+
- `frps` binary installed and available on `PATH`, or provide an absolute path per request. See the official releases: [`fatedier/frp` releases](https://github.com/fatedier/frp).

## Quick start

```bash
bun install
API_SECRET=change-me PORT=3000 bun run index.ts
```

Health check:

```bash
curl -s http://localhost:3000/healthz
```

All API endpoints (except `/healthz`) require a Bearer token:

```bash
curl -H 'Authorization: Bearer change-me' http://localhost:3000/frps
```

## API

All responses are JSON unless otherwise noted.

- Authorization: `Authorization: Bearer <API_SECRET>`

### GET /frps

List all managed `frps` processes.

Response 200:

```json
[
  {
    "id": "abc123",
    "binaryPath": "/usr/local/bin/frps",
    "configPath": "/.../runtime/frps-abc123/frps.toml",
    "workDir": "/.../runtime/frps-abc123",
    "args": ["-c", "/.../frps.toml"],
    "envKeys": ["PATH", "HOME", "..."],
    "state": { "status": "running", "pid": 12345, "startedAt": 1700000000000 }
  }
]
```

### POST /frps

Create and start an `frps` process.

Body (one of `configToml` OR `config` is required):

```json
{
  "id": "optional-custom-id",
  "binaryPath": "optional path to frps (default: 'frps' on PATH)",
  "configToml": "TOML string (preferred)",
  "config": { "bindPort": 7000, "dashboardPort": 7500 },
  "env": { "FOO": "bar" },
  "args": ["-c", "override.toml"],
  "logLines": 2000,
  "replaceIfExists": false
}
```

Notes:

- Prefer `configToml` to pass full `frps.toml` for exact parity with upstream docs.
- If only `config` is provided, the server generates a minimal TOML (flat and simple nested tables only).
- Default args are `-c <generated-config-path>` unless `args` provided.

Responses:

- 201 with process metadata on success
- 400 if validation fails or binary not found
- 409 if `id` already exists and `replaceIfExists` is false

### GET /frps/:id

Inspect one `frps` process.

### DELETE /frps/:id?force=true&timeoutMs=3000

Stop an `frps` process. Sends SIGTERM, then optionally SIGKILL if `force=true` and still running after `timeoutMs`.

### GET /frps/:id/logs?n=1000 (text/plain)

Return the latest N lines from the in-memory logs buffer (stdout/stderr).

## Operational notes

- The server writes configs to `runtime/frps-<id>/frps.toml`.
- On SIGINT/SIGTERM, all managed processes are terminated.
- Ensure your `frps.toml` aligns with upstream features like tcpmux, HTTP routing, etc. See `frp` docs: [`fatedier/frp`](https://github.com/fatedier/frp).

## Example

Create with TOML:

```bash
curl -X POST http://localhost:3000/frps \
  -H 'Authorization: Bearer change-me' \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "demo",
    "configToml": "bindPort = 7000\n",
    "logLines": 2000
  }'
```

Fetch logs:

```bash
curl -s http://localhost:3000/frps/demo/logs?n=200 \
  -H 'Authorization: Bearer change-me'
```

Stop:

```bash
curl -X DELETE 'http://localhost:3000/frps/demo?force=true&timeoutMs=2000' \
  -H 'Authorization: Bearer change-me'
```
