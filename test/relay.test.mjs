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
async function startAuthority() {
  output = ''
  server = spawn(process.execPath, ['--experimental-transform-types', 'relay/authority.mjs'], {
    env: { ...process.env, PORT: String(PORT), ROOM: 'test', DATA },
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
assert.equal(vars(await c.php('account9.php', { task: '1', usernameoremail: 'alice', password: 'newpw' })).code, '0')
assert.equal((await data(c, 'Alice')).coins, '5000', 'account restored from file after restart')
c.close()
await stopAuthority()
rmSync(dir, { recursive: true, force: true })

console.log('✔ relay + authoritative server: hosting, vault policy, admin console, persistence')
process.exit(0)
