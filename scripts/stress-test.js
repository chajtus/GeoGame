/**
 * Stress test — simulates N players joining and submitting answers.
 * Usage: node stress-test.js [playerCount] [sessionId]
 * Example: node stress-test.js 40 aga-abc123
 *
 * Run this AFTER starting the game on host.html (copy the session ID from the URL).
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://mbhdynfnjfldssrmiqku.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1iaGR5bmZuamZsZHNzcm1pcWt1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY4NjAzMTksImV4cCI6MjEwMjQzNjMxOX0.r2s7qMUvO4RNkJ2Ju272PfDwxUQu7Pfb1YyUo2oFetM';

const PLAYER_COUNT = parseInt(process.argv[2] || '40');
const SESSION_ID   = process.argv[3] || null;

const AVATAR_COLORS = ['#e91e8c','#9c27b0','#3f51b5','#009688','#ff5722','#ff9800','#2196f3'];
const NAMES = [
  'Anna','Bartek','Celina','Dawid','Ewa','Filip','Gosia','Hubert',
  'Iza','Jarek','Kasia','Leszek','Monika','Norbert','Ola','Paweł',
  'Renata','Sławek','Teresa','Ulka','Witek','Zosia','Arek','Basia',
  'Czarek','Dorota','Emil','Fela','Gracja','Heniek','Irena','Jurek',
  'Krzyś','Laura','Marek','Nina','Oskar','Patrycja','Rafał','Sara',
];

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function calculatePoints(km) {
  if (km < 0.5) return 5000;
  if (km > 5000) return 0;
  return Math.round(5000 * Math.exp(-km / 2000));
}

async function simulatePlayer(index, sessionId) {
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const name = NAMES[index % NAMES.length] + (index >= NAMES.length ? `_${Math.floor(index/NAMES.length)+1}` : '');
  const color = AVATAR_COLORS[index % AVATAR_COLORS.length];

  // 1. Join (insert player)
  const { data: player, error: joinErr } = await sb
    .from('players')
    .insert({ session_id: sessionId, name, initials: name.slice(0,2).toUpperCase(), avatar_color: color })
    .select('id').single();

  if (joinErr || !player) {
    console.error(`[${name}] Join failed:`, joinErr?.message);
    return;
  }
  console.log(`[${name}] Joined ✓`);

  // 2. Subscribe to game channel and wait for round_start
  let resolveRound;
  const roundPromise = new Promise(r => { resolveRound = r; });

  const ch = sb.channel(`game:${sessionId}`, { config: { broadcast: { self: false } } });
  ch
    .on('broadcast', { event: 'round_start' }, ({ payload }) => resolveRound(payload))
    .on('broadcast', { event: 'round_heartbeat' }, ({ payload }) => resolveRound(payload))
    .subscribe();

  console.log(`[${name}] Waiting for round_start...`);
  const round = await Promise.race([
    roundPromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout waiting for round')), 60_000)),
  ]);

  console.log(`[${name}] Round ${round.question_index + 1} started — submitting answer`);

  // 3. Simulate a random guess (within ±30 degrees of true location)
  const guessLat = round.lat + (Math.random() - 0.5) * 60;
  const guessLng = round.lng + (Math.random() - 0.5) * 60;
  const distanceKm = haversineKm(guessLat, guessLng, round.lat, round.lng);
  const points = calculatePoints(distanceKm);

  // Random delay 2-25s to simulate human think time
  const thinkMs = 2000 + Math.random() * 23_000;
  await new Promise(r => setTimeout(r, thinkMs));

  const { error: pinErr } = await sb.from('pins').insert({
    session_id: sessionId,
    player_id: player.id,
    question_index: round.question_index,
    lat: guessLat,
    lng: guessLng,
    distance_km: distanceKm,
    points,
  });

  if (pinErr) {
    console.error(`[${name}] Pin insert failed:`, pinErr.message);
  } else {
    console.log(`[${name}] Submitted — ${Math.round(distanceKm)} km, ${points} pts ✓`);
  }

  await sb.removeAllChannels();
}

async function run() {
  if (!SESSION_ID) {
    console.error('❌ Podaj session ID jako argument, np.:');
    console.error('   node stress-test.js 40 aga-abc123');
    console.error('\nSession ID znajdziesz w URL player.html: ?session=aga-...');
    process.exit(1);
  }

  console.log(`\n🚀 Stress test: ${PLAYER_COUNT} graczy → sesja "${SESSION_ID}"\n`);

  // Stagger joins over 3s to avoid thundering herd on Supabase
  const promises = Array.from({ length: PLAYER_COUNT }, (_, i) =>
    new Promise(r => setTimeout(r, i * 75)).then(() => simulatePlayer(i, SESSION_ID))
  );

  const results = await Promise.allSettled(promises);
  const ok = results.filter(r => r.status === 'fulfilled').length;
  const fail = results.filter(r => r.status === 'rejected').length;

  console.log(`\n✅ Gotowe: ${ok} sukces, ${fail} błąd`);
}

run().catch(console.error);
