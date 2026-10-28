import { BaseBridge } from './bridge.ts'

export interface WebSocketBridgeOptions {
  /**
   * Relay to connect to: a full ws:// or wss:// URL, or just a host name
   * (`abc.trycloudflare.com`, `localhost:8787`) - plain hosts get wss://,
   * localhost gets ws://.
   */
  relay: string
  /** Room code; players must share it to see each other. Default: "lobby". */
  room?: string
  /** Our peer id. Default: random 16 hex chars. */
  selfId?: string
  /** Reconnect automatically if the relay drops. Default: true. */
  reconnect?: boolean
  /** Log connection events to the console. */
  debug?: boolean
}

/**
 * Client-server bridge over a plain WebSocket to `relay/server.mjs`.
 *
 * Unlike the WebRTC bridge this works through any NAT or firewall that allows
 * normal web traffic, at the cost of needing the relay to be running. The
 * returned promise resolves once the relay has acknowledged us and told us who
 * is already in the room, so host election starts with a complete picture.
 *
 * ```ts
 * const bridge = await websocketBridge({ relay: 'abc.trycloudflare.com', room: 'friday' })
 * ```
 */
export function websocketBridge(options: WebSocketBridgeOptions): Promise<WebSocketBridge> {
  const bridge = new WebSocketBridge(options)
  return bridge._ready.then(() => bridge)
}

class WebSocketBridge extends BaseBridge {
  #url: string
  #ws: WebSocket | null = null
  #reconnect: boolean
  #debug: boolean
  #attempt = 0
  #lastReport: Record<string, unknown> | null = null
  #resolveReady: () => void = () => {}
  #rejectReady: (error: Error) => void = () => {}
  readonly _ready: Promise<void>

  constructor({ relay, room = 'lobby', selfId = randomId(), reconnect = true, debug = false }: WebSocketBridgeOptions) {
    super(selfId)
    this.#reconnect = reconnect
    this.#debug = debug
    const base = new URL(normalizeRelay(relay))
    base.searchParams.set('room', room)
    this.#url = base.toString()
    this._ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve
      this.#rejectReady = reject
    })
    this.#connect()
  }

  #connect(): void {
    if (this.closed) return
    const ws = new WebSocket(this.#url)
    ws.binaryType = 'arraybuffer'
    this.#ws = ws
    let greeted = false

    ws.onopen = () => {
      this.#attempt = 0
      ws.send(JSON.stringify({ t: 'hello', id: this.selfId }))
    }

    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        let msg: { t?: string; id?: string; peers?: string[]; at?: number }
        try {
          msg = JSON.parse(event.data)
        } catch {
          return
        }
        if (msg.t === 'full') {
          // The relay is at its player limit: give up, don't reconnect.
          this.#reconnect = false
          this.#rejectReady(new Error('full'))
          return
        }
        if (msg.t === 'ping') {
          ws.send(JSON.stringify({ t: 'pong', at: msg.at }))
          return
        }
        if (msg.t === 'hello') {
          greeted = true
          if (msg.id && msg.id !== this.selfId) {
            // The relay refused our id (collision); nothing we can do mid-session.
            console.warn('[flashnet] relay assigned a different peer id; reload to use it', msg.id)
          }
          for (const peerId of msg.peers ?? []) this.peerJoined(peerId)
          if (this.#debug) console.log('[flashnet] relay connected, peers:', msg.peers)
          if (this.#lastReport) ws.send(JSON.stringify({ t: 'info', ...this.#lastReport }))
          this.#resolveReady()
        } else if (msg.t === 'join' && msg.id) {
          this.peerJoined(msg.id)
        } else if (msg.t === 'leave' && msg.id) {
          this.peerLeft(msg.id)
        }
        return
      }
      const bytes = new Uint8Array(event.data as ArrayBuffer)
      if (bytes.length < 1) return
      const idLen = bytes[0] ?? 0
      const from = new TextDecoder().decode(bytes.subarray(1, 1 + idLen))
      this.peerJoined(from) // tolerate a message racing ahead of its join notice
      this.received(from, bytes.subarray(1 + idLen))
    }

    ws.onclose = () => {
      if (this.#ws !== ws) return
      this.#ws = null
      for (const peerId of [...this.peers]) this.peerLeft(peerId)
      if (this.closed) return
      if (!greeted && !this.#reconnect) {
        this.#rejectReady(new Error(`[flashnet] could not connect to relay ${this.#url}`))
        return
      }
      if (!this.#reconnect) return
      const delay = Math.min(10_000, 500 * 2 ** this.#attempt++)
      if (this.#debug) console.log(`[flashnet] relay lost, reconnecting in ${delay}ms`)
      setTimeout(() => this.#connect(), delay)
    }

    ws.onerror = () => {
      // onclose follows and handles it
    }
  }

  send(peerId: string, data: Uint8Array): void {
    if (this.closed || !this.peers.has(peerId)) return
    this.#transmit(1, peerId, data)
  }

  /** Tell the relay something about this client (shown to its operator, e.g. a NAT probe result). Re-sent after reconnects. */
  report(info: Record<string, unknown>): void {
    this.#lastReport = { ...this.#lastReport, ...info }
    const ws = this.#ws
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'info', ...this.#lastReport }))
  }

  override broadcast(data: Uint8Array): void {
    if (this.closed || this.peers.size === 0) return
    this.#transmit(0, '', data)
  }

  #transmit(flag: 0 | 1, target: string, data: Uint8Array): void {
    const ws = this.#ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const id = new TextEncoder().encode(target)
    const frame = new Uint8Array(2 + id.length + data.length)
    frame[0] = flag
    frame[1] = id.length
    frame.set(id, 2)
    frame.set(data, 2 + id.length)
    ws.send(frame)
  }

  protected onClose(): void {
    const ws = this.#ws
    this.#ws = null
    ws?.close()
  }
}

function normalizeRelay(relay: string): string {
  const trimmed = relay.trim().replace(/\/+$/, '')
  if (/^wss?:\/\//.test(trimmed)) return trimmed
  if (/^https?:\/\//.test(trimmed)) return trimmed.replace(/^http/, 'ws')
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(trimmed)
  return `${local ? 'ws' : 'wss'}://${trimmed}`
}

function randomId(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
