/**
 * Makes the server reachable from the internet by running a tunnel program as
 * a child process and picking its public address out of the output.
 *
 * Two providers:
 *   cloudflare  `cloudflared tunnel --url http://localhost:<port>`  (quick tunnel;
 *               no account; Cloudflare chooses the datacenter - sometimes a far one)
 *   ngrok       `ngrok http --region <region> <port>`  (free account + one-time
 *               `ngrok config add-authtoken`; you choose the region, e.g. "in" =
 *               Mumbai, "ap" = Singapore, "eu", "us")
 *
 * Install once:
 *   cloudflared  https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/
 *   ngrok        https://ngrok.com/download  (Windows: winget install ngrok.ngrok)
 *
 * The owner can also run any tunnel by hand and set PUBLIC_HOST=<host> - then
 * nothing is started here.
 */
import { spawn } from 'node:child_process'

const RETRY_DELAYS_MS = [3000, 8000, 15000, 30000, 60000]

const PROVIDERS = {
  cloudflare: {
    command: 'cloudflared',
    args: (port) => ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'],
    // The API host (api.trycloudflare.com) shows up in error messages - excluded.
    host: /https:\/\/((?!api\.)[a-z0-9-]+\.trycloudflare\.com)/i,
    install: 'cloudflared is not installed - see relay/README.md ("One-time setup")',
    hint: "Cloudflare's free quick tunnels may be having trouble; try again in a few minutes, or use ngrok (npm run server)",
  },
  ngrok: {
    command: 'ngrok',
    args: (port, { region }) => ['http', ...(region ? ['--region', region] : []), '--log', 'stdout', '--log-format', 'logfmt', String(port)],
    host: /url=https:\/\/([a-z0-9.-]+\.ngrok(?:-free)?\.(?:app|dev|io))/i,
    install: 'ngrok is not installed - see relay/README.md ("One-time setup"); Windows: winget install ngrok.ngrok',
    hint: 'if it says authtoken: run the "ngrok config add-authtoken ..." command from https://dashboard.ngrok.com once',
  },
}

export function startTunnel({ provider = 'cloudflare', port, log, onHost, region = null }) {
  const spec = PROVIDERS[provider]
  if (!spec) throw new Error(`unknown tunnel provider "${provider}"`)
  const state = { provider, status: 'starting', host: null, error: null, child: null, attempt: 0 }
  let retryTimer = null

  const handle = {
    get provider() { return provider },
    get status() { return state.status },
    get host() { return state.host },
    get error() { return state.error },
    stop() {
      state.status = 'stopped'
      clearTimeout(retryTimer)
      try { state.child?.kill() } catch { /* already gone */ }
    },
  }

  const launch = () => {
    state.attempt++
    let child
    try {
      child = spawn(spec.command, spec.args(port, { region }), { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      return fail(`could not start ${spec.command}: ${error.message}`)
    }
    state.child = child
    state.status = 'starting'

    let found = false
    const recent = [] // last lines of the tunnel's output, for the error report
    const watch = (chunk) => {
      const text = String(chunk)
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed) recent.push(trimmed.length > 200 ? trimmed.slice(0, 200) + '…' : trimmed)
      }
      while (recent.length > 6) recent.shift()
      if (found) return
      const match = spec.host.exec(text)
      if (!match) return
      found = true
      state.status = 'up'
      state.host = match[1].toLowerCase()
      state.error = null
      onHost(state.host)
    }
    child.stdout.on('data', watch)
    child.stderr.on('data', watch)

    child.on('error', (error) => {
      if (error.code === 'ENOENT') fail(`${spec.install}, or run your own tunnel and set PUBLIC_HOST=`)
      else fail(`${spec.command} failed: ${error.message}`)
    })
    child.on('exit', (code) => {
      if (state.status === 'stopped' || state.status === 'unavailable') return
      const wasUp = state.status === 'up'
      state.status = 'down'
      state.host = null
      const reason = recent.filter((l) => /ERR|error|fail/i.test(l)).at(-1) ?? recent.at(-1) ?? ''
      state.error = `${spec.command} exited (code ${code})${reason ? ': ' + reason.replace(/^.*?(ERR|error)/i, '$1') : ''}`
      log(`!! tunnel ${wasUp ? 'went down' : 'could not start'}: ${state.error}`)
      if (wasUp) onHost(null)
      const delay = RETRY_DELAYS_MS[Math.min(state.attempt - 1, RETRY_DELAYS_MS.length - 1)]
      log(`   retrying the tunnel in ${delay / 1000} s (attempt ${state.attempt + 1})${state.attempt >= 2 ? ' - ' + spec.hint : ''}`)
      retryTimer = setTimeout(launch, delay)
    })

    setTimeout(() => {
      if (state.status === 'starting' && state.child === child) log('tunnel is taking a while to get an address... (still trying)')
    }, 15_000).unref()
  }

  launch()
  return handle

  function fail(message) {
    state.status = 'unavailable'
    state.error = message
    log(`!! ${message}`)
    return handle
  }
}
