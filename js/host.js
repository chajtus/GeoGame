import { haversineKm, calculatePoints } from './scoring.js';
import { createChannel, broadcast } from './game-channel.js';
import { initMap, createAvatarIcon, addPlayerPin, drawPolyline, createTrueLocationMarker } from './map-utils.js';

// ── Helpers ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const show = id => $(id).classList.remove('hidden');
const hide = id => $(id).classList.add('hidden');

// ── Supabase + Session ────────────────────────────────────────────────────
const { createClient } = supabase;
const sb = createClient(window.CONFIG.supabaseUrl, window.CONFIG.supabaseAnonKey);

function generateSessionId() {
  return 'aga-' + Math.random().toString(36).slice(2, 10);
}
const SESSION_ID = generateSessionId();

// ── Questions ─────────────────────────────────────────────────────────────
let questions = [];
async function loadQuestions() {
  const res = await fetch('questions.json');
  questions = await res.json();
  if (questions.length === 0) {
    alert('questions.json jest puste — uruchom najpierw prepare-photos.js!');
  }
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

// ── Init ──────────────────────────────────────────────────────────────────
await loadQuestions();

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

// Create game_state record
await sb.from('game_state').insert({
  session_id: SESSION_ID,
  total_questions: questions.length,
  phase: 'lobby',
  round_duration_seconds: 30,
});

// ── Player list subscription ───────────────────────────────────────────────
sb.channel(`players:${SESSION_ID}`)
  .on('postgres_changes', {
    event: 'INSERT',
    schema: 'public',
    table: 'players',
    filter: `session_id=eq.${SESSION_ID}`,
  }, ({ new: player }) => {
    players.push(player);
    renderPlayerList();
  })
  .subscribe();

function renderPlayerList() {
  $('player-count').textContent = `${players.length} gracz${players.length === 1 ? '' : players.length < 5 ? 'e' : 'y'} dołączyło`;
  $('btn-start').disabled = players.length < 2;

  $('player-list').innerHTML = players.map(p => {
    const avatar = p.avatar_data_url
      ? `<img src="${p.avatar_data_url}" style="width:100%;height:100%;object-fit:cover;">`
      : `<span style="font-size:10px;font-weight:700;color:#fff;">${p.initials}</span>`;
    return `
      <div class="player-chip">
        <div class="avatar-circle" style="background:${p.avatar_color};width:28px;height:28px;font-size:10px;">${avatar}</div>
        <span>${p.name}</span>
      </div>`;
  }).join('');
}

// ── Start game ────────────────────────────────────────────────────────────
$('btn-start').addEventListener('click', async () => {
  $('btn-start').disabled = true;
  // Fetch all players who joined (in case subscription missed some)
  const { data } = await sb.from('players').select('*').eq('session_id', SESSION_ID);
  players = data || players;

  gameChannel = createChannel(sb, SESSION_ID);
  await new Promise(resolve => gameChannel.subscribe(status => {
    if (status === 'SUBSCRIBED') resolve();
  }));

  hide('screen-lobby');
  show('screen-round');
  $('player-total').textContent = players.length;
  startRound(0);
});

// ── Round ─────────────────────────────────────────────────────────────────
async function startRound(index) {
  currentQuestionIndex = index;
  const q = questions[index];
  $('phase-label').textContent = `RUNDA ${index + 1} / ${questions.length}`;
  $('global-stat').textContent = '';

  // Show photo
  $('round-photo').src = q.photo_url;

  const durationMs = 30_000;
  const startedAt = Date.now();

  await broadcast(gameChannel, 'round_start', {
    question_index: index,
    lat: q.lat,
    lng: q.lng,
    started_at: startedAt,
    duration_ms: durationMs,
  });

  $('answer-count-num').textContent = '0';
  startHostTimer(startedAt, durationMs);
  pollAnswerCount(index);
  pollTop5();
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
  } else {
    pausedAt = Date.now();
    paused = true;
    $('btn-pause').textContent = '▶ WZNÓW';
  }
});

$('btn-add-time').addEventListener('click', () => {
  roundDurationMs += 30_000;
});

$('btn-end-round').addEventListener('click', () => {
  clearInterval(timerInterval);
  timerRunning = false;
  endRound();
});

// ── Live answer count ─────────────────────────────────────────────────────
let answerPollInterval = null;
function pollAnswerCount(questionIndex) {
  clearInterval(answerPollInterval);
  answerPollInterval = setInterval(async () => {
    const { count } = await sb.from('pins')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', SESSION_ID)
      .eq('question_index', questionIndex);
    $('answer-count-num').textContent = count || 0;
    $('global-stat').textContent = `${count || 0}/${players.length} odpowiedziało`;
  }, 1500);
}

// ── Live TOP5 ─────────────────────────────────────────────────────────────
let top5PollInterval = null;
function pollTop5() {
  clearInterval(top5PollInterval);
  top5PollInterval = setInterval(async () => {
    const { data } = await sb.from('players')
      .select('name, total_score, avatar_data_url, initials, avatar_color')
      .eq('session_id', SESSION_ID)
      .order('total_score', { ascending: false })
      .limit(5);
    if (!data) return;
    const medals = ['🥇','🥈','🥉','4.','5.'];
    $('top5-list').innerHTML = data.map((p, i) => `
      <div class="top5-row">
        <span>${medals[i]}</span>
        <span style="flex:1;">${p.name}</span>
        <span style="color:var(--primary-light);font-weight:700;">${p.total_score.toLocaleString('pl')}</span>
      </div>`).join('');
  }, 2000);
}

// ── End round ─────────────────────────────────────────────────────────────
async function endRound() {
  clearInterval(answerPollInterval);
  clearInterval(top5PollInterval);
  await broadcast(gameChannel, 'round_end', {});
  await showResults(currentQuestionIndex);
}

// ── Results ───────────────────────────────────────────────────────────────
async function showResults(questionIndex) {
  const q = questions[questionIndex];

  hide('screen-round');
  show('screen-results');
  $('phase-label').textContent = `WYNIKI ${questionIndex + 1}/${questions.length}`;
  $('location-name-text').textContent = q.location_name;
  $('results-file-label').textContent = `📷 Lokalizacja z EXIF GPS`;

  // Determine next action label
  const isLast = questionIndex + 1 >= questions.length;
  const isLeaderboard = (questionIndex + 1) % 5 === 0;
  $('btn-next-question').textContent = isLast
    ? '🏆 WYNIKI KOŃCOWE'
    : isLeaderboard
    ? '🏆 RANKING'
    : `▶ PYTANIE ${questionIndex + 2}`;

  // Init / reset results map
  if (resultsMap) { resultsMap.remove(); resultsMap = null; }
  // Wait for DOM
  await new Promise(r => setTimeout(r, 50));
  resultsMap = initMap('results-map', { center: [q.lat, q.lng], zoom: 4 });

  // True location marker
  createTrueLocationMarker(resultsMap, q.lat, q.lng);

  // Fetch all pins for this question
  const { data: pins } = await sb.from('pins')
    .select('*, players(name, avatar_data_url, initials, avatar_color)')
    .eq('session_id', SESSION_ID)
    .eq('question_index', questionIndex)
    .order('points', { ascending: false });

  if (!pins) return;

  // Render side panel
  $('results-list').innerHTML = pins.map((pin, i) => {
    const p = pin.players;
    const avatar = p.avatar_data_url
      ? `<img src="${p.avatar_data_url}" style="width:100%;height:100%;object-fit:cover;">`
      : `<span style="font-size:9px;font-weight:700;color:#fff;">${p.initials}</span>`;
    const dist = pin.distance_km < 1
      ? `${Math.round(pin.distance_km * 1000)} m`
      : `${Math.round(pin.distance_km).toLocaleString('pl')} km`;
    return `
      <div class="result-row">
        <div class="avatar-circle" style="width:24px;height:24px;background:${p.avatar_color};">${avatar}</div>
        <div style="flex:1;">
          <div>${p.name}</div>
          <div style="color:var(--text-muted);font-size:9px;">${dist}</div>
        </div>
        <div class="pts">+${pin.points.toLocaleString('pl')}</div>
      </div>`;
  }).join('');

  // Fit map to show all pins + true location
  const allLatLngs = [[q.lat, q.lng], ...pins.map(p => [p.lat, p.lng])];
  if (allLatLngs.length > 1) {
    resultsMap.fitBounds(L.latLngBounds(allLatLngs), { padding: [40, 40] });
  }

  // Add player pins + polylines
  pins.forEach(pin => {
    addPlayerPin(resultsMap, pin.players, pin.lat, pin.lng, pin.distance_km);
    drawPolyline(
      resultsMap,
      [pin.lat, pin.lng],
      [q.lat, q.lng],
      pin.players.avatar_color
    );
  });

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

function showLeaderboard(isFinal) { console.log('showLeaderboard stub', isFinal); }
