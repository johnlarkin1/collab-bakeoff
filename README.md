# collab-bakeoff

Which collaboration engine should hold Rebar's takeoff docs, and how should those docs be laid out? This repo measures the next-gen RFC design, the Rivet project-actor proposal and today's y-redis on the same synthetic docs.

All data is synthetic. No customer data belongs in this repo.

## The question

Two designs replace y-redis. Both keep Yjs and put one owner in front of each project's doc, in Rust on `yrs`:

- **RFC: Realtime Collaboration** (next-gen): our own server, every edit appended to Postgres before it is acked, versions in S3. Launches on one pod; a hash ring follows.
- **Replacing y-redis with project actors** (Ethan): one Rivet actor per project, state in the actor's SQLite, and a smaller doc: one Yjs value per icon and ML `meta` moved out.

They disagree on three things this repo can measure: the doc shape, where an edit is durable, and who places the owner. See `CONTRACT.md` for the variants and the harness.

## Stage 1: doc shape

| Shape | Icon value | ML `meta` |
| --- | --- | --- |
| `map` | nested `Y.Map`, one key per field (today) | inline |
| `map-meta` | nested `Y.Map` | moved to a sidecar |
| `value` | one plain JSON value | inline |
| `value-meta` | one plain JSON value (Ethan's proposal) | moved to a sidecar |
| `hybrid` | nested `Y.Map` for the 9 fields people and agents edit (`x`, `y`, `name`, `color`, `category`, `properties`, `user_touched`, `pageId`, `meta`); everything else in one plain `rest` value | moved to a sidecar |

### Results (2026-11-11, Apple M5 Pro, `max` fixture: 36,000 icons)

Medians of 3 runs, each in a fresh process. Full table for every fixture: [results/shapes.md](results/shapes.md).

| shape | MB | gzip MB | yjs load ms | yjs heap MB | yrs load ms | yrs peak RSS MB | one-field edit B | concurrent field edits |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `map` (today) | 52 | 11 | 1,788 | 773 | 546 | 731 | 22 | merge |
| `map-meta` | 41 | 8.7 | 1,636 | 737 | 469 | 676 | 22 | merge |
| `value` | 41 | 6.4 | 456 | 166 | 185 | 390 | 1,120 | one is lost |
| `value-meta` (Ethan) | 31 | 4.3 | 390 | 129 | 126 | 281 | 838 | one is lost |
| `hybrid` | 34 | 5.3 | 599 | 292 | 202 | 419 | 22 | merge (hot fields) |

### What it shows

- **Ethan's numbers reproduce.** Today's shape: 1.8 s and 773 MB in yjs (his room: 2.1 s, 804 MB). His proposal: 390 ms / 129 MB in yjs and 126 ms in yrs (his: 285 ms / 108 MB, 61 ms). Our room is 27% larger in bytes, which accounts for most of the gap.
- **Almost all of the speedup comes from storing each icon as one value, not from moving ML `meta` out.** `map-meta` saves 20% of the bytes but only 8% of the load time (1.79 → 1.64 s). Load time follows the number of Yjs items (40 per icon in `map`, 1 in `value`), not the bytes.
- **One value per icon has two real costs.** A one-field edit becomes a whole-icon write: 838–1,120 bytes instead of 22, about 40–50× more bytes into the update log, the broadcast and the markup-event pipeline. And when two writers change different fields of one icon at the same time (a user and an agent, say), one change is lost.
- **`hybrid` keeps most of the speedup without those costs.** It loads 3× faster than today in yjs (599 ms) and 2.7× faster in yrs, edits stay 22 bytes, and concurrent edits to the editable fields merge. Edits to `rest` fields replace `rest` as a whole, so the split of hot and cold fields matters.
- **The server is not the bottleneck.** yrs loads every shape 2.5–3.5× faster than yjs. The 1.8 s problem is the browser, which is where render-first open and hydrating Yjs in a worker apply.
- **Typical rooms don't care.** At p99 (2.7 MB) every shape loads in under 65 ms in yjs and 25 ms in yrs.

## Stage 2: engines (next)

| Variant | Engine | Owner placement | Durable before ack | Status |
| --- | --- | --- | --- | --- |
| `yredis` | today's `y-redis-server` | any pod, Redis streams | none | planned |
| `rfc` | `services/collab` (Rust, `yrs` 0.28) | single pod, ring later | Postgres log | planned |
| `actor` | RivetKit Rust actor + `yrs` | Rivet | actor SQLite | planned |
| `actor-pg` | same actor | Rivet | Postgres log | planned |

`actor-pg` separates the two questions the proposals mix: who places the owner, and where the edit is durable.

## Claims to reproduce

From the actors proposal (measured on prd data) and Rivet's own benchmarks:

| Claim | Value | Stage |
| --- | --- | --- |
| Largest room, today's shape | 40.6 MB, 2.1 s decode, 804 MB heap (yjs) | 1: reproduced (52 MB, 1.8 s, 773 MB) |
| Same room, `value-meta` | 25.4 MB; 285 ms / 108 MB (yjs); 61 ms / 231 MB RSS (yrs) | 1: reproduced in direction (31 MB; 390 ms / 129 MB; 126 ms / 281 MB) |
| Same room gzipped | 6.4 MB | 1: 4.3 MB for `value-meta`, 11 MB for `map` (synthetic numbers compress worse) |
| ywasm vs yjs, icons out to JS | 690 ms vs ~12 ms | 1: yjs side only; `value-meta` 5 ms, `map` 948 ms |
| Room connect today | p50 564 ms, p95 6.1 s | 2 |
| Rivet | cold start 5 ms p99, wake 8 ms p99, durable write 1.07 ms p99 | 2 |
| RFC targets | append-to-broadcast p99 < 50 ms, p95 load < 2 s at 2,000 docs / 10,000 clients | 2 |

## Running

```bash
npm install
npm run corpus          # fixtures/ (about 1 GB, gitignored)
npm run shapes          # builds bench/yrs, writes results/shapes.{json,md}
node harness/run-shapes.mjs --only p99,max
```

Needs Node 22 and a Rust toolchain.

## Caveats

- Synthetic icons are about 1.4 KB each in `map`, heavier than the ~1.1 KB implied by the real 40.6 MB room, so `max` matches the real room's icon and item count (36k, ~1.44M) but encodes to about 52 MB. Compare ratios between shapes, not absolute bytes against prd.
- Only `markup.icons` is generated. Real docs also hold ducts, rooms, schedules and comments.
- One machine, no network. Memory numbers are process deltas, not a browser's.
