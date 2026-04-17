export const crimeHotspots = [];

export const accidentHotspots = [];

export function mergeHotspots(crime = [], accidents = []) {
  const allPoints = [...crime, ...accidents];

  return allPoints
    .filter((point) => point && Number.isFinite(point.lat) && Number.isFinite(point.lng))
    .map((point) => ({
      lat: point.lat,
      lng: point.lng,
      weight: Number.isFinite(point.weight) ? point.weight : 1,
    }));
}

export function toLeafletHeatPoints(points = []) {
  return points.map((point) => [point.lat, point.lng, point.weight]);
}
