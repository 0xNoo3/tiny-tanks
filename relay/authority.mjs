/**
 * Tiny Tanks authoritative server = the relay + the game backend + the owner's admin panel.
 *
 * In plain Flashback one *player's browser* plays the role of the old
 * multiplayer.gg backend (accounts, rooms, shop, level vault). Here that
 * backend runs in this Node process instead, as a permanent peer in the room
 * that always wins host election. Consequences:
 *   - accounts, XP, coins, unlocks and maps live in a file on this machine
 *     (relay/data/tiny-tanks.json), not in players' browsers
 *   - browsers can't overwrite server records with edited local vaults
 *   - the owner edits anything from the admin panel (browser) or this terminal
 *
 * Run:   npm run relay          (= node --experimental-transform-types relay/authority.mjs)
 * Env:   PORT=8787  ROOM=lobby  MODE=relay|p2p  DATA=relay/data/tiny-tanks.json
 *        ADMIN_KEY=<secret>     VAULT_POLICY=new-only|ignore|trust
 *        SITE=https://you.github.io/tiny-tanks/   (the game page; remembered once set)
 *        TUNNEL=auto|off        PUBLIC_HOST=<host>  (skip the built-in tunnel, use your own)
 *
 * MODE decides where *gameplay* packets travel; accounts always go through here.
 *   relay  every packet via this server - works for everyone, a few ms slower
 *   p2p    tank positions/shots browser-to-browser over WebRTC - lowest ping,
 *          but fails for players behind carrier-grade NAT or strict firewalls
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { startRelay, localPeer, rooms, peerStats, playerCount, MAX_PLAYERS } from './server.mjs'
import { adminHandler } from './admin.mjs'
import { startTunnel } from './tunnel.mjs'

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
const KEY_FILE = resolve(dirname(DATA), 'admin.key')
const SETTINGS_FILE = resolve(dirname(DATA), 'settings.json')
const TUNNEL = process.env.TUNNEL === 'off' || process.env.PUBLIC_HOST ? 'off' : 'auto'
let MODE = process.env.MODE === 'p2p' ? 'p2p' : 'relay'
const VAULT_POLICY = ['trust', 'new-only', 'ignore'].includes(process.env.VAULT_POLICY) ? process.env.VAULT_POLICY : 'new-only'
/** Lowest id the relay accepts - host election picks the lowest id, so this peer always hosts. */
const AUTHORITY_ID = '00000000'
const ITEM_COUNT = 39 // ids 0..38, see ITEM_COSTS in backend.ts
const NUMERIC_FIELDS = ['xp', 'coins', 'kills', 'deaths', 'wins', 'losses', 'gameshosted', 'minutesplayed', 'premium', 'referrals', 'special']
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
// Everything lives in one JSON file. It is rewritten (atomically, via a temp
// file) 2 s after any change, every minute regardless, and on quit.

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
let lastSaved = null
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
  lastSaved = Date.now()
}

/** Small owner settings that should survive restarts (currently: the game page URL). */
function loadSettings() {
  try {
    return existsSync(SETTINGS_FILE) ? JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) : {}
  } catch {
    return {}
  }
}
function saveSettings() {
  mkdirSync(dirname(SETTINGS_FILE), { recursive: true })
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
}
const settings = loadSettings()
if (process.env.SITE) settings.site = process.env.SITE

/** The link players open, or null until the public host is known. */
function shareLink() {
  const host = publicHost()
  if (!host) return null
  const site = (settings.site || '<your game page>').replace(/\/+$/, '')
  return `${site}/?room=${encodeURIComponent(ROOM)}&relay=${host}`
}
function publicHost() {
  return process.env.PUBLIC_HOST || tunnel?.host || null
}

/** The admin key: from the environment, else a stored random one so the panel URL stays the same. */
function adminKey() {
  if (process.env.ADMIN_KEY) return process.env.ADMIN_KEY
  if (existsSync(KEY_FILE)) return readFileSync(KEY_FILE, 'utf8').trim()
  const key = randomBytes(12).toString('base64url')
  mkdirSync(dirname(KEY_FILE), { recursive: true })
  writeFileSync(KEY_FILE, key + '\n')
  return key
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

const KEY = adminKey()
const startedAt = Date.now()
startRelay({
  port: PORT,
  log,
  info: () => ({ game: 'tiny-tanks', room: ROOM, mode: MODE }),
  onRequest: adminHandler({ key: KEY, actions: () => actions, log }),
})
const bridge = new LocalBridge(ROOM, AUTHORITY_ID)
const session = await createSession(definition, { net: new VirtualNetwork({}), bridge, settleMs: 50 })
session.on('host-changed', (hostId) => {
  if (hostId !== AUTHORITY_ID) console.warn(`!! host is ${hostId}, not this server - this should not happen`)
})
session.on('join', (peerId) => log(`player connected: ${peerId}`))
session.on('leave', (peerId) => log(`player left: ${peerId}`))
setInterval(() => save(true), 60_000).unref()

const accounts = () => game.server?.backend.accounts ?? new Map()
log(`authoritative Tiny Tanks server ready - room "${ROOM}", mode ${MODE}, up to ${MAX_PLAYERS} players, ${accounts().size} account(s) in ${DATA}`)
log(`admin panel:  http://localhost:${PORT}/admin#${KEY}`)
if (!settings.site) log(`tip: set your game page once with  SITE=https://you.github.io/tiny-tanks/ npm run relay  (or in the panel) and the share link below will be complete`)

let tunnel = null
if (TUNNEL === 'auto') {
  log('starting tunnel (cloudflared) ...')
  tunnel = startTunnel({
    port: PORT,
    log,
    onHost: (host) => {
      if (host) {
        log(`public address: ${host}`)
        printShareLink()
      }
    },
  })
} else {
  log(`tunnel: using PUBLIC_HOST=${process.env.PUBLIC_HOST ?? '(none)'}`)
  printShareLink()
}
if (process.stdin.isTTY) console.log(`type "help" for terminal commands\n`)

function printShareLink() {
  const link = shareLink()
  if (link) {
    console.log('')
    console.log('  ===================================================================')
    console.log(`  SHARE THIS LINK WITH YOUR FRIENDS:`)
    console.log(`  ${link}`)
    console.log('  ===================================================================')
    console.log('')
  } else {
    log('no public address yet - run `cloudflared tunnel --url http://localhost:' + PORT + '` yourself, or set PUBLIC_HOST=')
  }
}

// -- actions: shared by the admin panel and the terminal -----------------------------

const publicAccount = (a) => {
  const { passwordHash, ...rest } = a
  return rest
}

const actions = {
  state() {
    const online = (game.server?.online ?? []).map((p) => ({ ...p, ...(peerStats(ROOM, p.playerId) ?? { rtt: null, nat: 'unknown' }) }))
    const onlineNames = new Set(online.flatMap((p) => p.accounts.map((n) => n.toLowerCase())))
    return {
      room: ROOM,
      mode: MODE,
      port: PORT,
      players: playerCount(),
      maxPlayers: MAX_PLAYERS,
      startedAt,
      lastSaved,
      dataFile: DATA,
      site: settings.site ?? '',
      tunnel: { status: TUNNEL === 'off' ? (process.env.PUBLIC_HOST ? 'manual' : 'off') : tunnel?.status ?? 'starting', host: publicHost(), error: tunnel?.error ?? null },
      shareLink: shareLink(),
      itemCount: ITEM_COUNT,
      numericFields: NUMERIC_FIELDS,
      textFields: TEXT_FIELDS,
      online,
      accounts: [...accounts().values()]
        .sort((a, b) => b.xp - a.xp)
        .map((a) => ({ ...publicAccount(a), online: onlineNames.has(a.name.toLowerCase()) })),
      rooms: [...rooms].map(([room, m]) => ({ room, players: m.size - (room === ROOM ? 1 : 0) })),
    }
  },
  setSite(site) {
    const value = String(site ?? '').trim()
    if (value && !/^https?:\/\/\S+$/.test(value)) throw new Error('the game page must be a full http(s) URL')
    settings.site = value
    saveSettings()
    return value ? `game page set to ${value}` : 'game page cleared'
  },
  setMode(mode) {
    if (!['relay', 'p2p'].includes(mode)) throw new Error('mode must be relay or p2p')
    MODE = mode
    log(`gameplay mode -> ${MODE}`)
    return `gameplay mode: ${MODE} - players must reload the page to switch`
  },
  set(name, field, value) {
    const a = need(name)
    if (NUMERIC_FIELDS.includes(field)) {
      const n = Number(value)
      if (!Number.isFinite(n)) throw new Error(`${field} needs a number`)
      a[field] = field === 'special' ? (n ? 1 : 0) : Math.max(0, Math.trunc(n))
    } else if (TEXT_FIELDS.includes(field)) {
      a[field] = String(value ?? '')
    } else {
      throw new Error(`unknown field "${field}"`)
    }
    return touched(a, `${a.name}.${field} = ${a[field]}`)
  },
  give(name, field, amount) {
    const a = need(name)
    if (!['xp', 'coins'].includes(field)) throw new Error('give takes xp or coins')
    const n = Number(amount)
    if (!Number.isFinite(n)) throw new Error('amount must be a number')
    a[field] = Math.max(0, a[field] + Math.trunc(n))
    return touched(a, `${a.name}.${field} = ${a[field]}`)
  },
  unlock(name, ids) {
    const a = need(name)
    const list = ids === 'all' ? [...Array(ITEM_COUNT).keys()] : parseIds(ids)
    a.unlocks = [...new Set([...a.unlocks, ...list])].sort((x, y) => x - y)
    return touched(a, `${a.name} now has ${a.unlocks.length} part(s)`)
  },
  lock(name, ids) {
    const a = need(name)
    const set = ids === 'all' ? null : new Set(parseIds(ids))
    a.unlocks = set ? a.unlocks.filter((id) => !set.has(id)) : []
    return touched(a, `${a.name} now has ${a.unlocks.length} part(s)`)
  },
  password(name, pw) {
    const a = need(name)
    if (!pw) throw new Error('new password required')
    a.passwordHash = md5(pw)
    return touched(a, `password for ${a.name} changed`)
  },
  delete(name) {
    const a = need(name)
    accounts().delete(a.name.toLowerCase())
    game.server.refresh()
    save(true)
    log(`deleted account ${a.name}`)
    return `deleted ${a.name}`
  },
  save() {
    save(true)
    return `saved to ${DATA}`
  },
}

function need(name) {
  if (!name) throw new Error('which account? (see "accounts")')
  const a = accounts().get(String(name).toLowerCase())
  if (!a) throw new Error(`no account "${name}"`)
  return a
}

function parseIds(list) {
  const ids = (Array.isArray(list) ? list : String(list).split(/[\s,]+/)).filter(Boolean).map(Number)
  if (!ids.length || ids.some((id) => !Number.isInteger(id) || id < 0 || id >= ITEM_COUNT)) {
    throw new Error(`give part ids between 0 and ${ITEM_COUNT - 1}, or "all"`)
  }
  return ids
}

function touched(account, message) {
  account.updatecounter = (account.updatecounter ?? 0) + 1
  game.server.refresh()
  save(true)
  log(message)
  return message
}

// -- terminal console ----------------------------------------------------------------

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
  mode [relay|p2p]                show or switch where gameplay packets go (players reload)
  link                            print the share link again
  site <url>                      set your game page URL (remembered)
  admin                           print the admin panel address again
  rooms / save / quit
  Level is derived from xp by the game; "set <name> xp <n>" is how you change it.
  customtitle replaces the rank on screen. special=1 lets that player change
  their own title in-game (VIP flag); everyone else can only get one from you.
  Players see changes after they log out and back in.`

// The console reads commands from stdin. Under a service manager with no
// usable stdin it simply goes quiet (end-of-input is only "quit" when stdin
// was an actual terminal), and the admin panel is the console.
const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'tanks> ' })
if (process.stdin.isTTY) rl.prompt()
rl.on('line', (line) => {
  try {
    const out = run(line.trim())
    if (out) console.log(out)
  } catch (error) {
    console.log(`error: ${error.message}`)
  }
  if (process.stdin.isTTY) rl.prompt()
})
rl.on('close', () => {
  if (process.stdin.isTTY) shutdown()
})

function run(line) {
  if (!line) return ''
  const [cmd, ...args] = line.split(/\s+/)
  const name = args[0]
  switch (cmd.toLowerCase()) {
    case 'help':
      return HELP
    case 'admin':
      return `  http://localhost:${PORT}/admin#${KEY}`
    case 'link':
      return shareLink() ? `  ${shareLink()}` : `  no public address yet (tunnel: ${tunnel?.status ?? 'off'}${tunnel?.error ? ' - ' + tunnel.error : ''})`
    case 'site':
      return actions.setSite(args.join(' '))
    case 'players': {
      const online = actions.state().online
      return online.length
        ? online.map((p) => `  ${p.playerId}  ${String(p.rtt === null ? '?' : p.rtt + ' ms').padStart(7)}  p2p:${p.nat.padEnd(9)} ${p.accounts.join(', ') || '(not logged in)'}`).join('\n')
        : '  nobody connected'
    }
    case 'mode':
      return name ? actions.setMode(name) : `  gameplay mode: ${MODE}`
    case 'rooms':
      return actions.state().rooms.map((r) => `  ${r.room}: ${r.players} player(s)`).join('\n') || '  none'
    case 'accounts': {
      const rows = actions.state().accounts
      if (!rows.length) return '  no accounts yet'
      const w = Math.max(4, ...rows.map((a) => a.name.length))
      return [
        `  ${'name'.padEnd(w)}  ${'xp'.padStart(8)}  ${'coins'.padStart(7)}   k/d       w/l   parts  `,
        ...rows.map((a) => `  ${a.name.padEnd(w)}  ${String(a.xp).padStart(8)}  ${String(a.coins).padStart(7)}   ${a.kills}/${a.deaths}   ${a.wins}/${a.losses}   ${a.unlocks.length}${a.online ? '  online' : ''}`),
      ].join('\n')
    }
    case 'show':
      return JSON.stringify(publicAccount(need(name)), null, 2)
    case 'set':
      return actions.set(name, args[1], args.slice(2).join(' '))
    case 'give':
      return actions.give(name, args[1], args[2])
    case 'unlock':
      return actions.unlock(name, args[1] === 'all' ? 'all' : args.slice(1))
    case 'lock':
      return actions.lock(name, args[1] === 'all' ? 'all' : args.slice(1))
    case 'password':
      return actions.password(name, args.slice(1).join(' '))
    case 'delete':
      return actions.delete(name)
    case 'save':
      return actions.save()
    case 'quit':
    case 'exit':
      shutdown()
      return ''
    default:
      return `unknown command "${cmd}" - type help`
  }
}

let stopping = false
function shutdown() {
  if (stopping) return
  stopping = true
  try { save(true) } catch (error) { console.error('save failed:', error.message) }
  tunnel?.stop()
  log('stopped')
  process.exit(0)
}

function log(line) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`)
}
