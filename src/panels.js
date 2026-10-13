// Resizable workspace panels.
//
// Sizes live in CSS custom properties on :root, so the grid and the diagram panel read
// them directly and nothing needs a layout pass in JS. The handles are separate hit
// strips rather than CSS `resize`, because the panels have to grow in opposite
// directions (the right one grows leftwards) and `resize` cannot express that.
//
// Sizes persist per browser: a user who has arranged their workspace should find it that
// way next session, and re-dragging three panels every time is exactly the kind of small
// friction that makes a tool feel unfinished.

const STORE_KEY = 'fluidlab.layout.v1';

export const LIMITS = {
  left: { min: 160, max: 520, def: 264 },
  right: { min: 200, max: 560, def: 264 },
  diagram: { min: 90, max: 620, def: 168 },
};

const VAR = {
  left: '--panel-w-left',
  right: '--panel-w-right',
  diagram: '--diagram-h',
};

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    const out = {};
    for (const k of Object.keys(LIMITS)) {
      out[k] = clamp(Number(raw[k]) || LIMITS[k].def, LIMITS[k].min, LIMITS[k].max);
    }
    return out;
  } catch {
    return Object.fromEntries(Object.keys(LIMITS).map((k) => [k, LIMITS[k].def]));
  }
}

export class Panels {
  /** `onResize` fires while dragging, so the sheet and charts can re-fit live. */
  constructor(onResize) {
    this.sizes = load();
    this.onResize = onResize;
    this.apply();
    this.bind();
  }

  apply() {
    for (const [k, v] of Object.entries(this.sizes)) {
      document.documentElement.style.setProperty(VAR[k], `${v}px`);
    }
  }

  save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.sizes)); } catch { /* private mode */ }
  }

  set(which, px) {
    const l = LIMITS[which];
    this.sizes[which] = clamp(px, l.min, l.max);
    this.apply();
    this.onResize?.();
  }

  reset(which) {
    this.set(which, LIMITS[which].def);
    this.save();
  }

  bind() {
    for (const which of Object.keys(LIMITS)) {
      const handle = document.querySelector(`[data-resize="${which}"]`);
      if (!handle) continue;

      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        handle.classList.add('dragging');
        document.body.classList.add('resizing');

        const start = which === 'diagram' ? e.clientY : e.clientX;
        const from = this.sizes[which];
        // The right panel and the diagram grow against the drag direction.
        const sign = which === 'left' ? 1 : -1;

        const move = (ev) => {
          const now = which === 'diagram' ? ev.clientY : ev.clientX;
          this.set(which, from + (now - start) * sign);
        };
        const up = () => {
          handle.classList.remove('dragging');
          document.body.classList.remove('resizing');
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          this.save();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });

      // Double-click resets — the standard escape hatch when a panel has been dragged
      // somewhere useless.
      handle.addEventListener('dblclick', () => this.reset(which));
    }
  }
}
