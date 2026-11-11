// Shared adapter for `actor` (actor SQLite) and `actor-pg` (Postgres log). The runner is a
// local process; the Rivet engine and Postgres come from the repo's docker-compose.yml.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const CRATE = dirname(fileURLToPath(import.meta.url));
const REPO = join(CRATE, '..', '..');
const BIN = join(CRATE, 'target', 'release', 'collab-actor');
const RUN = join(CRATE, '.run');
const ENGINE = process.env.RIVET_ENGINE ?? 'http://127.0.0.1:6420';
const TOKEN = process.env.RIVET_TOKEN ?? 'bakeoff-dev-token';
const NAMESPACE = 'default';
const PG_URL = 'postgres://bakeoff:bakeoff@127.0.0.1:55442/bakeoff';

const MODES = {
  sqlite: { actor: 'doc_sqlite', pool: 'actor-sqlite', services: ['rivet'] },
  pg: { actor: 'doc_pg', pool: 'actor-pg', services: ['rivet', 'postgres'] },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function compose(...args) {
  return execFileSync('docker', ['compose', ...args], { cwd: REPO, encoding: 'utf8' });
}

function psql(sql) {
  return compose('exec', '-T', 'postgres', 'psql', '-U', 'bakeoff', '-d', 'bakeoff', '-tAc', sql).trim();
}

async function retry(what, fn, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (Date.now() > end) throw new Error(`${what}: ${e.message}`);
      await sleep(250);
    }
  }
}

export function makeAdapter(mode, name) {
  const m = MODES[mode];
  const pidFile = join(RUN, `${mode}.pid`);
  let nonce = process.env.BAKEOFF_ACTOR_NONCE ?? Date.now().toString(36);
  let prepared = [];
  const key = (projectId) => `${projectId}~${nonce}`;

  const gateway = (projectId, path) => {
    const q = new URLSearchParams({
      'rvt-namespace': NAMESPACE,
      'rvt-method': 'getOrCreate',
      'rvt-key': key(projectId),
      'rvt-runner': m.pool,
      'rvt-crash-policy': 'sleep',
      'rvt-token': TOKEN,
    });
    return `${ENGINE}/gateway/${m.actor}${path}?${q}`;
  };

  const pid = () => {
    if (!existsSync(pidFile)) return null;
    const p = Number(readFileSync(pidFile, 'utf8'));
    try {
      process.kill(p, 0);
      return p;
    } catch {
      return null;
    }
  };

  async function start() {
    mkdirSync(RUN, { recursive: true });
    const log = openSync(join(RUN, `${mode}.log`), 'a');
    const child = spawn(BIN, [], {
      detached: true,
      stdio: ['ignore', log, log],
      env: {
        ...process.env,
        COLLAB_STORE: mode,
        RIVET_ENDPOINT: ENGINE,
        RIVET_TOKEN: TOKEN,
        RIVET_NAMESPACE: NAMESPACE,
        RIVET_POOL: m.pool,
        RIVETKIT_ENGINE_SPAWN: 'never',
        DATABASE_URL: PG_URL,
        RUST_LOG: process.env.RUST_LOG ?? 'info',
      },
    });
    child.unref();
    writeFileSync(pidFile, String(child.pid));
    await waitReady();
  }

  // A runner is ready once a fresh actor on it answers a WebSocket with sync step 1.
  async function waitReady() {
    const probe = `__probe_${Date.now().toString(36)}`;
    await retry('runner not ready', () => new Promise((resolve, reject) => {
      const { url, protocols } = adapter.connect(probe);
      const ws = new WebSocket(url, protocols);
      const t = setTimeout(() => { ws.terminate(); reject(new Error('timeout')); }, 3000);
      ws.on('message', () => { clearTimeout(t); ws.close(); resolve(); });
      ws.on('error', (e) => { clearTimeout(t); reject(e); });
      ws.on('close', (code) => { clearTimeout(t); reject(new Error(`closed ${code}`)); });
    }), 120_000);
  }

  async function stop(signal) {
    const p = pid();
    if (!p) return;
    process.kill(p, signal);
    await retry('runner did not exit', async () => {
      if (pid()) throw new Error('alive');
    }, 60_000);
    rmSync(pidFile, { force: true });
  }

  const adapter = {
    name,
    ack: true,

    async up() {
      compose('up', '-d', ...m.services);
      await retry('engine health', async () => {
        const r = await fetch(`${ENGINE}/health`);
        if (!r.ok) throw new Error(String(r.status));
      });
      await retry('create pool', async () => {
        const r = await fetch(`${ENGINE}/pools/${m.pool}?namespace=${NAMESPACE}`, {
          method: 'PUT',
          headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
          body: '{}',
        });
        if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      });
      if (mode === 'pg') await retry('postgres', async () => psql('SELECT 1'));
      if (!existsSync(BIN)) {
        execFileSync('cargo', ['build', '--release'], { cwd: CRATE, stdio: 'inherit' });
      }
      if (!pid()) await start();
    },

    // Fresh actor keys per prepare, so every project starts empty; pg also drops old rows.
    async prepare(projectIds) {
      nonce = process.env.BAKEOFF_ACTOR_NONCE ?? Date.now().toString(36);
      prepared = [...projectIds];
      if (mode === 'pg') psql('TRUNCATE doc_updates, doc_snapshots');
    },

    connect(projectId) {
      return { url: gateway(projectId, '/websocket/').replace(/^http/, 'ws'), protocols: ['rivet'], headers: {} };
    },

    async restart() {
      await stop('SIGTERM');
      await start();
    },

    async kill() {
      await stop('SIGKILL');
      await start();
    },

    // Logical bytes of the update log + snapshots for the prepared projects.
    async storageBytes() {
      if (mode === 'pg') {
        return Number(psql(`SELECT (SELECT coalesce(sum(octet_length("update")),0) FROM doc_updates)
                                  + (SELECT coalesce(sum(octet_length(state)),0) FROM doc_snapshots)`));
      }
      let total = 0;
      for (const p of prepared) {
        const r = await fetch(gateway(p, '/request/stats'));
        if (!r.ok) throw new Error(`stats ${p}: ${r.status} ${await r.text()}`);
        total += (await r.json()).bytes;
      }
      return total;
    },
  };
  return adapter;
}
