'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// ── State ────────────────────────────────────────────────────────────────────

function freshState() {
  return {
    phase: 'lobby',
    round: 0,
    players: {},        // sid → { name, score }
    titles: {},         // sid → string
    assignments: {},    // sid(drawer) → string (title to draw)
    titleAuthors: {},   // sid(drawer) → sid(author)
    drawings: {},       // sid(drawer) → base64 png

    drawingQueue: [],
    currentDrawingIdx: 0,
    currentDrawer: null,
    currentTitleAuthor: null,
    currentTitle: null,

    fakeTitles: {},     // sid(submitter) → string
    votes: {},          // sid(voter) → title string
    candidates: [],     // [{ id, title, authorId }]

    revealItems: [],    // accumulated reveal steps sent to clients
    revealTimers: [],   // setTimeout handles

    drawingGains: {},   // sid → points gained this drawing
  };
}

let state = freshState();
const sockets = {};     // sid → socket

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalize(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  cookieHeader.split(';').forEach(part => {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k.trim()] = decodeURIComponent(v.join('='));
  });
  return out;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function derange(arr) {
  if (arr.length < 2) return arr;
  let result;
  let attempts = 0;
  do {
    result = shuffle([...arr]);
    attempts++;
  } while (result.some((v, i) => v === arr[i]) && attempts < 200);
  return result;
}

function playerCount() {
  return Object.keys(state.players).length;
}

function playerName(sid) {
  return state.players[sid] ? state.players[sid].name : '?';
}

// ── Views ────────────────────────────────────────────────────────────────────

function publicView() {
  const names = {};
  const scores = {};
  for (const sid of Object.keys(state.players)) {
    names[sid] = state.players[sid].name;
    scores[sid] = state.players[sid].score;
  }

  const view = {
    phase: state.phase,
    round: state.round,
    playerNames: names,
    scores,
    totalDrawings: state.drawingQueue.length,
    currentDrawingIdx: state.currentDrawingIdx,
  };

  // progress counters
  const { phase } = state;
  if (phase === 'titleWriting') {
    view.submittedCount = Object.keys(state.titles).length;
    view.totalCount = playerCount();
  } else if (phase === 'drawing') {
    view.submittedCount = Object.keys(state.drawings).length;
    view.totalCount = playerCount();
  } else if (phase === 'fakeTitleWriting') {
    const eligible = Object.keys(state.players).filter(s => s !== state.currentTitleAuthor);
    view.submittedCount = Object.keys(state.fakeTitles).length;
    view.totalCount = eligible.length;
    view.currentDrawingImageData = state.drawings[state.currentDrawer] || null;
  } else if (phase === 'voting') {
    const eligible = Object.keys(state.players).filter(
      s => s !== state.currentTitleAuthor && s !== state.currentDrawer
    );
    view.submittedCount = Object.keys(state.votes).length;
    view.totalCount = eligible.length;
    view.currentDrawingImageData = state.drawings[state.currentDrawer] || null;
    view.candidates = state.candidates.map(c => c.title);
  } else if (phase === 'revealing') {
    view.currentDrawingImageData = state.drawings[state.currentDrawer] || null;
    view.candidates = state.candidates.map(c => c.title);
    view.revealItems = state.revealItems;
  } else if (phase === 'drawingComplete') {
    view.currentDrawingImageData = state.drawings[state.currentDrawer] || null;
    view.drawingGains = state.drawingGains;
    view.revealItems = state.revealItems;
  } else if (phase === 'roundComplete' || phase === 'gameComplete') {
    // just scores
  }

  return view;
}

function privateView(sid) {
  const { phase } = state;
  const view = {
    mySid: sid,
    myScore: state.players[sid] ? state.players[sid].score : 0,
    inGame: !!state.players[sid],
  };

  if (phase === 'titleWriting') {
    view.submitted = !!state.titles[sid];
  } else if (phase === 'drawing') {
    view.myAssignment = state.assignments[sid] || null;
    view.submitted = !!state.drawings[sid];
  } else if (phase === 'fakeTitleWriting') {
    view.isTitleAuthor = sid === state.currentTitleAuthor;
    view.isDrawer = sid === state.currentDrawer;
    if (view.isTitleAuthor || view.isDrawer) {
      view.correctTitle = state.currentTitle;
    }
    view.submitted = view.isTitleAuthor ? false : !!state.fakeTitles[sid];
  } else if (phase === 'voting') {
    view.isTitleAuthor = sid === state.currentTitleAuthor;
    view.isDrawer = sid === state.currentDrawer;
    if (view.isTitleAuthor || view.isDrawer) {
      view.correctTitle = state.currentTitle;
    }
    view.submitted = !!state.votes[sid];
    view.myVotedTitle = state.votes[sid] || null;
    view.myFakeTitle = state.fakeTitles[sid] || null;
  } else if (phase === 'revealing') {
    view.isTitleAuthor = sid === state.currentTitleAuthor;
    view.isDrawer = sid === state.currentDrawer;
    view.correctTitle = state.currentTitle;
  } else if (phase === 'drawingComplete') {
    view.isTitleAuthor = sid === state.currentTitleAuthor;
    view.isDrawer = sid === state.currentDrawer;
    view.myGain = state.drawingGains[sid] || 0;
    const remaining = state.drawingQueue.length - state.currentDrawingIdx - 1;
    view.moreDrawings = remaining > 0;
    view.moreRounds = state.round < 3;
  }

  return view;
}

function emitPublic() {
  io.emit('stateUpdate', publicView());
}

function emitPrivate(sid) {
  const sock = sockets[sid];
  if (sock) sock.emit('privateUpdate', privateView(sid));
}

function emitAllPrivate() {
  for (const sid of Object.keys(sockets)) {
    emitPrivate(sid);
  }
}

function err(socket, msg) {
  socket.emit('error', msg);
}

// ── Game Logic ───────────────────────────────────────────────────────────────

function startGame() {
  state.round = 1;
  state.phase = 'titleWriting';
  state.titles = {};
  emitPublic();
  emitAllPrivate();
}

function doAssignTitles() {
  const ids = Object.keys(state.players);
  const deranged = derange(ids);
  state.assignments = {};
  state.titleAuthors = {};
  for (let i = 0; i < ids.length; i++) {
    const drawer = deranged[i];
    const author = ids[i];
    state.assignments[drawer] = state.titles[author];
    state.titleAuthors[drawer] = author;
  }
}

function startDrawingPhase() {
  doAssignTitles();
  state.drawings = {};
  state.phase = 'drawing';
  emitPublic();
  emitAllPrivate();
}

function setupDrawing(idx) {
  state.currentDrawingIdx = idx;
  const drawerId = state.drawingQueue[idx];
  state.currentDrawer = drawerId;
  state.currentTitleAuthor = state.titleAuthors[drawerId];
  state.currentTitle = state.assignments[drawerId];
  state.fakeTitles = {};
  state.votes = {};
  state.candidates = [];
  state.revealItems = [];
  state.revealTimers = [];
  state.phase = 'fakeTitleWriting';
}

function startFakeTitlePhase() {
  // build shuffled drawing queue for this round
  state.drawingQueue = shuffle(Object.keys(state.players));
  setupDrawing(0);
  emitPublic();
  emitAllPrivate();
}

function buildCandidates() {
  const items = [];
  for (const [sid, title] of Object.entries(state.fakeTitles)) {
    items.push({ id: uuidv4(), title, authorId: sid });
  }
  items.push({ id: uuidv4(), title: state.currentTitle, authorId: 'correct' });
  shuffle(items);
  state.candidates = items;
}

function startVoting() {
  buildCandidates();
  state.votes = {};
  state.phase = 'voting';
  emitPublic();
  emitAllPrivate();
}

function computeScores() {
  state.drawingGains = {};
  const gains = state.drawingGains;

  const correctVoters = [];
  for (const [voterId, chosenTitle] of Object.entries(state.votes)) {
    if (normalize(chosenTitle) === normalize(state.currentTitle)) {
      correctVoters.push(voterId);
    }
  }

  // correct guesses
  for (const vid of correctVoters) {
    gains[vid] = (gains[vid] || 0) + 1000;
  }

  // fake title fooling points
  for (const [voterId, chosenTitle] of Object.entries(state.votes)) {
    const candidate = state.candidates.find(c => normalize(c.title) === normalize(chosenTitle));
    if (candidate && candidate.authorId !== 'correct') {
      const authorId = candidate.authorId;
      gains[authorId] = (gains[authorId] || 0) + 500;
    }
  }

  // nobody guessed correctly bonus
  if (correctVoters.length === 0) {
    gains[state.currentDrawer] = (gains[state.currentDrawer] || 0) + 1500;
    gains[state.currentTitleAuthor] = (gains[state.currentTitleAuthor] || 0) + 1500;
  }

  // apply gains
  for (const [sid, pts] of Object.entries(gains)) {
    if (state.players[sid]) {
      state.players[sid].score += pts;
    }
  }
}

function startReveal() {
  computeScores();
  state.phase = 'revealing';
  state.revealItems = [];

  // collect fake titles that got votes
  const voted = [];
  for (const candidate of state.candidates) {
    if (candidate.authorId === 'correct') continue;
    const voters = Object.entries(state.votes)
      .filter(([, t]) => normalize(t) === normalize(candidate.title))
      .map(([vid]) => playerName(vid));
    if (voters.length > 0) {
      voted.push({ type: 'fake', title: candidate.title, voters, authorName: playerName(candidate.authorId) });
    }
  }

  // correct title
  const correctVoters = Object.entries(state.votes)
    .filter(([, t]) => normalize(t) === normalize(state.currentTitle))
    .map(([vid]) => playerName(vid));
  voted.push({
    type: 'correct',
    title: state.currentTitle,
    voters: correctVoters,
    authorName: playerName(state.currentTitleAuthor),
    drawerName: playerName(state.currentDrawer),
    noneGuessed: correctVoters.length === 0,
    drawerBonus: correctVoters.length === 0 ? 1500 : 0,
  });

  emitPublic();
  emitAllPrivate();

  // schedule each reveal step
  let delay = 2000;
  for (const item of voted) {
    const t = setTimeout(() => {
      state.revealItems.push(item);
      io.emit('revealStep', item);
      emitPublic();
    }, delay);
    state.revealTimers.push(t);
    delay += 2000;
  }

  // after last item, move to drawingComplete
  const finalTimer = setTimeout(() => {
    state.phase = 'drawingComplete';
    state.revealTimers = [];
    emitPublic();
    emitAllPrivate();
  }, delay);
  state.revealTimers.push(finalTimer);
}

function advanceAfterDrawing() {
  const nextIdx = state.currentDrawingIdx + 1;
  if (nextIdx < state.drawingQueue.length) {
    setupDrawing(nextIdx);
    emitPublic();
    emitAllPrivate();
  } else {
    // round done
    if (state.round >= 3) {
      state.phase = 'gameComplete';
    } else {
      state.phase = 'roundComplete';
    }
    emitPublic();
    emitAllPrivate();
  }
}

function advanceAfterRound() {
  state.round++;
  state.titles = {};
  state.assignments = {};
  state.titleAuthors = {};
  state.drawings = {};
  state.phase = 'titleWriting';
  emitPublic();
  emitAllPrivate();
}

function resetGame() {
  for (const t of state.revealTimers) clearTimeout(t);
  state = freshState();
  emitPublic();
  for (const sid of Object.keys(sockets)) emitPrivate(sid);
}

// ── Cookie middleware for HTTP ────────────────────────────────────────────────

app.use((req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  if (!cookies.sid) {
    const sid = uuidv4();
    res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  }
  next();
});

app.use(express.static('public'));

app.get('/host', (req, res) => {
  res.sendFile('host.html', { root: 'public' });
});

// ── Socket.IO ────────────────────────────────────────────────────────────────

io.on('connection', socket => {
  const cookies = parseCookies(socket.handshake.headers.cookie);
  const sid = cookies.sid || uuidv4();

  sockets[sid] = socket;

  // send current state to newly connected client
  socket.emit('stateUpdate', publicView());
  socket.emit('privateUpdate', privateView(sid));

  socket.on('disconnect', () => {
    if (sockets[sid] === socket) delete sockets[sid];
  });

  // ── join ──────────────────────────────────────────────────────────────────

  socket.on('join', ({ name } = {}) => {
    if (typeof name !== 'string') return err(socket, 'Неверный запрос');
    name = name.trim();
    if (!name || name.length < 1 || name.length > 20) {
      return err(socket, 'Имя должно быть от 1 до 20 символов');
    }
    if (state.phase !== 'lobby') {
      // allow rejoin if already registered
      if (state.players[sid]) {
        socket.emit('stateUpdate', publicView());
        socket.emit('privateUpdate', privateView(sid));
        return;
      }
      return err(socket, 'Игра уже началась');
    }
    if (playerCount() >= 10 && !state.players[sid]) {
      return err(socket, 'Максимум 10 игроков');
    }

    // check name uniqueness (case-insensitive), allow same player to re-set name
    const nameLower = normalize(name);
    for (const [otherId, p] of Object.entries(state.players)) {
      if (otherId !== sid && normalize(p.name) === nameLower) {
        return err(socket, 'Это имя уже занято');
      }
    }

    if (!state.players[sid]) {
      state.players[sid] = { name, score: 0 };
    } else {
      state.players[sid].name = name;
    }

    emitPublic();
    emitAllPrivate();
  });

  // ── startGame ─────────────────────────────────────────────────────────────

  socket.on('startGame', () => {
    if (state.phase !== 'lobby') return err(socket, 'Игра уже идёт');
    if (!state.players[sid]) return err(socket, 'Вы не в игре');
    if (playerCount() < 5) return err(socket, 'Нужно минимум 5 игроков');
    startGame();
  });

  // ── submitTitle ───────────────────────────────────────────────────────────

  socket.on('submitTitle', ({ title } = {}) => {
    if (state.phase !== 'titleWriting') return err(socket, 'Сейчас не ваш ход');
    if (!state.players[sid]) return err(socket, 'Вы не в игре');
    if (state.titles[sid]) return err(socket, 'Вы уже отправили');
    if (typeof title !== 'string') return err(socket, 'Неверный запрос');
    title = title.trim().replace(/\s+/g, ' ');
    if (title.length < 2) return err(socket, 'Название слишком короткое (минимум 2 символа)');
    if (title.length > 200) return err(socket, 'Название слишком длинное (максимум 200 символов)');

    const norm = normalize(title);
    for (const existing of Object.values(state.titles)) {
      if (normalize(existing) === norm) return err(socket, 'Такое название уже есть');
    }

    state.titles[sid] = title;

    if (Object.keys(state.titles).length === playerCount()) {
      startDrawingPhase();
    } else {
      emitPublic();
      emitPrivate(sid);
    }
  });

  // ── submitDrawing ─────────────────────────────────────────────────────────

  socket.on('submitDrawing', ({ imageData, hasDrawn } = {}) => {
    if (state.phase !== 'drawing') return err(socket, 'Сейчас не ваш ход');
    if (!state.players[sid]) return err(socket, 'Вы не в игре');
    if (state.drawings[sid]) return err(socket, 'Вы уже отправили');
    if (!hasDrawn) return err(socket, 'Нарисуйте что-нибудь перед отправкой');
    if (typeof imageData !== 'string' || !imageData.startsWith('data:image/')) {
      return err(socket, 'Неверный формат рисунка');
    }

    state.drawings[sid] = imageData;

    if (Object.keys(state.drawings).length === playerCount()) {
      startFakeTitlePhase();
    } else {
      emitPublic();
      emitPrivate(sid);
    }
  });

  // ── submitFakeTitle ───────────────────────────────────────────────────────

  socket.on('submitFakeTitle', ({ title } = {}) => {
    if (state.phase !== 'fakeTitleWriting') return err(socket, 'Сейчас не ваш ход');
    if (!state.players[sid]) return err(socket, 'Вы не в игре');
    if (sid === state.currentTitleAuthor) return err(socket, 'Вы автор названия — ждите');
    if (state.fakeTitles[sid]) return err(socket, 'Вы уже отправили');
    if (typeof title !== 'string') return err(socket, 'Неверный запрос');
    title = title.trim().replace(/\s+/g, ' ');
    if (title.length < 2) return err(socket, 'Название слишком короткое (минимум 2 символа)');
    if (title.length > 200) return err(socket, 'Название слишком длинное (максимум 200 символов)');

    const norm = normalize(title);
    if (norm === normalize(state.currentTitle)) return err(socket, 'Такое название уже есть');
    for (const existing of Object.values(state.fakeTitles)) {
      if (normalize(existing) === norm) return err(socket, 'Такое название уже есть');
    }

    state.fakeTitles[sid] = title;

    const eligible = Object.keys(state.players).filter(s => s !== state.currentTitleAuthor);
    if (Object.keys(state.fakeTitles).length === eligible.length) {
      startVoting();
    } else {
      emitPublic();
      emitPrivate(sid);
    }
  });

  // ── submitVote ────────────────────────────────────────────────────────────

  socket.on('submitVote', ({ title } = {}) => {
    if (state.phase !== 'voting') return err(socket, 'Сейчас не ваш ход');
    if (!state.players[sid]) return err(socket, 'Вы не в игре');
    if (sid === state.currentTitleAuthor) return err(socket, 'Вы автор названия — ждите');
    if (sid === state.currentDrawer) return err(socket, 'Вы рисовали — ждите');
    if (state.votes[sid]) return err(socket, 'Вы уже проголосовали');
    if (typeof title !== 'string') return err(socket, 'Неверный запрос');

    const norm = normalize(title);
    const candidate = state.candidates.find(c => normalize(c.title) === norm);
    if (!candidate) return err(socket, 'Нет такого варианта');

    // cannot vote for own fake title
    if (candidate.authorId === sid) return err(socket, 'Нельзя голосовать за своё название');

    state.votes[sid] = title;

    const eligible = Object.keys(state.players).filter(
      s => s !== state.currentTitleAuthor && s !== state.currentDrawer
    );
    if (Object.keys(state.votes).length === eligible.length) {
      startReveal();
    } else {
      emitPublic();
      emitPrivate(sid);
    }
  });

  // ── advance ───────────────────────────────────────────────────────────────

  socket.on('advance', () => {
    if (!state.players[sid]) return err(socket, 'Вы не в игре');
    if (state.phase === 'drawingComplete') {
      advanceAfterDrawing();
    } else if (state.phase === 'roundComplete') {
      advanceAfterRound();
    }
  });

  // ── resetGame ─────────────────────────────────────────────────────────────

  socket.on('resetGame', () => {
    // client must confirm; send back a prompt request
    socket.emit('confirmResetPrompt');
  });

  socket.on('confirmReset', () => {
    resetGame();
  });
});

// ── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`Семейная Рисовалка запущена: http://localhost:${PORT}`);
  console.log(`Хост: http://localhost:${PORT}/host`);
});
