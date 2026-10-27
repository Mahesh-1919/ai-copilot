const STEP = 5;
const ADJUST_DEBOUNCE_MS = 150;

/**
 * Maps the 0-100 "glass" slider to blur, saturation and background opacity.
 * 0 is solid and easiest to read; 100 is maximum glass.
 */
export function applyTransparency(root: HTMLElement, value: number): void {
  const t = value / 100;
  root.style.setProperty('--transparency-blur', `${Math.round(t * 30)}px`);
  root.style.setProperty('--transparency-saturation', `${100 + Math.round(t * 100)}%`);
  root.style.setProperty('--transparency-bg-opacity', String(1 - t * 0.6));
  // Text shadow keeps text readable once the background gets very see-through.
  root.classList.toggle('ic-glass-text', value > 50);
}

/** Wires the slider and the hold-`g` + `+`/`-` keyboard shortcut. */
export function setupTransparencyControls(root: HTMLElement, slider: HTMLInputElement, label: HTMLElement): void {
  const update = () => {
    const value = Number(slider.value);
    label.textContent = `${value}%`;
    applyTransparency(root, value);
  };

  const nudge = (delta: number) => {
    slider.value = String(Math.max(0, Math.min(100, Number(slider.value) + delta)));
    update();
  };

  slider.addEventListener('input', update);
  update();

  let gHeld = false;
  let lastAdjust = 0;

  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.altKey) return;
    if (event.key === 'g') {
      gHeld = true;
      return;
    }
    if (!gHeld) return;

    const now = Date.now();
    if (now - lastAdjust < ADJUST_DEBOUNCE_MS) return;

    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      nudge(STEP);
      lastAdjust = now;
    } else if (event.key === '-') {
      event.preventDefault();
      nudge(-STEP);
      lastAdjust = now;
    }
  });

  window.addEventListener('keyup', (event) => {
    if (event.key === 'g') gHeld = false;
  });
}
