const $ = (sel) => document.querySelector(sel);

// Tiny element builder; strings become text nodes, so nothing from the API is parsed as HTML.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const rupees = (n) => `₹${Number(n).toLocaleString('en-IN')}`;
const isoDay = (d) => d.toISOString().slice(0, 10);
const shortDate = (s) => new Date(`${s}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

function weatherEmoji(code) {
  if (code === 0) return '☀️';
  if (code <= 2) return '🌤️';
  if (code === 3) return '☁️';
  if (code <= 48) return '🌫️';
  if (code <= 57) return '🌦️';
  if (code <= 67) return '🌧️';
  if (code <= 77) return '❄️';
  if (code <= 82) return '🌦️';
  if (code <= 86) return '🌨️';
  return '⛈️';
}

async function loadHealth() {
  const pills = $('#pills');
  try {
    const health = await api('/api/health');
    const items = [
      ['Gemma', health.gemma, health.gemma ? `Decisions by ${health.gemma}` : 'No Gemini key: simple rules decide'],
      ['Places', health.serpapi, health.serpapi ? 'Google Maps places via SerpApi' : 'No SerpApi key: Gemma uses its own knowledge'],
      ['Telegram', health.telegram, health.telegram ? 'GO alerts go to Telegram' : 'Telegram not configured: no alerts'],
    ];
    pills.replaceChildren(...items.map(([name, on, title]) => h('li', { class: `pill${on ? ' on' : ''}`, title }, name)));
  } catch {
    pills.replaceChildren(h('li', { class: 'pill' }, 'Status unavailable'));
  }
}

function forecastStrip(days, chosenDate) {
  return h('div', { class: 'strip', role: 'list', 'aria-label': 'Forecast for your dates' },
    days.map((d) => h('div', {
      class: `day${d.date === chosenDate ? ' chosen' : ''}`,
      role: 'listitem',
      title: `${d.date}: ${Math.round(d.tempMinC)}–${Math.round(d.tempMaxC)}°C, ${d.rainChancePct}% rain chance, ${d.rainMm} mm`,
    },
      h('div', { class: 'wd' }, d.weekday),
      h('div', {}, shortDate(d.date)),
      h('div', { class: 'emoji', 'aria-hidden': 'true' }, weatherEmoji(d.weatherCode)),
      h('div', {}, `${Math.round(d.tempMaxC)}°`),
      h('div', { class: 'rain' }, `💧${d.rainChancePct}%`),
    )),
  );
}

function planView(plan) {
  return h('div', { class: 'plan' },
    plan.summary && h('p', {}, plan.summary),
    plan.gettingThere && h('p', {}, `🚌 ${plan.gettingThere}`),
    plan.howToGo?.length > 0 && h('ul', { class: 'stops' }, plan.howToGo.map((o) => h('li', { class: 'stop' },
      h('span', { class: 'time' }, o.mode),
      h('span', {}, o.route, h('span', { class: 'note' }, [o.durationMin != null && `${o.durationMin} min one way`, o.tip].filter(Boolean).join(' · '))),
      h('span', { class: 'cost' }, o.costInr != null ? rupees(o.costInr) : ''),
    ))),
    plan.stops.length > 0 && h('ol', { class: 'stops' }, plan.stops.map((s) => h('li', { class: 'stop' },
      h('span', { class: 'time' }, s.time || '—'),
      h('span', {}, s.name, s.note && h('span', { class: 'note' }, s.note)),
      h('span', { class: 'cost' }, s.costInr != null ? rupees(s.costInr) : ''),
    ))),
    plan.packing?.length > 0 && h('p', { class: 'note' }, `🎒 ${plan.packing.map((p) => p.item).join(', ')}`),
    plan.totalInr != null && h('p', { class: 'total' }, `Total ≈ ${rupees(plan.totalInr)}${plan.costsBy ? ` (priced by ${plan.costsBy} with Google Search)` : ''}`),
  );
}

function resultView(check) {
  const go = check.verdict === 'GO';
  const checkedAt = new Date(check.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  return h('div', { class: 'result' },
    h('div', { class: 'verdict' },
      h('span', { class: `badge ${go ? 'go' : 'wait'}` }, go ? 'GO' : 'NOT YET'),
      h('p', { class: 'reason' }, check.reason),
    ),
    check.days.length > 0 && forecastStrip(check.days, check.plan?.date),
    check.plan && planView(check.plan),
    h('p', { class: 'footnote' }, `Checked ${checkedAt} · decided by ${check.decidedBy} · forecast to ${check.horizon ? shortDate(check.horizon) : '—'}`),
    check.alertError && h('p', { class: 'alert-error', role: 'alert' }, check.alertError),
  );
}

function watchCard(watch) {
  const meta = [
    `from ${watch.origin}`,
    `${shortDate(watch.from)} – ${shortDate(watch.to)}`,
    rupees(watch.budgetInr),
    watch.weekendsOnly ? 'weekends' : 'any day',
    watch.noRain ? 'no rain' : 'rain ok',
    watch.vibe,
  ].filter(Boolean).join(' · ');

  const card = h('article', { class: 'card' });
  const checkButton = h('button', { type: 'button', onclick: () => checkNow(watch, card, checkButton) }, 'Check now');
  const deleteButton = h('button', {
    type: 'button', class: 'icon', 'aria-label': `Stop watching ${watch.place.name}`, title: 'Delete',
    onclick: () => remove(watch),
  }, '✕');

  card.append(
    h('div', { class: 'card-head' },
      h('div', {},
        h('h3', {}, watch.place.name, ' ', h('span', { class: 'region' }, watch.place.region)),
        h('p', { class: 'meta' }, meta),
      ),
      h('div', { class: 'actions' }, checkButton, deleteButton),
    ),
    watch.lastCheck
      ? resultView(watch.lastCheck)
      : h('p', { class: 'never' }, 'Not checked yet. It will check on its own, or press Check now.'),
  );
  return card;
}

async function checkNow(watch, card, button) {
  button.disabled = true;
  button.textContent = 'Checking…';
  try {
    card.replaceWith(watchCard(await api(`/api/watches/${watch.id}/check`, { method: 'POST' })));
  } catch (err) {
    button.disabled = false;
    button.textContent = 'Check now';
    alert(err.message);
  }
}

async function remove(watch) {
  if (!confirm(`Stop watching ${watch.place.name}?`)) return;
  try {
    await api(`/api/watches/${watch.id}`, { method: 'DELETE' });
    await loadWatches();
  } catch (err) {
    alert(err.message);
  }
}

async function loadWatches() {
  const list = $('#watches');
  try {
    const watches = await api('/api/watches');
    list.replaceChildren(...(watches.length
      ? watches.map(watchCard)
      : [h('p', { class: 'empty' }, 'No watches yet. Add one and go back to doing nothing. 🦥')]));
  } catch (err) {
    list.replaceChildren(h('p', { class: 'empty' }, `Couldn't load watches: ${err.message}`));
  }
}

function setupForm() {
  const form = $('#watch-form');
  const error = $('#form-error');
  const today = new Date();
  form.from.value = isoDay(today);
  form.to.value = isoDay(new Date(today.getTime() + 14 * 86_400_000));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Finding it on the map…';
    try {
      await api('/api/watches', {
        method: 'POST',
        body: JSON.stringify({
          destination: form.destination.value,
          origin: form.origin.value,
          from: form.from.value,
          to: form.to.value,
          budgetInr: Number(form.budgetInr.value),
          weekendsOnly: form.weekendsOnly.checked,
          noRain: form.noRain.checked,
          vibe: form.vibe.value,
        }),
      });
      form.destination.value = '';
      form.vibe.value = '';
      await loadWatches();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = 'Start watching';
    }
  });
}

setupForm();
loadHealth();
loadWatches();
