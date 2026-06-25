const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── Perguntas ──────────────────────────────────────────────────
const QF = path.join(__dirname, 'questions.json');
function loadQuestions() {
  if (!fs.existsSync(QF)) fs.writeFileSync(QF, JSON.stringify([], null, 2));
  return JSON.parse(fs.readFileSync(QF));
}

app.get('/api/questions',       (_, res) => res.json(loadQuestions()));
app.post('/api/questions/save', (req, res) => {
  fs.writeFileSync(QF, JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
});

// ── Estado do jogo ─────────────────────────────────────────────
let gameCode          = null;
let gameStarted       = false;
let players           = {};
let monitor           = null;
let questions         = [];
let qIndex            = 0;
let timer             = null;
let timeLeft          = 0;
let revealDone        = false;
let questionStartTime = 0; // ✅ momento em que a pergunta foi enviada

function generateCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

function sendMonitor(obj) {
  if (monitor && monitor.readyState === 1) monitor.send(JSON.stringify(obj));
}

function sendTo(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function playerList() {
  return Object.values(players).map(p => ({ name: p.name, score: p.score }));
}

function ranking() {
  return playerList().sort((a, b) => b.score - a.score);
}

function stopTimer() {
  if (timer) { clearInterval(timer); timer = null; }
}

function startTimer(limit) {
  stopTimer();
  timeLeft          = limit;
  revealDone        = false;
  questionStartTime = Date.now(); // ✅ registra quando a pergunta começou

  const tickAll = () => {
    sendMonitor({ type: 'tick', timeLeft });
    Object.values(players).forEach(p => sendTo(p.ws, { type: 'tick', timeLeft }));
  };

  tickAll(); // envia imediatamente o valor inicial

  timer = setInterval(() => {
    timeLeft--;
    tickAll();
    if (timeLeft <= 0) revealAnswer();
  }, 1000);
}

function revealAnswer() {
  if (revealDone) return;
  revealDone = true;
  stopTimer();

  const q      = questions[qIndex];
  const isLast = qIndex >= questions.length - 1;

  sendMonitor({
    type       : 'reveal',
    correct    : q.correct,
    correctText: q.options[q.correct],
    ranking    : ranking(),
    isLast
  });

  // ✅ envia pontos ganhos nesta rodada para cada jogador
  Object.values(players).forEach(p => {
    const hit          = p.lastAnswer === q.correct;
    const pointsGained = p.lastEarned || 0;

    sendTo(p.ws, {
      type   : 'reveal',
      correct: q.correct,
      hit,
      score  : p.score,
      points : pointsGained
    });
  });
}

// ── WebSocket ───────────────────────────────────────────────────
wss.on('connection', ws => {
  let playerId = null;

  const ping = setInterval(() => {
    if (ws.readyState === 1) ws.ping();
  }, 25000);

  ws.on('close', () => {
    clearInterval(ping);
    if (playerId && players[playerId]) {
      delete players[playerId];
      sendMonitor({ type: 'player_joined', players: playerList() });
    }
  });

  ws.on('message', raw => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // ── Monitor conecta ──
    if (data.type === 'monitor_connect') {
      monitor = ws;
      sendTo(ws, { type: 'state', players: playerList(), gameCode });
      return;
    }

    // ── Jogador valida código ──
    if (data.type === 'validate_code') {
      if (!gameCode || data.code?.toUpperCase() !== gameCode) {
        sendTo(ws, { type: 'code_invalid' });
      } else {
        sendTo(ws, { type: 'code_ok' });
      }
      return;
    }

    // ── Jogador entra ──
    if (data.type === 'join') {
      if (!gameCode || data.code?.toUpperCase() !== gameCode) {
        sendTo(ws, { type: 'error', msg: 'Código inválido ou partida não iniciada.' });
        return;
      }
      if (gameStarted) {
        sendTo(ws, { type: 'error', msg: 'A partida já começou!' });
        return;
      }
      const name = (data.name || '').trim().slice(0, 24);
      if (!name) { sendTo(ws, { type: 'error', msg: 'Nome inválido.' }); return; }
      const dup = Object.values(players).find(p => p.name.toLowerCase() === name.toLowerCase());
      if (dup) { sendTo(ws, { type: 'error', msg: 'Nome já em uso.' }); return; }

      playerId = crypto.randomUUID();
      players[playerId] = { ws, name, score: 0, answered: false, lastAnswer: null, lastEarned: 0 };
      sendTo(ws, { type: 'joined', name });
      sendMonitor({ type: 'player_joined', players: playerList() });
      return;
    }

    // ── Iniciar jogo ──
    if (data.type === 'start_game') {
      if (!Object.keys(players).length) {
        sendTo(ws, { type: 'error', msg: 'Nenhum jogador na sala!' }); return;
      }
      questions   = loadQuestions();
      qIndex      = 0;
      gameStarted = true;
      sendQuestion();
      return;
    }

    // ── Resposta do jogador ──
    if (data.type === 'answer') {
      const p = playerId && players[playerId];
      if (!p || p.answered || revealDone) return;

      p.answered   = true;
      p.lastAnswer = data.option;

      const q         = questions[qIndex];
      const timeLimit = q.timeLimit || 20;

      if (data.option === q.correct) {
        // ✅ Calcula tempo decorrido em segundos desde o início da pergunta
        const elapsed     = (Date.now() - questionStartTime) / 1000;
        const timeBonus   = Math.max(0, timeLimit - elapsed);         // segundos restantes reais
        const basePoints  = 500;
        const bonusPoints = Math.round((timeBonus / timeLimit) * 500); // até +500 de bônus
        const earned      = basePoints + bonusPoints;                  // entre 500 e 1000 pts
        p.score      += earned;
        p.lastEarned  = earned;
      } else {
        p.lastEarned = 0;
      }

      const answeredCount = Object.values(players).filter(x => x.answered).length;
      sendMonitor({ type: 'answer_update', answeredCount, totalPlayers: Object.keys(players).length });
      if (answeredCount === Object.keys(players).length) revealAnswer();
      return;
    }

    // ── Revelar forçado ──
    if (data.type === 'reveal_answer') { revealAnswer(); return; }

    // ── Próxima pergunta ──
    if (data.type === 'next_question') {
      qIndex++;
      if (qIndex >= questions.length) {
        sendMonitor({ type: 'final', ranking: ranking() });
        broadcast({ type: 'game_over', ranking: ranking() });
      } else {
        sendQuestion();
      }
      return;
    }

    // ── Reset ──
    if (data.type === 'reset_game') { resetAll(); return; }
  });
});

function sendQuestion() {
  const q         = questions[qIndex];
  const timeLimit = q.timeLimit || 20;

  Object.values(players).forEach(p => {
    p.answered   = false;
    p.lastAnswer = null;
    p.lastEarned = 0; // ✅ reseta pontos da rodada anterior
  });

  // ✅ limpa opções vazias antes de enviar (suporte a perguntas V/F)
  const cleanOptions = q.options.filter(o => o && o.trim());

  sendMonitor({
    type     : 'question',
    question : q.question,
    options  : q.options,     // monitor recebe todas (inclusive vazias para layout)
    correct  : q.correct,
    index    : qIndex,
    total    : questions.length,
    timeLimit
  });

  Object.values(players).forEach(p => {
    sendTo(p.ws, {
      type     : 'question',
      question : q.question,
      options  : cleanOptions, // jogador recebe só opções com texto
      index    : qIndex,
      total    : questions.length,
      timeLimit
    });
  });

  startTimer(timeLimit);
}

function resetAll() {
  stopTimer();
  Object.values(players).forEach(p => {
    sendTo(p.ws, { type: 'kicked', msg: 'A sala foi reiniciada.' });
    p.ws.close();
  });
  players           = {};
  gameStarted       = false;
  gameCode          = null;
  qIndex            = 0;
  revealDone        = false;
  timeLeft          = 0;
  questionStartTime = 0;
  questions         = [];
  sendMonitor({ type: 'reset' });
}

// ── Gerar código ──
app.post('/api/new-code', (_, res) => {
  stopTimer();
  gameCode          = generateCode();
  gameStarted       = false;
  players           = {};
  qIndex            = 0;
  revealDone        = false;
  timeLeft          = 0;
  questionStartTime = 0;
  questions         = [];
  sendMonitor({ type: 'new_code', gameCode });
  res.json({ gameCode });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Servidor rodando em http://localhost:${PORT}`));
