// Child of run-opens.mjs: opens one project n times and prints the open times as JSON.
import { Client } from './client.mjs'
const [variant, pid, n] = process.argv.slice(2)
const adapter = (await import(`../variants/${variant}/adapter.mjs`)).default
const out = []
for (let i = 0; i < Number(n); i++) {
  const c = new Client(await adapter.connect(pid))
  out.push(await c.connect(120000)); console.error("icons", c.doc.getMap("markup.icons").size)
  c.close()
}
console.log(JSON.stringify(out))
process.exit(0)
