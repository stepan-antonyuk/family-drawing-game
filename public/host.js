'use strict';

const _ioScript = document.querySelector('script[src*="socket.io"]');
const _socketPath = new URL('./', _ioScript.src).pathname;
const socket = io({ path: _socketPath });

// Player URL: host page is at .../host, player page is one level up
const PLAYER_URL = new URL('./', window.location.href).href;

let pub = {};
let _qrChecked = false;

const $ = id => document.getElementById(id);

const HOST_SECTIONS = [
  'h-lobby','h-title-writing','h-drawing','h-fake','h-voting',
  'h-revealing','h-drawing-complete','h-round-complete','h-game-complete',
];

function showOnly(id) {
  for (const s of HOST_SECTIONS) $(s).classList.toggle('hidden', s !== id);
}

function setText(id, text) {
  $(id).textContent = text;
}


function renderScoreboard(scores, names, gains) {
  const ul = $('h-scoreboard');
  ul.innerHTML = '';
  const sorted = Object.keys(scores).sort((a, b) => scores[b] - scores[a]);
  for (const sid of sorted) {
    const li = document.createElement('li');
    const nameEl = document.createElement('span');
    nameEl.textContent = names[sid] || '?';
    const ptsEl = document.createElement('span');
    ptsEl.className = 'h-pts';
    let txt = scores[sid];
    if (gains && gains[sid]) txt += ' (+' + gains[sid] + ')';
    ptsEl.textContent = txt;
    li.appendChild(nameEl);
    li.appendChild(ptsEl);
    ul.appendChild(li);
  }
  $('h-scoreboard-wrap').classList.remove('hidden');
}

function renderPlayerChips(names, completedSids, spectatorSids) {
  const wrap = $('h-player-chips');
  wrap.innerHTML = '';
  const completed = new Set(completedSids || []);
  const spectators = new Set(spectatorSids || []);
  for (const sid of Object.keys(names)) {
    const chip = document.createElement('div');
    if (spectators.has(sid)) {
      chip.className = 'h-chip h-chip-spec';
      chip.textContent = names[sid] + ' —';
    } else if (completed.has(sid)) {
      chip.className = 'h-chip h-chip-done';
      chip.textContent = names[sid] + ' ✓';
    } else {
      chip.className = 'h-chip h-chip-wait';
      chip.textContent = names[sid] + ' ○';
    }
    wrap.appendChild(chip);
  }
  wrap.classList.remove('hidden');
}

function hidePlayerChips() {
  $('h-player-chips').classList.add('hidden');
}

function renderRevealItems(containerId, items) {
  const container = $(containerId);
  container.innerHTML = '';
  for (const item of items) {
    const div = document.createElement('div');
    div.className = 'host-reveal-item' + (item.type === 'correct' ? ' correct' : '');
    const t = document.createElement('div');
    t.className = 'h-title';
    t.textContent = '«' + item.title + '»';
    div.appendChild(t);
    const m = document.createElement('div');
    m.className = 'h-meta';
    if (item.type === 'fake') {
      m.textContent = 'Выбрали: ' + (item.voters.join(', ') || '—') + '. Придумал: ' + item.authorName;
    } else {
      let s = 'Правильное название. Выбрали: ' + (item.voters.join(', ') || 'никто') + '. ';
      s += 'Придумал: ' + item.authorName + ', рисовал: ' + item.drawerName + '.';
      if (item.noneGuessed) s += ' Никто не угадал — автор и художник получают по 1500.';
      m.textContent = s;
    }
    div.appendChild(m);
    container.appendChild(div);
  }
}

function checkQr() {
  if (_qrChecked) return;
  _qrChecked = true;
  const qr = $('h-qr');
  qr.onerror = () => qr.classList.add('hidden');
  qr.onload = () => qr.classList.remove('hidden');
  qr.src = new URL('qr.png', PLAYER_URL).href;
}

function render() {
  const { phase, round, playerNames, scores, submittedCount, totalCount,
          currentDrawingImageData, candidates, revealItems,
          drawingGains } = pub;

  const names = playerNames || {};
  const sc = scores || {};

  const badge = $('host-round-badge');
  if (round) {
    badge.textContent = 'Раунд ' + round + '/3';
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  if (phase === 'lobby') {
    showOnly('h-lobby');
    $('h-scoreboard-wrap').classList.add('hidden');
    $('h-join-url').textContent = PLAYER_URL;
    checkQr();
    setText('h-lobby-count', Object.keys(names).length);
    const ul = $('h-player-list');
    ul.innerHTML = '';
    for (const sid of Object.keys(names)) {
      const li = document.createElement('li');
      li.textContent = names[sid];
      ul.appendChild(li);
    }
    return;
  }

  if (phase === 'titleWriting') {
    showOnly('h-title-writing');
    setText('h-tw-round', round);
    renderPlayerChips(names, pub.completedSids, []);
    renderScoreboard(sc, names, null);
    return;
  }

  if (phase === 'drawing') {
    showOnly('h-drawing');
    renderPlayerChips(names, pub.completedSids, []);
    renderScoreboard(sc, names, null);
    return;
  }

  if (phase === 'fakeTitleWriting') {
    showOnly('h-fake');
    $('h-fake-img').src = currentDrawingImageData || '';
    renderPlayerChips(names, pub.completedSids, pub.spectatorSids);
    renderScoreboard(sc, names, null);
    return;
  }

  if (phase === 'voting') {
    showOnly('h-voting');
    $('h-vote-img').src = currentDrawingImageData || '';
    const ul = $('h-candidates');
    ul.innerHTML = '';
    for (const title of (candidates || [])) {
      const li = document.createElement('li');
      li.textContent = title;
      ul.appendChild(li);
    }
    renderPlayerChips(names, pub.completedSids, pub.spectatorSids);
    renderScoreboard(sc, names, null);
    return;
  }

  if (phase === 'revealing') {
    showOnly('h-revealing');
    $('h-rev-img').src = currentDrawingImageData || '';
    renderRevealItems('h-reveal-items', revealItems || []);
    hidePlayerChips();
    renderScoreboard(sc, names, drawingGains);
    return;
  }

  if (phase === 'drawingComplete') {
    showOnly('h-drawing-complete');
    $('h-dc-img').src = currentDrawingImageData || '';
    renderRevealItems('h-dc-reveal', revealItems || []);
    hidePlayerChips();
    renderScoreboard(sc, names, drawingGains);
    return;
  }

  if (phase === 'roundComplete') {
    showOnly('h-round-complete');
    setText('h-rc-heading', 'Конец раунда ' + round);
    hidePlayerChips();
    renderScoreboard(sc, names, null);
    return;
  }

  if (phase === 'gameComplete') {
    showOnly('h-game-complete');
    const sorted = Object.keys(sc).sort((a, b) => sc[b] - sc[a]);
    const winner = sorted[0];
    $('h-gc-winner').textContent = winner ? 'Победитель: ' + (names[winner] || '?') : '';
    hidePlayerChips();
    renderScoreboard(sc, names, null);
    return;
  }
}

socket.on('stateUpdate', data => {
  pub = data;
  render();
});

socket.on('revealStep', () => {
  // handled via stateUpdate
});
