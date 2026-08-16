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

function startRound(index) { console.log('startRound stub', index); }
