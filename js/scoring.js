/**
 * Haversine distance between two GPS coordinates, in km.
 */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Points for a guess. Max 5000, 0 at 2500+ km.
 * Formula: max(0, round(5000 - distanceKm * 2))
 */
export function calculatePoints(distanceKm) {
  return Math.max(0, Math.round(5000 - distanceKm * 2));
}
