const table = document.getElementById("table");
const playerList = document.getElementById("playerList");
const loginBtn = document.getElementById("loginBtn");
const nameInput = document.getElementById("nameInput");
const loginMessage = document.getElementById("loginMessage");
const cardMenu = document.getElementById("cardMenu");
const menuTitle = document.getElementById("menuTitle");
const menuButtons = document.getElementById("menuButtons");
const cardModal = document.getElementById("cardModal");
const cardModalContent = document.getElementById("cardModalContent");
const stackModal = document.getElementById("stackModal");
const stackGrid = document.getElementById("stackGrid");

const SNAP_DISTANCE = 90;
const TABLE_MIN_X = 20;
const TABLE_MAX_X = 980;
const TABLE_MIN_Y = 20;
const TABLE_MAX_Y = 560;

let token = null;
let me = null;
let game = { players: [], state: { cards: {}, stacks: {} } };
let dragging = null;
let highlightedTargetId = null;

const events = new EventSource("/events");
events.onmessage = (event) => {
  game = JSON.parse(event.data);
  render();
};

async function api(path, body = null) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "x-session-token": token } : {}),
    },
    body: body ? JSON.stringify(body) : null,
  });
  return response.json();
}

loginBtn.addEventListener("click", async () => {
  const result = await api("/api/login", { name: nameInput.value });
  if (result.error) {
    loginMessage.textContent = result.error;
    return;
  }
  token = result.token;
  me = result.player;
  loginMessage.textContent = `Joined as ${me.name}`;
});

window.addEventListener("pointerdown", (event) => {
  if (!cardMenu.contains(event.target)) {
    cardMenu.classList.add("hidden");
  }
});

function cardLabel(card) {
  return `${card.rank}${card.suit}`;
}

function seatForPlayer(playerId) {
  if (me && playerId === me.id) return "bottom";
  const idx = game.players.findIndex((player) => player.id === playerId);
  return idx === -1 ? "bottom" : "top";
}

function isPlayerTwoPerspective() {
  if (!me) return false;
  return game.players.findIndex((player) => player.id === me.id) === 1;
}

function worldToView(x, y) {
  if (!isPlayerTwoPerspective()) return { x, y };
  return {
    x: TABLE_MIN_X + TABLE_MAX_X - x,
    y: TABLE_MIN_Y + TABLE_MAX_Y - y,
  };
}

function viewToWorld(x, y) {
  if (!isPlayerTwoPerspective()) return { x, y };
  return {
    x: TABLE_MIN_X + TABLE_MAX_X - x,
    y: TABLE_MIN_Y + TABLE_MAX_Y - y,
  };
}

function renderPlayers() {
  playerList.innerHTML = "";
  for (const player of game.players) {
    const li = document.createElement("li");
    const seat = seatForPlayer(player.id);
    li.textContent = me && me.id === player.id ? `${player.name} (you) - ${seat}` : `${player.name} - ${seat}`;
    playerList.appendChild(li);
  }
}

function getTargetStackId(sourceStackId, x, y) {
  for (const stack of Object.values(game.state.stacks)) {
    if (stack.id === sourceStackId) continue;
    const distance = Math.hypot(stack.x - x, stack.y - y);
    if (distance < SNAP_DISTANCE) {
      return stack.id;
    }
  }
  return null;
}

function menuAction(label, onClick) {
  const button = document.createElement("button");
  button.className = "menu-btn";
  button.textContent = label;
  button.addEventListener("click", async () => {
    await onClick();
    cardMenu.classList.add("hidden");
  });
  menuButtons.appendChild(button);
}

function showTopCardModal(card) {
  cardModalContent.innerHTML = "";
  const preview = document.createElement("div");
  preview.className = `card card-large ${card.faceUp ? "faceup" : "facedown"}`;
  preview.textContent = card.faceUp ? cardLabel(card) : "🂠";
  cardModalContent.appendChild(preview);
  cardModal.showModal();
}

function showStackGridModal(stack) {
  stackGrid.innerHTML = "";
  [...stack.cardIds].reverse().forEach((cardId) => {
    const card = game.state.cards[cardId];
    const tile = document.createElement("div");
    tile.className = "grid-tile";

    const cardEl = document.createElement("div");
    cardEl.className = `card card-grid ${card.faceUp ? "faceup" : "facedown"}`;
    cardEl.textContent = card.faceUp ? cardLabel(card) : "🂠";

    const caption = document.createElement("span");
    caption.textContent = `${cardLabel(card)} ${card.faceUp ? "(up)" : "(down)"}`;

    tile.appendChild(cardEl);
    tile.appendChild(caption);
    stackGrid.appendChild(tile);
  });
  stackModal.showModal();
}

function showStackMenu(event, stack, topCard) {
  if (!me) return;
  menuTitle.textContent = `Stack (${stack.cardIds.length} cards)`;
  menuButtons.innerHTML = "";

  menuAction("Turn top card face up", async () => {
    await api("/api/flip", { stackId: stack.id, faceUp: true });
  });
  menuAction("Turn top card face down", async () => {
    await api("/api/flip", { stackId: stack.id, faceUp: false });
  });
  menuAction("Draw top card from stack", async () => {
    const result = await api("/api/draw", { stackId: stack.id });
    if (result.error) loginMessage.textContent = result.error;
  });
  menuAction("Inspect top card", async () => {
    showTopCardModal(topCard);
  });
  menuAction("Flip entire stack", async () => {
    await api("/api/flip", { stackId: stack.id, scope: "stack" });
  });
  menuAction("View each card in stack", async () => {
    showStackGridModal(stack);
  });

  cardMenu.style.left = `${event.clientX}px`;
  cardMenu.style.top = `${event.clientY}px`;
  cardMenu.classList.remove("hidden");
}

function renderTable() {
  table.classList.toggle("perspective-p2", isPlayerTwoPerspective());
  table.innerHTML = "";
  for (const stack of Object.values(game.state.stacks)) {
    if (stack.cardIds.length === 0) continue;

    const stackEl = document.createElement("div");
    stackEl.className = "stack";
    if (highlightedTargetId === stack.id) {
      stackEl.classList.add("stack-highlight");
    }

    const viewedPosition = worldToView(stack.x, stack.y);
    stackEl.style.left = `${viewedPosition.x}px`;
    stackEl.style.top = `${viewedPosition.y}px`;

    const visibleCount = Math.min(stack.cardIds.length, 6);

    for (let i = 0; i < visibleCount; i += 1) {
      const cardId = stack.cardIds[stack.cardIds.length - visibleCount + i];
      const card = game.state.cards[cardId];
      const cardEl = document.createElement("div");
      cardEl.className = `card ${card.faceUp ? "faceup" : "facedown"}`;
      cardEl.textContent = card.faceUp ? cardLabel(card) : "🂠";
      cardEl.style.transform = `translate(${i * 8}px, ${i * 8}px)`;
      cardEl.style.zIndex = String(i);
      stackEl.appendChild(cardEl);
    }

    if (stack.cardIds.length > 1) {
      const count = document.createElement("div");
      count.className = "stack-count";
      count.textContent = String(stack.cardIds.length);
      stackEl.appendChild(count);
    }

    stackEl.addEventListener("pointerdown", (event) => {
      if (!me) return;
      if (event.button !== 0) return;
      event.preventDefault();
      const rect = table.getBoundingClientRect();
      dragging = {
        stackId: stack.id,
        originX: event.clientX,
        originY: event.clientY,
        moved: false,
        offsetX: event.clientX - rect.left - viewedPosition.x,
        offsetY: event.clientY - rect.top - viewedPosition.y,
      };
      stackEl.setPointerCapture(event.pointerId);
    });

    stackEl.addEventListener("pointerup", async (event) => {
      if (!dragging || dragging.stackId !== stack.id) return;
      if (dragging.moved) {
        if (highlightedTargetId) {
          await api("/api/stack", {
            sourceStackId: dragging.stackId,
            targetStackId: highlightedTargetId,
          });
        }
      } else {
        const topCard = game.state.cards[stack.cardIds[stack.cardIds.length - 1]];
        showStackMenu(event, stack, topCard);
      }
      highlightedTargetId = null;
      dragging = null;
      render();
    });

    table.appendChild(stackEl);
  }
}

window.addEventListener("pointermove", async (event) => {
  if (!dragging) return;
  const rect = table.getBoundingClientRect();
  const viewX = event.clientX - rect.left - dragging.offsetX;
  const viewY = event.clientY - rect.top - dragging.offsetY;
  const { x: newX, y: newY } = viewToWorld(viewX, viewY);

  if (Math.hypot(event.clientX - dragging.originX, event.clientY - dragging.originY) > 4) {
    dragging.moved = true;
  }

  if (dragging.moved) {
    await api("/api/move", {
      stackId: dragging.stackId,
      x: newX,
      y: newY,
    });
    highlightedTargetId = getTargetStackId(dragging.stackId, newX, newY);
    render();
  }
});

window.addEventListener("pointerup", () => {
  if (!dragging) return;
  dragging = null;
  highlightedTargetId = null;
});

function render() {
  renderPlayers();
  renderTable();
}
