// Interview Copilot in-tab panel (content script).
//
// Lives inside the meeting page DOM. Hidden by default; revealed when
// background.js sends `panel-show`. All UI events go back to background via
// chrome.runtime.sendMessage; all state updates arrive as broadcasts which
// background.js routes here via chrome.tabs.sendMessage.
//
// Privacy note: this overlay IS visible during tab-share. The Hide button
// (and the "ic-badge" small floating circle) collapse the panel for moments
// when the user shares the tab.

(() => {
  if (window.__ic_panel_loaded__) return;
  window.__ic_panel_loaded__ = true;

  // --- DOM scaffolding ----------------------------------------------------
  const root = document.createElement("div");
  root.id = "ic-root";
  root.hidden = true;
  root.innerHTML = `
    <div class="ic-bar">
      <div class="ic-logo">AS</div>
      <div class="ic-name">AdShield Lite</div>
      <div class="ic-spacer"></div>
      <span class="ic-timer" id="ic-timer">00:00</span>
      <span class="ic-dot" id="ic-dot" title="Listening state"></span>
      <button id="ic-popout" title="Pop the panel out as a floating window that stays on top of any app (VSCode, terminal, etc.). Hidden when you share a Chrome tab or a single window.">Pop out</button>
      <button id="ic-hide"   title="Hide panel (you can still see the badge in the corner)">Hide</button>
      <button id="ic-pause"  title="Pause - stop reacting to the interviewer's voice while you type code. Audio capture stays alive so resume is instant.">Pause</button>
      <button id="ic-resume" class="ic-primary" title="Resume listening" hidden>Resume</button>
      <button id="ic-exit"   class="ic-danger" title="End the session and close the panel">End</button>
      <button id="ic-clear"  title="Wipe transcript and dismiss any answer">Clear</button>
    </div>
    <div class="ic-actions">
      <button id="ic-answer"  class="ic-primary" title="Generate an answer from the current transcript">Answer Question</button>
      <button id="ic-analyse" title="Capture the meeting screen and answer based on what's shown">Analyse Screen</button>
      <span class="ic-spacer" id="ic-status">Idle</span>
    </div>
    <div class="ic-live" id="ic-live"></div>
    <div class="ic-err"  id="ic-err"></div>
    <div class="ic-card" id="ic-card">
      <button class="ic-close" id="ic-close" title="Dismiss this answer">&times;</button>
      <div class="ic-summary" id="ic-summary" data-empty="1"></div>
      <div class="ic-heading" id="ic-heading" data-empty="1"></div>
      <div class="ic-body"    id="ic-body"></div>
    </div>
  `;

  const badge = document.createElement("button");
  badge.id = "ic-badge";
  badge.title = "Show AdShield Lite panel";
  badge.textContent = "AS";

  function attach() {
    if (!document.body) {
      requestAnimationFrame(attach);
      return;
    }
    document.body.appendChild(root);
    document.body.appendChild(badge);
  }
  attach();

  const $ = (id) => root.querySelector(`#${id}`) || document.getElementById(id);

  // --- State --------------------------------------------------------------
  let timerStartedAt = 0;
  let timerHandle = null;
  let answering = false;
  let pendingDeltaBuffer = "";
  let paused = false;

  // --- Timer --------------------------------------------------------------
  function fmt(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    const ss = String(s % 60).padStart(2, "0");
    return `${String(m).padStart(2, "0")}:${ss}`;
  }
  function startTimer() {
    timerStartedAt = Date.now();
    if (timerHandle) clearInterval(timerHandle);
    timerHandle = setInterval(() => {
      $("ic-timer").textContent = fmt(Date.now() - timerStartedAt);
    }, 500);
    $("ic-timer").textContent = "00:00";
  }
  function stopTimer() {
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
  }

  // --- Visibility ---------------------------------------------------------
  // When `autoPopOut` is on we NEVER show the in-tab panel: the user only
  // ever sees the small IC badge, and the first click/keypress on it pops
  // the real UI into a Document PiP window. This way nothing visible to a
  // screen-share viewer reveals what the panel does, and stop/restart cycles
  // mid-interview don't flash the panel into the meeting tab.
  let autoPopOut = false;

  function showPanel() {
    if (autoPopOut && !pipWin) {
      // Stealth path: the panel itself stays hidden in the tab, but we DO
      // expose the small "AS" badge in the bottom-right corner as a
      // guaranteed-click trigger to pop the panel out. The badge is the
      // fallback for when chrome.commands (Ctrl+Shift+Y) is unbound, the
      // toolbar icon is unpinned, or the user just wants a fixed,
      // muscle-memory click target. Trade-off: the badge IS visible during
      // a tab- or window-share - but it's a 28px circle in the corner
      // that reads as random page chrome, not as an obvious AI tool.
      root.hidden = true;
      badge.dataset.visible = "1";
      return;
    }
    root.hidden = false;
    badge.dataset.visible = "0";
    badge.classList.remove("ic-pulse");
  }
  function hidePanelToBadge() {
    root.hidden = true;
    // Whether or not we're in stealth mode, "Hide" should always leave a
    // way back: the badge. The whole point of clicking Hide is "make this
    // smaller for now, I'll bring it back later".
    badge.dataset.visible = "1";
  }
  function removePanel() {
    root.hidden = true;
    badge.dataset.visible = "0";
    badge.classList.remove("ic-pulse");
    stopTimer();
    setActive(false);
  }

  // ---- Document Picture-in-Picture (always-on-top floating panel) -------
  //
  // documentPictureInPicture (Chrome 116+) gives us a real OS-level window
  // that:
  //   - stays on top of any app (VSCode, terminal, Notepad...)
  //   - is NOT inside any browser tab, so when the user shares a Chrome tab
  //     or a single window in Meet/Zoom this window is invisible to the
  //     interviewer
  //   - WILL still appear under "share entire screen" on a single monitor
  //     (no extension can hide from that - only OS-level
  //      SetWindowDisplayAffinity / NSWindowSharingNone can, and those are
  //      exclusive to native apps).  Workaround: put it on a 2nd monitor
  //      that you don't share, or pick "Share window" / "Share tab" instead
  //      of "Share entire screen".
  let pipWin = null;
  // Set to true when dockBack() is called from a user click on the Dock
  // button. Used inside onPipClosed() to differentiate "user wants the
  // panel back inside the tab" (show it centered) from "user closed PiP
  // via the native X button" (return to badge state). Reset every time.
  let dockingByButton = false;

  function pipSupported() {
    return typeof window.documentPictureInPicture !== "undefined"
        && typeof window.documentPictureInPicture.requestWindow === "function";
  }

  async function popOut() {
    if (pipWin) { try { pipWin.focus(); } catch {} return; }
    if (!pipSupported()) {
      setError("Pop-out needs Chrome 116+ (Document Picture-in-Picture).");
      return;
    }
    try {
      pipWin = await window.documentPictureInPicture.requestWindow({
        width: 520, height: 640,
      });
      // Copy our stylesheet into the PiP document - it's a separate document.
      const link = pipWin.document.createElement("link");
      link.rel = "stylesheet";
      link.href = chrome.runtime.getURL("content/panel.css");
      pipWin.document.head.appendChild(link);
      pipWin.document.title = "AdShield Lite";
      // Try OS-level window transparency. On Chrome 130+ this lets the
      // desktop / VSCode / whatever is behind the PiP show through. On
      // older Chrome, the window backdrop falls back to the OS default
      // (white on Windows light theme). The CSS in panel.css guards
      // against the white-fallback case by giving the root a heavily-
      // dark rgba background, which paints over the white into a
      // dark-with-frosted-glass effect.
      pipWin.document.documentElement.style.background = "transparent";
      const body = pipWin.document.body;
      body.style.margin = "0";
      body.style.padding = "0";
      body.style.background = "transparent";
      body.style.colorScheme = "dark";
      // Move the existing root element across.  Event listeners survive
      // adoptNode so all our click handlers keep working.
      body.appendChild(root);
      root.classList.add("ic-pip");
      root.hidden = false;
      // Hide the in-tab badge while popped out.
      badge.dataset.visible = "0";
      $("ic-popout").textContent = "Dock";
      $("ic-popout").title = "Move the panel back into the meeting tab";
      $("ic-hide").disabled = true;
      log("popped out into PiP window");

      pipWin.addEventListener("pagehide", onPipClosed, { once: true });
    } catch (e) {
      pipWin = null;
      const msg = e?.message || String(e);
      // requestWindow() rejects with NotAllowedError when no transient user
      // activation is present in the calling frame. This can happen when the
      // trigger came through chrome.tabs.sendMessage from the popup button -
      // some Chrome versions don't propagate the popup click as a user
      // gesture across the message hop. Both chrome.commands and
      // chrome.contextMenus DO propagate it; tell the user.
      if (/NotAllowedError|user (?:activation|gesture)/i.test(msg)) {
        setError(
          "Couldn't open the floating window from this button. Press " +
          "Ctrl+Shift+Y in the meeting tab, or right-click the page and " +
          "pick \"Show AdShield panel\"."
        );
        // Best-effort fallback so the user is not left with no UI: show the
        // in-tab panel. They can pop it out from there with the Pop out
        // button (which IS a real page-level click and always works).
        showPanel();
      } else {
        setError(`Pop-out failed: ${msg}`);
      }
    }
  }

  function onPipClosed() {
    try { document.body.appendChild(root); } catch {}
    root.classList.remove("ic-pip");
    $("ic-popout").textContent = "Pop out";
    $("ic-popout").title = "Pop the panel out as a floating window that stays on top of any app";
    $("ic-hide").disabled = false;
    pipWin = null;
    log(`pip closed (byButton=${dockingByButton})`);

    if (autoPopOut) {
      if (dockingByButton) {
        // User clicked Dock - they explicitly asked for the panel to come
        // back into the tab. Show it centered (CSS handles the centering
        // via top: 12px / left: 50% / transform translateX). Hide the
        // badge since the panel itself is now the visible UI.
        root.hidden = false;
        badge.dataset.visible = "0";
        badge.classList.remove("ic-pulse");
      } else {
        // User closed PiP via the native X button (top-right of the PiP
        // window). Return to the "badge only" state so they can re-popout
        // with one click.
        root.hidden = true;
        badge.dataset.visible = "1";
      }
    } else {
      // Non-stealth: panel always shows in-tab, badge stays hidden.
      root.hidden = false;
      badge.dataset.visible = "0";
    }
    dockingByButton = false;
  }

  function dockBack() {
    if (!pipWin) return;
    dockingByButton = true;
    try { pipWin.close(); } catch {}
    // pagehide fires inside pipWin which triggers onPipClosed.
  }

  // Disable the pop-out button entirely on browsers that don't support it.
  if (!pipSupported()) {
    queueMicrotask(() => {
      const b = $("ic-popout");
      if (b) {
        b.disabled = true;
        b.title = "Pop-out requires Chrome 116+";
      }
    });
  }

  // Tiny logger so users can confirm in DevTools whether their clicks are
  // reaching the panel at all. Look for "[IC]" lines in the page console.
  const log = (...args) => console.log("[IC]", ...args);

  // ---- Extension-context lifecycle --------------------------------------
  //
  // When the extension is reloaded/updated while this content script is
  // still running on the page, `chrome.runtime` is invalidated synchronously
  // and ANY call to chrome.runtime.* throws "Extension context invalidated".
  // The rejection is sometimes thrown before the Promise is even created, so
  // .catch() never attaches.  We trap that condition once and degrade
  // gracefully (panel buttons are disabled, a notice is shown).
  let invalidated = false;

  function isExtensionAlive() {
    try { return typeof chrome !== "undefined" && !!chrome.runtime?.id; }
    catch { return false; }
  }

  function isInvalidationError(e) {
    const msg = String(e?.message || e || "");
    return msg.includes("Extension context invalidated")
        || msg.includes("Receiving end does not exist") && !isExtensionAlive();
  }

  function handleInvalidation() {
    if (invalidated) return;
    invalidated = true;
    log("extension context invalidated - panel will stop talking to background");
    stopTimer();
    try {
      $("ic-status").textContent = "Reload page";
      $("ic-err").textContent = "AdShield Lite was reloaded. Refresh this tab to reconnect.";
      $("ic-err").dataset.visible = "1";
      $("ic-err").dataset.kind = "error";
      $("ic-dot").classList.add("ic-error");
      $("ic-dot").classList.remove("ic-active");
      // Disable everything except the visual dismiss buttons.
      ["ic-stop", "ic-answer", "ic-analyse", "ic-clear"].forEach((id) => {
        const b = $(id); if (b) b.disabled = true;
      });
    } catch { /* DOM may be gone too */ }
  }

  function send(type, extra = {}) {
    if (invalidated) return Promise.resolve();
    if (!isExtensionAlive()) { handleInvalidation(); return Promise.resolve(); }
    log("click ->", type, extra);
    try {
      const p = chrome.runtime.sendMessage({ type, ...extra });
      // sendMessage SHOULD return a Promise, but in some Chrome versions a
      // synchronous throw can happen before the Promise materialises.
      return Promise.resolve(p).catch((e) => {
        if (isInvalidationError(e)) handleInvalidation();
        else log("sendMessage failed:", e?.message || e);
      });
    } catch (e) {
      if (isInvalidationError(e)) handleInvalidation();
      else log("sendMessage threw:", e?.message || e);
      return Promise.resolve();
    }
  }

  badge.addEventListener("click", () => {
    log("click -> badge -> popout");
    badge.classList.remove("ic-pulse");
    // A real DOM click on the badge IS a fully-fledged user gesture, so
    // documentPictureInPicture.requestWindow() never trips its "user
    // gesture required" check from this path. This is the most reliable
    // trigger of all four (more reliable than the popup button, which
    // hops through chrome.tabs.sendMessage and may lose activation).
    if (pipWin) { try { pipWin.focus(); } catch {} return; }
    if (pipSupported()) popOut();
    else showPanel();
  });
  $("ic-popout").addEventListener("click", () => {
    log("click -> popout/dock");
    if (pipWin) dockBack(); else popOut();
  });

  // Toggle the floating panel: pops out into Document PiP if not yet popped,
  // docks back into the tab if it is. Falls back to a regular in-tab show
  // when PiP is unavailable (e.g. browser too old). Used by both the hotkey
  // and the chrome.commands message coming from background.js.
  function togglePopOut() {
    badge.classList.remove("ic-pulse");
    if (pipWin) dockBack();
    else if (pipSupported()) popOut();
    else showPanel();
  }

  // Page-level hotkey - kept as a fallback for tabs where chrome.commands
  // isn't wired (e.g. the user manually unbound the shortcut). The primary
  // path is chrome.commands -> background.js -> "panel-toggle-popout"
  // message handled below in handleMessage(). Capture-phase so the page
  // can't swallow it.
  //
  // We use Ctrl+Shift+Y. Earlier we tried Alt+Shift+J and Alt+Shift+I,
  // both of which lost the keypress on Windows: Alt+Shift+I is bound by
  // Chrome itself ("Send feedback to Google"), and Alt+Shift triggers
  // Windows' built-in IME / keyboard-layout swap, swallowing the J.
  // Ctrl+Shift+Y has none of those collisions.
  window.addEventListener("keydown", (e) => {
    if (!e.ctrlKey || !e.shiftKey) return;
    if (e.code !== "KeyY") return;
    e.preventDefault();
    e.stopPropagation();
    log("hotkey Ctrl+Shift+Y");
    togglePopOut();
  }, true);
  $("ic-hide").addEventListener("click", () => { log("click -> hide"); hidePanelToBadge(); });
  $("ic-exit").addEventListener("click", () => {
    send("stop-session");
    if (pipWin) dockBack();
    removePanel();
  });
  $("ic-pause").addEventListener("click", () => {
    log("click -> pause");
    setPausedUI(true);
    send("pause-session");
  });
  $("ic-resume").addEventListener("click", () => {
    log("click -> resume");
    setPausedUI(false);
    send("resume-session");
  });
  $("ic-answer").addEventListener("click",  () => send("regenerate"));
  $("ic-analyse").addEventListener("click", () => send("analyse-screen"));
  $("ic-close").addEventListener("click",   () => { log("click -> close"); clearAnswerCard(); });
  $("ic-clear").addEventListener("click", () => {
    send("clear-transcript");
    setLivePartial("");
    clearAnswerCard();
  });

  // Toggle Pause <-> Resume button visibility AND grey out the action row
  // (Answer/Analyse) so the user can tell at a glance that we're not
  // listening to the interviewer right now.
  function setPausedUI(p) {
    paused = !!p;
    $("ic-pause").hidden  = paused;
    $("ic-resume").hidden = !paused;
    $("ic-answer").disabled  = paused;
    $("ic-analyse").disabled = paused;
    $("ic-status").textContent = paused ? "Paused" : (answering ? "Answering" : "Listening");
    $("ic-dot").classList.toggle("ic-paused", paused);
    if (paused) {
      // Make sure no stale partial caption keeps shimmering under the cursor
      // while the user is typing in their editor.
      setLivePartial("");
    }
  }

  log("panel injected, listening for clicks");

  // --- Status & dot -------------------------------------------------------
  function setActive(active) {
    $("ic-dot").classList.toggle("ic-active", !!active);
    $("ic-dot").classList.remove("ic-error");
    if (!active) {
      // Session ended - reset pause UI so a fresh start is clean.
      paused = false;
      $("ic-pause").hidden  = false;
      $("ic-resume").hidden = true;
      $("ic-dot").classList.remove("ic-paused");
      $("ic-status").textContent = "Idle";
    } else if (!paused) {
      $("ic-status").textContent = answering ? "Answering" : "Listening";
    }
    $("ic-pause").disabled  = !active;
    $("ic-resume").disabled = !active;
  }
  function setError(msg) {
    if (msg) {
      $("ic-err").textContent = msg;
      $("ic-err").dataset.visible = "1";
      $("ic-err").dataset.kind = "error";
      $("ic-dot").classList.add("ic-error");
    } else {
      $("ic-err").dataset.visible = "0";
      $("ic-err").textContent = "";
      $("ic-err").dataset.kind = "";
    }
  }

  // --- Live partial caption ----------------------------------------------
  function setLivePartial(text) {
    const t = (text || "").trim();
    if (!t) {
      $("ic-live").dataset.visible = "0";
      $("ic-live").textContent = "";
    } else {
      $("ic-live").textContent = t;
      $("ic-live").dataset.visible = "1";
    }
  }

  // --- Answer card --------------------------------------------------------
  function clearAnswerCard() {
    $("ic-card").dataset.visible = "0";
    $("ic-summary").dataset.empty = "1"; $("ic-summary").textContent = "";
    $("ic-heading").dataset.empty = "1"; $("ic-heading").textContent = "";
    $("ic-body").innerHTML = "";
    pendingDeltaBuffer = "";
    answering = false;
    $("ic-status").textContent = "Listening";
  }

  function beginAnswer() {
    $("ic-card").dataset.visible = "1";
    $("ic-summary").dataset.empty = "1"; $("ic-summary").textContent = "";
    $("ic-heading").dataset.empty = "1"; $("ic-heading").textContent = "";
    $("ic-body").innerHTML = `<p><span class="ic-spin"></span> Thinking...</p>`;
    $("ic-status").textContent = "Answering";
    pendingDeltaBuffer = "";
    answering = true;
  }

  // The LLM is instructed to output:
  //   Q: <one-line summary of the question>
  //   A: **<short heading>**
  //
  //   <body markdown>
  //
  // The streamed text might arrive in arbitrary chunks; we re-parse on each
  // delta and re-render only the parts that have changed.
  function reRender() {
    const raw = pendingDeltaBuffer.replace(/\r\n/g, "\n");
    let summary = "", heading = "", body = "";
    const m = raw.match(/^\s*Q:\s*([\s\S]*?)(?:\n+A:\s*([\s\S]*))?$/);
    if (m) {
      summary = (m[1] || "").trim();
      const after = (m[2] || "").trim();
      if (after) {
        // Heading is the first line; body is the rest. If first line begins
        // with **bold**, that's the heading.
        const lines = after.split(/\n+/);
        const headLine = lines[0].trim();
        const headM = headLine.match(/^\*\*(.+?)\*\*\s*\.?$/);
        if (headM) {
          heading = headM[1].trim();
          body = lines.slice(1).join("\n").trim();
        } else {
          // No bold heading; treat the whole "A:" payload as body.
          body = after;
        }
      }
    } else {
      // Streamed text doesn't match the format yet (e.g. a model that ignored
      // the instructions). Show whatever we have as the body.
      body = raw;
    }

    if (summary) { $("ic-summary").textContent = summary; $("ic-summary").dataset.empty = "0"; }
    if (heading) { $("ic-heading").textContent = heading; $("ic-heading").dataset.empty = "0"; }

    if (body || answering === false) {
      $("ic-body").innerHTML = renderMarkdown(body) || "";
    }
  }

  function appendAnswer(delta) {
    pendingDeltaBuffer += delta;
    reRender();
    const card = $("ic-card");
    card.scrollTop = card.scrollHeight;
  }
  function endAnswer() {
    answering = false;
    $("ic-status").textContent = "Listening";
    if (!pendingDeltaBuffer.trim()) clearAnswerCard();
  }

  // --- Tiny safe markdown renderer ---------------------------------------
  // Handles **bold**, *italic*, `inline code`, ```fenced code blocks```,
  // paragraphs, and unordered / ordered lists. The fenced-code path uses a
  // placeholder so the line splitter doesn't shred multi-line code blocks
  // (which is what was collapsing functions onto a single horizontal-scrolling
  // line).
  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  function renderMarkdown(src) {
    if (!src) return "";
    let s = escapeHtml(src);

    // 1. Lift fenced code blocks out of the text BEFORE we split on \n,
    //    so their internal newlines are preserved verbatim.
    const codeBlocks = [];
    s = s.replace(/```([a-zA-Z0-9_+-]*)\r?\n?([\s\S]*?)```/g, (_m, _lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push(code.replace(/\n$/, ""));
      return `\u0000PRE${idx}\u0000`;
    });

    // 2. Inline transforms (these are safe to run on the linearised string).
    s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");

    // 3. Block-level pass: paragraphs and lists.
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
        out.push(`<pre>${codeBlocks[Number(preM[1])]}</pre>`);
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

    // 4. Restore any inline placeholders that landed inside paragraphs.
    let html = out.join("\n");
    html = html.replace(/\u0000PRE(\d+)\u0000/g, (_m, i) => `<pre>${codeBlocks[Number(i)]}</pre>`);
    return html;
  }

  // --- Message wiring -----------------------------------------------------
  // Wrap the listener registration so a stale `chrome` reference (after the
  // extension was reloaded) doesn't throw at load time on the next page.
  try {
    chrome.runtime.onMessage.addListener((m) => {
      if (invalidated || !m || typeof m !== "object") return;
      try { handleMessage(m); }
      catch (e) {
        if (isInvalidationError(e)) handleInvalidation();
        else log("onMessage handler error:", e?.message || e);
      }
    });
  } catch (e) {
    if (isInvalidationError(e)) handleInvalidation();
    else log("onMessage register failed:", e?.message || e);
  }

  function handleMessage(m) {
    switch (m.type) {
      case "panel-show":
        // The background tells us whether stealth (auto-popout) mode is on.
        // Default true if the field is missing (older background builds).
        autoPopOut = m.autoPopOut !== false;
        // Tag the root so CSS can hide stealth-irrelevant chrome (pop-out,
        // hide button) when popped out in PiP.
        root.classList.toggle("ic-stealth", autoPopOut);
        showPanel();
        setActive(true);
        setPausedUI(false);
        setError("");
        clearAnswerCard();
        startTimer();
        break;
      case "panel-hide":
        removePanel();
        break;
      case "panel-toggle-popout":
        // Sent from background.js when the user hits the chrome.commands
        // hotkey (Ctrl+Shift+Y). Transient user activation propagates from
        // the keypress through to this message handler, so requestWindow()
        // does NOT throw "user gesture required".
        log("cmd toggle-panel");
        togglePopOut();
        break;
      case "session-state":
        setActive(!!m.active);
        if (typeof m.paused === "boolean") setPausedUI(m.paused);
        if (m.active) {
          if (!timerHandle) startTimer();
        } else {
          stopTimer();
        }
        break;
      case "transcript-partial":
        setLivePartial(m.text || "");
        break;
      case "transcript-append":
        // Final transcript chunk arrived; clear the live caption. The auto-
        // answer flow in background.js will fire shortly after.
        setLivePartial("");
        break;
      case "transcript-cleared":
        setLivePartial("");
        clearAnswerCard();
        break;
      case "answer-begin":
        setError("");
        beginAnswer();
        break;
      case "answer-delta":
        if (!answering) beginAnswer();
        appendAnswer(m.delta || "");
        break;
      case "answer-end":
        endAnswer();
        break;
      case "info":
        // Non-fatal status (e.g. "Primary LLM failed; falling back to X").
        if (m.info) {
          $("ic-err").textContent = m.info;
          $("ic-err").dataset.visible = "1";
          $("ic-err").dataset.kind = "info";
        }
        break;
      case "error":
        setError(m.error || "Unknown error");
        endAnswer();
        break;
    }
  }

  // Tell background we're alive on this tab so it knows it can send `panel-show`.
  // Use the hardened send() helper so an invalidated context doesn't throw.
  send("panel-ready");

  // Periodically re-check that the extension context is alive. If the user
  // reloads / disables the extension we want to surface a friendly banner
  // instead of letting the next click throw "Extension context invalidated".
  const aliveCheck = setInterval(() => {
    if (invalidated) { clearInterval(aliveCheck); return; }
    if (!isExtensionAlive()) {
      clearInterval(aliveCheck);
      handleInvalidation();
    }
  }, 5000);
})();
