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

// Stubs — implemented in Task 7
function handleRoundStart(payload) { console.log('round_start stub', payload); }
function handleRoundEnd() { console.log('round_end stub'); }
