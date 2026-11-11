// Synthetic takeoff docs in four shapes. Deterministic; no customer data.
import * as Y from 'yjs'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), [])
)
const OUT = args.out ?? 'fixtures'
const ONLY = args.fixtures ? args.fixtures.split(',') : null

// Sizes from prd: RFC Prd sizing and the actors proposal (active rooms in yjs-states).
// `max` is pinned to the largest active room: ~36k icons, 40.6 MB in the `map` shape.
const FIXTURES = [
  { name: 'p50', targetMB: 0.1 },
  { name: 'p99', targetMB: 2.7 },
  { name: 'p999', targetMB: 7.3 },
  { name: 'over16', targetMB: 20 },
  { name: 'max', targetMB: 40.6, icons: 36000 },
]
const SHAPES = ['map', 'map-meta', 'value', 'value-meta', 'hybrid']
// `hybrid`: per-key Y.Map for the fields users and agents edit; everything else in one plain `rest` value; ML meta in the sidecar.
const HOT_KEYS = ['x', 'y', 'name', 'color', 'category', 'properties', 'user_touched', 'pageId', 'meta']
const ROOT = 'markup.icons'
const ICONS_PER_PAGE = 1900
const ATTRIBUTION_KEYS = ['created_by', 'created_at', 'updated_by', 'producer', 'origin', 'aiRunId']

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const CATEGORIES = ['Diffuser', 'Grille', 'VAV', 'Exhaust Fan', 'AHU', 'Damper', 'Duct Fitting', 'Thermostat']
const SYSTEMS = ['supply', 'return', 'exhaust', 'outside_air', 'transfer']
const WORDS = 'SUPPLY RETURN EXHAUST CFM DIA NECK 12X12 24X24 8" 10" 14" TYP SEE SCHED VAV-1 EF-2 AHU-3 RG-1 SD-4 LD-2'.split(' ')

function words(r, n) {
  const out = []
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(r() * WORDS.length)])
  return out.join(' ')
}
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d
const bbox = (r) => [Math.round(r() * 2400), Math.round(r() * 1600), Math.round(r() * 2400), Math.round(r() * 1600)]

// One icon, fields after app/src/components/Editor/types.ts DroppedIcon. ~40 top-level keys.
function makeIcon(i, r, pad) {
  const cat = CATEGORIES[Math.floor(r() * CATEGORIES.length)]
  const system = SYSTEMS[Math.floor(r() * SYSTEMS.length)]
  const icon = {
    id: i,
    uuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    model_id: 'm1',
    name: `${cat} ${i}`,
    category: cat,
    superset: 'HVAC',
    color: '#' + Math.floor(r() * 0xffffff).toString(16).padStart(6, '0'),
    page: Math.floor(i / ICONS_PER_PAGE),
    pageId: `page-${Math.floor(i / ICONS_PER_PAGE)}`,
    shape: 'rect',
    x: round(r() * 2400),
    y: round(r() * 1600),
    confidenceScore: round(r(), 4),
    properties: { cfm: Math.floor(r() * 2000), size: `${Math.floor(r() * 24)}x${Math.floor(r() * 24)}`, tag: `${cat.slice(0, 2).toUpperCase()}-${i % 50}`, model: words(r, 1), notes: 'x'.repeat(pad) },
    generic: r() < 0.2,
    tool_category: 'equipment',
    selectedOption: null,
    multiplier: 1,
    costMultiplier: 1,
    src_id: `s${i % 997}`,
    user_touched: r() < 0.1,
    measurementAccepted: false,
    extracted_text: words(r, 2),
    text_bbox: bbox(r),
    layer: 'mech',
    symbol_bbox: bbox(r),
    text_xy: [round(r() * 2400), round(r() * 1600)],
    typical_group_id: r() < 0.3 ? `tg-${i % 40}` : '',
    typical_required: 1,
    priced: r() < 0.5,
    priceConfigId: `pc-${i % 12}`,
    group_id: `g-${i % 200}`,
    is_active: true,
    _mult_: '1',
    sections: 1,
    slotLengthLinked: false,
    radiusLengthLinked: false,
    linear_run_id: i % 300,
    linear_section_id: `ls-${i % 900}`,
    ruleApplications: {},
    meta: {
      created_by: 'ai',
      created_at: 1762800000000 + i,
      updated_by: null,
      producer: 'ml-ductwork-v3',
      origin: 'ai',
      aiRunId: 'run-0001',
      // ML provenance: written by core, read only by ML-ETL. The `-meta` shapes move these to a sidecar.
      system_type_inference: {
        label: system,
        score: round(r(), 4),
        model: 'sti-2026-09',
        candidates: SYSTEMS.slice(0, 1).map((s) => ({ label: s, score: round(r(), 4) })),
      },
      size_evidence: { text: words(r, 2), bbox: bbox(r), ocr_conf: round(r(), 3), source: 'ocr', page: Math.floor(i / ICONS_PER_PAGE) },
      duct_tool: { tool_id: `dt-${i % 30}`, width: round(r() * 30), height: round(r() * 30), shape: 'rect', rule: 'fill' },
    },
  }
  return icon
}

function splitMeta(icon) {
  const meta = {}
  const ml = {}
  for (const [k, v] of Object.entries(icon.meta)) (ATTRIBUTION_KEYS.includes(k) ? meta : ml)[k] = v
  return [{ ...icon, meta }, ml]
}

function encode(shape, icons) {
  const doc = new Y.Doc()
  doc.clientID = 1234567 // outside the server-reserved range 1..=65535 in services/collab
  const root = doc.getMap(ROOT)
  const sidecar = {}
  doc.transact(() => {
    for (const icon0 of icons) {
      let icon = icon0
      if (shape.endsWith('-meta') || shape === 'hybrid') {
        const [kept, ml] = splitMeta(icon0)
        icon = kept
        sidecar[String(icon.id)] = ml
      }
      if (shape === 'hybrid') {
        const m = new Y.Map()
        root.set(String(icon.id), m)
        const rest = {}
        for (const [k, v] of Object.entries(icon)) (HOT_KEYS.includes(k) ? m.set(k, v) : (rest[k] = v))
        m.set('rest', rest)
      } else if (shape.startsWith('map')) {
        const m = new Y.Map()
        root.set(String(icon.id), m)
        for (const [k, v] of Object.entries(icon)) m.set(k, v)
      } else {
        root.set(String(icon.id), icon)
      }
    }
  })
  const bytes = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return { bytes, sidecar: shape.endsWith('-meta') || shape === 'hybrid' ? sidecar : null }
}

function icons(n, pad, seed = 42) {
  const r = rng(seed)
  return Array.from({ length: n }, (_, i) => makeIcon(i, r, pad))
}

// Calibrate the pad so 36k icons in `map` encode to ~40.6 MB (1,128 B per icon).
function calibrate() {
  const target = (40.6 * 1e6) / 36000
  const sample = 2000
  let lo = 0
  let hi = 1200
  for (let k = 0; k < 14; k++) {
    const mid = Math.floor((lo + hi) / 2)
    const per = encode('map', icons(sample, mid)).bytes.length / sample
    if (per < target) lo = mid
    else hi = mid
  }
  const per = encode('map', icons(sample, lo)).bytes.length / sample
  return { pad: lo, perIcon: per }
}

const { pad, perIcon } = calibrate()
console.log(`calibrated pad=${pad} bytes/icon(map)=${perIcon.toFixed(0)}`)

const manifest = { generated_at: new Date().toISOString(), root: ROOT, pad, bytes_per_icon_map: Math.round(perIcon), fixtures: [] }
for (const f of FIXTURES) {
  if (ONLY && !ONLY.includes(f.name)) continue
  const n = f.icons ?? Math.max(1, Math.round((f.targetMB * 1e6) / perIcon))
  const list = icons(n, pad)
  const dir = path.join(OUT, f.name)
  fs.mkdirSync(dir, { recursive: true })
  const entry = { name: f.name, target_mb: f.targetMB, icons: n, pages: Math.ceil(n / ICONS_PER_PAGE), shapes: {} }
  for (const shape of SHAPES) {
    const { bytes, sidecar } = encode(shape, list)
    fs.writeFileSync(path.join(dir, `${shape}.ybin`), bytes)
    const s = { bytes: bytes.length, gzip_bytes: zlib.gzipSync(bytes).length }
    if (sidecar) {
      const json = Buffer.from(JSON.stringify(sidecar))
      fs.writeFileSync(path.join(dir, `${shape}.sidecar.json`), json)
      s.sidecar_bytes = json.length
    }
    entry.shapes[shape] = s
    console.log(`${f.name.padEnd(7)} ${shape.padEnd(10)} icons=${n} ${(bytes.length / 1e6).toFixed(2)} MB gzip=${(s.gzip_bytes / 1e6).toFixed(2)} MB`)
  }
  manifest.fixtures.push(entry)
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2))
