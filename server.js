const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const DISCONNECT_TIMEOUT_MS = 30_000;
const SIZE_RANK = { S: 1, M: 2, L: 3 };
const ALL_SIZES = ["S", "M", "L"];

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

/** @type {Map<string, any>} */
const rooms = new Map();

function createEmptyBoard() {
  return Array.from({ length: 3 }, () =>
    Array.from({ length: 3 }, () => [])
  );
}

function createInitialHands() {
  return {
    host: { S: 2, M: 2, L: 2 },
    guest: { S: 2, M: 2, L: 2 },
  };
}

function randomRoomId() {
  for (let i = 0; i < 100; i += 1) {
    const roomId = String(Math.floor(10000 + Math.random() * 90000));
    if (!rooms.has(roomId)) {
      return roomId;
    }
  }
  throw new Error("Could not create a unique room ID");
}

function makeRoom(roomId, hostPlayerId) {
  return {
    roomId,
    status: "waiting",
    players: { host: hostPlayerId, guest: null },
    sockets: { host: null, guest: null },
    connectionStatus: { host: false, guest: false },
    disconnectTimers: { host: null, guest: null },
    turn: "host",
    winner: null,
    hands: createInitialHands(),
    board: createEmptyBoard(),
    lastMove: null,
    pieceCounter: 0,
  };
}

function topPiece(stack) {
  return stack.length > 0 ? stack[stack.length - 1] : null;
}

function canStack(movingSize, targetStack) {
  const targetTop = topPiece(targetStack);
  if (!targetTop) {
    return true;
  }
  return SIZE_RANK[movingSize] > SIZE_RANK[targetTop.size];
}

function topOwnerAt(board, row, col) {
  const top = topPiece(board[row][col]);
  return top ? top.owner : null;
}

function detectWinner(board) {
  const lines = [
    [
      [0, 0],
      [0, 1],
      [0, 2],
    ],
    [
      [1, 0],
      [1, 1],
      [1, 2],
    ],
    [
      [2, 0],
      [2, 1],
      [2, 2],
    ],
    [
      [0, 0],
      [1, 0],
      [2, 0],
    ],
    [
      [0, 1],
      [1, 1],
      [2, 1],
    ],
    [
      [0, 2],
      [1, 2],
      [2, 2],
    ],
    [
      [0, 0],
      [1, 1],
      [2, 2],
    ],
    [
      [0, 2],
      [1, 1],
      [2, 0],
    ],
  ];

  for (const line of lines) {
    const [a, b, c] = line;
    const ownerA = topOwnerAt(board, a[0], a[1]);
    const ownerB = topOwnerAt(board, b[0], b[1]);
    const ownerC = topOwnerAt(board, c[0], c[1]);
    if (ownerA && ownerA === ownerB && ownerB === ownerC) {
      return ownerA;
    }
  }
  return null;
}

function isValidCell(row, col) {
  return Number.isInteger(row) && Number.isInteger(col) && row >= 0 && row < 3 && col >= 0 && col < 3;
}

function roomStateForClient(room) {
  return {
    roomId: room.roomId,
    status: room.status,
    players: room.players,
    turn: room.turn,
    winner: room.winner,
    hands: room.hands,
    board: room.board,
    lastMove: room.lastMove,
    connectionStatus: room.connectionStatus,
  };
}

function emitState(room, eventName = "stateUpdate") {
  io.to(room.roomId).emit(eventName, roomStateForClient(room));
}

function assignSocketToRole(room, socket, role) {
  room.sockets[role] = socket.id;
  room.connectionStatus[role] = true;
  socket.data.roomId = room.roomId;
  socket.data.role = role;
  socket.join(room.roomId);

  if (room.disconnectTimers[role]) {
    clearTimeout(room.disconnectTimers[role]);
    room.disconnectTimers[role] = null;
  }
}

function roleFromSocket(room, socketId) {
  if (room.sockets.host === socketId) return "host";
  if (room.sockets.guest === socketId) return "guest";
  return null;
}

io.on("connection", (socket) => {
  socket.on("createRoom", ({ playerId }) => {
    if (!playerId) {
      socket.emit("errorMessage", "playerId is required");
      return;
    }

    const roomId = randomRoomId();
    const room = makeRoom(roomId, playerId);
    rooms.set(roomId, room);
    assignSocketToRole(room, socket, "host");

    socket.emit("roomCreated", {
      roomId,
      role: "host",
      state: roomStateForClient(room),
    });
    emitState(room);
  });

  socket.on("joinRoom", ({ roomId, playerId }) => {
    if (!roomId || !playerId) {
      socket.emit("errorMessage", "roomId and playerId are required");
      return;
    }
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit("errorMessage", "Room not found");
      return;
    }

    let role = null;
    if (room.players.host === playerId) {
      role = "host";
    } else if (room.players.guest === playerId) {
      role = "guest";
    } else if (room.status === "waiting" && !room.players.guest) {
      room.players.guest = playerId;
      role = "guest";
    }

    if (!role) {
      socket.emit("errorMessage", "Room is full or not joinable");
      return;
    }

    assignSocketToRole(room, socket, role);
    socket.emit("roomJoined", { roomId, role, state: roomStateForClient(room) });

    if (room.players.host && room.players.guest && room.status === "waiting") {
      room.status = "playing";
      room.turn = "host";
      emitState(room, "gameStart");
    }
    emitState(room);
  });

  socket.on("makeMove", ({ roomId, from, to }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit("errorMessage", "Room not found");
      return;
    }
    if (room.status !== "playing") {
      socket.emit("errorMessage", "Game is not in playing status");
      return;
    }

    const role = roleFromSocket(room, socket.id);
    if (!role) {
      socket.emit("errorMessage", "You are not assigned to this room");
      return;
    }
    if (role !== room.turn) {
      socket.emit("errorMessage", "It is not your turn");
      return;
    }
    if (!to || !isValidCell(to.row, to.col)) {
      socket.emit("errorMessage", "Invalid target cell");
      return;
    }

    const targetStack = room.board[to.row][to.col];
    let movedPiece = null;
    let fromSnapshot = null;

    if (from?.type === "hand") {
      const size = from.size;
      if (!ALL_SIZES.includes(size)) {
        socket.emit("errorMessage", "Invalid piece size");
        return;
      }
      if (room.hands[role][size] <= 0) {
        socket.emit("errorMessage", "No remaining pieces of that size");
        return;
      }
      if (!canStack(size, targetStack)) {
        socket.emit("errorMessage", "Cannot place a smaller or equal piece on top");
        return;
      }

      room.hands[role][size] -= 1;
      room.pieceCounter += 1;
      movedPiece = {
        id: `${role}-${size}-${room.pieceCounter}`,
        owner: role,
        size,
      };
      fromSnapshot = { type: "hand", size };
    } else if (from?.type === "board" && isValidCell(from.row, from.col)) {
      if (from.row === to.row && from.col === to.col) {
        socket.emit("errorMessage", "Source and target cannot be the same");
        return;
      }
      const sourceStack = room.board[from.row][from.col];
      const sourceTop = topPiece(sourceStack);
      if (!sourceTop) {
        socket.emit("errorMessage", "No piece in source cell");
        return;
      }
      if (sourceTop.owner !== role) {
        socket.emit("errorMessage", "You can only move your top piece");
        return;
      }
      if (!canStack(sourceTop.size, targetStack)) {
        socket.emit("errorMessage", "Cannot move piece onto same or larger size");
        return;
      }

      movedPiece = sourceStack.pop();
      fromSnapshot = { type: "board", row: from.row, col: from.col };
    } else {
      socket.emit("errorMessage", "Invalid move source");
      return;
    }

    targetStack.push(movedPiece);
    room.lastMove = {
      by: role,
      piece: movedPiece,
      from: fromSnapshot,
      to: { row: to.row, col: to.col },
      at: Date.now(),
    };

    const winner = detectWinner(room.board);
    if (winner) {
      room.winner = winner;
      room.status = "finished";
      emitState(room);
      io.to(room.roomId).emit("gameOver", {
        winner,
        reason: "line-complete",
      });
      return;
    }

    room.turn = role === "host" ? "guest" : "host";
    emitState(room);
  });

  socket.on("disconnect", () => {
    const { roomId } = socket.data;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const role = roleFromSocket(room, socket.id) || socket.data.role;
    if (!role) return;

    room.sockets[role] = null;
    room.connectionStatus[role] = false;
    emitState(room);

    if (room.status !== "playing" || room.winner) {
      return;
    }

    if (!room.disconnectTimers[role]) {
      room.disconnectTimers[role] = setTimeout(() => {
        const latest = rooms.get(roomId);
        if (!latest) return;
        if (latest.connectionStatus[role]) return;
        if (latest.status !== "playing" || latest.winner) return;

        const winner = role === "host" ? "guest" : "host";
        latest.winner = winner;
        latest.status = "finished";
        latest.lastMove = {
          by: winner,
          piece: null,
          from: null,
          to: null,
          at: Date.now(),
          meta: "opponent-disconnected-timeout",
        };
        emitState(latest);
        io.to(latest.roomId).emit("gameOver", {
          winner,
          reason: "disconnect-timeout",
        });
      }, DISCONNECT_TIMEOUT_MS);
    }
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server started: http://localhost:${PORT}`);
});
