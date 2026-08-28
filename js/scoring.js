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
 * Points for a guess based on distance thresholds.
 * <10km=10, <20km=9, <50km=8, <100km=5, <300km=4, <500km=3, <1000km=2, <5000km=1, >=5000km=0
 */
export function calculatePoints(distanceKm) {
  if (distanceKm < 10) return 10;
  if (distanceKm < 20) return 9;
  if (distanceKm < 50) return 8;
  if (distanceKm < 100) return 5;
  if (distanceKm < 300) return 4;
  if (distanceKm < 500) return 3;
  if (distanceKm < 1000) return 2;
  if (distanceKm < 5000) return 1;
  return 0;
}
