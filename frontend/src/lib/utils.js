export function cn(...classes) {
  return classes.filter(Boolean).join(' ');
}

export function calculateGeographicAreaKm2(bbox) {
  if (!bbox || typeof bbox.west !== 'number' || typeof bbox.south !== 'number' ||
      typeof bbox.east !== 'number' || typeof bbox.north !== 'number') {
    return null;
  }
  const { west, south, east, north } = bbox;
  if (east <= west || north <= south) return null;
  if (west < -180 || east > 180 || south < -90 || north > 90) return null;

  const R = 6371; // Earth mean radius in km
  const dRadLon = ((east - west) * Math.PI) / 180;
  const dSinLat = Math.sin((north * Math.PI) / 180) - Math.sin((south * Math.PI) / 180);
  const area = Math.abs(R * R * dRadLon * dSinLat);

  if (!isFinite(area) || area <= 0) return null;
  return area;
}

export function formatGeographicArea(areaKm2) {
  if (areaKm2 === null || areaKm2 === undefined || !isFinite(areaKm2)) return null;
  if (areaKm2 >= 100) return `${areaKm2.toFixed(1)} km²`;
  if (areaKm2 >= 0.01) return `${areaKm2.toFixed(2)} km²`;
  const m2 = areaKm2 * 1000000;
  return `${m2.toFixed(0)} m²`;
}

export default cn;