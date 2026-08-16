import { readdir, readFile, writeFile } from 'fs/promises';
import { join, dirname, extname, basename } from 'path';
import { fileURLToPath } from 'url';
import exifr from 'exifr';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Read credentials from js/config.js
const configText = await readFile(join(ROOT, 'js', 'config.js'), 'utf8');
const urlMatch = configText.match(/supabaseUrl:\s*'([^']+)'/);
const keyMatch = configText.match(/supabaseAnonKey:\s*'([^']+)'/);
if (!urlMatch || !keyMatch) {
  console.error('❌ Fill in js/config.js first (supabaseUrl + supabaseAnonKey)');
  process.exit(1);
}
const supabase = createClient(urlMatch[1], keyMatch[1]);

const PHOTOS_DIR = join(ROOT, 'photos');
const VALID_EXTS = ['.jpg', '.jpeg', '.JPG', '.JPEG'];
const DELAY_MS = 1100; // Nominatim rate limit: 1 req/sec

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function reverseGeocode(lat, lng) {
  await sleep(DELAY_MS);
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=pl`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'AGA-GEOGUESSER/1.0 (party game)' }
  });
  const data = await res.json();
  const a = data.address || {};
  const parts = [
    a.city || a.town || a.village || a.county,
    a.country
  ].filter(Boolean);
  return parts.join(', ') || data.display_name?.split(',').slice(-3).join(',').trim() || 'Nieznane miejsce';
}

const files = (await readdir(PHOTOS_DIR))
  .filter(f => VALID_EXTS.includes(extname(f)));

if (files.length === 0) {
  console.error('❌ Brak zdjęć w photos/ — wrzuć tam pliki JPG i uruchom ponownie.');
  process.exit(1);
}

console.log(`📷 Znaleziono ${files.length} zdjęć.\n`);

const questions = [];

for (let i = 0; i < files.length; i++) {
  const file = files[i];
  const filePath = join(PHOTOS_DIR, file);
  console.log(`[${i + 1}/${files.length}] Przetwarzam: ${file}`);

  // Extract GPS from EXIF
  let gps;
  try {
    gps = await exifr.gps(filePath);
  } catch (e) {
    console.warn(`  ⚠️  Brak GPS w ${file} — pomijam.`);
    continue;
  }
  if (!gps?.latitude || !gps?.longitude) {
    console.warn(`  ⚠️  Brak współrzędnych GPS w ${file} — pomijam.`);
    continue;
  }
  const { latitude: lat, longitude: lng } = gps;
  console.log(`  📍 GPS: ${lat.toFixed(5)}, ${lng.toFixed(5)}`);

  // Reverse geocode
  let locationName;
  try {
    locationName = await reverseGeocode(lat, lng);
    console.log(`  🌍 Lokalizacja: ${locationName}`);
  } catch (e) {
    locationName = `${lat.toFixed(2)}°N, ${lng.toFixed(2)}°E`;
    console.warn(`  ⚠️  Reverse geocoding nie powiódł się — używam współrzędnych.`);
  }

  // Upload to Supabase Storage
  const storageName = `q${String(i + 1).padStart(2, '0')}_${basename(file)}`;
  const fileBuffer = await readFile(filePath);
  const contentType = 'image/jpeg';

  const { error: uploadError } = await supabase.storage
    .from('photos')
    .upload(storageName, fileBuffer, { contentType, upsert: true });

  if (uploadError) {
    console.error(`  ❌ Upload błąd: ${uploadError.message}`);
    continue;
  }

  const { data: { publicUrl } } = supabase.storage
    .from('photos')
    .getPublicUrl(storageName);

  console.log(`  ✅ Wgrano: ${publicUrl}\n`);

  questions.push({ id: i + 1, photo_url: publicUrl, lat, lng, location_name: locationName });
}

if (questions.length === 0) {
  console.error('❌ Żadne zdjęcie nie miało GPS. Sprawdź zdjęcia i spróbuj ponownie.');
  process.exit(1);
}

await writeFile(join(ROOT, 'questions.json'), JSON.stringify(questions, null, 2), 'utf8');
console.log(`\n🎉 Gotowe! ${questions.length} pytań zapisano do questions.json`);
console.log('   Uruchom: git add questions.json && git commit -m "feat: add questions"');
