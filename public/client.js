'use strict';

const _ioScript = document.querySelector('script[src*="socket.io"]');
const _socketPath = new URL('./', _ioScript.src).pathname;
const socket = io({ path: _socketPath });

// ── State ─────────────────────────────────────────────────────────────────────

let pub = {};   // last publicView from server
let priv = {};  // last privateView from server
let mySid = null;
let joined = false;

// Canvas state
let canvas, ctx;
let drawing = false;
let hasDrawn = false;
let currentColor = '#000000';
let currentSize = 10;
let undoStack = [];

// ── DOM helpers ───────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

function showOnly(screenId) {
  const screens = [
    'screen-join','screen-lobby','screen-title','screen-drawing',
    'screen-fake','screen-vote','screen-reveal','screen-drawing-complete',
    'screen-round-complete','screen-game-complete',
  ];
  for (const s of screens) {
    $(s).classList.toggle('hidden', s !== screenId);
  }
}

function setText(id, text) {
  $(id).textContent = text;
}

function setError(id, msg) {
  $(id).textContent = msg || '';
}

function safeImg(id, src) {
  const el = $(id);
  if (src) { el.src = src; el.classList.remove('hidden'); }
  else { el.src = ''; el.classList.add('hidden'); }
}

// ── Scoreboard renderer ────────────────────────────────────────────────────────

function renderScoreboard(ulId, scores, names, gainMap) {
  const ul = $(ulId);
  ul.innerHTML = '';
  const sorted = Object.keys(scores).sort((a, b) => scores[b] - scores[a]);
  sorted.forEach((sid, i) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = (i === 0 ? '🥇 ' : '') + (names[sid] || '?');
    if (sid === mySid) name.style.fontWeight = '700';
    const pts = document.createElement('span');
    pts.className = 'pts';
    let ptsText = scores[sid] + ' очков';
    if (gainMap && gainMap[sid]) ptsText += ' (+' + gainMap[sid] + ')';
    pts.textContent = ptsText;
    li.appendChild(name);
    li.appendChild(pts);
    ul.appendChild(li);
  });
}

// ── Reveal summary renderer ────────────────────────────────────────────────────

function renderRevealItems(containerId, items) {
  const container = $(containerId);
  container.innerHTML = '';
  for (const item of items) {
    const div = document.createElement('div');
    div.className = 'reveal-item' + (item.type === 'correct' ? ' correct' : '');
    const t = document.createElement('div');
    t.className = 'title-text';
    t.textContent = '«' + item.title + '»';
    div.appendChild(t);
    const m = document.createElement('div');
    m.className = 'meta';
    if (item.type === 'fake') {
      m.textContent = 'Выбрали: ' + (item.voters.join(', ') || '—') + '. Придумал: ' + item.authorName;
    } else {
      let s = 'Правильное название. ';
      s += 'Выбрали: ' + (item.voters.join(', ') || 'никто') + '. ';
      s += 'Придумал: ' + item.authorName + ', рисовал: ' + item.drawerName + '.';
      if (item.noneGuessed) s += ' Никто не угадал — автор и художник получают по 1500.';
      m.textContent = s;
    }
    div.appendChild(m);
    container.appendChild(div);
  }
}

// ── Canvas ────────────────────────────────────────────────────────────────────

const COLORS = [
  '#000000','#ffffff','#e63946','#f4a261','#f9c74f','#2d9e5f','#457b9d','#7b2d8b',
  '#8b4513','#ff69b4','#00bcd4','#76b900','#1a237e','#9e9e9e','#bdbdbd','#800000',
];

const SIZES = [
  { label: 'S', size: 3, btnSize: 32 },
  { label: 'M', size: 10, btnSize: 40 },
  { label: 'L', size: 22, btnSize: 48 },
];

function initCanvas() {
  canvas = $('drawing-canvas');
  ctx = canvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  fillWhite();

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('contextmenu', e => e.preventDefault());
}

function resizeCanvas() {
  const w = Math.min(window.innerWidth - 48, 420);
  if (canvas.width === w) return;
  const snapshot = canvas.width > 0 ? ctx.getImageData(0, 0, canvas.width, canvas.height) : null;
  canvas.width = w;
  canvas.height = w;
  fillWhite();
  if (snapshot) ctx.putImageData(snapshot, 0, 0);
}

function fillWhite() {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function onDown(e) {
  e.preventDefault();
  if (undoStack.length >= 20) undoStack.shift();
  undoStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
  drawing = true;
  hasDrawn = true;
  $('drawing-submit-btn').disabled = false;
  const pos = getPos(e);
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, currentSize / 2, 0, Math.PI * 2);
  ctx.fillStyle = currentColor;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(pos.x, pos.y);
}

function onMove(e) {
  e.preventDefault();
  if (!drawing) return;
  const pos = getPos(e);
  ctx.lineTo(pos.x, pos.y);
  ctx.strokeStyle = currentColor;
  ctx.lineWidth = currentSize;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(pos.x, pos.y);
}

function onUp(e) {
  drawing = false;
}

function getPos(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const src = e.touches ? e.touches[0] : e;
  return {
    x: (src.clientX - rect.left) * scaleX,
    y: (src.clientY - rect.top) * scaleY,
  };
}

function buildColorPalette() {
  const palette = $('color-palette');
  palette.innerHTML = '';
  for (const color of COLORS) {
    const sw = document.createElement('button');
    sw.className = 'color-swatch' + (color === currentColor ? ' active' : '');
    sw.style.background = color;
    sw.style.width = '28px';
    sw.style.height = '28px';
    sw.title = color;
    sw.addEventListener('click', () => {
      currentColor = color;
      document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
      sw.classList.add('active');
    });
    palette.appendChild(sw);
  }
}

function buildSizeButtons() {
  const row = $('size-row');
  row.innerHTML = '';
  for (const s of SIZES) {
    const btn = document.createElement('button');
    btn.className = 'size-btn' + (s.size === currentSize ? ' active' : '');
    btn.style.width = s.btnSize + 'px';
    btn.style.height = s.btnSize + 'px';
    const dot = document.createElement('div');
    dot.className = 'size-dot';
    dot.style.width = s.size + 'px';
    dot.style.height = s.size + 'px';
    btn.appendChild(dot);
    btn.addEventListener('click', () => {
      currentSize = s.size;
      document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
    row.appendChild(btn);
  }
}

function resetCanvas() {
  undoStack = [];
  hasDrawn = false;
  fillWhite();
  $('drawing-submit-btn').disabled = true;
}

// ── Render ────────────────────────────────────────────────────────────────────

function render() {
  const { phase, playerNames, scores, submittedCount, totalCount,
          currentDrawingImageData, candidates, revealItems,
          drawingGains, round } = pub;
  const { myScore, inGame, submitted, myAssignment, isTitleAuthor, isDrawer,
          correctTitle, myVotedTitle, myFakeTitle, myGain, moreDrawings, moreRounds } = priv;

  // score badge
  if (joined) {
    $('score-badge').classList.remove('hidden');
    $('score-badge').textContent = (myScore || 0) + ' очков';
  }

  // reset button visible when in game and past lobby
  const showReset = joined && phase !== 'lobby';
  $('reset-btn').classList.toggle('hidden', !showReset);

  if (!joined || !inGame) {
    if (phase !== 'lobby') {
      // Server restarted; show join form with prefilled name
      showOnly('screen-join');
      const saved = localStorage.getItem('playerName');
      if (saved && !$('name-input').value) $('name-input').value = saved;
      return;
    }
    showOnly('screen-join');
    const saved = localStorage.getItem('playerName');
    if (saved && !$('name-input').value) $('name-input').value = saved;
    return;
  }

  if (phase === 'lobby') {
    showOnly('screen-lobby');
    setText('lobby-count', Object.keys(playerNames || {}).length);
    const ul = $('lobby-players');
    ul.innerHTML = '';
    for (const sid of Object.keys(playerNames || {})) {
      const li = document.createElement('li');
      li.textContent = playerNames[sid];
      ul.appendChild(li);
    }
    const count = Object.keys(playerNames || {}).length;
    $('start-btn').disabled = count < 5;
    return;
  }

  if (phase === 'titleWriting') {
    showOnly('screen-title');
    setText('title-round', round);
    if (submitted) {
      $('title-input').disabled = true;
      $('title-submit-btn').disabled = true;
      $('title-wait').classList.remove('hidden');
      const pct = totalCount ? (submittedCount / totalCount * 100) : 0;
      setText('title-prog', submittedCount);
      setText('title-total', totalCount);
      $('title-bar').style.width = pct + '%';
    } else {
      $('title-wait').classList.add('hidden');
    }
    return;
  }

  if (phase === 'drawing') {
    showOnly('screen-drawing');
    setText('drawing-assignment', myAssignment || '');
    if (submitted) {
      $('drawing-submit-btn').disabled = true;
      $('drawing-wait').classList.remove('hidden');
      const pct = totalCount ? (submittedCount / totalCount * 100) : 0;
      setText('drawing-prog', submittedCount);
      setText('drawing-total', totalCount);
      $('drawing-bar').style.width = pct + '%';
    } else {
      $('drawing-wait').classList.add('hidden');
    }
    return;
  }

  if (phase === 'fakeTitleWriting') {
    showOnly('screen-fake');
    safeImg('fake-drawing', currentDrawingImageData);
    if (isTitleAuthor) {
      $('fake-spectator').classList.remove('hidden');
      $('fake-spectator').textContent = 'Ваше название: «' + (correctTitle || '') + '»';
      $('fake-form').classList.add('hidden');
      $('fake-wait').classList.remove('hidden');
      const pct = totalCount ? (submittedCount / totalCount * 100) : 0;
      setText('fake-prog', submittedCount);
      setText('fake-total', totalCount);
      $('fake-bar').style.width = pct + '%';
    } else {
      // drawer sees notice + can submit; others just see form
      if (isDrawer) {
        $('fake-spectator').classList.remove('hidden');
        $('fake-spectator').textContent = 'Ваш рисунок. Правильное название: «' + (correctTitle || '') + '»';
      } else {
        $('fake-spectator').classList.add('hidden');
      }
      if (submitted) {
        $('fake-form').classList.add('hidden');
        $('fake-wait').classList.remove('hidden');
        const pct = totalCount ? (submittedCount / totalCount * 100) : 0;
        setText('fake-prog', submittedCount);
        setText('fake-total', totalCount);
        $('fake-bar').style.width = pct + '%';
      } else {
        $('fake-form').classList.remove('hidden');
        $('fake-wait').classList.add('hidden');
      }
    }
    return;
  }

  if (phase === 'voting') {
    showOnly('screen-vote');
    safeImg('vote-drawing', currentDrawingImageData);
    if (isTitleAuthor || isDrawer) {
      $('vote-spectator').classList.remove('hidden');
      $('vote-spectator').textContent = isTitleAuthor
        ? 'Ваше название: «' + (correctTitle || '') + '»'
        : 'Ваш рисунок. Правильное название: «' + (correctTitle || '') + '»';
      $('vote-form').classList.add('hidden');
      $('vote-wait').classList.remove('hidden');
      const pct = totalCount ? (submittedCount / totalCount * 100) : 0;
      setText('vote-prog', submittedCount);
      setText('vote-total', totalCount);
      $('vote-bar').style.width = pct + '%';
    } else {
      $('vote-spectator').classList.add('hidden');
      if (submitted) {
        $('vote-form').classList.add('hidden');
        $('vote-wait').classList.remove('hidden');
        const pct = totalCount ? (submittedCount / totalCount * 100) : 0;
        setText('vote-prog', submittedCount);
        setText('vote-total', totalCount);
        $('vote-bar').style.width = pct + '%';
      } else {
        $('vote-form').classList.remove('hidden');
        $('vote-wait').classList.add('hidden');
        const list = $('vote-candidates');
        if (list.children.length === 0 && candidates) {
          for (const title of candidates) {
            const btn = document.createElement('button');
            btn.className = 'candidate-btn';
            btn.textContent = title;
            if (myFakeTitle && title.trim().toLowerCase() === myFakeTitle.trim().toLowerCase()) {
              btn.disabled = true;
              btn.title = 'Ваше название';
            }
            btn.addEventListener('click', () => {
              if (submitted) return;
              document.querySelectorAll('.candidate-btn').forEach(b => b.classList.remove('selected'));
              btn.classList.add('selected');
              socket.emit('submitVote', { title });
            });
            list.appendChild(btn);
          }
        }
      }
    }
    return;
  }

  if (phase === 'revealing') {
    showOnly('screen-reveal');
    safeImg('reveal-drawing', currentDrawingImageData);
    renderRevealItems('reveal-items', revealItems || []);
    return;
  }

  if (phase === 'drawingComplete') {
    showOnly('screen-drawing-complete');
    safeImg('dc-drawing', currentDrawingImageData);
    renderRevealItems('dc-reveal-summary', revealItems || []);
    if (myGain) {
      $('dc-gain').innerHTML = '<span class="gain-badge">+' + myGain + ' очков!</span>';
    } else {
      $('dc-gain').innerHTML = '<span style="color:var(--muted);font-size:.9rem">Очков не получено</span>';
    }
    renderScoreboard('dc-scoreboard', scores || {}, playerNames || {}, drawingGains);
    const nextBtn = $('dc-next-btn');
    if (!moreDrawings) {
      nextBtn.textContent = moreRounds ? 'Следующий раунд' : 'Показать итоги';
    } else {
      nextBtn.textContent = 'Следующий рисунок';
    }
    return;
  }

  if (phase === 'roundComplete') {
    showOnly('screen-round-complete');
    setText('rc-heading', 'Конец раунда ' + round);
    renderScoreboard('rc-scoreboard', scores || {}, playerNames || {}, null);
    return;
  }

  if (phase === 'gameComplete') {
    showOnly('screen-game-complete');
    const sorted = Object.keys(scores || {}).sort((a, b) => scores[b] - scores[a]);
    const winner = sorted[0];
    if (winner) {
      $('gc-winner').textContent = 'Победитель: ' + (playerNames[winner] || '?') + ' (' + scores[winner] + ' очков)';
    }
    renderScoreboard('gc-scoreboard', scores || {}, playerNames || {}, null);
    return;
  }
}

// ── Socket events ─────────────────────────────────────────────────────────────

socket.on('stateUpdate', data => {
  const prevPhase = pub.phase;
  pub = data;

  // Reset candidate list DOM when entering voting fresh
  if (data.phase === 'voting' && prevPhase !== 'voting') {
    $('vote-candidates').innerHTML = '';
  }
  // Clear fake title input between drawings
  if (data.phase === 'fakeTitleWriting' && prevPhase !== 'fakeTitleWriting') {
    $('fake-input').value = '';
    setError('fake-error', '');
  }
  // Reset canvas when entering drawing phase
  if (data.phase === 'drawing' && prevPhase !== 'drawing') {
    resetCanvas();
    setError('drawing-error', '');
  }

  render();
});

socket.on('privateUpdate', data => {
  const prevPhase = priv.phase;
  priv = data;
  if (data.mySid) mySid = data.mySid;
  joined = data.inGame;
  render();
});

socket.on('revealStep', item => {
  // handled via stateUpdate (revealItems accumulates on server)
});

socket.on('error', msg => {
  // Route error to the right field
  const phase = pub.phase;
  if (!joined) return setError('join-error', msg);
  if (phase === 'lobby') return setError('lobby-error', msg);
  if (phase === 'titleWriting') return setError('title-error', msg);
  if (phase === 'drawing') return setError('drawing-error', msg);
  if (phase === 'fakeTitleWriting') return setError('fake-error', msg);
  if (phase === 'voting') return setError('vote-error', msg);
  if (phase === 'drawingComplete') return setError('dc-error', msg);
  if (phase === 'roundComplete') return setError('rc-error', msg);
  setError('error-global', msg);
});

socket.on('confirmResetPrompt', () => {
  if (confirm('Вы уверены? Игра будет сброшена.')) {
    socket.emit('confirmReset');
  }
});

// ── Button wiring ─────────────────────────────────────────────────────────────

$('join-btn').addEventListener('click', () => {
  const name = $('name-input').value.trim();
  setError('join-error', '');
  localStorage.setItem('playerName', name);
  socket.emit('join', { name });
});

$('name-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('join-btn').click();
});

$('start-btn').addEventListener('click', () => {
  setError('lobby-error', '');
  socket.emit('startGame');
});

$('title-submit-btn').addEventListener('click', () => {
  const title = $('title-input').value;
  setError('title-error', '');
  socket.emit('submitTitle', { title });
});

$('title-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('title-submit-btn').click();
});

$('drawing-submit-btn').addEventListener('click', () => {
  setError('drawing-error', '');
  if (!hasDrawn) return setError('drawing-error', 'Нарисуйте что-нибудь перед отправкой');
  const imageData = canvas.toDataURL('image/png');
  socket.emit('submitDrawing', { imageData, hasDrawn });
});

$('clear-btn').addEventListener('click', () => {
  if (confirm('Очистить холст?')) {
    resetCanvas();
  }
});

$('undo-btn').addEventListener('click', () => {
  if (undoStack.length > 0) {
    ctx.putImageData(undoStack.pop(), 0, 0);
  }
});

$('fake-submit-btn').addEventListener('click', () => {
  const title = $('fake-input').value;
  setError('fake-error', '');
  socket.emit('submitFakeTitle', { title });
});

$('fake-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('fake-submit-btn').click();
});

$('dc-next-btn').addEventListener('click', () => {
  setError('dc-error', '');
  socket.emit('advance');
});

$('rc-next-btn').addEventListener('click', () => {
  setError('rc-error', '');
  socket.emit('advance');
});

$('gc-reset-btn').addEventListener('click', () => {
  socket.emit('resetGame');
});

$('reset-btn').addEventListener('click', () => {
  socket.emit('resetGame');
});

// ── Init canvas on load ───────────────────────────────────────────────────────

window.addEventListener('load', () => {
  initCanvas();
  buildColorPalette();
  buildSizeButtons();

  // prefill name from localStorage
  const saved = localStorage.getItem('playerName');
  if (saved) $('name-input').value = saved;
});
