// ─── server.js ──────────────────────────────────────────────────────────────
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

// ─── Statische Dateien & Fallback ──────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Fragen aus JSON laden ─────────────────────────────────────────────────
let allQuestions = [];
try {
  const data = fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8');
  allQuestions = JSON.parse(data);
  console.log(`📚 ${allQuestions.length} Fragen geladen.`);
} catch (err) {
  console.warn('⚠️  Keine questions.json gefunden – verwende Standard-Fragen.');
  // Fallback-Fragen (damit das Spiel immer läuft)
  allQuestions = [
    {
      id: 'fallback1',
      question: 'Wie viele Beine hat ein Hund?',
      answer: 4,
      unit: 'Beine',
      category: 'Alltag',
      difficulty: 'easy',
      hints: [
        { text: 'Die Zahl ist kleiner als 10.', type: 'upper' },
        { text: 'Die Zahl ist größer als 2.', type: 'lower' },
      ],
    },
    {
      id: 'fallback2',
      question: 'Wie viele Stunden hat ein Tag?',
      answer: 24,
      unit: 'Stunden',
      category: 'Alltag',
      difficulty: 'easy',
      hints: [
        { text: 'Die Zahl ist kleiner als 30.', type: 'upper' },
        { text: 'Die Zahl ist größer als 20.', type: 'lower' },
      ],
    },
  ];
}

// ─── Kategorien extrahieren ─────────────────────────────────────────────────
const categories = [...new Set(allQuestions.map(q => q.category))];
console.log('📂 Kategorien:', categories.join(', '));

// ─── In-Memory-Store ────────────────────────────────────────────────────────
const rooms = new Map();

// ─── Hilfsfunktionen ────────────────────────────────────────────────────────
function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 5; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
  return id;
}

function getPlayerById(room, playerId) {
  return room.players.find(p => p.id === playerId);
}

function getActivePlayers(room) {
  return room.players.filter(p => p.status !== 'FOLD' && p.status !== 'OUT');
}

function getAlivePlayers(room) {
  return room.players.filter(p => p.status !== 'OUT');
}

function rotateDealer(room) {
  room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
}

function getBlindPositions(room) {
  const dealer = room.dealerIndex;
  const players = room.players;
  const alive = players.filter(p => p.status !== 'OUT');
  if (alive.length < 2) return { sb: -1, bb: -1 };
  const sbIdx = (dealer + 1) % players.length;
  const bbIdx = (dealer + 2) % players.length;
  return { sb: sbIdx, bb: bbIdx };
}

function resetPlayerState(room) {
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
}

// ─── Spielphasen ──────────────────────────────────────────────────────────────
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

// ─── Raum erstellen (mit Einstellungen) ────────────────────────────────────
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
    // Einstellungen
    startCapital: settings.startCapital || 1000,
    smallBlind: settings.smallBlind || 10,
    bigBlind: settings.bigBlind || 20,
    maxRounds: settings.maxRounds || 0,           // 0 = unbegrenzt
    blindIncreaseInterval: settings.blindIncreaseInterval || 5, // alle X Runden
    category: settings.category || 'Alle',
    timeLimit: settings.timeLimit || 20,

    question: null,
    hintsRevealed: 0,
    correctAnswer: null,
    showGuesses: false,
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
    roundEnded: false,
    // Zähler für Blind-Erhöhungen
    roundsSinceBlindIncrease: 0,
  };
  const player = {
    id: hostId,
    name: hostName,
    chips: room.startCapital,
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

// ─── Broadcast ──────────────────────────────────────────────────────────────
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
    maxRounds: room.maxRounds,
    startCapital: room.startCapital,
    category: room.category,
  };
  io.to(room.roomId).emit('game:state', state);
}

// ─── Fragen nach Kategorie filtern ──────────────────────────────────────────
function getQuestionsForCategory(category) {
  if (category === 'Alle') return allQuestions;
  return allQuestions.filter(q => q.category === category);
}

// ─── SPIELLOGIK ──────────────────────────────────────────────────────────────

function startGame(room) {
  if (room.phase !== PHASES.LOBBY || room.players.length < 2) return;
  room.started = true;
  room.roundNumber = 1;
  room.roundsSinceBlindIncrease = 0;
  startNextRound(room);
}

function startNextRound(room) {
  // Prüfe, ob maximale Rundenzahl erreicht ist
  if (room.maxRounds > 0 && room.roundNumber > room.maxRounds) {
    // Spiel beenden – alle Spieler in Lobby versetzen
    room.phase = PHASES.LOBBY;
    room.started = false;
    broadcastRoom(room);
    return;
  }

  resetPlayerState(room);
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
  room.roundEnded = false;

  // Blind-Erhöhung prüfen
  room.roundsSinceBlindIncrease++;
  if (room.roundsSinceBlindIncrease >= room.blindIncreaseInterval) {
    room.smallBlind = Math.floor(room.smallBlind * 2);
    room.bigBlind = Math.floor(room.bigBlind * 2);
    room.roundsSinceBlindIncrease = 0;
    console.log(`📈 Blinds erhöht auf SB=${room.smallBlind}, BB=${room.bigBlind}`);
  }

  rotateDealer(room);

  // Frage aus der gewählten Kategorie holen
  const pool = getQuestionsForCategory(room.category);
  if (pool.length === 0) {
    // Fallback: Alle Fragen
    const fallback = allQuestions;
    const q = fallback[room.roundNumber % fallback.length];
    room.question = q;
    room.correctAnswer = q.answer;
  } else {
    const q = pool[room.roundNumber % pool.length];
    room.question = q;
    room.correctAnswer = q.answer;
  }

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
  if (room.roundEnded) return;
  if (!BETTING_PHASES.includes(phase)) return;
  room.phase = phase;
  room.currentBet = (phase === PHASES.FINAL_BETTING) ? 0 : room.currentBet;
  const active = getActivePlayers(room);
  if (active.length < 2) {
    endRoundEarly(room);
    return;
  }
  const order = buildBettingOrder(room);
  if (order.length < 2) {
    endRoundEarly(room);
    return;
  }
  room.bettingOrder = order;
  room.bettingIndex = 0;
  room.currentPlayerId = order[0] || null;
  startBettingTimer(room);
  broadcastRoom(room);
}

function buildBettingOrder(room) {
  const order = [];
  const startIdx = (room.dealerIndex + 1) % room.players.length;
  for (let i = 0; i < room.players.length; i++) {
    const idx = (startIdx + i) % room.players.length;
    const p = room.players[idx];
    if (p.status !== 'FOLD' && p.status !== 'OUT') order.push(p.id);
  }
  return order;
}

function startBettingTimer(room) {
  if (room.roundEnded) return;
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
  if (room.roundEnded) return false;
  const player = getPlayerById(room, playerId);
  if (!player) return false;
  if (player.status === 'FOLD' || player.status === 'OUT') return false;
  if (room.currentPlayerId !== playerId) return false;

  if (room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }

  let valid = false;
  switch (action) {
    case 'CHECK':
      if (room.currentBet === player.bet) {
        player.status = 'CHECK';
        valid = true;
      }
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
        const order = buildBettingOrder(room).filter(id => id !== playerId);
        if (order.length === 0) {
          finishBettingRound(room);
          broadcastRoom(room);
          return true;
        }
        room.bettingOrder = order;
        room.bettingIndex = 0;
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
        const order = buildBettingOrder(room).filter(id => id !== playerId);
        if (order.length === 0) {
          finishBettingRound(room);
          broadcastRoom(room);
          return true;
        }
        room.bettingOrder = order;
        room.bettingIndex = 0;
        room.currentPlayerId = order[0];
        startBettingTimer(room);
        broadcastRoom(room);
        return true;
      }
      break;
    }
    default:
      return false;
  }

  if (valid) {
    broadcastRoom(room);
    advanceBetting(room);
    return true;
  }
  return false;
}

function advanceBetting(room) {
  if (room.roundEnded) return;
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
  if (room.roundEnded) return;
  if (room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }

  const phase = room.phase;
  const active = getActivePlayers(room);
  if (active.length < 2) {
    endRoundEarly(room);
    return;
  }

  const allSameBet = active.every(p => p.bet === room.currentBet);
  if (!allSameBet) {
    const order = buildBettingOrder(room);
    if (order.length > 1) {
      room.bettingOrder = order;
      room.bettingIndex = 0;
      room.currentPlayerId = order[0];
      startBettingTimer(room);
      broadcastRoom(room);
      return;
    }
  }

  if (phase === PHASES.BETTING_1) {
    room.phase = PHASES.HINT_1;
    room.hintsRevealed = 1;
    broadcastRoom(room);
    setTimeout(() => {
      if (room.phase === PHASES.HINT_1 && !room.roundEnded) {
        startBettingRound(room, PHASES.BETTING_2);
      }
    }, 3000);
  } else if (phase === PHASES.BETTING_2) {
    room.phase = PHASES.HINT_2;
    room.hintsRevealed = 2;
    broadcastRoom(room);
    setTimeout(() => {
      if (room.phase === PHASES.HINT_2 && !room.roundEnded) {
        startBettingRound(room, PHASES.BETTING_3);
      }
    }, 3000);
  } else if (phase === PHASES.BETTING_3) {
    room.phase = PHASES.REVEAL;
    broadcastRoom(room);
    setTimeout(() => {
      if (room.phase === PHASES.REVEAL && !room.roundEnded) {
        startBettingRound(room, PHASES.FINAL_BETTING);
      }
    }, 3000);
  } else if (phase === PHASES.FINAL_BETTING) {
    room.phase = PHASES.SHOWDOWN;
    room.showGuesses = true;
    showDown(room);
  }
}

function showDown(room) {
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
  room.roundEnded = true;
  broadcastRoom(room);
}

function endRoundEarly(room) {
  if (room.roundEnded) return;
  const active = getActivePlayers(room);
  if (active.length === 1) {
    const winner = active[0];
    winner.chips += room.pot;
    winner.isWinner = true;
    room.winnerIds = [winner.id];
    room.winningAmount = room.pot;
    room.phase = PHASES.RESULT;
    room.roundEnded = true;
    broadcastRoom(room);
  } else {
    room.roundEnded = true;
    setTimeout(() => {
      startNextRound(room);
    }, 2000);
  }
}

// ─── Socket.IO Events ────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);
  socket.emit('player:id', socket.id);

  // Sende Kategorien an den Client
  socket.emit('categories', categories);

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
      chips: room.startCapital,
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
    room.roundNumber++;
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

// ─── Server starten ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server läuft auf http://localhost:${PORT}`);
});