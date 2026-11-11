// Runs the shape matrix: every fixture x shape, in yjs and yrs, time and memory,
// each in a fresh process. Writes results/shapes.json and results/shapes.md.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), [])
)
const FIX = args.fixtures ?? 'fixtures'
const OUT = args.out ?? 'results'
const ONLY = args.only ? args.only.split(',') : null
const SHAPES = args.shapes ? args.shapes.split(',') : ['map', 'map-meta', 'value', 'value-meta', 'hybrid']
const REPS = { p50: 20, p99: 10, p999: 5, over16: 3, max: 3 }
const YRS = 'bench/yrs/target/release/shape-yrs'

execFileSync('cargo', ['build', '--release', '--manifest-path', 'bench/yrs/Cargo.toml'], { stdio: 'inherit' })
const manifest = JSON.parse(fs.readFileSync(path.join(FIX, 'manifest.json'), 'utf8'))

const run = (cmd, argv) => JSON.parse(execFileSync(cmd, argv, { encoding: 'utf8', maxBuffer: 1 << 26 }).trim().split('\n').pop())
const node = (file, mode, reps) =>
  run('node', ['--expose-gc', '--max-old-space-size=16384', 'bench/yjs.mjs', '--file', file, '--mode', mode, '--reps', String(reps)])
const yrs = (file, mode, reps) => run(YRS, ['--file', file, '--mode', mode, '--reps', String(reps)])

const prev = args.merge && fs.existsSync(path.join(OUT, 'shapes.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'shapes.json'), 'utf8')).rows : []
const rows = prev.filter((r) => !SHAPES.includes(r.shape))
for (const f of manifest.fixtures) {
  if (ONLY && !ONLY.includes(f.name)) continue
  for (const shape of SHAPES) {
    const file = path.join(FIX, f.name, `${shape}.ybin`)
    const reps = REPS[f.name] ?? 3
    process.stderr.write(`${f.name} ${shape} ...`)
    const row = {
      fixture: f.name,
      shape,
      icons: f.icons,
      mb: f.shapes[shape].bytes / 1e6,
      gzip_mb: f.shapes[shape].gzip_bytes / 1e6,
      sidecar_mb: (f.shapes[shape].sidecar_bytes ?? 0) / 1e6,
      yjs: { ...node(file, 'time', reps), ...node(file, 'mem', 1) },
      yrs: { ...yrs(file, 'time', reps), ...yrs(file, 'mem', 1) },
    }
    rows.push(row)
    process.stderr.write(` yjs ${row.yjs.load_ms.toFixed(0)} ms, yrs ${row.yrs.load_ms.toFixed(0)} ms\n`)
  }
}

const FORDER = manifest.fixtures.map((f) => f.name)
const SORDER = ['map', 'map-meta', 'value', 'value-meta', 'hybrid']
rows.sort((a, b) => FORDER.indexOf(a.fixture) - FORDER.indexOf(b.fixture) || SORDER.indexOf(a.shape) - SORDER.indexOf(b.shape))
const machine = `${os.cpus()[0].model}, ${os.cpus().length} cores, ${(os.totalmem() / 2 ** 30).toFixed(0)} GB, ${os.platform()} ${os.release()}, node ${process.version}`
fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'shapes.json'), JSON.stringify({ machine, ran_at: new Date().toISOString(), manifest, rows }, null, 2))

const f1 = (v) => (v == null ? '—' : v < 10 ? v.toFixed(1) : v.toFixed(0))
const lines = [
  `# Shape results`,
  ``,
  `Machine: ${machine}. Ran ${new Date().toISOString().slice(0, 10)}. Medians; each cell is a fresh process.`,
  ``,
  `| fixture | shape | icons | MB | gzip MB | sidecar MB | yjs load ms | yjs heap MB | yjs to-JS ms | yrs load ms | yrs peak RSS MB | yrs to-JSON ms | edit update B | concurrent field lost |`,
  `| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |`,
  ...rows.map((r) =>
    [
      r.fixture, r.shape, r.icons, f1(r.mb), f1(r.gzip_mb), r.sidecar_mb ? f1(r.sidecar_mb) : '—',
      f1(r.yjs.load_ms), f1(r.yjs.heap_mb), f1(r.yjs.to_js_ms),
      f1(r.yrs.load_ms), f1(r.yrs.peak_rss_delta_mb), f1(r.yrs.to_json_ms),
      r.yjs.edit_update_bytes, r.yjs.concurrent_field_lost ? 'yes' : 'no',
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |')
  ),
  ``,
]
fs.writeFileSync(path.join(OUT, 'shapes.md'), lines.join('\n'))
console.log(lines.join('\n'))
