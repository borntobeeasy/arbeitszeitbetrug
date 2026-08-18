// ─── server.js ───────────────────────────────────────────────
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

// ─── Statische Dateien aus dem public-Ordner ──────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Fallback für alle anderen Anfragen ─────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── In-Memory-Store ─────────────────────────────────────────
const rooms = new Map();

// ─── Hilfsfunktionen ─────────────────────────────────────────
function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 5; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

function getPlayerById(room, playerId) {
  return room.players.find(p => p.id === playerId);
}

function getActivePlayers(room) {
  return room.players.filter(p => p.status !== 'FOLD' && p.status !== 'OUT');
}

function rotateDealer(room) {
  room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
}

function getBlindPositions(room) {
  const dealer = room.dealerIndex;
  const players = room.players;
  const active = players.filter(p => p.status !== 'OUT');
  if (active.length < 2) return { sb: -1, bb: -1 };
  const sbIdx = (dealer + 1) % players.length;
  const bbIdx = (dealer + 2) % players.length;
  return { sb: sbIdx, bb: bbIdx };
}

// ─── Fragen-Datenbank (MVP) ──────────────────────────────────
const questions = [
  {
    id: 'q1',
    question: 'Wie viele deutsche Meisterschaften hat der FC Bayern gewonnen?',
    answer: 33,
    unit: 'Meisterschaften',
    category: 'Fußball',
    difficulty: 'easy',
    hints: [
      { text: 'Die Zahl ist kleiner als 40.', type: 'upper' },
      { text: 'Die Zahl ist größer als 30.', type: 'lower' },
    ],
  },
  {
    id: 'q2',
    question: 'Wie viele Bundesländer hat Deutschland?',
    answer: 16,
    unit: 'Bundesländer',
    category: 'Deutschland',
    difficulty: 'easy',
    hints: [
      { text: 'Die Zahl ist kleiner als 20.', type: 'upper' },
      { text: 'Die Zahl ist größer als 10.', type: 'lower' },
    ],
  },
  {
    id: 'q3',
    question: 'Wie viele Planeten hat unser Sonnensystem (inklusive Pluto)?',
    answer: 9,
    unit: 'Planeten',
    category: 'Wissenschaft',
    difficulty: 'medium',
    hints: [
      { text: 'Die Zahl ist kleiner als 12.', type: 'upper' },
      { text: 'Die Zahl ist größer als 7.', type: 'lower' },
    ],
  },
];

let questionIndex = 0;

function getNextQuestion() {
  const q = questions[questionIndex % questions.length];
  questionIndex++;
  return { ...q };
}

// ─── Spielphasen ──────────────────────────────────────────────
const PHASES = {
  LOBBY: 'LOBBY',
  QUESTION: 'QUESTION',
  GUESSING: 'GUESSING',
  BETTING_1: 'BETTING_1',
  HINT_1: 'HINT_1',
  BETTING_2: 'BETTING_2',
  HINT_2: 'HINT_2',
  BETTING_3: 'BETTING_3',
  REVEAL: 'REVEAL',
  FINAL_BETTING: 'FINAL_BETTING',
  SHOWDOWN: 'SHOWDOWN',
  RESULT: 'RESULT',
};

const BETTING_PHASES = [
  PHASES.BETTING_1,
  PHASES.BETTING_2,
  PHASES.BETTING_3,
  PHASES.FINAL_BETTING,
];

// ─── Raum erstellen ───────────────────────────────────────────
function createRoom(hostId, hostName, settings = {}) {
  const roomId = generateRoomId();
  const room = {
    roomId,
    phase: PHASES.LOBBY,
    roundNumber: 0,
    players: [],
    pot: 0,
    currentBet: 0,
    currentPlayerId: null,
    dealerIndex: 0,
    smallBlind: settings.smallBlind || 10,
    bigBlind: settings.bigBlind || 20,
    question: null,
    hintsRevealed: 0,
    correctAnswer: null,
    showGuesses: false,
    timeLimit: settings.timeLimit || 20,
    timeRemaining: 20,
    roundOver: false,
    winnerIds: [],
    winningAmount: 0,
    hostId: hostId,
    maxPlayers: settings.maxPlayers || 8,
    started: false,
    timerInterval: null,
    guesses: {},
    bettingOrder: [],
    bettingIndex: 0,
    allGuessed: false,
  };
  const player = {
    id: hostId,
    name: hostName,
    chips: settings.startCapital || 1000,
    status: 'WAITING',
    bet: 0,
    isDealer: false,
    isSmallBlind: false,
    isBigBlind: false,
    isHost: true,
    guess: undefined,
    distance: undefined,
    isWinner: false,
  };
  room.players.push(player);
  rooms.set(roomId, room);
  return room;
}

// ─── Broadcast ────────────────────────────────────────────────
function broadcastRoom(room) {
  const state = {
    roomId: room.roomId,
    phase: room.phase,
    roundNumber: room.roundNumber,
    players: room.players.map(p => ({
      ...p,
      guess: (room.phase === PHASES.SHOWDOWN || room.phase === PHASES.RESULT) ? p.guess : undefined,
      distance: (room.phase === PHASES.SHOWDOWN || room.phase === PHASES.RESULT) ? p.distance : undefined,
    })),
    pot: room.pot,
    currentBet: room.currentBet,
    currentPlayerId: room.currentPlayerId,
    dealerIndex: room.dealerIndex,
    smallBlind: room.smallBlind,
    bigBlind: room.bigBlind,
    question: room.question,
    hintsRevealed: room.hintsRevealed,
    correctAnswer: room.correctAnswer,
    showGuesses: room.showGuesses,
    timeLimit: room.timeLimit,
    timeRemaining: room.timeRemaining,
    roundOver: room.roundOver,
    winnerIds: room.winnerIds,
    winningAmount: room.winningAmount,
    hostId: room.hostId,
    maxPlayers: room.maxPlayers,
    started: room.started,
  };
  io.to(room.roomId).emit('game:state', state);
}

// ─── Spiellogik (vereinfacht) ────────────────────────────────
function startGame(room) {
  if (room.phase !== PHASES.LOBBY || room.players.length < 2) return;
  room.started = true;
  room.roundNumber = 1;
  startNextRound(room);
}

function startNextRound(room) {
  room.players.forEach(p => {
    if (p.status !== 'OUT') {
      p.status = 'WAITING';
      p.bet = 0;
      p.isDealer = false;
      p.isSmallBlind = false;
      p.isBigBlind = false;
      p.guess = undefined;
      p.distance = undefined;
      p.isWinner = false;
    }
  });
  room.pot = 0;
  room.currentBet = 0;
  room.currentPlayerId = null;
  room.hintsRevealed = 0;
  room.correctAnswer = null;
  room.showGuesses = false;
  room.winnerIds = [];
  room.winningAmount = 0;
  room.guesses = {};
  room.allGuessed = false;
  room.bettingOrder = [];
  room.bettingIndex = 0;
  room.roundOver = false;

  rotateDealer(room);
  const q = getNextQuestion();
  room.question = q;
  room.correctAnswer = q.answer;

  const { sb, bb } = getBlindPositions(room);
  if (sb >= 0) {
    const p = room.players[sb];
    const amount = Math.min(room.smallBlind, p.chips);
    p.chips -= amount;
    p.bet = amount;
    p.isSmallBlind = true;
    room.pot += amount;
  }
  if (bb >= 0) {
    const p = room.players[bb];
    const amount = Math.min(room.bigBlind, p.chips);
    p.chips -= amount;
    p.bet = amount;
    p.isBigBlind = true;
    room.pot += amount;
  }
  room.currentBet = room.bigBlind;

  room.phase = PHASES.QUESTION;
  broadcastRoom(room);
  setTimeout(() => {
    if (room.phase === PHASES.QUESTION) {
      room.phase = PHASES.GUESSING;
      broadcastRoom(room);
      startGuessingTimer(room);
    }
  }, 3000);
}

function startGuessingTimer(room) {
  let remaining = room.timeLimit;
  room.timeRemaining = remaining;
  broadcastRoom(room);
  if (room.timerInterval) clearInterval(room.timerInterval);
  room.timerInterval = setInterval(() => {
    remaining--;
    room.timeRemaining = remaining;
    broadcastRoom(room);
    if (remaining <= 0) {
      clearInterval(room.timerInterval);
      room.timerInterval = null;
      const active = getActivePlayers(room);
      active.forEach(p => {
        if (!room.guesses[p.id]) p.status = 'FOLD';
      });
      if (getActivePlayers(room).length < 2) {
        endRoundEarly(room);
        return;
      }
      room.allGuessed = true;
      startBettingRound(room, PHASES.BETTING_1);
    }
  }, 1000);
}

function submitGuess(room, playerId, value) {
  if (room.phase !== PHASES.GUESSING) return false;
  if (room.guesses[playerId]) return false;
  const player = getPlayerById(room, playerId);
  if (!player) return false;
  room.guesses[playerId] = value;
  player.guess = value;
  player.status = 'GUESSED';
  const active = getActivePlayers(room);
  if (active.every(p => room.guesses[p.id])) {
    room.allGuessed = true;
    if (room.timerInterval) {
      clearInterval(room.timerInterval);
      room.timerInterval = null;
    }
    startBettingRound(room, PHASES.BETTING_1);
  }
  broadcastRoom(room);
  return true;
}

function startBettingRound(room, phase) {
  if (!BETTING_PHASES.includes(phase)) return;
  room.phase = phase;
  room.currentBet = (phase === PHASES.FINAL_BETTING) ? 0 : room.currentBet;
  const active = getActivePlayers(room);
  if (active.length < 2) { endRoundEarly(room); return; }
  const order = [];
  const startIdx = (room.dealerIndex + 1) % room.players.length;
  for (let i = 0; i < room.players.length; i++) {
    const idx = (startIdx + i) % room.players.length;
    const p = room.players[idx];
    if (p.status !== 'FOLD' && p.status !== 'OUT') order.push(p.id);
  }
  room.bettingOrder = order;
  room.bettingIndex = 0;
  room.currentPlayerId = order[0] || null;
  startBettingTimer(room);
  broadcastRoom(room);
}

function startBettingTimer(room) {
  let remaining = room.timeLimit;
  room.timeRemaining = remaining;
  broadcastRoom(room);
  if (room.timerInterval) clearInterval(room.timerInterval);
  room.timerInterval = setInterval(() => {
    remaining--;
    room.timeRemaining = remaining;
    broadcastRoom(room);
    if (remaining <= 0) {
      clearInterval(room.timerInterval);
      room.timerInterval = null;
      const p = room.currentPlayerId ? getPlayerById(room, room.currentPlayerId) : null;
      if (p && p.status !== 'FOLD' && p.status !== 'OUT') {
        if (room.currentBet === p.bet) handleAction(room, p.id, 'CHECK');
        else handleAction(room, p.id, 'FOLD');
      } else {
        advanceBetting(room);
      }
    }
  }, 1000);
}

function handleAction(room, playerId, action, amount) {
  const player = getPlayerById(room, playerId);
  if (!player || player.status === 'FOLD' || player.status === 'OUT') return false;
  if (room.currentPlayerId !== playerId) return false;
  if (room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }
  let valid = false;
  switch (action) {
    case 'CHECK':
      if (room.currentBet === player.bet) { player.status = 'CHECK'; valid = true; }
      break;
    case 'CALL': {
      const call = room.currentBet - player.bet;
      if (call > 0 && call <= player.chips) {
        player.chips -= call;
        player.bet += call;
        room.pot += call;
        player.status = 'CALL';
        valid = true;
      }
      break;
    }
    case 'RAISE': {
      const minRaise = Math.max(room.currentBet + room.bigBlind, room.currentBet + 10);
      const maxRaise = player.chips + player.bet;
      if (amount >= minRaise && amount <= maxRaise) {
        const diff = amount - player.bet;
        player.chips -= diff;
        player.bet = amount;
        room.pot += diff;
        room.currentBet = amount;
        player.status = 'RAISE';
        valid = true;
        // Nach Raise: alle anderen müssen reagieren
        const active = getActivePlayers(room).filter(p => p.id !== playerId);
        const order = [];
        const startIdx = (room.dealerIndex + 1) % room.players.length;
        for (let i = 0; i < room.players.length; i++) {
          const idx = (startIdx + i) % room.players.length;
          const p = room.players[idx];
          if (p.status !== 'FOLD' && p.status !== 'OUT' && p.id !== playerId) order.push(p.id);
        }
        room.bettingOrder = order;
        room.bettingIndex = 0;
        if (order.length === 0) { finishBettingRound(room); return true; }
        room.currentPlayerId = order[0];
        startBettingTimer(room);
        broadcastRoom(room);
        return true;
      }
      break;
    }
    case 'FOLD':
      player.status = 'FOLD';
      valid = true;
      break;
    case 'ALL_IN': {
      if (player.chips > 0) {
        const all = player.chips;
        player.bet += all;
        room.pot += all;
        player.chips = 0;
        player.status = 'ALL_IN';
        if (player.bet > room.currentBet) room.currentBet = player.bet;
        valid = true;
        const active = getActivePlayers(room).filter(p => p.id !== playerId);
        const order = [];
        const startIdx = (room.dealerIndex + 1) % room.players.length;
        for (let i = 0; i < room.players.length; i++) {
          const idx = (startIdx + i) % room.players.length;
          const p = room.players[idx];
          if (p.status !== 'FOLD' && p.status !== 'OUT' && p.id !== playerId) order.push(p.id);
        }
        room.bettingOrder = order;
        room.bettingIndex = 0;
        if (order.length === 0) { finishBettingRound(room); return true; }
        room.currentPlayerId = order[0];
        startBettingTimer(room);
        broadcastRoom(room);
        return true;
      }
      break;
    }
    default: return false;
  }
  if (valid) {
    broadcastRoom(room);
    advanceBetting(room);
    return true;
  }
  return false;
}

function advanceBetting(room) {
  let idx = room.bettingIndex + 1;
  while (idx < room.bettingOrder.length) {
    const pid = room.bettingOrder[idx];
    const p = getPlayerById(room, pid);
    if (p && p.status !== 'FOLD' && p.status !== 'OUT') {
      room.bettingIndex = idx;
      room.currentPlayerId = pid;
      startBettingTimer(room);
      broadcastRoom(room);
      return;
    }
    idx++;
  }
  finishBettingRound(room);
}

function finishBettingRound(room) {
  if (room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }
  const phase = room.phase;
  if (phase === PHASES.BETTING_1) {
    room.phase = PHASES.HINT_1;
    room.hintsRevealed = 1;
    broadcastRoom(room);
    setTimeout(() => {
      if (room.phase === PHASES.HINT_1) startBettingRound(room, PHASES.BETTING_2);
    }, 3000);
  } else if (phase === PHASES.BETTING_2) {
    room.phase = PHASES.HINT_2;
    room.hintsRevealed = 2;
    broadcastRoom(room);
    setTimeout(() => {
      if (room.phase === PHASES.HINT_2) startBettingRound(room, PHASES.BETTING_3);
    }, 3000);
  } else if (phase === PHASES.BETTING_3) {
    room.phase = PHASES.REVEAL;
    broadcastRoom(room);
    setTimeout(() => {
      if (room.phase === PHASES.REVEAL) startBettingRound(room, PHASES.FINAL_BETTING);
    }, 3000);
  } else if (phase === PHASES.FINAL_BETTING) {
    room.phase = PHASES.SHOWDOWN;
    room.showGuesses = true;
    const answer = room.correctAnswer;
    room.players.forEach(p => {
      if (p.guess !== undefined && p.status !== 'FOLD' && p.status !== 'OUT') {
        p.distance = Math.abs(p.guess - answer);
      }
    });
    const active = getActivePlayers(room).filter(p => p.guess !== undefined);
    if (active.length === 0) {
      room.winnerIds = [];
      room.winningAmount = 0;
    } else {
      let minDist = Infinity;
      active.forEach(p => { if (p.distance < minDist) minDist = p.distance; });
      const winners = active.filter(p => p.distance === minDist);
      room.winnerIds = winners.map(p => p.id);
      const share = Math.floor(room.pot / winners.length);
      winners.forEach(p => {
        p.chips += share;
        p.isWinner = true;
      });
      room.winningAmount = share;
    }
    room.phase = PHASES.RESULT;
    broadcastRoom(room);
  }
}

function endRoundEarly(room) {
  const active = getActivePlayers(room);
  if (active.length === 1) {
    const winner = active[0];
    winner.chips += room.pot;
    winner.isWinner = true;
    room.winnerIds = [winner.id];
    room.winningAmount = room.pot;
    room.phase = PHASES.RESULT;
    broadcastRoom(room);
  } else {
    startNextRound(room);
  }
}

// ─── Socket.IO Events ─────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);
  socket.emit('player:id', socket.id);

  socket.on('room:create', (data) => {
    const { name, settings } = data;
    if (!name || name.trim() === '') {
      socket.emit('game:error', 'Bitte Namen eingeben.');
      return;
    }
    const room = createRoom(socket.id, name.trim(), settings);
    socket.join(room.roomId);
    socket.data.roomId = room.roomId;
    socket.data.playerId = socket.id;
    broadcastRoom(room);
    console.log(`🏠 Raum ${room.roomId} erstellt von ${name}`);
  });

  socket.on('room:join', (data) => {
    const { roomId, name } = data;
    if (!roomId || !name || name.trim() === '') {
      socket.emit('game:error', 'Raum-Code und Name erforderlich.');
      return;
    }
    const room = rooms.get(roomId.toUpperCase());
    if (!room) { socket.emit('game:error', 'Raum nicht gefunden.'); return; }
    if (room.started) { socket.emit('game:error', 'Spiel läuft bereits.'); return; }
    if (room.players.length >= room.maxPlayers) { socket.emit('game:error', 'Raum ist voll.'); return; }
    if (room.players.some(p => p.name.toLowerCase() === name.trim().toLowerCase())) {
      socket.emit('game:error', 'Name bereits vergeben.');
      return;
    }
    const player = {
      id: socket.id,
      name: name.trim(),
      chips: 1000,
      status: 'WAITING',
      bet: 0,
      isDealer: false,
      isSmallBlind: false,
      isBigBlind: false,
      isHost: false,
      guess: undefined,
      distance: undefined,
      isWinner: false,
    };
    room.players.push(player);
    socket.join(room.roomId);
    socket.data.roomId = room.roomId;
    socket.data.playerId = socket.id;
    broadcastRoom(room);
    console.log(`👤 ${name} ist ${roomId} beigetreten`);
  });

  socket.on('guess:submit', (data) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const value = data.value;
    if (value === undefined || isNaN(value)) {
      socket.emit('game:error', 'Ungültige Zahl.');
      return;
    }
    if (!submitGuess(room, socket.data.playerId, value)) {
      socket.emit('game:error', 'Schätzung fehlgeschlagen.');
    }
  });

  socket.on('bet:act', (data) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const { action, amount } = data;
    if (!handleAction(room, socket.data.playerId, action, amount)) {
      socket.emit('game:error', 'Ungültige Aktion.');
    }
  });

  socket.on('game:start', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    if (room.hostId !== socket.id) { socket.emit('game:error', 'Nur der Host kann starten.'); return; }
    if (room.started) return;
    startGame(room);
  });

  socket.on('game:next', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.phase !== PHASES.RESULT) return;
    const active = room.players.filter(p => p.status !== 'OUT');
    if (active.length < 2) {
      room.phase = PHASES.LOBBY;
      room.started = false;
      broadcastRoom(room);
      return;
    }
    startNextRound(room);
  });

  socket.on('disconnect', () => {
    console.log(`❌ Client disconnected: ${socket.id}`);
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const player = getPlayerById(room, socket.id);
    if (player) {
      player.status = 'OUT';
      if (room.hostId === socket.id) {
        const newHost = room.players.find(p => p.status !== 'OUT' && p.id !== socket.id);
        if (newHost) {
          room.hostId = newHost.id;
          newHost.isHost = true;
        } else {
          rooms.delete(room.roomId);
          return;
        }
      }
      broadcastRoom(room);
      const active = getActivePlayers(room);
      if (active.length < 2 && room.started && room.phase !== PHASES.RESULT && room.phase !== PHASES.LOBBY) {
        endRoundEarly(room);
      }
    }
  });
});

// ─── Server starten ────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server läuft auf http://localhost:${PORT}`);
});