// Smoke test for actor / actor-pg:
//   node variants/actor/smoke.mjs [--variant actor|actor-pg] [--seed fixtures/max/map.ybin]
// Two clients on one project; A's edit reaches B and A gets an ack; kill -9 the runner; a new
// client still sees the edit (and the seeded doc, if --seed is given).
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const { values: args } = parseArgs({
  options: { variant: { type: 'string', default: 'actor' }, seed: { type: 'string' } },
});
const adapter = (await import(`../${args.variant}/adapter.mjs`)).default;
const t0 = performance.now();
const log = (...a) => console.log(`[${((performance.now() - t0) / 1000).toFixed(2)}s]`, ...a);
const until = (what, cond, ms = 60_000) => new Promise((resolve, reject) => {
  const end = Date.now() + ms;
  const tick = () => {
    if (cond()) return resolve();
    if (Date.now() > end) return reject(new Error(`timeout: ${what}`));
    setTimeout(tick, 5);
  };
  tick();
});

function client(label, projectId) {
  const doc = new Y.Doc();
  const c = { label, doc, synced: false, acks: [], closed: false };
  const { url, protocols, headers } = adapter.connect(projectId);
  const ws = new WebSocket(url, protocols, { headers, maxPayload: 256 * 1024 * 1024 });
  ws.binaryType = 'arraybuffer';
  c.ws = ws;
  c.open = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.on('close', () => { c.closed = true; });
  ws.on('message', (data) => {
    const dec = decoding.createDecoder(new Uint8Array(data));
    const type = decoding.readVarUint(dec);
    if (type === 10) return void c.acks.push(decoding.readVarUint(dec));
    if (type !== 0) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    const sub = syncProtocol.readSyncMessage(dec, enc, doc, 'remote');
    if (sub === syncProtocol.messageYjsSyncStep2) c.synced = true;
    if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
  });
  doc.on('update', (update, origin) => {
    if (origin === 'remote') return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeUpdate(enc, update);
    ws.send(encoding.toUint8Array(enc));
  });
  c.close = () => ws.close();
  return c;
}

const icons = (c) => c.doc.getMap('markup.icons');

await adapter.up();
log(`${adapter.name}: stack up`);
const project = 'smoke';
await adapter.prepare([project]);

let seedIcons = 0;
if (args.seed) {
  const bytes = readFileSync(args.seed);
  const S = client('seed', project);
  await S.open;
  await until('seed synced', () => S.synced);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeUpdate(enc, bytes);
  const t = performance.now();
  S.ws.send(encoding.toUint8Array(enc));
  await until('seed ack', () => S.acks.some((s) => s > 0) || S.closed, 600_000);
  if (S.closed) throw new Error('seed socket closed before ack (gateway message limit?)');
  const probe = new Y.Doc();
  Y.applyUpdate(probe, bytes);
  seedIcons = probe.getMap('markup.icons').size;
  log(`seed ${(bytes.length / 1e6).toFixed(1)} MB acked (seq ${Math.max(...S.acks)}) in ${(performance.now() - t).toFixed(0)} ms, ${seedIcons} icons`);
  S.close();
}

const A = client('A', project);
const B = client('B', project);
await Promise.all([A.open, B.open]);
await until('A and B synced', () => A.synced && B.synced);
log('A and B synced');

const seqBefore = 0; // the edit is the project's first logged update; acks of 0 answer empty step 2s
const sent = performance.now();
icons(A).set('smoke-icon', 'hello from A');
await until('B received edit', () => icons(B).get('smoke-icon') === 'hello from A');
const bcastMs = performance.now() - sent;
await until('A acked', () => Math.max(-1, ...A.acks) > seqBefore);
log(`B received A's edit in ${bcastMs.toFixed(1)} ms; A ack seq=${A.acks.at(-1)} in ${(performance.now() - sent).toFixed(1)} ms`);
A.close();
B.close();

const bytesBefore = await adapter.storageBytes();
log(`storageBytes=${bytesBefore}`);

const k = performance.now();
await adapter.kill();
log(`kill -9 + runner restart in ${(performance.now() - k).toFixed(0)} ms`);

// Like a y-websocket client: reconnect until the project's owner is back.
const r = performance.now();
let C;
let attempts = 0;
for (;;) {
  attempts += 1;
  C = client('C', project);
  try {
    await C.open;
    await until('C synced', () => C.synced || C.closed, 10_000);
    if (C.synced) break;
  } catch {}
  C.ws.terminate();
  if (performance.now() - r > 180_000) throw new Error('C never synced');
  await new Promise((res) => setTimeout(res, 500));
}
log(`C synced after ${(performance.now() - r).toFixed(0)} ms (${attempts} connect attempts)`);
const got = icons(C).get('smoke-icon');
const okEdit = got === 'hello from A';
const okSeed = !args.seed || icons(C).size === seedIcons + 1;
log(`after kill: smoke-icon=${JSON.stringify(got)}, icons=${icons(C).size}`);
C.close();

console.log(okEdit && okSeed ? `PASS ${adapter.name}` : `FAIL ${adapter.name}`);
process.exit(okEdit && okSeed ? 0 : 1);
