/**
 * Initializes a Leaflet map with CartoDB Dark Matter tiles.
 * Reads tile URL and attribution from window.CONFIG.
 * @param {string} elementId - DOM element id
 * @param {{ center?: [number, number], zoom?: number }} options
 * @returns {L.Map}
 */
export function initMap(elementId, { center = [20, 0], zoom = 2, skipTiles = false, zoomControl = true } = {}) {
  const map = L.map(elementId, {
    center,
    zoom,
    zoomControl,
    attributionControl: true,
  });

  if (!skipTiles) {
    const primary = L.tileLayer(window.CONFIG.mapTileUrl, {
      attribution: window.CONFIG.mapAttribution,
      subdomains: window.CONFIG.mapTileSubdomains || 'abc',
      maxZoom: 19,
    }).addTo(map);

    // Fallback to free OSM tiles if primary (MapTiler) fails
    primary.on('tileerror', function onErr() {
      primary.off('tileerror', onErr);
      map.removeLayer(primary);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      }).addTo(map);
    });
  }

  return map;
}

/**
 * Creates a Leaflet DivIcon with player's avatar (photo or initials circle).
 * @param {{ name: string, avatar_data_url: string|null, initials: string, avatar_color: string }} player
 * @param {number} size - diameter in pixels
 * @returns {L.DivIcon}
 */
export function createAvatarIcon(player, size = 36) {
  const inner = player.avatar_data_url
    ? `<img src="${player.avatar_data_url}" style="width:100%;height:100%;object-fit:cover;">`
    : `<span style="font-size:${Math.round(size * 0.38)}px;font-weight:700;color:#fff;">${player.initials}</span>`;

  const html = `
    <div style="
      width:${size}px;height:${size}px;border-radius:50%;
      background:${player.avatar_data_url ? 'transparent' : player.avatar_color};
      border:2.5px solid white;
      box-shadow:0 2px 8px rgba(0,0,0,0.6);
      display:flex;align-items:center;justify-content:center;
      overflow:hidden;
    ">${inner}</div>
    <div style="
      background:rgba(0,0,0,0.82);color:white;
      font-size:11px;padding:3px 8px;border-radius:5px;
      white-space:nowrap;text-align:center;margin-top:3px;
      max-width:90px;overflow:hidden;text-overflow:ellipsis;
    ">${player.name}</div>
  `;

  return L.divIcon({
    html,
    className: '',
    iconSize: [size, size + 22],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -(size / 2)],
  });
}

/**
 * Adds a player pin to the results map with distance label.
 * @param {L.Map} map
 * @param {{ name: string, avatar_data_url: string|null, initials: string, avatar_color: string }} player
 * @param {number} lat
 * @param {number} lng
 * @param {number} distanceKm
 * @returns {L.Marker}
 */
export function addPlayerPin(map, player, lat, lng, distanceKm) {
  const icon = createAvatarIcon(player, 50);
  const distLabel = distanceKm < 1
    ? `${Math.round(distanceKm * 1000)} m`
    : `${Math.round(distanceKm).toLocaleString('pl')} km`;

  const marker = L.marker([lat, lng], { icon }).addTo(map);
  marker.bindTooltip(`${player.name} — ${distLabel}`, { permanent: false, direction: 'top' });
  return marker;
}

/**
 * Draws a dashed polyline from player pin to true location.
 * @param {L.Map} map
 * @param {[number,number]} fromLatLng
 * @param {[number,number]} toLatLng
 * @param {string} color - CSS color
 * @returns {L.Polyline}
 */
export function drawPolyline(map, fromLatLng, toLatLng, color = '#ffffff', distanceKm = null) {
  L.polyline([fromLatLng, toLatLng], {
    color,
    weight: 1.5,
    opacity: 0.55,
    dashArray: '6, 5',
  }).addTo(map);

  if (distanceKm !== null) {
    const midLat = (fromLatLng[0] + toLatLng[0]) / 2;
    const midLng = (fromLatLng[1] + toLatLng[1]) / 2;
    const label = distanceKm < 1
      ? `${Math.round(distanceKm * 1000)} m`
      : `${Math.round(distanceKm).toLocaleString('pl')} km`;
    // Use permanent tooltip — avoids the invisible marker container that renders as a black dot
    L.tooltip({ permanent: true, direction: 'top', className: 'km-dist-tip', offset: [0, 4] })
      .setLatLng([midLat, midLng])
      .setContent(`📏 ${label}`)
      .addTo(map);
  }
}

/**
 * Places the "true answer" star marker at the real GPS location.
 * @param {L.Map} map
 * @param {number} lat
 * @param {number} lng
 * @returns {L.Marker}
 */
export function createTrueLocationMarker(map, lat, lng) {
  const html = `
    <div style="
      width:28px;height:28px;border-radius:50%;
      background:#e91e8c;
      border:3px solid white;
      box-shadow:0 0 18px rgba(255,121,198,0.9);
      display:flex;align-items:center;justify-content:center;
      font-size:14px;
    ">⭐</div>
  `;
  const icon = L.divIcon({ html, className: '', iconSize: [28, 28], iconAnchor: [14, 14] });
  return L.marker([lat, lng], { icon, zIndexOffset: 1000 }).addTo(map);
}
