// App shell: sheet rendering, direct manipulation, inspector, and the run loop.

import { BY_ID, GROUPS, FAULT_LABELS } from './catalog.js';
import { Circuit, EXAMPLES } from './circuit.js';
import { Simulation, barG } from './engine.js';
import { History } from './history.js';
import { Recorder, drawDiagram } from './diagram.js';
import { Panels } from './panels.js';
import { buildParts, partsToCSV, totalParts, DOMAIN_LABEL } from './partslist.js';
import { exportSVG, exportPNG, exportPDF } from './export.js';
import { drawGrafcet, toChart, STEP_SIZE } from './grafcet-view.js';
import { validate as validateChart, receptivityError, Grafcet, ACTION_KINDS } from './grafcet.js';
import {
  Scope, drawScope, cursorReadout, quantitiesFor, readProbe, QUANTITIES, MAX_CHANNELS,
} from './scope.js';
import { GRID, BOX } from './symbols.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const $ = (sel) => document.querySelector(sel);

const el = {
  sheet: $('#sheet'),
  viewport: $('#viewport'),
  wires: $('#layer-wires'),
  parts: $('#layer-parts'),
  ports: $('#layer-ports'),
  overlay: $('#layer-overlay'),
  gridBg: $('#grid-bg'),
  libList: $('#lib-list'),
  libSearch: $('#lib-search'),
  inspector: $('#inspector-body'),
  runBtn: $('#btn-run'),
  runLabel: $('#run-label'),
  simState: $('#sim-state'),
  clock: $('#sim-clock'),
  zoomVal: $('#zoom-out-val'),
  toast: $('#toast'),
  diagram: $('#diagram'),
  diagPanel: $('#diagram-panel'),
  scope: $('#scope'),
  scopeView: $('#scope-view'),
  probeList: $('#probe-list'),
  partsView: $('#parts-view'),
  grafcetView: $('#grafcet-view'),
  grafcet: $('#grafcet'),
  grafcetSide: $('#grafcet-side'),
  canvasWrap: document.querySelector('.canvas-wrap'),
};

const state = {
  circuit: null,
  sim: null,
  tool: 'select',
  selection: new Set(),
  view: { x: 60, y: 30, k: 1 },
  speed: 1,
  drag: null,
  wiring: null,
  selectedWire: null,
  renderedRevision: -1,
  domParts: new Map(),
  history: null,
  rec: new Recorder(),
  panels: null,
  scope: new Scope(),
  tab: 'steps',
  docTitle: 'Esquema',
  grSel: null,      // {kind:'step'|'transition', id}
  grTool: 'select',
  grDrag: null,
  hideFaults: false,
  libDomain: 'all',
};

// ---------------------------------------------------------------- utilities

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const num = (n, d = 2) => n.toFixed(d).replace('.', ',');

/** Pointer capture throws if the pointer is already gone; losing it is never fatal. */
function capture(evt) {
  try { el.sheet.setPointerCapture(evt.pointerId); } catch { /* pointer already released */ }
}

function svgEl(name, attrs = {}) {
  const n = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

let toastTimer;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2200);
}

/** Screen point -> sheet coordinates. */
function toSheet(evt) {
  const r = el.sheet.getBoundingClientRect();
  return {
    x: (evt.clientX - r.left - state.view.x) / state.view.k,
    y: (evt.clientY - r.top - state.view.y) / state.view.k,
  };
}

const snap = (v) => Math.round(v / GRID) * GRID;

/**
 * Maps gauge pressure to the wire colour ramp. This is the app's core readout, so it
 * gets a perceptual-ish blend rather than a raw hex lerp: the midtones of a naive
 * grey->blue interpolation go muddy and the 2-3 bar range becomes unreadable.
 */
/** Hydraulic ramp. Oil works at 10-250 bar, so the pneumatic 0-6 scale would saturate
 *  instantly and every line would read the same. Green->red keeps it distinct from air. */
function hydColor(bar, max = 200) {
  const t = clamp(bar / max, 0, 1);
  const e = Math.pow(t, 0.6);
  const a = [0x8a, 0x93, 0x9b];
  const b = [0xd6, 0x2b, 0x2b];
  const mix = a.map((c, i) => Math.round(Math.sqrt((1 - e) * c * c + e * b[i] * b[i])));
  return `rgb(${mix.join(',')})`;
}

function pressureColor(bar) {
  const t = clamp(bar / 6, 0, 1);
  const e = Math.pow(t, 0.7);
  const a = [0x99, 0xa3, 0xad];
  const b = [0x0b, 0x63, 0xce];
  const mix = a.map((c, i) => Math.round(Math.sqrt((1 - e) * c * c + e * b[i] * b[i])));
  return `rgb(${mix.join(',')})`;
}

// -------------------------------------------------------------- wire routing

/** Orthogonal route between two ports, honouring each port's exit direction. */
function routeWire(a, b, dirA, dirB) {
  const STUB = 9;
  const off = (p, dir, d) => ({
    x: p.x + (dir === 'left' ? -d : dir === 'right' ? d : 0),
    y: p.y + (dir === 'up' ? -d : dir === 'down' ? d : 0),
  });
  const a1 = off(a, dirA, STUB);
  const b1 = off(b, dirB, STUB);

  const vertA = dirA === 'up' || dirA === 'down';
  const vertB = dirB === 'up' || dirB === 'down';

  let pts;
  if (vertA && vertB) {
    const midY = (a1.y + b1.y) / 2;
    pts = [a, a1, { x: a1.x, y: midY }, { x: b1.x, y: midY }, b1, b];
  } else if (!vertA && !vertB) {
    const midX = (a1.x + b1.x) / 2;
    pts = [a, a1, { x: midX, y: a1.y }, { x: midX, y: b1.y }, b1, b];
  } else if (vertA) {
    pts = [a, a1, { x: a1.x, y: b1.y }, b1, b];
  } else {
    pts = [a, a1, { x: b1.x, y: a1.y }, b1, b];
  }

  // Collapse the zero-length segments the general case leaves behind on aligned ports.
  const clean = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 0.01);
  return 'M ' + clean.map((p) => `${p.x} ${p.y}`).join(' L ');
}

function wireLength(c, w) {
  const a = c.portRef(w.from), b = c.portRef(w.to);
  if (!a || !b) return 1;
  return (Math.abs(a.x - b.x) + Math.abs(a.y - b.y)) / 100;
}

// ------------------------------------------------------------------ library

function thumbFor(def) {
  const inst = { id: 'thumb', type: def.id, x: 0, y: 0, rot: 0, sim: {}, params: {} };
  for (const [k, v] of Object.entries(def.params || {})) inst.params[k] = { ...v };
  if (def.initSim) def.initSim(inst);
  const { w, h } = def.size;
  const pad = 12;
  return `<svg viewBox="${-pad} ${-pad - 8} ${w + pad * 2} ${h + pad * 2 + 8}"
    preserveAspectRatio="xMidYMid meet">${def.render(inst)}</svg>`;
}

/**
 * Which domain a group belongs to. Group names carry it, but matching on the name is
 * fragile — so this is the one place that decides, and everything else asks it.
 */
function domainOfGroup(group) {
  if (group.startsWith('Hidráulica')) return 'hyd';
  if (group === 'Elétrica') return 'elec';
  if (group === 'Lógica digital') return 'dig';
  return 'pneu';
}

const LIB_OPEN_KEY = 'fluidlab.lib.open.v1';
const loadOpen = () => {
  try { return new Set(JSON.parse(localStorage.getItem(LIB_OPEN_KEY) || '[]')); }
  catch { return new Set(); }
};
const saveOpen = (set) => {
  try { localStorage.setItem(LIB_OPEN_KEY, JSON.stringify([...set])); } catch { /* private mode */ }
};

function buildLibrary(filter = '') {
  const q = filter.trim().toLowerCase();
  el.libList.innerHTML = '';
  const openSet = loadOpen();
  const first = loadOpen().size === 0; // first run: open one group, not all seventeen
  let shown = 0;

  for (const [group, defs] of GROUPS) {
    if (state.libDomain !== 'all' && domainOfGroup(group) !== state.libDomain) continue;

    const matches = defs.filter((d) =>
      !q || d.name.toLowerCase().includes(q) || d.short.toLowerCase().includes(q) || group.toLowerCase().includes(q));
    if (!matches.length) continue;
    shown += matches.length;

    const details = document.createElement('details');
    details.className = 'lib-group';
    // Searching or filtering means the user is looking for something specific: open what
    // matched. Otherwise honour what they last left open. Opening all 17 groups by
    // default put Elektrik 1600px down a 3900px list — two screens of scrolling to find
    // a pushbutton.
    details.open = q ? true
      : state.libDomain !== 'all' ? true
      : first ? group === 'Atuadores'
      : openSet.has(group);
    details.dataset.group = group;
    details.innerHTML = `<summary>${group}<span class="count">${matches.length}</span></summary>
      <div class="lib-items"></div>`;
    details.addEventListener('toggle', () => {
      const cur = loadOpen();
      if (details.open) cur.add(group); else cur.delete(group);
      saveOpen(cur);
    });
    const items = details.querySelector('.lib-items');

    for (const def of matches) {
      const item = document.createElement('div');
      item.className = 'lib-item';
      item.draggable = true;
      item.title = def.name;
      item.innerHTML = `<div class="chip">${thumbFor(def)}</div><div class="lib-name">${def.short}</div>`;
      item.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', def.id);
        e.dataTransfer.effectAllowed = 'copy';
      });
      item.addEventListener('click', () => {
        // Click-to-place drops into the middle of what the user is currently looking at.
        const r = el.sheet.getBoundingClientRect();
        const p = {
          x: (r.width / 2 - state.view.x) / state.view.k,
          y: (r.height / 2 - state.view.y) / state.view.k,
        };
        const inst = state.circuit.add(def.id, p.x - def.size.w / 2, p.y - def.size.h / 2);
        select([inst.id]);
        render();
        commit();
      });
      items.appendChild(item);
    }
    el.libList.appendChild(details);
  }

  if (!shown) {
    el.libList.innerHTML = `<p class="hint" style="border:0">Nenhum componente encontrado.</p>`;
  }
}

// ------------------------------------------------------------------ drawing

function applyView() {
  const { x, y, k } = state.view;
  el.viewport.setAttribute('transform', `translate(${x},${y}) scale(${k})`);
  // The grid lives outside the viewport so its stroke stays hairline at any zoom.
  el.gridBg.setAttribute('transform', `translate(${x},${y}) scale(${k})`);
  el.zoomVal.textContent = `${Math.round(k * 100)} %`;
}

/** Full structural rebuild. Cheap enough at these sizes; called only on edits. */
function render() {
  const c = state.circuit;
  if (state.sim && state.sim.circuit === c && c.revision !== state.renderedRevision) {
    state.sim.rebuild();
  }
  state.renderedRevision = c.revision;
  state.rec.sync(c);

  el.parts.innerHTML = '';
  el.ports.innerHTML = '';
  state.domParts.clear();

  for (const inst of c.instances) {
    const def = c.defOf(inst);
    const faulty = Object.values(inst.faults || {}).some(Boolean);
    const g = svgEl('g', {
      class: `part${def.interactive ? ' interactive' : ''}${faulty ? ' faulty' : ''}`,
      'data-id': inst.id,
      transform: `translate(${inst.x},${inst.y}) rotate(${inst.rot},${def.size.w / 2},${def.size.h / 2})`,
    });

    const box = svgEl('rect', {
      class: 'sel-box', x: -6, y: -6,
      width: def.size.w + 12, height: def.size.h + 12, rx: 3,
      fill: 'none', stroke: 'none',
    });
    g.appendChild(box);

    const body = svgEl('g', { class: 'body' });
    const html = def.render(inst);
    body.innerHTML = html;
    g.appendChild(body);

    // Invisible hit area: symbols are mostly thin strokes and would be near-impossible
    // to grab otherwise.
    g.appendChild(svgEl('rect', {
      class: 'hit', x: -4, y: -4, width: def.size.w + 8, height: def.size.h + 8,
    }));

    el.parts.appendChild(g);
    state.domParts.set(inst.id, { g, body, def, inst, lastHtml: html });

    for (const port of def.ports) {
      const p = c.portPos(inst, port);
      const wired = c.hasWire(inst.id, port.id);
      const dot = svgEl('circle', {
        class: `port-dot${wired ? '' : ' open'}`,
        cx: p.x, cy: p.y, r: wired ? 2.6 : 3.4,
        'data-inst': inst.id, 'data-port': port.id,
      });
      dot.appendChild(svgEl('title')).textContent = `${inst.params?.tag?.value || def.short} · Conexão ${port.id}`;
      el.ports.appendChild(dot);
    }
  }

  renderWires();
  state.scope.prune(c);
  renderProbes();
  buildProbeList();
  if (state.tab === 'parts') buildPartsList();
  updateSelectionDom();
  updateDynamic();
}

function renderWires() {
  const c = state.circuit;
  el.wires.innerHTML = '';

  const portDirs = new Map();
  for (const inst of c.instances) {
    for (const p of c.defOf(inst).ports) portDirs.set(`${inst.id}:${p.id}`, p);
  }

  const rotDir = (dir, rot) => {
    const order = ['up', 'right', 'down', 'left'];
    const i = order.indexOf(dir);
    return i < 0 ? dir : order[(i + rot / 90) % 4];
  };

  for (const w of c.wires) {
    const a = c.portRef(w.from), b = c.portRef(w.to);
    if (!a || !b) continue;
    const pa = portDirs.get(`${w.from.inst}:${w.from.port}`);
    const pb = portDirs.get(`${w.to.inst}:${w.to.port}`);
    const ia = c.byId(w.from.inst), ib = c.byId(w.to.inst);
    const d = routeWire(a, b, rotDir(pa.dir, ia.rot), rotDir(pb.dir, ib.rot));
    w.length = wireLength(c, w);

    const hit = svgEl('path', { class: 'wire-hit', d, 'data-wire': w.id });
    const line = svgEl('path', { class: `wire ${w.kind}`, d, 'data-wire-line': w.id });
    el.wires.appendChild(hit);
    el.wires.appendChild(line);
  }

  // Junction dots wherever three or more conductors meet — the standard tee mark.
  const counts = new Map();
  for (const w of c.wires) {
    for (const ref of [w.from, w.to]) {
      const k = `${ref.inst}:${ref.port}`;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  for (const [k, n] of counts) {
    if (n < 2) continue;
    const [instId, portId] = k.split(':');
    const p = c.portRef({ inst: instId, port: portId });
    if (!p) continue;
    el.wires.appendChild(svgEl('circle', {
      class: 'junction', cx: p.x, cy: p.y, r: 3.2,
      'data-jn-inst': instId, 'data-jn-port': portId,
    }));
  }
}

/** Per-frame refresh of anything the solver moved. */
function updateDynamic() {
  const sim = state.sim;

  for (const dom of state.domParts.values()) {
    const { body, def, inst } = dom;
    if (def.geom) {
      // Valve: keep the DOM node alive so the spool slide can be a CSS transition.
      const spool = body.querySelector('.spool');
      if (spool) spool.setAttribute('transform', `translate(${-(inst.sim.state ?? 0) * BOX},0)`);
      continue;
    }
    // Re-render only when the markup actually differs. Building the string is cheap;
    // reparsing it into the DOM 60x a second for every static symbol is not, and it
    // would also restart any CSS transition on the nodes it replaces.
    const html = def.render(inst);
    if (html !== dom.lastHtml) {
      body.innerHTML = html;
      dom.lastHtml = html;
    }
  }

  if (!sim) return;
  // Note: these must be inline styles, not presentation attributes — the .wire class
  // rule in the stylesheet outranks any attribute, so setAttribute('stroke', …) would
  // silently do nothing and every line would stay grey.
  for (const w of state.circuit.wires) {
    const node = el.wires.querySelector(`[data-wire-line="${w.id}"]`);
    if (!node) continue;
    if (w.kind === 'electric') {
      const i = sim.elecIndex(w.from.inst, w.from.port);
      const live = (i == null ? 0 : sim.v[i]) > 5;
      node.style.stroke = live ? 'var(--live)' : '';
      node.style.strokeWidth = live ? '2.4' : '';
    } else if (w.kind === 'hydraulic') {
      const i = sim.hydIndex(w.from.inst, w.from.port);
      const bar = i == null ? 0 : barG(sim.ph[i]);
      node.style.stroke = hydColor(bar);
      node.style.strokeWidth = String(2.4 + clamp(bar / 200, 0, 1) * 1.6);
    } else {
      const i = sim.netIndex(w.from.inst, w.from.port);
      const bar = i == null ? 0 : barG(sim.p[i]);
      node.style.stroke = pressureColor(bar);
      node.style.strokeWidth = String(2 + clamp(bar / 6, 0, 1) * 1.4);
    }
  }

  // Tee dots read the same pressure as the lines they join, otherwise a pressurised
  // manifold shows black blobs on blue wire.
  for (const dot of el.wires.querySelectorAll('.junction')) {
    const instId = dot.dataset.jnInst, portId = dot.dataset.jnPort;
    const pn = sim.netIndex(instId, portId);
    if (pn != null) { dot.style.fill = pressureColor(barG(sim.p[pn])); continue; }
    const hn = sim.hydIndex(instId, portId);
    if (hn != null) { dot.style.fill = hydColor(barG(sim.ph[hn])); continue; }
    const en = sim.elecIndex(instId, portId);
    if (en != null) dot.style.fill = sim.v[en] > 5 ? 'var(--live)' : '#5a646d';
  }
}

/** Force a part's symbol to redraw now, keeping the render cache honest. */
function redrawPart(inst) {
  const dom = state.domParts.get(inst.id);
  if (!dom) return;
  dom.lastHtml = dom.def.render(inst);
  dom.body.innerHTML = dom.lastHtml;
}

function updateSelectionDom() {
  for (const [id, { g }] of state.domParts) {
    g.classList.toggle('selected', state.selection.has(id));
  }
  for (const n of el.wires.querySelectorAll('.wire')) {
    n.classList.toggle('sel', n.dataset.wireLine === state.selectedWire);
  }
}

// ------------------------------------------------------------------- probes

/**
 * Attaches a virtual probe. Probes read solved state only — they never enter the net
 * graph, which is how the "must not influence the circuit" requirement is actually
 * guaranteed rather than merely intended.
 */
function addProbeAt(portEl) {
  const instId = portEl.dataset.inst, portId = portEl.dataset.port;
  const opts = quantitiesFor(state.circuit, instId, portId);
  if (!opts.length) { toast('Não há grandezas mensuráveis nesta conexão'); return; }

  const existing = state.scope.probes.find((p) => p.inst === instId && p.port === portId);
  if (existing) { toast('Já existe uma sonda nesta conexão'); return; }

  const inst = state.circuit.byId(instId);
  const tag = inst.params?.tag?.value ?? state.circuit.defOf(inst).short;
  const probe = state.scope.addProbe(instId, portId, opts[0], `${tag}:${portId}`);
  if (!probe) { toast('Limite de 8 sondas'); return; }

  buildProbeList();
  renderProbes();
  setPanelTab('scope');
  toast(`Sonda em ${probe.label} — ${QUANTITIES[opts[0]].label}`);
}

/** Probe markers ride on the sheet at their port, showing the live value. */
function renderProbes() {
  el.overlay.querySelectorAll('.probe-marker').forEach((n) => n.remove());
  for (const probe of state.scope.probes) {
    const p = state.circuit.portRef({ inst: probe.inst, port: probe.port });
    if (!p) continue;
    const g = svgEl('g', { class: 'probe-marker', 'data-probe': probe.id });
    const dot = svgEl('circle', { cx: p.x, cy: p.y, r: 4.5 });
    dot.style.fill = probe.color;
    g.appendChild(dot);
    const label = svgEl('text', { x: p.x + 7, y: p.y - 5 });
    label.textContent = probe.label;
    g.appendChild(label);
    const val = svgEl('text', { x: p.x + 7, y: p.y + 5, 'data-probe-val': probe.id });
    g.appendChild(val);
    el.overlay.appendChild(g);
  }
  updateProbeValues();
}

function fmtProbe(probe, v) {
  if (v == null) return '—';
  const q = QUANTITIES[probe.quantity];
  const dec = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
  return `${num(v, dec)} ${q.unit}`;
}

function updateProbeValues() {
  if (!state.sim) return;
  for (const probe of state.scope.probes) {
    const v = readProbe(state.sim, probe);
    const node = el.overlay.querySelector(`[data-probe-val="${probe.id}"]`);
    if (node) node.textContent = fmtProbe(probe, v);
    const cell = el.probeList.querySelector(`[data-probe-cell="${probe.id}"]`);
    if (cell) cell.textContent = fmtProbe(probe, v);
  }
}

function buildProbeList() {
  const s = state.scope;
  if (!s.probes.length) {
    el.probeList.innerHTML = `<p class="probe-empty">Nenhuma sonda.<br><br>
      Selecione <strong>Sonda</strong> (<kbd>P</kbd>) e clique em uma conexão.
      As sondas apenas medem e não interferem no circuito.</p>`;
    return;
  }
  let html = '';
  for (const probe of s.probes) {
    const ch = s.channels.indexOf(probe.id);
    const opts = quantitiesFor(state.circuit, probe.inst, probe.port);
    html += `<div class="probe-row">
      <span class="probe-swatch" style="background:${probe.color}"></span>
      <select class="probe-ch" data-ch-for="${probe.id}" title="Canal">
        <option value="-1"${ch < 0 ? ' selected' : ''}>–</option>
        ${Array.from({ length: MAX_CHANNELS }, (_, i) =>
          `<option value="${i}"${ch === i ? ' selected' : ''}>${i + 1}</option>`).join('')}
      </select>
      <span class="probe-name" title="${probe.label}">${probe.label}</span>
      <span class="probe-val" data-probe-cell="${probe.id}">—</span>
      <button class="probe-x" data-drop="${probe.id}" title="Remover sonda">×</button>
    </div>`;
    if (opts.length > 1) {
      html += `<div class="probe-row" style="padding-top:0">
        <span style="width:8px"></span>
        <select class="probe-ch" data-q-for="${probe.id}" style="flex:1">
          ${opts.map((o) => `<option value="${o}"${o === probe.quantity ? ' selected' : ''}>${QUANTITIES[o].label}</option>`).join('')}
        </select>
      </div>`;
    }
  }

  const cur = cursorReadout(s);
  if (cur) {
    html += `<div class="cursor-readout"><span class="dt">Δt = ${num(cur.dt * 1000, 0)} ms</span>`;
    for (const r of cur.rows) {
      html += `<div class="row"><span style="color:${r.color}">${r.label}</span>
        <span>Δ ${num(r.d, 2)} ${r.unit}</span></div>`;
    }
    html += `</div>`;
  }

  el.probeList.innerHTML = html;

  el.probeList.querySelectorAll('[data-drop]').forEach((b) => b.addEventListener('click', () => {
    state.scope.removeProbe(b.dataset.drop);
    buildProbeList(); renderProbes(); buildTriggerSources(); redrawScope();
  }));
  el.probeList.querySelectorAll('[data-ch-for]').forEach((sel) => sel.addEventListener('change', () => {
    const id = sel.dataset.chFor;
    const want = parseInt(sel.value, 10);
    state.scope.channels = state.scope.channels.map((c) => (c === id ? null : c));
    if (want >= 0) {
      while (state.scope.channels.length <= want) state.scope.channels.push(null);
      state.scope.channels[want] = id;
    }
    state.scope.syncColors();
    buildProbeList(); renderProbes(); buildTriggerSources(); redrawScope();
  }));
  el.probeList.querySelectorAll('[data-q-for]').forEach((sel) => sel.addEventListener('change', () => {
    const probe = state.scope.probes.find((p) => p.id === sel.dataset.qFor);
    if (!probe) return;
    probe.quantity = sel.value;
    // The old samples are a different quantity entirely; keeping them would draw a lie.
    state.scope.clear();
    buildProbeList(); redrawScope();
  }));
}

function buildTriggerSources() {
  const sel = $('#scope-trigsrc');
  const s = state.scope;
  sel.innerHTML = Array.from({ length: MAX_CHANNELS }, (_, i) => {
    const p = s.probeOf(i);
    return `<option value="${i}"${s.trigger.source === i ? ' selected' : ''}>
      Canal ${i + 1}${p ? ` ${p.label}` : ''}</option>`;
  }).join('');
}

function redrawScope() {
  if (state.tab !== 'scope' || el.diagPanel.classList.contains('collapsed')) return;
  const r = el.scope.getBoundingClientRect();
  if (r.width < 10) return;
  drawScope(el.scope, state.scope, { width: r.width, height: r.height });
  bindCursorDrag();
}

/** Cursors are dragged directly on the trace, which is how a scope is actually read. */
function bindCursorDrag() {
  el.scope.querySelectorAll('[data-cursor]').forEach((n) => {
    if (n.tagName !== 'rect') return;
    n.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const which = n.dataset.cursor;
      const rect = el.scope.getBoundingClientRect();
      const move = (ev) => {
        const frac = (ev.clientX - rect.left - 44) / Math.max(10, rect.width - 54);
        state.scope.cursors[which] = clamp(frac, 0, 1);
        redrawScope();
        buildProbeList();
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  });
}

function setPanelTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.panel-tab').forEach((b) =>
    b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  document.querySelectorAll('[data-for]').forEach((g) => { g.hidden = g.dataset.for !== tab; });
  // `hidden` is an HTMLElement property — assigning it on an <svg> only creates a dead
  // expando, so the step diagram kept drawing underneath the scope. A class works for
  // both element types.
  el.diagram.classList.toggle('is-hidden', tab !== 'steps');
  el.scopeView.classList.toggle('is-hidden', tab !== 'scope');
  el.partsView.classList.toggle('is-hidden', tab !== 'parts');
  el.grafcetView.classList.toggle('is-hidden', tab !== 'grafcet');
  if (tab === 'parts') buildPartsList();
  redrawGrafcet();
  if (el.diagPanel.classList.contains('collapsed')) {
    el.diagPanel.classList.remove('collapsed');
    el.canvasWrap.classList.remove('diagram-collapsed');
    $('#diag-toggle').textContent = '▾';
  }
  redrawDiagram();
  redrawScope();
}

// ---------------------------------------------------------------- selection

function select(ids, additive = false) {
  if (!additive) state.selection.clear();
  state.selectedWire = null;
  for (const id of ids) state.selection.add(id);
  updateSelectionDom();
  buildInspector();
}

function selectWire(id) {
  state.selection.clear();
  state.selectedWire = id;
  updateSelectionDom();
  el.inspector.innerHTML = `
    <h3 class="insp-title">Conexão</h3>
    <p class="insp-sub">selecionada</p>
    <div class="insp-empty" style="padding:0 0 12px">
      Remova com <kbd>Delete</kbd>.
    </div>
    <div class="insp-actions">
      <button class="btn btn-danger" data-act="delete">Excluir conexão</button>
    </div>`;
  wireInspectorActions();
}

function hitPart(evt) {
  const g = evt.target.closest('.part');
  return g ? g.dataset.id : null;
}

// ---------------------------------------------------------------- inspector

function buildInspector() {
  const ids = [...state.selection];
  if (ids.length === 0) { buildEmptyInspector(); return; }
  if (ids.length > 1) {
    el.inspector.innerHTML = `<div class="insp-empty"><strong>${ids.length} componentes selecionados</strong>
      Selecione um único componente para editar seus parâmetros.</div>
      <div class="insp-actions"><button class="btn btn-danger" data-act="delete">Excluir</button></div>`;
    wireInspectorActions();
    return;
  }

  const inst = state.circuit.byId(ids[0]);
  if (!inst) return;
  const def = state.circuit.defOf(inst);

  let html = `<h3 class="insp-title">${def.name}</h3>
    <p class="insp-sub">${inst.params?.tag?.value ?? def.short} · ${def.id}</p>`;

  for (const [key, p] of Object.entries(inst.params)) {
    html += `<div class="field" data-key="${key}">`;
    if (p.type === 'range') {
      const shown = p.unit ? `${num(p.value, p.step < 1 ? 2 : 0)} ${p.unit}` : num(p.value, 2);
      html += `<div class="field-label"><span>${p.label}</span><span class="field-value">${shown}</span></div>
        <input type="range" min="${p.min}" max="${p.max}" step="${p.step}" value="${p.value}">`;
    } else if (p.type === 'text') {
      html += `<div class="field-label"><span>${p.label}</span></div>
        <input type="text" value="${p.value ?? ''}">`;
    } else if (p.type === 'select') {
      html += `<div class="field-label"><span>${p.label}</span></div><select>`
        + p.options.map((o) => `<option value="${o.value}"${o.value === p.value ? ' selected' : ''}>${o.label}</option>`).join('')
        + `</select>`;
    } else if (p.type === 'cylinder') {
      const cyls = state.circuit.instances.filter((i) => i.type.startsWith('cyl_'));
      html += `<div class="field-label"><span>${p.label}</span></div><select>
        <option value="">— não associado —</option>`
        + cyls.map((cy) => `<option value="${cy.id}"${cy.id === p.value ? ' selected' : ''}>${cy.params.tag.value}</option>`).join('')
        + `</select>`;
      if (!cyls.length) html += `<p class="hint" style="border:0;padding:6px 0 0">Primeiro adicione um cilindro.</p>`;
    }
    html += `</div>`;
  }

  if (def.faultTypes?.length) {
    const armed = def.faultTypes.filter((f) => inst.faults?.[f]).length;
    html += `<div class="faults">
      <div class="faults-head">
        <span>Simulação de falhas</span>
        ${armed ? `<span class="armed">${armed} ativas</span>` : ''}
      </div>`;
    for (const f of def.faultTypes) {
      html += `<label class="fault-row">
        <input type="checkbox" data-fault="${f}"${inst.faults?.[f] ? ' checked' : ''}>
        <span>${FAULT_LABELS[f] ?? f}</span>
      </label>`;
    }
    html += `</div>`;
  }

  html += `<div class="readouts" id="readouts"></div>
    <div class="insp-actions">
      <button class="btn btn-ghost" data-act="rotate">Girar</button>
      <button class="btn btn-danger" data-act="delete">Excluir</button>
    </div>`;

  el.inspector.innerHTML = html;

  el.inspector.querySelectorAll('[data-fault]').forEach((box) => {
    box.addEventListener('change', () => {
      inst.faults = { ...inst.faults, [box.dataset.fault]: box.checked };
      // Defects change what the circuit *is*, not just how it looks, so the sheet has
      // to re-mark the part and the history has to record it.
      render();
      buildInspector();
      commit();
    });
  });

  el.inspector.querySelectorAll('.field').forEach((field) => {
    const key = field.dataset.key;
    const p = inst.params[key];
    const input = field.querySelector('input, select');
    if (!input) return;
    input.addEventListener('input', () => {
      if (p.type === 'range') {
        p.value = parseFloat(input.value);
        const shown = p.unit ? `${num(p.value, p.step < 1 ? 2 : 0)} ${p.unit}` : num(p.value, 2);
        field.querySelector('.field-value').textContent = shown;
        redrawPart(inst);
      } else if (p.type === 'cylinder') {
        p.value = input.value || null;
      } else {
        p.value = input.value;
        redrawPart(inst);
      }
      commit(`param:${inst.id}:${key}`);
    });
  });

  wireInspectorActions();
  updateReadouts();
}

/**
 * The empty state carries its weight instead of apologising: it reports what is on the
 * sheet, flags what is obviously wrong with it, and only then lists the shortcuts. An
 * inspector with nothing selected is the panel's most common state, so it should still
 * tell the user something they did not already know.
 */
function buildEmptyInspector() {
  const c = state.circuit;
  const counts = { pneumatic: 0, electric: 0, hydraulic: 0 };
  for (const inst of c.instances) {
    const def = c.defOf(inst);
    if (!def) continue;
    // Count by the domain the component's ports actually live in, not by its group name.
    const kinds = new Set(def.ports.map((p) => p.kind || 'pneumatic'));
    if (kinds.has('hydraulic')) counts.hydraulic++;
    else if (def.group === 'Elétrica') counts.electric++;
    else counts.pneumatic++;
  }

  const issues = checkCircuit(c);
  const armed = c.instances.filter((i) => Object.values(i.faults || {}).some(Boolean));

  const stat = (label, value) =>
    `<div class="stat"><span class="stat-v">${value}</span><span class="stat-l">${label}</span></div>`;

  let html = `
    <div class="empty-hero">
      <svg class="empty-mark" viewBox="0 0 48 32" aria-hidden="true">
        <rect x="1" y="7" width="14" height="14" rx="1.5"/>
        <rect x="15" y="7" width="14" height="14" rx="1.5"/>
        <path d="M5 21 L5 11 M11 11 L11 21 M19 21 L19 11 M25 11 L25 21"/>
        <path d="M33 14 L33 9 M33 19 L33 24"/>
        <path d="M38 16 L46 16"/>
      </svg>
      <p>Nenhum componente selecionado</p>
    </div>

    <div class="stats">
      ${stat('Pneumática', counts.pneumatic)}
      ${counts.hydraulic ? stat('Hidráulica', counts.hydraulic) : stat('Elétrica', counts.electric)}
      ${stat('Conexões', c.wires.length)}
      ${stat('Redes', state.sim
        ? state.sim.nets.count + state.sim.elec.count + state.sim.hyd.count : 0)}
    </div>`;

  if (armed.length) {
    html += `<div class="empty-block warn">
      <span class="block-title">${armed.length} falhas ativadas</span>
      <ul class="issue-list">`;
    for (const inst of armed.slice(0, 6)) {
      html += `<li><button class="issue" data-goto="${inst.id}">${inst.params?.tag?.value ?? inst.type}</button></li>`;
    }
    html += `</ul></div>`;
  }

  if (issues.length) {
    html += `<div class="empty-block">
      <span class="block-title">Verificação</span>
      <ul class="issue-list">`;
    for (const it of issues.slice(0, 8)) {
      html += `<li><button class="issue" data-goto="${it.id ?? ''}">
        <span class="dot ${it.level}"></span>${it.text}</button></li>`;
    }
    html += `</ul></div>`;
  } else if (c.instances.length) {
    html += `<div class="empty-block ok">
      <span class="block-title">Verificação</span>
      <p class="block-note">Nenhum problema encontrado.</p>
    </div>`;
  }

  html += `<div class="empty-block">
    <span class="block-title">Atalhos</span>
    <dl class="keys">
      <dt><kbd>V</kbd><kbd>W</kbd></dt><dd>Seleção · Conexão</dd>
      <dt><kbd>R</kbd></dt><dd>Girar componente</dd>
      <dt><kbd>Delete</kbd></dt><dd>Excluir</dd>
      <dt><kbd>⌘Z</kbd></dt><dd>Desfazer</dd>
      <dt><kbd>Espaço</kbd></dt><dd>Iniciar / Pausar</dd>
      <dt><kbd>Esc</kbd></dt><dd>Parar</dd>
    </dl>
    <p class="block-note">Arraste um ponto de conexão para conectar dois componentes. Durante a
      simulação, os botões e as alavancas podem ser acionados por clique.</p>
  </div>`;

  el.inspector.innerHTML = html;
  el.inspector.querySelectorAll('[data-goto]').forEach((b) => {
    b.addEventListener('click', () => {
      const id = b.dataset.goto;
      if (!id) return;
      select([id]);
      centerOn(id);
    });
  });
}

/**
 * Static checks a user can act on. Deliberately conservative: a false warning on a
 * correct circuit trains people to ignore the panel, so this only reports things that
 * are unambiguously mistakes.
 */
function checkCircuit(c) {
  const out = [];
  if (!c.instances.length) return out;

  /** Does any component actually have a port in this domain? */
  const usesDomain = (kind) => c.instances.some((i) => {
    const def = c.defOf(i);
    return def?.ports.some((p) => (p.kind || 'pneumatic') === kind);
  });

  // Only complain about a missing source in a domain the sheet actually uses. Flagging a
  // hydraulic circuit for having no compressed air is the kind of false warning that
  // teaches people to stop reading this panel.
  const airParts = c.instances.filter((i) => {
    const def = c.defOf(i);
    return def?.ports.some((p) => (p.kind || 'pneumatic') === 'pneumatic') && i.type !== 'supply';
  });
  if (airParts.length && !c.instances.some((i) => i.type === 'supply')) {
    out.push({ level: 'err', text: 'Falta uma fonte de ar comprimido no esquema' });
  }
  if (usesDomain('hydraulic')) {
    if (!c.instances.some((i) => i.type === 'h_pump')) {
      out.push({ level: 'err', text: 'Falta uma bomba hidráulica no esquema' });
    }
    if (!c.instances.some((i) => i.type === 'h_tank')) {
      out.push({ level: 'err', text: 'Falta um reservatório no esquema' });
    }
    if (!c.instances.some((i) => i.type === 'h_relief')) {
      // Not cosmetic: a fixed pump deadheading into a closed circuit has nothing to
      // limit it but its own leakage.
      out.push({ level: 'warn', text: 'Falta uma válvula de alívio — pressão do sistema sem limite' });
    }
  }

  // Duplicate tags: harmless on the sheet, but they break coil/contact pairing.
  const seen = new Map();
  for (const inst of c.instances) {
    const tag = inst.params?.tag?.value;
    if (!tag) continue;
    const def = c.defOf(inst);
    if (def?.id === 'contact_no' || def?.id === 'contact_nc') continue; // contacts share a coil's tag by design
    if (seen.has(tag)) out.push({ level: 'warn', text: `Identificação ${tag} duplicada`, id: inst.id });
    else seen.set(tag, inst.id);
  }

  // Coils and contacts that reference nothing.
  const coils = new Set(c.instances.filter((i) => c.defOf(i)?.coilLike).map((i) => i.params.tag.value));
  for (const inst of c.instances) {
    if (inst.type !== 'contact_no' && inst.type !== 'contact_nc') continue;
    const tag = inst.params.tag.value;
    if (!coils.has(tag)) out.push({ level: 'warn', text: `Contato ${tag} sem bobina associada`, id: inst.id });
  }

  // Limit switches that were never bound to a cylinder do nothing at all.
  for (const inst of c.instances) {
    if (!inst.params?.target) continue;
    if (!inst.params.target.value) {
      out.push({ level: 'warn', text: `${inst.params.tag?.value ?? inst.type}: nenhum cilindro associado`, id: inst.id });
    }
  }

  // Tags a GRAFCET reads or writes. Those components are wired *by name*, so an
  // unconnected sensor in a chart-driven circuit is correct, not a mistake — flagging it
  // is the kind of false warning that teaches people to stop reading this panel.
  const chartTags = new Set();
  if (c.chart) {
    for (const t of c.chart.transitions.values()) {
      for (const m of String(t.receptivity).matchAll(/[A-Za-z_][\w.]*/g)) chartTags.add(m[0]);
    }
    for (const st of c.chart.steps.values()) for (const a of st.actions) chartTags.add(a.target);
  }

  // Unconnected ports that are not meant to breathe.
  for (const inst of c.instances) {
    const def = c.defOf(inst);
    if (!def) continue;
    const tag = inst.params?.tag?.value;
    if (tag && chartTags.has(tag)) continue;
    // A solenoid valve's coil is addressed by tag too, wired or not.
    if (inst.params?.solA && chartTags.has(inst.params.solA.value)) continue;
    const loose = def.ports.filter((p) => !p.vent && !c.hasWire(inst.id, p.id));
    if (loose.length === def.ports.length && def.ports.length) {
      out.push({ level: 'warn', text: `${tag ?? def.short} não está conectado`, id: inst.id });
    }
  }
  return out;
}

/** Brings a component into view without changing the zoom. */
function centerOn(id) {
  const inst = state.circuit.byId(id);
  if (!inst) return;
  const b = state.circuit.bounds(inst);
  const r = el.sheet.getBoundingClientRect();
  const usableH = r.height - (el.diagPanel?.offsetHeight ?? 0);
  state.view.x = r.width / 2 - (b.x + b.w / 2) * state.view.k;
  state.view.y = usableH / 2 - (b.y + b.h / 2) * state.view.k;
  applyView();
}

function wireInspectorActions() {
  el.inspector.querySelectorAll('[data-act]').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.dataset.act === 'delete') deleteSelection();
      if (b.dataset.act === 'rotate') rotateSelection();
    });
  });
}

/** Live values for the selected component — the reason to keep a part selected while running. */
function updateReadouts() {
  const host = $('#readouts');
  if (!host || state.selection.size !== 1) return;
  const inst = state.circuit.byId([...state.selection][0]);
  if (!inst) return;
  const def = state.circuit.defOf(inst);
  const sim = state.sim;
  if (!sim) { host.innerHTML = ''; return; }

  let rows = '';
  if (inst.sim?.x != null) {
    const pct = Math.round(inst.sim.x * 100);
    rows += `<div class="readout"><span>Posição do curso</span><span>${pct} %</span></div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="readout"><span>Velocidade</span><span>${num(inst.sim.v * 1000, 0)} mm/s</span></div>`;
  }
  if (inst.sim?.state != null) {
    rows += `<div class="readout"><span>Posição de comutação</span><span>${inst.sim.state}</span></div>`;
  }
  if (inst.sim?.on != null) {
    rows += `<div class="readout"><span>Estado</span><span>${inst.sim.on ? 'energizado' : 'desenergizado'}</span></div>`;
  }
  for (const p of def.ports) {
    if ((p.kind || 'pneumatic') !== 'pneumatic') continue;
    rows += `<div class="readout"><span>Pressão ${p.id}</span><span>${num(sim.gauge(inst.id, p.id))} bar</span></div>`;
  }
  for (const p of def.ports) {
    if (p.kind !== 'hydraulic') continue;
    rows += `<div class="readout"><span>Pressão do óleo ${p.id}</span><span>${num(sim.hgauge(inst.id, p.id), 1)} bar</span></div>`;
  }
  for (const p of def.ports) {
    if (p.kind !== 'electric') continue;
    const i = sim.elecIndex(inst.id, p.id);
    rows += `<div class="readout"><span>Potencial ${p.id}</span><span>${num(i == null ? 0 : sim.v[i], 1)} V</span></div>`;
  }
  host.innerHTML = rows;
}

// ------------------------------------------------------------------ editing

/**
 * Records an undo point. `tag` coalesces a burst of related edits (a slider drag, a
 * part nudge) into a single step; omit it to force a discrete step.
 */
function commit(tag = null) {
  state.history.push(state.circuit, tag);
  refreshHistoryButtons();
}

function refreshHistoryButtons() {
  $('#btn-undo').disabled = !state.history.canUndo;
  $('#btn-redo').disabled = !state.history.canRedo;
}

function undo() {
  const c = state.history.undo();
  if (!c) return;
  applyCircuit(c);
  refreshHistoryButtons();
  toast('Desfazer');
}

function redo() {
  const c = state.history.redo();
  if (!c) return;
  applyCircuit(c);
  refreshHistoryButtons();
  toast('Refeito');
}

function deleteSelection() {
  if (state.selectedWire) {
    state.circuit.removeWire(state.selectedWire);
    state.selectedWire = null;
    render();
    buildInspector();
    commit();
    toast('Conexão removida');
    return;
  }
  if (!state.selection.size) return;
  for (const id of state.selection) state.circuit.remove(id);
  state.selection.clear();
  render();
  buildInspector();
  commit();
}

function rotateSelection() {
  for (const id of state.selection) {
    const inst = state.circuit.byId(id);
    if (inst) inst.rot = (inst.rot + 90) % 360;
  }
  state.circuit.touch();
  render();
  commit();
}

// ------------------------------------------------------------- interactions

el.sheet.addEventListener('pointerdown', (evt) => {
  if (evt.button === 1 || (evt.button === 0 && evt.altKey)) {
    startPan(evt);
    return;
  }
  if (evt.button !== 0) return;

  const portEl = evt.target.closest('.port-dot');
  if (portEl) {
    if (state.tool === 'probe') { addProbeAt(portEl); return; }
    startWire(portEl, evt);
    return;
  }

  const wireEl = evt.target.closest('.wire-hit');
  if (wireEl && state.tool === 'select') {
    // Select, don't delete. A stray click on a line must never destroy work.
    selectWire(wireEl.dataset.wire);
    return;
  }

  const partId = hitPart(evt);
  if (!partId) {
    if (!evt.shiftKey) select([]);
    startMarquee(evt);
    return;
  }

  const inst = state.circuit.byId(partId);
  const def = state.circuit.defOf(inst);

  // While the sim runs, an operable component is a control, not an object to drag.
  if (def.interactive && state.sim?.running) {
    if (def.manual) {
      // A 4/3 hand lever has three positions, so a press has to say *which*: which half
      // of the symbol was clicked decides the direction, and releasing springs it back.
      const b = state.circuit.bounds(inst);
      const p = toSheet(evt);
      inst.sim.lever = p.x < b.x + b.w / 2 ? -1 : 1;
      const release = () => { inst.sim.lever = 0; window.removeEventListener('pointerup', release); };
      window.addEventListener('pointerup', release);
      evt.preventDefault();
      return;
    }
    if (def.toggle) {
      inst.sim.pressed = !inst.sim.pressed;
    } else {
      inst.sim.pressed = true;
      const release = () => { inst.sim.pressed = false; window.removeEventListener('pointerup', release); };
      window.addEventListener('pointerup', release);
    }
    evt.preventDefault();
    return;
  }

  if (evt.shiftKey) select([partId], true);
  else if (!state.selection.has(partId)) select([partId]);
  startDrag(evt);
});

function startDrag(evt) {
  const origin = toSheet(evt);
  const starts = new Map();
  for (const id of state.selection) {
    const i = state.circuit.byId(id);
    if (i) starts.set(id, { x: i.x, y: i.y });
  }
  state.drag = { origin, starts, moved: false };
  capture(evt);
}

function startMarquee(evt) {
  const origin = toSheet(evt);
  const box = svgEl('rect', { class: 'marquee', x: origin.x, y: origin.y, width: 0, height: 0 });
  el.overlay.appendChild(box);
  state.drag = { marquee: { origin, box, additive: evt.shiftKey } };
  capture(evt);
}

function startPan(evt) {
  state.drag = { pan: { x: evt.clientX, y: evt.clientY, vx: state.view.x, vy: state.view.y } };
  el.sheet.classList.add('panning');
  capture(evt);
  evt.preventDefault();
}

function startWire(portEl, evt) {
  const from = { inst: portEl.dataset.inst, port: portEl.dataset.port };
  const p = state.circuit.portRef(from);
  const rubber = svgEl('path', { class: 'rubber', d: `M ${p.x} ${p.y} L ${p.x} ${p.y}` });
  el.overlay.appendChild(rubber);
  state.wiring = { from, start: p, rubber };
  portEl.classList.add('active');
  capture(evt);
  evt.preventDefault();
}

el.sheet.addEventListener('pointermove', (evt) => {
  if (state.wiring) {
    const p = toSheet(evt);
    const { start } = state.wiring;
    state.wiring.rubber.setAttribute('d', `M ${start.x} ${start.y} L ${start.x} ${p.y} L ${p.x} ${p.y}`);
    return;
  }
  const d = state.drag;
  if (!d) return;

  if (d.pan) {
    state.view.x = d.pan.vx + (evt.clientX - d.pan.x);
    state.view.y = d.pan.vy + (evt.clientY - d.pan.y);
    applyView();
    return;
  }

  if (d.marquee) {
    const p = toSheet(evt);
    const o = d.marquee.origin;
    d.marquee.box.setAttribute('x', Math.min(o.x, p.x));
    d.marquee.box.setAttribute('y', Math.min(o.y, p.y));
    d.marquee.box.setAttribute('width', Math.abs(p.x - o.x));
    d.marquee.box.setAttribute('height', Math.abs(p.y - o.y));
    return;
  }

  const p = toSheet(evt);
  const dx = p.x - d.origin.x, dy = p.y - d.origin.y;
  if (!d.moved && Math.hypot(dx, dy) < 3) return;
  d.moved = true;

  for (const [id, s] of d.starts) {
    const inst = state.circuit.byId(id);
    inst.x = snap(s.x + dx);
    inst.y = snap(s.y + dy);
    const dom = state.domParts.get(id);
    const def = state.circuit.defOf(inst);
    if (dom) {
      dom.g.setAttribute('transform',
        `translate(${inst.x},${inst.y}) rotate(${inst.rot},${def.size.w / 2},${def.size.h / 2})`);
    }
  }
  // Ports and wires follow the parts live; a full render each move would be wasteful.
  refreshPortPositions();
  renderWires();
  renderProbes();
  updateDynamic();
});

function refreshPortPositions() {
  for (const dot of el.ports.children) {
    const inst = state.circuit.byId(dot.dataset.inst);
    if (!inst) continue;
    const port = state.circuit.defOf(inst).ports.find((p) => p.id === dot.dataset.port);
    const p = state.circuit.portPos(inst, port);
    dot.setAttribute('cx', p.x);
    dot.setAttribute('cy', p.y);
  }
}

el.sheet.addEventListener('pointerup', (evt) => {
  if (state.wiring) {
    const target = document.elementFromPoint(evt.clientX, evt.clientY)?.closest('.port-dot');
    el.overlay.querySelectorAll('.rubber').forEach((n) => n.remove());
    el.ports.querySelectorAll('.active').forEach((n) => n.classList.remove('active'));
    if (target) {
      const to = { inst: target.dataset.inst, port: target.dataset.port };
      const made = state.circuit.connect(state.wiring.from, to);
      if (!made && to.inst !== state.wiring.from.inst) {
        toast('Conexões incompatíveis (pneumática ↔ elétrica).');
      }
      render();
      if (made) commit();
    }
    state.wiring = null;
    return;
  }

  const d = state.drag;
  state.drag = null;
  el.sheet.classList.remove('panning');
  if (!d) return;

  if (d.marquee) {
    const b = d.marquee.box.getBBox();
    d.marquee.box.remove();
    const hits = state.circuit.instances.filter((i) => {
      const r = state.circuit.bounds(i);
      return r.x < b.x + b.width && r.x + r.w > b.x && r.y < b.y + b.height && r.y + r.h > b.y;
    }).map((i) => i.id);
    if (hits.length) select(hits, d.marquee.additive);
    return;
  }
  if (d.starts && d.moved) { state.circuit.touch(); commit('move'); }
});

el.sheet.addEventListener('wheel', (evt) => {
  evt.preventDefault();
  if (evt.ctrlKey || evt.metaKey) {
    zoomAt(evt.clientX, evt.clientY, Math.exp(-evt.deltaY * 0.01));
  } else {
    state.view.x -= evt.deltaX;
    state.view.y -= evt.deltaY;
    applyView();
  }
}, { passive: false });

function zoomAt(cx, cy, factor) {
  const r = el.sheet.getBoundingClientRect();
  const px = cx - r.left, py = cy - r.top;
  const k0 = state.view.k;
  const k = clamp(k0 * factor, 0.25, 4);
  state.view.x = px - ((px - state.view.x) / k0) * k;
  state.view.y = py - ((py - state.view.y) / k0) * k;
  state.view.k = k;
  applyView();
}

function zoomFit() {
  const insts = state.circuit.instances;
  const r = el.sheet.getBoundingClientRect();
  // The diagram panel covers the bottom of the sheet, so the usable height is less than
  // the SVG's own height — fitting to the full rect would hide the lowest components.
  const usableH = r.height - (el.diagPanel?.offsetHeight ?? 0);
  if (!insts.length) {
    state.view = { x: 60, y: 30, k: 1 };
    applyView();
    return;
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of insts) {
    const b = state.circuit.bounds(i);
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  const pad = 50;
  const k = clamp(Math.min(r.width / (x1 - x0 + pad * 2), usableH / (y1 - y0 + pad * 2)), 0.25, 2);
  state.view.k = k;
  state.view.x = (r.width - (x1 - x0) * k) / 2 - x0 * k;
  state.view.y = (usableH - (y1 - y0) * k) / 2 - y0 * k;
  applyView();
}

// Drag-and-drop from the library.
el.sheet.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
el.sheet.addEventListener('drop', (e) => {
  e.preventDefault();
  const typeId = e.dataTransfer.getData('text/plain');
  if (!BY_ID.has(typeId)) return;
  const p = toSheet(e);
  const def = BY_ID.get(typeId);
  const inst = state.circuit.add(typeId, p.x - def.size.w / 2, p.y - def.size.h / 2);
  select([inst.id]);
  render();
  commit();
});

// -------------------------------------------------------------- simulation

function setRunning(run) {
  const sim = state.sim;
  sim.running = run;
  el.runBtn.classList.toggle('running', run);
  el.runLabel.textContent = run ? 'Pausar' : 'Iniciar';
  el.runBtn.querySelector('.icon').innerHTML = run
    ? '<rect x="4" y="3" width="3" height="10" rx="0.5"/><rect x="9" y="3" width="3" height="10" rx="0.5"/>'
    : '<polygon points="4,2.5 13,8 4,13.5"/>';
  el.simState.textContent = run ? 'Simulação em execução' : (sim.time > 0 ? 'Pausado' : 'Edição');
  el.simState.className = `pill ${run ? 'pill-run' : sim.time > 0 ? 'pill-pause' : 'pill-idle'}`;
  el.sheet.classList.toggle('ports-hidden', run);
}

function stopSim() {
  state.sim.reset();
  state.rec.clear();
  state.scope.clear();
  setRunning(false);
  el.simState.textContent = 'Edição';
  el.simState.className = 'pill pill-idle';
  render();
}

const DT = 0.001; // 1ms fixed step: fast enough for the relay chain, cheap enough to run real-time
const MAX_STEPS = 40; // ~40ms of catch-up per frame, then we accept slow-motion over a spiral

let lastFrame = performance.now();
let accumulator = 0;

function frame(now) {
  const dtReal = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

  const sim = state.sim;
  if (sim?.running) {
    accumulator += dtReal * state.speed;
    let steps = 0;
    while (accumulator >= DT && steps < MAX_STEPS) {
      sim.step(DT);
      // Sampled inside the tick loop, not once per frame: at 60 fps the scope would
      // capture ~1 of every 17 ticks, which aliases every transient it exists to show.
      state.scope.sample(sim);
      state.rec.sample(sim);
      accumulator -= DT;
      steps++;
    }
    if (steps >= MAX_STEPS) accumulator = 0;
    el.clock.textContent = `${num(sim.time)} s`;
    updateDynamic();
    updateReadouts();
    updateProbeValues();
    redrawDiagram();
    redrawScope();
    redrawGrafcet();
  }
  requestAnimationFrame(frame);
}

/** The legend must describe the domain on the sheet; "0–6 bar" over an 80 bar oil
 *  circuit is simply a wrong label. */
function updateLegend() {
  const hyd = state.sim?.hyd.count > 0;
  const air = state.sim?.nets.count > 0;
  const bar = $('#legend .legend-bar');
  const scale = $('#legend .legend-scale');
  const title = $('#legend .legend-title');
  if (!bar) return;
  if (hyd && !air) {
    title.textContent = 'Pressão do óleo';
    bar.style.background = 'linear-gradient(90deg, #8a939b, #b8494e, #d62b2b)';
    scale.textContent = '0–200 bar';
  } else {
    title.textContent = 'Pressão';
    bar.style.background = 'linear-gradient(90deg, #99a3ad, #4a86d8, #0b63ce)';
    scale.textContent = hyd ? '0–6 bar ar · 0–200 bar óleo' : '0–6 bar';
  }
}

function buildPartsList() {
  const rows = buildParts(state.circuit);
  if (!rows.length) {
    el.partsView.innerHTML = `<p class="parts-empty">Ainda não há componentes no esquema.</p>`;
    return;
  }

  let html = `<table class="parts-table">
    <thead><tr>
      <th class="num">Item</th><th class="qty">Qtd.</th><th>Identificação</th>
      <th>Componente</th><th>Especificação</th><th>Grupo</th>
    </tr></thead><tbody>`;

  let lastDomain = null;
  rows.forEach((r, i) => {
    if (r.domain !== lastDomain) {
      html += `<tr class="parts-domain"><td colspan="6">${DOMAIN_LABEL[r.domain]}</td></tr>`;
      lastDomain = r.domain;
    }
    html += `<tr>
      <td class="num">${i + 1}</td>
      <td class="qty">${r.count}×</td>
      <td class="tags">${r.tags.join(' ') || '—'}${
        r.faults ? ` <span class="parts-fault">${r.faults} falhas</span>` : ''}</td>
      <td class="name">${r.def.name}</td>
      <td class="spec">${r.spec || '—'}</td>
      <td class="grp">${r.def.group}</td>
    </tr>`;
  });
  html += `</tbody></table>
    <div class="parts-total">
      <span>${rows.length} itens</span>
      <span>${totalParts(rows)} componentes no total</span>
    </div>`;
  el.partsView.innerHTML = html;
}

function redrawGrafcet() {
  if (state.tab !== 'grafcet' || el.diagPanel.classList.contains('collapsed')) return;
  const r = el.grafcet.getBoundingClientRect();
  if (r.width < 10) return;
  const chart = state.circuit.chart;
  const issues = chart ? validateChart(chart) : [];
  drawGrafcet(el.grafcet, chart, {
    width: r.width, height: r.height, issues,
    selection: state.grSel,
    linkFrom: state.grDrag?.from ?? null,
  });
  if (state.grDrag?.rubber) el.grafcet.insertAdjacentHTML('beforeend', state.grDrag.rubber);
  el.grafcet.classList.toggle('tool-step', state.grTool === 'step');

  if (!chart) { el.grafcetSide.innerHTML = ''; buildGrafcetSide(); return; }
  buildGrafcetSide(issues);
  return;
}

/**
 * The chart's side panel: the property editor when something is selected, the live
 * readout otherwise. Kept separate from the circuit inspector on purpose — a step and a
 * cylinder have nothing in common, and cramming both into one panel would mean a mode.
 */
function buildGrafcetSide(issues = []) {
  const chart = state.circuit.chart;
  if (!chart) {
    el.grafcetSide.innerHTML = `<p class="gr-hint">Este circuito ainda não tem um GRAFCET.
      <br><br>“Criar GRAFCET” adiciona um diagrama com uma etapa inicial. Depois:
      <br>• <b>+ Etapa</b>, depois clique em uma área livre
      <br>• Arraste o <b>ponto</b> abaixo de uma etapa até outra para criar uma transição
      <br>• Clique em uma etapa ou transição para editá-la</p>`;
    return;
  }

  const sel = state.grSel;
  let html = '';

  if (sel?.kind === 'step' && chart.steps.has(sel.id)) {
    const s = chart.steps.get(sel.id);
    html += `<p class="gr-title">Etapa</p>
      <div class="gr-field"><label>Nome (para referências X)</label>
        <input type="text" id="gr-name" value="${esc(s.name)}"></div>
      <label class="gr-check"><input type="checkbox" id="gr-init"${s.initial ? ' checked' : ''}>
        Etapa inicial</label>
      <p class="gr-title" style="margin-top:12px">Ações</p>`;
    s.actions.forEach((a, i) => {
      html += `<div class="gr-act-row">
        <select data-akind="${i}">
          ${Object.entries(ACTION_KINDS).map(([k, lbl]) =>
            `<option value="${k}"${a.kind === k ? ' selected' : ''}>${k === 'stored' ? 'mem.' : 'cont.'}</option>`).join('')}
        </select>
        <input type="text" data-atarget="${i}" value="${esc(a.target)}" placeholder="Identificação">
        ${a.kind === 'stored' ? `<select data-avalue="${i}">
          <option value="1"${a.value !== false ? ' selected' : ''}>=1</option>
          <option value="0"${a.value === false ? ' selected' : ''}>=0</option>
        </select>` : ''}
        <button data-adel="${i}" title="Remover ação">×</button>
      </div>`;
    });
    html += `<button class="gr-add" id="gr-act-add">+ Ação</button>`;

  } else if (sel?.kind === 'transition' && chart.transitions.has(sel.id)) {
    const t = chart.transitions.get(sel.id);
    const err = receptivityError(t.receptivity);
    const nameOf = (id) => chart.steps.get(id)?.name ?? '?';
    html += `<p class="gr-title">Transição</p>
      <div class="gr-field"><label>Condição</label>
        <input type="text" id="gr-recep" class="${err ? 'bad' : ''}" value="${esc(t.receptivity)}">
        ${err ? `<p class="gr-err">${esc(err)}</p>` : ''}
      </div>
      <div class="gr-row"><span>de</span><b>${t.from.map(nameOf).join(' ') || '—'}</b></div>
      <div class="gr-row"><span>para</span><b>${t.to.map(nameOf).join(' ') || '—'}</b></div>
      <p class="gr-hint">Para ramificar, arraste o <b>ponto de conexão</b> de outra etapa até
      esta transição — com <b>Shift</b>, ela será anterior (convergência); sem
      Shift, será seguinte (divergência).</p>
      <p class="gr-hint">Condições: <code>S1 * a0</code> (E), <code>+</code> (OU),
      <code>/S1</code> (negação), <code>X2</code> (etapa ativa), <code>↑S1</code> (borda de subida),
      <code>t/X2/5s</code> (tempo)</p>`;

  } else {
    const outs = [...chart.outputs()].sort((a, b) => a[0].localeCompare(b[0]));
    html += `<p class="gr-title">Etapas ativas</p>`;
    const act = [...chart.active].map((id) => chart.steps.get(id)?.name).filter(Boolean);
    html += `<div class="gr-row"><span>Etapa</span><b>${act.join(' ') || '—'}</b></div>`;
    if (outs.length) {
      html += `<p class="gr-title" style="margin-top:10px">Comandos</p>`;
      for (const [k, v] of outs) {
        html += `<div class="gr-row${v ? ' on' : ''}"><span>${k}</span><b>${v ? '1' : '0'}</b></div>`;
      }
    }
    if (issues.length) {
      html += `<p class="gr-title" style="margin-top:10px;color:var(--danger)">Verificação</p>`;
      for (const i of issues.slice(0, 6)) {
        html += `<div class="gr-row"><span style="font-family:var(--font)">${i.text}</span></div>`;
      }
    }
  }
  el.grafcetSide.innerHTML = html;
  bindGrafcetSide();
}

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function bindGrafcetSide() {
  const chart = state.circuit.chart;
  const sel = state.grSel;
  const commitChart = () => { state.circuit.touch(); commit(); redrawGrafcet(); };

  const name = $('#gr-name');
  if (name) name.addEventListener('input', () => {
    chart.steps.get(sel.id).name = name.value;
    state.circuit.touch(); commit(`gr:${sel.id}:name`);
    // Redraw the chart but not the panel — rebuilding it would drop focus mid-typing.
    drawChartOnly();
  });

  const init = $('#gr-init');
  if (init) init.addEventListener('change', () => {
    chart.steps.get(sel.id).initial = init.checked;
    chart.reset();
    commitChart();
  });

  const recep = $('#gr-recep');
  if (recep) recep.addEventListener('input', () => {
    chart.transitions.get(sel.id).receptivity = recep.value;
    state.circuit.touch(); commit(`gr:${sel.id}:recep`);
    const err = receptivityError(recep.value);
    recep.classList.toggle('bad', !!err);
    let note = recep.parentElement.querySelector('.gr-err');
    if (err && !note) {
      note = document.createElement('p');
      note.className = 'gr-err';
      recep.parentElement.appendChild(note);
    }
    if (note) note.textContent = err || '';
    if (!err && note) note.remove();
    drawChartOnly();
  });

  el.grafcetSide.querySelectorAll('[data-adel]').forEach((b) => b.addEventListener('click', () => {
    chart.steps.get(sel.id).actions.splice(+b.dataset.adel, 1);
    commitChart();
  }));
  el.grafcetSide.querySelectorAll('[data-akind]').forEach((n) => n.addEventListener('change', () => {
    const a = chart.steps.get(sel.id).actions[+n.dataset.akind];
    a.kind = n.value;
    if (a.kind === 'stored' && a.value === undefined) a.value = true;
    commitChart();
  }));
  el.grafcetSide.querySelectorAll('[data-atarget]').forEach((n) => n.addEventListener('input', () => {
    chart.steps.get(sel.id).actions[+n.dataset.atarget].target = n.value;
    state.circuit.touch(); commit(`gr:${sel.id}:act`);
    drawChartOnly();
  }));
  el.grafcetSide.querySelectorAll('[data-avalue]').forEach((n) => n.addEventListener('change', () => {
    chart.steps.get(sel.id).actions[+n.dataset.avalue].value = n.value === '1';
    commitChart();
  }));
  const add = $('#gr-act-add');
  if (add) add.addEventListener('click', () => {
    chart.steps.get(sel.id).actions.push({ kind: 'continuous', target: '' });
    commitChart();
  });
}

/** Redraws the chart graphic without rebuilding the side panel (keeps input focus). */
function drawChartOnly() {
  const r = el.grafcet.getBoundingClientRect();
  if (r.width < 10) return;
  const chart = state.circuit.chart;
  drawGrafcet(el.grafcet, chart, {
    width: r.width, height: r.height,
    issues: chart ? validateChart(chart) : [],
    selection: state.grSel,
  });
}

function redrawDiagram() {
  if (state.tab !== 'steps' || el.diagPanel.classList.contains('collapsed')) return;
  const r = el.diagram.getBoundingClientRect();
  if (r.width < 10) return;
  drawDiagram(el.diagram, state.rec, { width: r.width, height: r.height });
}

// ---------------------------------------------------------- GRAFCET editing

const GR_SNAP = 10;
const grSnap = (v) => Math.round(v / GR_SNAP) * GR_SNAP;

function selectGr(sel) {
  state.grSel = sel;
  redrawGrafcet();
}

el.grafcet.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const chart = state.circuit.chart;
  if (!chart) return;

  const linkEl = e.target.closest('[data-link]');
  const stepEl = e.target.closest('[data-sid]');
  const transEl = e.target.closest('[data-tid]');
  const p = toChart(el.grafcet, e.clientX, e.clientY);

  // Link handle: start a connection, never a move.
  if (linkEl) {
    state.grDrag = { linking: true, from: linkEl.dataset.link, shift: e.shiftKey, moved: true };
    selectGr({ kind: 'step', id: linkEl.dataset.link });
    el.grafcet.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    return;
  }

  // Place a step on empty canvas.
  if (state.grTool === 'step' && !stepEl && !transEl) {
    const s = chart.addStep({
      name: nextStepName(chart),
      x: grSnap(p.x - STEP_SIZE / 2),
      y: grSnap(p.y - STEP_SIZE / 2),
      initial: chart.steps.size === 0, // the first step has to be the initial one
    });
    chart.reset();
    state.grTool = 'select';
    $('#gr-add-step').classList.remove('active');
    state.circuit.touch();
    commit();
    selectGr({ kind: 'step', id: s.id });
    return;
  }

  if (transEl) { selectGr({ kind: 'transition', id: transEl.dataset.tid }); return; }
  if (!stepEl) { selectGr(null); return; }

  const id = stepEl.dataset.sid;
  selectGr({ kind: 'step', id });

  // Body drag: move only. Linking has its own handle.
  const step = chart.steps.get(id);
  state.grDrag = { id, ox: p.x - step.x, oy: p.y - step.y, moved: false };
  el.grafcet.setPointerCapture?.(e.pointerId);
  e.preventDefault();
});

el.grafcet.addEventListener('pointermove', (e) => {
  const d = state.grDrag;
  if (!d) return;
  const chart = state.circuit.chart;
  const p = toChart(el.grafcet, e.clientX, e.clientY);

  if (d.linking) {
    const src = chart.steps.get(d.from);
    if (!src) return;
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-sid],[data-tid]');
    d.link = !over || over.dataset.sid === d.from ? null
      : over.dataset.sid ? { kind: 'step', id: over.dataset.sid }
      : { kind: 'transition', id: over.dataset.tid };
    d.rubber = `<line class="gr-rubber" x1="${src.x + STEP_SIZE / 2}" y1="${src.y + STEP_SIZE}"
      x2="${p.x}" y2="${p.y}"/>`;
    drawChartOnly();
    el.grafcet.insertAdjacentHTML('beforeend', d.rubber);
    return;
  }

  const step = chart.steps.get(d.id);
  if (!step) return;
  if (!d.moved && Math.hypot(p.x - step.x - d.ox, p.y - step.y - d.oy) < 4) return;
  d.moved = true;
  step.x = grSnap(p.x - d.ox);
  step.y = grSnap(p.y - d.oy);
  drawChartOnly();
});

el.grafcet.addEventListener('pointerup', () => {
  const d = state.grDrag;
  state.grDrag = null;
  if (!d) return;
  const chart = state.circuit.chart;

  if (d.linking && d.link) {
    if (d.link.kind === 'step') {
      const from = chart.steps.get(d.from), to = chart.steps.get(d.link.id);
      const t = chart.addTransition({
        from: [d.from], to: [d.link.id], receptivity: '1',
        x: from.x + STEP_SIZE / 2,
        y: grSnap((from.y + STEP_SIZE + to.y) / 2),
      });
      selectGr({ kind: 'transition', id: t.id });
      toast('Transição criada — preencha a condição à direita');
    } else if (d.shift) {
      // Shift-drag onto a transition adds a *predecessor*: that is how an AND convergence
      // is built, and it has to be explicit or an accidental drag would rewire the chart.
      const t = chart.transitions.get(d.link.id);
      if (t && !t.from.includes(d.from)) {
        t.from.push(d.from);
        toast('Etapa anterior adicionada — convergência simultânea');
      }
      selectGr({ kind: 'transition', id: d.link.id });
    } else {
      // Plain drag onto a transition adds a *successor* — that is an OR/AND divergence.
      const t = chart.transitions.get(d.link.id);
      if (t && !t.to.includes(d.from)) {
        t.to.push(d.from);
        toast('Etapa seguinte adicionada — divergência');
      }
      selectGr({ kind: 'transition', id: d.link.id });
    }
    chart.reset();
    state.circuit.touch();
    commit();
  } else if (!d.linking && d.moved) {
    state.circuit.touch();
    commit('gr:move');
  }
  redrawGrafcet();
});

/** Lowest free integer name, so a new step reads 0,1,2… like a textbook chart. */
function nextStepName(chart) {
  const taken = new Set([...chart.steps.values()].map((s) => s.name));
  for (let i = 0; i < 999; i++) if (!taken.has(String(i))) return String(i);
  return `S${chart.steps.size}`;
}

function deleteGrSelection() {
  const chart = state.circuit.chart;
  if (!chart || !state.grSel) return false;
  chart.remove(state.grSel.id);
  chart.reset();
  state.grSel = null;
  state.circuit.touch();
  commit();
  redrawGrafcet();
  return true;
}

$('#gr-new').addEventListener('click', () => {
  if (state.circuit.chart && !confirm('Descartar o GRAFCET existente?')) return;
  const g = new Grafcet();
  g.addStep({ name: '0', initial: true, x: 60, y: 40 });
  g.reset();
  state.circuit.chart = g;
  state.sim.chart = g;
  state.circuit.touch();
  commit();
  document.querySelector('.panel-tab[data-tab="grafcet"]').classList.add('has-content');
  redrawGrafcet();
  toast('GRAFCET criado');
});

$('#gr-add-step').addEventListener('click', (e) => {
  if (!state.circuit.chart) { toast('Primeiro clique em “Criar GRAFCET”'); return; }
  state.grTool = state.grTool === 'step' ? 'select' : 'step';
  e.currentTarget.classList.toggle('active', state.grTool === 'step');
  redrawGrafcet();
});

$('#gr-del').addEventListener('click', () => {
  if (!deleteGrSelection()) toast('Nenhum item selecionado');
});

// ------------------------------------------------------------------ toolbar

function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll('.tool').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
  });
  el.sheet.classList.toggle('tool-wire', tool === 'wire');
  el.sheet.classList.toggle('tool-probe', tool === 'probe');
}

document.querySelectorAll('.tool').forEach((b) => {
  b.addEventListener('click', () => setTool(b.dataset.tool));
});

el.runBtn.addEventListener('click', () => setRunning(!state.sim.running));
$('#btn-stop').addEventListener('click', stopSim);
$('#zoom-in').addEventListener('click', () => {
  const r = el.sheet.getBoundingClientRect();
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.2);
});
$('#zoom-out').addEventListener('click', () => {
  const r = el.sheet.getBoundingClientRect();
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.2);
});
$('#zoom-fit').addEventListener('click', zoomFit);

$('#speed').addEventListener('input', (e) => {
  state.speed = parseFloat(e.target.value);
  $('#speed-out').textContent = `${num(state.speed, 1)}×`;
});

el.libSearch.addEventListener('input', (e) => buildLibrary(e.target.value));

document.querySelectorAll('#lib-domains .chip').forEach((b) => {
  b.addEventListener('click', () => {
    state.libDomain = b.dataset.domain;
    document.querySelectorAll('#lib-domains .chip').forEach((x) =>
      x.setAttribute('aria-pressed', String(x === b)));
    buildLibrary(el.libSearch.value);
    el.libList.scrollTop = 0;
  });
});

document.querySelectorAll('.panel-tab').forEach((b) =>
  b.addEventListener('click', () => setPanelTab(b.dataset.tab)));

$('#scope-timebase').addEventListener('change', (e) => {
  state.scope.timebase = parseFloat(e.target.value);
  redrawScope();
});
$('#scope-trigmode').addEventListener('change', (e) => {
  const v = e.target.value;
  state.scope.trigger.mode = v === 'none' ? 'none' : 'edge';
  if (v !== 'none') state.scope.trigger.edge = v;
  redrawScope();
});
$('#scope-trigsrc').addEventListener('change', (e) => {
  state.scope.trigger.source = parseInt(e.target.value, 10);
  redrawScope();
});
$('#scope-triglevel').addEventListener('input', (e) => {
  state.scope.trigger.level = parseFloat(e.target.value) || 0;
  redrawScope();
});
$('#scope-cursors').addEventListener('click', (e) => {
  state.scope.cursors.on = !state.scope.cursors.on;
  e.currentTarget.classList.toggle('active', state.scope.cursors.on);
  redrawScope(); buildProbeList();
});
$('#scope-freeze').addEventListener('click', (e) => {
  state.scope.frozen = !state.scope.frozen;
  e.currentTarget.classList.toggle('active', state.scope.frozen);
  toast(state.scope.frozen ? 'Imagem congelada' : 'Gravação em andamento');
});
$('#scope-clear').addEventListener('click', () => { state.scope.clear(); redrawScope(); });
$('#scope-csv').addEventListener('click', () => {
  const csv = state.scope.toCSV();
  if (!csv) { toast('Ainda não há dados gravados'); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'osciloscopio.csv';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Canais exportados em CSV');
});

$('#diag-toggle').addEventListener('click', () => {
  const collapsed = el.diagPanel.classList.toggle('collapsed');
  el.canvasWrap.classList.toggle('diagram-collapsed', collapsed);
  $('#diag-toggle').textContent = collapsed ? '▴' : '▾';
  redrawDiagram();
  redrawScope();
  redrawGrafcet();
});
$('#diag-clear').addEventListener('click', () => { state.rec.clear(); redrawDiagram(); });
$('#diag-csv').addEventListener('click', () => {
  const csv = state.rec.toCSV();
  if (!csv) { toast('Ainda não há dados gravados'); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'tracos.csv';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Traços exportados em CSV');
});

$('#btn-undo').addEventListener('click', undo);
$('#btn-redo').addEventListener('click', redo);

$('#btn-new').addEventListener('click', () => {
  state.docTitle = 'Esquema';
  loadCircuit(new Circuit());
  toast('Novo desenho');
});

const exportMenu = $('#export-menu');
const closeMenu = () => {
  exportMenu.hidden = true;
  $('#btn-export').setAttribute('aria-expanded', 'false');
};
$('#btn-export').addEventListener('click', (e) => {
  e.stopPropagation();
  exportMenu.hidden = !exportMenu.hidden;
  $('#btn-export').setAttribute('aria-expanded', String(!exportMenu.hidden));
});
window.addEventListener('pointerdown', (e) => {
  if (!exportMenu.hidden && !e.target.closest('.menu-wrap')) closeMenu();
});

exportMenu.addEventListener('click', async (e) => {
  const what = e.target.dataset?.export;
  if (!what) return;
  closeMenu();
  const title = state.docTitle || 'Esquema';

  if (what === 'json') {
    const blob = new Blob([JSON.stringify(state.circuit.toJSON(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'esquema.fluidlab.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Esquema exportado');
  } else if (what === 'svg') {
    toast(exportSVG(el.sheet, title) ? 'SVG exportado' : 'Não há conteúdo para exportar');
  } else if (what === 'png') {
    try {
      toast(await exportPNG(el.sheet, title) ? 'PNG exportado' : 'Não há conteúdo para exportar');
    } catch (err) {
      toast(`Falha ao exportar PNG: ${err.message}`);
    }
  } else if (what === 'pdf') {
    try {
      // The parts list rides along as a second page; passing the rows in keeps export.js
      // from having to know about the document model.
      const ok = exportPDF(el.sheet, title, { partsRows: buildParts(state.circuit) });
      toast(ok ? 'PDF exportado' : 'Não há conteúdo para exportar');
    } catch (err) {
      toast(`Falha ao exportar PDF: ${err.message}`);
    }
  } else if (what === 'parts') {
    const rows = buildParts(state.circuit);
    if (!rows.length) { toast('Não há conteúdo para exportar'); return; }
    const blob = new Blob([partsToCSV(rows)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'lista-de-materiais.csv';
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`Lista de materiais exportada com ${rows.length} itens`);
  }
});

$('#parts-csv').addEventListener('click', () => {
  exportMenu.hidden = true;
  const rows = buildParts(state.circuit);
  if (!rows.length) { toast('Não há conteúdo para exportar'); return; }
  const blob = new Blob([partsToCSV(rows)], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'lista-de-materiais.csv';
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`Lista de materiais exportada com ${rows.length} itens`);
});

$('#btn-load').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    loadCircuit(Circuit.fromJSON(JSON.parse(await file.text())));
    toast(`${file.name} carregado`);
  } catch (err) {
    toast('Não foi possível ler o arquivo');
  }
  e.target.value = '';
});

const examplesSel = $('#examples');
for (const [key, ex] of Object.entries(EXAMPLES)) {
  examplesSel.appendChild(Object.assign(document.createElement('option'), { value: key, textContent: ex.name }));
}
examplesSel.addEventListener('change', (e) => {
  const ex = EXAMPLES[e.target.value];
  if (!ex) return;
  state.docTitle = ex.name;
  loadCircuit(ex.build());
  toast(ex.description);
  e.target.value = '';
});

window.addEventListener('keydown', (e) => {
  // target is only guaranteed to be an Element when something is focused; when it is
  // the window or document, matches() does not exist and would take out every shortcut.
  const t = e.target;
  if (t instanceof Element && t.matches('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  if (k === 'v') setTool('select');
  else if (k === 'w') setTool('wire');
  else if (k === 'p') setTool('probe');
  else if (k === 'r') rotateSelection();
  else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    // The chart panel owns Delete while something in it is selected.
    if (state.tab === 'grafcet' && state.grSel) deleteGrSelection();
    else deleteSelection();
  }
  else if (e.key === ' ') { e.preventDefault(); setRunning(!state.sim.running); }
  else if (e.key === 'Escape') stopSim();
  else if (k === 'a' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    select(state.circuit.instances.map((i) => i.id));
  } else if (k === 'z' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
  } else if (k === 'y' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    redo();
  }
});

// ---------------------------------------------------------------- bootstrap

/** Swaps in a different document without touching the history or the view. */
function applyCircuit(c) {
  state.circuit = c;
  state.sim = new Simulation(c);
  state.sim.chart = c.chart || null;
  state.sim.chart?.reset();
  state.grSel = null;
  state.grTool = 'select';
  document.querySelector('.panel-tab[data-tab="grafcet"]').classList.toggle('has-content', !!c.chart);
  state.rec.clear();
  state.rec.sync(c);
  state.scope.clear();
  state.selection.clear();
  state.selectedWire = null;
  state.renderedRevision = -1;
  render();
  setRunning(false);
  el.clock.textContent = '0,00 s';
  buildInspector();
  updateLegend();
}

/** Loads a document as a fresh start: history cleared, view fitted. */
function loadCircuit(c) {
  applyCircuit(c);
  state.history = new History(c);
  refreshHistoryButtons();
  zoomFit();
}

setTool('select');
buildLibrary();
el.canvasWrap.classList.add('has-diagram');
// Panels resize live, so the sheet and the chart both have to follow the drag.
state.panels = new Panels(() => { redrawDiagram(); redrawScope(); redrawGrafcet(); });
buildProbeList();
buildTriggerSources();
loadCircuit(EXAMPLES.indirect.build());
applyView();
setPanelTab('steps');
window.addEventListener('resize', () => { redrawDiagram(); redrawScope(); redrawGrafcet(); });
requestAnimationFrame(frame);
