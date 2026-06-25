const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Carrega perguntas do questions.json (ou usa o padrão embutido) ──
const QUESTIONS_PATH = path.join(__dirname, 'questions.json');

function loadQuestions() {
  try {
    if (fs.existsSync(QUESTIONS_PATH)) {
      return JSON.parse(fs.readFileSync(QUESTIONS_PATH, 'utf8'));
    }
  } catch (e) { console.error('Erro ao carregar questions.json:', e); }
  return DEFAULT_QUESTIONS;
}

function saveQuestions(list) {
  fs.writeFileSync(QUESTIONS_PATH, JSON.stringify(list, null, 2), 'utf8');
}

// ── API REST para editar perguntas ──
app.get('/api/questions', (_, res) => res.json(loadQuestions()));

app.post('/api/questions', (req, res) => {
  const list = req.body;
  if (!Array.isArray(list)) return res.status(400).json({ error: 'Formato inválido' });
  saveQuestions(list);
  res.json({ ok: true });
});

// ── Estado do jogo ──
let state = {
  screen: 'lobby',
  currentQ: 0,
  timeLeft: 20,
  players: {}
};

let timerInterval = null;
let monitor = null;

function broadcast(data, exclude = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => {
    if (c !== exclude && c.readyState === 1) c.send(msg);
  });
}

function sendTo(ws, data) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
}

function startTimer(duration, onTick, onEnd) {
  clearInterval(timerInterval);
  state.timeLeft = duration;
  onTick(state.timeLeft);
  timerInterval = setInterval(() => {
    state.timeLeft--;
    onTick(state.timeLeft);
    if (state.timeLeft <= 0) { clearInterval(timerInterval); onEnd(); }
  }, 1000);
}

function getPlayerList() {
  return Object.entries(state.players).map(([name, d]) => ({ name, score: d.score, streak: d.streak }));
}

function getRanking() {
  return getPlayerList().sort((a, b) => b.score - a.score);
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    if (data.type === 'monitor_connect') {
      monitor = ws;
      ws.role = 'monitor';
      sendTo(ws, { type: 'state', players: getPlayerList() });
    }

    if (data.type === 'join') {
      const name = data.name?.trim().slice(0, 20);
      if (!name) return;
      ws.role = 'player';
      ws.playerName = name;
      if (!state.players[name]) {
        state.players[name] = { score: 0, streak: 0, ws };
      } else {
        state.players[name].ws = ws;
      }
      sendTo(ws, { type: 'joined', name, screen: state.screen });
      sendTo(monitor, { type: 'player_joined', players: getPlayerList() });
    }

    if (data.type === 'start_game' && ws.role === 'monitor') {
      Object.values(state.players).forEach(p => { p.score = 0; p.streak = 0; });
      state.currentQ = 0;
      sendQuestion();
    }

    if (data.type === 'next_question' && ws.role === 'monitor') {
      state.currentQ++;
      const QUESTIONS = loadQuestions();
      if (state.currentQ >= QUESTIONS.length) endGame();
      else sendQuestion();
    }

    if (data.type === 'answer' && ws.role === 'player') {
      const player = state.players[ws.playerName];
      if (!player || player.answered) return;
      player.answered = true;
      const QUESTIONS = loadQuestions();
      const q = QUESTIONS[state.currentQ];
      const isCorrect = data.answer === q.correct;
      const timeBonus = Math.round(800 * (state.timeLeft / 20));
      let pts = 0;
      if (isCorrect) {
        player.streak = (player.streak || 0) + 1;
        const streakBonus = player.streak >= 3 ? 150 : 0;
        pts = 200 + timeBonus + streakBonus;
        player.score += pts;
      } else {
        player.streak = 0;
      }
      sendTo(ws, { type: 'answer_result', correct: isCorrect, points: pts, score: player.score });
      const answeredCount = Object.values(state.players).filter(p => p.answered).length;
      sendTo(monitor, { type: 'answer_update', answeredCount, totalPlayers: Object.keys(state.players).length });
    }

    if (data.type === 'reveal_answer' && ws.role === 'monitor') {
      clearInterval(timerInterval);
      revealAnswer();
    }

    if (data.type === 'reset_game' && ws.role === 'monitor') {
      clearInterval(timerInterval);
      state = { screen: 'lobby', currentQ: 0, timeLeft: 20, players: state.players };
      Object.values(state.players).forEach(p => { p.score = 0; p.streak = 0; p.answered = false; });
      broadcast({ type: 'reset' });
    }
  });

  ws.on('close', () => {
    if (ws.role === 'monitor') { monitor = null; console.log('Monitor desconectado'); }
    if (ws.role === 'player')  console.log(`Jogador desconectado: ${ws.playerName}`);
  });
});

function sendQuestion() {
  state.screen = 'question';
  const QUESTIONS = loadQuestions();
  const q = QUESTIONS[state.currentQ];
  Object.values(state.players).forEach(p => { p.answered = false; });

  sendTo(monitor, {
    type: 'question',
    index: state.currentQ,
    total: QUESTIONS.length,
    question: q.q,
    options: q.options,
    correct: q.correct,
    timeLimit: 20
  });

  Object.values(state.players).forEach(p => {
    sendTo(p.ws, {
      type: 'question',
      index: state.currentQ,
      total: QUESTIONS.length,
      options: q.options,
      timeLimit: 20
    });
  });

  startTimer(20,
    (t) => sendTo(monitor, { type: 'tick', timeLeft: t }),
    () => revealAnswer()
  );
}

function revealAnswer() {
  state.screen = 'reveal';
  const QUESTIONS = loadQuestions();
  const q = QUESTIONS[state.currentQ];
  const isLast = state.currentQ >= QUESTIONS.length - 1;
  broadcast({ type: 'reveal', correct: q.correct, correctText: q.options[q.correct], ranking: getRanking(), isLast });
}

function endGame() {
  state.screen = 'final';
  clearInterval(timerInterval);
  broadcast({ type: 'final', ranking: getRanking() });
}

// ── Perguntas padrão (usadas se questions.json não existir) ──
const DEFAULT_QUESTIONS = [
  { q: "Qual o principal objetivo do Sistema Manufatura Enxuta?", options: ["Reduzir a demanda dos clientes","Reduzir os desperdícios para redução de custos e aumentar a qualidade","Realizar Manutenção preventiva e Trabalho padronizado","Aumentar o número de funcionários"], correct: 1 },
  { q: "São atividades que agregam valor:", options: ["Movimentação e trabalho","Transformação do produto para atender o cliente","Retrabalho e qualidade","Transporte e estoque"], correct: 1 },
  { q: "O Diagrama de Espaguete é uma ferramenta utilizada para analisar...", options: ["Tempo total de produção","Qualidade total do equipamento","Eficácia total do equipamento","Movimentação"], correct: 3 },
  { q: "O retrabalho no processo produtivo não é desperdício, pois não descartamos o produto.", options: ["Verdadeiro","Falso"], correct: 1 },
  { q: "Espera, estoque e transporte são desperdícios que podemos identificar e eliminar com Ferramentas da Manufatura Enxuta.", options: ["Verdadeiro","Falso"], correct: 0 },
  { q: "Diagrama de Espaguete evidencia o movimento dos operadores no chão de fábrica.", options: ["Verdadeiro","Falso"], correct: 0 },
  { q: "Os fluxos do Mapeamento de Fluxo de Valor (MFV) são: materiais e informações.", options: ["Verdadeiro","Falso"], correct: 0 },
  { q: "São algumas das bases do sistema de Produção sem desperdícios:", options: ["Padronização dos processos e melhoria contínua","Variabilidade e excesso de produção","Aumento das vendas e entrega","Redução do atraso na entrega"], correct: 0 },
  { q: "O Lean visa: Maior qualidade, menor custo e menor tempo de produção.", options: ["Verdadeiro","Falso"], correct: 0 },
  { q: "Os indicadores de produção devem ser preenchidos e divulgados no chão de fábrica — Gerenciamento diário.", options: ["Verdadeiro","Falso"], correct: 0 },
  { q: "São alguns dos benefícios da padronização:", options: ["Reduz o tempo de produção e aumenta o nível de qualidade","Torna as operações consistentes e permite a aplicação da melhoria contínua","Aprimora o processo e reduz o estresse do operário","Todas as alternativas anteriores"], correct: 3 },
  { q: "O que sustenta as melhorias implementadas por mais tempo e com melhor performance?", options: ["Mudança de comportamentos e mentalidades","Mudança do sistema operacional","Mudança no Layout","Nenhuma das alternativas anteriores"], correct: 0 },
  { q: "A metodologia do 5S é utilizada com qual(is) finalidade(s)?", options: ["Apenas organização visual","Apenas redução de custos","Organização, limpeza, padronização e disciplina no ambiente de trabalho","Somente treinamento de operadores"], correct: 2 },
  { q: "O POP (Procedimento Operacional Padrão) é importante, pois...", options: ["Aumenta produtos defeituosos","Garante que atividades sejam realizadas sempre da mesma forma correta","Substitui o treinamento dos operadores","Reduz o número de funcionários"], correct: 1 },
  { q: "Qual(is) o(s) objetivo(s) de organizar o local de trabalho usando a metodologia 5S?", options: ["Melhorar a segurança e produtividade","Aumentar o estoque","Reduzir o número de turnos","Substituir equipamentos antigos"], correct: 0 },
  { q: "Eliminação de estoque, redução de custo e tempo são benefícios do sistema Just in Time.", options: ["Verdadeiro","Falso"], correct: 0 },
  { q: "Como deve ser o processo de resolução de problemas?", options: ["Rápido e sem análise de causa raiz","Estruturado, identificando a causa raiz antes de agir","Baseado apenas na experiência do operador","Delegado apenas à gerência"], correct: 1 },
  { q: "Qual é o objetivo do sistema puxado?", options: ["Produzir o máximo possível","Produzir somente o que o cliente demanda, na hora certa","Aumentar o estoque de segurança","Reduzir o número de fornecedores"], correct: 1 },
  { q: "Por que é importante reduzir o tempo de troca de ferramenta?", options: ["Para aumentar o estoque","Para permitir lotes menores e maior flexibilidade de produção","Para reduzir o número de operadores","Para aumentar o tempo de ciclo"], correct: 1 },
  { q: "São benefícios de um bom diálogo de desempenho:", options: ["Aumento de conflitos na equipe","Alinhamento de metas, engajamento e melhoria contínua","Redução da comunicação entre turnos","Nenhuma das alternativas"], correct: 1 },
  { q: "São benefícios da Manutenção Planejada:", options: ["Aumento de quebras e paradas","Redução da vida útil dos equipamentos","Maior disponibilidade dos equipamentos e redução de custos com manutenção corretiva","Aumento do número de manutenções emergenciais"], correct: 2 },
  { q: "Qual é a importância da Manutenção Autônoma?", options: ["Substituir totalmente a equipe de manutenção","Envolver os operadores nos cuidados básicos do equipamento, prevenindo falhas","Aumentar o tempo de parada dos equipamentos","Reduzir o treinamento dos técnicos"], correct: 1 },
  { q: "São atividades da Manutenção Autônoma: limpar os equipamentos e sinalizar as alterações apresentadas no equipamento.", options: ["Verdadeiro","Falso"], correct: 0 },
  { q: "O PDCA possui quatro etapas: Planejar, Desenvolver, Checar e Agir.", options: ["Verdadeiro","Falso"], correct: 1 },
  { q: "Quais os benefícios da redução do tempo de troca de ferramenta?", options: ["Aumento do estoque intermediário","Maior flexibilidade, lotes menores e redução de desperdícios","Redução da qualidade do produto","Aumento do tempo de ciclo"], correct: 1 }
];

// Gera o questions.json na primeira execução se não existir
if (!fs.existsSync(QUESTIONS_PATH)) saveQuestions(DEFAULT_QUESTIONS);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let localIP = 'localhost';
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) { localIP = net.address; break; }
    }
  }
  console.log(`\n🎯 Quiz B+P rodando!`);
  console.log(`📺 Monitor:  http://${localIP}:${PORT}/monitor.html`);
  console.log(`📱 Jogador:  http://${localIP}:${PORT}/jogador.html`);
  console.log(`✏️  Editor:   http://${localIP}:${PORT}/editor.html\n`);
});
