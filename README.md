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
| `map` (today) | 55 | 11 | 2,170 | 773 | 418 | 786 | 26 | merge |
| `map-meta` | 44 | 8.7 | 1,464 | 737 | 386 | 625 | 26 | merge |
| `value` | 41 | 6.4 | 485 | 166 | 150 | 391 | 1,124 | one is lost |
| `value-meta` (Ethan) | 31 | 4.3 | 353 | 129 | 149 | 281 | 842 | one is lost |
| `hybrid` | 35 | 5.3 | 545 | 292 | 180 | 419 | 26 | merge (hot fields) |

### What it shows

- **Ethan's numbers reproduce.** Today's shape: 2.2 s and 773 MB in yjs (his room: 2.1 s, 804 MB). His proposal: 353 ms / 129 MB in yjs and 149 ms in yrs (his: 285 ms / 108 MB, 61 ms). Our room is ~35% larger in bytes, which accounts for most of the gap.
- **Most of the speedup comes from storing each icon as one value, not from moving ML `meta` out.** `map-meta` saves 20% of the bytes and a third of the load time (2.17 → 1.46 s); `value` saves 78%. Load time follows the number of Yjs items (40 per icon in `map`, 1 in `value`), not the bytes.
- **One value per icon has two real costs.** A one-field edit becomes a whole-icon write: 842–1,124 bytes instead of 26, about 30–40× more bytes into the update log, the broadcast and the markup-event pipeline. And when two writers change different fields of one icon at the same time (a user and an agent, say), one change is lost.
- **`hybrid` keeps most of the speedup without those costs.** It loads 4× faster than today in yjs (545 ms) and 2.3× faster in yrs, edits stay 26 bytes, and concurrent edits to the editable fields merge. Edits to `rest` fields replace `rest` as a whole, so the split of hot and cold fields matters.
- **The server is not the bottleneck for decode.** yrs loads every shape 2.4–5× faster than yjs. The 2.2 s problem is the browser, which is where render-first open and hydrating Yjs in a worker apply.
- **Typical rooms don't care.** At p99 (2.7 MB) every shape loads in under 60 ms in yjs and 30 ms in yrs.

## Stage 2: engines

| Variant | Engine | Owner placement | Durable before ack | Broadcast |
| --- | --- | --- | --- | --- |
| `yredis` | upstream `@y/redis` 0.1.6 (Node 20), Redis + MinIO | any pod, Redis streams | no ack | after the Redis stream write |
| `rfc` | `services/collab` (Rust, `yrs` 0.28), one pod | single pod, ring later | Postgres log | after commit |
| `actor` | RivetKit 3.0.7 Rust actor + `yrs` | Rivet | actor SQLite | on apply |
| `actor-pg` | same actor | Rivet | Postgres log | on apply |

`actor-pg` separates the two questions the proposals mix: who places the owner, and where the edit is durable.

### Results (2026-11-11, Apple M5 Pro, `map` shape)

One run per variant. Opens are full connect + sync step 2 applied. Warm opens were rerun with each open in a fresh Node process (`harness/run-opens.mjs`), because in the bench run the harness process still held the seed and earlier docs, which inflated its warm opens up to 5× (`rfc` 7.3 MB: 944 ms in the bench, 275 ms fresh). Cold = first open after a graceful restart, from the bench run, and may carry the same inflation. Edits: 200 one-key updates at 20/s, one sender and one peer. Kill: `kill -9` of the owner mid-stream, then reconnect and count delivered edits that are gone. Raw: `results/engines/*.json`.

| | `yredis` | `rfc` | `actor` | `actor-pg` |
| --- | ---: | ---: | ---: | ---: |
| p99 room (2.7 MB) warm open, ms (fresh process, median of 5) | 244 | **101** | 168 | 153 |
| p999 room (7.3 MB) warm open, ms (fresh process, median of 5) | 578 | **275** | 408 | 377 |
| p99 room cold open, ms (bench run) | 1,248 | **170** | 500 | 642 |
| max room (55 MB) | sync timeout | opens: warm 2.4 s, cold 2.8 s (rechecked; bench said 17 s) | cannot (16 MiB gateway cap) | cannot (16 MiB gateway cap) |
| edit ack p50 / p99, ms (p999 room) | no ack | 19 / 82 | 6 / 752 | 20 / 3,959 |
| edit broadcast p50 / p99, ms (p999 room) | 2.5 / 134 | 20 / 96 | 2.4 / 768 | 2.9 / 3,779 |
| kill -9: delivered edits lost | 0 of 717 (10 runs) | 0 of 756 (10 runs) | 0 of 242 (5 runs, 1 never reconnected) | 0 of 280 (5 runs) |
| kill -9: reopen p50 | 76 ms | 44 ms | **101 s** | **106 s** |

### What it shows

- **No engine lost a delivered edit to `kill -9`.** For `rfc`, `actor` and `actor-pg`, delivered means acked. `yredis` has no ack, so delivered means a peer applied it; the client itself never learns whether an edit is durable.
- **Rivet's owner loss is the operational gap.** After a runner is killed, clients wait ~100 s before the doc opens again: the engine holds the dead runner's actors until `pegboard.node_lost_threshold` (40 s) expires, and clients back off while it does. `rfc` and `yredis` reopen in under 100 ms. The threshold can be tuned down, but it is the same fencing-vs-availability trade the RFC already makes with its advisory lock, just with less control.
- **Only `rfc` opened the 55 MB room, and only with its limits raised.** Its defaults close the connection: `COLLAB_MAX_MESSAGE_BYTES` 32 MiB rejects the seed (4413), and `COLLAB_OUT_BYTES` 16 MiB rejects the sync step 2 that follows (4408 slow). The bench raises both to 128/256 MiB. Rivet cannot carry it at all; `yredis` timed out syncing it. A real 40.6 MB room exists in prd, so the RFC needs either chunked sync or raised limits, and it is a reason to fix the doc shape (stage 1) before launch.
- **Opens: `rfc` is fastest wherever all four can open the room.** In fresh processes it opens the 2.7 MB room in 101 ms and the 7.3 MB room in 275 ms, about 1.5× faster than the actors and 2× faster than `yredis`. The actors pay for the extra hop through Rivet's gateway. The bench run showed the actors ahead at 7.3 MB; that was the harness, not the engines.
- **The bench's 17 s warm open for the 55 MB room was mostly the harness.** Rechecked in a fresh process against the same room: a warm open is 2.4 s, made up of ~1.0 s for the server to encode and send the 54.6 MB step 2 and ~1.4 s for yjs to apply it. A cold open after a graceful restart is 2.8 s: the server's load (snapshot fetch from S3, sha256, zstd, yrs apply, claim) adds ~0.3–1 s, which matches the parts timed alone (fetch < 1 s, zstd 0.13 s, sha256 0.07 s, yrs apply 0.44 s). One earlier cold open took 10.5 s, the first of the day after the laptop had been idle for hours; it did not reproduce. In the bench run, the same harness process had just seeded 55 MB and held the earlier docs, so the extra time is likely GC pressure in the harness or the server's post-seed work (snapshot, projector); not yet separated.
- **Even 2.4 s is too slow, and most of it is in the browser.** The yjs apply is ~60% of the warm open. Stage 1's `hybrid` shape loads this room in 545 ms in yjs and makes the step 2 35 MB instead of 55 MB, which is the bigger lever than anything on the server.
- **Durable-before-broadcast costs ~17 ms per edit.** `rfc` broadcasts after the group commit, so peers see edits at ~20 ms p50 instead of ~2.5 ms. At p99 it is 96–110 ms on this laptop, over the RFC's 50 ms target. The others broadcast before the write is durable, so a peer can see an edit that is later lost.
- **The concurrent-docs run is not usable yet.** With 314 docs for 30 s the harness should send ~18,800 updates; it sent 1,887 (`actor`) to 16,989 (`actor-pg`), so the single Node harness process is the bottleneck and the latencies are not comparable. One signal to chase: `rfc` acks reached 732 ms p50 / 3.8 s p99 under that load. Rerun on Linux with the clients split across processes before reading anything into it.

### Caveats for stage 2

- One laptop. `rfc` and its Postgres run in Docker Desktop's VM; the Rivet engine runs in Docker and the actor runner natively; `yredis` runs natively against Redis and MinIO in Docker. Fsync and network costs differ from prd.
- One run per variant; the p99 columns come from 200 edits. Treat differences under 2× as noise.
- `rfc` p50 room failed with `rfc not ready` (the container was still starting); its p99 and p999 rows are complete.
- `actor` and `actor-pg` skip `max` because of the 16 MiB gateway cap; they were run with 5 kill runs instead of 10 to keep the run under an hour, since each one waits ~100 s.

## Stage 2 variants: actor, actor-pg

One Rust crate, `variants/actor/` (`rivetkit` 3.0.7, `yrs` 0.28), builds one binary, `collab-actor`. `COLLAB_STORE` selects the storage mode:

| Variant | `COLLAB_STORE` | Actor name | Pool | Update log |
| --- | --- | --- | --- | --- |
| `actor` | `sqlite` | `doc_sqlite` | `actor-sqlite` | actor SQLite (`updates`, `snapshot` tables) |
| `actor-pg` | `pg` | `doc_pg` | `actor-pg` | Postgres `doc_updates(project_id, seq, update)` + `doc_snapshots`, group commit ≤ 10 ms or 256 rows |

Each project is one actor, keyed by project id. The actor accepts a raw WebSocket through `Actor::on_websocket`, which is the SDK's documented low-level handler. It speaks y-websocket and the type-10 ack. It applies each update to the in-memory `yrs` doc in arrival order and broadcasts it to the project's other sockets. It appends the update to the log and acks the sender only after the write commits. A snapshot is written every 500 updates (`SNAPSHOT_EVERY`), and the log rows it covers are deleted in the same transaction. On wake, the actor loads the snapshot and replays the rows after it.

### Running

```bash
docker compose up -d                       # Rivet engine 3.0.7 on :6420, Postgres 17 on :55442
cargo build --release --manifest-path variants/actor/Cargo.toml
node variants/actor/smoke.mjs --variant actor
node variants/actor/smoke.mjs --variant actor-pg
```

`adapter.up()` does all of this itself: it starts compose, creates the node pool, builds the crate if needed, and starts the runner as a local process. Runner logs and PIDs are in `variants/actor/.run/`. `connect(projectId)` returns `ws://127.0.0.1:6420/gateway/<actor>/websocket/?rvt-method=getOrCreate&rvt-key=…&rvt-runner=<pool>&rvt-token=…` with subprotocol `rivet`. `prepare()` uses fresh actor keys, so every project starts empty. For `actor-pg`, it also truncates the tables. `kill()` sends SIGKILL to the runner process and starts it again. `restart()` does the same with SIGTERM, so actors sleep gracefully. `storageBytes()` reports logical bytes (the sum of update and snapshot blob lengths). For `actor`, it reads them from each prepared actor over HTTP. For `actor-pg`, it reads them from Postgres.

### Deviations from Ethan's design, and blockers

- **Blocker: docs over 16 MiB cannot go through Rivet's gateway.** Rivet documents a 16 MiB hard limit on WebSocket messages and frames, in both directions, and it is not configurable. The engine drops the seed of `max/map.ybin` (54.6 MB) and logs `actor WebSocket tunnel stopped … Message too long: 54617827 > 16777216`. The client never gets an ack. Raising `pubsub.max_message_bytes` (the engine accepts up to 64 MiB) does not change this limit. Engine 3.0.7 has no `guard.websocket_max_frame_size` key. As a result, neither variant can seed or open `over16` or `max` with the contract's one-message seed and one-message sync step 2. Docs up to 16 MiB (p50, p99, p999) are not affected. Splitting updates into chunks would get past the limit, but it would change what is measured, so it is not done here.
- **Broadcast is not gated on durability.** Updates are broadcast when they are applied, and only the ack waits for the commit (Ethan's design). `rfc` broadcasts only after the commit.
- **Actor SQLite is remote.** The default `rivetkit` feature (`sqlite` → `sqlite-remote`) sends SQLite page reads and writes to the engine. The engine replicates them to its log disks and moves them to object storage in the background. This is the SDK's default. The local-file `sqlite-local` feature is not used.
- **Owner-loss recovery after kill -9 takes 40 s or more.** It took 44 s in a clean run. It took 59 to 147 s in runs where the host laptop went into sleep and dark-wake cycles, so measure it on a host that stays awake. Each runner process connects with a new random envoy key. The engine keeps the dead runner's actors until `pegboard.node_lost_threshold` (40 s by default) expires, and then reschedules them. This is stock Rivet behavior and is not tuned here.
- **The two variants use separate actor names and pools.** Actor keys are unique per name, so `actor` and `actor-pg` can run at the same time without sharing actors.
- **Group commit placement.** For `actor`, each actor writes all its queued updates in one SQLite transaction (`execute_batch`). For `actor-pg`, there is one group-commit writer per runner process, shared by all actors. In both variants, a doc's acks stay in order.

## Claims to reproduce

From the actors proposal (measured on prd data) and Rivet's own benchmarks:

| Claim | Value | Stage |
| --- | --- | --- |
| Largest room, today's shape | 40.6 MB, 2.1 s decode, 804 MB heap (yjs) | 1: reproduced (55 MB, 2.2 s, 773 MB) |
| Same room, `value-meta` | 25.4 MB; 285 ms / 108 MB (yjs); 61 ms / 231 MB RSS (yrs) | 1: reproduced in direction (31 MB; 353 ms / 129 MB; 149 ms / 281 MB) |
| Same room gzipped | 6.4 MB | 1: 4.3 MB for `value-meta`, 11 MB for `map` (synthetic numbers compress worse) |
| ywasm vs yjs, icons out to JS | 690 ms vs ~12 ms | 1: yjs side only; `value-meta` 6 ms, `map` 240 ms |
| Room connect today | p50 564 ms, p95 6.1 s | 2: not comparable (no network); `yredis` p99 room 283 ms warm, 1.2 s cold |
| Rivet | cold start 5 ms p99, wake 8 ms p99, durable write 1.07 ms p99 | 2: `actor` p50 room cold open 31 ms, ack p50 6 ms; owner loss ~100 s |
| RFC targets | append-to-broadcast p99 < 50 ms, p95 load < 2 s at 2,000 docs / 10,000 clients | 2: broadcast p99 96–110 ms on one laptop (missed); load run not yet usable |

## Running

```bash
npm install
npm run corpus          # fixtures/ (about 1 GB, gitignored)
npm run shapes          # builds bench/yrs, writes results/shapes.{json,md}
node harness/run-shapes.mjs --only p99,max
```

Needs Node 22 and a Rust toolchain.

## Caveats

- Synthetic icons are about 1.4 KB each in `map`, heavier than the ~1.1 KB implied by the real 40.6 MB room, so `max` matches the real room's icon and item count (36k, ~1.44M) but encodes to about 55 MB. Compare ratios between shapes, not absolute bytes against prd.
- Only `markup.icons` is generated. Real docs also hold ducts, rooms, schedules and comments.
- One machine, no network. Memory numbers are process deltas, not a browser's.
