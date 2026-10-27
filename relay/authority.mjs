/**
 * Tiny Tanks authoritative server = the relay + the game backend, run by the owner.
 *
 * In plain Flashback one *player's browser* plays the role of the old
 * multiplayer.gg backend (accounts, rooms, shop, level vault). Here that
 * backend runs in this Node process instead, as a permanent peer in the room
 * that always wins host election. Consequences:
 *   - accounts, XP, coins, unlocks and maps live in a file on this machine
 *     (relay/data/tiny-tanks.json), not in players' browsers
 *   - browsers can't overwrite server records with edited local vaults
 *   - the owner edits anything from the admin console in this terminal
 *
 * Run:   npm run relay          (= node --experimental-transform-types relay/authority.mjs)
 * Env:   PORT=8787  ROOM=lobby  DATA=relay/data/tiny-tanks.json  VAULT_POLICY=new-only|ignore|trust
 *
 * Then expose the port (e.g. `cloudflared tunnel --url http://localhost:8787`)
 * and share  <your site>/?room=<ROOM>&relay=<tunnel host>
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { startRelay, localPeer, rooms } from './server.mjs'

// Node's CloseEvent is missing in some versions; the socket layer references it.
if (typeof globalThis.CloseEvent === 'undefined') {
  globalThis.CloseEvent = class CloseEvent extends Event {
    constructor(type, init = {}) {
      super(type)
      this.code = init.code ?? 0
      this.reason = init.reason ?? ''
      this.wasClean = init.wasClean ?? false
    }
  }
}

const { BaseBridge, createSession, VirtualNetwork } = await import('../src/flashnet/index.ts')
const { tinyTanks } = await import('../src/games/tiny-tanks/game.ts')
const { md5 } = await import('../src/games/tiny-tanks/md5.ts')

const PORT = Number(process.env.PORT) || 8787
const ROOM = (process.env.ROOM || 'lobby').slice(0, 64)
const DATA = resolve(process.env.DATA || 'relay/data/tiny-tanks.json')
const VAULT_POLICY = ['trust', 'new-only', 'ignore'].includes(process.env.VAULT_POLICY) ? process.env.VAULT_POLICY : 'new-only'
/** Lowest id the relay accepts - host election picks the lowest id, so this peer always hosts. */
const AUTHORITY_ID = '00000000'
const ITEM_COUNT = 39 // ids 0..38, see ITEM_COSTS in backend.ts
const NUMERIC_FIELDS = ['xp', 'coins', 'kills', 'deaths', 'wins', 'losses', 'gameshosted', 'minutesplayed', 'premium', 'referrals']
const TEXT_FIELDS = ['customtitle', 'itemsinuse', 'campaign', 'friendlist']

// -- bridge: this process as a peer inside the relay room ---------------------------

class LocalBridge extends BaseBridge {
  constructor(room, id) {
    super(id)
    this.peer = localPeer(room, id, { log })
    if (this.peer.id !== id) throw new Error(`relay gave us id ${this.peer.id}; is another authority running?`)
    this.peer.onJoin = (peerId) => this.peerJoined(peerId)
    this.peer.onLeave = (peerId) => this.peerLeft(peerId)
    this.peer.onMessage = (from, data) => {
      this.peerJoined(from)
      this.received(from, data)
    }
    for (const peerId of this.peer.initialPeers) this.peerJoined(peerId)
  }
  send(peerId, data) {
    if (!this.closed && this.peers.has(peerId)) this.peer.send(1, peerId, data)
  }
  broadcast(data) {
    if (!this.closed && this.peers.size > 0) this.peer.send(0, '', data)
  }
  onClose() {
    this.peer.leave()
  }
}

// -- persistence -------------------------------------------------------------------

function loadSaved() {
  if (!existsSync(DATA)) return null
  try {
    return JSON.parse(readFileSync(DATA, 'utf8'))
  } catch (error) {
    console.error(`could not read ${DATA}:`, error.message)
    process.exit(1)
  }
}

let saveTimer = null
function save(now = false) {
  if (!game.server) return
  if (!now) {
    if (saveTimer) return
    saveTimer = setTimeout(() => { saveTimer = null; save(true) }, 2000)
    return
  }
  mkdirSync(dirname(DATA), { recursive: true })
  const tmp = DATA + '.tmp'
  writeFileSync(tmp, JSON.stringify(game.server.saveState(), null, 2))
  renameSync(tmp, DATA)
}

// -- the session ---------------------------------------------------------------------

const saved = loadSaved()
const game = { server: null, ctx: null }
const definition = tinyTanks({ vaultPolicy: VAULT_POLICY })
const original = definition.createServer
definition.createServer = (ctx) => {
  const server = original(ctx)
  const replicated = server.loadState.bind(server)
  if (saved) {
    server.loadState(saved)
    // Never let a snapshot replicated from a browser (a stand-in host while we
    // were down) overwrite the file on disk: the file is the authority.
    server.loadState = () => {}
  } else {
    server.loadState = replicated
  }
  const publish = ctx.publishState
  ctx.publishState = () => { publish(); save() }
  game.server = server
  game.ctx = ctx
  return server
}

startRelay({ port: PORT, log })
const bridge = new LocalBridge(ROOM, AUTHORITY_ID)
const session = await createSession(definition, { net: new VirtualNetwork({}), bridge, settleMs: 50 })
session.on('host-changed', (hostId) => {
  if (hostId !== AUTHORITY_ID) console.warn(`!! host is ${hostId}, not this server - this should not happen`)
})
session.on('join', (peerId) => log(`player connected: ${peerId}`))
session.on('leave', (peerId) => log(`player left: ${peerId}`))
setInterval(() => save(true), 60_000).unref()

const accounts = () => game.server?.backend.accounts ?? new Map()
log(`authoritative Tiny Tanks server ready - room "${ROOM}", ${accounts().size} account(s) in ${DATA}`)
log(`players should open  <your site>/?room=${ROOM}&relay=<this server's public host>`)
console.log(`type "help" for admin commands\n`)

// -- admin console -------------------------------------------------------------------

const HELP = `
  players                         who is connected right now
  accounts                        every account: xp, coins, kills/deaths, wins/losses
  show <name>                     everything about one account
  set <name> <field> <value>      fields: ${NUMERIC_FIELDS.join(' ')}
                                          ${TEXT_FIELDS.join(' ')}
  give <name> <xp|coins> <n>      add (or subtract with a negative n)
  unlock <name> all | <id ...>    give tank parts (ids 0-${ITEM_COUNT - 1})
  lock <name> all | <id ...>      take tank parts away (free parts stay)
  password <name> <new password>  reset a login
  delete <name>                   remove an account
  rooms                           relay rooms and player counts
  save                            write the data file now (also automatic)
  quit                            save and stop
  Level is derived from xp by the game; "set <name> xp <n>" is how you change it.
  Players see changes after they log out and back in.`

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'tanks> ' })
rl.prompt()
rl.on('line', (line) => {
  try {
    const out = run(line.trim())
    if (out) console.log(out)
  } catch (error) {
    console.log(`error: ${error.message}`)
  }
  rl.prompt()
})
rl.on('close', () => shutdown())
process.on('SIGINT', () => shutdown())
process.on('SIGTERM', () => shutdown())

function run(line) {
  if (!line) return ''
  const [cmd, ...args] = line.split(/\s+/)
  const name = args[0]
  switch (cmd.toLowerCase()) {
    case 'help':
      return HELP
    case 'players': {
      const ids = [...(game.server?.players ?? [])]
      return ids.length ? ids.map((id) => `  ${id}`).join('\n') : '  nobody connected'
    }
    case 'rooms':
      return [...rooms].map(([room, m]) => `  ${room}: ${m.size - (room === ROOM ? 1 : 0)} player(s)`).join('\n') || '  none'
    case 'accounts': {
      const rows = [...accounts().values()].sort((a, b) => b.xp - a.xp)
      if (!rows.length) return '  no accounts yet'
      const w = Math.max(4, ...rows.map((a) => a.name.length))
      return [
        `  ${'name'.padEnd(w)}  ${'xp'.padStart(8)}  ${'coins'.padStart(7)}   k/d       w/l   parts`,
        ...rows.map((a) => `  ${a.name.padEnd(w)}  ${String(a.xp).padStart(8)}  ${String(a.coins).padStart(7)}   ${a.kills}/${a.deaths}   ${a.wins}/${a.losses}   ${a.unlocks.length}`),
      ].join('\n')
    }
    case 'show': {
      const a = need(name)
      const { passwordHash, ...rest } = a
      return JSON.stringify(rest, null, 2)
    }
    case 'set': {
      const a = need(name)
      const [, field, ...rest] = args
      const value = rest.join(' ')
      if (NUMERIC_FIELDS.includes(field)) {
        const n = Number(value)
        if (!Number.isFinite(n)) throw new Error(`${field} needs a number`)
        a[field] = Math.max(0, Math.trunc(n))
      } else if (TEXT_FIELDS.includes(field)) {
        a[field] = value
      } else {
        throw new Error(`unknown field "${field}"`)
      }
      return touched(a, `${a.name}.${field} = ${a[field]}`)
    }
    case 'give': {
      const a = need(name)
      const [, field, amount] = args
      if (!['xp', 'coins'].includes(field)) throw new Error('give <name> xp|coins <n>')
      const n = Number(amount)
      if (!Number.isFinite(n)) throw new Error('amount must be a number')
      a[field] = Math.max(0, a[field] + Math.trunc(n))
      return touched(a, `${a.name}.${field} = ${a[field]}`)
    }
    case 'unlock': {
      const a = need(name)
      const ids = args[1] === 'all' ? [...Array(ITEM_COUNT).keys()] : parseIds(args.slice(1))
      a.unlocks = [...new Set([...a.unlocks, ...ids])].sort((x, y) => x - y)
      return touched(a, `${a.name} now has ${a.unlocks.length} part(s)`)
    }
    case 'lock': {
      const a = need(name)
      const ids = args[1] === 'all' ? null : new Set(parseIds(args.slice(1)))
      a.unlocks = ids ? a.unlocks.filter((id) => !ids.has(id)) : []
      return touched(a, `${a.name} now has ${a.unlocks.length} part(s)`)
    }
    case 'password': {
      const a = need(name)
      const pw = args.slice(1).join(' ')
      if (!pw) throw new Error('password <name> <new password>')
      a.passwordHash = md5(pw)
      return touched(a, `password for ${a.name} changed`)
    }
    case 'delete': {
      const a = need(name)
      accounts().delete(a.name.toLowerCase())
      game.server.refresh()
      save(true)
      return `deleted ${a.name}`
    }
    case 'save':
      save(true)
      return `saved to ${DATA}`
    case 'quit':
    case 'exit':
      shutdown()
      return ''
    default:
      return `unknown command "${cmd}" - type help`
  }
}

function need(name) {
  if (!name) throw new Error('which account? (see "accounts")')
  const a = accounts().get(name.toLowerCase())
  if (!a) throw new Error(`no account "${name}"`)
  return a
}

function parseIds(list) {
  const ids = list.map(Number)
  if (!ids.length || ids.some((id) => !Number.isInteger(id) || id < 0 || id >= ITEM_COUNT)) {
    throw new Error(`give part ids between 0 and ${ITEM_COUNT - 1}, or "all"`)
  }
  return ids
}

function touched(account, message) {
  account.updatecounter = (account.updatecounter ?? 0) + 1
  game.server.refresh()
  save(true)
  return message
}

let stopping = false
function shutdown() {
  if (stopping) return
  stopping = true
  try { save(true) } catch (error) { console.error('save failed:', error.message) }
  log('stopped')
  process.exit(0)
}

function log(line) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`)
}
