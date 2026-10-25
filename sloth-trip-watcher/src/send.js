import { alertText } from './check.js';
import { config } from './config.js';

// Deliberately loose: the email service does the real validation; this catches typos and junk.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const isEmail = (s) => typeof s === 'string' && s.length <= 254 && EMAIL.test(s);

// POSTs the watch's GO plan to ITINERARY_API_URL. Returns the email service's HTTP status.
export async function sendItinerary(watch, to) {
  const { reason, plan, decidedBy } = watch.lastCheck;
  const res = await fetch(config.itineraryApiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      to,
      subject: `🦥 GO to ${watch.place.name} on ${plan.date}`,
      text: alertText(watch, watch.lastCheck),
      itinerary: { place: watch.place, origin: watch.origin, budgetInr: watch.budgetInr, reason, decidedBy, plan },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`email service returned ${res.status}`);
  return res.status;
}
