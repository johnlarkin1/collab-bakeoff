// Engine bench: seed, warm and cold open, edit latency, kill -9 durability, concurrent docs.
// Usage: node harness/run-engines.mjs --variant rfc [--fixtures p50,p99,max] [--shape map] [--out results]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client, now } from './client.mjs'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), [])
)
const VARIANT = args.variant ?? 'rfc'
const FIXTURES = (args.fixtures ?? 'p50,p99,max').split(',')
const SHAPE = args.shape ?? 'map'
const OUT = args.out ?? 'results'
const EDITS = Number(args.edits ?? 200)
const KILL_RUNS = Number(args['kill-runs'] ?? 5)
const LOAD_DOCS = Number(args['load-docs'] ?? 314)
const LOAD_SECONDS = Number(args['load-seconds'] ?? 30)
const ROOT = 'markup.icons'

const adapter = (await import(`../variants/${VARIANT}/adapter.mjs`)).default
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pct = (xs, p) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10)
let pidSeq = Date.now() % 1e9
const newPid = () => `00000000-0000-4000-8000-${(pidSeq++).toString(16).padStart(12, '0')}`
const log = (...a) => console.error(`[${VARIANT}]`, ...a)

// Connect and sync, retrying transient failures (owner moving or waking, 1013/4408/4410, timeouts)
// for up to `budgetMs`, like a real provider would. `ms` covers every attempt; `attempts` counts them.
const retries = { total: 0 }
async function client(pid, budgetMs = 240000) {
  const t0 = now()
  for (let attempt = 1; ; attempt++) {
    const c = new Client(await adapter.connect(pid))
    try {
      const single = await c.connect(Math.min(90000, budgetMs))
      return { c, ms: attempt === 1 ? single : now() - t0, attempts: attempt }
    } catch (e) {
      c.close()
      const code = c.closed?.code
      const transient = code == null || [1006, 1011, 1013, 4408, 4410].includes(code)
      if (!transient || now() - t0 > budgetMs) throw new Error(`${e.message} after ${attempt} attempts`)
      retries.total++
      await sleep(Math.min(5000, 250 * attempt))
    }
  }
}

// Seed a project with a fixture by sending it as one update, and wait for the server to hold it.
async function seed(pid, bytes, expectIcons) {
  const { c } = await client(pid)
  const t = now()
  const { applyUpdate } = await import('yjs')
  applyUpdate(c.doc, bytes)
  if (adapter.ack) await c.drain(300000)
  else await sleep(2000)
  const ms = now() - t
  c.close()
  const { c: v } = await client(pid)
  const got = v.doc.getMap(ROOT).size
  v.close()
  if (got !== expectIcons) throw new Error(`seed check: ${got} icons, expected ${expectIcons}`)
  return ms
}

async function openTimes(pid, n, expectIcons) {
  const out = []
  for (let i = 0; i < n; i++) {
    const { c, ms } = await client(pid)
    if (c.doc.getMap(ROOT).size !== expectIcons) throw new Error('open: wrong icon count')
    out.push(ms)
    c.close()
  }
  return out
}

// A edits a small `bench` root at ~20/s; B times each edit's arrival. Ack latency from A.
async function editLatency(pid) {
  const { c: a } = await client(pid)
  const { c: b } = await client(pid)
  const sent = new Map()
  const bcast = []
  b.doc.getMap('bench').observe((e) => {
    for (const k of e.keysChanged) if (sent.has(k)) bcast.push(now() - sent.get(k))
  })
  const m = a.doc.getMap('bench')
  for (let i = 0; i < EDITS; i++) {
    const k = `e${i}`
    sent.set(k, now())
    m.set(k, i)
    await sleep(50)
  }
  if (adapter.ack) await a.drain()
  await sleep(500)
  a.close()
  b.close()
  return { ack: a.ackMs.slice(-EDITS), bcast }
}

// Send edits, kill -9 the owner mid-stream, reconnect, count delivered edits that are gone.
// Delivered = acked by the server (ack variants) or applied by a peer (no-ack variants).
async function killRun(pid, run) {
  const { c: a } = await client(pid)
  const { c: b } = await client(pid)
  const seen = new Set()
  b.doc.getMap('bench').observe((e) => e.keysChanged.forEach((k) => seen.add(k)))
  const base = a.acked // the step-2 reply on connect is acked too
  const m = a.doc.getMap('bench')
  const sentKeys = []
  let i = 0
  let killed = false
  const killAt = 40 + run * 7
  const sender = (async () => {
    while (!killed && i < 400) {
      const k = `k${run}_${i}`
      sentKeys.push(k)
      m.set(k, i)
      i++
      await sleep(5)
    }
  })()
  const delivered = () => (adapter.ack ? a.acked - base : seen.size)
  while (delivered() < killAt) await sleep(2)
  const t = now()
  const killP = adapter.kill()
  killed = true
  await sender
  await killP.catch(() => {})
  const recoverMs = now() - t
  const keys = adapter.ack ? sentKeys.slice(0, a.acked - base) : sentKeys.filter((k) => seen.has(k))
  a.close()
  b.close()
  const { c: v, ms } = await client(pid)
  const vm = v.doc.getMap('bench')
  const lost = keys.filter((k) => !vm.has(k)).length
  v.close()
  return { delivered: keys.length, lost, recover_ms: recoverMs, reopen_ms: ms }
}

// `docs` projects, each with one editing client at ~2 updates/s, plus a second client on 10%.
async function load(docs, seconds) {
  const pids = Array.from({ length: docs }, newPid)
  await adapter.prepare(pids)
  const clients = []
  const t0 = now()
  for (const pid of pids) clients.push((await client(pid)).c)
  const connectAllMs = now() - t0
  const peers = []
  const sentAt = new Map()
  const bcast = []
  for (let i = 0; i < docs; i += 10) {
    const p = (await client(pids[i])).c
    p.doc.getMap('bench').observe((e) => e.keysChanged.forEach((k) => sentAt.has(k) && bcast.push(now() - sentAt.get(k))))
    peers.push(p)
  }
  const end = now() + seconds * 1000
  let n = 0
  await Promise.all(
    clients.map(async (c, ci) => {
      const m = c.doc.getMap('bench')
      while (now() < end) {
        const k = `l${n++}`
        sentAt.set(k, now())
        m.set(k, ci)
        await sleep(400 + Math.random() * 200)
      }
    })
  )
  if (adapter.ack) await Promise.all(clients.map((c) => c.drain().catch(() => {})))
  await sleep(1000)
  const ack = clients.flatMap((c) => c.ackMs)
  for (const c of [...clients, ...peers]) c.close()
  return { docs, connections: clients.length + peers.length, connect_all_ms: connectAllMs, updates: n, ack, bcast }
}

const keepAlive = setInterval(() => {}, 1000) // child processes are unref'd; keep the loop alive
await adapter.up()
const manifest = JSON.parse(fs.readFileSync('fixtures/manifest.json', 'utf8'))
const save = () => {
  fs.mkdirSync(path.join(OUT, 'engines'), { recursive: true })
  result.connect_retries = retries.total
  fs.writeFileSync(path.join(OUT, 'engines', `${VARIANT}-${SHAPE}.json`), JSON.stringify(result, null, 2))
}
const result = { variant: VARIANT, shape: SHAPE, machine: `${os.cpus()[0].model}, ${os.cpus().length} cores`, ran_at: new Date().toISOString(), fixtures: [] }

for (const name of FIXTURES) {
  try {
  const f = manifest.fixtures.find((x) => x.name === name)
  const bytes = fs.readFileSync(path.join('fixtures', name, `${SHAPE}.ybin`))
  const pid = newPid()
  await adapter.prepare([pid])
  log(`${name}: seeding ${(bytes.length / 1e6).toFixed(1)} MB`)
  const seedMs = await seed(pid, bytes, f.icons)
  const warm = await openTimes(pid, 5, f.icons)
  const cold = []
  for (let i = 0; i < 3; i++) {
    await adapter.restart()
    cold.push((await openTimes(pid, 1, f.icons))[0])
  }
  log(`${name}: warm p50 ${r1(pct(warm, 50))} ms, cold p50 ${r1(pct(cold, 50))} ms`)
  const lat = await editLatency(pid)
  log(`${name}: ack p50 ${r1(pct(lat.ack, 50))} p99 ${r1(pct(lat.ack, 99))}, broadcast p50 ${r1(pct(lat.bcast, 50))} p99 ${r1(pct(lat.bcast, 99))}`)
  result.fixtures.push({
    fixture: name, icons: f.icons, mb: bytes.length / 1e6, seed_ms: r1(seedMs),
    warm_open_p50: r1(pct(warm, 50)), warm_open_max: r1(Math.max(...warm)),
    cold_open_p50: r1(pct(cold, 50)), cold_open_max: r1(Math.max(...cold)),
    ack_p50: r1(pct(lat.ack, 50)), ack_p99: r1(pct(lat.ack, 99)),
    bcast_p50: r1(pct(lat.bcast, 50)), bcast_p99: r1(pct(lat.bcast, 99)), bcast_n: lat.bcast.length,
  })
  } catch (e) {
    log(`${name}: FAILED ${e.message}`)
    result.fixtures.push({ fixture: name, error: e.message.slice(0, 300) })
  }
  save()
}

if (KILL_RUNS > 0) {
  const pid = newPid()
  await adapter.prepare([pid])
  const runs = []
  for (let r = 0; r < KILL_RUNS; r++) {
    try {
      runs.push(await killRun(pid, r))
    } catch (e) {
      log(`kill ${r}: FAILED ${e.message}`)
      runs.push({ delivered: 0, lost: 0, recover_ms: null, error: e.message.slice(0, 300) })
      continue
    }
    log(`kill ${r}: delivered ${runs.at(-1).delivered}, lost ${runs.at(-1).lost}, recover ${r1(runs.at(-1).recover_ms)} ms`)
  }
  result.durability = {
    runs: runs.length, delivered: runs.reduce((s, x) => s + x.delivered, 0), delivered_means: adapter.ack ? 'acked' : 'applied by a peer', lost: runs.reduce((s, x) => s + x.lost, 0),
    recover_p50_ms: r1(pct(runs.filter((x) => x.recover_ms != null).map((x) => x.recover_ms), 50)),
    reopen_p50_ms: r1(pct(runs.filter((x) => x.reopen_ms != null).map((x) => x.reopen_ms), 50)),
    failed_runs: runs.filter((x) => x.error).length,
    errors: runs.filter((x) => x.error).map((x) => x.error),
  }
  save()
}

if (LOAD_DOCS > 0) {
  log(`load: ${LOAD_DOCS} docs for ${LOAD_SECONDS} s`)
  let l
  try {
    l = await load(LOAD_DOCS, LOAD_SECONDS)
  } catch (e) {
    log(`load: FAILED ${e.message}`)
    result.load = { error: e.message.slice(0, 300) }
  }
  if (l) {
  result.load = {
    docs: l.docs, connections: l.connections, connect_all_ms: r1(l.connect_all_ms), updates: l.updates,
    ack_p50: r1(pct(l.ack, 50)), ack_p99: r1(pct(l.ack, 99)), bcast_p50: r1(pct(l.bcast, 50)), bcast_p99: r1(pct(l.bcast, 99)), bcast_n: l.bcast.length,
  }
  log(`load: ack p50 ${result.load.ack_p50} p99 ${result.load.ack_p99}, broadcast p50 ${result.load.bcast_p50} p99 ${result.load.bcast_p99}`)
  }
}

result.storage_bytes = await adapter.storageBytes().catch(() => null)
save()
console.log(JSON.stringify(result, null, 2))
process.exit(0)
