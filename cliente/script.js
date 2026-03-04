// ══════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════
const WS_URL = `ws://${location.hostname}:8000/ws`;
const CROSSHAIR_OFFSET_PERCENT = 0.62; // 62% down the pipe
const ZONE_TOLERANCE_PX = 55;          // balloon center must be within this of crosshair
const GAME_DURATION = 120;             // seconds
const MAX_LIVES = 5;

// Balloon definitions (client-side display only; server drives the data)
const BALLOON_COLORS = {
  red: '#cc0000', blue: '#0044cc', green: '#00aa33',
  yellow: '#cc9900', black: '#222', white: '#ccc',
  purple: '#6600aa', moab: '#334'
};

// ══════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════
let ws = null;
let players = {};            // { name: { score, avatar, side } }
let balloons = {};           // { id: { el, type, hp, maxHp, top, speed } }
let crosshairY = 0;
let lives = MAX_LIVES;
let timeLeft = GAME_DURATION;
let timerInterval = null;
let phase = 'lobby';         // lobby | game | scoring
let balloonInZone = false;

// ══════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════
const $ = id => document.getElementById(id);

const AVATARS = ['🐸', '🐙', '🦊', '🐼', '🐯', '🦁', '🐻', '🐮', '🐷', '🐸'];
let avatarIdx = 0;

function getAvatar() {
  return AVATARS[avatarIdx++ % AVATARS.length];
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = String(s % 60).padStart(2, '0');
  return `${m}:${sec}`;
}

// ══════════════════════════════════════════════
//  WEBSOCKET
// ══════════════════════════════════════════════
function connect() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    $('wsDot').className = 'ws-dot connected';
    $('wsLabel').textContent = 'Connected';
    $('connOverlay').classList.add('hidden');
  };

  ws.onclose = () => {
    $('wsDot').className = 'ws-dot error';
    $('wsLabel').textContent = 'Disconnected';
    $('connOverlay').classList.remove('hidden');
    setTimeout(connect, 2000);
  };

  ws.onerror = () => {
    $('wsDot').className = 'ws-dot error';
  };

  ws.onmessage = e => {
    try {
      const msg = JSON.parse(e.data);
      handleMessage(msg);
    } catch (err) {
      console.error('WS parse error', err);
    }
  };
}

function sendWS(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ══════════════════════════════════════════════
//  MESSAGE HANDLER
// ══════════════════════════════════════════════
function handleMessage(msg) {
  switch (msg.type) {
    case 'player_joined':   onPlayerJoined(msg);   break;
    case 'player_left':     onPlayerLeft(msg);     break;
    case 'game_start':      onGameStart(msg);      break;
    case 'balloon_spawn':   onBalloonSpawn(msg);   break;
    case 'balloon_hit':     onBalloonHit(msg);     break;
    case 'balloon_pop':     onBalloonPop(msg);     break;
    case 'balloon_escaped': onBalloonEscaped(msg); break;
    case 'shoot_miss':      onShootMiss(msg);      break;
    case 'game_over':       onGameOver(msg);       break;
    case 'state_sync':      onStateSync(msg);      break;
    case 'zone_update':     onZoneUpdate(msg);     break;
  }
}

// ══════════════════════════════════════════════
//  LOBBY
// ══════════════════════════════════════════════
function onPlayerJoined(msg) {
  if (players[msg.name]) return;
  const side = Object.keys(players).length % 2 === 0 ? 'left' : 'right';
  players[msg.name] = { score: 0, avatar: getAvatar(), side };
  renderPlayerList();
  if (phase === 'game') renderSidePanels();
}

function onPlayerLeft(msg) {
  delete players[msg.name];
  renderPlayerList();
  if (phase === 'game') renderSidePanels();
}

function renderPlayerList() {
  const ul = $('playerList');
  ul.innerHTML = '';
  const names = Object.keys(players);
  names.forEach(n => {
    const li = document.createElement('li');
    li.textContent = `${players[n].avatar} ${n}`;
    ul.appendChild(li);
  });
  $('lobbyStatus').textContent = names.length === 0
    ? 'Waiting for players to connect…'
    : `${names.length} player${names.length > 1 ? 's' : ''} ready`;
  $('btnStart').disabled = names.length < 1;
}

// ══════════════════════════════════════════════
//  GAME START
// ══════════════════════════════════════════════
function onGameStart(msg) {
  phase = 'game';
  lives = MAX_LIVES;
  timeLeft = GAME_DURATION;
  balloons = {};
  Object.keys(players).forEach(n => players[n].score = 0);

  showScreen('game');
  setupArena();
  renderSidePanels();
  startTimer();
}

function setupArena() {
  // Place crosshair
  const arena = $('arena');
  const pipe = $('pipe');
  const arenaH = arena.clientHeight;
  const pipeTop = 48; // below HUD
  const pipeH = arenaH - pipeTop;
  crosshairY = pipeTop + pipeH * CROSSHAIR_OFFSET_PERCENT;

  const ch = $('crosshair');
  ch.style.top = (crosshairY - 45) + 'px';

  const zl = $('zoneLight');
  zl.style.top = (crosshairY - 45) + 'px';

  // Add decorative clouds
  arena.querySelectorAll('.arena-cloud').forEach(c => c.remove());
  for (let i = 0; i < 5; i++) {
    const c = document.createElement('div');
    c.className = 'arena-cloud';
    c.style.cssText = `
      width: ${60 + Math.random()*80}px;
      height: ${20 + Math.random()*20}px;
      top: ${10 + Math.random()*30}%;
      left: ${Math.random()*80}%;
      opacity: ${0.4 + Math.random()*0.4};
    `;
    arena.appendChild(c);
  }

  $('waveDisplay').textContent = '1';
  updateHealthBar();
}

function startTimer() {
  clearInterval(timerInterval);
  $('timerDisplay').textContent = formatTime(timeLeft);
  timerInterval = setInterval(() => {
    timeLeft--;
    $('timerDisplay').textContent = formatTime(timeLeft);
    if (timeLeft <= 20) $('timerDisplay').classList.add('urgent');
    if (timeLeft <= 0) {
      clearInterval(timerInterval);
      // server will send game_over, but we stop locally too
    }
  }, 1000);
}

// ══════════════════════════════════════════════
//  SIDE PANELS
// ══════════════════════════════════════════════
function renderSidePanels() {
  const left = $('leftPanel');
  const right = $('rightPanel');
  left.innerHTML = '';
  right.innerHTML = '';

  const names = Object.keys(players);
  names.forEach((name, i) => {
    const p = players[name];
    const card = document.createElement('div');
    card.className = 'player-card';
    card.id = `card-${name}`;
    card.innerHTML = `
      <div class="shoot-indicator" id="si-${name}"></div>
      <div class="avatar">${p.avatar}</div>
      <div class="player-name">${name}</div>
      <div class="player-score" id="score-${name}">${p.score}</div>
    `;
    if (i % 2 === 0) left.appendChild(card);
    else right.appendChild(card);
  });
}

function updatePlayerScore(name) {
  const el = $(`score-${name}`);
  if (el) el.textContent = players[name]?.score ?? 0;
}

// ══════════════════════════════════════════════
//  BALLOONS
// ══════════════════════════════════════════════
function onBalloonSpawn(msg) {
  // msg: { id, type, hp, speed }
  const pipeInner = $('pipeInner');
  const pipeInnerH = pipeInner.clientHeight;

  const el = document.createElement('div');
  el.className = 'balloon';
  el.dataset.type = msg.type;
  el.dataset.id = msg.id;
  el.style.top = '-80px';

  el.innerHTML = `
    <div class="balloon-hp" id="bhp-${msg.id}">${msg.hp}/${msg.hp}</div>
    <div class="balloon-body">${msg.type === 'moab' ? 'M.O.A.B' : ''}</div>
    <div class="balloon-string"></div>
  `;

  pipeInner.appendChild(el);

  balloons[msg.id] = {
    el, type: msg.type,
    hp: msg.hp, maxHp: msg.hp,
    top: -80, speed: msg.speed,
    pipeH: pipeInnerH
  };

  // Animate downward with rAF
  animateBalloon(msg.id);
}

function animateBalloon(id) {
  const b = balloons[id];
  if (!b) return;

  let lastTime = null;

  function frame(ts) {
    if (!balloons[id]) return;
    if (lastTime === null) lastTime = ts;
    const dt = (ts - lastTime) / 1000;
    lastTime = ts;

    b.top += b.speed * dt;
    b.el.style.top = b.top + 'px';

    // Check zone
    const pipeRect = $('pipeInner').getBoundingClientRect();
    const arenaRect = $('arena').getBoundingClientRect();
    const balloonAbsolute = pipeRect.top + b.top + 26 - arenaRect.top;
    const dist = Math.abs(balloonAbsolute - crosshairY);
    b.inZone = dist < ZONE_TOLERANCE_PX;

    // Check escape (past pipe bottom)
    if (b.top > b.pipeH + 80) {
      // Tell server it escaped if still tracked (server is authoritative, but client animates)
      delete balloons[id];
      return;
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

function onZoneUpdate(msg) {
  // msg: { balloon_in_zone: bool }
  balloonInZone = msg.balloon_in_zone;
  const zl = $('zoneLight');
  if (balloonInZone) {
    zl.classList.add('active');
  } else {
    zl.classList.remove('active');
  }
}

function onBalloonHit(msg) {
  // msg: { id, shooter, hp_left, points }
  const b = balloons[msg.id];
  if (!b) return;

  // Flash balloon
  b.el.classList.remove('hit');
  void b.el.offsetWidth;
  b.el.classList.add('hit');
  b.hp = msg.hp_left;

  // Update HP label
  const hpEl = $(`bhp-${msg.id}`);
  if (hpEl) hpEl.textContent = `${msg.hp_left}/${b.maxHp}`;

  // Score popup
  showScorePopup(msg.points, false);

  // Flash shooter card
  flashShooter(msg.shooter);

  // Update score
  if (players[msg.shooter]) {
    players[msg.shooter].score += msg.points;
    updatePlayerScore(msg.shooter);
  }

  // Shoot burst at crosshair
  spawnBurst();
}

function onBalloonPop(msg) {
  // msg: { id, killer, bonus_points, points }
  const b = balloons[msg.id];

  // Pop animation
  if (b) {
    b.el.classList.add('popping');
    setTimeout(() => {
      b.el.remove();
      delete balloons[msg.id];
    }, 400);
  }

  showScorePopup(msg.bonus_points, true);
  flashShooter(msg.killer);

  if (players[msg.killer]) {
    players[msg.killer].score += msg.bonus_points;
    updatePlayerScore(msg.killer);
  }

  spawnBurst();
}

function onBalloonEscaped(msg) {
  // msg: { id, lives_left }
  const b = balloons[msg.id];
  if (b) {
    b.el.remove();
    delete balloons[msg.id];
  }

  lives = msg.lives_left;
  updateHealthBar();

  // Flash arena red
  const arena = $('arena');
  arena.classList.add('escaped');
  setTimeout(() => arena.classList.remove('escaped'), 500);
}

function onShootMiss(msg) {
  // msg: { shooter }
  const pipeInner = $('pipeInner');
  const pipeH = pipeInner.clientHeight;
  const miss = document.createElement('div');
  miss.className = 'miss-text';
  miss.style.top = (crosshairY - 50) + 'px';
  miss.textContent = 'MISS!';
  $('arena').appendChild(miss);
  setTimeout(() => miss.remove(), 800);
}

function onStateSync(msg) {
  // Sync scores, lives, time
  if (msg.scores) {
    Object.entries(msg.scores).forEach(([name, score]) => {
      if (players[name]) {
        players[name].score = score;
        updatePlayerScore(name);
      }
    });
  }
  if (msg.lives !== undefined) {
    lives = msg.lives;
    updateHealthBar();
  }
  if (msg.time_left !== undefined) {
    timeLeft = msg.time_left;
  }
  if (msg.wave !== undefined) {
    $('waveDisplay').textContent = msg.wave;
  }
}

// ══════════════════════════════════════════════
//  GAME OVER
// ══════════════════════════════════════════════
function onGameOver(msg) {
  // msg: { reason, scores: [{name, score}] }
  phase = 'scoring';
  clearInterval(timerInterval);

  // Clear remaining balloons
  Object.values(balloons).forEach(b => b.el?.remove());
  balloons = {};

  $('endReason').textContent = msg.reason === 'time'
    ? '⏱ Time\'s up!' : '💔 Too many balloons escaped!';

  const table = $('scoreTable');
  table.innerHTML = '';

  const sorted = (msg.scores || []).sort((a, b) => b.score - a.score);
  sorted.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'score-row';
    row.style.animationDelay = `${i * 0.1}s`;
    const rankClass = i === 0 ? 'r1' : i === 1 ? 'r2' : i === 2 ? 'r3' : '';
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i+1}`;
    row.innerHTML = `
      <span class="rank-badge ${rankClass}">${medal}</span>
      <span class="avatar" style="width:30px;height:30px;font-size:1rem;">${players[s.name]?.avatar ?? '🎈'}</span>
      <span class="name">${s.name}</span>
      <span class="pts">${s.score} pts</span>
    `;
    table.appendChild(row);
  });

  showScreen('scoring');
}

// ══════════════════════════════════════════════
//  UI HELPERS
// ══════════════════════════════════════════════
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(name).classList.add('active');
}

function updateHealthBar() {
  const pct = Math.max(0, (lives / MAX_LIVES) * 100);
  $('healthBar').style.width = pct + '%';
}

function flashShooter(name) {
  const card = $(`card-${name}`);
  const si = $(`si-${name}`);
  if (card) {
    card.classList.add('shot-flash');
    setTimeout(() => card.classList.remove('shot-flash'), 300);
  }
  if (si) {
    si.classList.add('active');
    setTimeout(() => si.classList.remove('active'), 300);
  }
}

function showScorePopup(pts, isDouble) {
  const pop = document.createElement('div');
  pop.className = 'score-popup' + (isDouble ? ' double' : '');
  pop.style.top = (crosshairY - 30) + 'px';
  pop.textContent = isDouble ? `🎉 +${pts}!` : `+${pts}`;
  $('arena').appendChild(pop);
  setTimeout(() => pop.remove(), 1000);
}

function spawnBurst() {
  const burst = document.createElement('div');
  burst.className = 'shoot-burst';
  const pipeEl = $('pipe');
  const arenaEl = $('arena');
  const pipeRect = pipeEl.getBoundingClientRect();
  const arenaRect = arenaEl.getBoundingClientRect();
  const cx = pipeRect.left + pipeRect.width / 2 - arenaRect.left;
  burst.style.left = cx + 'px';
  burst.style.top = crosshairY + 'px';
  arenaEl.appendChild(burst);
  setTimeout(() => burst.remove(), 400);
}

// ══════════════════════════════════════════════
//  LOBBY CLOUDS (decorative)
// ══════════════════════════════════════════════
function spawnLobbyClouds() {
  const bg = $('lobbyBg');
  for (let i = 0; i < 8; i++) {
    const c = document.createElement('div');
    c.className = 'cloud';
    const size = 60 + Math.random() * 120;
    c.style.cssText = `
      width: ${size}px; height: ${size * 0.4}px;
      top: ${Math.random() * 90}%;
      left: ${-200}px;
      animation-duration: ${12 + Math.random() * 18}s;
      animation-delay: ${-Math.random() * 30}s;
      opacity: ${0.3 + Math.random() * 0.4};
    `;
    bg.appendChild(c);
  }
}

// ══════════════════════════════════════════════
//  BUTTON HANDLERS
// ══════════════════════════════════════════════
$('btnStart').addEventListener('click', () => {
  sendWS({ type: 'start_game' });
});

$('btnRestart').addEventListener('click', () => {
  balloons = {};
  phase = 'lobby';
  // Keep players but reset their scores
  Object.keys(players).forEach(n => players[n].score = 0);
  renderPlayerList();
  showScreen('lobby');
  sendWS({ type: 'reset_game' });
});

// ══════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════
spawnLobbyClouds();
showScreen('lobby');
connect();

// Resize handler to reposition crosshair
window.addEventListener('resize', () => {
  if (phase === 'game') setupArena();
});