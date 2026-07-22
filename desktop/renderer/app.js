// Renderer process - UI logic with markdown rendering

console.log('[renderer] App initializing');

// Markdown renderer (ported from extension)
function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderMarkdown(src) {
  if (!src) return "";
  let s = escapeHtml(src);

  // Lift fenced code blocks
  const codeBlocks = [];
  s = s.replace(/```([a-zA-Z0-9_+-]*)\r?\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(code.replace(/\n$/, ""));
    return `\u0000PRE${idx}\u0000`;
  });

  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");

  const lines = s.split("\n");
  const out = [];
  let para = [];
  let inList = null;
  const flushPara = () => {
    if (para.length) { out.push(`<p>${para.join(" ")}</p>`); para = []; }
  };
  const closeList = () => {
    if (inList) { out.push(inList === "ul" ? "</ul>" : "</ol>"); inList = null; }
  };
  for (const ln of lines) {
    const trimmed = ln.trim();
    if (trimmed === "") { flushPara(); closeList(); continue; }
    const preM = trimmed.match(/^\u0000PRE(\d+)\u0000$/);
    if (preM) {
      flushPara(); closeList();
      out.push(`<pre><code>${codeBlocks[Number(preM[1])]}</code></pre>`);
      continue;
    }
    const ulM = ln.match(/^\s*[-*+]\s+(.*)$/);
    const olM = ln.match(/^\s*\d+\.\s+(.*)$/);
    if (ulM) {
      flushPara();
      if (inList !== "ul") { closeList(); out.push("<ul>"); inList = "ul"; }
      out.push(`<li>${ulM[1]}</li>`);
      continue;
    }
    if (olM) {
      flushPara();
      if (inList !== "ol") { closeList(); out.push("<ol>"); inList = "ol"; }
      out.push(`<li>${olM[1]}</li>`);
      continue;
    }
    closeList();
    para.push(ln);
  }
  flushPara();
  closeList();

  let html = out.join("\n");
  html = html.replace(/\u0000PRE(\d+)\u0000/g, (_m, i) => `<pre><code>${codeBlocks[Number(i)]}</code></pre>`);
  return html;
}

// DOM elements
const root = document.getElementById('ic-root');
const timer = document.getElementById('ic-timer');
const dot = document.getElementById('ic-dot');
const startBtn = document.getElementById('ic-start');
const pauseBtn = document.getElementById('ic-pause');
const resumeBtn = document.getElementById('ic-resume');
const exitBtn = document.getElementById('ic-exit');
const clearBtn = document.getElementById('ic-clear');
const answerBtn = document.getElementById('ic-answer');
const analyseBtn = document.getElementById('ic-analyse');
const status = document.getElementById('ic-status');
const live = document.getElementById('ic-live');
const err = document.getElementById('ic-err');
const card = document.getElementById('ic-card');
const closeCard = document.getElementById('ic-close');
const summary = document.getElementById('ic-summary');
const questionText = document.getElementById('ic-question-text');
const heading = document.getElementById('ic-heading');
const body = document.getElementById('ic-body');
const manualInput = document.getElementById('ic-manual-input');
const manualSend = document.getElementById('ic-manual-send');
const opacitySlider = document.getElementById('ic-opacity-slider');
const opacityValue = document.getElementById('ic-opacity-value');

// State
let sessionActive = false;
let sessionPaused = false;
let currentAnswer = '';
let currentQuestion = '';
let sessionStartTime = null;
let timerInterval = null;

// Initialize
async function init() {
  try {
    const config = await window.electronAPI.loadConfig();
    console.log('[renderer] Config loaded');
    
    setupEventListeners();
    setupIPCListeners();
    
    console.log('[renderer] App ready');
  } catch (error) {
    console.error('[renderer] Init error:', error);
    showError(error.message);
  }
}

function setupEventListeners() {
  // Session controls
  startBtn.addEventListener('click', async () => {
    console.log('[renderer] Start button clicked');
    try {
      // Kill any previous audio/session so quick Start/Stop/Start never conflicts
      try { await window.audioManager.stop(); } catch {}
      try { await window.electronAPI.stopSession(); } catch {}

      showError('🎤 Starting audio capture...');
      await window.audioManager.start();
      showError('✓ Audio capture started');

      const result = await window.electronAPI.startSession();
      console.log('[renderer] Start session result:', result);
    } catch (error) {
      console.error('[renderer] Start session error:', error);
      showError(error.message);
      try { await window.audioManager.stop(); } catch {}
      try { await window.electronAPI.stopSession(); } catch {}
    }
  });

  exitBtn.addEventListener('click', async () => {
    try {
      // Stop audio capture
      await window.audioManager.stop();
      // Hide window (session will be stopped automatically)
      await window.electronAPI.hideWindow();
    } catch (error) {
      showError(error.message);
    }
  });

  pauseBtn.addEventListener('click', async () => {
    try {
      // Pause audio capture (stop but don't reset session)
      await window.audioManager.stop();
      await window.electronAPI.pauseSession();
    } catch (error) {
      showError(error.message);
    }
  });

  resumeBtn.addEventListener('click', async () => {
    try {
      // Resume session first
      await window.electronAPI.resumeSession();
      // Then restart audio capture
      await window.audioManager.start();
    } catch (error) {
      showError(error.message);
    }
  });

  clearBtn.addEventListener('click', async () => {
    try {
      await window.electronAPI.clearTranscript();
      clearAnswerCard();
    } catch (error) {
      showError(error.message);
    }
  });

  // Answer generation
  answerBtn.addEventListener('click', async () => {
    try {
      await window.electronAPI.generateAnswer();
    } catch (error) {
      showError(error.message);
    }
  });

  analyseBtn.addEventListener('click', async () => {
    try {
      await window.electronAPI.analyseScreen();
    } catch (error) {
      showError(error.message);
    }
  });

  // Manual input
  manualSend.addEventListener('click', async () => {
    const text = manualInput.value.trim();
    if (!text) return;

    if (!sessionActive) {
      // Auto-start session
      try {
        await window.electronAPI.startSession();
      } catch (error) {
        showError(error.message);
        return;
      }
    }

    try {
      currentQuestion = text;
      await window.electronAPI.addTranscript(text);
      manualInput.value = '';
    } catch (error) {
      showError(error.message);
    }
  });

  manualInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault(); // Prevent newline
      manualSend.click();
    }
  });

  // Answer card
  closeCard.addEventListener('click', () => {
    clearAnswerCard();
  });

  // Transparency slider
  opacitySlider.addEventListener('input', (e) => {
    const value = parseInt(e.target.value);
    opacityValue.textContent = `${value}%`;
    
    // Update transparency with smooth gradient (0-100)
    updateTransparency(value);
  });
  
  // Update transparency based on slider value (0-100)
  function updateTransparency(value) {
    // Map 0-100 to smooth blur and opacity values
    // 0 = solid (no blur, opaque)
    // 100 = max glass (max blur, transparent)
    
    const blurAmount = Math.round((value / 100) * 30); // 0px to 30px
    const saturation = 100 + Math.round((value / 100) * 100); // 100% to 200%
    const bgOpacity = 1 - (value / 100) * 0.6; // 1.0 to 0.4
    
    // Apply CSS custom properties for smooth interpolation
    root.style.setProperty('--transparency-blur', `${blurAmount}px`);
    root.style.setProperty('--transparency-saturation', `${saturation}%`);
    root.style.setProperty('--transparency-bg-opacity', bgOpacity);
    
    // Add text shadow for readability when transparency is high
    if (value > 50) {
      root.classList.add('ic-glass-text');
    } else {
      root.classList.remove('ic-glass-text');
    }
  }
  
  // Set initial transparency
  updateTransparency(parseInt(opacitySlider.value));

  // Keyboard shortcuts for glass effect adjustment
  let gKeyHeld = false;
  let lastAdjustTime = 0;
  const adjustDebounce = 150; // ms between adjustments
  
  window.addEventListener('keydown', (e) => {
    // Track 'g' key being held
    if (e.key === 'g' && !e.ctrlKey && !e.altKey) {
      gKeyHeld = true;
      return;
    }
    
    // Debounce to prevent rapid-fire adjustments
    const now = Date.now();
    if (now - lastAdjustTime < adjustDebounce) {
      return;
    }
    
    // g+ or g= to increase (+ is on the = key)
    if ((e.key === '+' || e.key === '=') && gKeyHeld && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const currentValue = parseInt(opacitySlider.value);
      const newValue = Math.min(100, currentValue + 5);
      opacitySlider.value = newValue;
      opacitySlider.dispatchEvent(new Event('input'));
      lastAdjustTime = now;
      return;
    }
    
    // g- to decrease
    if (e.key === '-' && gKeyHeld && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const currentValue = parseInt(opacitySlider.value);
      const newValue = Math.max(0, currentValue - 5);
      opacitySlider.value = newValue;
      opacitySlider.dispatchEvent(new Event('input'));
      lastAdjustTime = now;
      return;
    }
  });
  
  window.addEventListener('keyup', (e) => {
    // Release 'g' key tracking
    if (e.key === 'g') {
      gKeyHeld = false;
    }
  });
}

function setupIPCListeners() {
  window.electronAPI.onSessionState((data) => {
    sessionActive = data.active;
    sessionPaused = data.paused;
    
    if (data.active && !sessionStartTime) {
      sessionStartTime = Date.now();
      startTimer();
    } else if (!data.active) {
      sessionStartTime = null;
      stopTimer();
    }
    
    updateUI();
  });

  window.electronAPI.onTranscriptUpdate((data) => {
    // Show last transcript entry as question
    if (data.transcript && data.transcript.length > 0) {
      const lastEntry = data.transcript[data.transcript.length - 1];
      currentQuestion = lastEntry;
    }
    
    if (data.livePartial) {
      live.textContent = data.livePartial;
    } else {
      live.textContent = '';
    }
  });

  window.electronAPI.onAnswerChunk((text) => {
    if (currentAnswer === '') {
      // First chunk - show card with question
      showAnswerCard();
    }
    currentAnswer += text;
    displayAnswer(currentAnswer);
  });

  window.electronAPI.onAnswerDone(() => {
    console.log('[renderer] Answer complete');
  });

  window.electronAPI.onError((error) => {
    showError(error);
  });
}

function updateUI() {
  // Dot indicator
  dot.className = 'ic-dot';
  if (sessionActive) {
    dot.classList.add(sessionPaused ? 'paused' : 'active');
  }

  // Status text
  if (!sessionActive) {
    status.textContent = 'Inactive';
  } else if (sessionPaused) {
    status.textContent = 'Paused';
  } else {
    status.textContent = 'Active';
  }

  // Button visibility and states
  if (!sessionActive) {
    // Inactive: Show Start button only
    startBtn.hidden = false;
    pauseBtn.hidden = true;
    resumeBtn.hidden = true;
    exitBtn.disabled = false;
    clearBtn.disabled = true;
    answerBtn.disabled = true;
    analyseBtn.disabled = true;
  } else if (sessionPaused) {
    // Paused: Show Resume, hide Start/Pause
    startBtn.hidden = true;
    pauseBtn.hidden = true;
    resumeBtn.hidden = false;
    exitBtn.disabled = false;
    clearBtn.disabled = false;
    answerBtn.disabled = true;
    analyseBtn.disabled = true;
  } else {
    // Active: Show Pause, hide Start/Resume
    startBtn.hidden = true;
    pauseBtn.hidden = false;
    resumeBtn.hidden = true;
    exitBtn.disabled = false;
    clearBtn.disabled = false;
    answerBtn.disabled = false;
    analyseBtn.disabled = false;
  }
}

function startTimer() {
  stopTimer();
  timerInterval = setInterval(() => {
    if (!sessionStartTime) return;
    const elapsed = Math.floor((Date.now() - sessionStartTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    timer.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  timer.textContent = '00:00';
}

function showAnswerCard() {
  card.removeAttribute('data-empty');
  summary.removeAttribute('data-empty');
  heading.removeAttribute('data-empty');
  questionText.textContent = currentQuestion || 'Question';
}

function clearAnswerCard() {
  card.setAttribute('data-empty', '1');
  summary.setAttribute('data-empty', '1');
  heading.setAttribute('data-empty', '1');
  body.innerHTML = '';
  currentAnswer = '';
  currentQuestion = '';
}

function displayAnswer(text) {
  if (!text) {
    body.innerHTML = '';
    return;
  }

  // Render markdown
  const html = renderMarkdown(text);
  body.innerHTML = html;
  
  // Scroll to bottom
  body.scrollTop = body.scrollHeight;
}

function showError(message) {
  console.error('[renderer] Error:', message);
  err.textContent = message;
  setTimeout(() => {
    err.textContent = '';
  }, 5000);
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Reset answer when new question comes in
window.electronAPI.onTranscriptUpdate(() => {
  if (currentAnswer) {
    clearAnswerCard();
  }
});
