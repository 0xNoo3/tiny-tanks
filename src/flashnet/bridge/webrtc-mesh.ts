import { BaseBridge } from './bridge.ts'
import type { Bridge } from './bridge.ts'
import type { Unsubscribe } from '../events.ts'

export interface WebRtcMeshOptions {
  /**
   * A bridge that already reaches every peer (e.g. the relay). It carries only
   * the WebRTC handshake (offers, answers, ICE candidates) as small JSON
   * messages; game data then flows browser-to-browser.
   */
  signal: Bridge
  /** ICE servers (STUN/TURN). */
  rtcConfig?: RTCConfiguration
  /** Called whenever the number of connected mesh peers changes. */
  onStats?: (stats: { connected: number; wanted: number }) => void
  debug?: boolean
}

type SignalMessage =
  | { t: 'rtc'; k: 'hello' }
  | { t: 'rtc'; k: 'offer'; sdp: string }
  | { t: 'rtc'; k: 'answer'; sdp: string }
  | { t: 'rtc'; k: 'ice'; c: RTCIceCandidateInit }
  | { t: 'rtc'; k: 'bye' }

interface Link {
  pc: RTCPeerConnection
  channel: RTCDataChannel | null
  /** ICE candidates that arrived before the remote description. */
  pendingIce: RTCIceCandidateInit[]
  remoteSet: boolean
  retry: number
}

const RETRY_MS = [1500, 3000, 6000, 10_000]

/**
 * Full-mesh WebRTC data channels between browsers, signaled over another
 * bridge. Peers announce themselves with `hello`; of any two peers that have
 * both said hello, the one with the lower id makes the offer. Peers that never
 * say hello (a Node-side relay authority, say) are simply never connected to.
 *
 * Delivery is ordered and reliable per peer, like the original Flash
 * NetStream, so the RTMFP router can use it unchanged.
 */
export function webrtcMeshBridge(options: WebRtcMeshOptions): WebRtcMeshBridge {
  return new WebRtcMeshBridge(options)
}

export class WebRtcMeshBridge extends BaseBridge {
  #signal: Bridge
  #rtcConfig: RTCConfiguration
  #debug: boolean
  #onStats?: WebRtcMeshOptions['onStats']
  #links = new Map<string, Link>()
  #known = new Set<string>() // peers that said hello
  #retries = new Map<string, ReturnType<typeof setTimeout>>()
  #nextRetry = new Map<string, number>()
  #unsubs: Unsubscribe[] = []

  constructor({ signal, rtcConfig = {}, onStats, debug = false }: WebRtcMeshOptions) {
    super(signal.selfId)
    this.#signal = signal
    this.#rtcConfig = rtcConfig
    this.#onStats = onStats
    this.#debug = debug

    this.#unsubs.push(
      signal.on('message', (peerId, data) => this.#onSignal(peerId, data)),
      signal.on('join', (peerId) => this.#say(peerId, { t: 'rtc', k: 'hello' })),
      signal.on('leave', (peerId) => {
        this.#known.delete(peerId)
        const timer = this.#retries.get(peerId)
        if (timer) clearTimeout(timer)
        this.#retries.delete(peerId)
        this.#drop(peerId, 'signal peer left')
        this.#report()
      }),
      signal.on('close', () => this.close()),
    )
    for (const peerId of signal.peers) this.#say(peerId, { t: 'rtc', k: 'hello' })
  }

  send(peerId: string, data: Uint8Array): void {
    if (this.closed) return
    const channel = this.#links.get(peerId)?.channel
    if (channel && channel.readyState === 'open') channel.send(data)
  }

  protected onClose(): void {
    for (const off of this.#unsubs) off()
    for (const timer of this.#retries.values()) clearTimeout(timer)
    this.#retries.clear()
    for (const peerId of [...this.#links.keys()]) {
      this.#say(peerId, { t: 'rtc', k: 'bye' })
      this.#drop(peerId, 'closing')
    }
    this.#known.clear()
  }

  /** Mesh health: how many peers are connected vs. how many announced themselves. */
  get stats(): { connected: number; wanted: number } {
    return { connected: this.peers.size, wanted: this.#known.size }
  }

  // -- signaling -----------------------------------------------------------------

  #say(peerId: string, message: SignalMessage): void {
    this.#signal.send(peerId, new TextEncoder().encode(JSON.stringify(message)))
  }

  #onSignal(peerId: string, data: Uint8Array): void {
    if (this.closed || data.length === 0 || data[0] !== 0x7b /* '{' */) return
    let message: SignalMessage
    try {
      message = JSON.parse(new TextDecoder().decode(data)) as SignalMessage
    } catch {
      return
    }
    if (message?.t !== 'rtc') return
    switch (message.k) {
      case 'hello':
        if (!this.#known.has(peerId)) {
          this.#known.add(peerId)
          this.#say(peerId, { t: 'rtc', k: 'hello' }) // so the other side learns about us too
          this.#report()
        }
        // Lower id offers; the other side waits for the offer.
        if (this.selfId < peerId && !this.#links.has(peerId)) void this.#offer(peerId)
        break
      case 'offer':
        void this.#answer(peerId, message.sdp)
        break
      case 'answer': {
        const link = this.#links.get(peerId)
        if (!link) return
        void link.pc
          .setRemoteDescription({ type: 'answer', sdp: message.sdp })
          .then(() => this.#flushIce(link))
          .catch((error) => this.#log('answer failed', peerId, error))
        break
      }
      case 'ice': {
        const link = this.#links.get(peerId)
        if (!link) return
        if (link.remoteSet) void link.pc.addIceCandidate(message.c).catch(() => {})
        else link.pendingIce.push(message.c)
        break
      }
      case 'bye':
        this.#known.delete(peerId)
        this.#drop(peerId, 'peer said bye')
        break
    }
  }

  // -- connections ---------------------------------------------------------------

  #create(peerId: string): Link {
    const pc = new RTCPeerConnection(this.#rtcConfig)
    const link: Link = { pc, channel: null, pendingIce: [], remoteSet: false, retry: this.#nextRetry.get(peerId) ?? 0 }
    this.#nextRetry.delete(peerId)
    this.#links.set(peerId, link)
    pc.onicecandidate = (event) => {
      if (event.candidate) this.#say(peerId, { t: 'rtc', k: 'ice', c: event.candidate.toJSON() })
    }
    pc.onconnectionstatechange = () => {
      this.#log(peerId, 'connection', pc.connectionState)
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.#lost(peerId, link)
    }
    pc.ondatachannel = (event) => this.#attach(peerId, link, event.channel)
    return link
  }

  async #offer(peerId: string): Promise<void> {
    const link = this.#create(peerId)
    this.#attach(peerId, link, link.pc.createDataChannel('game', { ordered: true }))
    try {
      const offer = await link.pc.createOffer()
      await link.pc.setLocalDescription(offer)
      this.#say(peerId, { t: 'rtc', k: 'offer', sdp: offer.sdp ?? '' })
    } catch (error) {
      this.#log('offer failed', peerId, error)
      this.#lost(peerId, link)
    }
  }

  async #answer(peerId: string, sdp: string): Promise<void> {
    const existing = this.#links.get(peerId)
    if (existing) this.#drop(peerId, 'renegotiating')
    const link = this.#create(peerId)
    try {
      await link.pc.setRemoteDescription({ type: 'offer', sdp })
      await this.#flushIce(link)
      const answer = await link.pc.createAnswer()
      await link.pc.setLocalDescription(answer)
      this.#say(peerId, { t: 'rtc', k: 'answer', sdp: answer.sdp ?? '' })
    } catch (error) {
      this.#log('answer failed', peerId, error)
      this.#lost(peerId, link)
    }
  }

  async #flushIce(link: Link): Promise<void> {
    link.remoteSet = true
    for (const candidate of link.pendingIce.splice(0)) await link.pc.addIceCandidate(candidate).catch(() => {})
  }

  #attach(peerId: string, link: Link, channel: RTCDataChannel): void {
    link.channel = channel
    channel.binaryType = 'arraybuffer'
    channel.onopen = () => {
      link.retry = 0
      this.#nextRetry.delete(peerId)
      this.#log(peerId, 'channel open')
      this.peerJoined(peerId)
      this.#report()
    }
    channel.onmessage = (event: MessageEvent) => {
      const data = event.data
      if (data instanceof ArrayBuffer) this.received(peerId, new Uint8Array(data))
    }
    channel.onclose = () => {
      if (this.#links.get(peerId) === link) this.#lost(peerId, link)
    }
  }

  /** A link died on its own: tear down and, if the peer is still around, try again (lower id re-offers). */
  #lost(peerId: string, link: Link): void {
    if (this.#links.get(peerId) !== link) return
    const attempt = link.retry
    this.#drop(peerId, 'link lost')
    if (this.closed || !this.#known.has(peerId) || !this.#signal.peers.has(peerId)) return
    const delay = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!
    this.#log(peerId, `retrying in ${delay} ms`)
    this.#retries.set(
      peerId,
      setTimeout(() => {
        this.#retries.delete(peerId)
        if (this.closed || this.#links.has(peerId) || !this.#signal.peers.has(peerId)) return
        this.#nextRetry.set(peerId, attempt + 1)
        if (this.selfId < peerId) void this.#offer(peerId)
        else this.#say(peerId, { t: 'rtc', k: 'hello' }) // nudge the offerer
      }, delay),
    )
  }

  #drop(peerId: string, why: string): void {
    const link = this.#links.get(peerId)
    if (!link) return
    this.#links.delete(peerId)
    try {
      link.channel?.close()
    } catch { /* ignore */ }
    try {
      link.pc.close()
    } catch { /* ignore */ }
    this.#log(peerId, 'dropped:', why)
    this.peerLeft(peerId)
    this.#report()
  }

  #report(): void {
    this.#onStats?.(this.stats)
  }

  #log(...values: unknown[]): void {
    if (this.#debug) console.log('[webrtc-mesh]', ...values)
  }
}
