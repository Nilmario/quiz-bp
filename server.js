const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ─── BANCO DE PERGUNTAS ───────────────────────────────────────────────────────
const QUESTIONS = [
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

// ─── ESTADO DO JOGO ────────────────────────────────────────────────────────────
let state = {
  screen: 'lobby',
  currentQ: 0,
  timeLeft: 20,
  players: {}
};

let timerInterval = null;
let monitor = null;

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function send(ws, data) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
}

function broadcast(data, exclude = null) {
  wss.clients.forEach(c => {
    if (c !== exclude && c.readyState === 1) c.send(JSON.stringify(data));
  });
}

function getPlayerList() {
  return Object.entries(state.players)
    .map(([name, d]) => ({ name, score: d.score, streak: d.streak }));
}

function getRanking() {
  return getPlayerList().sort((a, b) => b.score - a.score);
}

function startTimer(seconds, onEnd) {
  clearInterval(timerInterval);
  state.timeLeft = seconds;
  send(monitor, { type: 'tick', timeLeft: state.timeLeft });

  timerInterval = setInterval(() => {
    state.timeLeft--;
    send(monitor, { type: 'tick', timeLeft: state.timeLeft });
    if (state.timeLeft <= 0) {
      clearInterval(timerInterval);
      onEnd();
    }
  }, 1000);
}

// ─── LÓGICA DO JOGO ────────────────────────────────────────────────────────────
function sendQuestion() {
  state.screen = 'question';
  const q = QUESTIONS[state.currentQ];
  Object.values(state.players).forEach(p => { p.answered = false; });

  // Monitor recebe gabarito
  send(monitor, {
    type: 'question',
    index: state.currentQ,
    total: QUESTIONS.length,
    question: q.q,
    options: q.options,
    correct: q.correct,
    timeLimit: 20
  });

  // Jogadores NÃO recebem gabarito
  Object.values(state.players).forEach(p => {
    send(p.ws, {
      type: 'question',
      index: state.currentQ,
      total: QUESTIONS.length,
      options: q.options,
      timeLimit: 20
    });
  });

  startTimer(20, () => revealAnswer());
}

function revealAnswer() {
  state.screen = 'reveal';
  clearInterval(timerInterval);
  const q = QUESTIONS[state.currentQ];
  const isLast = state.currentQ >= QUESTIONS.length - 1;
  broadcast({ type: 'reveal', correct: q.correct, ranking: getRanking().slice(0, 5), isLast });
}

function endGame() {
  state.screen = 'final';
  clearInterval(timerInterval);
  broadcast({ type: 'final', ranking: getRanking() });
}

// ─── WEBSOCKET ────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {

  // Keepalive ping para evitar timeout no Railway
  const ping = setInterval(() => {
    if (ws.readyState === 1) ws.ping();
  }, 25000);

  ws.on('close', () => {
    clearInterval(ping);
    if (ws === monitor) { monitor = null; console.log('Monitor desconectou'); }
    if (ws.playerName) console.log(`Saiu: ${ws.playerName}`);
  });

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // ── Monitor conecta ──
    if (data.type === 'monitor_connect') {
      monitor = ws;
      ws.role = 'monitor';
      send(ws, { type: 'state', players: getPlayerList(), screen: state.screen });
      console.log('Monitor conectado');
      return;
    }

    // ── Jogador entra ──
    if (data.type === 'join') {
      const name = (data.name || '').trim().slice(0, 20);
      if (!name) return;

      // Bloqueia entrada se jogo já começou
      if (state.screen !== 'lobby') {
        send(ws, { type: 'error', msg: 'O jogo já começou! Aguarde a próxima rodada.' });
        return;
      }

      ws.role = 'player';
      ws.playerName = name;

      // Reconexão ou novo jogador
      if (state.players[name]) {
        state.players[name].ws = ws;
      } else {
        state.players[name] = { score: 0, streak: 0, answered: false, ws };
      }

      send(ws, { type: 'joined', name });
      send(monitor, { type: 'player_joined', players: getPlayerList() });
      console.log(`Entrou: ${name} | Total: ${Object.keys(state.players).length}`);
      return;
    }

    // ── Monitor inicia ──
    if (data.type === 'start_game' && ws === monitor) {
      if (Object.keys(state.players).length === 0) {
        send(monitor, { type: 'error', msg: 'Nenhum jogador conectado!' });
        return;
      }
      Object.values(state.players).forEach(p => { p.score = 0; p.streak = 0; p.answered = false; });
      state.currentQ = 0;
      sendQuestion();
      return;
    }

    // ── Monitor avança ──
    if (data.type === 'next_question' && ws === monitor) {
      state.currentQ++;
      if (state.currentQ >= QUESTIONS.length) {
        endGame();
      } else {
        sendQuestion();
      }
      return;
    }

    // ── Monitor revela manualmente ──
    if (data.type === 'reveal_answer' && ws === monitor) {
      clearInterval(timerInterval);
      revealAnswer();
      return;
    }

    // ── Jogador responde ──
    if (data.type === 'answer' && ws.role === 'player') {
      const player = state.players[ws.playerName];
      if (!player || player.answered || state.screen !== 'question') return;

      player.answered = true;
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

      send(ws, { type: 'answer_result', correct: isCorrect, points: pts, score: player.score });

      const answeredCount = Object.values(state.players).filter(p => p.answered).length;
      const totalPlayers = Object.keys(state.players).length;
      send(monitor, { type: 'answer_update', answeredCount, totalPlayers });

      // Auto-revela se todos responderam
      if (answeredCount === totalPlayers) {
        clearInterval(timerInterval);
        setTimeout(() => revealAnswer(), 800);
      }
      return;
    }

    // ── Monitor reseta ──
    if (data.type === 'reset_game' && ws === monitor) {
      clearInterval(timerInterval);
      state = { screen: 'lobby', currentQ: 0, timeLeft: 20, players: {} };
      broadcast({ type: 'reset' });
      return;
    }
  });
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎯 Quiz B+P online na porta ${PORT}`));
