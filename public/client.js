const socket = io();

const createRoomBtn = document.getElementById("createRoomBtn");
const joinRoomBtn = document.getElementById("joinRoomBtn");
const roomIdInput = document.getElementById("roomIdInput");
const roomInfo = document.getElementById("roomInfo");
const waitingText = document.getElementById("waitingText");
const lobbySection = document.getElementById("lobbySection");
const gameSection = document.getElementById("gameSection");
const statusText = document.getElementById("statusText");
const connectionText = document.getElementById("connectionText");
const boardEl = document.getElementById("board");
const myHandEl = document.getElementById("myHand");
const opponentHandEl = document.getElementById("opponentHand");
const selectedInfo = document.getElementById("selectedInfo");
const messageText = document.getElementById("messageText");

const storageKey = "sample-game-player-id";
let playerId = localStorage.getItem(storageKey);
if (!playerId) {
  playerId = `p-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  localStorage.setItem(storageKey, playerId);
}

let roomId = null;
let myRole = null;
let gameState = null;
let selected = null; // { type: "hand", size } or { type: "board", row, col }

function setMessage(message) {
  messageText.textContent = message || "";
}

function toRoleLabel(role) {
  return role === "host" ? "ホスト" : "ゲスト";
}

function isMyTurn() {
  return gameState && gameState.status === "playing" && gameState.turn === myRole;
}

function clearSelection() {
  selected = null;
  selectedInfo.textContent = "選択中のコマ: なし";
}

function selectSource(source, label) {
  selected = source;
  selectedInfo.textContent = `選択中のコマ: ${label}`;
}

function handCountText(hand) {
  return `S:${hand.S} / M:${hand.M} / L:${hand.L}`;
}

function currentOpponentRole() {
  return myRole === "host" ? "guest" : "host";
}

function pieceLabel(piece) {
  return `${piece.owner === "host" ? "H" : "G"}-${piece.size}`;
}

function renderBoard() {
  boardEl.innerHTML = "";
  if (!gameState) return;

  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const cell = document.createElement("button");
      cell.className = "cell";
      cell.type = "button";

      if (
        gameState.lastMove &&
        gameState.lastMove.to &&
        gameState.lastMove.to.row === row &&
        gameState.lastMove.to.col === col
      ) {
        cell.classList.add("last-move");
      }

      if (
        selected &&
        selected.type === "board" &&
        selected.row === row &&
        selected.col === col
      ) {
        cell.classList.add("selected-source");
      }

      const stack = gameState.board[row][col];
      const top = stack.length > 0 ? stack[stack.length - 1] : null;
      if (top) {
        const piece = document.createElement("div");
        piece.className = `piece ${top.owner} size-${top.size}`;
        piece.textContent = pieceLabel(top);
        cell.appendChild(piece);
      } else {
        const empty = document.createElement("span");
        empty.className = "muted";
        empty.textContent = "空";
        cell.appendChild(empty);
      }

      cell.addEventListener("click", () => onCellClick(row, col));
      boardEl.appendChild(cell);
    }
  }
}

function renderHands() {
  if (!gameState || !myRole) return;
  myHandEl.innerHTML = "";
  opponentHandEl.innerHTML = "";

  const myHand = gameState.hands[myRole];
  const opponentRole = currentOpponentRole();
  const opponentHand = gameState.hands[opponentRole];

  ["S", "M", "L"].forEach((size) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "hand-item";
    item.textContent = `${size} x ${myHand[size]}`;
    if (myHand[size] <= 0) {
      item.disabled = true;
    }
    if (selected && selected.type === "hand" && selected.size === size) {
      item.classList.add("selected");
    }
    item.addEventListener("click", () => onHandClick(size));
    myHandEl.appendChild(item);
  });

  const opp = document.createElement("div");
  opp.className = "hand-item";
  opp.textContent = handCountText(opponentHand);
  opponentHandEl.appendChild(opp);
}

function renderStatus() {
  if (!gameState || !myRole) return;
  const opponentRole = currentOpponentRole();
  const myConnection = gameState.connectionStatus[myRole] ? "接続中" : "切断";
  const oppConnection = gameState.connectionStatus[opponentRole] ? "接続中" : "切断";
  connectionText.textContent = `接続状態: 自分 ${myConnection} / 相手 ${oppConnection}`;

  if (gameState.status === "waiting") {
    statusText.textContent = "対戦相手を待っています...";
    waitingText.classList.remove("hidden");
    return;
  }
  waitingText.classList.add("hidden");

  if (gameState.status === "finished") {
    if (gameState.winner) {
      statusText.textContent =
        gameState.winner === myRole ? "ゲーム終了: あなたの勝ち" : "ゲーム終了: あなたの負け";
    } else {
      statusText.textContent = "ゲーム終了";
    }
    return;
  }

  statusText.textContent = isMyTurn()
    ? "あなたのターンです"
    : "相手のターンです（操作ロック中）";
}

function render() {
  if (!gameState) return;
  renderStatus();
  renderBoard();
  renderHands();
}

function showGame() {
  lobbySection.classList.add("hidden");
  gameSection.classList.remove("hidden");
}

function onHandClick(size) {
  setMessage("");
  if (!gameState) return;
  if (!isMyTurn()) {
    setMessage("相手のターン中は操作できません。");
    return;
  }
  if (gameState.hands[myRole][size] <= 0) {
    setMessage("そのサイズの持ち駒はありません。");
    return;
  }
  selectSource({ type: "hand", size }, `手駒 ${size}`);
  render();
}

function onCellClick(row, col) {
  setMessage("");
  if (!gameState || !myRole) return;
  if (!isMyTurn()) {
    setMessage("相手のターン中は操作できません。");
    return;
  }

  if (!selected) {
    const stack = gameState.board[row][col];
    const top = stack.length > 0 ? stack[stack.length - 1] : null;
    if (!top || top.owner !== myRole) {
      setMessage("まず自分の持ち駒または盤上の自分の最上段コマを選択してください。");
      return;
    }
    selectSource({ type: "board", row, col }, `盤上 (${row + 1},${col + 1})`);
    render();
    return;
  }

  socket.emit("makeMove", {
    roomId,
    from: selected,
    to: { row, col },
  });
  clearSelection();
}

createRoomBtn.addEventListener("click", () => {
  setMessage("");
  socket.emit("createRoom", { playerId });
});

joinRoomBtn.addEventListener("click", () => {
  setMessage("");
  const inputRoomId = roomIdInput.value.trim();
  if (!/^\d{5}$/.test(inputRoomId)) {
    setMessage("5桁のルームIDを入力してください。");
    return;
  }
  socket.emit("joinRoom", { roomId: inputRoomId, playerId });
});

socket.on("roomCreated", ({ roomId: createdRoomId, role, state }) => {
  roomId = createdRoomId;
  myRole = role;
  gameState = state;
  roomInfo.textContent = `ルームID: ${roomId}（${toRoleLabel(role)}）`;
  waitingText.classList.remove("hidden");
  showGame();
  render();
});

socket.on("roomJoined", ({ roomId: joinedRoomId, role, state }) => {
  roomId = joinedRoomId;
  myRole = role;
  gameState = state;
  roomInfo.textContent = `ルームID: ${roomId}（${toRoleLabel(role)}）`;
  showGame();
  render();
});

socket.on("gameStart", (state) => {
  gameState = state;
  render();
});

socket.on("stateUpdate", (state) => {
  gameState = state;
  if (gameState.status !== "playing") {
    clearSelection();
  }
  render();
});

socket.on("gameOver", ({ winner, reason }) => {
  if (reason === "disconnect-timeout") {
    setMessage(
      winner === myRole
        ? "相手が復帰しなかったため不戦勝になりました。"
        : "切断復帰できなかったため敗北になりました。"
    );
  } else {
    setMessage(winner === myRole ? "あなたの勝利です。" : "あなたの敗北です。");
  }
});

socket.on("errorMessage", (message) => {
  setMessage(message);
});

socket.on("connect", () => {
  if (roomId) {
    socket.emit("joinRoom", { roomId, playerId });
  }
});
