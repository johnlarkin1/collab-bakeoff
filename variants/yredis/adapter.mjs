// yredis: upstream yjs/y-redis (@y/redis 0.1.6, AGPL) as the multi-writer baseline.
// Installed from npm into variants/yredis/node_modules only; never vendored. Runs on the host:
// auth server, one y-redis server, one worker. Redis and MinIO come from variants/yredis/compose.yml.
// Rebar's own fork (y-redis-server) is not run here: it is wired to real AWS (DynamoDB, Lambda, Mongo).
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ecdsa from 'lib0/crypto/ecdsa'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.join(DIR, 'node_modules/@y/redis')
const RUN = path.join(DIR, '../../out/yredis')
const PORT = 3102
// uws v20.40.0 (pinned by @y/redis 0.1.6) ships binaries up to Node 20 (ABI 115). Prd y-redis also runs Node 20.
const NODE20 = process.env.NODE20 ?? path.join(process.env.HOME, '.nvm/versions/node/v20.20.2/bin/node')
const AUTH = 'http://localhost:5173'
const procs = {}

async function keys() {
  const f = path.join(RUN, 'keys.json')
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'))
  const kp = await ecdsa.generateKeyPair({ extractable: true })
  const k = { pub: JSON.stringify(await ecdsa.exportKeyJwk(kp.publicKey)), priv: JSON.stringify(await ecdsa.exportKeyJwk(kp.privateKey)) }
  fs.mkdirSync(RUN, { recursive: true })
  fs.writeFileSync(f, JSON.stringify(k))
  return k
}

async function env() {
  const k = await keys()
  return {
    ...process.env,
    REDIS: 'redis://localhost:56379',
    S3_ENDPOINT: 'localhost',
    S3_PORT: '59100',
    S3_SSL: 'false',
    S3_ACCESS_KEY: 'bakeoff',
    S3_SECRET_KEY: 'bakeoffsecret',
    AUTH_PERM_CALLBACK: `${AUTH}/auth/perm`,
    AUTH_PUBLIC_KEY: k.pub,
    AUTH_PRIVATE_KEY: k.priv,
    PORT: String(PORT),
    // No AWS credentials reach these processes.
    AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_PROFILE: '',
  }
}

async function start(name, script) {
  fs.mkdirSync(RUN, { recursive: true })
  const out = fs.openSync(path.join(RUN, `${name}.log`), 'a')
  const p = spawn(NODE20, [path.join(PKG, 'bin', script)], { cwd: PKG, env: await env(), stdio: ['ignore', out, out] })
  procs[name] = p
  p.unref()
}

async function waitPort(url, timeoutMs = 30000) {
  const t = Date.now()
  while (Date.now() - t < timeoutMs) {
    try {
      await fetch(url)
      return
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`not up: ${url}`)
}

function stop(name, signal) {
  const p = procs[name]
  if (!p) return Promise.resolve()
  return new Promise((r) => {
    p.once('exit', r)
    p.kill(signal)
  })
}

async function startServer() {
  await start('server', 'server.js')
  await waitPort(`http://localhost:${PORT}/`)
}

process.on('exit', () => Object.values(procs).forEach((p) => p.kill('SIGKILL')))

export default {
  name: 'yredis',
  ack: false,
  async up() {
    execFileSync('docker', ['compose', '-f', path.join(DIR, 'compose.yml'), 'up', '-d'], { stdio: 'ignore' })
    if (!procs.auth) {
      await start('auth', 'auth-server-example.js')
      await waitPort(`${AUTH}/auth/token`)
    }
    if (!procs.worker) await start('worker', 'worker.js')
    if (!procs.server) await startServer()
  },
  async prepare() {},
  async connect(pid) {
    const token = (await (await fetch(`${AUTH}/auth/token`)).text()).trim()
    return { url: `ws://localhost:${PORT}/${pid}?yauth=${token}`, protocols: [] }
  },
  async restart() {
    await stop('server', 'SIGTERM')
    await startServer()
  },
  async kill() {
    await stop('server', 'SIGKILL')
    await startServer()
  },
  async storageBytes() {
    return null
  },
}
