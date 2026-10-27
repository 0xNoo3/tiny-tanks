# The server

Two programs, pick one:

| Command              | What runs on your PC                                   | Who owns accounts            |
|----------------------|--------------------------------------------------------|------------------------------|
| `npm run relay`      | relay **+ the game backend + admin console**           | you (file on disk)           |
| `npm run relay:plain`| relay only; a player's browser still runs the backend  | each player's browser        |

Neither needs `npm install`. `relay:plain` runs on Node.js 18+; `npm run relay`
runs the TypeScript sources directly and needs Node.js 22.7 or newer.

## Play night, step by step

1. **Start the server** in a terminal inside the project folder:

       npm run relay

   You'll see `authoritative Tiny Tanks server ready` and a `tanks>` prompt.
   Leave it running.

2. **Make it reachable from the internet.** Easiest: a free Cloudflare quick
   tunnel, no account needed. Install `cloudflared` once
   (https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/),
   then in a second terminal:

       cloudflared tunnel --url http://localhost:8787

   It prints a URL like `https://brave-lion-1234.trycloudflare.com`. Copy the
   host part. It changes every time you start the tunnel. (ngrok works too:
   `ngrok http 8787`.)

3. **Share the link.** Everyone opens:

       https://<you>.github.io/<repo>/?room=lobby&relay=brave-lion-1234.trycloudflare.com

   `room` must be the room the server hosts (`lobby` unless you set `ROOM=`).
   Add `&debug` to see connection logs in the browser console (F12).

4. When you're done: type `quit` at the `tanks>` prompt (it saves), close the
   tunnel. Accounts are in `relay/data/tiny-tanks.json` - back that file up.

## Admin console

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
rooms / save / quit
```

Level is computed from XP by the game, so `set alice xp 50000` is how you
change a level. Players see changes after they log out and back in.

## Settings (environment variables)

- `PORT` - listen port, default `8787`
- `ROOM` - the room the server hosts, default `lobby` (other room codes still
  work peer-hosted, without the server's accounts)
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
still do the RTMFP/Cirrus gameplay routing themselves; the server only owns
the "database" part: logins, stats, shop, level vault.

Things to know:
- If the server crashes while players are in, a browser takes over hosting
  for that session (upstream behaviour); when the server comes back it
  reclaims hosting and its file wins over anything the stand-in host had.
- State snapshots are replicated to connected browsers for that failover.
  They contain MD5 password hashes, so tell players not to reuse real
  passwords - the old multiplayer.gg protocol is from 2011 and has no better
  option.
