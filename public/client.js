const { useEffect, useMemo, useRef, useState } = React;

const SNAP_DISTANCE = 90;
const HAND_REVEAL_MARGIN = 170;
const HAND_SNAP_MARGIN = 190;
const BOARD_CARD_WIDTH = 78;
const BOARD_CARD_HEIGHT = 112;
const HOVER_PREVIEW_DELAY_MS = 500;
const MENU_OPEN_DELAY_MS = 220;

function cardLabel(card) {
  return `${card.rank}${card.suit}\uFE0E`;
}

function isRedSuit(card) {
  return card && (card.suit === "♥" || card.suit === "♦");
}

function clampMenuPosition(clickX, clickY, menuEl) {
  const margin = 10;
  if (!menuEl) return { x: clickX, y: clickY };
  const menuRect = menuEl.getBoundingClientRect();
  const x = Math.max(margin, Math.min(clickX, window.innerWidth - menuRect.width - margin));
  const y = clickY + menuRect.height + margin > window.innerHeight ? clickY - menuRect.height : clickY;
  return { x, y: Math.max(margin, y) };
}

function stackOffsetPx(cardCount, visibleCount) {
  if (cardCount <= 1 || visibleCount <= 1) return 0;
  const maxThicknessPx = 27;
  return Math.max(0.5, Math.min(4, maxThicknessPx / (visibleCount - 1)));
}

function App() {
  const [token, setToken] = useState(null);
  const [me, setMe] = useState(null);
  const [nameInput, setNameInput] = useState("");
  const [loginMessage, setLoginMessage] = useState("");
  const [game, setGame] = useState({ players: [], state: { cards: {}, stacks: {}, hands: {} } });
  const [highlightedTargetId, setHighlightedTargetId] = useState(null);
  const [menuState, setMenuState] = useState({ visible: false, x: 0, y: 0, stackId: null });
  const [draggedHandIndex, setDraggedHandIndex] = useState(null);
  const [handDropIndex, setHandDropIndex] = useState(null);
  const [boardDropPreview, setBoardDropPreview] = useState(null);
  const [handRaised, setHandRaised] = useState(false);
  const [hoverPreviewCardId, setHoverPreviewCardId] = useState(null);
  const [tableWidth, setTableWidth] = useState(typeof window === "undefined" ? 1200 : window.innerWidth);
  const [tableHeight, setTableHeight] = useState(typeof window === "undefined" ? 900 : window.innerHeight);
  const [handDragPreview, setHandDragPreview] = useState(null);
  const [handInsertGhostCardId, setHandInsertGhostCardId] = useState(null);
  const [selectedStackIds, setSelectedStackIds] = useState([]);
  const [selectionBox, setSelectionBox] = useState(null);

  const tableRef = useRef(null);
  const handZoneRef = useRef(null);
  const menuRef = useRef(null);
  const draggingRef = useRef(null);
  const handDraggingRef = useRef(null);
  const gameRef = useRef(game);
  const meRef = useRef(me);
  const tokenRef = useRef(token);
  const hoverTimerRef = useRef(null);
  const hoverCandidateRef = useRef(null);
  const selectionRef = useRef(null);
  const menuOpenTimerRef = useRef(null);
  const recentDoubleClickRef = useRef(0);

  useEffect(() => {
    gameRef.current = game;
  }, [game]);

  useEffect(() => {
    meRef.current = me;
  }, [me]);

  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    if (menuOpenTimerRef.current) clearTimeout(menuOpenTimerRef.current);
  }, []);

  useEffect(() => {
    if (!tableRef.current) return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setTableWidth(entry.contentRect.width);
      setTableHeight(entry.contentRect.height);
    });
    observer.observe(tableRef.current);
    return () => observer.disconnect();
  }, []);

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
      setHoverPreviewCardId(null);
      hoverCandidateRef.current = null;
      if (menuOpenTimerRef.current) {
        clearTimeout(menuOpenTimerRef.current);
        menuOpenTimerRef.current = null;
      }
      if (!event.target.closest(".stack")) {
        setSelectedStackIds([]);
      }
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setMenuState((current) => ({ ...current, visible: false }));
      }
    }

    async function onPointerMove(event) {
      const handDragging = handDraggingRef.current;
      if (handDragging) {
        if (!handDragging.moved && Math.hypot(event.clientX - handDragging.originX, event.clientY - handDragging.originY) > 4) {
          handDragging.moved = true;
          setDraggedHandIndex(handDragging.sourceIndex);
          setHandRaised(true);
        }

        if (!handDragging.moved) return;

        setHandDragPreview({
          cardId: handDragging.cardId,
          x: event.clientX - handDragging.offsetX,
          y: event.clientY - handDragging.offsetY,
        });

        if (isPointerInHandZone(event.clientX, event.clientY)) {
          setHandDropIndex(getHandInsertIndex(event.clientX));
          setBoardDropPreview(null);
          return;
        }

        setHandDropIndex(null);
        setBoardDropPreview(getBoardDropPreview(event));
        return;
      }

      const dragging = draggingRef.current;
      const tableEl = tableRef.current;
      if (!dragging || !tableEl) {
        const selection = selectionRef.current;
        if (selection && selection.active) {
          if (!tableEl) return;
          const currentRect = makeRect(selection.originX, selection.originY, event.clientX, event.clientY);
          const tableRect = tableEl.getBoundingClientRect();
          const selectedIds = Object.values(gameRef.current.state.stacks)
            .filter((stack) => stack.cardIds.length > 0)
            .filter((stack) => {
              const viewed = worldToView(stack.x, stack.y, gameRef.current, meRef.current);
              const stackRect = {
                left: tableRect.left + viewed.x,
                top: tableRect.top + viewed.y,
                right: tableRect.left + viewed.x + 98,
                bottom: tableRect.top + viewed.y + 146,
              };
              return rectsIntersect(currentRect, stackRect);
            })
            .map((stack) => stack.id);

          setSelectionBox(viewportToTableRect(currentRect, tableRect));
          setSelectedStackIds(selectedIds);
        }
        return;
      }

      const rect = tableEl.getBoundingClientRect();
      const viewX = event.clientX - rect.left - dragging.offsetX;
      const viewY = event.clientY - rect.top - dragging.offsetY;
      const { x: newX, y: newY } = viewToWorld(viewX, viewY, gameRef.current, meRef.current);

      if (Math.hypot(event.clientX - dragging.originX, event.clientY - dragging.originY) > 4) {
        dragging.moved = true;
      }

        if (dragging.moved) {
        const deltaX = newX - dragging.startX;
        const deltaY = newY - dragging.startY;
        await Promise.all(
          dragging.stackIds.map((stackId) => {
            const anchor = dragging.anchors[stackId];
            if (!anchor) return Promise.resolve();
            return api("/api/move", {
              stackId,
              x: anchor.x + deltaX,
              y: anchor.y + deltaY,
            });
          }),
        );

        if (shouldTreatAsHandDrop(event.clientY)) {
          const draggingStack = gameRef.current.state.stacks[dragging.stackId];
          const topCardId = draggingStack?.cardIds?.[draggingStack.cardIds.length - 1] || null;
          setHandRaised(true);
          setHandInsertGhostCardId(topCardId);
          setHandDropIndex(getHandInsertIndex(event.clientX));
          setHighlightedTargetId(null);
          return;
        }

        setHandDropIndex(null);
        setHandInsertGhostCardId(null);
        const targetId = dragging.stackIds.length === 1 ? getTargetStackId(dragging.stackId, viewX, viewY, gameRef.current, meRef.current, worldToView) : null;
        setHighlightedTargetId(targetId);
      }
    }

    async function onPointerUp(event) {
      const handDragging = handDraggingRef.current;
      if (handDragging) {
        if (handDragging.moved && isPointerInHandZone(event.clientX, event.clientY)) {
          await onHandDrop(getHandInsertIndex(event.clientX), handDragging.sourceIndex);
        } else if (handDragging.moved) {
          const preview = getBoardDropPreview(event);
          if (preview) {
            const world = viewToWorld(preview.x, preview.y, gameRef.current, meRef.current);
            const result = await api("/api/play-from-hand", {
              handIndex: handDragging.sourceIndex,
              x: world.x,
              y: world.y,
              targetStackId: preview.targetStackId,
            });
            if (result.error) setLoginMessage(result.error);
          }
        }

        handDraggingRef.current = null;
        setDraggedHandIndex(null);
        setHandDropIndex(null);
        setBoardDropPreview(null);
        setHandDragPreview(null);
        setHandInsertGhostCardId(null);
        setHandRaised(false);
        return;
      }

      const dragging = draggingRef.current;
      const selection = selectionRef.current;
      if (selection && selection.active) {
        selectionRef.current = null;
        setSelectionBox(null);
        return;
      }
      if (!dragging) return;

      if (dragging.moved && dragging.stackIds.length === 1 && shouldTreatAsHandDrop(event.clientY)) {
        const targetIndex = normalizeHandDropIndex(getHandInsertIndex(event.clientX), null);
        const result = await api("/api/pickup-to-hand", {
          stackId: dragging.stackId,
          toIndex: targetIndex === null ? undefined : targetIndex,
        });
        if (result.error) setLoginMessage(result.error);
      } else if (dragging.moved && dragging.stackIds.length === 1 && highlightedTargetId) {
        await api("/api/stack", {
          sourceStackId: dragging.stackId,
          targetStackId: highlightedTargetId,
        });
      } else if (!dragging.moved) {
        const stack = gameRef.current.state.stacks[dragging.stackId];
        if (stack && stack.cardIds.length > 0) {
          if (menuOpenTimerRef.current) clearTimeout(menuOpenTimerRef.current);
          menuOpenTimerRef.current = setTimeout(() => {
            setMenuState({
              visible: true,
              x: event.clientX,
              y: event.clientY,
              stackId: dragging.stackId,
            });
            menuOpenTimerRef.current = null;
          }, MENU_OPEN_DELAY_MS);
        }
      }

      draggingRef.current = null;
      setHighlightedTargetId(null);
      setHandDropIndex(null);
      setHandInsertGhostCardId(null);
      setHandRaised(false);
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
    event.stopPropagation();
    handleCardHoverEnd(hoverCandidateRef.current);
    const currentSelection = selectedStackIds.includes(stackId) ? selectedStackIds : [stackId];
    setSelectedStackIds(currentSelection);
    const anchors = {};
    currentSelection.forEach((id) => {
      const stack = gameRef.current.state.stacks[id];
      if (stack) anchors[id] = { x: stack.x, y: stack.y };
    });
    const currentStack = gameRef.current.state.stacks[stackId];
    if (!currentStack) return;
    const rect = tableRef.current.getBoundingClientRect();
    draggingRef.current = {
      stackId,
      stackIds: currentSelection,
      anchors,
      startX: currentStack.x,
      startY: currentStack.y,
      originX: event.clientX,
      originY: event.clientY,
      moved: false,
      offsetX: event.clientX - rect.left - viewedPosition.x,
      offsetY: event.clientY - rect.top - viewedPosition.y,
    };
  }

  function onTablePointerDown(event) {
    if (!tableRef.current || event.button !== 0) return;
    const interactiveAncestor = event.target.closest(".stack, .card-menu, .player-hand-zone, .opponent-hand-zone");
    if (interactiveAncestor) return;

    setSelectedStackIds([]);
    setMenuState((current) => ({ ...current, visible: false }));
    setHighlightedTargetId(null);

    selectionRef.current = {
      active: true,
      originX: event.clientX,
      originY: event.clientY,
    };
    const tableRect = tableRef.current.getBoundingClientRect();
    setSelectionBox(
      viewportToTableRect(
        {
          left: event.clientX,
          top: event.clientY,
          right: event.clientX,
          bottom: event.clientY,
        },
        tableRect,
      ),
    );
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
    } else if (action === "shuffle") {
      const result = await api("/api/shuffle", { stackId });
      if (result.error) setLoginMessage(result.error);
    } else if (action === "tap-all") {
      await api("/api/tap", { stackId, scope: "all", tapped: true });
    } else if (action === "untap-all") {
      await api("/api/tap", { stackId, scope: "all", tapped: false });
    }

    setMenuState((current) => ({ ...current, visible: false }));
  }

  function handleCardHoverStart(cardId) {
    if (!cardId) return;
    if (draggingRef.current || handDraggingRef.current || draggedHandIndex !== null || handDragPreview) return;
    if (Date.now() - recentDoubleClickRef.current < 350) return;
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverCandidateRef.current = cardId;
    hoverTimerRef.current = setTimeout(() => {
      if (hoverCandidateRef.current === cardId) {
        setHoverPreviewCardId(cardId);
      }
    }, HOVER_PREVIEW_DELAY_MS);
  }

  function handleCardHoverEnd(cardId) {
    if (hoverCandidateRef.current === cardId) hoverCandidateRef.current = null;
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHoverPreviewCardId(null);
  }

  function getTableWorldBounds() {
    const minX = tableWidth * 0.02;
    const minY = tableHeight * 0.02;
    const maxX = Math.max(minX, tableWidth * 0.98 - BOARD_CARD_WIDTH);
    const maxY = Math.max(minY, tableHeight * 0.98 - BOARD_CARD_HEIGHT);
    return { minX, minY, maxX, maxY };
  }

  function worldToView(x, y, currentGame = game, currentMe = me) {
    if (!isPlayerTwoPerspective(currentGame, currentMe)) return { x, y };
    const bounds = getTableWorldBounds();
    return {
      x: bounds.minX + bounds.maxX - x,
      y: bounds.minY + bounds.maxY - y,
    };
  }

  function viewToWorld(x, y, currentGame = game, currentMe = me) {
    if (!isPlayerTwoPerspective(currentGame, currentMe)) return { x, y };
    const bounds = getTableWorldBounds();
    return {
      x: bounds.minX + bounds.maxX - x,
      y: bounds.minY + bounds.maxY - y,
    };
  }

  const perspectiveP2 = isPlayerTwoPerspective(game, me);
  const myHandIds = me ? game.state.hands?.[me.id]?.cardIds || [] : [];
  const opponent = me ? game.players.find((player) => player.id !== me.id) : null;
  const opponentHandCount = opponent ? game.state.hands?.[opponent.id]?.count || 0 : 0;

  const handLayout = useMemo(() => {
    const count = myHandIds.length;
    const cardWidth = 90;
    const tinyGap = 4;
    const maxWidth = Math.max(cardWidth, tableWidth * 0.75);
    if (count <= 1) {
      return { cardWidth, spacing: 0, handWidth: cardWidth, startX: (tableWidth - cardWidth) / 2 };
    }

    const naturalWidth = count * cardWidth + (count - 1) * tinyGap;
    const spacing =
      naturalWidth <= maxWidth
        ? cardWidth + tinyGap
        : Math.max(24, Math.min(cardWidth + tinyGap, (maxWidth - cardWidth) / (count - 1)));
    const handWidth = cardWidth + (count - 1) * spacing;
    const startX = (tableWidth - handWidth) / 2;

    return { cardWidth, spacing, handWidth, startX };
  }, [myHandIds.length, tableWidth]);

  function normalizeHandDropIndex(targetIndex, sourceIndex = draggedHandIndex) {
    if (targetIndex === null) return null;
    if (sourceIndex === null) return targetIndex;
    const clamped = Math.max(0, Math.min(myHandIds.length, targetIndex));
    if (clamped === sourceIndex) return null;
    if (clamped > sourceIndex) return Math.min(myHandIds.length, clamped + 1);
    return clamped;
  }

  async function onHandDrop(targetIndex, sourceIndex = draggedHandIndex) {
    if (sourceIndex === null || targetIndex === null) return;
    const validTargetIndex = normalizeHandDropIndex(targetIndex, sourceIndex);
    if (validTargetIndex === null) {
      setDraggedHandIndex(null);
      setHandDropIndex(null);
      setHandRaised(false);
      return;
    }
    const result = await api("/api/reorder-hand", { fromIndex: sourceIndex, toIndex: validTargetIndex });
    if (result.error) setLoginMessage(result.error);
    setDraggedHandIndex(null);
    setHandDropIndex(null);
    setHandRaised(false);
  }


  function getBoardDropPreview(event) {
    if (!tableRef.current) return null;
    const rect = tableRef.current.getBoundingClientRect();
    const viewX = event.clientX - rect.left - BOARD_CARD_WIDTH / 2;
    const viewY = event.clientY - rect.top - BOARD_CARD_HEIGHT / 2;
    const targetStackId = getTargetStackId(null, viewX, viewY, gameRef.current, meRef.current, worldToView);

    if (targetStackId) {
      const targetStack = gameRef.current.state.stacks[targetStackId];
      const viewedPosition = worldToView(targetStack.x, targetStack.y, gameRef.current, meRef.current);
      return { x: viewedPosition.x, y: viewedPosition.y, targetStackId };
    }

    const bounds = getTableWorldBounds();
    return {
      x: Math.max(bounds.minX, Math.min(bounds.maxX, viewX)),
      y: Math.max(bounds.minY, Math.min(bounds.maxY, viewY)),
      targetStackId: null,
    };
  }

  function shouldTreatAsHandDrop(clientY) {
    const tableEl = tableRef.current;
    if (!tableEl) return false;
    const rect = tableEl.getBoundingClientRect();
    return clientY >= rect.bottom - HAND_SNAP_MARGIN;
  }

  function isPointerInHandZone(clientX, clientY) {
    const handZone = handZoneRef.current;
    if (!handZone) return shouldTreatAsHandDrop(clientY);
    const rect = handZone.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  }

  function getHandInsertIndex(clientX) {
    const tableEl = tableRef.current;
    if (!tableEl) return myHandIds.length;
    const rect = tableEl.getBoundingClientRect();
    const relativeX = clientX - rect.left - handLayout.startX;
    if (myHandIds.length <= 1 || handLayout.spacing <= 0) {
      return relativeX < handLayout.cardWidth / 2 ? 0 : myHandIds.length;
    }
    return Math.max(0, Math.min(myHandIds.length, Math.round(relativeX / handLayout.spacing)));
  }

  const handPreviewItems = useMemo(() => {
    const items = myHandIds.map((cardId, idx) => ({ type: "card", cardId, originalIndex: idx }));
    if (draggedHandIndex === null) {
      if (handInsertGhostCardId !== null && handDropIndex !== null) {
        const insertionIndex = Math.max(0, Math.min(items.length, handDropIndex));
        items.splice(insertionIndex, 0, { type: "ghost", cardId: handInsertGhostCardId, originalIndex: -1 });
      }
      return items;
    }

    const draggedItem = items[draggedHandIndex];
    const remainingItems = items.filter((_, idx) => idx !== draggedHandIndex);
    if (handDropIndex === null) return remainingItems;

    const clampedPreviewIndex = Math.max(0, Math.min(items.length, handDropIndex));
    const insertionIndex = Math.max(
      0,
      Math.min(remainingItems.length, clampedPreviewIndex > draggedHandIndex ? clampedPreviewIndex - 1 : clampedPreviewIndex),
    );
    remainingItems.splice(insertionIndex, 0, {
      type: "ghost",
      cardId: draggedItem.cardId,
      originalIndex: draggedHandIndex,
    });
    return remainingItems;
  }, [myHandIds, draggedHandIndex, handDropIndex, handInsertGhostCardId]);

  async function tapStack(stackId) {
    await api("/api/tap", { stackId, scope: "top" });
  }

  async function tapCard(stackId, cardId) {
    await api("/api/tap", { stackId, scope: "card", cardId });
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
        React.createElement("h2", null, "Log"),
        React.createElement(
          "ul",
          { className: "log-list" },
          (game.state.log || []).length === 0
            ? React.createElement("li", { className: "log-empty" }, "No actions yet.")
            : (game.state.log || []).slice().reverse().map((entry, idx) => React.createElement("li", { key: `${entry}-${idx}` }, entry)),
        ),
      ),
    ),
    React.createElement(
      "main",
      {
        ref: tableRef,
        className: perspectiveP2 ? "table perspective-p2" : "table",
        onPointerDown: onTablePointerDown,
        onPointerMove: (event) => {
          if (!tableRef.current) return;
          const rect = tableRef.current.getBoundingClientRect();
          setHandRaised(event.clientY >= rect.bottom - HAND_REVEAL_MARGIN);
        },
        onPointerLeave: () => {
          setHandRaised(false);
          handleCardHoverEnd(hoverCandidateRef.current);
        },
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
          const visibleCount = Math.min(stack.cardIds.length, 30);
          const offset = stackOffsetPx(stack.cardIds.length, visibleCount);
          const cardsToRender = stack.cardIds.slice(stack.cardIds.length - visibleCount);
          const topCardOffset = Math.max(0, (visibleCount - 1) * offset);
          const topCardId = stack.cardIds[stack.cardIds.length - 1];
          const topCard = game.state.cards[topCardId];
          const isStackHighlighted =
            selectedStackIds.includes(stack.id) || highlightedTargetId === stack.id || (boardDropPreview && boardDropPreview.targetStackId === stack.id);

          return React.createElement(
            "div",
            {
              key: stack.id,
              className: isStackHighlighted ? `stack stack-highlight ${topCard?.tapped ? "stack-highlight-tapped" : ""}`.trim() : "stack",
              style: {
                left: `${viewedPosition.x}px`,
                top: `${viewedPosition.y}px`,
                "--stack-top-offset": `${topCardOffset}px`,
              },
              onMouseEnter: () => handleCardHoverStart(topCardId),
              onMouseLeave: () => handleCardHoverEnd(topCardId),
              onPointerDown: (event) => onStackPointerDown(event, stack.id, viewedPosition),
              onDoubleClick: (event) => {
                event.preventDefault();
                recentDoubleClickRef.current = Date.now();
                if (menuOpenTimerRef.current) {
                  clearTimeout(menuOpenTimerRef.current);
                  menuOpenTimerRef.current = null;
                }
                setMenuState((current) => ({ ...current, visible: false }));
                handleCardHoverEnd(stack.cardIds[stack.cardIds.length - 1]);
                tapStack(stack.id);
              },
            },
            cardsToRender.map((cardId, index) => {
              const card = game.state.cards[cardId];
              return React.createElement(
                "div",
                {
                  key: cardId,
                  className: `card ${card.faceUp ? "faceup" : "facedown"} ${card.faceUp && isRedSuit(card) ? "card-red" : ""} ${
                    isStackHighlighted && index === cardsToRender.length - 1 && !card.tapped ? "card-stack-highlight" : ""
                  }`,
                  onMouseEnter: () => handleCardHoverStart(cardId),
                  onMouseLeave: () => handleCardHoverEnd(cardId),
                  onDoubleClick: (event) => {
                    event.stopPropagation();
                    recentDoubleClickRef.current = Date.now();
                    if (menuOpenTimerRef.current) {
                      clearTimeout(menuOpenTimerRef.current);
                      menuOpenTimerRef.current = null;
                    }
                    setMenuState((current) => ({ ...current, visible: false }));
                    handleCardHoverEnd(cardId);
                    tapCard(stack.id, cardId);
                  },
                  style: {
                    transform: `translate(${index * offset}px, ${index * offset}px)${card.tapped ? " rotate(90deg)" : ""}`,
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
        {
          ref: handZoneRef,
          className: `player-hand-zone ${handRaised || draggedHandIndex !== null ? "raised" : ""}`,
        },
        handPreviewItems.map((item, idx) => {
          const card = game.state.cards[item.cardId];
          const left = handLayout.startX + idx * handLayout.spacing;
          return React.createElement(
            "div",
            {
              key: `${item.type}-${item.cardId}-${idx}`,
              className: `card faceup card-hand ${isRedSuit(card) ? "card-red" : ""} ${item.type === "ghost" ? "card-hand-ghost" : ""}`,
              style: { left: `${left}px`, zIndex: String(idx + 1) },
              onMouseEnter: () => handleCardHoverStart(item.cardId),
              onMouseLeave: () => handleCardHoverEnd(item.cardId),
              onPointerDown:
                item.type === "card"
                  ? (event) => {
                      if (event.button !== 0) return;
                      event.preventDefault();
                      handleCardHoverEnd(item.cardId);
                      const rect = event.currentTarget.getBoundingClientRect();
                      handDraggingRef.current = {
                        sourceIndex: item.originalIndex,
                        cardId: item.cardId,
                        originX: event.clientX,
                        originY: event.clientY,
                        offsetX: event.clientX - rect.left,
                        offsetY: event.clientY - rect.top,
                        moved: false,
                      };
                      setHandDropIndex(null);
                      setBoardDropPreview(null);
                    }
                  : undefined,
            },
            cardLabel(card),
          );
        }),
      ),
      boardDropPreview
        ? React.createElement("div", {
            className: "board-drop-outline",
            style: { left: `${boardDropPreview.x}px`, top: `${boardDropPreview.y}px` },
          })
        : null,
      selectionBox
        ? React.createElement("div", {
            className: "selection-box",
            style: {
              left: `${selectionBox.left}px`,
              top: `${selectionBox.top}px`,
              width: `${Math.max(0, selectionBox.right - selectionBox.left)}px`,
              height: `${Math.max(0, selectionBox.bottom - selectionBox.top)}px`,
            },
          })
        : null,

      handDragPreview
        ? React.createElement(
            "div",
            {
              className: `card faceup card-hand card-hand-dragging ${isRedSuit(game.state.cards[handDragPreview.cardId]) ? "card-red" : ""}`,
              style: {
                left: `${handDragPreview.x}px`,
                top: `${handDragPreview.y}px`,
                zIndex: "999",
              },
            },
            cardLabel(game.state.cards[handDragPreview.cardId]),
          )
        : null,
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
            game.state.stacks[menuState.stackId] && game.state.stacks[menuState.stackId].cardIds.length > 1
              ? React.createElement("button", { className: "menu-btn", onClick: () => handleMenuAction("shuffle") }, "Shuffle")
              : null,
            game.state.stacks[menuState.stackId] &&
            game.state.stacks[menuState.stackId].cardIds.some((cardId) => !game.state.cards[cardId]?.tapped)
              ? React.createElement("button", { className: "menu-btn", onClick: () => handleMenuAction("tap-all") }, "Tap all")
              : null,
            game.state.stacks[menuState.stackId] &&
            game.state.stacks[menuState.stackId].cardIds.some((cardId) => game.state.cards[cardId]?.tapped)
              ? React.createElement("button", { className: "menu-btn", onClick: () => handleMenuAction("untap-all") }, "Untap all")
              : null,
          ),
        )
      : null,
    hoverPreviewCardId
      ? React.createElement(
          "div",
          { className: "overlay overlay-preview" },
          React.createElement(
            "dialog",
            { open: true },
            React.createElement(
              "div",
              {
                className: `card card-large ${game.state.cards[hoverPreviewCardId]?.faceUp ? "faceup" : "facedown"} ${isRedSuit(game.state.cards[hoverPreviewCardId]) ? "card-red" : ""}`,
              },
              game.state.cards[hoverPreviewCardId]?.faceUp ? cardLabel(game.state.cards[hoverPreviewCardId]) : "🂠",
            ),
          ),
        )
      : null,
  );
}

function isPlayerTwoPerspective(game, me) {
  if (!me) return false;
  return game.players.findIndex((player) => player.id === me.id) === 1;
}

function getTargetStackId(sourceStackId, viewX, viewY, game, me, worldToViewFn) {
  for (const stack of Object.values(game.state.stacks)) {
    if (sourceStackId && stack.id === sourceStackId) continue;
    const viewed = worldToViewFn(stack.x, stack.y, game, me);
    const distance = Math.hypot(viewed.x - viewX, viewed.y - viewY);
    if (distance < SNAP_DISTANCE) return stack.id;
  }
  return null;
}

function viewportToTableRect(rect, tableRect) {
  if (!tableRect) return null;
  return {
    left: rect.left - tableRect.left,
    top: rect.top - tableRect.top,
    right: rect.right - tableRect.left,
    bottom: rect.bottom - tableRect.top,
  };
}

function makeRect(ax, ay, bx, by) {
  return {
    left: Math.min(ax, bx),
    top: Math.min(ay, by),
    right: Math.max(ax, bx),
    bottom: Math.max(ay, by),
  };
}

function rectsIntersect(a, b) {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

const root = ReactDOM.createRoot(document.getElementById("app"));
root.render(React.createElement(App));
