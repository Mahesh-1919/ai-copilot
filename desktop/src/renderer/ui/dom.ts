function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`Missing #${id} (${type.name})`);
  return element;
}

/** Looks up every element the UI needs once, failing fast if the markup changed. */
export function queryElements() {
  return {
    root: byId('ic-root', HTMLDivElement),
    timer: byId('ic-timer', HTMLSpanElement),
    dot: byId('ic-dot', HTMLSpanElement),
    status: byId('ic-status', HTMLSpanElement),

    startBtn: byId('ic-start', HTMLButtonElement),
    pauseBtn: byId('ic-pause', HTMLButtonElement),
    resumeBtn: byId('ic-resume', HTMLButtonElement),
    exitBtn: byId('ic-exit', HTMLButtonElement),
    clearBtn: byId('ic-clear', HTMLButtonElement),
    answerBtn: byId('ic-answer', HTMLButtonElement),
    analyseBtn: byId('ic-analyse', HTMLButtonElement),

    live: byId('ic-live', HTMLDivElement),
    err: byId('ic-err', HTMLDivElement),

    card: byId('ic-card', HTMLElement),
    closeCard: byId('ic-close', HTMLButtonElement),
    summary: byId('ic-summary', HTMLDivElement),
    questionText: byId('ic-question-text', HTMLSpanElement),
    heading: byId('ic-heading', HTMLDivElement),
    body: byId('ic-body', HTMLDivElement),

    manualInput: byId('ic-manual-input', HTMLInputElement),
    manualSend: byId('ic-manual-send', HTMLButtonElement),

    opacitySlider: byId('ic-opacity-slider', HTMLInputElement),
    opacityValue: byId('ic-opacity-value', HTMLSpanElement),
  };
}

export type Elements = ReturnType<typeof queryElements>;
