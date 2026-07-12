const SWATCHES: Array<{ prov: 'human' | 'ai' | 'mixed'; label: string }> = [
  { prov: 'human', label: 'Human' },
  { prov: 'ai', label: 'AI' },
  { prov: 'mixed', label: 'Mixed' },
];

let mounted = false;

/**
 * Bottom-left color key explaining the provenance gutter (human/AI/mixed).
 * Styled by the .proof-legend rules in index.html.
 */
export function initProvenanceLegend(): void {
  if (mounted || document.querySelector('.proof-legend')) return;
  mounted = true;

  const legend = document.createElement('div');
  legend.className = 'proof-legend';
  legend.setAttribute('role', 'note');
  legend.setAttribute('aria-label', 'Provenance color key');
  legend.innerHTML = SWATCHES.map(
    ({ prov, label }) =>
      `<span class="proof-legend-k"><span class="proof-legend-sw" data-prov="${prov}"></span>${label}</span>`
  ).join('');

  document.body.appendChild(legend);
}
