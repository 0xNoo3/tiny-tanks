# Tiny Tanks

Chaz Robinson's *Tiny Tanks* (multiplayer.gg, 2011-2020), playable again in
the browser. Based on [Flashback](https://github.com/freehuntx/flashback) by
freehuntx, trimmed to this one game and extended with an owner-run server.

The original SWF runs in [Ruffle](https://ruffle.rs). Its network traffic is
intercepted in the page and answered by an emulation of the old multiplayer.gg
backend (accounts, rooms, shop, level vault). The game belongs to its creator;
this exists so it can still be played.

## How playing works

The game runs **only while the owner's server is up**. You start
`npm run relay` on your PC, expose it with a free tunnel, and share a link
that includes the server address (`?room=lobby&relay=<host>`). Everyone's
browser connects to your server. Match traffic goes through the server too
(works for everyone) or, if you start it with `MODE=p2p`, browser-to-browser
over WebRTC for the lowest ping.

The server is also the game's backend: accounts, XP, coins, unlocks and maps
live in a file on your machine. Browsers can't host, can't overwrite records,
and you edit anything from an admin panel in your browser (or the terminal). Opening the page
without the server (or with a stale link) shows an "offline" message instead
of the game.

See [relay/README.md](relay/README.md) for the play-night steps and the admin
commands.

## Deploying the game page (once)

The page is static files, built by `npm run build` into `dist/`. The included
GitHub Actions workflow builds and publishes it to GitHub Pages on every push:

1. Push this repository to GitHub.
2. Settings → Pages → Source: **GitHub Actions**.
3. Settings → Actions → General → allow actions to run (needed on forks).
4. Push (or Actions → "Deploy to GitHub Pages" → Run workflow). After ~3
   minutes the game is at `https://<you>.github.io/<repo>/`.

GitHub Pages on a free account requires a **public** repository. For a private
one, point Cloudflare Pages or Netlify at the repo instead: build command
`npm run build`, output `dist`, and set the environment variable
`BASE_PATH=/`.

## Development

```
npm install
npm run dev          # http://localhost:5173 (add ?room=x&relay=localhost:8787 to use a local server)
npm run relay        # owner-run server + admin console on port 8787
npm test
npm run build
```

Query params: `?room=<code>` (must match the server's `ROOM`), `&relay=<host>`
(required), `&debug` (connection and packet log in the browser console).

## Repository layout

```
index.html               Redirects to the game
games/tiny-tanks/        The game page
src/flashnet/            Network lib: virtual sockets/HTTP, host election, migration, bridges
src/games/tiny-tanks/    multiplayer.gg backend emulation + Cirrus/RTMFP routing
public/games/tiny-tanks/ Game assets (patched SWF, configs)
relay/                   The owner-run server (server.mjs = relay, authority.mjs = relay + backend + admin)
tools/tiny-tanks/        SWF patch tooling (replaces flash.net.NetStream with a shim)
test/                    Protocol, migration and server integration tests (Node)
```
