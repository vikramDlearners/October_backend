import { config } from './config.js';

const FLASH_TIMEOUT_MS = 90_000;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const inr = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : null);
const str = (v, max = 300) => String(v ?? '').trim().slice(0, max);
const list = (v, max) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object').slice(0, max) : []);

function buildPrompt(watch, plan, day) {
  const weather = day
    ? `${day.weekday}, max ${day.tempMaxC}°C, ${day.rainChancePct}% rain chance, ${day.rainMm} mm`
    : 'unknown';
  const draft = plan.stops.map(({ time, name, note }) => ({ time, name, note }));
  return `You price one day trip in India for a budget traveller. Use Google Search for CURRENT prices: government and private bus fares (TNSTC, SETC, KSRTC, MSRTC and so on), train fares (IRCTC), metro, auto and cab rates, monument and park entry fees for Indian citizens, and typical local food prices.

Trip:
- From: ${watch.origin}
- To: ${watch.place.name}, ${watch.place.region}
- Date: ${plan.date} (${weather})
- Budget: ₹${watch.budgetInr} per person, all-in
- Vibe: ${watch.vibe || 'no preference'}
- Summary so far: ${plan.summary || 'none'}
- Draft stops: ${draft.length ? JSON.stringify(draft) : 'none, pick 3 to 5 real places worth seeing'}

Rules:
- howToGo: 1 to 3 realistic ways to get from ${watch.origin} to ${watch.place.name}, cheapest first. costInr and durationMin are ONE WAY per person.
- stops: keep the draft stops (same names, same order) and give each a start time (HH:MM, 24-hour), a short note and its cost per person (entry fee, food or local transport; 0 if free). Leave time for travel. Add a lunch stop if there isn't one.
- packing: 3 to 6 items for this place and this weather, each with a short reason.
- totalInr: per person, round trip using the FIRST howToGo option, plus every stop cost.
- gettingThere: one line naming the recommended way and its round-trip cost.
- All money is whole rupees. Keep strings short and concrete.

Reply with ONLY this JSON:
{"gettingThere":"...","howToGo":[{"mode":"Bus","route":"...","durationMin":0,"costInr":0,"tip":"..."}],"stops":[{"time":"09:00","name":"...","note":"...","costInr":0}],"packing":[{"item":"...","why":"..."}],"totalInr":0}`;
}

// Gemini Flash with Google Search grounding fills in transport, timings, costs and packing for a GO plan.
// Search grounding and JSON mode don't mix (it stops searching), so the reply is parsed from plain text.
export async function priceTrip(watch, plan, day) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${config.flashModel}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': config.geminiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: buildPrompt(watch, plan, day) }] }],
      tools: [{ google_search: {} }],
      // The default thinking level takes ~90 s with search; "low" takes seconds.
      generationConfig: { temperature: 0.2, thinkingConfig: { thinkingLevel: 'low' } },
    }),
    signal: AbortSignal.timeout(FLASH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Gemini Flash returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Gemini Flash reply had no JSON');
  const reply = JSON.parse(text.slice(start, end + 1));

  const howToGo = list(reply.howToGo, 3).map((o) => ({
    mode: str(o.mode, 40),
    route: str(o.route),
    durationMin: inr(o.durationMin),
    costInr: inr(o.costInr),
    tip: str(o.tip),
  }));
  const stops = list(reply.stops, 8).map((s) => ({
    time: TIME.test(String(s.time ?? '')) ? s.time : null,
    name: str(s.name, 120),
    note: str(s.note),
    costInr: inr(s.costInr),
  })).filter((s) => s.name);
  if (!howToGo.length || !stops.length) throw new Error('Gemini Flash reply had no transport or stops');

  const sources = (candidate.groundingMetadata?.groundingChunks ?? [])
    .map((c) => c.web)
    .filter((w) => w?.uri)
    .slice(0, 5)
    .map((w) => ({ title: str(w.title, 120), url: w.uri }));
  return {
    ...plan,
    gettingThere: str(reply.gettingThere) || plan.gettingThere,
    howToGo,
    stops,
    packing: list(reply.packing, 6).map((p) => ({ item: str(p.item, 80), why: str(p.why) })).filter((p) => p.item),
    totalInr: inr(reply.totalInr) ?? plan.totalInr,
    costsBy: config.flashModel,
    costSources: sources,
  };
}

// Prices a GO decision. Over budget turns it into NOT_YET; a failed lookup keeps the plan unpriced.
export async function priceDecision(watch, decision, days) {
  if (decision.verdict !== 'GO' || !config.geminiKey) return decision;
  let plan;
  try {
    plan = await priceTrip(watch, decision.plan, days.find((d) => d.date === decision.plan.date));
  } catch (err) {
    console.warn(`[costs] ${watch.place.name}: ${err.message}; keeping the plan unpriced`);
    return decision;
  }
  if (plan.totalInr != null && plan.totalInr > watch.budgetInr) {
    return {
      ...decision,
      verdict: 'NOT_YET',
      reason: `The best plan (${plan.date}) costs about ₹${plan.totalInr}, over your ₹${watch.budgetInr} budget. Raise the budget or wait for a cheaper option.`,
      plan: null,
    };
  }
  return { ...decision, plan };
}
