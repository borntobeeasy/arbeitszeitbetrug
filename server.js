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

// ─── Raum erstellen ──────────────────────────────────────────────────────────
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
    // Standard-Einstellungen (werden beim Start überschrieben)
    startCapital: settings.startCapital || 1000,
    smallBlind: settings.smallBlind || 10,
    bigBlind: settings.bigBlind || 20,
    maxRounds: settings.maxRounds || 0,
    blindIncreaseInterval: settings.blindIncreaseInterval || 5,
    category: settings.category || 'Alle',
    timeLimit: settings.timeLimit || 20,
    maxPlayers: settings.maxPlayers || 8,

    question: null,
    hintsRevealed: 0,
    correctAnswer: null,
    showGuesses: false,
    timeRemaining: 20,
    roundOver: false,
    winnerIds: [],
    winningAmount: 0,
    hostId: hostId,
    started: false,
    timerInterval: null,
    guesses: {},
    bettingOrder: [],
    bettingIndex: 0,
    allGuessed: false,
    roundEnded: false,
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

function startGame(room, settings) {
  if (room.phase !== PHASES.LOBBY || room.players.length < 2) return;
  
  // ─── Einstellungen vom Client übernehmen ─────────────────────────────
  if (settings) {
    room.startCapital = settings.startCapital || room.startCapital;
    room.smallBlind = settings.smallBlind || room.smallBlind;
    room.bigBlind = settings.bigBlind || room.bigBlind;
    room.maxRounds = settings.maxRounds !== undefined ? settings.maxRounds : room.maxRounds;
    room.blindIncreaseInterval = settings.blindIncreaseInterval || room.blindIncreaseInterval;
    room.category = settings.category || room.category;
    room.timeLimit = settings.timeLimit || room.timeLimit;
    room.maxPlayers = settings.maxPlayers || room.maxPlayers;
    
    // Spieler-Chips aktualisieren (falls Startkapital geändert)
    room.players.forEach(p => {
      if (p.chips !== room.startCapital) {
        p.chips = room.startCapital;
      }
    });
  }
  
  room.started = true;
  room.roundNumber = 1;
  room.roundsSinceBlindIncrease = 0;
  startNextRound(room);
}

function startNextRound(room) {
  // Prüfe, ob maximale Rundenzahl erreicht ist
  if (room.maxRounds > 0 && room.roundNumber > room.maxRounds) {
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

// ─── (Rest der Spiellogik bleibt unverändert – siehe vorherige Version) ──
// ─── Die Funktionen startGuessingTimer, submitGuess, startBettingRound, ──
// ─── handleAction, advanceBetting, finishBettingRound, showDown, ──────
// ─── endRoundEarly sind identisch zur vorherigen Version. ────────────
// ─── Ich kürze hier aus Platzgründen, aber du kannst sie aus der ──────
// ─── vorherigen Antwort kopieren. ─────────────────────────────────────

// ─── Socket.IO Events ────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);
  socket.emit('player:id', socket.id);
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

  // ─── SPIEL STARTEN MIT EINSTELLUNGEN ───────────────────────────────────
  socket.on('game:start', (data) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    if (room.hostId !== socket.id) {
      socket.emit('game:error', 'Nur der Host kann starten.');
      return;
    }
    if (room.started) return;
    // Einstellungen aus dem Client übernehmen
    const settings = data || {};
    startGame(room, settings);
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