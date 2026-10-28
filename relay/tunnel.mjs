/**
 * Makes the server reachable from the internet by running a Cloudflare quick
 * tunnel (`cloudflared tunnel --url http://localhost:<port>`) as a child
 * process. No account needed; the public host changes every start.
 *
 * Install cloudflared once:
 *   https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/
 *   (Ubuntu/Debian: see the .deb there; macOS: brew install cloudflared;
 *    Windows: winget install Cloudflare.cloudflared)
 *
 * The owner can also run a tunnel by hand (or use ngrok etc.) and set
 * PUBLIC_HOST=<host> - then nothing is started here.
 */
import { spawn } from 'node:child_process'

// A quick tunnel's address is a random name under trycloudflare.com. The API
// host (api.trycloudflare.com) shows up in cloudflared's error messages, so it
// is excluded explicitly.
const HOST_RE = /https:\/\/((?!api\.)[a-z0-9-]+\.trycloudflare\.com)/i
const RETRY_DELAYS_MS = [3000, 8000, 15000, 30000, 60000]

export function startTunnel({ port, log, onHost }) {
  const state = { status: 'starting', host: null, error: null, child: null, attempt: 0 }
  let retryTimer = null

  const handle = {
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
      child = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      return fail(`could not start cloudflared: ${error.message}`)
    }
    state.child = child
    state.status = 'starting'

    let found = false
    const recent = [] // last lines of cloudflared's output, for the error report
    const watch = (chunk) => {
      const text = String(chunk)
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed) recent.push(trimmed.length > 200 ? trimmed.slice(0, 200) + '…' : trimmed)
      }
      while (recent.length > 6) recent.shift()
      if (found) return
      const match = HOST_RE.exec(text)
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
      if (error.code === 'ENOENT') {
        fail('cloudflared is not installed - see relay/README.md ("One-time setup"), or run your own tunnel and set PUBLIC_HOST=')
      } else {
        fail(`cloudflared failed: ${error.message}`)
      }
    })
    child.on('exit', (code) => {
      if (state.status === 'stopped' || state.status === 'unavailable') return
      const wasUp = state.status === 'up'
      state.status = 'down'
      state.host = null
      const reason = recent.filter((l) => /ERR|error|fail/i.test(l)).at(-1) ?? recent.at(-1) ?? ''
      state.error = `cloudflared exited (code ${code})${reason ? ': ' + reason.replace(/^.*?(ERR|error)/i, '$1') : ''}`
      log(`!! tunnel ${wasUp ? 'went down' : 'could not start'}: ${state.error}`)
      if (wasUp) onHost(null)
      const delay = RETRY_DELAYS_MS[Math.min(state.attempt - 1, RETRY_DELAYS_MS.length - 1)]
      log(`   retrying the tunnel in ${delay / 1000} s (attempt ${state.attempt + 1})${state.attempt >= 3 ? " - if this keeps failing, Cloudflare's free quick tunnels may be having trouble; try again in a few minutes, or run ngrok and set PUBLIC_HOST=" : ''}`)
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
