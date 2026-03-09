const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 2;
const SNAP_DISTANCE = 90;

const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

const clients = new Set();
const state = createInitialState();
const sessions = new Map();

function createDeckCards() {
  const cards = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      const id = `${rank}${suit}`;
      cards.push({ id, suit, rank, faceUp: false });
    }
  }
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function createInitialState() {
  const deckCards = createDeckCards();
  return {
    cards: Object.fromEntries(deckCards.map((card) => [card.id, card])),
    stacks: {
      deck: {
        id: "deck",
        cardIds: deckCards.map((c) => c.id),
        x: 100,
        y: 180,
      },
    },
    nextStackId: 1,
  };
}

function clampTable(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function maybeSnapStack(movingStackId) {
  const moving = state.stacks[movingStackId];
  if (!moving) return;

  for (const stack of Object.values(state.stacks)) {
    if (stack.id === moving.id) continue;
    const distance = Math.hypot(stack.x - moving.x, stack.y - moving.y);
    if (distance < SNAP_DISTANCE) {
      stack.cardIds = stack.cardIds.concat(moving.cardIds);
      delete state.stacks[moving.id];
      return;
    }
  }
}

function currentPayload() {
  return JSON.stringify({
    players: [...sessions.values()].map(({ id, name }) => ({ id, name })),
    state,
  });
}

function broadcast() {
  const message = `data: ${currentPayload()}\n\n`;
  for (const client of clients) {
    client.write(message);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 2e6) {
        reject(new Error("body too large"));
      }
    });
    req.on("end", () => resolve(data ? JSON.parse(data) : {}));
    req.on("error", reject);
  });
}

function sendJson(res, code, payload) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function getSession(req) {
  const token = req.headers["x-session-token"];
  if (!token || typeof token !== "string") return null;
  return sessions.get(token) || null;
}

function serveFile(res, filePath) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = path.extname(filePath);
  const type = ext === ".html" ? "text/html" : ext === ".css" ? "text/css" : "application/javascript";
  res.writeHead(200, { "Content-Type": type });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/") {
    serveFile(res, path.join(__dirname, "public", "index.html"));
    return;
  }

  if (req.method === "GET" && ["/client.js", "/styles.css"].includes(url.pathname)) {
    serveFile(res, path.join(__dirname, "public", url.pathname.slice(1)));
    return;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    clients.add(res);
    res.write(`data: ${currentPayload()}\n\n`);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readBody(req).catch(() => null);
    const name = `${body?.name || ""}`.trim().slice(0, 20);
    if (!name) return sendJson(res, 400, { error: "Enter a display name." });
    if (sessions.size >= MAX_PLAYERS) return sendJson(res, 403, { error: "Table is full." });

    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessions.set(token, { id: token, name });
    broadcast();
    return sendJson(res, 200, { token, player: { id: token, name } });
  }

  if (req.method === "POST" && url.pathname === "/api/draw") {
    const player = getSession(req);
    if (!player) return sendJson(res, 401, { error: "Login required." });

    const deck = state.stacks.deck;
    if (!deck || deck.cardIds.length === 0) return sendJson(res, 400, { error: "Deck empty" });

    const cardId = deck.cardIds.pop();
    state.cards[cardId].faceUp = true;
    const stackId = `stack-${state.nextStackId++}`;
    state.stacks[stackId] = {
      id: stackId,
      cardIds: [cardId],
      x: 270 + Math.floor(Math.random() * 420),
      y: 160 + Math.floor(Math.random() * 250),
    };
    broadcast();
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/flip") {
    const player = getSession(req);
    if (!player) return sendJson(res, 401, { error: "Login required." });

    const body = await readBody(req).catch(() => null);
    const card = state.cards[body?.cardId];
    if (!card) return sendJson(res, 404, { error: "Card not found" });
    card.faceUp = !card.faceUp;
    broadcast();
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/move") {
    const player = getSession(req);
    if (!player) return sendJson(res, 401, { error: "Login required." });

    const body = await readBody(req).catch(() => null);
    const stack = state.stacks[body?.stackId];
    if (!stack || stack.id === "deck") return sendJson(res, 404, { error: "Stack not found" });

    stack.x = clampTable(Number(body.x) || 0, 20, 980);
    stack.y = clampTable(Number(body.y) || 0, 20, 560);
    maybeSnapStack(stack.id);
    broadcast();
    return sendJson(res, 200, { ok: true });
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`Card table running on http://localhost:${PORT}`);
});
