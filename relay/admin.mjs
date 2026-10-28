/**
 * The owner's admin panel: a single HTML page + a small JSON API, served by
 * the relay's HTTP server under /admin. Protected by a secret key, because the
 * server is reachable from the internet while the tunnel is up.
 *
 *   GET  /admin                      the page (key goes in the URL fragment: /admin#<key>)
 *   GET  /admin/api/state            everything the page shows
 *   POST /admin/api/mode             { mode: "relay" | "p2p" }
 *   POST /admin/api/account          { action, name, ... }  action: set | give | unlock | lock | password | delete
 *   POST /admin/api/site             { site: "https://you.github.io/tiny-tanks/" }
 *   POST /admin/api/save
 *
 * Every API call carries the key in the `x-admin-key` header.
 */
import { readFileSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'admin.html'), 'utf8')

export function adminHandler({ key, actions: getActions, log }) {
  const keyBuf = Buffer.from(key)
  const authorized = (req) => {
    const given = Buffer.from(String(req.headers['x-admin-key'] ?? ''))
    return given.length === keyBuf.length && timingSafeEqual(given, keyBuf)
  }
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://relay')
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(HTML)
      return true
    }
    if (!url.pathname.startsWith('/admin/api/')) return false

    if (!authorized(req)) {
      json(res, 401, { error: 'wrong or missing admin key' })
      return true
    }
    const route = url.pathname.slice('/admin/api/'.length)
    const actions = getActions()

    if (req.method === 'GET' && route === 'state') {
      json(res, 200, actions.state())
      return true
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return true
    }

    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 64 * 1024) req.destroy()
    })
    req.on('end', () => {
      let input = {}
      try {
        input = body ? JSON.parse(body) : {}
      } catch {
        return json(res, 400, { error: 'invalid JSON' })
      }
      try {
        let message
        switch (route) {
          case 'mode':
            message = actions.setMode(input.mode)
            break
          case 'save':
            message = actions.save()
            break
          case 'site':
            message = actions.setSite(input.site)
            break
          case 'account': {
            const { action, name } = input
            switch (action) {
              case 'set': message = actions.set(name, input.field, input.value); break
              case 'give': message = actions.give(name, input.field, input.amount); break
              case 'unlock': message = actions.unlock(name, input.ids); break
              case 'lock': message = actions.lock(name, input.ids); break
              case 'password': message = actions.password(name, input.password); break
              case 'delete': message = actions.delete(name); break
              default: throw new Error(`unknown action "${action}"`)
            }
            break
          }
          default:
            return json(res, 404, { error: 'no such endpoint' })
        }
        json(res, 200, { ok: true, message, state: actions.state() })
      } catch (error) {
        json(res, 400, { error: error.message })
      }
    })
    return true
  }
}
