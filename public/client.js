const table = document.getElementById("table");
const playerList = document.getElementById("playerList");
const loginBtn = document.getElementById("loginBtn");
const nameInput = document.getElementById("nameInput");
const loginMessage = document.getElementById("loginMessage");
const drawBtn = document.getElementById("drawBtn");
const stackDialog = document.getElementById("stackDialog");
const stackContents = document.getElementById("stackContents");
const closeDialogBtn = document.getElementById("closeDialogBtn");

let token = null;
let me = null;
let game = { players: [], state: { cards: {}, stacks: {} } };
let dragging = null;

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

drawBtn.addEventListener("click", async () => {
  const result = await api("/api/draw");
  if (result.error) loginMessage.textContent = result.error;
});

closeDialogBtn.addEventListener("click", () => stackDialog.close());

function cardLabel(card) {
  return `${card.rank}${card.suit}`;
}

function renderPlayers() {
  playerList.innerHTML = "";
  for (const player of game.players) {
    const li = document.createElement("li");
    li.textContent = me && me.id === player.id ? `${player.name} (you)` : player.name;
    playerList.appendChild(li);
  }
}

function renderTable() {
  table.innerHTML = "";
  for (const stack of Object.values(game.state.stacks)) {
    if (stack.cardIds.length === 0) continue;

    const stackEl = document.createElement("div");
    stackEl.className = "stack";
    stackEl.style.left = `${stack.x}px`;
    stackEl.style.top = `${stack.y}px`;

    const topCardId = stack.cardIds[stack.cardIds.length - 1];
    const topCard = game.state.cards[topCardId];

    const cardEl = document.createElement("div");
    cardEl.className = `card ${topCard.faceUp ? "faceup" : "facedown"}`;
    cardEl.textContent = topCard.faceUp ? cardLabel(topCard) : "🂠";
    cardEl.style.transform = `translateY(-${Math.min((stack.cardIds.length - 1) * 2, 18)}px)`;
    stackEl.appendChild(cardEl);

    if (stack.cardIds.length > 1) {
      const count = document.createElement("div");
      count.className = "stack-count";
      count.textContent = String(stack.cardIds.length);
      stackEl.appendChild(count);
    }

    if (stack.id !== "deck") {
      stackEl.addEventListener("pointerdown", (event) => {
        if (!me) return;
        dragging = {
          stackId: stack.id,
          offsetX: event.clientX - stack.x,
          offsetY: event.clientY - stack.y,
        };
        stackEl.setPointerCapture(event.pointerId);
      });
    }

    stackEl.addEventListener("dblclick", async () => {
      if (!me) return;
      await api("/api/flip", { cardId: topCardId });
    });

    stackEl.addEventListener("click", () => {
      stackContents.innerHTML = "";
      [...stack.cardIds].reverse().forEach((cardId, index) => {
        const card = game.state.cards[cardId];
        const li = document.createElement("li");
        li.textContent = `${cardLabel(card)} ${card.faceUp ? "face up" : "face down"} ${index === 0 ? "(top)" : ""}`;
        stackContents.appendChild(li);
      });
      stackDialog.showModal();
    });

    table.appendChild(stackEl);
  }
}

window.addEventListener("pointermove", async (event) => {
  if (!dragging) return;
  await api("/api/move", {
    stackId: dragging.stackId,
    x: event.clientX - dragging.offsetX,
    y: event.clientY - dragging.offsetY,
  });
});

window.addEventListener("pointerup", () => {
  dragging = null;
});

function render() {
  renderPlayers();
  renderTable();
}
