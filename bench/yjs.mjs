// Shape bench in yjs (the browser's library). One fixture file per process.
// Usage: node --expose-gc bench/yjs.mjs --file F --mode time|mem [--reps N]
import * as Y from 'yjs'
import fs from 'node:fs'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), [])
)
const ROOT = 'markup.icons'
const bytes = fs.readFileSync(args.file)
const now = () => Number(process.hrtime.bigint()) / 1e6
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

function load() {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, bytes)
  return doc
}

if (args.mode === 'mem') {
  global.gc()
  const h0 = process.memoryUsage().heapUsed
  const r0 = process.memoryUsage().rss
  const doc = load()
  global.gc()
  const h1 = process.memoryUsage().heapUsed
  const r1 = process.memoryUsage().rss
  console.log(JSON.stringify({ heap_mb: (h1 - h0) / 1e6, rss_mb: (r1 - r0) / 1e6, items: doc.getMap(ROOT).size }))
  process.exit(0)
}

const reps = Number(args.reps ?? 5)
const loadMs = []
let doc
for (let i = 0; i < reps; i++) {
  if (doc) doc.destroy()
  global.gc?.()
  const t = now()
  doc = load()
  loadMs.push(now() - t)
}
const root = doc.getMap(ROOT)

// Materialize every icon as a plain JS object, as the canvas needs.
let t = now()
let n = 0
root.forEach((v) => {
  const o = v instanceof Y.Map ? v.toJSON() : v
  n += o.x > -1 ? 1 : 0
})
const toJsMs = now() - t

t = now()
const encoded = Y.encodeStateAsUpdate(doc)
const encodeMs = now() - t

// One field edit: per-key set vs whole-value replace. Report the update size.
const key = root.keys().next().value
const editBytes = (d, field, value) => {
  const r = d.getMap(ROOT)
  const sv = Y.encodeStateVector(d)
  const cur = r.get(key)
  if (cur instanceof Y.Map) cur.set(field, value)
  else r.set(key, { ...cur, [field]: value })
  return Y.encodeStateAsUpdate(d, sv)
}
const oneEdit = editBytes(doc, 'x', 1234.5)

// Two users edit different fields of the same icon concurrently. Does either edit get lost?
const a = new Y.Doc()
const b = new Y.Doc()
Y.applyUpdate(a, encoded)
Y.applyUpdate(b, encoded)
const ua = editBytes(a, 'x', 111)
const ub = editBytes(b, 'color', '#abcdef')
Y.applyUpdate(a, ub)
Y.applyUpdate(b, ua)
const get = (d) => {
  const v = d.getMap(ROOT).get(key)
  return v instanceof Y.Map ? v.toJSON() : v
}
const merged = get(a)
const fieldLost = !(merged.x === 111 && merged.color === '#abcdef')

console.log(
  JSON.stringify({
    icons: root.size,
    load_ms: median(loadMs),
    load_ms_all: loadMs.map((x) => Math.round(x * 10) / 10),
    to_js_ms: toJsMs,
    encode_ms: encodeMs,
    edit_update_bytes: oneEdit.length,
    concurrent_field_lost: fieldLost,
    converged: JSON.stringify(get(a)) === JSON.stringify(get(b)),
  })
)
