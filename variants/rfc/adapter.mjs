// rfc: services/collab from rebar-larkin, run from its own compose stack (project "collab").
import { execFileSync } from 'node:child_process'

const BASE = 'http://localhost:8080'
const READY = 'http://localhost:9090/readyz'
const SERVER = 'collab-collab-1'
const PG = 'collab-postgres-1'
const COMPANY = '00000000-0000-0000-0000-00000000c0de'
const USER = '00000000-0000-0000-0000-00000000beef'

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const psql = (user, pass, sql) =>
  sh('docker', ['exec', '-e', `PGPASSWORD=${pass}`, PG, 'psql', '-h', 'localhost', '-U', user, '-d', 'rebar', '-v', 'ON_ERROR_STOP=1', '-qAtc', sql])

async function ready(timeoutMs = 60000) {
  const t = Date.now()
  while (Date.now() - t < timeoutMs) {
    try {
      if ((await fetch(READY)).ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('rfc not ready')
}

export default {
  name: 'rfc',
  ack: true,
  async up() {
    // Recreate the server with the bench override (message cap raised to 128 MiB).
    const dir = new URL('../../../rebar-larkin/services/collab/', import.meta.url).pathname
    sh('docker', ['compose', '-f', `${dir}docker-compose.yaml`, '-f', new URL('./compose.override.yml', import.meta.url).pathname, 'up', '-d', '--no-deps', 'collab'])
    await ready()
  },
  async prepare(pids) {
    const values = pids.map((p, i) => `('${p}','${COMPANY}','${USER}','bakeoff ${i}')`).join(',')
    psql('api_app', 'local', `BEGIN; SET LOCAL app.company_id = '${COMPANY}'; SET LOCAL app.user_id = '${USER}'; INSERT INTO projects.projects (id, company_id, owner_user_id, name) VALUES ${values} ON CONFLICT DO NOTHING; COMMIT;`)
    for (const p of pids) {
      const r = await fetch(`${BASE}/collab/dev/projects/${p}/init`, { method: 'POST' })
      if (!r.ok && r.status !== 409) throw new Error(`init ${p}: ${r.status} ${await r.text()}`)
    }
  },
  async connect(pid) {
    const r = await fetch(`${BASE}/collab/dev/token?pid=${pid}`)
    if (!r.ok) throw new Error(`token: ${r.status}`)
    const jwt = (await r.text()).trim()
    return { url: `ws://localhost:8080/collab/v1/projects/${pid}/ws`, protocols: ['collab.v1', `bearer.${jwt}`] }
  },
  async restart() {
    sh('docker', ['restart', '-t', '60', SERVER])
    await ready()
  },
  async kill() {
    sh('docker', ['kill', '--signal', 'KILL', SERVER])
    sh('docker', ['start', SERVER])
    await ready()
  },
  async storageBytes() {
    const sql = "SELECT coalesce(sum(pg_total_relation_size(c.oid)),0) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'collab' AND c.relkind IN ('r','p')"
    return Number(psql('postgres', 'collab', sql).trim())
  },
}
