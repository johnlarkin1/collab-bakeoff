# Bake-off contract

Collaboration engines for Rebar's takeoff docs (RFC: Realtime Collaboration). Several engine variants serve the same synthetic docs, and one harness drives them with the same edit traces. A separate shape bench measures the doc layouts themselves.

## Rules

- Synthetic data only. No customer docs, `yjs-states` objects or prd exports in git (`.gitignore` covers `fixtures/` and `*.ybin`). A real room may be passed in by path for a local run; its numbers may go in a results table, its bytes never do.
- `y-redis-server` is AGPL. Run it from a local checkout; never vendor or publish its code here.
- Do not commit from agents. Leave changes in the working tree.

## Doc shapes

The root is `markup.icons` (RFC doc schema), a `Y.Map` keyed by icon id.

| Shape | Icon value | ML `meta` |
| --- | --- | --- |
| `map` | nested `Y.Map`, one key per field (~40) | inline in `meta` |
| `map-meta` | nested `Y.Map` | provenance keys moved to `{shape}.sidecar.json` |
| `value` | one plain JSON value | inline |
| `value-meta` | one plain JSON value | moved to the sidecar |
| `hybrid` | nested `Y.Map` with the 9 edited fields (`x`, `y`, `name`, `color`, `category`, `properties`, `user_touched`, `pageId`, `meta`) plus one plain `rest` value | moved to the sidecar |

Attribution keys that stay in the doc: `created_by`, `created_at`, `updated_by`, `producer`, `origin`, `aiRunId`. ML provenance keys that move: `system_type_inference`, `size_evidence`, `duct_tool`.

## Corpus

`node corpus_gen/generate.mjs --out fixtures [--fixtures p50,max]` writes `fixtures/{fixture}/{shape}.ybin` (Yjs v1 update), the sidecars and `fixtures/manifest.json`. Deterministic (seeded).

| Fixture | Target | Notes |
| --- | --- | --- |
| `p50` | 0.1 MB in `map` | typical room |
| `p99` | 2.7 MB | heavy room |
| `p999` | 7.3 MB | very heavy room |
| `over16` | 20 MB | the rooms over 16 MiB |
| `max` | 36,000 icons | largest active room: 36k icons, ~1.44M Yjs items |

Icon fields follow `DroppedIcon` in `app/src/components/Editor/types.ts`. Synthetic icons are about 1.4 KB each in `map`, heavier than the ~1.1 KB per icon implied by the real 40.6 MB room, so `max` encodes to about 52 MB. Item count matches; byte size does not.

## Shape bench

One fixture file per process, so memory numbers are not polluted by earlier runs.

```
node --expose-gc bench/yjs.mjs --file F --mode time|mem [--reps N]
bench/yrs/target/release/shape-yrs --file F --mode time|mem [--reps N]
```

`time` prints JSON with `load_ms` (median), `to_js_ms` / `to_json_ms` (materialize every icon as a plain object), `encode_ms` (full state), `edit_update_bytes` (one field edit). The yjs bench also reports `concurrent_field_lost` (two replicas edit different fields of one icon; true if either edit is lost after merging) and `converged`.

`mem` prints `heap_mb` and `rss_mb` deltas after load and GC (yjs), or `peak_rss_delta_mb` (yrs, `getrusage` max RSS after load minus before; includes decode transients).

`node harness/run-shapes.mjs --fixtures fixtures --out results [--only p99,max]` runs the matrix and writes `results/shapes.json` and `results/shapes.md`.

## Engine variants (next)

| Variant | Engine | Owner placement | Durable before ack |
| --- | --- | --- | --- |
| `yredis` | today's `y-redis-server` (Node) | any pod; Redis streams + workers | none (no ack) |
| `rfc` | `services/collab` (Rust, `yrs` 0.28) | single pod (ring later) | Postgres `collab.doc_updates` |
| `actor` | RivetKit Rust actor + `yrs` | Rivet control plane | actor SQLite, tiered to S3 |
| `actor-pg` | same Rivet actor | Rivet control plane | Postgres log (the RFC's `crates/log`) |

Every variant serves standard y-websocket sync + awareness at `ws://localhost:{port}/{project_id}` and loads a fixture into a project through `POST /admin/seed/{project_id}` with the `.ybin` body. Variants with an `ack {seq}` message report it; the others are measured on broadcast only. One `docker compose` stack provides Postgres 17, MinIO, Redis and the Rivet engine, with optional latency shaping.

Engine metrics: cold and warm open, append-to-ack p50/p99, broadcast p99, acked updates lost after `kill -9` of the owner (must be 0), owner-loss recovery, deploy disruption, writes accepted by a stale owner (must be 0), memory per doc, storage bytes, moving parts.
