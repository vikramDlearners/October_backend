import { config, telegramConfigured } from './config.js';
import { priceDecision } from './costs.js';
import { decide } from './decide.js';
import { forecast, places } from './sources.js';
import { mutate, readWatches } from './store.js';

// One check per watch at a time, so "Check now" during a scheduled run can't send two alerts.
const running = new Map();

export function runCheck(id) {
  if (!running.has(id)) {
    running.set(id, doCheck(id).finally(() => running.delete(id)));
  }
  return running.get(id);
}

async function doCheck(id) {
  const watch = (await readWatches()).find((w) => w.id === id);
  if (!watch) return null;

  const fc = await forecast(watch.place, watch);
  const found = await places(watch.place, watch.vibe);
  const decision = await priceDecision(watch, await decide(watch, fc, found), fc.days);
  const lastCheck = {
    at: new Date().toISOString(),
    horizon: fc.horizon,
    days: fc.days,
    places: found,
    verdict: decision.verdict,
    reason: decision.reason,
    plan: decision.plan,
    decidedBy: decision.decidedBy,
  };

  let notifiedFor = watch.notifiedFor;
  if (decision.verdict === 'GO' && decision.plan.date !== watch.notifiedFor && telegramConfigured()) {
    try {
      await sendTelegram(alertText(watch, decision));
      notifiedFor = decision.plan.date;
    } catch (err) {
      // Keep the decision; notifiedFor stays put so the next check retries the alert.
      lastCheck.alertError = `Telegram alert not sent: ${err.message}`;
      console.warn(`[telegram] ${watch.place.name}: ${err.message}`);
    }
  }

  return mutate((watches) => {
    const current = watches.find((w) => w.id === id);
    if (!current) return null;
    current.lastCheck = lastCheck;
    current.notifiedFor = notifiedFor;
    return current;
  });
}

const rupees = (n) => `₹${Number(n).toLocaleString('en-IN')}`;

export function alertText(watch, { reason, plan }) {
  const stops = plan.stops.map((s) =>
    `• ${s.time ? `${s.time} ` : ''}${s.name}${s.costInr != null ? ` (${rupees(s.costInr)})` : ''}`,
  );
  return [
    `🦥 GO to ${watch.place.name} on ${plan.date}`,
    reason,
    plan.summary,
    `🚌 ${plan.gettingThere}`,
    ...stops,
    plan.totalInr != null ? `Total ≈ ${rupees(plan.totalInr)}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

async function sendTelegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: config.telegramChatId, text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.ok) return;
  if (res.status === 404) throw new Error('bot token is malformed (Telegram returned 404); paste the full BotFather token');
  const body = await res.json().catch(() => ({}));
  throw new Error(`Telegram returned ${res.status}${body.description ? `: ${body.description}` : ''}`);
}

let checkingAll = false;

export async function checkAll() {
  if (checkingAll) return;
  checkingAll = true;
  try {
    for (const watch of await readWatches()) {
      const label = `${watch.place.name} ${watch.from}..${watch.to}`;
      try {
        const updated = await runCheck(watch.id);
        if (!updated) continue;
        const { verdict, plan, decidedBy, alertError } = updated.lastCheck;
        console.log(`[check] ${label}: ${verdict}${plan ? ` ${plan.date}` : ''} by ${decidedBy}${alertError ? ' (alert failed)' : ''}`);
      } catch (err) {
        console.error(`[check] ${label}: failed: ${err.message}`);
      }
    }
  } finally {
    checkingAll = false;
  }
}
