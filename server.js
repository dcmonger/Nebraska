const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 2;

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
        x: 120,
        y: 260,
        ownerId: null,
      },
    },
    nextStackId: 1,
  };
}

function clampTable(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function drawTopCardToNewStack(sourceStack, playerId) {
  if (!sourceStack || sourceStack.cardIds.length === 0) return null;
  const cardId = sourceStack.cardIds.pop();
  const stackId = `stack-${state.nextStackId++}`;
  const offset = Math.floor(Math.random() * 25);
  state.stacks[stackId] = {
    id: stackId,
    cardIds: [cardId],
    x: clampTable(sourceStack.x + 120 + offset, 20, 980),
    y: clampTable(sourceStack.y + 20 + offset, 20, 560),
    ownerId: playerId,
  };
  if (sourceStack.cardIds.length === 0 && sourceStack.id !== "deck") {
    delete state.stacks[sourceStack.id];
  }
  return stackId;
}

function mergeStacks(sourceId, targetId, playerId) {
  const source = state.stacks[sourceId];
  const target = state.stacks[targetId];
  if (!source || !target || source.id === target.id) return false;
  if (source.id === "deck") return false;
  target.cardIds = target.cardIds.concat(source.cardIds);
  target.ownerId = playerId;
  delete state.stacks[source.id];
  return true;
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

    const body = await readBody(req).catch(() => null);
    const sourceStack = state.stacks[body?.stackId || "deck"];
    if (!sourceStack || sourceStack.cardIds.length === 0) {
      return sendJson(res, 400, { error: "No cards to draw from this stack." });
    }

    const newStackId = drawTopCardToNewStack(sourceStack, player.id);
    if (!newStackId) return sendJson(res, 400, { error: "Unable to draw." });

    state.cards[state.stacks[newStackId].cardIds[0]].faceUp = true;
    broadcast();
    return sendJson(res, 200, { ok: true, stackId: newStackId });
  }

  if (req.method === "POST" && url.pathname === "/api/flip") {
    const player = getSession(req);
    if (!player) return sendJson(res, 401, { error: "Login required." });

    const body = await readBody(req).catch(() => null);
    const stack = state.stacks[body?.stackId];
    if (!stack) return sendJson(res, 404, { error: "Stack not found" });

    if (body?.scope === "stack") {
      for (const cardId of stack.cardIds) {
        const card = state.cards[cardId];
        card.faceUp = !card.faceUp;
      }
      broadcast();
      return sendJson(res, 200, { ok: true });
    }

    const topCardId = stack.cardIds[stack.cardIds.length - 1];
    const card = state.cards[topCardId];
    if (!card) return sendJson(res, 404, { error: "Card not found" });
    if (body?.faceUp === true || body?.faceUp === false) {
      card.faceUp = body.faceUp;
    } else {
      card.faceUp = !card.faceUp;
    }
    broadcast();
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/move") {
    const player = getSession(req);
    if (!player) return sendJson(res, 401, { error: "Login required." });

    const body = await readBody(req).catch(() => null);
    const stack = state.stacks[body?.stackId];
    if (!stack) return sendJson(res, 404, { error: "Stack not found" });

    stack.x = clampTable(Number(body.x) || 0, 20, 980);
    stack.y = clampTable(Number(body.y) || 0, 20, 560);
    if (stack.id !== "deck") stack.ownerId = player.id;
    broadcast();
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/stack") {
    const player = getSession(req);
    if (!player) return sendJson(res, 401, { error: "Login required." });

    const body = await readBody(req).catch(() => null);
    const merged = mergeStacks(body?.sourceStackId, body?.targetStackId, player.id);
    if (!merged) return sendJson(res, 400, { error: "Unable to stack." });
    broadcast();
    return sendJson(res, 200, { ok: true });
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`Card table running on http://localhost:${PORT}`);
});
