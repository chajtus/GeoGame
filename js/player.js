import { AGA_FACTS } from './aga-facts.js';

// ── Helpers ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const show = id => $(id).classList.remove('hidden');
const hide = id => $(id).classList.add('hidden');

const AVATAR_COLORS = ['#e91e8c','#9c27b0','#3f51b5','#009688','#ff5722','#ff9800','#2196f3'];
function randomColor() { return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]; }
function getInitials(name) { return name.trim().split(/\s+/).map(w => w[0]).join('').slice(0,2).toUpperCase(); }

// ── Session from URL ──────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
const SESSION_ID = params.get('session') || 'demo';

// ── Supabase ──────────────────────────────────────────────────────────────
const { createClient } = supabase;
const sb = createClient(window.CONFIG.supabaseUrl, window.CONFIG.supabaseAnonKey);

// ── State ─────────────────────────────────────────────────────────────────
let playerState = {
  id: null,
  name: '',
  avatarDataUrl: null,
  initials: '',
  avatarColor: randomColor(),
};
let cameraStream = null;

// ── AGA FACT ──────────────────────────────────────────────────────────────
$('fact-text').textContent = AGA_FACTS[Math.floor(Math.random() * AGA_FACTS.length)];

// ── Name input ────────────────────────────────────────────────────────────
$('name-input').addEventListener('input', () => {
  const name = $('name-input').value.trim();
  $('btn-join').disabled = name.length < 2;
  if (!playerState.avatarDataUrl) renderAvatarPreview();
});

// ── Selfie flow ───────────────────────────────────────────────────────────
$('btn-selfie').addEventListener('click', async () => {
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    $('camera-video').srcObject = cameraStream;
    show('camera-overlay');
  } catch {
    alert('Nie można uruchomić kamery. Użyj opcji "pomiń".');
  }
});

$('btn-snap').addEventListener('click', () => {
  const video = $('camera-video');
  const canvas = $('snap-canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  playerState.avatarDataUrl = canvas.toDataURL('image/jpeg', 0.6);
  stopCamera();
  renderAvatarPreview();
});

$('btn-cancel-camera').addEventListener('click', stopCamera);

function stopCamera() {
  if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
  hide('camera-overlay');
}

$('retake-hint').addEventListener('click', () => {
  playerState.avatarDataUrl = null;
  renderAvatarPreview();
  $('btn-selfie').click();
});

$('btn-skip-avatar').addEventListener('click', () => {
  playerState.avatarDataUrl = null;
  renderAvatarPreview();
});

function renderAvatarPreview() {
  const el = $('avatar-preview');
  const name = $('name-input').value.trim();
  const initials = name ? getInitials(name) : '?';

  if (playerState.avatarDataUrl) {
    el.innerHTML = `<img src="${playerState.avatarDataUrl}" alt="selfie">`;
    el.style.background = 'transparent';
    el.classList.add('has-photo');
    show('retake-hint');
    hide('btn-skip-avatar');
  } else {
    // Show initials circle — feels like a real avatar, not a broken state
    el.style.background = playerState.avatarColor;
    el.innerHTML = `<span style="font-size:28px;font-weight:800;color:#fff;line-height:1;">${initials}</span>`;
    el.classList.remove('has-photo');
    hide('retake-hint');
    show('btn-skip-avatar');
  }
}

// ── Join game ─────────────────────────────────────────────────────────────
$('btn-join').addEventListener('click', async () => {
  const name = $('name-input').value.trim();
  if (!name) return;
  $('btn-join').disabled = true;
  $('btn-join').textContent = 'Dołączam...';

  playerState.name = name;
  playerState.initials = getInitials(name);

  const { data, error } = await sb.from('players').insert({
    session_id: SESSION_ID,
    name: playerState.name,
    avatar_data_url: playerState.avatarDataUrl || null,
    initials: playerState.initials,
    avatar_color: playerState.avatarColor,
  }).select('id').single();

  if (error || !data) {
    alert('Błąd połączenia z grą. Spróbuj ponownie.');
    $('btn-join').disabled = false;
    $('btn-join').textContent = 'DOŁĄCZ DO GRY 🎮';
    return;
  }

  playerState.id = data.id;
  sessionStorage.setItem('player', JSON.stringify(playerState));
  showWaiting();
  subscribeToGame();
});

// ── Waiting screen ────────────────────────────────────────────────────────
function showWaiting() {
  hide('screen-login');
  show('screen-waiting');
  const el = $('waiting-avatar-display');
  if (playerState.avatarDataUrl) {
    el.innerHTML = `<img src="${playerState.avatarDataUrl}" alt="" style="width:100%;height:100%;object-fit:cover;">`;
    el.style.background = 'transparent';
  } else {
    el.style.background = playerState.avatarColor;
    el.textContent = playerState.initials;
  }
  $('waiting-name-display').textContent = playerState.name;
}

// ── Game channel (map logic added in Task 7) ──────────────────────────────
let gameChannel = null;
export { gameChannel, playerState, SESSION_ID, sb };

function subscribeToGame() {
  gameChannel = sb.channel(`game:${SESSION_ID}`, { config: { broadcast: { self: false } } });
  gameChannel
    .on('broadcast', { event: 'round_start' }, ({ payload }) => handleRoundStart(payload, true))
    .on('broadcast', { event: 'round_heartbeat' }, ({ payload }) => {
      // Fallback: if player missed round_start (channel reconnect etc.)
      if (!currentQuestion || currentQuestion.question_index !== payload.question_index) {
        handleRoundStart(payload, false); // No flash on heartbeat recovery
      }
    })
    .on('broadcast', { event: 'time_extended' }, ({ payload }) => {
      if (currentQuestion) {
        currentQuestion.started_at = payload.started_at;
        currentQuestion.duration_ms = payload.duration_ms;
        if (!submitted) startPlayerTimer(payload.started_at, payload.duration_ms);
      }
    })
    .on('broadcast', { event: 'round_paused' }, () => {
      clearInterval(timerInterval);
      $('player-timer').style.opacity = '0.45';
      $('player-timer').style.textDecoration = 'line-through';
    })
    .on('broadcast', { event: 'round_resumed' }, ({ payload }) => {
      $('player-timer').style.opacity = '';
      $('player-timer').style.textDecoration = '';
      if (currentQuestion && !submitted) {
        currentQuestion.started_at = payload.started_at;
        currentQuestion.duration_ms = payload.duration_ms;
        startPlayerTimer(payload.started_at, payload.duration_ms);
      }
    })
    .on('broadcast', { event: 'player_answered' }, ({ payload }) => {
      if (!$('map-submitted-overlay').classList.contains('hidden')) {
        $('overlay-count').textContent = `${payload.answered} / ${payload.total} odpowiedziało`;
        // Floating ✅ animation for each new answer
        const icons = ['✅','🎯','✔️','💚'];
        const el = document.createElement('div');
        el.className = 'vote-float';
        el.textContent = icons[Math.floor(Math.random() * icons.length)];
        el.style.left = (10 + Math.random() * 80) + '%';
        el.style.bottom = (5 + Math.random() * 40) + '%';
        $('overlay-vote-bg').appendChild(el);
        el.addEventListener('animationend', () => el.remove(), { once: true });
      }
    })
    .on('broadcast', { event: 'round_end' }, () => handleRoundEnd())
    .on('broadcast', { event: 'show_leaderboard' }, () => {
      clearInterval(submittedCountdownInterval);
      hide('screen-submitted');
      hide('screen-map');
      hide('screen-round-flash');
      show('screen-waiting');
      document.querySelector('#screen-waiting .waiting-sub').textContent = 'Oglądaj wyniki na ekranie 📺';
    })
    .subscribe();
}

// ── Map state ─────────────────────────────────────────────────────────────
let leafletMap = null;
let playerPin = null;
let playerPinLatLng = null;
let currentQuestion = null;
let timerInterval = null;
let submitted = false;
let playerResultMap = null;
let submittedCountdownInterval = null;
let lastPlayerCountdownSec = -1;
let lastDistanceKm = 0;
let lastPoints = 0;

// ── Round start ───────────────────────────────────────────────────────────
async function handleRoundStart(payload, showFlash = false) {
  clearInterval(submittedCountdownInterval);
  if (playerResultMap) { playerResultMap.remove(); playerResultMap = null; }

  currentQuestion = payload;
  playerPinLatLng = null;
  submitted = false;
  lastDistanceKm = 0;
  lastPoints = 0;
  hide('player-countdown-overlay');
  lastPlayerCountdownSec = -1;

  // Brief photo flash with round number
  if (showFlash && payload.photo_url) {
    $('flash-round-num').textContent = payload.question_index + 1;
    $('flash-photo').src = payload.photo_url;
    hide('screen-waiting');
    hide('screen-submitted');
    hide('map-submitted-overlay');
    hide('screen-map');
    show('screen-round-flash');
    triggerAnim('screen-round-flash', 'flash--in');
    await new Promise(r => setTimeout(r, 2200));
    hide('screen-round-flash');
  } else {
    hide('screen-waiting');
    hide('screen-submitted');
    hide('map-submitted-overlay');
    hide('screen-round-flash');
  }

  show('screen-map');
  $('round-label').textContent = `RUNDA ${payload.question_index + 1}`;
  $('btn-submit').disabled = true;
  $('btn-submit').textContent = '✅ ZATWIERDŹ ODPOWIEDŹ';

  // Init map on first round
  if (!leafletMap) {
    await initPlayerMap();
  } else {
    // Remove previous pin, reset view to world
    if (playerPin) { leafletMap.removeLayer(playerPin); playerPin = null; }
    leafletMap.setView([20, 0], 2);
    showHintAnimated();
    setTimeout(() => leafletMap.invalidateSize(), 60);
  }

  startPlayerTimer(payload.started_at, payload.duration_ms);
}

// ── Animation helper: remove class, force reflow, re-add (re-trigger) ────────
function triggerAnim(el, cls) {
  if (typeof el === 'string') el = $(el);
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

async function initPlayerMap() {
  const { initMap } = await import('./map-utils.js');
  leafletMap = initMap('map', { center: [20, 0], zoom: 2 });
  leafletMap.on('click', onMapClick);
  showHintAnimated();
}

function showHintAnimated() {
  const hint = $('map-hint');
  if (!hint) return;
  show('map-hint');
  triggerAnim(hint, 'hint--visible');
}

function onMapClick(e) {
  playerPinLatLng = [e.latlng.lat, e.latlng.lng];
  if (playerPin) leafletMap.removeLayer(playerPin);

  const icon = L.divIcon({
    html: `<div style="width:18px;height:18px;background:var(--primary-light,#ff79c6);border-radius:50% 50% 50% 0;transform:rotate(-45deg);border:2px solid white;box-shadow:0 0 10px rgba(255,121,198,0.9);"></div>`,
    className: '',
    iconSize: [18, 18],
    iconAnchor: [9, 18],
  });
  playerPin = L.marker(playerPinLatLng, { icon }).addTo(leafletMap);

  hide('map-hint');
  $('btn-submit').disabled = false;
}

// ── Timer ─────────────────────────────────────────────────────────────────
function startPlayerTimer(startedAt, durationMs) {
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const remaining = Math.max(0, durationMs - (Date.now() - new Date(startedAt).getTime()));
    const secs = Math.ceil(remaining / 1000);
    const mins = Math.floor(secs / 60);
    const s = secs % 60;
    $('player-timer').textContent = `${mins}:${String(s).padStart(2, '0')}`;
    $('player-timer').classList.toggle('urgent', secs <= 10);

    // Countdown overlay 5-4-3-2-1
    if (secs <= 5 && secs > 0 && remaining > 0) {
      if (secs !== lastPlayerCountdownSec) {
        lastPlayerCountdownSec = secs;
        const el = $('player-countdown-number');
        el.textContent = secs;
        el.classList.remove('countdown-num');
        void el.offsetWidth;
        el.classList.add('countdown-num');
      }
      show('player-countdown-overlay');
    } else {
      hide('player-countdown-overlay');
      if (remaining > 0) lastPlayerCountdownSec = -1;
    }

    if (remaining <= 0) {
      clearInterval(timerInterval);
      $('player-timer').textContent = 'Czas!';
      $('player-timer').classList.add('urgent');
      hide('player-countdown-overlay');
      // Do NOT auto-submit — wait for round_end from host
    }
  }, 100); // 100ms for tight sync with host
}

// ── Submit answer ─────────────────────────────────────────────────────────
$('btn-submit').addEventListener('click', submitAnswer);

async function autoSubmit() {
  if (!playerPinLatLng) {
    // No pin placed — submit [0,0] as fallback (0 points)
    playerPinLatLng = [0, 0];
  }
  await submitAnswer();
}

async function submitAnswer() {
  if (submitted) return;
  submitted = true;
  if (!playerPinLatLng || !currentQuestion) return;
  $('btn-submit').disabled = true;
  clearInterval(timerInterval);

  const { haversineKm, calculatePoints } = await import('./scoring.js');
  const distanceKm = haversineKm(
    playerPinLatLng[0], playerPinLatLng[1],
    currentQuestion.lat, currentQuestion.lng
  );
  const points = calculatePoints(distanceKm);
  lastDistanceKm = distanceKm;
  lastPoints = points;

  await sb.from('pins').insert({
    session_id: SESSION_ID,
    player_id: playerState.id,
    question_index: currentQuestion.question_index,
    lat: playerPinLatLng[0],
    lng: playerPinLatLng[1],
    distance_km: distanceKm,
    points,
  });

  // Run SQL in Supabase: CREATE OR REPLACE FUNCTION increment_score(player_id UUID, amount INTEGER) RETURNS void LANGUAGE sql AS $$ UPDATE players SET total_score = total_score + amount WHERE id = player_id; $$;
  await sb.rpc('increment_score', { player_id: playerState.id, amount: points })
    .catch(() => null);

  // Show overlay over the (now dimmed) map
  const distLabel = distanceKm < 1
    ? `${Math.round(distanceKm * 1000)} m od celu`
    : `${Math.round(distanceKm).toLocaleString('pl')} km od celu`;

  $('overlay-points').textContent = points > 0 ? `+${points.toLocaleString('pl')}` : '0 pkt';
  $('overlay-distance').textContent = distLabel;
  $('overlay-location').textContent = currentQuestion.location_name || '';
  $('overlay-countdown').textContent = '';

  show('map-submitted-overlay');
  triggerAnim('map-submitted-overlay', 'overlay--in');
  triggerAnim('map-submitted-card', 'card--in');
  triggerAnim('overlay-points', 'points--in');

  // btn-submit confirmation bounce
  triggerAnim('btn-submit', 'btn--confirmed');
  $('btn-submit').textContent = '✓ Wysłano';
  $('btn-submit').disabled = true;

  startSubmittedCountdown();
}

function startSubmittedCountdown() {
  clearInterval(submittedCountdownInterval);
  const q = currentQuestion;
  submittedCountdownInterval = setInterval(() => {
    const remaining = Math.max(0, q.duration_ms - (Date.now() - new Date(q.started_at).getTime()));
    const secs = Math.ceil(remaining / 1000);
    if (secs > 0) {
      $('overlay-countdown').textContent = `${secs}s`;
      $('overlay-waiting').textContent = 'Czekam na innych graczy...';
    } else {
      $('overlay-countdown').textContent = '';
      $('overlay-waiting').textContent = 'Czekam na wyniki...';
      clearInterval(submittedCountdownInterval);
    }
  }, 100);
}

async function initSubmitMiniMap(distanceKm) {
  if (playerResultMap) { playerResultMap.remove(); playerResultMap = null; }
  const q = currentQuestion;
  if (!playerPinLatLng || !q) return;

  const { initMap, createTrueLocationMarker } = await import('./map-utils.js');
  await new Promise(r => setTimeout(r, 80));

  const midLat = (playerPinLatLng[0] + q.lat) / 2;
  const midLng = (playerPinLatLng[1] + q.lng) / 2;

  playerResultMap = initMap('submit-mini-map', { center: [midLat, midLng], zoom: 3 });
  createTrueLocationMarker(playerResultMap, q.lat, q.lng);

  // Player pin
  L.marker(playerPinLatLng, {
    icon: L.divIcon({
      html: `<div style="width:14px;height:14px;background:#ff79c6;border-radius:50%;border:2px solid #fff;box-shadow:0 0 8px rgba(255,121,198,0.9);"></div>`,
      className: '', iconSize: [14, 14], iconAnchor: [7, 7],
    }),
  }).addTo(playerResultMap);

  // Line between them
  L.polyline([playerPinLatLng, [q.lat, q.lng]], {
    color: '#ff79c6', weight: 2, opacity: 0.8, dashArray: '6, 4',
  }).addTo(playerResultMap);

  // Km label at midpoint — pill above the line, centered
  const distKm = distanceKm < 1
    ? `${Math.round(distanceKm * 1000)} m`
    : `${Math.round(distanceKm).toLocaleString('pl')} km`;
  // Permanent tooltip — clean, no invisible marker container (no black dot artifact)
  L.tooltip({ permanent: true, direction: 'top', className: 'km-dist-tip', offset: [0, 4] })
    .setLatLng([midLat, midLng])
    .setContent(`📏 ${distKm}`)
    .addTo(playerResultMap);

  setTimeout(() => {
    playerResultMap.invalidateSize();
    const bounds = L.latLngBounds([playerPinLatLng, [q.lat, q.lng]]);
    playerResultMap.fitBounds(bounds, { padding: [30, 30] });
  }, 100);
}

// ── Show player result map after round ends ───────────────────────────────
function showPlayerResult() {
  clearInterval(submittedCountdownInterval);
  hide('map-submitted-overlay');

  const noPin = !playerPinLatLng && lastDistanceKm === 0 && lastPoints === 0;
  const distLabel = noPin
    ? '😅 Nie zaznaczyłeś miejsca'
    : lastDistanceKm < 1
      ? `${Math.round(lastDistanceKm * 1000)} m od celu`
      : `${Math.round(lastDistanceKm).toLocaleString('pl')} km od celu`;
  $('submit-points').textContent = lastPoints > 0 ? `+${lastPoints.toLocaleString('pl')} pkt` : '0 pkt';
  $('submit-distance').textContent = distLabel;
  $('submit-location').textContent = noPin ? '' : (currentQuestion?.location_name || '');
  $('submit-countdown-label').textContent = 'Poczekaj na leaderboard...';
  $('submit-countdown-secs').textContent = '';

  // Random Aga quote while waiting for next round
  const quote = AGA_FACTS[Math.floor(Math.random() * AGA_FACTS.length)];
  $('aga-quote-text').textContent = `„${quote}"`;
  $('aga-quote-author').textContent = '— z archiwum życia Agi 🎂';

  hide('screen-map');
  show('screen-submitted');

  // Animate results fly-in with stagger
  triggerAnim('submit-points', 'result--in');
  triggerAnim('submit-distance', 'result--in');
  triggerAnim('submit-mini-map', 'minimap--in');

  initSubmitMiniMap(lastDistanceKm);
}

// ── Session restore (rejoin after accidental refresh) ─────────────────────
// Must run after all let declarations to avoid TDZ errors
(function tryRestoreSession() {
  const saved = sessionStorage.getItem('player');
  if (!saved) return;
  try {
    const p = JSON.parse(saved);
    if (!p.id || !p.name) return;
    Object.assign(playerState, p);
    showWaiting();
    document.querySelector('#screen-waiting .waiting-sub').textContent = 'Łączenie ponownie...';
    subscribeToGame();
  } catch { /* ignore */ }
})();

// ── Round end from host ───────────────────────────────────────────────────
function handleRoundEnd() {
  clearInterval(timerInterval);
  clearInterval(submittedCountdownInterval);
  hide('player-countdown-overlay');
  $('player-timer').textContent = 'Czas!';
  $('player-timer').classList.add('urgent');

  if (!submitted) {
    if (!playerPinLatLng) {
      // No pin placed — skip DB insert, show 0 points directly
      submitted = true;
      lastDistanceKm = 0;
      lastPoints = 0;
      showPlayerResult();
    } else {
      submitAnswer().then(() => showPlayerResult());
    }
  } else {
    showPlayerResult();
  }
}
