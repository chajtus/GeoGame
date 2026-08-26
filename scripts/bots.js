/**
 * Bot script — subscribes to game channel and auto-answers for all bot players.
 * Usage: node scripts/bots.js <session_id>
 */
import { createClient } from '@supabase/supabase-js';

const SESSION_ID = process.argv[2];
if (!SESSION_ID) { console.error('Usage: node scripts/bots.js <session_id>'); process.exit(1); }

const sb = createClient(
  'https://mbhdynfnjfldssrmiqku.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1iaGR5bmZuamZsZHNzcm1pcWt1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY4NjAzMTksImV4cCI6MjEwMjQzNjMxOX0.r2s7qMUvO4RNkJ2Ju272PfDwxUQu7Pfb1YyUo2oFetM'
);

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calculatePoints(distanceKm) {
  return Math.max(0, Math.round(5000 - distanceKm * 2));
}

let botPlayers = [];

const BOT_NAMES = new Set([
  'Kasia','Tomek','Ania','Bartek','Magda','Piotr','Ola','Kamil','Zuzia','Dawid',
  'Ewa','Marcin','Natalia','Jakub','Weronika','Michał','Alicja','Szymon','Hania','Filip',
  'Joasia','Adam','Patrycja','Łukasz','Monika','Rafał','Dominika','Krzysztof','Maja','Sebastian',
  'Karolina','Grzegorz','Izabela','Wojtek','Julia',
]);

const AVATAR_COLORS = ['#e74c3c','#e67e22','#f1c40f','#2ecc71','#1abc9c','#3498db','#9b59b6','#e91e63','#00bcd4','#ff5722'];

function getInitials(name) {
  return name.slice(0, 2).toUpperCase();
}

async function loadBots() {
  const { data } = await sb.from('players').select('id, name').eq('session_id', SESSION_ID);
  botPlayers = (data || []).filter(p => BOT_NAMES.has(p.name));
  const skipped = (data || []).length - botPlayers.length;

  if (botPlayers.length === 0) {
    console.log('Brak botów w sesji — tworzę...');
    const names = [...BOT_NAMES];
    const rows = names.map((name, i) => ({
      session_id: SESSION_ID,
      name,
      initials: getInitials(name),
      avatar_color: AVATAR_COLORS[i % AVATAR_COLORS.length],
    }));
    const { data: inserted, error } = await sb.from('players').insert(rows).select('id, name');
    if (error) { console.error('Błąd tworzenia botów:', error.message); process.exit(1); }
    botPlayers = inserted;
    console.log(`Utworzono ${botPlayers.length} botów`);
  } else {
    console.log(`Załadowano ${botPlayers.length} botów (pominięto ${skipped} prawdziwych graczy)`);
  }
}

async function handleRound(payload) {
  const { question_index, lat: trueLat, lng: trueLng, premium } = payload;
  console.log(`\nRunda ${question_index + 1}${premium ? ' ⭐ PREMIUM' : ''} — odpowiada ${botPlayers.length} botów...`);

  for (const bot of botPlayers) {
    const delay = 2000 + Math.random() * 20000; // 2-22s delay
    setTimeout(async () => {
      // Random offset: some bots are close, some far
      const skill = Math.random(); // 0=bad, 1=good
      const maxOffset = skill < 0.3 ? 30 : skill < 0.7 ? 10 : 3; // degrees offset
      const lat = trueLat + (Math.random() - 0.5) * maxOffset;
      const lng = trueLng + (Math.random() - 0.5) * maxOffset;
      const distanceKm = haversineKm(lat, lng, trueLat, trueLng);
      const basePoints = calculatePoints(distanceKm);
      const points = premium ? basePoints * 2 : basePoints;

      const { error } = await sb.from('pins').insert({
        session_id: SESSION_ID,
        player_id: bot.id,
        question_index,
        lat, lng,
        distance_km: distanceKm,
        points,
      });

      if (!error) {
        try { await sb.rpc('increment_score', { player_id: bot.id, amount: points }); } catch (_) {}
        console.log(`  ✓ ${bot.name}: ${Math.round(distanceKm)} km → ${points} pkt`);
      } else {
        console.log(`  ✗ ${bot.name}: ${error.message}`);
      }
    }, delay);
  }
}

async function main() {
  await loadBots();
  if (!botPlayers.length) { console.error('Brak graczy w sesji'); process.exit(1); }

  const channel = sb.channel(`game:${SESSION_ID}`, { config: { broadcast: { self: false } } });
  channel
    .on('broadcast', { event: 'round_start' }, ({ payload }) => handleRound(payload))
    .on('broadcast', { event: 'round_heartbeat' }, ({ payload }) => {
      // Ignore heartbeats — only respond to round_start
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log(`Nasłuchuję na sesję ${SESSION_ID}...`);
      }
    });
}

main();
