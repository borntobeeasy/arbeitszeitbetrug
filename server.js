const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

// ─── STATISCHE DATEIEN AUSLIEFERN ──────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── FALLBACK: ALLE ANDEREN ANFRAGEN AN INDEX.HTML ──────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── DEINE VOLLSTÄNDIGE SPIELLOGIK (alles ab hier) ──────
// ... der gesamte restliche Code, den du schon hast (ab "const rooms = new Map();") ...
// (Achte darauf, dass der letzte Teil mit server.listen(...) erhalten bleibt)