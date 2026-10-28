/**
 * Relay + authoritative server integration test.
 *
 * Spawns relay/authority.mjs as the owner would, connects two "browsers"
 * through the WebSocket bridge, and checks: the server always hosts, accounts
 * register against it, edited browser vaults are rejected, admin console
 * commands change accounts live, and everything survives a restart.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (typeof globalThis.CloseEvent === 'undefined') {
  globalThis.CloseEvent = class CloseEvent extends Event { constructor(t, i = {}) { super(t); this.code = i.code ?? 0 } }
}

const { websocketBridge, createSession, VirtualNetwork } = await import('../src/flashnet/index.ts')
const { tinyTanks, BACKEND_ENDPOINT } = await import('../src/games/tiny-tanks/game.ts')
const { SECRET } = await import('../src/games/tiny-tanks/backend.ts')
const { md5 } = await import('../src/games/tiny-tanks/md5.ts')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PORT = 18790
const dir = mkdtempSync(join(tmpdir(), 'tt-relay-'))
const DATA = join(dir, 'tiny-tanks.json')

// -- the owner's server -----------------------------------------------------------

let server = null
let output = ''
process.on('uncaughtException', (e) => { server?.kill('SIGKILL'); console.error(e); process.exit(1) })
process.on('unhandledRejection', (e) => { server?.kill('SIGKILL'); console.error(e); process.exit(1) })
async function startAuthority() {
  output = ''
  server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', '--import', './relay/ts-register.mjs', 'relay/authority.mjs'], {
    env: { ...process.env, PORT: String(PORT), ROOM: 'test', DATA, ADMIN_KEY: 'test-key', RELAY_PING_MS: '200', PUBLIC_HOST: 'test.example.com', MAX_PLAYERS: '2' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  server.stdout.on('data', (d) => (output += d))
  server.stderr.on('data', (d) => { if (!/ExperimentalWarning|trace-warnings/.test(String(d))) output += d })
  const deadline = Date.now() + 15_000
  while (!output.includes('authoritative Tiny Tanks server ready')) {
    if (Date.now() > deadline) throw new Error('authority did not start:\n' + output)
    await sleep(50)
  }
}
const admin = async (line) => {
  const before = output.length
  server.stdin.write(line + '\n')
  await sleep(150)
  return output.slice(before)
}
const stopAuthority = async () => {
  const exited = new Promise((resolve) => server.once('exit', resolve))
  server.stdin.write('quit\n')
  await exited
  await sleep(200)
}

// -- a "browser" ------------------------------------------------------------------

const browser = async (selfId) => {
  const net = new VirtualNetwork()
  const bridge = await websocketBridge({ relay: `localhost:${PORT}`, room: 'test', selfId })
  const session = await createSession(tinyTanks(), { net, bridge, settleMs: 300 })
  const proxy = session.ruffleConfig().socketProxy.find(({ host, port }) => `${host}:${port}` === BACKEND_ENDPOINT)
  const ws = new WebSocket(proxy.proxyUrl)
  ws.binaryType = 'arraybuffer'
  let buffer = ''
  let nextId = 1
  const pending = new Map()
  const vaults = []
  ws.onmessage = (event) => {
    buffer += new TextDecoder().decode(new Uint8Array(event.data))
    let end
    while ((end = buffer.indexOf('\0')) !== -1) {
      const message = JSON.parse(buffer.slice(0, end))
      buffer = buffer.slice(end + 1)
      if (message.t === 'php') pending.get(message.id)?.(message.body)
      if (message.t === 'vault') vaults.push(message)
    }
  }
  await new Promise((resolve) => (ws.onopen = resolve))
  const send = (m) => ws.send(new TextEncoder().encode(JSON.stringify(m) + '\0'))
  return {
    session,
    bridge,
    vaults,
    hello: (accounts = [], maps = []) => send({ t: 'hello', accounts, maps }),
    php: (script, params) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); send({ t: 'php', id, script, params }) }),
    close: () => { ws.close(); session.leave() },
  }
}
const vars = (body) => Object.fromEntries(new URLSearchParams(body))

// ====================================================================================

await startAuthority()

const a = await browser('aaaaaaaaaaaaaaaa')
const b = await browser('bbbbbbbbbbbbbbbb')
await sleep(300)
assert.equal(a.session.hostId, '00000000', 'the server hosts, not a browser')
assert.equal(b.session.hostId, '00000000')
assert.equal(a.session.isHost, false)

// register + login against the server
a.hello()
assert.equal(vars(await a.php('account9.php', { task: '2', username: 'Alice', password: 'pw' })).code, '0', 'registered')
const login = vars(await a.php('account9.php', { task: '1', usernameoremail: 'alice', password: 'pw' }))
assert.equal(login.code, '0')
const data = async (page, name) => vars(await page.php('account9.php', { task: '3', username: name }))
assert.equal((await data(a, 'Alice')).coins, '0')

// a browser offering a doctored vault for a known account is ignored (new-only policy)
b.hello([{ id: 1, name: 'Alice', passwordHash: md5('pw'), xp: 999999, coins: 999999, updatecounter: 9999, unlocks: [] }])
await sleep(200)
assert.equal((await data(b, 'Alice')).coins, '0', 'cheated vault rejected')

// unknown accounts in a vault are migrated once
b.hello([{ id: 7, name: 'Bob', passwordHash: md5('bobpw'), xp: 1500, coins: 40, updatecounter: 3, unlocks: [3] }])
await sleep(200)
assert.equal(vars(await b.php('account9.php', { task: '1', usernameoremail: 'bob', password: 'bobpw' })).code, '0', 'migrated account logs in')
assert.equal((await data(b, 'Bob')).coins, '40', 'old progress migrated')

// the page's first contact: GET / describes the server and the gameplay mode
const describe = async () => (await fetch(`http://localhost:${PORT}/`)).json()
assert.deepEqual((({ game, room, mode }) => ({ game, room, mode }))(await describe()), { game: 'tiny-tanks', room: 'test', mode: 'relay' })
assert.match(await admin('mode'), /gameplay mode: relay/)
assert.match(await admin('mode p2p'), /gameplay mode: p2p/)
assert.equal((await describe()).mode, 'p2p')
assert.match(await admin('mode nope'), /mode must be relay or p2p/)
await admin('mode relay')

// the admin panel's API: key required, state, mode, account edits
const admin_api = async (path, body, keyHeader = 'test-key') => {
  const res = await fetch(`http://localhost:${PORT}/admin/api/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-admin-key': keyHeader, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: await res.json() }
}
assert.equal((await fetch(`http://localhost:${PORT}/admin`)).status, 200, 'panel page served')
// player cap: a third browser is refused with "full" and the page can tell
await assert.rejects(websocketBridge({ relay: `localhost:${PORT}`, room: 'test', selfId: 'dddddddddddddddd' }), /full/)
assert.equal((await admin_api('state')).data.players, 2)
assert.equal((await admin_api('state')).data.maxPlayers, 2)

// share link: built from the public host and the remembered game page
let st = (await admin_api('state')).data
assert.equal(st.tunnel.status, 'manual')
assert.equal(st.tunnel.host, 'test.example.com')
assert.equal(st.site, '')
assert.equal((await admin_api('site', { site: 'not a url' })).status, 400)
st = (await admin_api('site', { site: 'https://me.github.io/tiny-tanks/' })).data.state
assert.equal(st.shareLink, 'https://me.github.io/tiny-tanks/?room=test&relay=test.example.com')
assert.match(await admin('link'), /me\.github\.io\/tiny-tanks\/\?room=test&relay=test\.example\.com/)

assert.equal((await admin_api('state', null, 'wrong')).status, 401, 'key required')
st = (await admin_api('state')).data
assert.equal(st.mode, 'relay')
assert.ok(st.accounts.some((x) => x.name === 'Alice' && x.online === true), 'alice listed and online')
assert.ok(!('passwordHash' in st.accounts[0]), 'hashes never leave the server')
assert.ok(st.online.some((p) => p.playerId === 'aaaaaaaaaaaaaaaa' && p.accounts.includes('Alice')), 'online players mapped to accounts')
// ping is measured by the relay; the page's NAT probe result is reported and shown
a.bridge.report({ nat: 'symmetric' })
await sleep(500)
st = (await admin_api('state')).data
const pa = st.online.find((p) => p.playerId === 'aaaaaaaaaaaaaaaa')
assert.ok(Number.isInteger(pa.rtt) && pa.rtt >= 0 && pa.rtt < 1000, `rtt measured: ${pa.rtt}`)
assert.equal(pa.nat, 'symmetric')
assert.equal(st.online.find((p) => p.playerId === 'bbbbbbbbbbbbbbbb').nat, 'unknown')
assert.match(await admin('players'), /p2p:symmetric/)
assert.equal((await admin_api('mode', { mode: 'p2p' })).data.state.mode, 'p2p')
await admin_api('mode', { mode: 'relay' })
assert.equal((await admin_api('account', { action: 'give', name: 'Bob', field: 'coins', amount: 10 })).data.state.accounts.find((x) => x.name === 'Bob').coins, 50)
assert.equal((await admin_api('account', { action: 'unlock', name: 'Bob', ids: [5, 6] })).data.state.accounts.find((x) => x.name === 'Bob').unlocks.join(), '3,5,6')
assert.equal((await admin_api('account', { action: 'lock', name: 'Bob', ids: [3] })).data.state.accounts.find((x) => x.name === 'Bob').unlocks.join(), '5,6')
assert.equal((await admin_api('account', { action: 'set', name: 'Bob', field: 'customtitle', value: 'The Boss' })).data.state.accounts.find((x) => x.name === 'Bob').customtitle, 'The Boss')
assert.equal((await admin_api('account', { action: 'set', name: 'Bob', field: 'passwordHash', value: 'x' })).status, 400, 'unknown field rejected')
assert.equal((await admin_api('account', { action: 'give', name: 'Nobody', field: 'coins', amount: 1 })).status, 400)
assert.equal((await admin_api('account', { action: 'delete', name: 'Bob' })).data.state.accounts.some((x) => x.name === 'Bob'), false)

// titles are operator-controlled: a normal player's in-game "set title" is refused, a VIP's is accepted
assert.equal(vars(await a.php('account9.php', { task: '11', username: 'Alice', usertitle: 'Hacker', password: md5('pw') })).code, '2', 'title request refused')
assert.equal((await data(a, 'Alice')).customtitle, '', 'title unchanged')
await admin_api('account', { action: 'set', name: 'Alice', field: 'special', value: 1 })
assert.equal((await data(a, 'Alice')).special, '1', 'VIP flag reaches the game')
assert.equal(vars(await a.php('account9.php', { task: '11', username: 'Alice', usertitle: 'The%20Boss', password: md5('pw') })).code, '0', 'VIP may set own title')
assert.equal((await data(a, 'Alice')).customtitle, 'The Boss')
await admin_api('account', { action: 'set', name: 'Alice', field: 'special', value: 0 })

// admin console edits reach the game immediately
assert.match(await admin('accounts'), /Alice/)
assert.match(await admin('give alice coins 5000'), /coins = 5000/)
assert.match(await admin('set alice xp 12345'), /xp = 12345/)
assert.match(await admin('unlock alice all'), /39 part\(s\)/)
assert.match(await admin('set nobody xp 1'), /no account/)
const after = await data(a, 'Alice')
assert.equal(after.coins, '5000')
assert.equal(after.xp, '12345')
assert.equal(after.totalunlocks, '39')

// password reset
await admin('password alice newpw')
assert.equal(vars(await a.php('account9.php', { task: '1', usernameoremail: 'alice', password: 'pw' })).code, '2', 'old password dead')
assert.equal(vars(await a.php('account9.php', { task: '1', usernameoremail: 'alice', password: 'newpw' })).code, '0')

// persisted to disk, survives a restart, and the server reclaims hosting
a.close(); b.close()
await stopAuthority()
const file = JSON.parse(readFileSync(DATA, 'utf8'))
assert.equal(file.backend.accounts.find((x) => x.name === 'Alice').coins, 5000, 'saved to file')
assert.equal(file.backend.accounts.find((x) => x.name === 'Alice').passwordHash, md5('newpw'))

await startAuthority()
const c = await browser('cccccccccccccccc')
await sleep(300)
assert.equal(c.session.hostId, '00000000')
assert.equal((await admin_api('state')).data.site, 'https://me.github.io/tiny-tanks/', 'game page remembered across restarts')
assert.equal(vars(await c.php('account9.php', { task: '1', usernameoremail: 'alice', password: 'newpw' })).code, '0')
assert.equal((await data(c, 'Alice')).coins, '5000', 'account restored from file after restart')
c.close()
await stopAuthority()
rmSync(dir, { recursive: true, force: true })

console.log('✔ relay + authoritative server: hosting, vault policy, admin console, persistence')
process.exit(0)
