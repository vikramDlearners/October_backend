import { config } from './config.js';
import { isRainy } from './sources.js';

const GEMMA_TIMEOUT_MS = 120_000;

// Carries a short reason for the "rules (<why>)" label alongside the full message for the log.
class DecisionError extends Error {
  constructor(short, detail = '') {
    super(detail ? `${short}: ${detail}` : short);
    this.short = short;
  }
}

export async function decide(watch, { days }, places) {
  if (!days.length) {
    return {
      verdict: 'NOT_YET',
      reason: 'None of your dates are inside the 16-day forecast yet.',
      plan: null,
      decidedBy: 'rules (no days in forecast)',
    };
  }
  if (!config.geminiKey) return fallback(watch, days, places, 'no Gemini key');
  try {
    const decision = await askGemma(watch, days, places);
    return { ...decision, decidedBy: config.gemmaModel };
  } catch (err) {
    const short = err.name === 'TimeoutError' ? 'Gemma timed out' : err.short ?? 'Gemma unreachable';
    console.warn(`[decide] ${watch.place.name}: ${err.message}; using rules`);
    return fallback(watch, days, places, short);
  }
}

function buildPrompt(watch, days, places) {
  const { place } = watch;
  return `You are Sloth Trip Watcher. You decide whether a lazy traveller in India should take this trip, so they never have to compare options themselves.

Watch rule:
- Destination: ${place.name}, ${place.region}
- Travelling from: ${watch.origin}
- Dates: any ${watch.weekendsOnly ? 'Saturday or Sunday' : 'day'} from ${watch.from} to ${watch.to}
- Weather rule: ${watch.noRain ? 'NO RAIN. A day is rainy if rainChance >= 40 or rainMm >= 2.' : 'rain is fine'}
- Budget: ₹${watch.budgetInr} per person, all-in (travel both ways, entry fees, food)
- Vibe: ${watch.vibe || 'no preference'}

Candidate days (forecast):
${JSON.stringify(days)}

Places worth seeing (Google Maps):
${places.length ? JSON.stringify(places) : 'none, use your own knowledge'}

Rules:
- Say GO only if at least one candidate day fits the weather rule AND a realistic plan fits the budget.
- Pick exactly ONE day and ONE plan. No alternatives, no "or".
- The plan has 3 to 5 stops in visiting order, each with a start time (HH:MM, 24-hour).
- Use realistic INR costs. totalInr includes getting there and back.
- If NOT_YET, the reason says what would have to change (weather, budget or dates).

Reply with ONLY this JSON and nothing else:
{"verdict":"GO|NOT_YET","reason":"one sentence","plan":null|{"date":"YYYY-MM-DD","summary":"...","gettingThere":"how and rough cost","stops":[{"time":"09:00","name":"...","note":"why go","costInr":0}],"totalInr":0}}`;
}

async function askGemma(watch, days, places) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${config.gemmaModel}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': config.geminiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: buildPrompt(watch, days, places) }] }],
      // "minimal" switches Gemma 4's thinking off (~14s instead of 40-70s); "low" and thinkingBudget are rejected.
      generationConfig: { temperature: 0.3, thinkingConfig: { thinkingLevel: 'minimal' } },
    }),
    signal: AbortSignal.timeout(GEMMA_TIMEOUT_MS),
  });
  if (!res.ok) throw new DecisionError(`Gemma API error ${res.status}`, (await res.text()).slice(0, 300));
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text = parts.filter((p) => !p.thought).map((p) => p.text ?? '').join('');
  return parseDecision(text, days);
}

// Gemma has no JSON mode and likes ```json fences, so take everything from the first "{" to the last "}".
export function parseDecision(text, days) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let reply;
  try {
    if (start < 0 || end < start) throw new Error('no JSON object');
    reply = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new DecisionError('unparseable Gemma reply', text.slice(0, 200));
  }
  if (!reply || !['GO', 'NOT_YET'].includes(reply.verdict)) {
    throw new DecisionError('invalid Gemma reply', 'verdict must be GO or NOT_YET');
  }
  if (reply.verdict === 'NOT_YET') {
    return { verdict: 'NOT_YET', reason: String(reply.reason ?? ''), plan: null };
  }
  const plan = reply.plan;
  if (!plan?.date) throw new DecisionError('invalid Gemma reply', 'GO without plan.date');
  if (!days.some((d) => d.date === plan.date)) {
    throw new DecisionError('invalid Gemma reply', `plan.date ${plan.date} is not a candidate day`);
  }
  return {
    verdict: 'GO',
    reason: String(reply.reason ?? ''),
    plan: {
      date: plan.date,
      summary: String(plan.summary ?? ''),
      gettingThere: String(plan.gettingThere ?? ''),
      stops: (Array.isArray(plan.stops) ? plan.stops : []).map((s) => ({
        time: s.time ?? null,
        name: String(s.name ?? ''),
        note: String(s.note ?? ''),
        costInr: Number.isFinite(Number(s.costInr)) ? Number(s.costInr) : null,
      })),
      totalInr: Number.isFinite(Number(plan.totalInr)) ? Number(plan.totalInr) : null,
    },
  };
}

function fallback(watch, days, places, why) {
  const decidedBy = `rules (${why})`;
  const day = watch.noRain ? days.find((d) => !isRainy(d)) : days[0];
  if (!day) {
    const chances = days.map((d) => `${d.date} ${d.rainChance}%`).join(', ');
    return {
      verdict: 'NOT_YET',
      reason: `Every candidate day looks rainy (${chances}); waiting for a dry one.`,
      plan: null,
      decidedBy,
    };
  }
  return {
    verdict: 'GO',
    reason: watch.noRain ? `${day.date} is the first dry day in your window.` : `${day.date} is the first day in your window.`,
    plan: {
      date: day.date,
      summary: `Day trip to ${watch.place.name}. Picked by simple rules, so check timings and costs yourself.`,
      gettingThere: `From ${watch.origin}; cost not estimated.`,
      stops: places.slice(0, 4).map((p) => ({ time: null, name: p.name, note: p.type ?? '', costInr: null })),
      totalInr: null,
    },
    decidedBy,
  };
}
