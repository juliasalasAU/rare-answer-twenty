// Rare Answer Twenty — Cloudflare Worker + Durable Object.
// The static page lives in /public (served by Workers Assets). This file handles
// /api/rooms (create a room) and /api/rooms/CODE/ws (the room's WebSocket).

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
const ROUND_COUNT = 20;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === "/api/rooms" && req.method === "POST") {
      for (let attempt = 0; attempt < 6; attempt++) {
        const code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
        const hostToken = crypto.randomUUID();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const res = await stub.fetch("https://room/init", { method: "POST", body: JSON.stringify({ hostToken }) });
        if (res.ok) return json({ code, hostToken });
      }
      return json({ error: "Could not create a room. Try again." }, 503);
    }

    const m = url.pathname.match(/^\/api\/rooms\/([A-Z]{4})\/ws$/);
    if (m) {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
      return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req);
    }

    return new Response("Not found", { status: 404 });
  },
};

export class Room {
  constructor(state) {
    this.state = state;
  }

  async load() {
    return (await this.state.storage.get("data")) || null;
  }
  async save(d) {
    await this.state.storage.put("data", d);
  }

  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/init") {
      const cur = await this.load();
      const live = cur && Date.now() - cur.createdAt < ROOM_TTL_MS && (Object.keys(cur.players).length > 0 || cur.game.phase !== "lobby");
      if (live) return new Response("busy", { status: 409 });
      const { hostToken } = await req.json();
      await this.save({ createdAt: Date.now(), hostToken, game: { phase: "lobby", round: 0, order: null }, players: {} });
      return new Response("ok");
    }

    if (req.headers.get("Upgrade") === "websocket") {
      const cur = await this.load();
      if (!cur || Date.now() - cur.createdAt > ROOM_TTL_MS) return new Response("No such room", { status: 404 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      server.serializeAttachment({ pid: null, isHost: false });
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not found", { status: 404 });
  }

  // ---- views -------------------------------------------------------------
  view(d, att) {
    const g = d.game;
    const revealedUpTo = g.phase === "reveal" || g.phase === "done" ? g.round : g.round - 1;
    const players = {};
    for (const [id, p] of Object.entries(d.players)) {
      const guesses = {};
      for (const [k, v] of Object.entries(p.guesses || {})) {
        if (id === att.pid || Number(k) <= revealedUpTo) guesses[k] = v;
      }
      players[id] = { name: p.name, guesses, answered: g.phase === "guess" && (p.guesses || {})[String(g.round)] != null };
    }
    return { type: "state", game: g, players, you: att.pid, isHost: att.isHost, joined: !!(att.pid && d.players[att.pid]) };
  }

  broadcast(d) {
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      try { ws.send(JSON.stringify(this.view(d, att))); } catch (e) {}
    }
  }

  // ---- messages ----------------------------------------------------------
  async webSocketMessage(ws, raw) {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    const d = await this.load();
    if (!d) { ws.close(1011, "room gone"); return; }
    const att = ws.deserializeAttachment() || { pid: null, isHost: false };
    const g = d.game;
    const clean = s => String(s ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60);

    switch (m.type) {
      case "hello": {
        const pid = clean(m.pid);
        if (!/^[A-Za-z0-9_-]{6,40}$/.test(pid)) return;
        att.pid = pid;
        att.isHost = !!m.hostToken && m.hostToken === d.hostToken;
        ws.serializeAttachment(att);
        ws.send(JSON.stringify(this.view(d, att)));
        return;
      }
      case "join": {
        if (!att.pid) return;
        const name = clean(m.name).slice(0, 24);
        if (!name) return;
        if (Object.keys(d.players).length >= 30 && !d.players[att.pid]) return;
        d.players[att.pid] = { name, guesses: (d.players[att.pid] || {}).guesses || {} };
        break;
      }
      case "guess": {
        if (!att.pid || !d.players[att.pid] || g.phase !== "guess") return;
        const text = clean(m.text);
        if (!text) return;
        d.players[att.pid].guesses[String(g.round)] = text;
        break;
      }
      case "host": {
        if (!att.isHost) return;
        const validOrder = Array.isArray(m.order) && m.order.length === ROUND_COUNT &&
          new Set(m.order).size === ROUND_COUNT && m.order.every(n => Number.isInteger(n) && n >= 0 && n < ROUND_COUNT);
        if (m.action === "start" && validOrder && g.phase === "lobby") {
          for (const p of Object.values(d.players)) p.guesses = {};
          d.game = { phase: "guess", round: 0, order: m.order };
        } else if (m.action === "reveal" && g.phase === "guess") {
          d.game = { ...g, phase: "reveal" };
        } else if (m.action === "next" && g.phase === "reveal") {
          d.game = g.round >= ROUND_COUNT - 1 ? { ...g, phase: "done" } : { ...g, phase: "guess", round: g.round + 1 };
        } else if (m.action === "end") {
          d.game = { ...g, phase: "done" };
        } else if (m.action === "lobby") {
          for (const p of Object.values(d.players)) p.guesses = {};
          d.game = { phase: "lobby", round: 0, order: null };
        } else if (m.action === "clear") {
          d.players = {};
        } else if (m.action === "kick" && typeof m.pid === "string") {
          delete d.players[m.pid];
        } else return;
        break;
      }
      default:
        return;
    }
    await this.save(d);
    this.broadcast(d);
  }

  async webSocketClose(ws) {
    try { ws.close(); } catch (e) {}
  }
  async webSocketError(ws) {
    try { ws.close(); } catch (e) {}
  }
}
