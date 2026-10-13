// GRAFCET rendering (EN 60848 graphical conventions).
//
// Steps are squares, initial steps double-framed, transitions a bar across the link with
// the receptivity beside it, actions a box to the right. The active step carries the
// token — which is the whole reason to draw this at all: you watch the chart move and see
// immediately where a stalled sequence is stuck.

const STEP = 34;
const ACT_W = 92, ACT_H = 20;
const PAD = 24;

/** Where a step's box sits, given its stored position. */
const box = (s) => ({ x: s.x, y: s.y, w: STEP, h: STEP, cx: s.x + STEP / 2, cy: s.y + STEP / 2 });

export function drawGrafcet(svg, chart, { width, height, issues = [], selection = null, linkFrom = null } = {}) {
  if (!chart || !chart.steps.size) {
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.innerHTML = `<text class="gr-empty" x="${width / 2}" y="${height / 2}"
      text-anchor="middle" dominant-baseline="middle">Este circuito ainda não tem um GRAFCET</text>`;
    return;
  }

  const steps = [...chart.steps.values()];
  const trans = [...chart.transitions.values()];
  const flagged = new Set(issues.filter((i) => i.id).map((i) => i.id));

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of steps) {
    x0 = Math.min(x0, s.x); y0 = Math.min(y0, s.y);
    x1 = Math.max(x1, s.x + STEP + ACT_W + 30); y1 = Math.max(y1, s.y + STEP);
  }
  svg.setAttribute('viewBox', `${x0 - PAD} ${y0 - PAD} ${x1 - x0 + PAD * 2} ${y1 - y0 + PAD * 2}`);

  let out = '';

  // Links first, so the step boxes sit on top of them.
  for (const t of trans) {
    const from = t.from.map((id) => chart.steps.get(id)).filter(Boolean);
    const to = t.to.map((id) => chart.steps.get(id)).filter(Boolean);
    if (!from.length || !to.length) continue;

    const fired = chart.lastFired.has(t.id);
    const enabled = t.from.every((s) => chart.active.has(s));
    const ty = t.y ?? (Math.max(...from.map((s) => s.y + STEP)) + Math.min(...to.map((s) => s.y))) / 2;
    const tx = t.x ?? from[0].x + STEP / 2;

    for (const s of from) {
      const b = box(s);
      out += `<path class="gr-link" d="M ${b.cx} ${b.y + b.h} L ${b.cx} ${ty} L ${tx} ${ty}"/>`;
    }
    for (const s of to) {
      const b = box(s);
      out += `<path class="gr-link" d="M ${tx} ${ty} L ${b.cx} ${ty} L ${b.cx} ${b.y}"/>`;
    }
    // Double bar marks a simultaneous (AND) divergence/convergence, per EN 60848.
    const simultaneous = from.length > 1 || to.length > 1;
    const sel = selection?.kind === 'transition' && selection.id === t.id;
    const cls = `gr-bar${fired ? ' fired' : enabled ? ' enabled' : ''}${flagged.has(t.id) ? ' bad' : ''}${sel ? ' sel' : ''}`;
    out += `<line class="${cls}" x1="${tx - 13}" y1="${ty}" x2="${tx + 13}" y2="${ty}"/>`;
    if (simultaneous) out += `<line class="${cls}" x1="${tx - 13}" y1="${ty + 4}" x2="${tx + 13}" y2="${ty + 4}"/>`;
    out += `<text class="gr-recep" x="${tx + 19}" y="${ty + 3}">${esc(t.receptivity)}</text>`;
    // Generous invisible hit strip: a 2px bar is not a click target anyone can hit.
    out += `<rect class="gr-hit" data-tid="${t.id}" x="${tx - 16}" y="${ty - 7}" width="${32 + measure(t.receptivity)}" height="16"/>`;
  }

  for (const s of steps) {
    const b = box(s);
    const active = chart.active.has(s.id);
    const sel = selection?.kind === 'step' && selection.id === s.id;
    const cls = `gr-step${active ? ' active' : ''}${flagged.has(s.id) ? ' bad' : ''}${sel ? ' sel' : ''}${linkFrom === s.id ? ' linking' : ''}`;
    out += `<rect class="${cls}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="2"/>`;
    // Initial step: the inner frame is the EN 60848 mark, not decoration.
    if (s.initial) {
      out += `<rect class="${cls}" x="${b.x + 3}" y="${b.y + 3}" width="${b.w - 6}" height="${b.h - 6}" rx="1"/>`;
    }
    out += `<text class="gr-name" x="${b.cx}" y="${b.cy + 4}" text-anchor="middle">${esc(s.name)}</text>`;
    if (active) out += `<circle class="gr-token" cx="${b.cx}" cy="${b.cy}" r="5"/>`;
    out += `<rect class="gr-hit" data-sid="${s.id}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"/>`;
    // Link handle on the bottom edge. Dragging the step *body* onto another step cannot
    // mean "connect": the body follows the pointer and ends up covering the target, so
    // the gesture is ambiguous by construction. A separate handle makes move and link two
    // different gestures decided at pointer-down, which is what node editors do.
    out += `<circle class="gr-nub" cx="${b.cx}" cy="${b.y + b.h}" r="3.5"/>`;
    out += `<circle class="gr-hit" data-link="${s.id}" cx="${b.cx}" cy="${b.y + b.h}" r="8"/>`;

    // Actions hang to the right of the step.
    s.actions.forEach((a, i) => {
      const ax = b.x + STEP + 14, ay = b.y + i * (ACT_H + 3);
      out += `<line class="gr-link" x1="${b.x + STEP}" y1="${b.cy}" x2="${ax}" y2="${ay + ACT_H / 2}"/>`;
      out += `<rect class="gr-action${active ? ' active' : ''}" x="${ax}" y="${ay}" width="${ACT_W}" height="${ACT_H}" rx="2"/>`;
      const mark = a.kind === 'stored' ? (a.value === false ? 'S↓ ' : 'S↑ ') : '';
      out += `<text class="gr-act-t" x="${ax + 5}" y="${ay + ACT_H / 2 + 3}">${esc(mark + a.target)}</text>`;
    });
  }

  svg.innerHTML = out;
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Rough width of a receptivity label, so its hit strip covers the text too. */
const measure = (s) => String(s).length * 5;

/** Screen point -> the chart's own coordinates. */
export function toChart(svg, clientX, clientY) {
  const p = svg.createSVGPoint();
  p.x = clientX; p.y = clientY;
  const m = svg.getScreenCTM();
  return m ? p.matrixTransform(m.inverse()) : { x: 0, y: 0 };
}

export const STEP_SIZE = STEP;
