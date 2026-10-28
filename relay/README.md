# The server

`npm run relay` starts everything the game needs: the relay that connects the
players' browsers, the Tiny Tanks backend (accounts, rooms, shop, level vault),
an **admin panel in your browser**, and a terminal console. The game page
refuses to run without it, so nobody can play - or hold accounts - except
through you.

Needs Node.js 22.13 or newer (any later version works - the launcher transforms the TypeScript sources itself, no flags); no `npm install`.

## The admin panel

When the server starts it prints a line like

    admin panel:  http://localhost:8787/admin#Kx9...

Open that address in your browser. The part after `#` is the admin key - it
protects the panel, because the server is reachable from the internet while
your tunnel is up. The key is generated once and stored in
`relay/data/admin.key`, so the address stays the same every time (set
`ADMIN_KEY=...` to choose your own). Don't share it.

The panel shows:

- **Gameplay mode** - a switch between Relay and Peer-to-peer (details below).
- **Share link** - tonight's link, filled in by the server once its tunnel is up; one Copy button.
- **Online now** - every connected browser: which account it's logged into,
  its **ping** to this server, and a **P2P check**. The check is a test each
  player's browser runs on connect (it asks two STUN servers how it looks from
  outside): *ok* = direct connections should work; *symmetric NAT* = direct
  connections usually fail, the TURN fallback may or may not save it;
  *blocked* = no WebRTC at all. Next to the mode switch the panel sums it up:
  "all N passed" or "peer-to-peer would leave these players out". Switch to
  Relay for a night where anyone is flagged.
- **Accounts** - every player ever registered, sorted by XP, with a green dot
  when online. Per player: **Give** XP or coins (negative takes away), **Edit**
  every field and tick tank parts on or off, **All parts** in one click, set
  a password, delete. Changes save instantly and reach the player the next
  time they log in.

It refreshes every 3 seconds. The terminal console (`help`) does the same
things if you prefer typing.

## Where everything is stored (persistence)

One file: `relay/data/tiny-tanks.json`. It holds every account (name, MD5
password hash, kills/deaths/wins/losses, XP, coins, unlocked parts, loadout,
title, minutes played, campaign progress, friend list) and every map saved to
the level vault.

- The server **loads** it at startup. If it's missing, it starts empty.
- It is **written** 2 seconds after any change (a match ends, a purchase, an
  admin edit), once a minute regardless, and when you `quit`. Writes go to a
  temp file first and are then renamed, so a crash mid-write can't corrupt it.
- Nothing is stored in players' browsers that the server trusts: a browser
  offering a local copy of an account the server already knows is ignored.

So accounts persist as long as that file exists. **Back it up** (copy it
somewhere) now and then - that's the whole server state. To move the server to
another PC, copy `relay/data/` along with the project.

## Two gameplay modes - your choice each night

Accounts, stats and the shop always go through your server. Where the match
itself (tank positions, shots) travels is up to you:

| Mode (panel switch or `MODE=` env) | Gameplay packets            | Ping     | Works for                                  |
|------------------------------------|-----------------------------|----------|--------------------------------------------|
| **Relay** (default)                | through your server         | +5-20 ms | everyone (any ISP, NAT, country)            |
| **Peer-to-peer**                   | browser-to-browser (WebRTC) | lowest   | most home broadband; fails on mobile data / carrier-grade NAT |

Start in Relay when unsure. Once everyone is connected, look at the P2P
check in the panel: if it says all passed, flip to Peer-to-peer and players
reload; if anyone is flagged, stay on Relay. The check is a strong hint, not
a guarantee - if someone still can't get into a match, switch back. In
Peer-to-peer a free shared TURN relay is the fallback for difficult networks -
it helps but isn't guaranteed.

In Peer-to-peer the browsers find each other **through your server** (it
carries the WebRTC handshake), so no public signaling service is involved;
only the game packets themselves go direct. The panel then shows each player's
**mesh**, e.g. `mesh 2/3` = directly connected to 2 of the 3 other players.
Everyone should show the full count within a few seconds of joining; a player
stuck below it can't reach some others and will fail to join their matches -
switch to Relay for that night.

## Play night, step by step

1. **Start the server** in a terminal inside the project folder, with the
   tunnel of your choice:

       npm run server     # ngrok tunnel (you pick the region; usually the lower ping)
       npm run relay      # Cloudflare quick tunnel (no account; the datacenter is Cloudflare's pick)

   It starts the game backend, the admin panel, and the tunnel that makes it
   reachable from the internet. After a few seconds it prints:

       SHARE THIS LINK WITH YOUR FRIENDS:
       https://you.github.io/tiny-tanks/?room=lobby&relay=brave-lion-1234.trycloudflare.com

   The same link, with a Copy button, is at the top of the admin panel.

2. **Send the link.** It changes every time the server starts (the tunnel
   gets a new address), so send it fresh each night. Add `&debug` for
   connection logs in the browser console (F12).

3. When you're done: type `quit` at the `tanks>` prompt or press Ctrl+C
   (both save and close the tunnel).

**One-time setup - ngrok** (`npm run server`): free account at
https://ngrok.com, install it (Windows: `winget install ngrok.ngrok`; others:
https://ngrok.com/download), then run the `ngrok config add-authtoken ...`
line shown on your ngrok dashboard once. Region defaults to `in` (Mumbai);
set `NGROK_REGION=ap` (Singapore), `eu`, `us`, `jp`, `au` or `sa` to change
it. The free tier allows a handful of connections and ~1 GB/month - fine for
a group of friends. Players never see ngrok's "visit site" page; the game
page skips it.

**One-time setup - Cloudflare** (`npm run relay`): install `cloudflared`
(free, no account):
https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/
- Ubuntu/Debian: download the `.deb` from that page, `sudo dpkg -i cloudflared*.deb`
- macOS: `brew install cloudflared` · Windows: `winget install Cloudflare.cloudflared`

**Which one?** Check your own row in the panel after opening the *tunnel*
link yourself: that ping is what the tunnel alone adds for everyone. Under
~80 ms is good; 200+ means that provider routed you far away tonight - try
the other one. (Your own play link should use `relay=localhost:8787`
instead, which skips the tunnel entirely.)

And tell the server your game page once, so the link is complete - either
`SITE=https://you.github.io/tiny-tanks/ npm run relay`, the `site` console
command, or the box in the panel. It's remembered in `relay/data/settings.json`.

**Your own tunnel**: run anything you like and start the server with
`PUBLIC_HOST=<its host> npm run relay`; the built-in tunnel is then skipped.
`TUNNEL=off` disables it entirely.

## Terminal console

Type `help` at the `tanks>` prompt. The commands:

```
players                         who is connected right now
accounts                        every account: xp, coins, kills/deaths, wins/losses
show <name>                     everything about one account
set <name> <field> <value>      xp coins kills deaths wins losses gameshosted minutesplayed premium
                                customtitle itemsinuse campaign friendlist
give <name> <xp|coins> <n>      add (negative n subtracts)
unlock <name> all | <id ...>    give tank parts (ids 0-38)
lock <name> all | <id ...>      take parts away (the free starter parts always stay)
password <name> <new password>  reset a login
delete <name>                   remove an account
mode [relay|p2p]                show or switch gameplay mode (players reload)
link                            print the share link again
site <url>                      set your game page URL (remembered)
admin                           print the admin panel address again
rooms / save / quit
```

Level is computed from XP by the game, so `set alice xp 50000` is how you
change a level. Players see changes after they log out and back in.

## Ranks and titles

The game derives level from XP (`level = floor(sqrt(xp) / 10)`) and shows a
rank for it: New Recruit (0), Private (1), Corporal (3), Sergeant (5),
Sergeant Major (10), Lieutenant (15), Captain (20), Major (30), Colonel (40+).
So XP is the lever: 160 000 XP is a Colonel.

`customtitle`, when not empty, replaces the rank on screen ("Server Owner",
"Clan Leader", ...). Only you can set it - the game's own "change title"
button appears only for accounts with `special` = 1 (the original game's VIP
flag, which also tints their rooms and maps in the lobby), and the server
refuses title requests from anyone else even if sent by hand. Set `special`
from the panel's Edit dialog if you want to let someone pick their own.

## Settings (environment variables)

- `PORT` - listen port, default `8787`
- `MAX_PLAYERS` - most browsers allowed at once, default `10`; extra ones see "server is full"
- `MODE` - `relay` (default) or `p2p`, see above
- `ADMIN_KEY` - the admin panel key (default: random, stored in `relay/data/admin.key`)
- `SITE` - your game page URL (remembered in `relay/data/settings.json`)
- `TUNNEL` - `cloudflare` (default), `ngrok` or `off`; `npm run server` / `npm run relay` set it for you
- `NGROK_REGION` - ngrok region, default `in` (Mumbai)
- `PUBLIC_HOST` - use this public address instead of starting a tunnel
- `RELAY_PING_MS` - how often each connection is pinged for the ping display, default 5000
- `ROOM` - the room the server hosts, default `lobby`; the link's `?room=` must match
- `DATA` - where accounts are saved, default `relay/data/tiny-tanks.json`
- `VAULT_POLICY` - what to do with the account copy a browser offers on
  connect. `new-only` (default): import accounts the server has never seen,
  so progress from peer-to-peer days migrates once; known accounts are never
  overwritten. `ignore`: never import. `trust`: upstream behaviour, merges
  everything - this lets players edit their own stats, so avoid it.

Example: `ROOM=friday PORT=9000 npm run relay`
(on Windows PowerShell: `$env:ROOM="friday"; npm run relay`).

## Running it permanently

Any host with Node and WebSocket support works (small VPS, Fly.io, Render,
Oracle's always-free VM). Set `PORT` if the host assigns one, keep `DATA` on
persistent storage, and put it behind HTTPS - an `https://` page can only open
`wss://` connections. `GET /` returns JSON with the rooms in use.

## How it works

The relay forwards bytes between browsers in the same room and announces
joins/leaves; it never looks inside. `authority.mjs` additionally joins the
room as a peer with the lowest possible id (`00000000`). Flashback elects the
lowest id as host, so this process always wins and runs the backend. Browsers
still do the RTMFP/Cirrus gameplay routing themselves - via the server in
`relay` mode or over a separate WebRTC mesh in `p2p` mode; the server owns the
"database" part either way: logins, stats, shop, level vault. The page asks
`GET /` on the server for the mode before connecting, and refuses to run
without a Tiny Tanks server answering.

Things to know:
- If the server stops while players are in, their pages return to the
  "offline" screen; nobody's browser takes over. Restart it and they reload.
- `relay/server.mjs` alone (`node relay/server.mjs`) is just the relay with no
  backend - the game page will refuse it. It exists as the building block for
  `authority.mjs`.
- State snapshots are replicated to connected browsers for that failover.
  They contain MD5 password hashes, so tell players not to reuse real
  passwords - the old multiplayer.gg protocol is from 2011 and has no better
  option.
