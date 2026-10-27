/**
 * Flashback relay - a tiny WebSocket hub so browsers can reach each other when
 * peer-to-peer WebRTC can't connect (mobile data, carrier-grade NAT, strict
 * firewalls, different countries).
 *
 * On its own it holds no game state: every browser connects here, the relay
 * forwards bytes between the browsers in the same room and announces
 * joins/leaves. The game logic keeps running inside the browsers.
 *
 * `authority.mjs` builds on this: it plugs a Node-side peer into a room that
 * runs the Tiny Tanks backend permanently, so the server owns accounts.
 *
 * Zero dependencies - just Node 18+:
 *   node relay/server.mjs            (listens on port 8787, or $PORT)
 *
 * Wire protocol (all frames to/from the browser):
 *   text  JSON  server -> client: {t:"hello", id, peers:[...]}, {t:"join", id}, {t:"leave", id}
 *   text  JSON  client -> server: {t:"hello", id}
 *   binary      client -> server: [flag][idLen][id...][payload]   flag 1 = to one peer, 0 = broadcast (idLen 0)
 *   binary      server -> client: [idLen][fromId...][payload]
 */
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const MAX_PAYLOAD = 1024 * 1024
const PING_MS = 25_000
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** room code -> Map<peerId, Peer> */
export const rooms = new Map()

/** Start the relay. Returns the http server (call .close() to stop). */
export function startRelay({ port = Number(process.env.PORT) || 8787, log = defaultLog } = {}) {
  const http = createServer((req, res) => {
    const stats = [...rooms].map(([room, peers]) => ({ room, players: peers.size }))
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
    res.end(JSON.stringify({ ok: true, service: 'flashback-relay', rooms: stats }))
  })

  http.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key']
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    const url = new URL(req.url ?? '/', 'http://relay')
    const room = (url.searchParams.get('room') || 'lobby').slice(0, 64)
    const client = new SocketPeer(socket, room, log)
    if (head.length) client.feed(head)
  })

  const pinger = setInterval(() => {
    for (const members of rooms.values()) {
      for (const peer of members.values()) {
        if (!(peer instanceof SocketPeer)) continue
        if (!peer.alive) { peer.destroy(); continue }
        peer.alive = false
        peer.sendFrame(0x9, Buffer.alloc(0))
      }
    }
  }, PING_MS)
  pinger.unref()
  http.on('close', () => clearInterval(pinger))

  http.listen(port, () => log(`relay listening on http://localhost:${port}`))
  return http
}

/**
 * Plug an in-process peer into a room (no socket). Returns handles the caller
 * uses as a bridge: `send(flag, target, bytes)` outbound, and `on*` callbacks
 * inbound. The peer stays in the room until `leave()`.
 */
export function localPeer(room, id, { log = defaultLog } = {}) {
  const peer = new LocalPeer(room, id, log)
  peer.join(id)
  return peer
}

// -- room plumbing shared by socket and local peers --------------------------------

class Peer {
  constructor(room, log) {
    this.room = room
    this.log = log
    this.id = null
  }

  get members() {
    return rooms.get(this.room) ?? new Map()
  }

  join(wanted) {
    const members = this.members
    const valid = typeof wanted === 'string' && /^[0-9a-z]{8,32}$/.test(wanted) && !members.has(wanted)
    this.id = valid ? wanted : randomBytes(8).toString('hex')
    if (!rooms.has(this.room)) rooms.set(this.room, members)
    this.sendJson({ t: 'hello', id: this.id, peers: [...members.keys()] })
    for (const other of members.values()) other.sendJson({ t: 'join', id: this.id })
    members.set(this.id, this)
    this.log(`+ ${this.id} joined "${this.room}" (${members.size} online)`)
  }

  /** Forward a payload from this peer to one member or to everyone else. */
  route(targeted, target, body) {
    if (this.id === null) return
    const from = Buffer.from(this.id)
    const frame = Buffer.concat([Buffer.from([from.length]), from, body])
    if (targeted) {
      this.members.get(target)?.sendFrame(0x2, frame)
    } else {
      for (const [otherId, other] of this.members) if (otherId !== this.id) other.sendFrame(0x2, frame)
    }
  }

  leaveRoom() {
    if (this.id === null) return
    const members = rooms.get(this.room)
    if (!members || members.get(this.id) !== this) return
    members.delete(this.id)
    for (const other of members.values()) other.sendJson({ t: 'leave', id: this.id })
    this.log(`- ${this.id} left "${this.room}" (${members.size} online)`)
    if (members.size === 0) rooms.delete(this.room)
    this.id = null
  }
}

class LocalPeer extends Peer {
  constructor(room, id, log) {
    super(room, log)
    this.onJoin = () => {}
    this.onLeave = () => {}
    this.onMessage = () => {}
    this.initialPeers = []
  }

  sendJson(msg) {
    if (msg.t === 'hello') this.initialPeers = msg.peers
    else if (msg.t === 'join') this.onJoin(msg.id)
    else if (msg.t === 'leave') this.onLeave(msg.id)
  }

  sendFrame(opcode, payload) {
    if (opcode !== 0x2) return
    const idLen = payload[0]
    const from = payload.subarray(1, 1 + idLen).toString()
    this.onMessage(from, new Uint8Array(payload.subarray(1 + idLen)))
  }

  /** Outbound, same shape the browser bridge uses. */
  send(flag, target, bytes) {
    this.route(flag === 1, target, Buffer.from(bytes))
  }

  leave() {
    this.leaveRoom()
  }
}

// -- one connected browser ---------------------------------------------------------

class SocketPeer extends Peer {
  constructor(socket, room, log) {
    super(room, log)
    this.socket = socket
    this.alive = true
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.fragmentOpcode = 0
    this.closed = false
    socket.on('data', (chunk) => this.feed(chunk))
    socket.on('close', () => this.onClose())
    socket.on('error', () => this.destroy())
    socket.setNoDelay(true)
  }

  /** Parse as many complete frames as the buffer holds. */
  feed(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    for (;;) {
      const buf = this.buffer
      if (buf.length < 2) return
      const fin = (buf[0] & 0x80) !== 0
      const opcode = buf[0] & 0x0f
      const masked = (buf[1] & 0x80) !== 0
      let length = buf[1] & 0x7f
      let offset = 2
      if (length === 126) {
        if (buf.length < 4) return
        length = buf.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buf.length < 10) return
        const big = buf.readBigUInt64BE(2)
        if (big > BigInt(MAX_PAYLOAD)) return this.destroy()
        length = Number(big)
        offset = 10
      }
      if (length > MAX_PAYLOAD || !masked) return this.destroy() // clients must mask (RFC 6455)
      if (buf.length < offset + 4 + length) return
      const mask = buf.subarray(offset, offset + 4)
      const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + length))
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
      this.buffer = buf.subarray(offset + 4 + length)
      this.onFrame(fin, opcode, payload)
      if (this.closed) return
    }
  }

  onFrame(fin, opcode, payload) {
    switch (opcode) {
      case 0x0: // continuation
        this.fragments.push(payload)
        if (fin) {
          const whole = Buffer.concat(this.fragments)
          this.fragments = []
          this.onMessage(this.fragmentOpcode, whole)
        }
        return
      case 0x1: // text
      case 0x2: // binary
        if (fin) return this.onMessage(opcode, payload)
        this.fragmentOpcode = opcode
        this.fragments = [payload]
        return
      case 0x8: // close
        this.sendFrame(0x8, payload.subarray(0, 2))
        return this.destroy()
      case 0x9: // ping
        return this.sendFrame(0xa, payload)
      case 0xa: // pong
        this.alive = true
        return
      default:
        return this.destroy()
    }
  }

  onMessage(opcode, payload) {
    this.alive = true
    if (opcode === 0x1) {
      let msg
      try { msg = JSON.parse(payload.toString()) } catch { return }
      if (msg?.t === 'hello' && this.id === null) this.join(msg.id)
      return
    }
    if (this.id === null || payload.length < 2) return
    const targeted = payload[0] === 1
    const idLen = payload[1]
    const target = targeted ? payload.subarray(2, 2 + idLen).toString() : null
    this.route(targeted, target, payload.subarray(2 + idLen))
  }

  sendJson(msg) {
    this.sendFrame(0x1, Buffer.from(JSON.stringify(msg)))
  }

  sendFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return
    let header
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, payload.length])
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 126
      header.writeUInt16BE(payload.length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 127
      header.writeBigUInt64BE(BigInt(payload.length), 2)
    }
    this.socket.write(Buffer.concat([header, payload]))
  }

  destroy() {
    if (!this.closed) this.socket.destroy()
    this.onClose()
  }

  onClose() {
    if (this.closed) return
    this.closed = true
    this.leaveRoom()
  }
}

function defaultLog(line) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`)
}

// Run directly: plain relay, no authority.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) startRelay()
