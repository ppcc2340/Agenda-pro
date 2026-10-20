#!/usr/bin/env node
/**
 * `pnpm demo` (PROTOTYPE.md, D-047): checks Postgres and Redis, migrates, seeds the demo workspace and starts
 * api, worker and web in fake mode with DEMO_MODE=1, printing the two URLs. One parent process; Ctrl-C stops all.
 * Flags: --dev (next dev instead of a production build), --build (rebuild the web app even if a build exists),
 * --reset (reseed from scratch), --no-seed, --public (listen on every interface instead of 127.0.0.1: the demo
 * signs anyone in as the demo user).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dev = args.includes("--dev");
// The demo signs every visitor in as demo@meri.local: keep it on this machine unless asked otherwise.
const host = args.includes("--public") ? "0.0.0.0" : "127.0.0.1";

function loadEnv() {
  const env = { ...process.env };
  for (const file of [".env", ".env.example"]) {
    const path = resolve(root, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const v = m[2].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "");
      if (!(m[1] in env) && v !== "") env[m[1]] = v;
    }
  }
  return env;
}

function canConnect(url, fallbackPort) {
  return new Promise((done) => {
    let host = "localhost";
    let port = fallbackPort;
    try {
      const u = new URL(url);
      host = u.hostname || host;
      port = Number(u.port) || port;
    } catch {
      /* keep the fallback */
    }
    const socket = net.createConnection({ host, port });
    const finish = (ok) => {
      socket.destroy();
      done(ok);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(2000, () => finish(false));
  });
}

const env = {
  ...loadEnv(),
  GOOGLE_MODE: "fake",
  AI_MODE: "fake",
  STRIPE_MODE: "fake",
  ANALYTICS_MODE: "noop",
  KMS_PROVIDER: "local",
  DEMO_MODE: "1",
  LISTEN_HOST: host,
  // One shared demo user drives the desktop and mobile E2E projects in parallel (local only, 127.0.0.1 by default).
  RATE_LIMIT_PER_MINUTE: "3000",
  APP_ENV: "development",
  ALLOW_FAKES_ON_PRODUCTION_BUILD: "1",
};
if (!env.DATABASE_URL || !env.REDIS_URL) {
  console.error("DATABASE_URL and REDIS_URL are required (copy .env.example to .env).");
  process.exit(1);
}
const [pg, redis] = await Promise.all([canConnect(env.DATABASE_URL, 5432), canConnect(env.REDIS_URL, 6379)]);
if (!pg || !redis) {
  console.error(`${pg ? "" : "Postgres"}${!pg && !redis ? " y " : ""}${redis ? "" : "Redis"} no responde. Arranca los servicios con:\n\n  docker compose up -d\n`);
  process.exit(1);
}

const run = (cmd, cmdArgs, extra = {}) => {
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: "inherit", env, ...extra });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run("pnpm", ["db:migrate"]);
if (!args.includes("--no-seed")) run("pnpm", ["demo:seed", ...(args.includes("--reset") ? ["--", "--reset"] : [])]);
if (!dev && (args.includes("--build") || !existsSync(resolve(root, "apps/web/.next/BUILD_ID"))))
  run("pnpm", ["--filter", "@meri/web", "build"]);

const children = [
  spawn("pnpm", ["--filter", "@meri/api", "exec", "tsx", "src/main.ts"], { cwd: root, stdio: "inherit", env }),
  spawn("pnpm", ["--filter", "@meri/worker", "exec", "tsx", "src/main.ts"], { cwd: root, stdio: "inherit", env }),
  spawn("pnpm", ["--filter", "@meri/web", dev ? "dev" : "start", "-H", host], { cwd: root, stdio: "inherit", env }),
];
const stop = () => {
  for (const c of children) if (!c.killed) c.kill("SIGTERM");
  setTimeout(() => process.exit(0), 500);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
// One process going down (an error exit or a signal) stops the demo: never leave half of it running.
for (const c of children)
  c.on("exit", (code, signal) => {
    if (code === 0) return;
    console.error(`a process stopped (${signal ?? `exit ${String(code)}`}); stopping the demo`);
    stop();
  });
setTimeout(() => {
  const shown = host === "127.0.0.1" ? "localhost" : "<esta-máquina>";
  console.log(`\nMeri (demo, adaptadores fake, usuario demo@meri.local, escuchando en ${host}):\n  Ordenador: http://${shown}:3000/\n  Móvil:     http://${shown}:3000/mobile  (o cualquier viewport ≤ 520 px)\n` + (env.DEMO_NOW ? `  Reloj:     DEMO_NOW=${env.DEMO_NOW}\n` : ""));
}, 4000);
