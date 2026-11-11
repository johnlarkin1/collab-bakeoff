// Warm opens, each timed in a fresh Node process so the seeding process's heap doesn't skew them.
// Usage: node harness/run-opens.mjs <variant> [p99,p999]
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import { Client } from './client.mjs'
const variant = process.argv[2]
const fixtures = (process.argv[3] ?? 'p99,p999').split(',')
process.env.BAKEOFF_ACTOR_NONCE ??= `fresh${Date.now().toString(36)}` // child processes reuse the parent's actor keys
const adapter = (await import(`../variants/${variant}/adapter.mjs`)).default
const keep = setInterval(() => {}, 1000)
await adapter.up()
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
let seq = Date.now() % 1e9
for (const f of fixtures) {
  const pid = `00000000-0000-4000-9000-${(seq++).toString(16).padStart(12, '0')}`
  await adapter.prepare([pid])
  const c = new Client(await adapter.connect(pid)); await c.connect(120000)
  Y.applyUpdate(c.doc, fs.readFileSync(`fixtures/${f}/map.ybin`))
  if (adapter.ack) await c.drain(300000); else await new Promise((r) => setTimeout(r, 3000))
  c.close()
  const warm = []
  for (let i = 0; i < 5; i++) warm.push(...JSON.parse(execFileSync('node', ['harness/open-child.mjs', variant, pid, '1'], { encoding: 'utf8', stdio: ['ignore','pipe','inherit'] }).trim().split('\n').pop()))
  console.log(`${variant} ${f}: fresh-process warm opens ${warm.map((x) => x.toFixed(0)).join(', ')} ms, median ${med(warm).toFixed(0)}`)
}
process.exit(0)
