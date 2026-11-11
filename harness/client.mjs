// One y-websocket client: sync step 1/2/update, awareness ignored, type-10 acks matched FIFO.
import WebSocket from 'ws'
import * as Y from 'yjs'
import * as sync from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

const MSG_SYNC = 0
const MSG_ACK = 10
const MSG_REJECT = 11
export const now = () => Number(process.hrtime.bigint()) / 1e6

export class Client {
  constructor({ url, protocols = [], headers = {} }) {
    this.url = url
    this.protocols = protocols
    this.headers = headers
    this.doc = new Y.Doc()
    this.pending = [] // send times awaiting ack, FIFO
    this.ackMs = []
    this.acked = 0
    this.rejects = 0
    this.closed = null
    this.doc.on('update', (u, origin) => {
      if (origin === this) return
      const e = encoding.createEncoder()
      encoding.writeVarUint(e, MSG_SYNC)
      sync.writeUpdate(e, u)
      this.send(encoding.toUint8Array(e))
    })
  }

  send(frame) {
    if (this.ws.readyState !== WebSocket.OPEN) return
    this.pending.push(now())
    this.ws.send(frame)
  }

  // Resolves with ms from socket start to the server's sync step 2 applied.
  connect(timeoutMs = 120000) {
    const t0 = now()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`sync timeout ${this.url}`)), timeoutMs)
      this.ws = new WebSocket(this.url, this.protocols, { headers: this.headers, maxPayload: 256 * 1024 * 1024, perMessageDeflate: false })
      this.ws.binaryType = 'arraybuffer'
      this.ws.on('error', (err) => { clearTimeout(timer); reject(err) })
      this.ws.on('open', () => {
        const e = encoding.createEncoder()
        encoding.writeVarUint(e, MSG_SYNC)
        sync.writeSyncStep1(e, this.doc)
        this.ws.send(encoding.toUint8Array(e)) // step 1 is not an update: no ack expected
      })
      this.ws.on('close', (code, reason) => {
        this.closed = { code, reason: reason.toString() }
        clearTimeout(timer)
        this.onClosed?.(this.closed)
        reject(new Error(`closed ${code} ${reason}`))
      })
      this.ws.on('message', (data) => {
        const d = decoding.createDecoder(new Uint8Array(data))
        const type = decoding.readVarUint(d)
        if (type === MSG_SYNC) {
          const e = encoding.createEncoder()
          encoding.writeVarUint(e, MSG_SYNC)
          const kind = sync.readSyncMessage(d, e, this.doc, this)
          if (encoding.length(e) > 1) this.send(encoding.toUint8Array(e)) // our step 2 reply
          if (kind === sync.messageYjsSyncStep2 && !this.synced) {
            this.synced = now() - t0
            clearTimeout(timer)
            resolve(this.synced)
          }
          this.onSync?.(kind)
        } else if (type === MSG_ACK || type === MSG_REJECT) {
          const sent = this.pending.shift()
          if (type === MSG_ACK) {
            this.acked++
            if (sent != null) this.ackMs.push(now() - sent)
          } else this.rejects++
          this.onAck?.(type)
        }
      })
    })
  }

  // Waits until every frame sent so far is acked (ack variants only).
  drain(timeoutMs = 120000) {
    if (this.pending.length === 0) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ack timeout, ${this.pending.length} pending`)), timeoutMs)
      this.onClosed = (c) => { clearTimeout(timer); reject(new Error(`closed ${c.code} ${c.reason} with ${this.pending.length} pending`)) }
      this.onAck = () => {
        if (this.pending.length === 0) { clearTimeout(timer); this.onAck = null; resolve() }
      }
    })
  }

  close() {
    this.ws?.removeAllListeners('close')
    this.ws?.on('close', () => {})
    this.ws?.close()
    this.doc.destroy()
  }
}
