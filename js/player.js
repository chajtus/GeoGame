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
  $('btn-join').disabled = $('name-input').value.trim().length < 2;
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
  if (playerState.avatarDataUrl) {
    el.innerHTML = `<img src="${playerState.avatarDataUrl}" alt="selfie">`;
    el.classList.add('has-photo');
    show('retake-hint');
    hide('btn-skip-avatar');
  } else {
    el.innerHTML = `<span>📷</span><span style="font-size:8px;color:var(--text-muted)">avatar</span>`;
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
    .on('broadcast', { event: 'round_start' }, ({ payload }) => handleRoundStart(payload))
    .on('broadcast', { event: 'round_end' }, () => handleRoundEnd())
    .on('broadcast', { event: 'next_question' }, ({ payload }) => handleRoundStart(payload))
    .on('broadcast', { event: 'show_leaderboard' }, () => {
      hide('screen-submitted');
      hide('screen-map');
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

// ── Round start ───────────────────────────────────────────────────────────
async function handleRoundStart(payload) {
  currentQuestion = payload;
  hide('screen-waiting');
  hide('screen-submitted');
  show('screen-map');

  $('round-label').textContent = `RUNDA ${payload.question_index + 1}`;
  $('btn-submit').disabled = true;
  $('btn-submit').textContent = '✅ ZATWIERDŹ ODPOWIEDŹ';
  playerPinLatLng = null;
  submitted = false;

  // Init map on first round
  if (!leafletMap) {
    await initPlayerMap();
  } else {
    // Remove previous pin
    if (playerPin) { leafletMap.removeLayer(playerPin); playerPin = null; }
    show('map-hint');
  }

  startPlayerTimer(payload.started_at, payload.duration_ms);
}

async function initPlayerMap() {
  const { initMap } = await import('./map-utils.js');
  leafletMap = initMap('map', { center: [20, 0], zoom: 2 });
  leafletMap.on('click', onMapClick);
  show('map-hint');
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
    if (remaining <= 0) { clearInterval(timerInterval); autoSubmit(); }
  }, 250);
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

  hide('screen-map');
  show('screen-submitted');
}

// ── Round end from host ───────────────────────────────────────────────────
function handleRoundEnd() {
  clearInterval(timerInterval);
  // Host will broadcast next_question or show_leaderboard next
}
