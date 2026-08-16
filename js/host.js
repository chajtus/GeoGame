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
let heartbeatInterval = null;
let lastCountdownSec = -1;
let roundEnding = false;

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
  $('btn-start-test').style.display = players.length >= 1 ? 'inline-flex' : 'none';

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
async function startGame() {
  $('btn-start').disabled = true;
  $('btn-start-test').disabled = true;
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
}

$('btn-start').addEventListener('click', startGame);
$('btn-start-test').addEventListener('click', startGame);

// ── Round ─────────────────────────────────────────────────────────────────
async function startRound(index) {
  roundEnding = false;
  currentQuestionIndex = index;
  const q = questions[index];
  $('phase-label').textContent = `RUNDA ${index + 1} / ${questions.length}`;
  $('global-stat').textContent = '';

  // Show photo
  $('round-photo').src = q.photo_url;

  const durationMs = 30_000;
  const startedAt = Date.now();

  const roundPayload = {
    question_index: index,
    lat: q.lat,
    lng: q.lng,
    location_name: q.location_name,
    photo_url: q.photo_url,
    started_at: startedAt,
    duration_ms: durationMs,
  };

  await broadcast(gameChannel, 'round_start', roundPayload);

  // Heartbeat every 5s — catches players who missed round_start (e.g. channel reconnect)
  clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    broadcast(gameChannel, 'round_heartbeat', roundPayload).catch(() => null);
  }, 5000);

  $('answer-count-num').textContent = '0';
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
    // Tell players new effective start (accounts for pause duration)
    broadcast(gameChannel, 'round_resumed', {
      started_at: roundStartedAt - extraMs,
      duration_ms: roundDurationMs,
    }).catch(() => null);
  } else {
    pausedAt = Date.now();
    paused = true;
    $('btn-pause').textContent = '▶ WZNÓW';
    broadcast(gameChannel, 'round_paused', {}).catch(() => null);
  }
});

$('btn-add-time').addEventListener('click', () => {
  roundDurationMs += 5_000;
  // Tell players about new duration; adjusted start compensates for pauses
  broadcast(gameChannel, 'time_extended', {
    started_at: roundStartedAt - extraMs,
    duration_ms: roundDurationMs,
  }).catch(() => null);
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

function subscribeAnswerCount(questionIndex) {
  if (answerChannel) { answerChannel.unsubscribe(); answerChannel = null; }
  answerCount = 0;
  answeredNames = [];
  $('answer-count-num').textContent = '0';
  $('global-stat').textContent = `0/${players.length} odpowiedziało`;
  $('answered-names').textContent = '';

  answerChannel = sb.channel(`pins:${SESSION_ID}:${questionIndex}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'pins',
      filter: `session_id=eq.${SESSION_ID}`,
    }, ({ new: pin }) => {
      if (pin.question_index !== questionIndex) return;
      answerCount++;
      $('answer-count-num').textContent = answerCount;
      $('global-stat').textContent = `${answerCount}/${players.length} odpowiedziało`;
      const player = players.find(p => p.id === pin.player_id);
      if (player) {
        answeredNames.push(player.name);
        $('answered-names').textContent = answeredNames.join(' · ');
      }
      refreshTop5();
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
    <div class="top5-row">
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

  // Show question photo thumbnail in side panel
  const thumb = $('results-photo-thumb');
  thumb.src = q.photo_url;
  thumb.style.display = 'block';

  // Init / reset results map
  if (resultsMap) { resultsMap.remove(); resultsMap = null; }
  // Wait for DOM to render the visible container
  await new Promise(r => setTimeout(r, 120));
  resultsMap = initMap('results-map', { center: [q.lat, q.lng], zoom: 4, skipTiles: true });

  // Layer control with 3 base maps
  const voyager = L.tileLayer(window.CONFIG.mapTileUrl, {
    attribution: window.CONFIG.mapAttribution, subdomains: 'abcd', maxZoom: 19,
  }).addTo(resultsMap);
  const dark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap © CARTO', subdomains: 'abcd', maxZoom: 19,
  });
  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors', maxZoom: 19,
  });
  L.control.layers({ 'Kolorowa': voyager, 'Ciemna': dark, 'OSM': osm }, {}, { position: 'topleft' }).addTo(resultsMap);

  setTimeout(() => resultsMap.invalidateSize(), 100);

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
      : `<span style="font-size:11px;font-weight:700;color:#fff;">${p.initials}</span>`;
    const dist = pin.distance_km < 1
      ? `${Math.round(pin.distance_km * 1000)} m`
      : `${Math.round(pin.distance_km).toLocaleString('pl')} km`;
    return `
      <div class="result-row">
        <div class="avatar-circle" style="width:36px;height:36px;background:${p.avatar_color};flex-shrink:0;">${avatar}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.name}</div>
          <div class="dist-label">${dist} w linii prostej</div>
        </div>
        <div class="pts">+${pin.points.toLocaleString('pl')}</div>
      </div>`;
  }).join('');

  // Fit map to show all pins + true location
  const allLatLngs = [[q.lat, q.lng], ...pins.map(p => [p.lat, p.lng])];
  if (allLatLngs.length > 1) {
    resultsMap.fitBounds(L.latLngBounds(allLatLngs), { padding: [40, 40] });
  }

  // Add player pins + polylines + km labels
  pins.forEach(pin => {
    addPlayerPin(resultsMap, pin.players, pin.lat, pin.lng, pin.distance_km);
    drawPolyline(resultsMap, [pin.lat, pin.lng], [q.lat, q.lng], pin.players.avatar_color);

    // Distance label at midpoint of line
    const midLat = (pin.lat + q.lat) / 2;
    const midLng = (pin.lng + q.lng) / 2;
    const distKm = pin.distance_km < 1
      ? `${Math.round(pin.distance_km * 1000)} m`
      : `${Math.round(pin.distance_km)} km`;
    L.marker([midLat, midLng], {
      icon: L.divIcon({
        html: `<div style="background:#fff;color:#111;padding:3px 8px;border-radius:6px;font-size:10px;font-weight:800;white-space:nowrap;box-shadow:0 1px 6px rgba(0,0,0,0.35);border:1px solid rgba(0,0,0,0.12);">${distKm}</div>`,
        className: '',
        iconAnchor: [22, 10],
      }),
      interactive: false,
    }).addTo(resultsMap);
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

// ── Leaderboard ───────────────────────────────────────────────────────────
async function showLeaderboard(isFinal) {
  await broadcast(gameChannel, 'show_leaderboard', {});

  // Compute total scores directly from pins — reliable, no RPC dependency
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

  const nextQ = currentQuestionIndex + 1;
  $('lb-title').textContent = isFinal ? 'WYNIKI KOŃCOWE 🏆' : `RANKING PO PYTANIU ${nextQ} / ${questions.length}`;
  $('lb-subtitle').textContent = isFinal
    ? 'Dziękujemy za grę!'
    : nextQ % questions.length === 0
    ? 'Ostatni sprint!'
    : `Jeszcze ${questions.length - nextQ} pytań do końca.`;

  // Compute position changes
  const posMap = {};
  prevRankings.forEach((p, i) => { posMap[p.id] = i + 1; });

  // Podium (TOP 3)
  const podiumData = [
    { player: ranked[1], rank: 2, height: 55, color: 'var(--silver)', avatarSize: 54 },
    { player: ranked[0], rank: 1, height: 75, color: 'var(--gold)', avatarSize: 66, crown: true },
    { player: ranked[2], rank: 3, height: 42, color: 'var(--bronze)', avatarSize: 54 },
  ].filter(d => d.player);

  $('podium').innerHTML = podiumData.map(({ player: p, rank, height, color, avatarSize, crown }) => {
    const avatarContent = p.avatar_data_url
      ? `<img src="${p.avatar_data_url}" style="width:100%;height:100%;object-fit:cover;">`
      : `<span style="font-size:${avatarSize * 0.38}px;font-weight:700;color:#fff;">${p.initials}</span>`;
    return `
      <div class="podium-place">
        ${crown ? '<div style="font-size:22px;">👑</div>' : ''}
        <div class="podium-avatar" style="width:${avatarSize}px;height:${avatarSize}px;border:3px solid ${color};background:${p.avatar_color};box-shadow:0 0 18px ${color}44;">
          ${avatarContent}
        </div>
        <div style="color:${color};font-size:${rank === 1 ? 14 : 12}px;font-weight:700;">${p.name}</div>
        <div style="color:${color};font-size:${rank === 1 ? 16 : 14}px;font-weight:700;">${p.total_score.toLocaleString('pl')}</div>
        <div class="podium-bar" style="height:${height}px;background:${color};">${rank}</div>
      </div>`;
  }).join('');

  // Rest of ranking
  $('lb-rest').innerHTML = ranked.slice(3).map((p, i) => {
    const rank = i + 4;
    const prev = posMap[p.id];
    const change = prev ? prev - rank : 0;
    const changeHtml = change > 0
      ? `<span class="lb-change up">▲${change}</span>`
      : change < 0
      ? `<span class="lb-change down">▼${Math.abs(change)}</span>`
      : `<span class="lb-change" style="color:var(--text-muted)">—</span>`;
    const avatarContent = p.avatar_data_url
      ? `<img src="${p.avatar_data_url}" style="width:100%;height:100%;object-fit:cover;">`
      : `<span style="font-size:9px;font-weight:700;color:#fff;">${p.initials}</span>`;
    return `
      <div class="lb-row">
        <span class="lb-rank">${rank}.</span>
        <div class="avatar-circle" style="width:26px;height:26px;background:${p.avatar_color};font-size:9px;">${avatarContent}</div>
        <span style="flex:1;">${p.name}</span>
        <span class="lb-pts">${p.total_score.toLocaleString('pl')}</span>
        ${changeHtml}
      </div>`;
  }).join('');

  prevRankings = ranked;

  if (isFinal) {
    $('btn-after-lb').textContent = '🎉 FINAŁ';
    $('btn-after-lb').onclick = () => showFinale(ranked[0]);
  } else {
    $('btn-after-lb').textContent = `▶ PYTANIE ${currentQuestionIndex + 2}`;
    $('btn-after-lb').onclick = () => {
      hide('screen-leaderboard');
      show('screen-round');
      startRound(currentQuestionIndex + 1);
    };
  }
}

// ── Finale ────────────────────────────────────────────────────────────────
async function showFinale(winner) {
  hide('screen-leaderboard');
  show('screen-finale');
  $('phase-label').textContent = '🏆 FINAŁ';

  // Maja video — place maja.mp4 in assets/ and upload to Supabase Storage
  // or host directly in repo (if <25MB)
  const videoEl = $('finale-video');
  videoEl.src = 'assets/maja.mp4'; // fallback local path
  // Try Supabase Storage URL:
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

  // Show winner banner
  $('finale-lb-wrap').innerHTML = `
    <div style="text-align:center;padding:24px;flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;">
      <div style="font-size:18px;color:var(--primary-light);font-weight:700;letter-spacing:2px;">🥇 ZWYCIĘZCA</div>
      <div class="avatar-circle" style="width:96px;height:96px;background:${winner.avatar_color};font-size:32px;font-weight:700;border:4px solid var(--gold);box-shadow:0 0 30px var(--gold)44;">
        ${winner.avatar_data_url
          ? `<img src="${winner.avatar_data_url}" style="width:100%;height:100%;object-fit:cover;">`
          : winner.initials}
      </div>
      <div style="font-size:32px;font-weight:700;color:var(--gold);">${winner.name}</div>
      <div style="font-size:22px;color:var(--gold);">${winner.total_score.toLocaleString('pl')} pkt</div>
      <div style="color:var(--text-muted);font-size:14px;">Brawo! 🎂 Sto lat Aga! 🎂</div>
    </div>
  `;
}
