import { createSession, trysteroBridge, VirtualNetwork, websocketBridge } from "../../flashnet/index.ts";
import { joinRoom, selfId as p2pId } from "@trystero-p2p/mqtt";
import { GAME_VERSION } from "./backend.ts";
import { BACKEND_ENDPOINT, tinyTanks } from "./game.ts";
import { RtmfpRouter } from "./rtmfp.ts";

type RufflePlayerElement = HTMLElement & {
  load?: (config: object) => unknown;
  ruffle?: () => { load(config: object): unknown };
};

declare global {
  interface Window {
    RufflePlayer: {
      newest(): {
        createPlayer?: () => RufflePlayerElement;
        createPlayerElement?: () => RufflePlayerElement;
      };
    };
    tabPressed: () => void;
    changeText: (text: string) => void;
  }
}

const params = new URLSearchParams(location.search);
const roomCode = params.get("room") ?? "lobby";
const relay = params.get("relay"); // the owner's server (relay/authority.mjs) - required
const debug = params.has("debug");
const VAULT_KEY = "tiny-tanks.vault.v1";
const SWF_URL = "http://www.multiplayer.gg/tt/TinyTanksLive.swf";

// ExternalInterface calls the SWF makes on its home site.
window.tabPressed = () => {};
window.changeText = () => {};

// -- local vault: accounts and authored maps persist in this browser --------------

interface Vault {
  accounts: Array<{ name: string }>;
  maps: Array<{ name: string; author: string }>;
}

const loadVault = (): Vault => {
  try {
    const parsed = JSON.parse(localStorage.getItem(VAULT_KEY) ?? "{}") as Partial<Vault>;
    return {
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      maps: Array.isArray(parsed.maps) ? parsed.maps : [],
    };
  } catch {
    return { accounts: [], maps: [] };
  }
};

const saveVault = (update: Vault): void => {
  const vault = loadVault();
  for (const account of update.accounts) {
    const index = vault.accounts.findIndex((other) => other.name.toLowerCase() === account.name.toLowerCase());
    if (index === -1) vault.accounts.push(account);
    else vault.accounts[index] = account;
  }
  for (const map of update.maps) {
    const index = vault.maps.findIndex((other) => other.name === map.name && other.author === map.author);
    if (index === -1) vault.maps.push(map);
    else vault.maps[index] = map;
  }
  try {
    localStorage.setItem(VAULT_KEY, JSON.stringify(vault));
  } catch (error) {
    console.warn("[tiny-tanks] could not save vault:", error);
  }
};

/**
 * The page's line to the backend on the session host. Survives host
 * migration (stateful session); requests made while reconnecting are queued.
 */
class BackendClient {
  #ws: WebSocket | null = null;
  #nextId = 1;
  #pending = new Map<number, { resolve: (body: string) => void; payload: string }>();
  #disposed = false;

  constructor(private readonly proxyUrl: string) {
    this.#connect();
  }

  request(script: string, params: Record<string, string>): Promise<string> {
    return new Promise((resolve) => {
      const id = this.#nextId++;
      const payload = JSON.stringify({ t: "php", id, script, params });
      this.#pending.set(id, { resolve, payload });
      this.#send(payload);
      setTimeout(() => {
        if (this.#pending.delete(id)) resolve("code=3");
      }, 15_000);
    });
  }

  /** Offer this browser's vault to the backend (again, e.g. after a host change). */
  announce(): void {
    const vault = loadVault();
    this.#send(JSON.stringify({ t: "hello", accounts: vault.accounts, maps: vault.maps }));
  }

  dispose(): void {
    this.#disposed = true;
    this.#ws?.close();
  }

  #connect(): void {
    if (this.#disposed) return;
    const ws = new WebSocket(this.proxyUrl);
    ws.binaryType = "arraybuffer";
    this.#ws = ws;
    let buffer = "";
    ws.onopen = () => {
      this.announce();
      for (const { payload } of this.#pending.values()) this.#send(payload);
    };
    ws.onmessage = (event) => {
      buffer += new TextDecoder().decode(new Uint8Array(event.data as ArrayBuffer));
      let end;
      while ((end = buffer.indexOf("\0")) !== -1) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message: { t: string; id?: number; body?: string } & Partial<Vault>;
        try {
          message = JSON.parse(raw);
        } catch {
          continue;
        }
        if (message.t === "php" && message.id !== undefined) {
          this.#pending.get(message.id)?.resolve(message.body ?? "");
          this.#pending.delete(message.id);
        } else if (message.t === "vault") {
          saveVault({ accounts: message.accounts ?? [], maps: message.maps ?? [] });
        }
      }
    };
    ws.onclose = () => {
      if (this.#ws === ws) this.#ws = null;
      if (!this.#disposed) setTimeout(() => this.#connect(), 1000);
    };
  }

  #send(payload: string): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(new TextEncoder().encode(payload + "\0"));
  }
}

// -- session --------------------------------------------------------------------

/** Peer id relay/authority.mjs joins with; the lowest possible, so it always hosts. */
const AUTHORITY_ID = "00000000";

/** Replace the player area with a message and stop - the game only runs through the owner's server. */
function halt(title: string, detail: string): never {
  const slot = document.getElementById("player-slot")!;
  slot.innerHTML = "";
  const box = document.createElement("div");
  box.style.cssText =
    "margin:auto;max-width:28rem;padding:2rem;text-align:center;color:#d7e8ee;font:15px/1.6 system-ui,sans-serif";
  const h = document.createElement("h1");
  h.style.cssText = "font-size:1.4rem;margin:0 0 0.6rem";
  h.textContent = title;
  const p = document.createElement("p");
  p.style.cssText = "margin:0;color:#a8b8c0";
  p.textContent = detail;
  box.append(h, p);
  slot.appendChild(box);
  throw new Error(`[tiny-tanks] ${title}`);
}

if (!relay) {
  halt("Tiny Tanks is offline", "This game runs only while the host's server is up. Ask the host for tonight's link - it includes the server address.");
}

/** The server's base URL for plain HTTP (its GET / describes the game mode). */
function httpUrl(host: string): string {
  const trimmed = host.trim().replace(/\/+$/, "");
  if (/^wss?:\/\//.test(trimmed)) return trimmed.replace(/^ws/, "http");
  if (/^https?:\/\//.test(trimmed)) return trimmed;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(trimmed);
  return `${local ? "http" : "https"}://${trimmed}`;
}

// First contact: the server says which room it hosts and where gameplay packets
// should travel ("relay": through it; "p2p": browser-to-browser over WebRTC).
const info = await fetch(httpUrl(relay), { signal: AbortSignal.timeout(8000), cache: "no-store" })
  .then((response) => response.json() as Promise<{ game?: string; room?: string; mode?: string }>)
  .catch(() => halt("Can't reach the server", `No answer from ${relay}. The host may have stopped the server, or the link is from an earlier session.`));
if (info.game !== "tiny-tanks") halt("That's not a Tiny Tanks server", `${relay} answered, but it isn't running the Tiny Tanks server.`);
if (info.room && info.room !== roomCode) {
  halt("Wrong room", `This link says room "${roomCode}" but the server hosts "${info.room}". Ask the host for the current link.`);
}
const gameplayMode: "relay" | "p2p" = info.mode === "p2p" ? "p2p" : "relay";

const net = new VirtualNetwork({ debug });
const bridge = await Promise.race([
  websocketBridge({ relay, room: roomCode, debug }),
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 10_000)),
]).catch(() => halt("Can't reach the server", `No answer from ${relay}. The host may have stopped the server, or the link is from an earlier session.`));
if (debug) console.log("[tiny-tanks] accounts via", relay, "- gameplay:", gameplayMode);
const session = await createSession(tinyTanks({ debug }), {
  net,
  bridge,
  settleMs: 4000,
});
// Only the owner's server may host. If it isn't in the room (plain relay, or
// the authority died) this page would have elected itself - refuse instead,
// so accounts never end up owned by a browser.
if (session.hostId !== AUTHORITY_ID) {
  session.leave();
  halt("The server isn't running", "The relay answered, but the Tiny Tanks server behind it is down. Ask the host to start it (npm run relay) and reload.");
}
session.on("host-changed", (hostId) => {
  if (hostId !== AUTHORITY_ID) location.reload(); // server went away mid-session: come back to the gate
});

/**
 * Can this browser do peer-to-peer? Gather STUN candidates from two servers:
 * none at all means UDP/WebRTC is blocked; the same local port mapped to
 * different public ports means a symmetric NAT (direct connections fail
 * without TURN). Reported to the server so the owner can see who would be
 * stuck in p2p mode. Runs in the background; never delays the game.
 */
async function probeNat(): Promise<"open" | "symmetric" | "blocked" | "unknown"> {
  if (typeof RTCPeerConnection === "undefined") return "blocked";
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }],
  });
  const mapped = new Map<string, Set<number>>(); // local addr:port -> public ports seen
  try {
    pc.createDataChannel("probe");
    const done = new Promise<void>((resolve) => {
      pc.onicecandidate = (event) => {
        const c = event.candidate;
        if (!c) return resolve();
        if (c.type === "srflx" && c.relatedAddress && c.relatedPort !== null && c.port !== null) {
          const key = `${c.relatedAddress}:${c.relatedPort}`;
          if (!mapped.has(key)) mapped.set(key, new Set());
          mapped.get(key)!.add(c.port);
        }
      };
      setTimeout(resolve, 6000);
    });
    await pc.setLocalDescription(await pc.createOffer());
    await done;
  } catch {
    return "unknown";
  } finally {
    pc.close();
  }
  if (mapped.size === 0) return "blocked";
  for (const ports of mapped.values()) if (ports.size > 1) return "symmetric";
  return "open";
}
void probeNat().then((nat) => {
  if (debug) console.log("[tiny-tanks] nat probe:", nat);
  bridge.report({ nat });
});
/**
 * Where the match itself (tank positions, shots - the emulated Cirrus streams)
 * travels. "relay": over the same connection as everything else, through the
 * server. "p2p": a second, browser-to-browser WebRTC mesh; the room name is
 * scoped to this server so two owners' games never meet. STUN-only WebRTC
 * fails behind carrier-grade NAT, hence the TURN entries; the Open Relay
 * Project ones are free but shared - a metered.ca account gives you your own.
 */
const gameplayBridge =
  gameplayMode === "p2p"
    ? trysteroBridge({
        selfId: p2pId,
        room: joinRoom(
          {
            appId: "tiny-tanks-gameplay",
            rtcConfig: {
              iceServers: [
                { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
                { urls: "stun:stun.relay.metered.ca:80" },
                {
                  urls: [
                    "turn:global.relay.metered.ca:80",
                    "turn:global.relay.metered.ca:80?transport=tcp",
                    "turn:global.relay.metered.ca:443",
                    "turns:global.relay.metered.ca:443?transport=tcp",
                  ],
                  username: "openrelayproject",
                  credential: "openrelayproject",
                },
              ],
            },
          },
          `${roomCode}@${relay}`,
        ),
      })
    : session.bridge;
if (debug && gameplayMode === "p2p") {
  gameplayBridge.on("join", (peerId) => console.log("[tiny-tanks] p2p peer joined:", peerId));
  gameplayBridge.on("leave", (peerId) => console.log("[tiny-tanks] p2p peer left:", peerId));
}
const router = new RtmfpRouter({ net, bridge: gameplayBridge, debug });
const backendProxy = session.ruffleConfig().socketProxy.find(
  (proxy) => `${proxy.host}:${proxy.port}` === BACKEND_ENDPOINT,
);
const backend = new BackendClient(backendProxy!.proxyUrl);

/**
 * Rooms this page hosts, as last registered. A new backend host normally
 * restores the replicated state, but after a split-brain merge (two pages
 * that self-elected before seeing each other) the winner never had it - so
 * on every host change we re-offer our vault and re-register our rooms.
 */
const ownRooms = new Map<string, { add: Record<string, string>; join?: Record<string, string> }>();

session.on("host-changed", (hostId, isHost) => {
  console.log("[tiny-tanks] backend host:", hostId, isHost ? "(us)" : "");
  backend.announce();
  for (const room of ownRooms.values()) {
    void backend.request("addnewroom.php", room.add);
    if (room.join) void backend.request("joinroom.php", room.join);
  }
});
if (debug) {
  console.log("[tiny-tanks] self:", session.selfId);
  session.on("join", (peerId) => console.log("[tiny-tanks] peer joined:", peerId));
  session.on("leave", (peerId) => console.log("[tiny-tanks] peer left:", peerId));
}

// -- HTTP: multiplayer.gg and friends --------------------------------------------

/** Fire-and-forget logging endpoints; nobody reads their responses. */
const LOG_SCRIPTS = new Set([
  "igl.php",
  "armorclicklog.php",
  "clicklog.php",
  "logmins2.php",
  "chatlog.php",
  "ailog.php",
  "campaignlog.php",
  "logconnectionattempt.php",
  "loggamecompleted.php",
  "accountlog.php",
]);

const formParams = (body: string, url: URL): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of url.searchParams) result[key] = value;
  for (const [key, value] of new URLSearchParams(body)) result[key] = value;
  return result;
};

/**
 * The game often does `loader = new URLLoader(request); loader.load(request)`.
 * Flash cancels the constructor's load, so the server sees one request and
 * the SWF one COMPLETE. Ruffle runs both. An identical request right after
 * its twin is that phantom first load: leave it pending forever, so the
 * backend acts once and the SWF handles exactly one response.
 */
const recentRequests = new Map<string, number>();
const isDuplicate = (key: string): boolean => {
  const now = Date.now();
  for (const [seen, at] of recentRequests) if (now - at > 2000) recentRequests.delete(seen);
  if (recentRequests.has(key)) return true;
  recentRequests.set(key, now);
  return false;
};

const textResponse = (body: string) => ({ body, headers: { "Content-Type": "text/plain" } });

net.listenHttp(
  (url) => /(^|\.)multiplayer\.gg$/.test(url.hostname),
  async (request, url) => {
    if (url.pathname.endsWith("/TinyTanksLive.swf")) {
      const local = await fetch(new URL(`${import.meta.env.BASE_URL}games/tiny-tanks/TinyTanksLive.swf`, location.origin));
      const response = new Response(await local.arrayBuffer(), {
        status: local.status,
        headers: { "Content-Type": "application/x-shockwave-flash" },
      });
      // Ruffle uses Response.url for loaderInfo.url, which the game's sitelock checks.
      Object.defineProperty(response, "url", { value: url.href });
      return response;
    }
    const script = url.pathname.match(/\/tt\/scripts\/([^/]+)$/)?.[1];
    if (!script) return { status: 404, body: "" };
    if (script === "rtmfp.txt") return textResponse("0");
    if (script === "latestversion.txt") return textResponse(GAME_VERSION);
    if (script === "fglwindow.txt") return textResponse("");
    if (script === "ip_query4.php") return textResponse("city=Flashback&latitude=0&longitude=0");
    const body = request.method === "POST" ? await request.text() : "";
    if (isDuplicate(`${request.method} ${url.href} ${body}`)) return new Promise<never>(() => {});
    if (LOG_SCRIPTS.has(script)) return textResponse("code=0");
    const params = formParams(body, url);
    const address = params.addressstring ?? "";
    if (script === "addnewroom.php") ownRooms.set(address, { add: params });
    else if (script === "joinroom.php" && ownRooms.has(address)) ownRooms.get(address)!.join = params;
    else if (script === "removeroom.php") ownRooms.delete(address);
    return textResponse(await backend.request(script, params));
  },
);

// Everything else off-site (Kongregate API, analytics, YouTube policy files,
// avatar services) is long gone - answer locally instead of leaking requests.
net.listenHttp(
  (url) => url.origin !== location.origin && /^https?:$/.test(url.protocol),
  (_request, url) => {
    if (debug) console.log("[tiny-tanks] blocked", url.href);
    return { status: 404, body: "" };
  },
);

// -- Ruffle ------------------------------------------------------------------------

const ruffleSource = window.RufflePlayer.newest();
const player = (ruffleSource.createPlayerElement ?? ruffleSource.createPlayer)!.call(ruffleSource);
document.getElementById("player-slot")!.appendChild(player);
(player.ruffle?.() ?? player).load!({
  url: SWF_URL,
  base: "http://www.multiplayer.gg/tt/",
  upgradeToHttps: false,
  allowNetworking: "all",
  allowScriptAccess: true,
  autoplay: "on",
  unmuteOverlay: "hidden",
  splashScreen: false,
  maxExecutionDuration: 30,
  letterbox: "on",
  scale: "showAll",
  forceScale: true,
  logLevel: debug ? "info" : "error",
  ...session.ruffleConfig(),
});

window.addEventListener("beforeunload", () => {
  backend.dispose();
  router.dispose();
  session.leave();
  net.dispose();
});
