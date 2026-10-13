// Bill of materials, generated from the sheet.
//
// Grouped by component type rather than listing every instance: a sheet with eight
// identical 3/2 valves should read "8×", not eight rows. The tags stay visible on each
// row because that is how you find the part on the drawing.
//
// Nothing here is stored in the document — the list is derived on demand. A parts list
// that can drift out of sync with the circuit is worse than none.

/** Parameters worth printing per type. Everything else is noise on a BOM. */
const SPEC_KEYS = {
  cyl_double: ['bore', 'rod', 'stroke'],
  cyl_single: ['bore', 'stroke', 'springForce'],
  h_cyl: ['bore', 'rod', 'stroke'],
  supply: ['pressure'],
  throttle_check: ['opening'],
  h_throttle: ['opening'],
  pressure_reg: ['setpoint'],
  sequence_valve: ['setpoint'],
  pressure_switch: ['setpoint'],
  timer_nc: ['delay'],
  timer_no: ['delay'],
  h_pump: ['flow'],
  h_relief: ['setpoint'],
  h_counterbalance: ['setpoint', 'ratio'],
  check: ['cracking'],
  h_check: ['cracking'],
};

const fmt = (p) => {
  const v = typeof p.value === 'number'
    ? p.value.toFixed(p.step && p.step < 1 ? 2 : 0).replace('.', ',')
    : p.value;
  return p.unit ? `${v} ${p.unit}` : `${v}`;
};

/**
 * Builds the grouped list. Returns rows sorted by domain then name, so a mixed sheet
 * reads pneumatics, then hydraulics, then electrics — the order the drawing is laid out.
 */
export function buildParts(circuit) {
  const groups = new Map();

  for (const inst of circuit.instances) {
    const def = circuit.defOf(inst);
    if (!def) continue;

    // Two components of the same type but different key specs are different line items:
    // a 25 mm and a 50 mm cylinder must not collapse into "2× DW-Zylinder".
    const keys = SPEC_KEYS[def.id] || [];
    const spec = keys
      .map((k) => inst.params[k] && fmt(inst.params[k]))
      .filter(Boolean)
      .join(' · ');
    const key = `${def.id}|${spec}`;

    if (!groups.has(key)) {
      groups.set(key, { def, spec, tags: [], count: 0, faults: 0 });
    }
    const g = groups.get(key);
    g.count++;
    if (inst.params?.tag?.value) g.tags.push(inst.params.tag.value);
    if (Object.values(inst.faults || {}).some(Boolean)) g.faults++;
  }

  const domainOf = (def) => {
    const kinds = new Set(def.ports.map((p) => p.kind || 'pneumatic'));
    if (kinds.has('hydraulic')) return 2;
    if (def.group === 'Elétrica') return 3;
    return 1;
  };

  return [...groups.values()]
    .map((g) => ({ ...g, domain: domainOf(g.def), tags: g.tags.sort(naturalCmp) }))
    .sort((a, b) => a.domain - b.domain
      || a.def.group.localeCompare(b.def.group, 'pt-BR')
      || a.def.name.localeCompare(b.def.name, 'pt-BR'));
}

/** 1A1 before 1A10 before 2A1 — plain string sort gets this wrong. */
function naturalCmp(a, b) {
  return String(a).localeCompare(String(b), 'pt-BR', { numeric: true });
}

export const DOMAIN_LABEL = { 1: 'Pneumática', 2: 'Hidráulica', 3: 'Elétrica' };

export function partsToCSV(rows) {
  const out = ['Item,Quantidade,Identificação,Componente,Especificação,Grupo,Área'];
  rows.forEach((r, i) => {
    const cell = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    out.push([
      i + 1,
      r.count,
      cell(r.tags.join(' ')),
      cell(r.def.name),
      cell(r.spec),
      cell(r.def.group),
      cell(DOMAIN_LABEL[r.domain]),
    ].join(','));
  });
  return out.join('\n');
}

/** Total instance count, for the panel header. */
export const totalParts = (rows) => rows.reduce((n, r) => n + r.count, 0);
