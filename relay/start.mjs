/**
 * Launcher for the server. The server runs the project's TypeScript sources
 * directly; Node's flags for that have changed between versions, so instead
 * of guessing flags this registers a module hook that transforms .ts files
 * with Node's built-in API (ts-register.mjs). Works on Node 22.13 and newer.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Node ${process.versions.node} is too old - the server needs Node 22.13 or newer (https://nodejs.org).`)
  process.exit(1)
}

// `--tunnel ngrok|cloudflare|off` on the command line = TUNNEL env (so npm scripts work on Windows too).
const argv = process.argv.slice(2)
const env = { ...process.env }
const t = argv.indexOf('--tunnel')
if (t !== -1 && argv[t + 1]) env.TUNNEL = argv[t + 1]

const child = spawn(
  process.execPath,
  // --import takes a URL, not a path (a Windows path like D:\\... would be read as protocol "d:").
  ['--no-warnings=ExperimentalWarning', '--import', pathToFileURL(join(here, 'ts-register.mjs')).href, join(here, 'authority.mjs')],
  { stdio: 'inherit', env },
)
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))
