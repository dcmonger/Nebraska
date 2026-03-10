const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 2;
const TABLE_MIN = 20;

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
      cards.push({ id, suit, rank, faceUp: false, tapped: false });
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
    hands: {},
    log: [],
    nextStackId: 1,
  };
}

function addLog(playerId, action, details = "") {
  const name = [...sessions.values()].find((player) => player.id === playerId)?.name || "Unknown";
  const detailSuffix = details ? ` ${details}` : "";
  state.log.push(`${name} ${action}${detailSuffix}`);
  if (state.log.length > 80) {
    state.log.shift();
  }
}

function clampTable(value, min, max = null) {
  if (typeof max === "number") return Math.max(min, Math.min(max, value));
  return Math.max(min, value);
}

function drawTopCardToNewStack(sourceStack, playerId) {
  if (!sourceStack || sourceStack.cardIds.length === 0) return null;
  const cardId = sourceStack.cardIds.pop();
  state.cards[cardId].tapped = false;
  const stackId = `stack-${state.nextStackId++}`;
  const offset = Math.floor(Math.random() * 25);
  state.stacks[stackId] = {
    id: stackId,
    cardIds: [cardId],
    x: clampTable(sourceStack.x + 120 + offset, TABLE_MIN),
    y: clampTable(sourceStack.y + 20 + offset, TABLE_MIN),
    ownerId: playerId,
  };
  if (sourceStack.cardIds.length === 0 && sourceStack.id !== "deck") {
    delete state.stacks[sourceStack.id];
  }
  return stackId;
}

function drawTopCardToHand(sourceStack, playerId) {
  if (!sourceStack || sourceStack.cardIds.length === 0) return null;
  if (!state.hands[playerId]) state.hands[playerId] = [];
  const cardId = sourceStack.cardIds.pop();
  state.cards[cardId].tapped = false;
  state.hands[playerId].push(cardId);
  if (sourceStack.cardIds.length === 0 && sourceStack.id !== "deck") {
    delete state.stacks[sourceStack.id];
  }
  return cardId;
}

function moveStackToHand(sourceStack, playerId, toIndex = null) {
  if (!sourceStack || sourceStack.cardIds.length === 0) return [];
  if (!state.hands[playerId]) state.hands[playerId] = [];
  const movedCardIds = [...sourceStack.cardIds];
  const hand = state.hands[playerId];
  const insertAt = Number.isInteger(toIndex) ? Math.max(0, Math.min(toIndex, hand.length)) : hand.length;
  hand.splice(insertAt, 0, ...movedCardIds);
  for (const cardId of movedCardIds) {
    state.cards[cardId].tapped = false;
  }
  if (sourceStack.id === "deck") {
    sourceStack.cardIds = [];
  } else {
    delete state.stacks[sourceStack.id];
  }
  return movedCardIds;
}

function playHandCardToBoard(playerId, handIndex, x, y, targetStackId = null) {
  const hand = state.hands[playerId] || [];
  if (!Number.isInteger(handIndex) || handIndex < 0 || handIndex >= hand.length) return null;

  const [cardId] = hand.splice(handIndex, 1);
  if (!cardId) return null;

  const target = targetStackId ? state.stacks[targetStackId] : null;
  if (target) {
    target.cardIds.push(cardId);
    target.ownerId = playerId;
    return { stackId: target.id, cardId, merged: true };
  }

  const stackId = `stack-${state.nextStackId++}`;
  state.stacks[stackId] = {
    id: stackId,
    cardIds: [cardId],
    x: clampTable(Number(x) || 0, TABLE_MIN),
    y: clampTable(Number(y) || 0, TABLE_MIN),
    ownerId: playerId,
  };
  return { stackId, cardId, merged: false };
}

function payloadForPlayer(playerId) {
  const hands = {};
  for (const player of sessions.values()) {
    const cardIds = state.hands[player.id] || [];
    const isOwner = player.id === playerId;
    hands[player.id] = {
      count: cardIds.length,
      cardIds: isOwner ? cardIds : [],
    };
  }
  return {
    players: [...sessions.values()].map(({ id, name }) => ({ id, name })),
    state: {
      cards: state.cards,
      stacks: state.stacks,
      hands,
      log: state.log,
    },
  };
}


function setTappedState(stack, scope = "top", cardId = null, tapped = null) {
  if (!stack || stack.cardIds.length === 0) return 0;

  const shouldTap = (card) => (typeof tapped === "boolean" ? tapped : !card.tapped);

  if (scope === "all") {
    let changed = 0;
    for (const id of stack.cardIds) {
      const card = state.cards[id];
      if (!card) continue;
      const next = shouldTap(card);
      if (card.tapped !== next) {
        card.tapped = next;
        changed += 1;
      }
    }
    return changed;
  }

  let targetId = null;
  if (scope === "card" && cardId && stack.cardIds.includes(cardId)) {
    targetId = cardId;
  } else {
    targetId = stack.cardIds[stack.cardIds.length - 1];
  }

  const card = state.cards[targetId];
  if (!card) return 0;
  const next = shouldTap(card);
  if (card.tapped === next) return 0;
  card.tapped = next;
  return 1;
}

function mergeStacks(sourceId, targetId, playerId) {
  const source = state.stacks[sourceId];
  const target = state.stacks[targetId];
  if (!source || !target || source.id === target.id) return false;
  target.cardIds = target.cardIds.concat(source.cardIds);
  target.ownerId = playerId;
  delete state.stacks[source.id];
  return true;
}

function broadcast() {
  for (const client of clients) {
    const message = `data: ${JSON.stringify(payloadForPlayer(client.playerId))}\n\n`;
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

function getSession(req, explicitToken = null) {
  const token = explicitToken || req.headers["x-session-token"];
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
    const player = getSession(req, url.searchParams.get("token"));
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.playerId = player?.id || null;
    clients.add(res);
    res.write(`data: ${JSON.stringify(payloadForPlayer(res.playerId))}\n\n`);
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
    state.hands[token] = [];
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

    const destination = body?.destination === "board" ? "board" : "hand";
    if (destination === "board") {
      const newStackId = drawTopCardToNewStack(sourceStack, player.id);
      if (!newStackId) return sendJson(res, 400, { error: "Unable to draw." });
      state.cards[state.stacks[newStackId].cardIds[0]].faceUp = true;
      addLog(player.id, "pulled", `from ${sourceStack.id}`);
      broadcast();
      return sendJson(res, 200, { ok: true, stackId: newStackId });
    }

    const cardId = drawTopCardToHand(sourceStack, player.id);
    if (!cardId) return sendJson(res, 400, { error: "Unable to draw." });
    state.cards[cardId].faceUp = true;
    addLog(player.id, "drew", `from ${sourceStack.id}`);
    broadcast();
    return sendJson(res, 200, { ok: true, cardId });
  }

  if (req.method === "POST" && url.pathname === "/api/pickup-to-hand") {
    const player = getSession(req);
    if (!player) return sendJson(res, 401, { error: "Login required." });

    const body = await readBody(req).catch(() => null);
    const sourceStack = state.stacks[body?.stackId];
    if (!sourceStack || sourceStack.cardIds.length === 0) {
      return sendJson(res, 400, { error: "No cards to draw from this stack." });
    }

    const requestedToIndex = Number(body?.toIndex);
    const hand = state.hands[player.id] || [];
    if (body?.toIndex !== undefined && (!Number.isInteger(requestedToIndex) || requestedToIndex < 0 || requestedToIndex > hand.length)) {
      return sendJson(res, 400, { error: "Invalid hand index." });
    }

    const movedCardIds = moveStackToHand(sourceStack, player.id, body?.toIndex === undefined ? null : requestedToIndex);
    if (movedCardIds.length === 0) return sendJson(res, 400, { error: "Unable to move cards to hand." });
    for (const cardId of movedCardIds) {
      state.cards[cardId].faceUp = true;
    }
    addLog(player.id, "drew", `${movedCardIds.length} cards from ${sourceStack.id}`);
    broadcast();
    return sendJson(res, 200, { ok: true, cardIds: movedCardIds });
  }

  if (req.method === "POST" && url.pathname === "/api/reorder-hand") {
    const player = getSession(req);
    if (!player) return sendJson(res, 401, { error: "Login required." });

    const body = await readBody(req).catch(() => null);
    const fromIndex = Number(body?.fromIndex);
    const toIndex = Number(body?.toIndex);
    const hand = state.hands[player.id] || [];
    if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex < 0 || fromIndex >= hand.length || toIndex < 0 || toIndex > hand.length) {
      return sendJson(res, 400, { error: "Invalid hand indices." });
    }
    const [moved] = hand.splice(fromIndex, 1);
    const adjustedToIndex = toIndex > fromIndex ? toIndex - 1 : toIndex;
    if (adjustedToIndex === fromIndex) return sendJson(res, 200, { ok: true });
    hand.splice(adjustedToIndex, 0, moved);
    broadcast();
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/play-from-hand") {
    const player = getSession(req);
    if (!player) return sendJson(res, 401, { error: "Login required." });

    const body = await readBody(req).catch(() => null);
    const played = playHandCardToBoard(
      player.id,
      Number(body?.handIndex),
      body?.x,
      body?.y,
      body?.targetStackId || null,
    );
    if (!played) return sendJson(res, 400, { error: "Unable to play card from hand." });

    state.cards[played.cardId].faceUp = true;
    addLog(player.id, "pulled", "to board");
    broadcast();
    return sendJson(res, 200, { ok: true, ...played });
  }

  if (req.method === "POST" && url.pathname === "/api/flip") {
    const player = getSession(req);
    if (!player) return sendJson(res, 401, { error: "Login required." });

    const body = await readBody(req).catch(() => null);
    const stack = state.stacks[body?.stackId];
    if (!stack) return sendJson(res, 404, { error: "Stack not found" });

    stack.cardIds.reverse();

    if (body?.scope === "stack") {
      for (const cardId of stack.cardIds) {
        const card = state.cards[cardId];
        card.faceUp = !card.faceUp;
      }
      addLog(player.id, "flipped", `stack ${stack.id}`);
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
    addLog(player.id, "flipped", `top of ${stack.id}`);
    broadcast();
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/shuffle") {
    const player = getSession(req);
    if (!player) return sendJson(res, 401, { error: "Login required." });

    const body = await readBody(req).catch(() => null);
    const stack = state.stacks[body?.stackId];
    if (!stack) return sendJson(res, 404, { error: "Stack not found" });
    if (stack.cardIds.length < 2) return sendJson(res, 400, { error: "Need at least two cards to shuffle." });

    for (let i = stack.cardIds.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [stack.cardIds[i], stack.cardIds[j]] = [stack.cardIds[j], stack.cardIds[i]];
    }

    addLog(player.id, "shuffled", `stack ${stack.id}`);
    broadcast();
    return sendJson(res, 200, { ok: true });
  }


  if (req.method === "POST" && url.pathname === "/api/tap") {
    const player = getSession(req);
    if (!player) return sendJson(res, 401, { error: "Login required." });

    const body = await readBody(req).catch(() => null);
    const stack = state.stacks[body?.stackId];
    if (!stack) return sendJson(res, 404, { error: "Stack not found" });

    const scope = body?.scope === "all" || body?.scope === "card" ? body.scope : "top";
    const changed = setTappedState(stack, scope, body?.cardId || null, body?.tapped);
    if (changed === 0) return sendJson(res, 200, { ok: true, changed: 0 });

    if (scope === "all") {
      addLog(player.id, body?.tapped === false ? "untapped" : "tapped", `all in ${stack.id}`);
    } else {
      addLog(player.id, body?.tapped === false ? "untapped" : "tapped", `card in ${stack.id}`);
    }
    broadcast();
    return sendJson(res, 200, { ok: true, changed });
  }

  if (req.method === "POST" && url.pathname === "/api/move") {
    const player = getSession(req);
    if (!player) return sendJson(res, 401, { error: "Login required." });

    const body = await readBody(req).catch(() => null);
    const stack = state.stacks[body?.stackId];
    if (!stack) return sendJson(res, 404, { error: "Stack not found" });

    stack.x = clampTable(Number(body.x) || 0, TABLE_MIN);
    stack.y = clampTable(Number(body.y) || 0, TABLE_MIN);
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
    addLog(player.id, "stacked", `${body?.sourceStackId} onto ${body?.targetStackId}`);
    broadcast();
    return sendJson(res, 200, { ok: true });
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`Card table running on http://localhost:${PORT}`);
});
