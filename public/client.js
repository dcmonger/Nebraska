const { useEffect, useMemo, useRef, useState } = React;

const SNAP_DISTANCE = 90;
const TABLE_MIN_X = 20;
const TABLE_MAX_X = 980;
const TABLE_MIN_Y = 20;
const TABLE_MAX_Y = 640;

function cardLabel(card) {
  return `${card.rank}${card.suit}`;
}

function clampMenuPosition(clickX, clickY, menuEl) {
  const margin = 10;
  if (!menuEl) return { x: clickX, y: clickY };
  const menuRect = menuEl.getBoundingClientRect();
  const x = Math.max(margin, Math.min(clickX, window.innerWidth - menuRect.width - margin));
  const y = clickY + menuRect.height + margin > window.innerHeight ? clickY - menuRect.height : clickY;
  return { x, y: Math.max(margin, y) };
}

function stackOffsetPx(cardCount) {
  if (cardCount <= 1) return 0;
  return Math.max(0.5, Math.min(4, 40 / cardCount));
}

function App() {
  const [token, setToken] = useState(null);
  const [me, setMe] = useState(null);
  const [nameInput, setNameInput] = useState("");
  const [loginMessage, setLoginMessage] = useState("");
  const [game, setGame] = useState({ players: [], state: { cards: {}, stacks: {}, hands: {} } });
  const [highlightedTargetId, setHighlightedTargetId] = useState(null);
  const [menuState, setMenuState] = useState({ visible: false, x: 0, y: 0, stackId: null });
  const [stackModalStackId, setStackModalStackId] = useState(null);
  const [draggedHandIndex, setDraggedHandIndex] = useState(null);

  const tableRef = useRef(null);
  const menuRef = useRef(null);
  const draggingRef = useRef(null);
  const gameRef = useRef(game);
  const meRef = useRef(me);
  const tokenRef = useRef(token);

  useEffect(() => {
    gameRef.current = game;
  }, [game]);

  useEffect(() => {
    meRef.current = me;
  }, [me]);

  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  async function api(path, body = null) {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(tokenRef.current ? { "x-session-token": tokenRef.current } : {}),
      },
      body: body ? JSON.stringify(body) : null,
    });
    return response.json();
  }

  useEffect(() => {
    const query = token ? `?token=${encodeURIComponent(token)}` : "";
    const events = new EventSource(`/events${query}`);
    events.onmessage = (event) => {
      setGame(JSON.parse(event.data));
    };
    return () => events.close();
  }, [token]);

  useEffect(() => {
    function onPointerDown(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setMenuState((current) => ({ ...current, visible: false }));
      }
    }

    async function onPointerMove(event) {
      const dragging = draggingRef.current;
      const tableEl = tableRef.current;
      if (!dragging || !tableEl) return;

      const rect = tableEl.getBoundingClientRect();
      const viewX = event.clientX - rect.left - dragging.offsetX;
      const viewY = event.clientY - rect.top - dragging.offsetY;
      const { x: newX, y: newY } = viewToWorld(viewX, viewY, gameRef.current, meRef.current);

      if (Math.hypot(event.clientX - dragging.originX, event.clientY - dragging.originY) > 4) {
        dragging.moved = true;
      }

      if (dragging.moved) {
        await api("/api/move", {
          stackId: dragging.stackId,
          x: newX,
          y: newY,
        });
        const targetId = getTargetStackId(dragging.stackId, newX, newY, gameRef.current);
        setHighlightedTargetId(targetId);
      }
    }

    async function onPointerUp(event) {
      const dragging = draggingRef.current;
      if (!dragging) return;

      if (dragging.moved && highlightedTargetId) {
        await api("/api/stack", {
          sourceStackId: dragging.stackId,
          targetStackId: highlightedTargetId,
        });
      } else if (!dragging.moved) {
        const stack = gameRef.current.state.stacks[dragging.stackId];
        if (stack && stack.cardIds.length > 0) {
          setMenuState({
            visible: true,
            x: event.clientX,
            y: event.clientY,
            stackId: dragging.stackId,
          });
        }
      }

      draggingRef.current = null;
      setHighlightedTargetId(null);
    }

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [highlightedTargetId]);

  useEffect(() => {
    if (!menuState.visible || !menuRef.current) return;
    const pos = clampMenuPosition(menuState.x, menuState.y, menuRef.current);
    if (pos.x !== menuState.x || pos.y !== menuState.y) {
      setMenuState((current) => ({ ...current, x: pos.x, y: pos.y }));
    }
  }, [menuState]);

  async function handleLogin() {
    const result = await api("/api/login", { name: nameInput });
    if (result.error) {
      setLoginMessage(result.error);
      return;
    }
    setToken(result.token);
    setMe(result.player);
    setLoginMessage(`Joined as ${result.player.name}`);
  }

  function seatForPlayer(playerId) {
    if (me && playerId === me.id) return "bottom";
    const idx = game.players.findIndex((player) => player.id === playerId);
    return idx === -1 ? "bottom" : "top";
  }

  function onStackPointerDown(event, stackId, viewedPosition) {
    if (!me || event.button !== 0 || !tableRef.current) return;
    event.preventDefault();
    const rect = tableRef.current.getBoundingClientRect();
    draggingRef.current = {
      stackId,
      originX: event.clientX,
      originY: event.clientY,
      moved: false,
      offsetX: event.clientX - rect.left - viewedPosition.x,
      offsetY: event.clientY - rect.top - viewedPosition.y,
    };
  }

  async function handleMenuAction(action) {
    const stackId = menuState.stackId;
    const stack = game.state.stacks[stackId];
    if (!stack) return;

    if (action === "draw") {
      const result = await api("/api/draw", { stackId, destination: "hand" });
      if (result.error) setLoginMessage(result.error);
    } else if (action === "pull") {
      const result = await api("/api/draw", { stackId, destination: "board" });
      if (result.error) setLoginMessage(result.error);
    } else if (action === "flip") {
      await api("/api/flip", { stackId, scope: "stack" });
    } else if (action === "inspect") {
      setStackModalStackId(stackId);
    }

    setMenuState((current) => ({ ...current, visible: false }));
  }

  const stackModalCards = useMemo(() => {
    if (!stackModalStackId) return [];
    const stack = game.state.stacks[stackModalStackId];
    if (!stack) return [];
    return [...stack.cardIds].reverse().map((cardId) => game.state.cards[cardId]);
  }, [stackModalStackId, game]);

  const perspectiveP2 = isPlayerTwoPerspective(game, me);
  const myHandIds = me ? game.state.hands?.[me.id]?.cardIds || [] : [];
  const opponent = me ? game.players.find((player) => player.id !== me.id) : null;
  const opponentHandCount = opponent ? game.state.hands?.[opponent.id]?.count || 0 : 0;

  async function onHandDrop(targetIndex) {
    if (draggedHandIndex === null || draggedHandIndex === targetIndex) return;
    const result = await api("/api/reorder-hand", { fromIndex: draggedHandIndex, toIndex: targetIndex });
    if (result.error) setLoginMessage(result.error);
    setDraggedHandIndex(null);
  }

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "aside",
      { className: "sidebar" },
      React.createElement("h1", null, "Card Table"),
      React.createElement(
        "div",
        { className: "panel" },
        React.createElement("h2", null, "Login"),
        React.createElement("input", {
          value: nameInput,
          onChange: (event) => setNameInput(event.target.value),
          maxLength: 20,
          placeholder: "Display name",
        }),
        React.createElement("button", { onClick: handleLogin }, "Join game"),
        React.createElement("p", null, loginMessage),
      ),
      React.createElement(
        "div",
        { className: "panel" },
        React.createElement("h2", null, "Players"),
        React.createElement(
          "ul",
          null,
          game.players.map((player) =>
            React.createElement(
              "li",
              { key: player.id },
              me && me.id === player.id ? `${player.name} (you) - ${seatForPlayer(player.id)}` : `${player.name} - ${seatForPlayer(player.id)}`,
            ),
          ),
        ),
      ),
      React.createElement(
        "div",
        { className: "panel" },
        React.createElement("p", null, "Click stacks for actions (draw, pull, flip, inspect)."),
        React.createElement("p", null, "Drag and release on a highlighted stack to combine."),
      ),
    ),
    React.createElement(
      "main",
      {
        ref: tableRef,
        className: perspectiveP2 ? "table perspective-p2" : "table",
      },
      React.createElement(
        "div",
        { className: "opponent-hand-zone" },
        Array.from({ length: opponentHandCount }).map((_, idx) =>
          React.createElement("div", { key: `opp-${idx}`, className: "card facedown card-hand-opponent" }, "🂠"),
        ),
      ),
      Object.values(game.state.stacks)
        .filter((stack) => stack.cardIds.length > 0)
        .map((stack) => {
          const viewedPosition = worldToView(stack.x, stack.y, game, me);
          const allCardsFaceDown = stack.cardIds.every((cardId) => !game.state.cards[cardId].faceUp);
          const offset = stackOffsetPx(stack.cardIds.length);
          const maxVisibleByHeight = Math.max(1, Math.floor(42 / Math.max(offset, 0.5)));
          const visibleCount = allCardsFaceDown
            ? Math.min(stack.cardIds.length, maxVisibleByHeight)
            : Math.min(stack.cardIds.length, 10);
          const cardsToRender = stack.cardIds.slice(stack.cardIds.length - visibleCount);

          return React.createElement(
            "div",
            {
              key: stack.id,
              className: highlightedTargetId === stack.id ? "stack stack-highlight" : "stack",
              style: { left: `${viewedPosition.x}px`, top: `${viewedPosition.y}px` },
              onPointerDown: (event) => onStackPointerDown(event, stack.id, viewedPosition),
            },
            cardsToRender.map((cardId, index) => {
              const card = game.state.cards[cardId];
              return React.createElement(
                "div",
                {
                  key: cardId,
                  className: `card ${card.faceUp ? "faceup" : "facedown"}`,
                  style: {
                    transform: `translate(${index * offset}px, ${index * offset}px)`,
                    zIndex: String(index),
                  },
                },
                card.faceUp ? cardLabel(card) : "🂠",
              );
            }),
            stack.cardIds.length > 1
              ? React.createElement("div", { className: "stack-count" }, String(stack.cardIds.length))
              : null,
          );
        }),
      React.createElement(
        "div",
        { className: "player-hand-zone" },
        myHandIds.map((cardId, idx) => {
          const card = game.state.cards[cardId];
          return React.createElement(
            "div",
            {
              key: `${cardId}-${idx}`,
              className: `card faceup card-hand ${draggedHandIndex === idx ? "hand-dragging" : ""}`,
              draggable: true,
              onDragStart: () => setDraggedHandIndex(idx),
              onDragOver: (event) => event.preventDefault(),
              onDrop: () => onHandDrop(idx),
              onDragEnd: () => setDraggedHandIndex(null),
            },
            cardLabel(card),
          );
        }),
      ),
    ),
    menuState.visible
      ? React.createElement(
          "div",
          {
            ref: menuRef,
            className: "card-menu",
            style: { left: `${menuState.x}px`, top: `${menuState.y}px` },
          },
          React.createElement("h3", null, `Stack (${game.state.stacks[menuState.stackId]?.cardIds.length || 0} cards)`),
          React.createElement(
            "div",
            { className: "menu-buttons" },
            React.createElement("button", { className: "menu-btn", onClick: () => handleMenuAction("draw") }, "Draw"),
            game.state.stacks[menuState.stackId] && game.state.stacks[menuState.stackId].cardIds.length > 1
              ? React.createElement("button", { className: "menu-btn", onClick: () => handleMenuAction("pull") }, "Pull")
              : null,
            React.createElement("button", { className: "menu-btn", onClick: () => handleMenuAction("flip") }, "Flip"),
            React.createElement("button", { className: "menu-btn", onClick: () => handleMenuAction("inspect") }, "Inspect"),
          ),
        )
      : null,
    stackModalStackId
      ? React.createElement(
          "div",
          { className: "overlay" },
          React.createElement(
            "dialog",
            { open: true },
            React.createElement("h3", null, "Stack Inspector"),
            stackModalCards.length === 1
              ? React.createElement(
                  "div",
                  {
                    className: `card card-large ${stackModalCards[0].faceUp ? "faceup" : "facedown"}`,
                  },
                  stackModalCards[0].faceUp ? cardLabel(stackModalCards[0]) : "🂠",
                )
              : React.createElement(
                  "div",
                  { className: "stack-grid" },
                  stackModalCards.map((card, idx) =>
                    React.createElement(
                      "div",
                      { key: `${card.id}-${idx}`, className: "grid-tile" },
                      React.createElement(
                        "div",
                        { className: `card card-grid ${card.faceUp ? "faceup" : "facedown"}` },
                        card.faceUp ? cardLabel(card) : "🂠",
                      ),
                    ),
                  ),
                ),
            React.createElement("button", { onClick: () => setStackModalStackId(null) }, "Close"),
          ),
        )
      : null,
  );
}

function isPlayerTwoPerspective(game, me) {
  if (!me) return false;
  return game.players.findIndex((player) => player.id === me.id) === 1;
}

function worldToView(x, y, game, me) {
  if (!isPlayerTwoPerspective(game, me)) return { x, y };
  return {
    x: TABLE_MIN_X + TABLE_MAX_X - x,
    y: TABLE_MIN_Y + TABLE_MAX_Y - y,
  };
}

function viewToWorld(x, y, game, me) {
  if (!isPlayerTwoPerspective(game, me)) return { x, y };
  return {
    x: TABLE_MIN_X + TABLE_MAX_X - x,
    y: TABLE_MIN_Y + TABLE_MAX_Y - y,
  };
}

function getTargetStackId(sourceStackId, x, y, game) {
  for (const stack of Object.values(game.state.stacks)) {
    if (stack.id === sourceStackId) continue;
    const distance = Math.hypot(stack.x - x, stack.y - y);
    if (distance < SNAP_DISTANCE) return stack.id;
  }
  return null;
}

const root = ReactDOM.createRoot(document.getElementById("app"));
root.render(React.createElement(App));
