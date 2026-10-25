import { config } from './config.js';

const TIMEOUT_MS = 15_000;

async function getJson(url, label) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${label} responded ${res.status}`);
  return res.json();
}

export async function geocode(name) {
  const params = new URLSearchParams({ count: 10, language: 'en', name });
  const data = await getJson(`https://geocoding-api.open-meteo.com/v1/search?${params}`, 'Geocoding');
  const results = data.results ?? [];
  // "Pondicherry" resolves to the airport; populated places (PPL*) avoid most of those surprises.
  const best = results.find((r) => r.feature_code?.startsWith('PPL')) ?? results[0];
  if (!best) return null;
  return {
    name: best.name,
    region: [best.admin1, best.country].filter(Boolean).join(', '),
    lat: best.latitude,
    lon: best.longitude,
  };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekdayOf = (date) => WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];

export const isRainy = (day) => day.rainChancePct >= 40 || day.rainMm >= 2;

export async function forecast(place, { from, to, weekendsOnly }) {
  const params = new URLSearchParams({
    latitude: place.lat,
    longitude: place.lon,
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max',
    timezone: 'auto',
    forecast_days: 16,
  });
  const { daily } = await getJson(`https://api.open-meteo.com/v1/forecast?${params}`, 'Forecast');
  const days = daily.time
    .map((date, i) => ({
      date,
      weekday: weekdayOf(date),
      weatherCode: daily.weather_code[i],
      tempMaxC: daily.temperature_2m_max[i],
      tempMinC: daily.temperature_2m_min[i],
      rainMm: daily.precipitation_sum[i] ?? 0,
      rainChancePct: daily.precipitation_probability_max[i] ?? 0,
    }))
    .filter((day) => day.date >= from && day.date <= to)
    .filter((day) => !weekendsOnly || day.weekday === 'Sat' || day.weekday === 'Sun');
  return { days, horizon: daily.time.at(-1) ?? null };
}

export async function places(place, vibe) {
  if (!config.serpapiKey) return [];
  const params = new URLSearchParams({
    engine: 'google_maps',
    type: 'search',
    q: vibe ? `${vibe} places in ${place.name}` : `things to do in ${place.name}`,
    ll: `@${place.lat},${place.lon},13z`,
    api_key: config.serpapiKey,
  });
  try {
    const data = await getJson(`https://serpapi.com/search.json?${params}`, 'SerpApi');
    if (data.error) throw new Error(data.error);
    return (data.local_results ?? []).slice(0, 8).map((p) => ({
      name: p.title,
      type: p.type ?? null,
      rating: p.rating ?? null,
      reviews: p.reviews ?? null,
      price: p.price ?? null,
      address: p.address ?? null,
    }));
  } catch (err) {
    console.warn(`[places] lookup failed for ${place.name}: ${err.message}`);
    return [];
  }
}
