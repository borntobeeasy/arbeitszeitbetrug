// ─── server.js ───────────────────────────────────────────────
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*', // Für Entwicklung offen – im Produktivbetrieb einschränken
  },
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── In-Memory-Store ────────────────────────────────────────
const rooms = new Map(); // roomId -> Room

// ─── Hilfsfunktionen ────────────────────────────────────────
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

function getNextPlayerIndex(room, startIndex) {
  const players = room.players;
  for (let i = 1; i <= players.length; i++) {
    const idx = (startIndex + i) % players.length;
    const p = players[idx];
    if (p.status !== 'FOLD' && p.status !== 'OUT') {
      return idx;
    }
  }
  return -1;
}

function getActivePlayers(room) {
  return room.players.filter(p => p.status !== 'FOLD' && p.status !== 'OUT');
}

function getDealerIndex(room) {
  return room.dealerIndex;
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

function resetPlayerBets(room) {
  room.players.forEach(p => { p.bet = 0; });
}

function resetPlayerStatus(room) {
  room.players.forEach(p => {
    if (p.status !== 'OUT') {
      p.status = 'WAITING';
    }
    p.bet = 0;
    p.isDealer = false;
    p.isSmallBlind = false;
    p.isBigBlind = false;
    p.distance = undefined;
    p.isWinner = false;
  });
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
  {
    id: 'q4',
    question: 'Wie viele Tore schoss Gerd Müller in der Bundesliga?',
    answer: 365,
    unit: 'Tore',
    category: 'Fußball',
    difficulty: 'hard',
    hints: [
      { text: 'Die Zahl ist kleiner als 400.', type: 'upper' },
      { text: 'Die Zahl ist größer als 300.', type: 'lower' },
    ],
  },
  {
    id: 'q5',
    question: 'Wie viele Einwohner hat Berlin (in Millionen)?',
    answer: 3.7,
    unit: 'Millionen',
    category: 'Geografie',
    difficulty: 'medium',
    hints: [
      { text: 'Die Zahl ist kleiner als 4.0.', type: 'upper' },
      { text: 'Die Zahl ist größer als 3.0.', type: 'lower' },
    ],
  },
  // Füge hier weitere Fragen hinzu (mindestens 5 für den MVP)
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

const BETTING_PHASES = [PHASES.BETTING_1, PHASES.BETTING_2, PHASES.BETTING_3, PHASES.FINAL_BETTING];

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
    // Interne Timer
    timerInterval: null,
    // Schätzungen (geheim)
    guesses: {}, // playerId -> number
    // Spieler-Reihenfolge für Setzrunden
    bettingOrder: [],
    bettingIndex: 0,
    // Alle Spieler haben ihre Schätzung abgegeben?
    allGuessed: false,
    // letzte Aktion
    lastAction: null,
  };
  // Host als ersten Spieler hinzufügen
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
    isSelf: false, // wird clientseitig gesetzt
  };
  room.players.push(player);
  rooms.set(roomId, room);
  return room;
}

// ─── Spiel starten ────────────────────────────────────────────
function startGame(room) {
  if (room.phase !== PHASES.LOBBY) return;
  if (room.players.length < 2) return;
  room.started = true;
  room.roundNumber = 1;
  // Dealer setzen
  room.dealerIndex = 0;
  // Nächste Runde starten
  startNextRound(room);
}

function startNextRound(room) {
  // Spieler zurücksetzen (außer OUT)
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
  room.lastAction = null;
  room.roundOver = false;

  // Dealer rotieren
  rotateDealer(room);

  // Frage holen
  const q = getNextQuestion();
  room.question = q;
  room.correctAnswer = q.answer;

  // Blinds setzen
  const { sb, bb } = getBlindPositions(room);
  if (sb >= 0) {
    const sbPlayer = room.players[sb];
    const sbAmount = Math.min(room.smallBlind, sbPlayer.chips);
    sbPlayer.chips -= sbAmount;
    sbPlayer.bet = sbAmount;
    sbPlayer.isSmallBlind = true;
    room.pot += sbAmount;
  }
  if (bb >= 0) {
    const bbPlayer = room.players[bb];
    const bbAmount = Math.min(room.bigBlind, bbPlayer.chips);
    bbPlayer.chips -= bbAmount;
    bbPlayer.bet = bbAmount;
    bbPlayer.isBigBlind = true;
    room.pot += bbAmount;
  }

  // Setze aktuellen Einsatz auf Big Blind
  room.currentBet = room.bigBlind;

  // Phase auf QUESTION (Frage anzeigen)
  room.phase = PHASES.QUESTION;
  broadcastRoom(room);

  // Nach kurzer Pause zur Schätzungsphase
  setTimeout(() => {
    if (room.phase === PHASES.QUESTION) {
      room.phase = PHASES.GUESSING;
      broadcastRoom(room);
      // Timer für Schätzungen starten
      startGuessingTimer(room);
    }
  }, 3000);
}

// ─── Timer für Schätzungen ────────────────────────────────────
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
      // Alle, die noch nicht geschätzt haben, werden als FOLD behandelt (oder ausgeschlossen)
      const activePlayers = getActivePlayers(room);
      activePlayers.forEach(p => {
        if (!room.guesses[p.id]) {
          // Setze auf OUT? Oder FOLD? Für diese Runde als FOLD behandeln
          p.status = 'FOLD';
        }
      });
      // Prüfen, ob noch aktive Spieler übrig sind
      const remainingActive = getActivePlayers(room);
      if (remainingActive.length < 2) {
        // Nur ein Spieler übrig – er gewinnt sofort
        endRoundEarly(room);
        return;
      }
      // Alle haben geschätzt? Dann weiter mit Setzrunde
      room.allGuessed = true;
      startBettingRound(room, PHASES.BETTING_1);
    }
  }, 1000);
}

// ─── Schätzung abgeben ────────────────────────────────────────
function submitGuess(room, playerId, value) {
  if (room.phase !== PHASES.GUESSING) return false;
  if (room.guesses[playerId]) return false; // schon abgegeben
  const player = getPlayerById(room, playerId);
  if (!player) return false;
  // Wert speichern (geheim)
  room.guesses[playerId] = value;
  player.guess = value;
  player.status = 'GUESSED';

  // Prüfen, ob alle aktiven Spieler geschätzt haben
  const activePlayers = getActivePlayers(room);
  const allGuessed = activePlayers.every(p => room.guesses[p.id]);
  if (allGuessed) {
    room.allGuessed = true;
    if (room.timerInterval) {
      clearInterval(room.timerInterval);
      room.timerInterval = null;
    }
    // Weiter zur Setzrunde
    startBettingRound(room, PHASES.BETTING_1);
  }
  broadcastRoom(room);
  return true;
}

// ─── Setzrunde starten ────────────────────────────────────────
function startBettingRound(room, phase) {
  if (!BETTING_PHASES.includes(phase)) return;
  room.phase = phase;
  room.currentBet = phase === PHASES.FINAL_BETTING ? 0 : room.currentBet; // bei finaler Runde beginnt bei 0
  // Bestimme Reihenfolge: nach dem Dealer
  const active = getActivePlayers(room);
  if (active.length < 2) {
    endRoundEarly(room);
    return;
  }
  // Sortiere nach Sitzreihenfolge
  const order = [];
  const startIdx = (room.dealerIndex + 1) % room.players.length;
  for (let i = 0; i < room.players.length; i++) {
    const idx = (startIdx + i) % room.players.length;
    const p = room.players[idx];
    if (p.status !== 'FOLD' && p.status !== 'OUT') {
      order.push(p.id);
    }
  }
  room.bettingOrder = order;
  room.bettingIndex = 0;
  // Setze aktuellen Spieler
  room.currentPlayerId = order[0] || null;
  // Timer starten
  startBettingTimer(room);
  broadcastRoom(room);
}

// ─── Timer für Setzrunden ────────────────────────────────────
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
      // Automatische Aktion: Check wenn möglich, sonst Fold
      const currentPlayer = room.currentPlayerId ? getPlayerById(room, room.currentPlayerId) : null;
      if (currentPlayer && currentPlayer.status !== 'FOLD' && currentPlayer.status !== 'OUT') {
        // Prüfen, ob Check möglich (currentBet == player.bet)
        if (room.currentBet === currentPlayer.bet) {
          handleAction(room, currentPlayer.id, 'CHECK');
        } else {
          handleAction(room, currentPlayer.id, 'FOLD');
        }
      } else {
        // Kein aktueller Spieler? Dann weitermachen
        advanceBetting(room);
      }
    }
  }, 1000);
}

// ─── Spieleraktion in Setzrunde ──────────────────────────────
function handleAction(room, playerId, action, amount) {
  const player = getPlayerById(room, playerId);
  if (!player) return false;
  if (player.status === 'FOLD' || player.status === 'OUT') return false;
  if (room.currentPlayerId !== playerId) return false;

  // Timer stoppen
  if (room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }

  let valid = false;
  switch (action) {
    case 'CHECK':
      if (room.currentBet === player.bet) {
        valid = true;
        player.status = 'CHECK';
      }
      break;
    case 'CALL': {
      const callAmount = room.currentBet - player.bet;
      if (callAmount <= player.chips && callAmount > 0) {
        player.chips -= callAmount;
        player.bet += callAmount;
        room.pot += callAmount;
        player.status = 'CALL';
        valid = true;
      }
      break;
    }
    case 'RAISE': {
      const minRaise = Math.max(room.currentBet + room.bigBlind, room.currentBet + 10);
      const maxRaise = player.chips + player.bet;
      if (amount >= minRaise && amount <= maxRaise) {
        const raiseAmount = amount - player.bet;
        player.chips -= raiseAmount;
        player.bet = amount;
        room.pot += raiseAmount;
        room.currentBet = amount;
        player.status = 'RAISE';
        valid = true;
        // Nach Raise müssen alle anderen erneut reagieren
        // Wir setzen die Betting-Order zurück auf den nächsten Spieler nach dem Dealer
        // Einfach: alle aktiven Spieler außer dem Raisenden müssen nochmal
        const active = getActivePlayers(room);
        const order = [];
        const startIdx = (room.dealerIndex + 1) % room.players.length;
        for (let i = 0; i < room.players.length; i++) {
          const idx = (startIdx + i) % room.players.length;
          const p = room.players[idx];
          if (p.status !== 'FOLD' && p.status !== 'OUT' && p.id !== playerId) {
            order.push(p.id);
          }
        }
        // Den Raisenden an das Ende setzen? Nein, er hat bereits agiert. Andere müssen callen oder folden.
        // Also neue Order ohne den Raisenden, aber der Raisende ist raus aus der aktuellen Runde.
        room.bettingOrder = order;
        room.bettingIndex = 0;
        if (order.length === 0) {
          // Alle haben gecallt? Dann Runde beenden
          finishBettingRound(room);
          return true;
        }
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
      const allInAmount = player.chips;
      if (allInAmount > 0) {
        player.bet += allInAmount;
        room.pot += allInAmount;
        player.chips = 0;
        player.status = 'ALL_IN';
        // aktueller Bet anpassen, falls All-In größer ist
        if (player.bet > room.currentBet) {
          room.currentBet = player.bet;
        }
        valid = true;
        // Nach All-In müssen andere reagieren
        const active = getActivePlayers(room);
        const order = [];
        const startIdx = (room.dealerIndex + 1) % room.players.length;
        for (let i = 0; i < room.players.length; i++) {
          const idx = (startIdx + i) % room.players.length;
          const p = room.players[idx];
          if (p.status !== 'FOLD' && p.status !== 'OUT' && p.id !== playerId) {
            order.push(p.id);
          }
        }
        room.bettingOrder = order;
        room.bettingIndex = 0;
        if (order.length === 0) {
          finishBettingRound(room);
          return true;
        }
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
    // Wechsel zum nächsten Spieler oder beende Runde
    advanceBetting(room);
    return true;
  }
  return false;
}

function advanceBetting(room) {
  // Aktuellen Spielerindex erhöhen
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
  // Kein weiterer Spieler – Runde beenden
  finishBettingRound(room);
}

function finishBettingRound(room) {
  // Setzrunde beendet
  if (room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }
  // Aktuelle Phase prüfen und nächste Phase einleiten
  const phase = room.phase;
  if (phase === PHASES.BETTING_1) {
    room.phase = PHASES.HINT_1;
    room.hintsRevealed = 1;
    broadcastRoom(room);
    setTimeout(() => {
      if (room.phase === PHASES.HINT_1) {
        startBettingRound(room, PHASES.BETTING_2);
      }
    }, 3000);
  } else if (phase === PHASES.BETTING_2) {
    room.phase = PHASES.HINT_2;
    room.hintsRevealed = 2;
    broadcastRoom(room);
    setTimeout(() => {
      if (room.phase === PHASES.HINT_2) {
        startBettingRound(room, PHASES.BETTING_3);
      }
    }, 3000);
  } else if (phase === PHASES.BETTING_3) {
    // Reveal der Antwort
    room.phase = PHASES.REVEAL;
    broadcastRoom(room);
    setTimeout(() => {
      if (room.phase === PHASES.REVEAL) {
        // Finale Setzrunde
        startBettingRound(room, PHASES.FINAL_BETTING);
      }
    }, 3000);
  } else if (phase === PHASES.FINAL_BETTING) {
    // Showdown
    room.phase = PHASES.SHOWDOWN;
    room.showGuesses = true;
    // Abstände berechnen
    const answer = room.correctAnswer;
    room.players.forEach(p => {
      if (p.guess !== undefined && p.status !== 'FOLD' && p.status !== 'OUT') {
        p.distance = Math.abs(p.guess - answer);
      }
    });
    // Gewinner ermitteln
    const active = getActivePlayers(room).filter(p => p.guess !== undefined);
    if (active.length === 0) {
      // Keine aktiven Spieler – Pot zurückgeben? Einfach: keiner gewinnt
      room.winnerIds = [];
      room.winningAmount = 0;
    } else {
      let minDist = Infinity;
      active.forEach(p => {
        if (p.distance < minDist) minDist = p.distance;
      });
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
    // Nach Result -> nächste Runde (automatisch oder per Button)
    // Client sendet "game:next" wenn er bereit ist
  }
}

function endRoundEarly(room) {
  // Nur ein Spieler übrig – er gewinnt den Pot
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
    // Keine aktiven Spieler? Dann nächste Runde
    startNextRound(room);
  }
}

// ─── Broadcast an Raum ────────────────────────────────────────
function broadcastRoom(room) {
  // Sende Game-State an alle Clients im Raum
  const state = {
    roomId: room.roomId,
    phase: room.phase,
    roundNumber: room.roundNumber,
    players: room.players.map(p => ({
      ...p,
      // Schätzungen nur im Showdown senden
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

// ─── Socket.IO Events ──────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  // Spieler-ID senden
  socket.emit('player:id', socket.id);

  // Raum erstellen
  socket.on('room:create', (data) => {
    const { name, settings } = data;
    if (!name || name.trim() === '') {
      socket.emit('game:error', 'Bitte einen Namen eingeben.');
      return;
    }
    const room = createRoom(socket.id, name.trim(), settings);
    socket.join(room.roomId);
    socket.data.roomId = room.roomId;
    socket.data.playerId = socket.id;
    broadcastRoom(room);
    console.log(`🏠 Raum ${room.roomId} erstellt von ${name}`);
  });

  // Raum beitreten
  socket.on('room:join', (data) => {
    const { roomId, name } = data;
    if (!roomId || !name || name.trim() === '') {
      socket.emit('game:error', 'Raum-Code und Name erforderlich.');
      return;
    }
    const room = rooms.get(roomId.toUpperCase());
    if (!room) {
      socket.emit('game:error', 'Raum nicht gefunden.');
      return;
    }
    if (room.started) {
      socket.emit('game:error', 'Spiel läuft bereits.');
      return;
    }
    if (room.players.length >= room.maxPlayers) {
      socket.emit('game:error', 'Raum ist voll.');
      return;
    }
    // Prüfen, ob Name bereits existiert
    if (room.players.some(p => p.name.toLowerCase() === name.trim().toLowerCase())) {
      socket.emit('game:error', 'Dieser Name ist bereits vergeben.');
      return;
    }
    const player = {
      id: socket.id,
      name: name.trim(),
      chips: 1000, // Startkapital
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
    console.log(`👤 ${name} ist Raum ${roomId} beigetreten`);
  });

  // Schätzung abgeben
  socket.on('guess:submit', (data) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const playerId = socket.data.playerId;
    const value = data.value;
    if (value === undefined || isNaN(value)) {
      socket.emit('game:error', 'Ungültige Zahl.');
      return;
    }
    if (!submitGuess(room, playerId, value)) {
      socket.emit('game:error', 'Schätzung konnte nicht abgegeben werden.');
    }
  });

  // Setzaktion
  socket.on('bet:act', (data) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const playerId = socket.data.playerId;
    const { action, amount } = data;
    if (!handleAction(room, playerId, action, amount)) {
      socket.emit('game:error', 'Ungültige Aktion.');
    }
  });

  // Spiel starten (nur Host)
  socket.on('game:start', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    if (room.hostId !== socket.id) {
      socket.emit('game:error', 'Nur der Host kann starten.');
      return;
    }
    if (room.started) return;
    startGame(room);
  });

  // Nächste Runde (nach Result)
  socket.on('game:next', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    if (room.phase !== PHASES.RESULT) return;
    // Prüfen, ob noch genug Spieler
    const active = room.players.filter(p => p.status !== 'OUT');
    if (active.length < 2) {
      // Spiel beenden
      room.phase = PHASES.LOBBY;
      room.started = false;
      broadcastRoom(room);
      return;
    }
    startNextRound(room);
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log(`❌ Client disconnected: ${socket.id}`);
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const player = getPlayerById(room, socket.id);
    if (player) {
      // Spieler als OUT markieren, aber nicht entfernen (für Reconnect)
      player.status = 'OUT';
      // Wenn der Host geht, neuen Host bestimmen
      if (room.hostId === socket.id) {
        const newHost = room.players.find(p => p.status !== 'OUT' && p.id !== socket.id);
        if (newHost) {
          room.hostId = newHost.id;
          newHost.isHost = true;
        } else {
          // Raum leeren
          rooms.delete(room.roomId);
          return;
        }
      }
      broadcastRoom(room);
      // Prüfen, ob Spiel fortgesetzt werden kann
      const active = getActivePlayers(room);
      if (active.length < 2 && room.started && room.phase !== PHASES.RESULT && room.phase !== PHASES.LOBBY) {
        // Spiel beenden oder pausieren
        endRoundEarly(room);
      }
    }
  });

  // Reconnect – Client verbindet sich neu, wir senden den aktuellen State
  socket.on('reconnect', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    // Spieler wiederherstellen (falls vorhanden)
    const player = getPlayerById(room, socket.id);
    if (player && player.status === 'OUT') {
      // Reaktiviere, wenn möglich
      if (room.phase === PHASES.LOBBY || room.phase === PHASES.RESULT) {
        player.status = 'WAITING';
      }
    }
    broadcastRoom(room);
  });
});

// ─── Server starten ────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server läuft auf http://localhost:${PORT}`);
});