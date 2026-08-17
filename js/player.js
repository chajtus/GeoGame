import { AGA_FACTS } from './aga-facts.js';

// ── Helpers ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const show = id => $(id).classList.remove('hidden');
const hide = id => $(id).classList.add('hidden');

function showMap() {
  show('screen-map');
  $('map-top-bar').classList.add('map-bar--visible');
}
function hideMap() {
  hide('screen-map');
  $('map-top-bar').classList.remove('map-bar--visible');
}

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


// ── Name input ────────────────────────────────────────────────────────────
$('name-input').addEventListener('input', () => {
  const name = $('name-input').value.trim();
  $('btn-join').disabled = name.length < 2;
  if (!playerState.avatarDataUrl) renderAvatarPreview();
});

// ── Selfie flow ───────────────────────────────────────────────────────────
$('avatar-preview').addEventListener('click', () => $('btn-selfie').click());
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
  subscribeToKick();
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
      if (!$('map-waiting-overlay').classList.contains('hidden')) {
        $('waiting-count').textContent = `${payload.answered}/${payload.total}`;
      }
    })
    .on('broadcast', { event: 'round_end' }, () => handleRoundEnd())
    .on('broadcast', { event: 'session_killed' }, () => {
      // Host killed the session — show a clear message
      document.body.innerHTML = '<div style="height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:#0d0d1a;color:#fff;text-align:center;padding:24px;"><div style="font-size:48px;">🎮</div><div style="font-size:22px;font-weight:900;">Sesja zakończona</div><div style="font-size:14px;color:#aaa;">Host zakończył grę.<br>Dziękujemy za udział!</div></div>';
    })
    .on('broadcast', { event: 'show_leaderboard' }, ({ payload }) => {
      leaderboardShown = true;
    
      hide('screen-submitted');
      hideMap();
      hide('screen-round-flash');
      if (payload?.isFinal) {
        hide('screen-waiting');
        $('finale-player-name').textContent = playerState.name;
        show('screen-player-finale');
        // Fetch final rank and display it
        fetchPlayerRank().then(() => {
          $('finale-rank-num').textContent = playerRank ? `#${playerRank}` : '—';
        });
      } else {
        show('screen-waiting');
        document.querySelector('#screen-waiting .waiting-sub').textContent = 'Oglądaj wyniki na ekranie 📺';
      }
    })
    .subscribe();
}

// ── Kick detection via polling (checks if player record still exists) ─────
let kickPollInterval = null;
function subscribeToKick() {
  if (kickPollInterval) return;
  kickPollInterval = setInterval(async () => {
    try {
      const { data, error } = await sb.from('players')
        .select('id')
        .eq('id', playerState.id)
        .maybeSingle();
      console.log('[kick-poll]', { id: playerState.id, data, error });
      if (!data && !error) {
        clearInterval(kickPollInterval);
        clearInterval(timerInterval);
        sessionStorage.removeItem('player');
        document.body.innerHTML = `<div style="height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:#0d0d1a;color:#fff;text-align:center;padding:24px;">
          <div style="font-size:48px;">🚫</div>
          <div style="font-size:22px;font-weight:900;color:#ff5252;">Zostałeś wyrzucony z gry</div>
          <div style="font-size:14px;color:#aaa;">Host usunął Cię z sesji.<br>Może następnym razem pójdzie lepiej!</div>
        </div>`;
      }
    } catch (_) {}
  }, 3000);
}

// ── Map state ─────────────────────────────────────────────────────────────
let leafletMap = null;
let playerPin = null;
let playerPinLatLng = null;
let currentQuestion = null;
let timerInterval = null;
let submitted = false;
let manuallySubmitted = false; // true only when player clicked Zatwierdź
let autoSubmitted = false; // true when pin was auto-submitted on timeout
let playerResultMap = null;

let lastPlayerCountdownSec = -1;
let lastDistanceKm = 0;
let lastPoints = 0;
let lastEndedQuestionIndex = -1;
let playerRank = null;
let leaderboardShown = false;

async function fetchPlayerRank() {
  try {
    const { data } = await sb.from('players')
      .select('id, total_score')
      .eq('session_id', SESSION_ID)
      .order('total_score', { ascending: false });
    if (data) {
      const idx = data.findIndex(p => p.id === playerState.id);
      playerRank = idx >= 0 ? idx + 1 : null;
    }
  } catch (_) {}
}

// ── Round start ───────────────────────────────────────────────────────────
async function handleRoundStart(payload, showFlash = false) {

  if (playerResultMap) { playerResultMap.remove(); playerResultMap = null; }

  // Guard: round already ended (late delivery of round_start after round_end)
  if (payload.question_index <= lastEndedQuestionIndex) return;

  // Guard: round already expired by the time we received it
  const msRemaining = payload.duration_ms - (Date.now() - new Date(payload.started_at).getTime());
  if (msRemaining <= 0) {
    lastEndedQuestionIndex = payload.question_index;
    currentQuestion = payload;
    submitted = true;
    lastDistanceKm = 0;
    lastPoints = 0;
    hide('screen-waiting');
    hide('screen-round-flash');
    showPlayerResult();
    return;
  }

  currentQuestion = payload;
  playerPinLatLng = null;
  submitted = false;
  manuallySubmitted = false;
  autoSubmitted = false;
  leaderboardShown = false;
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
    hide('map-waiting-overlay');
    hideMap();
    show('screen-round-flash');
    triggerAnim('screen-round-flash', 'flash--in');
    await new Promise(r => setTimeout(r, 2200));
    hide('screen-round-flash');
    if (submitted) return; // host ended round during flash — skip map
  } else {
    hide('screen-waiting');
    hide('screen-submitted');
    hide('map-waiting-overlay');
    hide('screen-round-flash');
  }

  showMap();
  show('map-submit-bar');
  $('round-label').textContent = `RUNDA ${payload.question_index + 1}`;
  $('btn-submit').disabled = true;
  $('btn-submit').textContent = '✅ ZATWIERDŹ ODPOWIEDŹ';

  // Init map on first round
  if (!leafletMap) {
    await initPlayerMap();
  } else {
    // Restore map interaction for new round
    leafletMap.dragging.enable();
    leafletMap.touchZoom.enable();
    // Remove previous pin, reset view to world
    if (playerPin) { leafletMap.removeLayer(playerPin); playerPin = null; }
    leafletMap.setView([20, 0], 2);
    showHintAnimated();
    setTimeout(() => leafletMap.invalidateSize(), 60);
  }

  // Show rank from previous round (or placeholder for first round)
  $('leader-label').textContent = playerRank ? `🏆 #${playerRank}` : '🏆 —';

  startPlayerTimer(payload.started_at, payload.duration_ms);

  // Check if player already submitted answer for this round (e.g. after page refresh)
  try {
    const { data: existingPin } = await sb.from('pins')
      .select('distance_km, points')
      .eq('session_id', SESSION_ID)
      .eq('player_id', playerState.id)
      .eq('question_index', payload.question_index)
      .maybeSingle();
    if (existingPin) {
      submitted = true;
      manuallySubmitted = true;
      lastDistanceKm = existingPin.distance_km;
      lastPoints = existingPin.points;
      hide('map-submit-bar');
      hide('map-hint');
      if (leafletMap) { leafletMap.dragging.disable(); leafletMap.touchZoom.disable(); }
      $('waiting-count').textContent = '';
      show('map-waiting-overlay');
      triggerAnim('map-waiting-overlay', 'waiting--in');
    }
  } catch (_) {}
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
  leafletMap = initMap('map', { center: [20, 0], zoom: 2, zoomControl: false });
  leafletMap.on('click', onMapClick);
  showHintAnimated();
  // Resize when browser chrome hides/shows (e.g. Android address bar)
  window.addEventListener('resize', () => { if (leafletMap) leafletMap.invalidateSize(); });
}

function showHintAnimated() {
  const hint = $('map-hint');
  if (!hint) return;
  show('map-hint');
  triggerAnim(hint, 'hint--visible');
}

function onMapClick(e) {
  if (submitted) return;
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

    // Submit bar urgent pulse — last 5 seconds
    if (secs <= 5 && remaining > 0 && !submitted) {
      $('map-submit-bar').classList.add('submit-urgent');
    } else {
      $('map-submit-bar').classList.remove('submit-urgent');
    }

    // Countdown: flash "10" once (orange), then 5-4-3-2-1 (red) — only before submitting
    const showCountdown = !submitted && (secs === 10 || secs <= 5) && secs > 0 && remaining > 0;
    if (showCountdown) {
      if (secs !== lastPlayerCountdownSec) {
        lastPlayerCountdownSec = secs;
        const el = $('player-countdown-number');
        el.textContent = secs;
        el.style.color = secs > 5 ? 'rgba(255,152,0,0.7)' : 'rgba(255,255,255,0.13)';
        el.style.textShadow = secs > 5 ? '0 0 12px rgba(255,152,0,0.5)' : '0 0 60px rgba(244,67,54,0.5)';
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
      // Timer expired — handle immediately (round_end broadcast is not guaranteed delivery)
      handleRoundEnd();
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
  manuallySubmitted = true;
  if (!playerPinLatLng || !currentQuestion) return;
  $('btn-submit').disabled = true;
  $('map-submit-bar').classList.remove('submit-urgent');

  // Immediately show waiting overlay and block interaction
  hide('map-submit-bar');
  hide('map-hint');
  if (leafletMap) leafletMap.dragging.disable();
  if (leafletMap) leafletMap.touchZoom.disable();
  $('waiting-count').textContent = '';
  show('map-waiting-overlay');
  triggerAnim('map-waiting-overlay', 'waiting--in');

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

  await sb.rpc('increment_score', { player_id: playerState.id, amount: points })
    .catch(() => null);
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

  hide('map-waiting-overlay');

  const notSubmitted = !manuallySubmitted;
  const noPin = notSubmitted && !playerPinLatLng;
  const distLabel = notSubmitted
    ? (playerPinLatLng ? '📍 Pinezka niezatwierdzona' : '😅 Nie zaznaczyłeś miejsca')
    : lastDistanceKm < 1
      ? `${Math.round(lastDistanceKm * 1000)} m od celu`
      : `${Math.round(lastDistanceKm).toLocaleString('pl')} km od celu`;
  const statusEl = $('submit-status-label');
  if (notSubmitted) {
    statusEl.textContent = '⚠ ODPOWIEDŹ NIEZATWIERDZONA';
    statusEl.style.color = 'var(--red)';
  } else if (autoSubmitted) {
    statusEl.innerHTML = '✓ ODPOWIEDŹ WYSŁANA<br><span style="font-size:11px;color:var(--orange);">Następnym razem zatwierdź, łajdaku, bo będą problemy! 😤</span>';
    statusEl.style.color = 'var(--green)';
  } else {
    statusEl.textContent = '✓ ODPOWIEDŹ WYSŁANA';
    statusEl.style.color = 'var(--green)';
  }
  $('submit-points').textContent = lastPoints > 0 ? `+${lastPoints.toLocaleString('pl')} pkt` : '0 pkt';
  $('submit-distance').textContent = distLabel;
  $('submit-location').textContent = noPin ? '' : (currentQuestion?.location_name || '');
  $('submit-countdown-label').textContent = 'Poczekaj na leaderboard...';
  $('submit-countdown-secs').textContent = '';

  // Random Aga quote while waiting for next round

  hideMap();
  show('screen-submitted');

  // Animate results fly-in with stagger
  triggerAnim('submit-points', 'result--in');
  triggerAnim('submit-distance', 'result--in');

  if (noPin || notSubmitted) {
    hide('submit-mini-map');
  } else {
    show('submit-mini-map');
    triggerAnim('submit-mini-map', 'minimap--in');
    initSubmitMiniMap(lastDistanceKm);
  }

  // Fetch rank in background — will show on next round's map screen
  fetchPlayerRank();
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
    subscribeToKick();
  } catch { /* ignore */ }
})();

// ── Round end from host ───────────────────────────────────────────────────
async function handleRoundEnd() {
  if (currentQuestion) lastEndedQuestionIndex = currentQuestion.question_index;
  clearInterval(timerInterval);

  hide('player-countdown-overlay');
  $('player-timer').textContent = 'Czas!';
  $('player-timer').classList.add('urgent');

  if (!submitted) {
    if (playerPinLatLng) {
      // Pin placed but not confirmed — auto-submit as valid answer
      autoSubmitted = true;
      await autoSubmit();
    } else {
      // No pin at all — 0 pts, no DB write
      submitted = true;
      lastDistanceKm = 0;
      lastPoints = 0;
    }
    showPlayerResult();
  } else {
    showPlayerResult();
  }
}
