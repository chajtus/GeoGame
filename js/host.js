import { haversineKm, calculatePoints } from './scoring.js';
import { createChannel, broadcast } from './game-channel.js';
import { initMap, createAvatarIcon, addPlayerPin, drawPolyline, createTrueLocationMarker } from './map-utils.js';

// ── Helpers ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const show = id => $(id).classList.remove('hidden');
const hide = id => $(id).classList.add('hidden');

// ── Session persist (restore on accidental refresh) ───────────────────────
const HOST_STATE_KEY = 'aga_host_state_v1';
const STATE_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours

function saveHostState(patch) {
  try {
    const current = loadHostState() || {};
    localStorage.setItem(HOST_STATE_KEY, JSON.stringify({ ...current, ...patch, savedAt: Date.now() }));
  } catch (_) {}
}

function loadHostState() {
  try {
    const raw = localStorage.getItem(HOST_STATE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw);
    if (Date.now() - (state.savedAt || 0) > STATE_TTL_MS) {
      localStorage.removeItem(HOST_STATE_KEY);
      return null;
    }
    return state;
  } catch (_) { return null; }
}

function clearHostState() {
  localStorage.removeItem(HOST_STATE_KEY);
}

// ── Supabase ──────────────────────────────────────────────────────────────
const { createClient } = supabase;
const sb = createClient(window.CONFIG.supabaseUrl, window.CONFIG.supabaseAnonKey);

function generateSessionId() {
  return 'aga-' + Math.random().toString(36).slice(2, 10);
}

// ── Questions ─────────────────────────────────────────────────────────────
let questions = [];
async function loadQuestions() {
  const res = await fetch('questions.json');
  questions = await res.json();
  if (questions.length === 0) {
    alert('questions.json jest puste — uruchom najpierw prepare-photos.js!');
  }
}

// ── Sync game_state to Supabase (so players can poll after background) ────
function syncGameState(patch) {
  sb.from('game_state').update(patch).eq('session_id', SESSION_ID).then(null, () => null);
}

// ── Game state ─────────────────────────────────────────────────────────────
let gameChannel = null;
let players = [];
let currentQuestionIndex = 0;
let timerInterval = null;
let timerRemaining = 0;
let timerRunning = false;
let prevRankings = [];
let resultsMap = null;
let heartbeatInterval = null;
let lastCountdownSec = -1;
let roundEnding = false;
let roundPayload = null; // module-level so both startRound and restoreHostSession can set it

// ── Init ──────────────────────────────────────────────────────────────────
await loadQuestions();

// Check for saved session (restore after accidental refresh)
const _saved = loadHostState();
const SESSION_ID = _saved?.sessionId ?? generateSessionId();
const _isRestoring = !!(_saved?.sessionId);

const playerUrl = `${location.origin}${location.pathname.replace('host.html', 'player.html')}?session=${SESSION_ID}`;
$('lobby-url').textContent = playerUrl;
$('phase-label').textContent = 'LOBBY';

// QR Code
new QRCode($('qr-code'), {
  text: playerUrl,
  width: 260,
  height: 260,
  colorDark: '#ffffff',
  colorLight: '#0d0d1a',
  correctLevel: QRCode.CorrectLevel.H,
});

// ── Copy link button ──────────────────────────────────────────────────────
$('btn-copy-link').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(playerUrl);
    $('btn-copy-link').textContent = '✅ Skopiowano!';
    setTimeout(() => { $('btn-copy-link').textContent = '📋 Kopiuj link do gry'; }, 2000);
  } catch {
    // Fallback for older browsers
    const ta = document.createElement('textarea');
    ta.value = playerUrl;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    $('btn-copy-link').textContent = '✅ Skopiowano!';
    setTimeout(() => { $('btn-copy-link').textContent = '📋 Kopiuj link do gry'; }, 2000);
  }
});

// ── Kick player (in-game) ─────────────────────────────────────────────────
function openKickModal() {
  const list = $('kick-player-list');
  list.innerHTML = players.map(p => {
    const avatar = p.avatar_data_url
      ? `<img src="${p.avatar_data_url}" style="width:100%;height:100%;object-fit:cover;">`
      : `<span style="font-size:12px;font-weight:700;color:#fff;">${p.initials}</span>`;
    return `<div style="display:flex;align-items:center;gap:10px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:8px 12px;">
      <div class="avatar-circle" style="background:${p.avatar_color};width:32px;height:32px;font-size:12px;">${avatar}</div>
      <span style="flex:1;text-align:left;font-weight:700;">${p.name}</span>
      <button class="btn btn--danger kick-player-btn" data-id="${p.id}" style="font-size:11px;padding:6px 14px;min-width:auto;">Usuń</button>
    </div>`;
  }).join('');

  list.querySelectorAll('.kick-player-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const player = players.find(p => p.id === id);
      if (!player) return;
      btn.textContent = '...';
      btn.disabled = true;
      // Check if kicked player already answered this round
      const hadAnswered = answeredIds.has(id);
      await sb.from('players').delete().eq('id', id).catch(() => null);
      await sb.from('pins').delete().eq('player_id', id).catch(() => null);
      players = players.filter(p => p.id !== id);
      if (hadAnswered) {
        answerCount = Math.max(0, answerCount - 1);
        answeredIds.delete(id);
        answeredNames = answeredNames.filter(n => n !== player.name);
      }
      // Remove from waiting list too
      const wpEl = document.querySelector(`.waiting-player[data-id="${id}"]`);
      if (wpEl) wpEl.remove();
      if (!$('waiting-for-list').children.length) $('waiting-for-panel').classList.add('hidden');
      $('player-total').textContent = players.length;
      $('answer-count-num').textContent = answerCount;
      btn.closest('div[style]').remove();
      // Update stats and auto-end round if all remaining players answered
      // answer count shown only in left panel
      broadcast(gameChannel, 'player_answered', { answered: answerCount, total: players.length }).catch(() => null);
      if (players.length > 0 && answerCount >= players.length) {
        $('kick-modal').style.display = 'none';
        endRound();
      }
    });
  });

  $('kick-modal').style.display = 'flex';
}

$('btn-kick-close').addEventListener('click', () => {
  $('kick-modal').style.display = 'none';
});
$('btn-kick-round').addEventListener('click', openKickModal);
document.querySelectorAll('.btn-kick-ingame').forEach(btn => {
  btn.addEventListener('click', openKickModal);
});

// ── Kill-session button ───────────────────────────────────────────────────
$('btn-kill-session').addEventListener('click', () => {
  $('kill-modal').style.display = 'flex';
});
$('btn-kill-cancel').addEventListener('click', () => {
  $('kill-modal').style.display = 'none';
});
$('btn-kill-confirm').addEventListener('click', async () => {
  $('btn-kill-confirm').textContent = 'Usuwam...';
  $('btn-kill-confirm').disabled = true;
  try {
    // Notify players
    if (gameChannel) await broadcast(gameChannel, 'session_killed', {}).catch(() => null);
    // Wipe session data from DB
    await Promise.all([
      sb.from('pins').delete().eq('session_id', SESSION_ID),
      sb.from('players').delete().eq('session_id', SESSION_ID),
      sb.from('game_state').delete().eq('session_id', SESSION_ID),
    ]);
  } catch (_) {}
  clearHostState();
  location.reload();
});

if (!_isRestoring) {
  // Fresh session — create game_state record
  saveHostState({ sessionId: SESSION_ID, phase: 'lobby' });
  await sb.from('game_state').insert({
    session_id: SESSION_ID,
    total_questions: questions.length,
    phase: 'lobby',
    round_duration_seconds: 30,
  });
}

// Always subscribe to player join events (new joins even during restored session)
subscribeToPlayers();

// Create game channel early so kick broadcasts work from lobby
gameChannel = createChannel(sb, SESSION_ID);
await new Promise(resolve => gameChannel.subscribe(status => {
  if (status === 'SUBSCRIBED') resolve();
}));

// Keepalive — ping every 10s to prevent WebSocket idle disconnect
setInterval(() => {
  broadcast(gameChannel, 'keepalive', {}).catch(() => null);
}, 10_000);

if (_isRestoring) {
  // Re-fetch existing players then jump to the saved screen
  const { data } = await sb.from('players').select('*').eq('session_id', SESSION_ID);
  players = data || [];
  renderPlayerList();
  await restoreHostSession(_saved);
}

// ── Player list subscription ───────────────────────────────────────────────
function subscribeToPlayers() {
  sb.channel(`players:${SESSION_ID}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'players',
      filter: `session_id=eq.${SESSION_ID}`,
    }, ({ new: player }) => {
      // Avoid duplicates (can happen if subscription fires for pre-existing player on restore)
      if (players.find(p => p.id === player.id)) return;
      players.push(player);
      showJoinFlash(player);
      addPlayerChip(player);
      updatePlayerCount();
    })
    .subscribe();
}

let ljfSide = 0; // alternates, but first pick is random
function showJoinFlash(player) {
  // Remove previous flash if still visible
  document.querySelectorAll('.lobby-join-flash').forEach(el => el.remove());
  const side = ljfSide++ % 2 === (Math.random() > 0.5 ? 0 : 1) ? 'ljf-left' : 'ljf-right';
  const avatarInner = player.avatar_data_url
    ? `<img src="${player.avatar_data_url}">`
    : `<span>${player.initials}</span>`;
  const div = document.createElement('div');
  div.className = `lobby-join-flash ${side}`;
  div.innerHTML = `
    <div class="ljf-avatar" style="background:${player.avatar_data_url ? 'transparent' : player.avatar_color}">${avatarInner}</div>
    <div class="ljf-name">${player.name}</div>
    <div class="ljf-label">dołącza do gry</div>
  `;
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 2200);
}

function updatePlayerCount() {
  $('player-count').textContent = `${players.length} gracz${players.length === 1 ? '' : players.length < 5 ? 'e' : 'y'} dołączyło`;
  $('btn-start').disabled = players.length < 2;
  $('btn-start-test').style.display = players.length >= 1 ? 'inline-flex' : 'none';
}

function createChipHtml(p) {
  const avatar = p.avatar_data_url
    ? `<img src="${p.avatar_data_url}" style="width:100%;height:100%;object-fit:cover;">`
    : `<span style="font-size:10px;font-weight:700;color:#fff;">${p.initials}</span>`;
  return `
    <div class="avatar-circle" style="background:${p.avatar_color};width:28px;height:28px;font-size:10px;">${avatar}</div>
    <span>${p.name}</span>
    <button class="btn-kick" data-id="${p.id}" title="Usuń gracza">✕</button>`;
}

function bindKickButton(btn) {
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const id = btn.dataset.id;
    const player = players.find(p => p.id === id);
    if (!player || !confirm(`Usunąć ${player.name} z gry?`)) return;
    await sb.from('players').delete().eq('id', id).catch(() => null);
    players = players.filter(p => p.id !== id);
    const chip = document.querySelector(`.player-chip[data-id="${id}"]`);
    if (chip) chip.remove();
    updatePlayerCount();
  });
}

function addPlayerChip(p) {
  const div = document.createElement('div');
  div.className = 'player-chip';
  div.dataset.id = p.id;
  div.innerHTML = createChipHtml(p);
  $('player-list').appendChild(div);
  bindKickButton(div.querySelector('.btn-kick'));
}

function renderPlayerList() {
  updatePlayerCount();
  $('player-list').innerHTML = '';
  players.forEach(p => addPlayerChip(p));
}

// ── Session restore ───────────────────────────────────────────────────────
async function restoreHostSession(state) {
  if (state.phase === 'lobby') {
    // Already in lobby, players re-fetched — nothing more to do
    showRestoreToast();
    return;
  }

  // gameChannel already created and subscribed at startup

  currentQuestionIndex = state.questionIndex ?? 0;
  $('player-total').textContent = players.length;
  hide('screen-lobby');

  if (state.phase === 'round') {
    const q = questions[state.questionIndex];
    $('round-photo').src = q.photo_url;
    $('phase-label').textContent = `RUNDA ${state.questionIndex + 1} / ${questions.length}`;
    $('answer-count-num').textContent = '0';
    hide('host-countdown-overlay');
    lastCountdownSec = -1;

    // Reconstruct timer from saved values
    roundStartedAt = state.roundStartedAt ?? Date.now();
    roundDurationMs = state.roundDurationMs ?? 30_000;
    extraMs = state.extraMs ?? 0;
    paused = false;

    // Reconstruct heartbeat payload
    roundPayload = {
      question_index: state.questionIndex,
      lat: q.lat, lng: q.lng,
      location_name: q.location_name,
      photo_url: q.photo_url,
      started_at: roundStartedAt - extraMs,
      duration_ms: roundDurationMs,
    };

    // Check if round has already expired during the refresh
    const elapsed = Date.now() - roundStartedAt + extraMs;
    if (elapsed >= roundDurationMs) {
      // Time ran out while refreshing — go straight to results
      show('screen-round'); // needed so hide() in showResults works
      await showResults(state.questionIndex);
    } else {
      show('screen-round');

      // Re-fetch already-answered pins
      const { data: pins } = await sb.from('pins')
        .select('player_id')
        .eq('session_id', SESSION_ID)
        .eq('question_index', state.questionIndex);
      if (pins) {
        answerCount = pins.length;
        answeredNames = pins.map(p => players.find(pl => pl.id === p.player_id)?.name).filter(Boolean);
        $('answer-count-num').textContent = answerCount;
        // answer count shown only in left panel
      }

      // Resume heartbeat
      clearInterval(heartbeatInterval);
      heartbeatInterval = setInterval(() => {
        const effectiveStartedAt = roundStartedAt - extraMs;
        if (roundPayload.started_at !== effectiveStartedAt || roundPayload.duration_ms !== roundDurationMs) {
          roundPayload = { ...roundPayload, started_at: effectiveStartedAt, duration_ms: roundDurationMs };
        }
        broadcast(gameChannel, 'round_heartbeat', roundPayload).catch(() => null);
        saveHostState({ roundStartedAt, roundDurationMs, extraMs });
      }, 2000);

      // Resume timer
      roundEnding = false;
      timerRunning = true;
      clearInterval(timerInterval);
      timerInterval = setInterval(tickTimer, 100);
      subscribeAnswerCount(state.questionIndex);
      refreshTop5();
    }
  } else if (state.phase === 'results') {
    show('screen-round'); // so hide() in showResults works cleanly
    await showResults(state.questionIndex);
  } else if (state.phase === 'leaderboard') {
    await showLeaderboard(state.isFinal ?? false);
  }

  showRestoreToast();
}

function showRestoreToast() {
  const toast = $('restore-toast');
  if (!toast) return;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 3500);
}

// ── Start game ────────────────────────────────────────────────────────────
async function startGame() {
  $('btn-start').disabled = true;
  $('btn-start-test').disabled = true;
  const { data } = await sb.from('players').select('*').eq('session_id', SESSION_ID);
  players = data || players;

  hide('screen-lobby');
  show('screen-round');
  $('player-total').textContent = players.length;
  startRound(0);
}

$('btn-start').addEventListener('click', startGame);
$('btn-start-test').addEventListener('click', startGame);

// ── Round ─────────────────────────────────────────────────────────────────
async function startRound(index) {
  roundEnding = false;
  currentQuestionIndex = index;
  const q = questions[index];
  const isPremium = !!q.premium;
  $('phase-label').textContent = `RUNDA ${index + 1} / ${questions.length}${isPremium ? ' ⭐ PREMIUM' : ''}`;

  // Show photo first (so premium overlay appears on new photo, not old one)
  $('round-photo').src = q.photo_url;

  // Premium announcement — overlay on top of new photo for 3s
  if (isPremium) {
    $('premium-overlay').classList.remove('hidden');
    await new Promise(r => setTimeout(r, 3000));
    $('premium-overlay').classList.add('hidden');
  }

  const durationMs = 30_000;
  const startedAt = Date.now();

  // Module-level — shared with restore path and heartbeat
  roundPayload = {
    question_index: index,
    lat: q.lat,
    lng: q.lng,
    location_name: q.location_name,
    photo_url: q.photo_url,
    started_at: startedAt,
    duration_ms: durationMs,
    premium: isPremium,
  };

  await broadcast(gameChannel, 'round_start', roundPayload);

  // Save state for restore-on-refresh
  saveHostState({ phase: 'round', questionIndex: index, roundStartedAt: startedAt, roundDurationMs: durationMs, extraMs: 0 });
  syncGameState({ phase: 'round', current_question: index, round_started_at: new Date(startedAt).toISOString(), round_duration_seconds: Math.round(durationMs / 1000) });

  // Heartbeat every 2s — catches players who missed round_start (e.g. page refresh)
  // Also saves current timer state so host can restore after their own refresh
  clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    const effectiveStartedAt = roundStartedAt - extraMs;
    if (roundPayload.started_at !== effectiveStartedAt || roundPayload.duration_ms !== roundDurationMs) {
      roundPayload = { ...roundPayload, started_at: effectiveStartedAt, duration_ms: roundDurationMs };
    }
    broadcast(gameChannel, 'round_heartbeat', roundPayload).catch(() => null);
    saveHostState({ roundStartedAt, roundDurationMs, extraMs });
  }, 2000);

  $('answer-count-num').textContent = '0';
  $('top5-list').innerHTML = '<div style="color:var(--text-muted);font-size:11px;text-align:center;padding:8px 0;">Brak danych z poprzednich rund</div>';
  hide('host-countdown-overlay');
  lastCountdownSec = -1;
  startHostTimer(startedAt, durationMs);
  subscribeAnswerCount(index);
  refreshTop5(); // Show scores from previous rounds immediately
}

// ── Host timer ────────────────────────────────────────────────────────────
let roundStartedAt = 0;
let roundDurationMs = 30_000;
let extraMs = 0;
let paused = false;
let pausedAt = 0;

function startHostTimer(startedAt, durationMs) {
  roundStartedAt = startedAt;
  roundDurationMs = durationMs;
  extraMs = 0;
  paused = false;
  timerRunning = true;
  clearInterval(timerInterval);
  timerInterval = setInterval(tickTimer, 100);
}

function tickTimer() {
  if (paused) return;
  const elapsed = Date.now() - roundStartedAt + extraMs;
  const remaining = Math.max(0, roundDurationMs - elapsed);
  const secs = Math.ceil(remaining / 1000);
  const mins = Math.floor(secs / 60);
  const s = secs % 60;
  $('host-timer-display').textContent = `${mins}:${String(s).padStart(2,'0')}`;
  const pct = (remaining / roundDurationMs) * 100;
  $('timer-bar').style.width = `${pct}%`;
  $('timer-bar').style.background = secs <= 10
    ? 'linear-gradient(90deg,#f44336,#ff5722)'
    : 'linear-gradient(90deg,var(--primary),var(--primary-light))';

  // Countdown overlay 5-4-3-2-1
  if (secs <= 5 && secs > 0 && remaining > 0) {
    if (secs !== lastCountdownSec) {
      lastCountdownSec = secs;
      const el = $('host-countdown-number');
      el.textContent = secs;
      el.classList.remove('countdown-num');
      void el.offsetWidth; // reflow to restart animation
      el.classList.add('countdown-num');
    }
    show('host-countdown-overlay');
  } else {
    hide('host-countdown-overlay');
    if (remaining > 0) lastCountdownSec = -1;
  }

  if (remaining <= 0) {
    clearInterval(timerInterval);
    timerRunning = false;
    endRound();
  }
}

$('btn-pause').addEventListener('click', () => {
  if (!timerRunning) return;
  if (paused) {
    extraMs -= (Date.now() - pausedAt);
    paused = false;
    $('btn-pause').textContent = '⏸ PAUZA';
    broadcast(gameChannel, 'round_resumed', {
      started_at: roundStartedAt - extraMs,
      duration_ms: roundDurationMs,
    }).catch(() => null);
    saveHostState({ roundStartedAt, roundDurationMs, extraMs });
  } else {
    pausedAt = Date.now();
    paused = true;
    $('btn-pause').textContent = '▶ WZNÓW';
    broadcast(gameChannel, 'round_paused', {}).catch(() => null);
    saveHostState({ roundStartedAt, roundDurationMs, extraMs });
  }
});

$('btn-add-time').addEventListener('click', () => {
  roundDurationMs += 5_000;
  broadcast(gameChannel, 'time_extended', {
    started_at: roundStartedAt - extraMs,
    duration_ms: roundDurationMs,
  }).catch(() => null);
  saveHostState({ roundDurationMs });
});

$('btn-end-round').addEventListener('click', () => {
  clearInterval(timerInterval);
  timerRunning = false;
  endRound();
});

// ── Live answer count (Realtime) ──────────────────────────────────────────
let answerChannel = null;
let answerCount = 0;
let answeredNames = [];

function renderWaitingList() {
  const list = $('waiting-for-list');
  const waiting = players.filter(p => !answeredIds.has(p.id));
  if (waiting.length === 0) {
    $('waiting-for-panel').classList.add('hidden');
    return;
  }
  $('waiting-for-panel').classList.remove('hidden');
  list.innerHTML = waiting.map(p => {
    const avatarInner = p.avatar_data_url
      ? `<img src="${p.avatar_data_url}">`
      : `<span>${p.initials}</span>`;
    return `<div class="waiting-player" data-id="${p.id}">
      <div class="wp-avatar" style="background:${p.avatar_data_url ? 'transparent' : p.avatar_color}">${avatarInner}</div>
      <span class="wp-name">${p.name}</span>
    </div>`;
  }).join('');
}

let answeredIds = new Set();

function subscribeAnswerCount(questionIndex) {
  if (answerChannel) { answerChannel.unsubscribe(); answerChannel = null; }
  answerCount = 0;
  answeredNames = [];
  answeredIds = new Set();
  $('answer-count-num').textContent = '0';
  // answer count shown only in left panel
  renderWaitingList();

  answerChannel = sb.channel(`pins:${SESSION_ID}:${questionIndex}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'pins',
      filter: `session_id=eq.${SESSION_ID}`,
    }, ({ new: pin }) => {
      if (pin.question_index !== questionIndex) return;
      answerCount++;
      answeredIds.add(pin.player_id);
      const numEl = $('answer-count-num');
      numEl.textContent = answerCount;
      numEl.classList.remove('count-pop-anim');
      void numEl.offsetWidth;
      numEl.classList.add('count-pop-anim');
      // answer count shown only in left panel
      const player = players.find(p => p.id === pin.player_id);
      if (player) {
        answeredNames.push(player.name);
      }
      // Animate out the answered player from waiting list
      const wpEl = document.querySelector(`.waiting-player[data-id="${pin.player_id}"]`);
      if (wpEl) {
        wpEl.classList.add('answered');
        setTimeout(() => { wpEl.remove(); if (!$('waiting-for-list').children.length) $('waiting-for-panel').classList.add('hidden'); }, 400);
      }
      broadcast(gameChannel, 'player_answered', { answered: answerCount, total: players.length }).catch(() => null);
      // Auto-end round when everyone has answered
      if (players.length > 0 && answerCount >= players.length) {
        endRound();
      }
    })
    .subscribe();
}

// ── TOP5 — computed from pins (no RPC dependency) ─────────────────────────
async function refreshTop5() {
  const [{ data: pls }, { data: pins }] = await Promise.all([
    sb.from('players').select('id, name, total_score, avatar_data_url, initials, avatar_color').eq('session_id', SESSION_ID),
    sb.from('pins').select('player_id, points').eq('session_id', SESSION_ID),
  ]);
  if (!pls) return;
  const byPlayer = {};
  (pins || []).forEach(p => { byPlayer[p.player_id] = (byPlayer[p.player_id] || 0) + (p.points || 0); });
  const top5 = pls
    .map(p => ({ ...p, score: byPlayer[p.id] || 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  const medals = ['🥇','🥈','🥉','4.','5.'];
  $('top5-list').innerHTML = top5.map((p, i) => `
    <div class="top5-row" style="animation-delay:${i * 0.06}s;">
      <span>${medals[i]}</span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.name}</span>
      <span style="color:var(--primary-light);font-weight:700;">${p.score.toLocaleString('pl')}</span>
    </div>`).join('');
}

// ── End round ─────────────────────────────────────────────────────────────
async function endRound() {
  if (roundEnding) return;
  roundEnding = true;
  clearInterval(timerInterval);
  timerRunning = false;
  clearInterval(heartbeatInterval);
  hide('host-countdown-overlay');
  $('waiting-for-panel').classList.add('hidden');
  if (answerChannel) { answerChannel.unsubscribe(); answerChannel = null; }
  // Broadcast with 2s timeout — showResults must always run even on network hiccup
  await Promise.race([
    broadcast(gameChannel, 'round_end', {}).catch(() => null),
    new Promise(r => setTimeout(r, 2000)),
  ]);
  await showResults(currentQuestionIndex);
}

// ── Results ───────────────────────────────────────────────────────────────
async function showResults(questionIndex) {
  saveHostState({ phase: 'results', questionIndex });
  syncGameState({ phase: 'results', current_question: questionIndex });

  const q = questions[questionIndex];

  hide('screen-round');
  show('screen-results');
  $('phase-label').textContent = `WYNIKI ${questionIndex + 1}/${questions.length}`;
  $('location-name-text').textContent = q.location_name;
  $('results-file-label').textContent = `📷 Lokalizacja z EXIF GPS`;

  // Determine next action label
  const isLast = questionIndex + 1 >= questions.length;
  const halfwayIndex = Math.floor(questions.length / 2) - 1;
  const isLeaderboard = questionIndex === halfwayIndex;
  $('btn-next-question').textContent = isLast
    ? '🏆 WYNIKI KOŃCOWE'
    : isLeaderboard
    ? '🏆 RANKING'
    : `▶ PYTANIE ${questionIndex + 2}`;

  // Show question photo thumbnail in side panel
  const thumb = $('results-photo-thumb');
  thumb.src = q.photo_url;
  thumb.style.display = 'block';

  // Show loading state while fetching
  $('results-list').innerHTML = `<div style="color:var(--text-muted);font-size:12px;text-align:center;padding:16px;">Ładowanie wyników...</div>`;

  // Init / reset results map
  if (resultsMap) { resultsMap.remove(); resultsMap = null; }
  await new Promise(r => setTimeout(r, 200));
  resultsMap = initMap('results-map', { center: [q.lat, q.lng], zoom: 4, skipTiles: true });

  // Layer control with 2 base maps (no CARTO — requires API key)
  const osm = L.tileLayer(window.CONFIG.mapTileUrl, {
    attribution: window.CONFIG.mapAttribution, subdomains: window.CONFIG.mapTileSubdomains, maxZoom: 19,
  }).addTo(resultsMap);
  const satellite = L.tileLayer('https://api.maptiler.com/maps/satellite/256/{z}/{x}/{y}@2x.jpg?key=08XhqhteQR7440peDz9Y', {
    attribution: '© MapTiler © OpenStreetMap', maxZoom: 19,
  });
  L.control.layers({ 'Mapa': osm, 'Satelita': satellite }, {}, { position: 'topleft' }).addTo(resultsMap);

  setTimeout(() => resultsMap.invalidateSize(), 100);
  setTimeout(() => resultsMap.invalidateSize(), 350);
  setTimeout(() => resultsMap.invalidateSize(), 700);

  // True location marker
  createTrueLocationMarker(resultsMap, q.lat, q.lng);

  // Fetch all pins for this question
  const { data: pins } = await sb.from('pins')
    .select('*, players(name, avatar_data_url, initials, avatar_color)')
    .eq('session_id', SESSION_ID)
    .eq('question_index', questionIndex)
    .order('points', { ascending: false });

  if (!pins) return;

  // Render side panel — top 5 only
  const shown = pins.slice(0, 5);
  const rest = pins.length - shown.length;
  $('results-list').innerHTML = shown.map((pin, i) => {
    const p = pin.players;
    const avatar = p.avatar_data_url
      ? `<img src="${p.avatar_data_url}" style="width:100%;height:100%;object-fit:cover;">`
      : `<span style="font-size:22px;font-weight:700;color:#fff;">${p.initials}</span>`;
    const dist = pin.distance_km < 1
      ? `${Math.round(pin.distance_km * 1000)} m`
      : `${Math.round(pin.distance_km).toLocaleString('pl')} km`;
    return `
      <div class="result-row" style="animation-delay:${i * 0.05}s;">
        <div class="avatar-circle" style="width:72px;height:72px;background:${p.avatar_color};flex-shrink:0;">${avatar}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.name}</div>
          <div class="dist-label" style="font-size:16px;">${dist} w linii prostej</div>
        </div>
        <div class="pts">+${pin.points.toLocaleString('pl')}</div>
      </div>`;
  }).join('') + (rest > 0
    ? `<div style="text-align:center;color:var(--text-muted);font-size:13px;padding:10px 0;">+ ${rest} pozostałych graczy</div>`
    : '');

  // Add player pins + polylines
  pins.forEach(pin => {
    addPlayerPin(resultsMap, pin.players, pin.lat, pin.lng, pin.distance_km);
    drawPolyline(resultsMap, [pin.lat, pin.lng], [q.lat, q.lng], pin.players.avatar_color, pin.distance_km);
  });

  // Fit map after invalidateSize settles
  const allLatLngs = [[q.lat, q.lng], ...pins.map(p => [p.lat, p.lng])];
  setTimeout(() => {
    resultsMap.invalidateSize();
    if (allLatLngs.length > 1) {
      resultsMap.fitBounds(L.latLngBounds(allLatLngs), { padding: [60, 60] });
    }
  }, 400);

  // Next question button
  $('btn-next-question').onclick = () => {
    hide('screen-results');
    if (isLast) {
      showLeaderboard(true);
    } else if (isLeaderboard) {
      showLeaderboard(false);
    } else {
      show('screen-round');
      startRound(questionIndex + 1);
    }
  };
}

// ── Leaderboard ───────────────────────────────────────────────────────────
async function showLeaderboard(isFinal) {
  saveHostState({ phase: 'leaderboard', questionIndex: currentQuestionIndex, isFinal });
  syncGameState({ phase: isFinal ? 'final' : 'leaderboard', current_question: currentQuestionIndex });

  await broadcast(gameChannel, 'show_leaderboard', { isFinal });

  const [{ data: playersData }, { data: pinsData }] = await Promise.all([
    sb.from('players').select('*').eq('session_id', SESSION_ID),
    sb.from('pins').select('player_id, points').eq('session_id', SESSION_ID),
  ]);

  if (!playersData) return;

  const byPlayer = {};
  (pinsData || []).forEach(p => { byPlayer[p.player_id] = (byPlayer[p.player_id] || 0) + (p.points || 0); });
  const ranked = playersData
    .map(p => ({ ...p, total_score: byPlayer[p.id] || 0 }))
    .sort((a, b) => b.total_score - a.total_score);

  if (!ranked.length) return;

  hide('screen-results');
  hide('screen-round');
  show('screen-leaderboard');
  $('phase-label').textContent = isFinal ? 'WYNIKI KOŃCOWE' : 'RANKING';

  const nextQ = currentQuestionIndex + 1;
  $('lb-title').textContent = isFinal ? 'WYNIKI KOŃCOWE 🏆' : 'RANKING HALF TIME ⏱';
  $('lb-subtitle').textContent = isFinal
    ? 'Dziękujemy za grę!'
    : `Jeszcze ${questions.length - nextQ} pytań do końca.`;

  // Compute position changes
  const posMap = {};
  prevRankings.forEach((p, i) => { posMap[p.id] = i + 1; });

  // Always table (no podium) — podium only in finale
  $('podium').style.display = 'none';
  $('lb-rest').style.maxWidth = isFinal ? '840px' : '840px';
  $('lb-rest').style.margin = '0 auto';

  // Floating quotes — only on final results
  if (window._quoteInterval) { clearInterval(window._quoteInterval); window._quoteInterval = null; }
  const ql = $('lb-quote-left');
  const qr = $('lb-quote-right');
  if (isFinal) {
    const QUOTES = [
      { text: 'Jeżeli przegrałeś to jesteś parówą.', author: 'Mirosław Smrut' },
      { text: 'Geografia to nie jest sprint, to jest maraton... który przegrałeś.', author: 'Jan Geograf Kowalski' },
      { text: 'Kto nie umie znaleźć Agnieszki, ten nie znajdzie szczęścia w życiu.', author: 'Konfucjusz (prawie)' },
      { text: 'Najważniejsze to nie wygrać, ale sprawić żeby inni przegrali.', author: 'Sun Tzu, chyba' },
      { text: 'Mapy kłamią, ale wyniki nie.', author: 'Aleksander Wielki' },
      { text: 'Ziemia jest okrągła, ale Twój wynik jest płaski.', author: 'Kopernik 2.0' },
      { text: 'Nie liczy się czy wygrasz, liczy się ile osób za Tobą.', author: 'Filosopher69' },
      { text: 'Każda porażka to lekcja geografii.', author: 'Prof. Przegryw' },
      { text: 'Stalking to sztuka, a Wy jesteście artystami.', author: 'FBI Agent #42' },
      { text: 'Nie chodzi o to gdzie jesteś, ale gdzie Aga była.', author: 'Budda (po polsku)' },
      { text: 'GPS to wymysł ludzi, którzy nie potrafią czytać map.', author: 'Mój dziadek' },
      { text: 'Przegrywasz? To znaczy że żyjesz. Jak parówka.', author: 'Mirosław Smrut' },
    ];
    const shuffled = [...QUOTES].sort(() => Math.random() - 0.5);
    let idx = 0;
    const showQuote = (el, q) => {
      el.innerHTML = `"${q.text}"<span class="quote-author">— ${q.author}</span>`;
      el.classList.add('quote-visible');
      setTimeout(() => el.classList.remove('quote-visible'), 4000);
    };
    // Show first pair immediately
    showQuote(ql, shuffled[0]);
    setTimeout(() => showQuote(qr, shuffled[1 % shuffled.length]), 1500);
    idx = 2;
    // Cycle every 5s
    window._quoteInterval = setInterval(() => {
      showQuote(ql, shuffled[idx % shuffled.length]);
      idx++;
      setTimeout(() => {
        showQuote(qr, shuffled[idx % shuffled.length]);
        idx++;
      }, 1500);
    }, 5000);
  } else {
    ql.classList.remove('quote-visible');
    qr.classList.remove('quote-visible');
    ql.innerHTML = '';
    qr.innerHTML = '';
  }

  const LB_MAX = 30;
  const lbShown = ranked.slice(0, LB_MAX);
  $('lb-rest').innerHTML = lbShown.map((p, i) => {
    const rank = i + 1;
    const rowDelay = `${(i * 0.04).toFixed(2)}s`;
    const medalHtml = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}.`;
    const rankClass = rank === 1 ? 'rank-gold' : rank === 2 ? 'rank-silver' : rank === 3 ? 'rank-bronze' : '';
    const prev = posMap[p.id];
    const change = prev ? prev - rank : 0;
    const changeHtml = !isFinal && prev
      ? change > 0
        ? `<span class="lb-change up">▲${change}</span>`
        : change < 0
        ? `<span class="lb-change down">▼${Math.abs(change)}</span>`
        : `<span class="lb-change" style="color:var(--text-muted)">—</span>`
      : '';
    const avatarContent = p.avatar_data_url
      ? `<img src="${p.avatar_data_url}" style="width:100%;height:100%;object-fit:cover;">`
      : `<span style="font-size:16px;font-weight:700;color:#fff;">${p.initials}</span>`;
    return `
      <div class="lb-row ${rankClass}" style="animation-delay:${rowDelay};">
        <span class="lb-rank">${medalHtml}</span>
        <div class="avatar-circle" style="width:48px;height:48px;background:${p.avatar_color};font-size:16px;">${avatarContent}</div>
        <span style="flex:1;font-size:20px;font-weight:700;">${p.name}</span>
        <span class="lb-pts">${p.total_score.toLocaleString('pl')}</span>
        ${changeHtml}
      </div>`;
  }).join('');

  prevRankings = ranked;

  if (isFinal) {
    $('btn-after-lb').textContent = '🏆 FINAŁ';
    $('btn-after-lb').onclick = () => showFinale(ranked);
  } else {
    $('btn-after-lb').textContent = `▶ PYTANIE ${currentQuestionIndex + 2}`;
    $('btn-after-lb').onclick = () => {
      hide('screen-leaderboard');
      show('screen-round');
      startRound(currentQuestionIndex + 1);
    };
  }
}

// ── Finale — podium + Majusia video ──────────────────────────────────────
async function showFinale(ranked) {
  clearHostState(); // Game over — clear restore state

  hide('screen-leaderboard');
  show('screen-finale');
  $('phase-label').textContent = '🏆 FINAŁ';

  // Video
  const videoEl = $('finale-video');
  videoEl.src = 'assets/maja.mp4';
  const { data: { publicUrl } } = sb.storage.from('photos').getPublicUrl('maja.mp4');
  if (publicUrl) videoEl.src = publicUrl;
  videoEl.play().catch(() => null);

  // Confetti burst
  const burst = () => confetti({
    particleCount: 180,
    spread: 100,
    origin: { y: 0.4 },
    colors: ['#ff79c6', '#9c27b0', '#e91e8c', '#ffffff', '#ffd700'],
  });
  burst();
  setTimeout(burst, 800);
  setTimeout(burst, 1600);

  // Podium (TOP 3)
  const podiumData = [
    { player: ranked[1], rank: 2, height: 80,  barW: 110, color: 'var(--silver)', avatarSize: 78,  namePx: 15, scorePx: 18, barPx: 36 },
    { player: ranked[0], rank: 1, height: 115, barW: 130, color: 'var(--gold)',   avatarSize: 100, namePx: 18, scorePx: 22, barPx: 44, crown: true },
    { player: ranked[2], rank: 3, height: 55,  barW: 100, color: 'var(--bronze)', avatarSize: 70,  namePx: 14, scorePx: 16, barPx: 32 },
  ].filter(d => d.player);

  $('finale-lb-wrap').innerHTML = `
    <div style="display:flex;justify-content:center;align-items:flex-end;gap:28px;padding:16px 40px 0;">
      ${podiumData.map(({ player: p, rank, height, barW, color, avatarSize, namePx, scorePx, barPx, crown }) => {
        const avatarContent = p.avatar_data_url
          ? `<img src="${p.avatar_data_url}" style="width:100%;height:100%;object-fit:cover;">`
          : `<span style="font-size:${Math.round(avatarSize * 0.38)}px;font-weight:700;color:#fff;">${p.initials}</span>`;
        return `
          <div class="podium-place">
            ${crown ? '<div class="podium-crown">👑</div>' : '<div style="height:36px;"></div>'}
            <div class="podium-avatar" style="width:${avatarSize}px;height:${avatarSize}px;border:4px solid ${color};background:${p.avatar_color};box-shadow:0 0 28px ${color}66,0 0 60px ${color}22;">
              ${avatarContent}
            </div>
            <div class="podium-name" style="color:${color};font-size:${namePx}px;max-width:${barW + 10}px;">${p.name}</div>
            <div class="podium-score" style="color:${color};font-size:${scorePx}px;">${p.total_score.toLocaleString('pl')} pkt</div>
            <div class="podium-bar" style="height:${height}px;width:${barW}px;background:${color};font-size:${barPx}px;animation-delay:${rank === 2 ? '0.05s' : rank === 1 ? '0.2s' : '0.35s'};">${rank}</div>
          </div>`;
      }).join('')}
    </div>
    <div style="text-align:center;color:var(--text-muted);font-size:16px;padding:12px 0;">Brawo! 🎂 Sto lat Aga! 🎂</div>
  `;
}
