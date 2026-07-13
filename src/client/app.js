/* global io */

(function () {
  'use strict';

  const AUTH_TOKEN_KEY = 'cursor-remote-token';
  const PAIRED_KEY = 'cursor-remote-paired';

  const defaultState = {
    connected: false,
    extractorStatus: 'idle',
    lastExtractionAt: null,
    consecutiveExtractionFailures: 0,
    lastExtractionError: null,
    agentStatus: 'idle',
    agentActivityText: null,
    agentActivityLive: false,
    agentActivitySource: 'none',
    messages: [],
    pendingApprovals: [],
    inputAvailable: false,
    chatTabs: [],
    mode: { current: 'agent', available: [] },
    model: { current: 'Auto', currentId: '' },
    windows: [],
    activeWindowId: '',
    composerQueue: { items: [] },
    questionnaire: null,
  };

  function getAuthToken() {
    return localStorage.getItem(AUTH_TOKEN_KEY) || '';
  }

  function getAuthHeaders() {
    const token = getAuthToken();
    return token ? { 'Authorization': 'Bearer ' + token } : {};
  }

  function isPaired() {
    return localStorage.getItem(PAIRED_KEY) === '1';
  }

  function setPaired(v) {
    if (v) localStorage.setItem(PAIRED_KEY, '1');
    else localStorage.removeItem(PAIRED_KEY);
  }

  function newCommandId() {
    const cryptoApi = globalThis.crypto;
    if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
      return cryptoApi.randomUUID();
    }
    const bytes = new Uint8Array(16);
    if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
      cryptoApi.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
  }

  async function checkAuth() {
    try {
      const res = await fetch('/health', { credentials: 'same-origin', headers: getAuthHeaders() });
      if (res.ok) {
        const data = await res.json();
        if (data.authRequired) {
          if (data.sessionValid === true) return true;
          if (data.sessionValid === false) {
            localStorage.removeItem(AUTH_TOKEN_KEY);
            setPaired(false);
            return false;
          }
          if (getAuthToken()) return true;
          return false;
        }
        return true;
      }
    } catch { /* network error */ }
    return true;
  }

  function showOnboarding() {
    const el = document.getElementById('onboarding');
    if (el) el.classList.remove('hidden');
  }
  function hideOnboarding() {
    const el = document.getElementById('onboarding');
    if (el) el.classList.add('hidden');
  }

  function setupOnboarding() {
    const codeInput = document.getElementById('onboarding-code');
    const btn = document.getElementById('onboarding-pair-btn');
    const errEl = document.getElementById('onboarding-error');

    codeInput.addEventListener('input', () => {
      let v = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (v.length > 3) v = v.slice(0, 3) + '-' + v.slice(3, 6);
      codeInput.value = v;
      errEl.textContent = '';
    });

    async function submit() {
      btn.disabled = true;
      errEl.textContent = '';
      try {
        const res = await fetch('/api/pair', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: codeInput.value }),
        });
        const data = await res.json();
        if (res.ok && data.token) {
          localStorage.setItem(AUTH_TOKEN_KEY, data.token);
          setPaired(true);
          hideOnboarding();
          bootstrap();
        } else {
          errEl.textContent = data.error || 'Invalid code';
        }
      } catch {
        errEl.textContent = 'Network error';
      }
      btn.disabled = false;
    }

    btn.addEventListener('click', submit);
    codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
  }

  async function init() {
    registerServiceWorker();
    setupInstallPrompt();
    setupOnboarding();
    const ok = await checkAuth();
    if (!ok) {
      showOnboarding();
      return;
    }
    bootstrap();
  }

  function registerServiceWorker() {
    if (typeof navigator.serviceWorker?.register !== 'function') return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch((err) => {
        console.warn('[pwa] service worker registration failed', err);
      });
    });
  }

  function setupInstallPrompt() {
    const DISMISS_KEY = 'cursor-remote-install-dismissed';
    const $banner = document.getElementById('install-banner');
    const $btn = document.getElementById('install-banner-btn');
    const $dismiss = document.getElementById('install-banner-dismiss');
    if (!$banner || !$btn || !$dismiss) return;

    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true;
    if (isStandalone) return;
    if (localStorage.getItem(DISMISS_KEY) === '1') return;

    let deferredPrompt = null;

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      $banner.classList.remove('hidden');
    });

    $btn.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      $banner.classList.add('hidden');
      deferredPrompt.prompt();
      try {
        await deferredPrompt.userChoice;
      } catch (_) { /* ignore */ }
      deferredPrompt = null;
    });

    $dismiss.addEventListener('click', () => {
      localStorage.setItem(DISMISS_KEY, '1');
      $banner.classList.add('hidden');
    });

    window.addEventListener('appinstalled', () => {
      deferredPrompt = null;
      $banner.classList.add('hidden');
    });

    // iOS Safari: no beforeinstallprompt — show a how-to hint once
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const isSafari = /safari/i.test(navigator.userAgent) && !/crios|fxios|edgios/i.test(navigator.userAgent);
    if (isIos && isSafari && !localStorage.getItem(DISMISS_KEY)) {
      const text = $banner.querySelector('.install-banner-text');
      if (text) {
        text.innerHTML = '<strong>Add to Home Screen</strong><span>Tap Share, then “Add to Home Screen”</span>';
      }
      $btn.classList.add('hidden');
      $banner.classList.remove('hidden');
    }
  }

  function bootstrap() {

  let state = { ...defaultState };

  let userScrolledUp = false;
  let autoScrollJob = 0;
  let notificationPermission = 'default';
  const notifiedMessageIds = new Set();
  let activePlanModal = null;
  let activePlanModelContext = null;
  let activeSheet = null;
  let lastActiveTabTitle = '';
  const pendingCommandResults = new Map();

  function isNearMessagesBottom() {
    const threshold = 80;
    return $messages.scrollTop + $messages.clientHeight >= $messages.scrollHeight - threshold;
  }

  function scheduleMessagesAutoScroll() {
    const jobId = ++autoScrollJob;
    requestAnimationFrame(() => {
      if (jobId !== autoScrollJob) return;
      if (userScrolledUp) return;
      $messages.scrollTop = $messages.scrollHeight;
    });
  }

  const $messages = document.getElementById('messages');
  const $emptyState = document.getElementById('empty-state');
  const $emptyPrimary = document.getElementById('empty-state-primary');
  const $emptyHint = document.getElementById('empty-state-hint');
  const $activityStrip = document.getElementById('agent-activity-strip');
  const $statusText = document.getElementById('agent-status-text');
  const $approvalBar = document.getElementById('approval-bar');
  const $approvalDesc = document.getElementById('approval-desc');
  const $btnApprove = document.getElementById('btn-approve');
  const $btnReject = document.getElementById('btn-reject');
  var questionnaireSelections = {};
  const $questionnaireBar = document.getElementById('questionnaire-bar');
  const $questionnaireStepper = document.getElementById('questionnaire-stepper');
  const $questionnaireQuestions = document.getElementById('questionnaire-questions');
  const $btnQSkip = document.getElementById('btn-q-skip');
  const $btnQContinue = document.getElementById('btn-q-continue');
  const $input = document.getElementById('message-input');
  const $btnSend = document.getElementById('btn-send');
  const $toastContainer = document.getElementById('toast-container');

  const $tabBar = document.getElementById('tab-bar');
  const $tabList = document.getElementById('tab-list');
  const $btnNewChat = document.getElementById('btn-new-chat');
  const $pillMode = document.getElementById('pill-mode');
  const $pillModeIcon = document.getElementById('pill-mode-icon');
  const $pillModeText = document.getElementById('pill-mode-text');
  const $pillModel = document.getElementById('pill-model');
  const $pillModelText = document.getElementById('pill-model-text');
  const $pillWindow = document.getElementById('pill-window');
  const $pillWindowText = document.getElementById('pill-window-text');
  const $windowSync = document.getElementById('window-sync');
  const $connChip = document.getElementById('conn-chip');
  const $connChipText = document.getElementById('conn-chip-text');
  const $sheetOverlay = document.getElementById('sheet-overlay');
  const $sheetMode = document.getElementById('sheet-mode');
  const $sheetModeList = document.getElementById('sheet-mode-list');
  const $sheetModel = document.getElementById('sheet-model');
  const $sheetModelList = document.getElementById('sheet-model-list');
  const $sheetPlanModel = document.getElementById('sheet-plan-model');
  const $sheetPlanModelHeader = document.getElementById('sheet-plan-model-header');
  const $sheetPlanModelList = document.getElementById('sheet-plan-model-list');
  const $sheetWindow = document.getElementById('sheet-window');
  const $sheetWindowList = document.getElementById('sheet-window-list');
  const $sheetConnection = document.getElementById('sheet-connection');
  const $sheetConnectionBody = document.getElementById('sheet-connection-body');
  const $planModalOverlay = document.getElementById('plan-modal-overlay');
  const $planModalLabel = document.getElementById('plan-modal-label');
  const $planModalTitle = document.getElementById('plan-modal-title');
  const $planModalBody = document.getElementById('plan-modal-body');
  const $planModalClose = document.getElementById('plan-modal-close');

  // --- Per-window session cache (memory + IndexedDB) ---
  const memWindowCache = new Map();
  let windowCacheDb = null;
  let windowSyncStatus = 'live'; // live | syncing | cached
  let pendingSwitchId = null;
  let pendingSwitchPrevId = null;

  function openWindowCacheDb() {
    if (!('indexedDB' in window)) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open('cursor-remote-windows', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('sessions')) {
            db.createObjectStore('sessions', { keyPath: 'windowId' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
    });
  }

  function idbPutSession(snap) {
    if (!windowCacheDb || !snap || !snap.windowId) return;
    try {
      const tx = windowCacheDb.transaction('sessions', 'readwrite');
      tx.objectStore('sessions').put(snap);
    } catch (_) { /* ignore quota / closed */ }
  }

  function idbLoadAllSessions() {
    if (!windowCacheDb) return Promise.resolve([]);
    return new Promise((resolve) => {
      try {
        const tx = windowCacheDb.transaction('sessions', 'readonly');
        const req = tx.objectStore('sessions').getAll();
        req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
        req.onerror = () => resolve([]);
      } catch (_) {
        resolve([]);
      }
    });
  }

  function captureWindowSnapshot(windowId) {
    const win = (state.windows || []).find((w) => w.id === windowId);
    return {
      windowId,
      windowTitle: (win && win.title) || '',
      messages: state.messages || [],
      chatTabs: state.chatTabs || [],
      pendingApprovals: state.pendingApprovals || [],
      agentStatus: state.agentStatus || 'idle',
      agentActivityText: state.agentActivityText || null,
      agentActivityLive: !!state.agentActivityLive,
      agentActivitySource: state.agentActivitySource || 'none',
      composerQueue: state.composerQueue || { items: [] },
      mode: state.mode || { current: 'agent', available: [] },
      model: state.model || { current: 'Auto', currentId: '' },
      questionnaire: state.questionnaire || null,
      inputAvailable: !!state.inputAvailable,
      lastUpdated: Date.now(),
    };
  }

  function applyWindowSnapshot(snap) {
    if (!snap) return;
    state.messages = Array.isArray(snap.messages) ? snap.messages : [];
    state.chatTabs = Array.isArray(snap.chatTabs) ? snap.chatTabs : [];
    state.pendingApprovals = Array.isArray(snap.pendingApprovals) ? snap.pendingApprovals : [];
    state.agentStatus = snap.agentStatus || 'idle';
    state.agentActivityText = snap.agentActivityText || null;
    state.agentActivityLive = !!snap.agentActivityLive;
    state.agentActivitySource = snap.agentActivitySource || 'none';
    state.composerQueue = snap.composerQueue || { items: [] };
    state.mode = snap.mode || { current: 'agent', available: [] };
    state.model = snap.model || { current: 'Auto', currentId: '' };
    state.questionnaire = snap.questionnaire || null;
    if (typeof snap.inputAvailable === 'boolean') state.inputAvailable = snap.inputAvailable;
  }

  function clearWindowScopedState() {
    state.messages = [];
    state.chatTabs = [];
    state.pendingApprovals = [];
    state.agentStatus = 'idle';
    state.agentActivityText = null;
    state.agentActivityLive = false;
    state.agentActivitySource = 'none';
    state.composerQueue = { items: [] };
    state.questionnaire = null;
    state.inputAvailable = false;
  }

  function putWindowCache(windowId, snapOverride) {
    if (!windowId && !snapOverride) return;
    const snap = snapOverride || captureWindowSnapshot(windowId);
    if (!snap.windowId) snap.windowId = windowId;
    memWindowCache.set(snap.windowId, snap);
    if (snap.windowTitle) {
      memWindowCache.set('title:' + String(snap.windowTitle).toLowerCase(), snap);
    }
    idbPutSession(snap);
  }

  function lookupWindowCache(win) {
    if (!win) return null;
    return memWindowCache.get(win.id)
      || (win.title ? memWindowCache.get('title:' + String(win.title).toLowerCase()) : null)
      || null;
  }

  function ingestServerSnapshots(list) {
    if (!Array.isArray(list)) return;
    list.forEach((snap) => {
      if (!snap || !snap.windowId) return;
      const prev = memWindowCache.get(snap.windowId);
      if (prev && prev.lastUpdated && snap.lastUpdated && prev.lastUpdated > snap.lastUpdated) return;
      putWindowCache(snap.windowId, {
        windowId: snap.windowId,
        windowTitle: snap.windowTitle || '',
        messages: Array.isArray(snap.messages) ? snap.messages : [],
        chatTabs: Array.isArray(snap.chatTabs) ? snap.chatTabs : [],
        pendingApprovals: Array.isArray(snap.pendingApprovals) ? snap.pendingApprovals : [],
        agentStatus: snap.agentStatus || 'idle',
        agentActivityText: snap.agentActivityText || null,
        agentActivityLive: !!snap.agentActivityLive,
        agentActivitySource: snap.agentActivitySource || 'none',
        composerQueue: snap.composerQueue || { items: [] },
        mode: snap.mode || { current: 'agent', available: [] },
        model: snap.model || { current: 'Auto', currentId: '' },
        questionnaire: snap.questionnaire || null,
        inputAvailable: false,
        lastUpdated: snap.lastUpdated || Date.now(),
      });
    });
  }

  function isSwitchableWindow(win) {
    if (!win || win.available === false) return false;
    const t = (win.title || '').trim();
    if (!t) return false;
    if (/^(cursor|welcome|getting started|settings)$/i.test(t)) return false;
    return true;
  }

  function parseWindowGroup(title) {
    const raw = (title || '').trim();
    const m = raw.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
    if (m) return { group: m[1].trim() || raw, variant: m[2].trim(), full: raw };
    return { group: raw || 'Window', variant: '', full: raw };
  }

  function getSwitchableWindows() {
    return (state.windows || []).filter(isSwitchableWindow);
  }

  function groupWindows(windows) {
    const map = new Map();
    windows.forEach((win) => {
      const parsed = parseWindowGroup(win.title || '');
      const key = parsed.group.toLowerCase();
      if (!map.has(key)) map.set(key, { group: parsed.group, items: [] });
      map.get(key).items.push({ win, variant: parsed.variant });
    });
    return Array.from(map.values());
  }

  function setWindowSyncStatus(next) {
    const was = windowSyncStatus;
    windowSyncStatus = next;
    renderWindowSync(next === 'live' && was !== 'live');
  }

  function renderWindowSync(pulse) {
    if (!$windowSync) return;
    if (pulse) {
      $windowSync.className = 'window-sync';
      void $windowSync.offsetWidth;
    }
    $windowSync.className = 'window-sync window-sync-' + windowSyncStatus;
    $windowSync.title = windowSyncStatus === 'syncing'
      ? 'Updating…'
      : windowSyncStatus === 'cached'
        ? 'Cached'
        : 'Live';
  }

  function markSwitchLive(windowId) {
    if (pendingSwitchId && windowId && pendingSwitchId !== windowId) return;
    pendingSwitchId = null;
    pendingSwitchPrevId = null;
    setWindowSyncStatus('live');
    if (windowId) putWindowCache(windowId);
  }

  openWindowCacheDb().then((db) => {
    windowCacheDb = db;
    return idbLoadAllSessions();
  }).then((sessions) => {
    sessions.forEach((snap) => {
      if (snap && snap.windowId && !memWindowCache.has(snap.windowId)) {
        memWindowCache.set(snap.windowId, snap);
      }
    });
  });

  const socket = io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    withCredentials: true,
    auth: (cb) => {
      try { cb({ token: getAuthToken() || '' }); } catch { cb({ token: '' }); }
    },
  });

  function sendCommandAwaitResult(eventName, payload) {
    return new Promise((resolve) => {
      const commandId = payload.commandId;
      const timer = setTimeout(() => {
        pendingCommandResults.delete(commandId);
        resolve({ commandId, ok: false, error: 'Command timed out' });
      }, 12000);
      pendingCommandResults.set(commandId, (result) => { clearTimeout(timer); resolve(result); });
      socket.emit(eventName, payload);
    });
  }

  socket.on('connect', () => renderAll());
  socket.on('disconnect', () => renderAll());

  let connectFailCount = 0;
  socket.on('connect_error', (err) => {
    connectFailCount++;
    if (err.message === 'Unauthorized' || connectFailCount >= 5) {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      setPaired(false);
      socket.disconnect();
      showOnboarding();
    }
  });

  socket.on('state:full', (newState) => {
    state = { ...defaultState, ...newState };
    if (pendingSwitchId) {
      if (state.activeWindowId === pendingSwitchId) markSwitchLive(pendingSwitchId);
      else state.activeWindowId = pendingSwitchId;
    } else if (state.activeWindowId) {
      putWindowCache(state.activeWindowId);
      setWindowSyncStatus('live');
    }
    renderAll();
  });

  socket.on('windows:snapshots', (list) => {
    ingestServerSnapshots(list);
    if (activeSheet === 'window') renderWindowSheet();
    renderTabs();
  });

  socket.on('state:patch', (patch) => {
    const switchingTo = pendingSwitchId;
    Object.assign(state, patch);

    if (switchingTo) {
      // Keep optimistic selection while CDP catches up
      if (patch.activeWindowId && patch.activeWindowId !== switchingTo) {
        state.activeWindowId = switchingTo;
      } else if (!state.activeWindowId) {
        state.activeWindowId = switchingTo;
      }

      const hydrated = patch.messages !== undefined
        || patch.chatTabs !== undefined
        || patch.mode !== undefined
        || patch.model !== undefined;
      if (hydrated) {
        putWindowCache(switchingTo);
        setWindowSyncStatus('live');
      }
      if (patch.activeWindowId === switchingTo) {
        markSwitchLive(switchingTo);
      }
    } else if (state.activeWindowId) {
      putWindowCache(state.activeWindowId);
    }

    renderAll();
  });

  socket.on('connection:status', (data) => {
    // During an optimistic switch, ignore brief CDP disconnect flicker
    if (pendingSwitchId && data && data.connected === false) return;
    state.connected = data.connected;
    renderAll();
  });

  socket.on('command:result', (result) => {
    const pending = pendingCommandResults.get(result.commandId);
    if (pending) {
      pendingCommandResults.delete(result.commandId);
      pending(result);
      return;
    }
    if (!result.ok) showToast(result.error || 'Command failed', 'error');
  });

  $messages.addEventListener('scroll', () => {
    autoScrollJob++;
    userScrolledUp = !isNearMessagesBottom();
  });

  $input.addEventListener('input', () => {
    $input.style.height = 'auto';
    $input.style.height = Math.min($input.scrollHeight, 120) + 'px';
    $btnSend.disabled = !$input.value.trim();
  });

  const isTouchPrimary = () => window.matchMedia('(pointer: coarse)').matches;
  $input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.metaKey || e.ctrlKey) { e.preventDefault(); sendMessage(); return; }
    if (e.shiftKey) return;
    if (isTouchPrimary()) return;
    e.preventDefault();
    sendMessage();
  });

  $btnSend.addEventListener('click', sendMessage);

  $btnApprove.addEventListener('click', () => {
    const approval = state.pendingApprovals[0];
    if (!approval) return;
    const action = approval.actions.find(a => a.type === 'approve' || a.type === 'approve_all');
    if (!action) return;
    socket.emit('command:approve', { commandId: newCommandId(), approvalId: approval.id, selectorPath: action.selectorPath });
    showToast('Approve sent', 'success');
  });

  $btnReject.addEventListener('click', () => {
    const approval = state.pendingApprovals[0];
    if (!approval) return;
    const action = approval.actions.find(a => a.type === 'reject');
    if (!action) return;
    socket.emit('command:reject', { commandId: newCommandId(), approvalId: approval.id, selectorPath: action.selectorPath });
    showToast('Reject sent', 'success');
  });

  $btnQSkip.addEventListener('click', () => {
    if (!state.questionnaire) return;
    socket.emit('command:click_action', { commandId: newCommandId(), selectorPath: state.questionnaire.skipSelectorPath, actionLabel: 'Skip' });
    showToast('Skip sent', 'success');
  });

  $btnQContinue.addEventListener('click', () => {
    if (!state.questionnaire || state.questionnaire.continueDisabled) return;
    socket.emit('command:click_action', { commandId: newCommandId(), selectorPath: state.questionnaire.continueSelectorPath, actionLabel: 'Continue' });
    showToast('Continue sent', 'success');
  });

  $btnNewChat.addEventListener('click', () => {
    socket.emit('command:new_chat', { commandId: newCommandId() });
    showToast('Creating new chat...', 'success');
  });

  $pillMode.addEventListener('click', () => openSheet('mode'));
  $pillModel.addEventListener('click', () => openSheet('model'));
  $pillWindow.addEventListener('click', () => openSheet('window'));
  $connChip.addEventListener('click', () => openSheet('connection'));
  $sheetOverlay.addEventListener('click', closeSheet);
  $planModalClose.addEventListener('click', closePlanModal);
  $planModalOverlay.addEventListener('click', (e) => { if (e.target === $planModalOverlay) closePlanModal(); });

  function sendMessage() {
    const text = $input.value.trim();
    if (!text) return;
    socket.emit('command:send_message', { commandId: newCommandId(), text });
    $input.value = '';
    $input.style.height = 'auto';
    $btnSend.disabled = true;
    showToast('Message sent', 'success');
  }

  function renderAll() {
    renderAgentStatus();
    renderComposerQueue();
    renderWindows();
    renderMessages();
    renderApprovals();
    renderQuestionnaire();
    renderInputState();
    renderTabs();
    renderModeModel();
    syncPlanModalFromState();
    if (activeSheet === 'window') renderWindowSheet();
    else if (activeSheet === 'connection') renderConnectionSheet();
  }

  function renderAgentStatus() {
    const labels = {
      idle: 'Idle', thinking: 'Thinking...', generating: 'Generating...',
      running_tool: 'Running tool...', waiting_approval: 'Needs approval', error: 'Error',
    };
    const status = state.agentStatus || 'idle';
    const activity = (state.agentActivityText || '').trim();
    const activityLive = !!state.agentActivityLive;
    const baseLabel = labels[status] || status;

    let text = baseLabel;
    if (activityLive && activity && status !== 'idle') {
      const max = 64;
      text = activity.length > max ? activity.slice(0, max - 1) + '…' : activity;
    }
    $statusText.textContent = text;

    const busy = status !== 'idle';
    $activityStrip.classList.toggle('hidden', !busy);
    const shimmer = busy && status !== 'waiting_approval' && status !== 'error';
    $statusText.className = 'agent-status-text'
      + (shimmer ? ' agent-status-shimmer' : '')
      + (status === 'waiting_approval' ? ' agent-status-warn' : '')
      + (status === 'error' ? ' agent-status-error' : '');

    renderConnChip();
  }

  function renderConnChip() {
    const relayUp = !!socket.connected;
    const cursorUp = !!state.connected;
    let cls = 'conn-chip';
    let label = 'connected';
    if (!relayUp) { cls += ' conn-off'; label = 'offline'; }
    else if (!cursorUp) { cls += ' conn-warn'; label = 'no Cursor'; }
    else cls += ' conn-ok';
    $connChip.className = cls;
    $connChipText.textContent = label;
  }

  function renderComposerQueue() {
    const bar = document.getElementById('composer-queue-bar');
    const labelEl = document.getElementById('composer-queue-label');
    const itemsEl = document.getElementById('composer-queue-items');
    if (!bar || !labelEl || !itemsEl) return;
    const q = state.composerQueue && Array.isArray(state.composerQueue.items) ? state.composerQueue : { items: [] };
    if (q.items.length === 0) { bar.classList.add('hidden'); itemsEl.innerHTML = ''; return; }
    bar.classList.remove('hidden');
    labelEl.textContent = q.queueLabel || `${q.items.length} queued`;
    itemsEl.innerHTML = '';
    q.items.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'composer-queue-row';
      const dot = document.createElement('span');
      dot.className = 'composer-queue-dot';
      const tx = document.createElement('span');
      tx.className = 'composer-queue-text';
      tx.textContent = it.text || '';
      row.appendChild(dot);
      row.appendChild(tx);
      itemsEl.appendChild(row);
    });
  }

  // --- Message rendering ---

  function renderMessages() {
    if (state.messages.length === 0) {
      const ui = getEmptyState();
      $emptyState.style.display = '';
      $messages.querySelectorAll('.chat-el').forEach(el => el.remove());
      $emptyPrimary.textContent = ui.primary;
      $emptyHint.innerHTML = ui.hint;
      return;
    }
    $emptyState.style.display = 'none';
    const existingEls = $messages.querySelectorAll('.chat-el');
    const existingIds = new Map();
    existingEls.forEach(el => existingIds.set(el.dataset.id, el));
    const newIds = new Set(state.messages.map(m => m.id));
    existingEls.forEach(el => { if (!newIds.has(el.dataset.id)) el.remove(); });
    state.messages.forEach((msg, index) => {
      let el = existingIds.get(msg.id);
      if (!el) {
        el = createElement(msg);
        const allEls = $messages.querySelectorAll('.chat-el');
        if (index < allEls.length) $messages.insertBefore(el, allEls[index]);
        else $messages.appendChild(el);
      } else if (el.dataset.msgType !== msg.type) {
        const replacement = createElement(msg);
        el.replaceWith(replacement);
        el = replacement;
      } else {
        updateElement(el, msg);
      }
    });
    if (!userScrolledUp) scheduleMessagesAutoScroll();
    checkMessagesForNotifications();
  }

  function getEmptyState() {
    if (pendingSwitchId) {
      return windowSyncStatus === 'syncing'
        ? { primary: 'Loading window…', hint: 'Showing cache until Cursor catches up.' }
        : { primary: 'No messages in this chat yet.', hint: 'Send a message below.' };
    }
    if (!socket.connected) return { primary: 'Connecting...', hint: 'Waiting for relay.' };
    if (!state.connected) return { primary: 'Waiting for Cursor', hint: 'Make sure Cursor is running.' };
    if (state.extractorStatus === 'stale') return { primary: 'Cursor stalled', hint: 'Extraction is failing.' };
    if (state.extractorStatus === 'waiting') return { primary: 'Waiting for snapshot...', hint: 'Connected to Cursor.' };
    return { primary: 'No messages in this chat yet.', hint: 'Send a message below.' };
  }

  function createElement(msg) {
    let el;
    switch (msg.type) {
      case 'human': el = createHumanEl(msg); break;
      case 'assistant': el = createAssistantEl(msg); break;
      case 'tool': el = createToolEl(msg); break;
      case 'thought': el = createThoughtEl(msg); break;
      case 'plan': el = createPlanEl(msg); break;
      case 'todo_list': el = createTodoListEl(msg); break;
      case 'run_command': el = createRunCommandEl(msg); break;
      case 'loading': el = createLoadingEl(msg); break;
      default: el = createFallbackEl(msg); break;
    }
    el.dataset.msgType = msg.type;
    return el;
  }

  function updateElement(el, msg) {
    switch (msg.type) {
      case 'human': updateHumanEl(el, msg); break;
      case 'assistant': updateAssistantEl(el, msg); break;
      case 'tool': updateToolEl(el, msg); break;
      case 'thought': updateThoughtEl(el, msg); break;
      case 'plan': updatePlanEl(el, msg); break;
      case 'todo_list': updateTodoListEl(el, msg); break;
      case 'run_command': updateRunCommandEl(el, msg); break;
      case 'loading': break;
    }
  }

  // --- Human message ---

  function createQuotedWidget(text) {
    const wrap = document.createElement('div');
    wrap.className = 'quoted-widget';
    const lab = document.createElement('div');
    lab.className = 'quoted-label';
    lab.textContent = 'Quoted';
    const body = document.createElement('div');
    body.className = 'quoted-text';
    body.textContent = text;
    wrap.appendChild(lab);
    wrap.appendChild(body);
    return wrap;
  }

  function createHumanEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-human';
    el.dataset.id = msg.id;
    const bubble = document.createElement('div');
    bubble.className = 'human-bubble';
    if (msg.quoted && msg.quoted.text) bubble.appendChild(createQuotedWidget(msg.quoted.text));
    if (msg.mentions && msg.mentions.length > 0) {
      const mentionsRow = document.createElement('div');
      mentionsRow.className = 'mentions-row';
      msg.mentions.forEach(m => {
        const badge = document.createElement('span');
        badge.className = 'mention-badge';
        badge.textContent = m.name;
        mentionsRow.appendChild(badge);
      });
      bubble.appendChild(mentionsRow);
    }
    const text = document.createElement('div');
    text.className = 'human-text';
    text.textContent = msg.text;
    bubble.appendChild(text);
    el.appendChild(bubble);
    return el;
  }

  function updateHumanEl(el, msg) {
    const bubble = el.querySelector('.human-bubble');
    let qw = el.querySelector('.quoted-widget');
    if (msg.quoted && msg.quoted.text) {
      if (!qw && bubble) {
        qw = createQuotedWidget(msg.quoted.text);
        bubble.insertBefore(qw, bubble.firstChild);
      } else if (qw) {
        const body = qw.querySelector('.quoted-text');
        if (body) body.textContent = msg.quoted.text;
      }
    } else if (qw) qw.remove();
    const text = el.querySelector('.human-text');
    if (text) text.textContent = msg.text;
  }

  // --- Assistant message ---

  let codeBlockFsOverlay = null;

  function closeCodeBlockFullscreen() {
    if (!codeBlockFsOverlay) return;
    codeBlockFsOverlay.remove();
    codeBlockFsOverlay = null;
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onCodeBlockFsKeydown);
  }

  function onCodeBlockFsKeydown(e) { if (e.key === 'Escape') closeCodeBlockFullscreen(); }

  function openCodeBlockFullscreen(wrapper) {
    closeCodeBlockFullscreen();
    const viewport = wrapper.querySelector('.code-block-viewport');
    const headerEl = wrapper.querySelector('.code-block-header');
    const title = (headerEl && headerEl.textContent.trim()) || 'Code';
    const overlay = document.createElement('div');
    overlay.className = 'code-block-fs-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', title);
    const backdrop = document.createElement('div');
    backdrop.className = 'code-block-fs-backdrop';
    backdrop.addEventListener('click', closeCodeBlockFullscreen);
    const panel = document.createElement('div');
    panel.className = 'code-block-fs-panel';
    const panelHead = document.createElement('div');
    panelHead.className = 'code-block-fs-panel-header';
    const titleSpan = document.createElement('span');
    titleSpan.className = 'code-block-fs-title';
    titleSpan.textContent = title;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'code-block-fs-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '\u2715';
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeCodeBlockFullscreen(); });
    panelHead.appendChild(titleSpan);
    panelHead.appendChild(closeBtn);
    const scroll = document.createElement('div');
    scroll.className = 'code-block-fs-scroll';
    if (viewport && viewport.firstElementChild) scroll.appendChild(viewport.firstElementChild.cloneNode(true));
    panel.appendChild(panelHead);
    panel.appendChild(scroll);
    overlay.appendChild(backdrop);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    codeBlockFsOverlay = overlay;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onCodeBlockFsKeydown);
    closeBtn.focus();
  }

  function createNativeBlockFromItem(item, filenameFallback) {
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block native-code-block';
    const title = (item.filename || item.language || filenameFallback || '').trim();
    const toolbar = document.createElement('div');
    toolbar.className = 'code-block-toolbar' + (title ? '' : ' code-block-toolbar--actions-only');
    if (title) {
      const header = document.createElement('div');
      header.className = 'code-block-header';
      header.textContent = title;
      toolbar.appendChild(header);
    }
    const expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'code-block-fullscreen-btn';
    expandBtn.setAttribute('aria-label', 'View full screen');
    expandBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>';
    expandBtn.addEventListener('click', (e) => { e.stopPropagation(); openCodeBlockFullscreen(wrapper); });
    toolbar.appendChild(expandBtn);
    wrapper.appendChild(toolbar);
    const viewport = document.createElement('div');
    viewport.className = 'code-block-viewport';
    const body = document.createElement('div');
    body.className = 'code-block-diff-plain';
    if (item.blockKind === 'diff' && item.diffLines && item.diffLines.length > 0) {
      for (const line of item.diffLines) {
        const row = document.createElement('div');
        const k = ['add', 'rem', 'ctx', 'meta', 'hunk'].includes(line.kind) ? line.kind : 'ctx';
        row.className = 'code-block-diff-line code-block-diff-line--' + k;
        row.textContent = line.text;
        body.appendChild(row);
      }
    } else {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = item.code || '';
      pre.appendChild(code);
      body.appendChild(pre);
      body.classList.add('code-block-diff-plain--raw');
    }
    viewport.appendChild(body);
    wrapper.appendChild(viewport);
    return wrapper;
  }

  function appendAssistantNativeBlocks(bubble, msg) {
    if (!bubble) return;
    bubble.querySelectorAll(':scope > .native-code-block').forEach((n) => n.remove());
    if (!msg.codeBlocks?.length) return;
    for (const item of msg.codeBlocks) {
      if (!item || (!item.code?.trim() && !(item.diffLines && item.diffLines.length))) continue;
      bubble.appendChild(createNativeBlockFromItem(item));
    }
  }

  function createAssistantEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-assistant';
    el.dataset.id = msg.id;
    const bubble = document.createElement('div');
    bubble.className = 'assistant-bubble';
    if (msg.html) {
      const content = document.createElement('div');
      content.className = 'assistant-content markdown-body';
      content.innerHTML = sanitizeHtml(msg.html);
      normalizeMarkdownCodeBlocks(content);
      bubble.appendChild(content);
    } else {
      const content = document.createElement('div');
      content.className = 'assistant-content';
      content.textContent = msg.text;
      bubble.appendChild(content);
    }
    appendAssistantNativeBlocks(bubble, msg);
    el.appendChild(bubble);
    return el;
  }

  function updateAssistantEl(el, msg) {
    const bubble = el.querySelector('.assistant-bubble');
    const content = el.querySelector('.assistant-content');
    if (!content) return;
    if (msg.html) {
      content.innerHTML = sanitizeHtml(msg.html);
      normalizeMarkdownCodeBlocks(content);
      content.classList.add('markdown-body');
    } else {
      content.textContent = msg.text;
      content.classList.remove('markdown-body');
    }
    appendAssistantNativeBlocks(bubble, msg);
  }

  // --- Tool call ---

  function createToolEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-tool';
    el.dataset.id = msg.id;
    const line = document.createElement('div');
    line.className = 'tool-line ' + msg.status;
    const icon = document.createElement('span');
    icon.className = 'tool-icon';
    icon.textContent = msg.status === 'completed' ? '\u2713' : '\u2022';
    line.appendChild(icon);
    if (msg.summaryText) {
      const summary = document.createElement('span');
      summary.className = 'tool-summary';
      summary.textContent = msg.summaryText;
      line.appendChild(summary);
    } else {
      if (msg.action) {
        const action = document.createElement('span');
        action.className = 'tool-action';
        action.textContent = msg.action;
        line.appendChild(action);
      }
      if (msg.details) {
        const details = document.createElement('span');
        details.className = 'tool-details';
        details.textContent = msg.details;
        line.appendChild(details);
      }
    }
    if (msg.filename || msg.additions != null || msg.deletions != null) {
      const fileInfo = document.createElement('span');
      fileInfo.className = 'tool-file-info';
      if (msg.filename) {
        const fn = document.createElement('span');
        fn.className = 'tool-filename';
        fn.textContent = msg.filename;
        fileInfo.appendChild(fn);
      }
      if (msg.additions != null) {
        const add = document.createElement('span');
        add.className = 'tool-additions';
        add.textContent = '+' + msg.additions;
        fileInfo.appendChild(add);
      }
      if (msg.deletions != null) {
        const del = document.createElement('span');
        del.className = 'tool-deletions';
        del.textContent = '-' + msg.deletions;
        fileInfo.appendChild(del);
      }
      line.appendChild(fileInfo);
    }
    el.appendChild(line);
    if (msg.actions && msg.actions.length > 0) {
      const actionsRow = document.createElement('div');
      actionsRow.className = 'tool-actions-row';
      appendRunStyleActionButtons(actionsRow, msg.actions);
      el.appendChild(actionsRow);
    }
    syncToolDiffHost(el, msg);
    return el;
  }

  function syncToolDiffHost(el, msg) {
    const db = msg.diffBlock;
    const hasBody = db && ((db.diffLines && db.diffLines.length > 0) || (db.code && String(db.code).trim().length > 0));
    let host = el.querySelector('.tool-diff-host');
    if (!hasBody) { if (host) { delete host._nativeDiffKey; host.remove(); } return; }
    const key = JSON.stringify({ bk: db.blockKind, c: db.code, d: db.diffLines, f: db.filename || msg.filename });
    if (!host) { host = document.createElement('div'); host.className = 'tool-diff-host'; el.appendChild(host); }
    if (host._nativeDiffKey === key) return;
    host._nativeDiffKey = key;
    host.innerHTML = '';
    host.appendChild(createNativeBlockFromItem(db, msg.filename));
  }

  function updateToolEl(el, msg) {
    const fresh = createToolEl(msg);
    const newLine = fresh.querySelector('.tool-line');
    const oldLine = el.querySelector('.tool-line');
    if (newLine && oldLine) el.replaceChild(newLine, oldLine);
    const newActions = fresh.querySelector('.tool-actions-row');
    const oldActions = el.querySelector('.tool-actions-row');
    if (newActions && oldActions) el.replaceChild(newActions, oldActions);
    else if (newActions && !oldActions) {
      const diffHost = el.querySelector('.tool-diff-host');
      if (diffHost) el.insertBefore(newActions, diffHost);
      else el.appendChild(newActions);
    } else if (!newActions && oldActions) oldActions.remove();
    syncToolDiffHost(el, msg);
  }

  // --- Thought block ---

  function formatThoughtLine(msg) {
    const dur = (msg.duration || '').trim();
    const detail = (msg.detail || '').trim();
    if (msg.thoughtKind === 'step_summary') {
      const a = (msg.action || '').trim();
      return detail ? `${a || 'Steps'} — ${detail}` : (a || 'Steps');
    }
    if (msg.thoughtKind === 'thinking_step') {
      const a = (msg.action || '').trim();
      if (dur) return `${a || 'Step'} · ${dur}`;
      if (a) {
        if (/^thought$/i.test(a)) return 'Thought';
        if (/ing$/i.test(a)) return `${a.replace(/\.\.\.?$/, '')}…`;
        return a;
      }
      return 'Thinking…';
    }
    if (dur) return `Thought for ${dur}`;
    const action = (msg.action || '').trim();
    if (action) {
      if (/^thought$/i.test(action)) return 'Thought';
      if (/ing$/i.test(action)) return `${action.replace(/\.\.\.?$/, '')}…`;
      return action;
    }
    return 'Thinking…';
  }

  function syncThoughtLineClasses(inner, msg) {
    inner.classList.remove('thought-line-summary', 'thought-line-step');
    if (msg.thoughtKind === 'step_summary') inner.classList.add('thought-line-summary');
    else if (msg.thoughtKind === 'thinking_step') inner.classList.add('thought-line-step');
  }

  function createThoughtEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-thought';
    el.dataset.id = msg.id;
    const inner = document.createElement('div');
    inner.className = 'thought-line';
    syncThoughtLineClasses(inner, msg);
    inner.textContent = formatThoughtLine(msg);
    el.appendChild(inner);
    return el;
  }

  function updateThoughtEl(el, msg) {
    const inner = el.querySelector('.thought-line');
    if (inner) { syncThoughtLineClasses(inner, msg); inner.textContent = formatThoughtLine(msg); }
  }

  // --- Plan block ---

  function emitClickAction(selectorPath, actionLabel) {
    socket.emit('command:click_action', { commandId: newCommandId(), selectorPath, actionLabel });
  }

  function buildPlanFullContent(planData) {
    const content = document.createElement('div');
    content.className = 'plan-card plan-card-modal';
    if (Array.isArray(planData.todos) && planData.todos.length > 0) {
      const completed = planData.todos.filter((todo) => todo.status === 'completed').length;
      const summary = document.createElement('div');
      summary.className = 'plan-progress';
      summary.textContent = `To-dos ${completed}/${planData.todos.length}`;
      content.appendChild(summary);
      const todoList = document.createElement('div');
      todoList.className = 'plan-todo-list';
      planData.todos.forEach((todo) => {
        const item = document.createElement('div');
        item.className = 'plan-todo-item';
        const dot = document.createElement('span');
        dot.className = 'plan-todo-dot plan-todo-' + todo.status;
        item.appendChild(dot);
        const text = document.createElement('span');
        text.className = 'plan-todo-text';
        text.textContent = todo.text;
        item.appendChild(text);
        todoList.appendChild(item);
      });
      content.appendChild(todoList);
    }
    if (planData.bodyHtml) {
      const body = document.createElement('div');
      body.className = 'plan-description markdown-body';
      body.innerHTML = sanitizeHtml(planData.bodyHtml);
      normalizeMarkdownCodeBlocks(body);
      content.appendChild(body);
    }
    return content;
  }

  function buildPlanModalContent(msg, planData) {
    if (planData) return buildPlanFullContent(planData);
    const modalMsg = {
      ...msg,
      actions: Array.isArray(msg.actions) ? msg.actions.filter((action) => action.type !== 'view_plan') : msg.actions,
    };
    const content = buildPlanCard(modalMsg);
    content.classList.add('plan-card-modal');
    return content;
  }

  function renderPlanModal(msg) {
    if (!msg) return;
    $planModalLabel.textContent = msg.label || '';
    $planModalLabel.style.display = msg.label ? '' : 'none';
    $planModalTitle.textContent = msg.title || 'Plan';
    $planModalBody.innerHTML = '';
    $planModalBody.appendChild(buildPlanModalContent(msg, activePlanModal && activePlanModal.fullData));
  }

  async function loadFullPlanIntoModal(msg) {
    if (!msg.label || !activePlanModal || activePlanModal.id !== msg.id) return;
    activePlanModal.loading = true;
    const result = await sendCommandAwaitResult('command:get_plan_full', {
      commandId: newCommandId(), type: 'get_plan_full', planLabel: msg.label,
    });
    if (!activePlanModal || activePlanModal.id !== msg.id) return;
    activePlanModal.loading = false;
    if (!result.ok || !result.data) return;
    activePlanModal.fullData = result.data;
    renderPlanModal(msg);
  }

  function openPlanModal(msg) {
    activePlanModal = { id: msg.id, label: msg.label || '', fullData: null, loading: false };
    renderPlanModal(msg);
    $planModalOverlay.classList.remove('hidden');
    loadFullPlanIntoModal(msg);
  }

  function closePlanModal() {
    activePlanModal = null;
    $planModalOverlay.classList.add('hidden');
  }

  function syncPlanModalFromState() {
    if (!activePlanModal) return;
    const current = (state.messages || []).find((msg) => msg.type === 'plan' && msg.id === activePlanModal.id);
    if (current) {
      renderPlanModal(current);
      if (current.label && !activePlanModal.fullData && !activePlanModal.loading) loadFullPlanIntoModal(current);
    }
  }

  async function openPlanModelPicker(msg) {
    if (!msg.modelDropdownSelectorPath) {
      if (msg.model) showToast(`Plan model: ${msg.model}`, 'success');
      return;
    }
    const commandId = newCommandId();
    const result = await sendCommandAwaitResult('command:get_plan_model_options', {
      commandId, type: 'get_plan_model_options', selectorPath: msg.modelDropdownSelectorPath,
    });
    const options = Array.isArray(result.data?.options) ? result.data.options : [];
    if (!result.ok || options.length === 0) {
      emitClickAction(msg.modelDropdownSelectorPath);
      if (!result.ok) showToast(result.error || 'Could not load plan models', 'error');
      return;
    }
    activePlanModelContext = { selectorPath: msg.modelDropdownSelectorPath, title: msg.title || 'Plan', options };
    openSheet('plan-model');
  }

  function buildPlanCard(msg) {
    const card = document.createElement('div');
    card.className = 'plan-card plan-card-widget';
    if (msg.label) {
      const header = document.createElement('div');
      header.className = 'plan-widget-header';
      const icon = document.createElement('span');
      icon.className = 'plan-widget-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = '\u2712';
      const fn = document.createElement('span');
      fn.className = 'plan-widget-filename';
      fn.textContent = msg.label;
      header.appendChild(icon);
      header.appendChild(fn);
      card.appendChild(header);
    }
    const title = document.createElement('div');
    title.className = 'plan-title';
    title.textContent = msg.title;
    card.appendChild(title);
    if (msg.descriptionHtml) {
      const desc = document.createElement('div');
      desc.className = 'plan-description markdown-body';
      desc.innerHTML = sanitizeHtml(msg.descriptionHtml);
      normalizeMarkdownCodeBlocks(desc);
      card.appendChild(desc);
    } else if (msg.description) {
      const desc = document.createElement('div');
      desc.className = 'plan-description';
      desc.textContent = msg.description;
      card.appendChild(desc);
    }
    if (msg.todos && msg.todos.length > 0) {
      const todoList = document.createElement('div');
      todoList.className = 'plan-todo-list';
      msg.todos.forEach((todo) => {
        const item = document.createElement('div');
        item.className = 'plan-todo-item';
        const dot = document.createElement('span');
        dot.className = 'plan-todo-dot plan-todo-' + todo.status;
        item.appendChild(dot);
        const text = document.createElement('span');
        text.className = 'plan-todo-text';
        text.textContent = todo.text;
        item.appendChild(text);
        todoList.appendChild(item);
      });
      card.appendChild(todoList);
    }
    if (msg.todosMoreCount && msg.todosMoreCount > 0) {
      const more = document.createElement('div');
      more.className = 'plan-todos-more';
      more.textContent = `${msg.todosMoreCount} more`;
      card.appendChild(more);
    }
    if (msg.todosTotal > 0) {
      const progress = document.createElement('div');
      progress.className = 'plan-progress';
      const track = document.createElement('div');
      track.className = 'plan-progress-track';
      const bar = document.createElement('div');
      bar.className = 'plan-progress-bar';
      const pct = Math.round((msg.todosCompleted / msg.todosTotal) * 100);
      bar.style.width = pct + '%';
      track.appendChild(bar);
      progress.appendChild(track);
      const progressText = document.createElement('span');
      progressText.className = 'plan-progress-text';
      progressText.textContent = msg.todosCompleted + '/' + msg.todosTotal;
      progress.appendChild(progressText);
      card.appendChild(progress);
    }
    const hasActions = (msg.actions && msg.actions.length > 0) || msg.modelDropdownSelectorPath || msg.model;
    if (hasActions) {
      const toolbar = document.createElement('div');
      toolbar.className = 'plan-actions-toolbar';
      const left = document.createElement('div');
      left.className = 'plan-actions-left';
      if (msg.actions) {
        const viewAct = msg.actions.find((a) => a.type === 'view_plan');
        if (viewAct) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'plan-btn plan-btn-view';
          btn.textContent = viewAct.label || 'View Plan';
          btn.addEventListener('click', () => openPlanModal(msg));
          left.appendChild(btn);
        }
      }
      toolbar.appendChild(left);
      const center = document.createElement('div');
      center.className = 'plan-actions-center';
      if (msg.modelDropdownSelectorPath) {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'plan-model-pill';
        const lab = document.createElement('span');
        lab.className = 'plan-model-pill-text';
        lab.textContent = msg.model || 'Model';
        const chev = document.createElement('span');
        chev.className = 'plan-model-pill-chev';
        chev.textContent = '\u25BE';
        pill.appendChild(lab);
        pill.appendChild(chev);
        pill.addEventListener('click', () => { void openPlanModelPicker(msg); });
        center.appendChild(pill);
      } else if (msg.model) {
        const badge = document.createElement('span');
        badge.className = 'plan-model-badge-inline';
        badge.textContent = msg.model;
        center.appendChild(badge);
      }
      toolbar.appendChild(center);
      const right = document.createElement('div');
      right.className = 'plan-actions-right';
      if (msg.actions) {
        const buildAct = msg.actions.find((a) => a.type === 'build');
        if (buildAct) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'plan-btn plan-btn-build';
          btn.textContent = buildAct.label || 'Build';
          btn.addEventListener('click', () => emitClickAction(buildAct.selectorPath, buildAct.label || 'Build'));
          right.appendChild(btn);
        }
      }
      toolbar.appendChild(right);
      card.appendChild(toolbar);
    }
    return card;
  }

  function createPlanEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-plan';
    el.dataset.id = msg.id;
    el.appendChild(buildPlanCard(msg));
    return el;
  }

  function updatePlanEl(el, msg) {
    const oldCard = el.querySelector('.plan-card');
    if (oldCard) el.replaceChild(buildPlanCard(msg), oldCard);
  }

  // --- Standalone todo list ---

  function createTodoListEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-todo-list';
    el.dataset.id = msg.id;
    const card = document.createElement('div');
    card.className = 'todo-list-card';
    const head = document.createElement('div');
    head.className = 'todo-list-card-title';
    head.textContent = `${msg.title} (${msg.todosCompleted}/${msg.todosTotal})`;
    card.appendChild(head);
    const list = document.createElement('div');
    list.className = 'todo-list-card-items';
    msg.todos.forEach((todo) => {
      const row = document.createElement('div');
      row.className = 'todo-list-card-row';
      const icon = document.createElement('span');
      icon.className = 'todo-list-card-icon';
      icon.textContent = todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '●' : '○';
      const tx = document.createElement('span');
      tx.className = 'todo-list-card-text';
      tx.textContent = todo.text;
      row.appendChild(icon);
      row.appendChild(tx);
      list.appendChild(row);
    });
    card.appendChild(list);
    el.appendChild(card);
    return el;
  }

  function updateTodoListEl(el, msg) {
    const fresh = createTodoListEl(msg);
    const newCard = fresh.querySelector('.todo-list-card');
    const oldCard = el.querySelector('.todo-list-card');
    if (newCard && oldCard) el.replaceChild(newCard, oldCard);
  }

  // --- Run command / tool inline actions ---

  function appendRunStyleActionButtons(container, actions) {
    actions.forEach(function (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = action.type === 'run' ? 'run-btn run-btn-run'
        : action.type === 'allow' ? 'run-btn run-btn-allow'
        : 'run-btn run-btn-skip';
      btn.textContent = action.label;
      btn.addEventListener('click', function () {
        socket.emit('command:click_action', {
          commandId: newCommandId(), selectorPath: action.selectorPath, actionLabel: action.label,
        });
      });
      container.appendChild(btn);
    });
  }

  function createRunCommandEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-run-command';
    el.dataset.id = msg.id;
    const card = document.createElement('div');
    card.className = 'run-card';
    const header = document.createElement('div');
    header.className = 'run-header';
    const desc = document.createElement('span');
    desc.className = 'run-description';
    desc.textContent = msg.description;
    header.appendChild(desc);
    if (msg.candidates) {
      const cand = document.createElement('span');
      cand.className = 'run-candidates';
      cand.textContent = ' ' + msg.candidates;
      header.appendChild(cand);
    }
    card.appendChild(header);
    const cmdBlock = document.createElement('div');
    cmdBlock.className = 'run-command-block';
    const prompt = document.createElement('span');
    prompt.className = 'run-prompt';
    prompt.textContent = '$ ';
    cmdBlock.appendChild(prompt);
    const cmdText = document.createElement('span');
    cmdText.className = 'run-command-text';
    cmdText.textContent = msg.command;
    cmdBlock.appendChild(cmdText);
    card.appendChild(cmdBlock);
    if (msg.actions && msg.actions.length > 0) {
      const actionsRow = document.createElement('div');
      actionsRow.className = 'run-actions-row';
      appendRunStyleActionButtons(actionsRow, msg.actions);
      card.appendChild(actionsRow);
    }
    el.appendChild(card);
    return el;
  }

  function updateRunCommandEl(el, msg) {
    const oldCommand = (el.querySelector('.run-command-text')?.textContent || '').trim();
    const nextMsg = (!msg.command || !msg.command.trim()) && oldCommand
      ? { ...msg, command: oldCommand }
      : msg;
    const fresh = createRunCommandEl(nextMsg);
    const newCard = fresh.querySelector('.run-card');
    const oldCard = el.querySelector('.run-card');
    if (newCard && oldCard) el.replaceChild(newCard, oldCard);
  }

  // --- Loading indicator ---

  function createLoadingEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-loading';
    el.dataset.id = msg.id;
    const dots = document.createElement('div');
    dots.className = 'loading-dots';
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('span');
      dot.className = 'dot-anim';
      dots.appendChild(dot);
    }
    el.appendChild(dots);
    return el;
  }

  // --- Fallback ---

  function createFallbackEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-fallback';
    el.dataset.id = msg.id;
    el.textContent = msg.text || msg.type || '...';
    return el;
  }

  // --- Sanitize HTML ---

  function sanitizeHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    tmp.querySelectorAll('script, iframe, object, embed, form').forEach(el => el.remove());
    tmp
      .querySelectorAll('.composer-message-codeblock, .composer-code-block-container, .ui-code-block')
      .forEach((el) => el.remove());
    tmp.querySelectorAll('*').forEach(el => {
      for (const attr of Array.from(el.attributes)) {
        if (attr.name.startsWith('on') || attr.name === 'srcdoc') el.removeAttribute(attr.name);
      }
      if (el.tagName === 'A') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
    });
    return tmp.innerHTML;
  }

  function normalizeMarkdownCodeBlocks(root) {
    if (!root) return;
    function extractStructuredCodeText(el) {
      let out = '';
      function walk(node) {
        if (!node) return;
        if (node.nodeType === Node.TEXT_NODE) { out += node.textContent || ''; return; }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const tag = (node.tagName || '').toLowerCase();
        if (tag === 'br') { out += '\n'; return; }
        const before = out.length;
        node.childNodes.forEach(walk);
        const isLineLike = tag === 'div' || tag === 'p' || tag === 'li' || node.matches?.('[data-line], .line');
        if (isLineLike && out.length > before && !out.endsWith('\n')) out += '\n';
      }
      walk(el);
      return out.replace(/\n{3,}/g, '\n\n').replace(/\s+\n/g, '\n').trimEnd();
    }
    root.querySelectorAll('code').forEach((codeEl) => {
      if (codeEl.closest('pre')) return;
      if (codeEl.className.includes('md-inline-') || codeEl.closest('p, li, a, h1, h2, h3, h4, h5, h6')) return;
      const text = extractStructuredCodeText(codeEl);
      const looksBlockLike = text.includes('\n') || !!codeEl.querySelector('br,[data-line],.line,div,p') || /(?:^|\s)(?:language-|shiki)/.test(codeEl.className);
      if (!looksBlockLike) return;
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.className = codeEl.className || '';
      code.textContent = text;
      pre.appendChild(code);
      codeEl.replaceWith(pre);
    });
  }

  // --- Approvals ---

  function shortActionLabel(label, fallback) {
    const t = (label || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 24) return fallback;
    return t;
  }

  function renderApprovals() {
    if (state.pendingApprovals.length > 0) {
      $approvalBar.classList.remove('hidden');
      const approval = state.pendingApprovals[0];
      $approvalDesc.textContent = approval.description || 'Action needs approval';
      const approveAction = approval.actions.find(a => a.type === 'approve' || a.type === 'approve_all');
      const rejectAction = approval.actions.find(a => a.type === 'reject');
      $btnApprove.disabled = !approveAction;
      $btnReject.disabled = !rejectAction;
      if (approveAction) $btnApprove.textContent = shortActionLabel(approveAction.label, 'Accept');
      if (rejectAction) $btnReject.textContent = shortActionLabel(rejectAction.label, 'Reject');
      fireNotification(approval.description || 'Agent needs approval', 'cursor-approval');
    } else {
      $approvalBar.classList.add('hidden');
    }
  }

  function renderQuestionnaire() {
    var q = state.questionnaire;
    if (!q || !q.questions || q.questions.length === 0) {
      $questionnaireBar.classList.add('hidden');
      questionnaireSelections = {};
      return;
    }
    $questionnaireBar.classList.remove('hidden');
    $questionnaireStepper.textContent = q.totalLabel || '';
    $btnQContinue.disabled = q.continueDisabled;
    $questionnaireQuestions.innerHTML = '';
    for (var i = 0; i < q.questions.length; i++) {
      var question = q.questions[i];
      var qDiv = document.createElement('div');
      qDiv.className = 'questionnaire-question' + (question.isActive ? ' questionnaire-question-active' : '');
      var labelDiv = document.createElement('div');
      labelDiv.className = 'questionnaire-question-label';
      var numSpan = document.createElement('span');
      numSpan.className = 'questionnaire-question-number';
      numSpan.textContent = question.number;
      var textSpan = document.createElement('span');
      textSpan.textContent = question.text;
      labelDiv.appendChild(numSpan);
      labelDiv.appendChild(textSpan);
      qDiv.appendChild(labelDiv);
      var optionsDiv = document.createElement('div');
      optionsDiv.className = 'questionnaire-options';
      for (var j = 0; j < question.options.length; j++) {
        var opt = question.options[j];
        var optBtn = document.createElement('button');
        var isSelected = questionnaireSelections[question.number] === opt.letter;
        optBtn.className = 'questionnaire-option' + (isSelected ? ' questionnaire-option-selected' : '');
        var letterSpan = document.createElement('span');
        letterSpan.className = 'questionnaire-option-letter';
        letterSpan.textContent = opt.letter + ')';
        var labelSpan = document.createElement('span');
        labelSpan.textContent = ' ' + opt.label;
        optBtn.appendChild(letterSpan);
        optBtn.appendChild(labelSpan);
        optBtn.dataset.selectorPath = opt.selectorPath;
        optBtn.dataset.questionNumber = question.number;
        optBtn.dataset.letter = opt.letter;
        optBtn.dataset.label = opt.label;
        optBtn.addEventListener('click', function() {
          questionnaireSelections[this.dataset.questionNumber] = this.dataset.letter;
          var siblings = this.parentNode.querySelectorAll('.questionnaire-option');
          for (var s = 0; s < siblings.length; s++) siblings[s].classList.remove('questionnaire-option-selected');
          this.classList.add('questionnaire-option-selected');
          socket.emit('command:click_action', {
            commandId: newCommandId(), selectorPath: this.dataset.selectorPath, actionLabel: this.dataset.label,
          });
          showToast('Answer sent', 'success');
        });
        optionsDiv.appendChild(optBtn);
      }
      qDiv.appendChild(optionsDiv);
      $questionnaireQuestions.appendChild(qDiv);
    }
    fireNotification('Agent has questions for you', 'cursor-questionnaire');
  }

  function renderInputState() {
    $input.disabled = !state.inputAvailable && !state.connected;
    $btnSend.disabled = !$input.value.trim() || $input.disabled;
  }

  function fireNotification(text, tag) {
    if (document.hasFocus()) return;
    if (typeof Notification === 'undefined') return;
    var ntag = tag || 'cursor-agent';
    if (notificationPermission === 'default') {
      Notification.requestPermission().then(function (perm) {
        notificationPermission = perm;
        if (perm === 'granted') new Notification('CursorRemote', { body: text, tag: ntag });
      });
    } else if (notificationPermission === 'granted') {
      new Notification('CursorRemote', { body: text, tag: ntag });
    }
  }

  function checkMessagesForNotifications() {
    if (document.hasFocus()) return;
    state.messages.forEach(function (msg) {
      if (notifiedMessageIds.has(msg.id)) return;
      var text = null;
      if (msg.type === 'run_command' && msg.actions && msg.actions.length > 0) {
        text = (msg.description || 'Run command') + ': ' + (msg.command || '').substring(0, 80);
      } else if (msg.type === 'tool' && msg.actions && msg.actions.length > 0) {
        var detail = msg.details || msg.filename || '';
        text = (msg.action || 'Tool') + (detail ? ' ' + detail : '') + ' needs approval';
      } else if (msg.type === 'assistant' && msg.text) {
        text = msg.text.substring(0, 120);
      }
      if (text) {
        notifiedMessageIds.add(msg.id);
        fireNotification(text, 'cursor-action-' + msg.id);
      }
    });
  }

  // Request notification permission on first interaction
  document.addEventListener('click', function requestPerm() {
    if (typeof Notification !== 'undefined' && notificationPermission === 'default') {
      Notification.requestPermission().then(function (p) { notificationPermission = p; });
    }
    document.removeEventListener('click', requestPerm);
  }, { once: true });

  // --- Window pill (bottom toolbar) + window sheet ---

  function renderWindows() {
    const windows = getSwitchableWindows();
    const active = windows.find(w => w.id === state.activeWindowId) || windows[0];
    if (!active || !active.title) {
      $pillWindow.classList.add('hidden');
      return;
    }
    $pillWindow.classList.remove('hidden');
    const parsed = parseWindowGroup(active.title);
    $pillWindowText.textContent = parsed.variant
      ? parsed.group + ' · ' + parsed.variant
      : parsed.group;
    renderWindowSync();
  }

  function switchToWindow(win) {
    if (!win || win.id === state.activeWindowId) return;

    if (state.activeWindowId) putWindowCache(state.activeWindowId);

    pendingSwitchPrevId = state.activeWindowId;
    pendingSwitchId = win.id;
    state.activeWindowId = win.id;

    const cached = lookupWindowCache(win);
    if (cached) {
      applyWindowSnapshot(cached);
      setWindowSyncStatus('syncing');
    } else {
      clearWindowScopedState();
      setWindowSyncStatus('syncing');
    }
    userScrolledUp = false;
    notifiedMessageIds.clear();
    lastActiveTabTitle = '';

    // Paint immediately (don't wait for socket round-trip)
    renderTabs();
    renderWindows();
    renderMessages();
    renderApprovals();
    renderQuestionnaire();
    renderComposerQueue();
    renderAgentStatus();
    renderModeModel();
    renderInputState();

    const commandId = newCommandId();
    const targetId = win.id;
    sendCommandAwaitResult('command:switch_window', {
      commandId,
      windowId: targetId,
    }).then((result) => {
      if (!result.ok) {
        const rollbackId = pendingSwitchPrevId;
        pendingSwitchId = null;
        pendingSwitchPrevId = null;
        if (rollbackId) {
          state.activeWindowId = rollbackId;
          const prev = memWindowCache.get(rollbackId);
          if (prev) applyWindowSnapshot(prev);
        }
        setWindowSyncStatus('live');
        renderAll();
        showToast(result.error || 'Could not switch window', 'error');
        return;
      }
      setTimeout(() => {
        if (pendingSwitchId === targetId) markSwitchLive(targetId);
      }, 8000);
    });
  }

  function renderWindowSheet() {
    $sheetWindowList.innerHTML = '';
    const windows = getSwitchableWindows();
    if (windows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sheet-empty';
      empty.textContent = 'No open Cursor windows';
      $sheetWindowList.appendChild(empty);
      return;
    }

    const groups = groupWindows(windows);
    groups.forEach((g) => {
      const showHeader = g.items.length > 1;
      if (showHeader) {
        const header = document.createElement('div');
        header.className = 'sheet-group-header';
        header.textContent = g.group;
        $sheetWindowList.appendChild(header);
      }

      g.items.forEach(({ win, variant }) => {
        const isActive = win.id === state.activeWindowId;
        const cached = lookupWindowCache(win);
        const btn = document.createElement('button');
        btn.className = 'sheet-item' + (isActive ? ' selected' : '');

        // Single window in group → full project name; multi → Local / WSL / SSH
        const label = showHeader ? (variant || 'Local') : (win.title || g.group);
        const cacheHint = cached && !isActive
          ? '<span class="win-cache-dot" title="Cached"></span>'
          : '';
        const badge = isActive
          ? '<span class="win-badge win-badge-active">Active</span>'
          : '<span class="win-badge win-badge-open">Open</span>';

        btn.innerHTML =
          '<span class="sheet-item-label">' + escapeHtml(label) + '</span>' +
          '<span class="sheet-item-right">' + cacheHint + badge
          + (isActive ? '<span class="sheet-item-check">\u2713</span>' : '')
          + '</span>';
        btn.addEventListener('click', () => {
          closeSheet();
          if (isActive) return;
          switchToWindow(win);
        });
        $sheetWindowList.appendChild(btn);
      });
    });
  }

  // --- Connection sheet (status details + unpair) ---

  function renderConnectionSheet() {
    $sheetConnectionBody.innerHTML = '';

    function addRow(label, value, ok) {
      const row = document.createElement('div');
      row.className = 'conn-row';
      const dot = document.createElement('span');
      dot.className = 'conn-row-dot ' + (ok ? 'ok' : 'off');
      const lab = document.createElement('span');
      lab.className = 'conn-row-label';
      lab.textContent = label;
      const val = document.createElement('span');
      val.className = 'conn-row-value';
      val.textContent = value;
      row.appendChild(dot);
      row.appendChild(lab);
      row.appendChild(val);
      $sheetConnectionBody.appendChild(row);
    }

    addRow('Relay', socket.connected ? 'Connected' : 'Disconnected', !!socket.connected);
    addRow('Cursor IDE', state.connected ? 'Connected' : 'Not connected', !!state.connected);
    const windows = state.windows || [];
    const activeWin = windows.find(w => w.id === state.activeWindowId);
    if (activeWin) addRow('Window', activeWin.title, true);
    const activeTab = (state.chatTabs || []).find(t => t.isActive);
    if (activeTab) addRow('Chat', activeTab.title, true);

    if (isPaired()) {
      const unpair = document.createElement('button');
      unpair.className = 'conn-unpair-btn';
      unpair.textContent = 'Unpair this device';
      unpair.addEventListener('click', () => {
        localStorage.removeItem(AUTH_TOKEN_KEY);
        setPaired(false);
        socket.disconnect();
        closeSheet();
        showOnboarding();
      });
      $sheetConnectionBody.appendChild(unpair);
    }
  }

  // --- Tab bar: agent chats of the active window (+ only; no Customize / New Agent) ---

  function isNoiseChatTab(title) {
    const t = (title || '').trim();
    if (!t) return true;
    if (/^(customize|new agent|new chat|create agent|agents)$/i.test(t)) return true;
    if (/\/\s*(customize|new agent|new chat|create agent)\s*$/i.test(t)) return true;
    return false;
  }

  function tabDisplayTitle(title) {
    const raw = (title || '').trim();
    const idx = raw.lastIndexOf(' / ');
    if (idx >= 0) {
      const rest = raw.slice(idx + 3).trim();
      if (rest) return rest;
    }
    return raw || 'Chat';
  }

  function getVisibleChatTabs() {
    return (state.chatTabs || []).filter((t) => !isNoiseChatTab(t.title));
  }

  function renderTabs() {
    const tabs = getVisibleChatTabs();
    if (tabs.length === 0) {
      // Still show the bar when we have a window, so + stays reachable
      if (getSwitchableWindows().length === 0) {
        $tabBar.classList.add('hidden');
        $tabList.innerHTML = '';
        return;
      }
      $tabBar.classList.remove('hidden');
      $tabList.innerHTML = '';
      return;
    }
    $tabBar.classList.remove('hidden');

    const existingBtns = $tabList.querySelectorAll('.tab-item');
    const existingMap = new Map();
    existingBtns.forEach((b) => existingMap.set(b.dataset.title, b));
    const newTitles = new Set(tabs.map((t) => t.title));
    existingBtns.forEach((b) => { if (!newTitles.has(b.dataset.title)) b.remove(); });

    const fragment = document.createDocumentFragment();
    tabs.forEach((tab) => {
      let btn = existingMap.get(tab.title);
      if (!btn) {
        btn = document.createElement('button');
        btn.className = 'tab-item';
        btn.dataset.title = tab.title;
        btn.type = 'button';
        const dot = document.createElement('span');
        dot.className = 'tab-item-dot';
        const label = document.createElement('span');
        label.className = 'tab-item-label';
        btn.appendChild(dot);
        btn.appendChild(label);
        btn.addEventListener('click', () => {
          socket.emit('command:switch_tab', {
            commandId: newCommandId(), tabTitle: tab.title, selectorPath: tab.selectorPath,
          });
        });
        existingMap.set(tab.title, btn);
      }
      btn.classList.toggle('active', !!tab.isActive);
      btn.querySelector('.tab-item-label').textContent = tabDisplayTitle(tab.title);
      fragment.appendChild(btn);
    });
    $tabList.appendChild(fragment);

    const activeTab = tabs.find((t) => t.isActive);
    const activeTitle = activeTab ? activeTab.title : '';
    if (activeTitle && activeTitle !== lastActiveTabTitle) {
      lastActiveTabTitle = activeTitle;
      const activeBtn = $tabList.querySelector('.tab-item.active');
      if (activeBtn && typeof activeBtn.scrollIntoView === 'function') {
        activeBtn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Mode / Model rendering ---

  const MODE_ICONS = {
    agent: '\u221E', plan: '\u2611', debug: '\uD83D\uDC1B', chat: '\uD83D\uDCAC',
  };
  const MODE_LABELS = { agent: 'Agent', plan: 'Plan', debug: 'Debug', chat: 'Ask' };

  function renderModeModel() {
    const mode = state.mode || { current: 'agent', available: [] };
    const model = state.model || { current: 'Auto', currentId: '' };
    $pillModeIcon.textContent = MODE_ICONS[mode.current] || '';
    $pillModeText.textContent = MODE_LABELS[mode.current] || mode.current;
    $pillModelText.textContent = model.current || 'Auto';
  }

  renderAll();

  // --- Bottom sheet logic ---

  function openSheet(type) {
    closeSheet();
    activeSheet = type;
    $sheetOverlay.classList.remove('hidden');
    if (type === 'mode') {
      $sheetMode.classList.remove('hidden');
      renderModeSheet();
    } else if (type === 'model') {
      $sheetModel.classList.remove('hidden');
      if (cachedModelOptions) renderModelSheet(cachedModelOptions);
      else renderModelSheetLoading();
      fetchModelOptions().then(options => {
        if (activeSheet !== 'model') return;
        if (options) renderModelSheet(options);
        else if (!cachedModelOptions) renderModelSheet(null);
      });
    } else if (type === 'plan-model') {
      $sheetPlanModel.classList.remove('hidden');
      renderPlanModelSheet();
    } else if (type === 'window') {
      $sheetWindow.classList.remove('hidden');
      renderWindowSheet();
    } else if (type === 'connection') {
      $sheetConnection.classList.remove('hidden');
      renderConnectionSheet();
    }
  }

  function closeSheet() {
    $sheetOverlay.classList.add('hidden');
    $sheetMode.classList.add('hidden');
    $sheetModel.classList.add('hidden');
    $sheetPlanModel.classList.add('hidden');
    $sheetWindow.classList.add('hidden');
    $sheetConnection.classList.add('hidden');
    activeSheet = null;
  }

  function renderModeSheet() {
    $sheetModeList.innerHTML = '';
    const modes = [
      { id: 'agent', label: 'Agent', icon: '\u221E' },
      { id: 'plan', label: 'Plan', icon: '\u2611' },
      { id: 'debug', label: 'Debug', icon: '\uD83D\uDC1B' },
      { id: 'chat', label: 'Ask', icon: '\uD83D\uDCAC' },
    ];
    const current = (state.mode || {}).current || 'agent';
    modes.forEach(m => {
      const btn = document.createElement('button');
      btn.className = 'sheet-item' + (m.id === current ? ' selected' : '');
      btn.innerHTML = `<span class="sheet-item-icon">${m.icon}</span><span>${escapeHtml(m.label)}</span>` + (m.id === current ? '<span class="sheet-item-check">\u2713</span>' : '');
      btn.addEventListener('click', () => {
        socket.emit('command:set_mode', { commandId: newCommandId(), modeId: m.id });
        closeSheet();
        showToast(`Mode: ${m.label}`, 'success');
      });
      $sheetModeList.appendChild(btn);
    });
  }

  let cachedModelOptions = null;

  async function fetchModelOptions() {
    const commandId = newCommandId();
    const result = await sendCommandAwaitResult('command:get_model_options', { commandId, type: 'get_model_options' });
    if (result.ok && Array.isArray(result.data?.options)) {
      cachedModelOptions = result.data.options;
      return result.data.options;
    }
    return null;
  }

  function renderModelSheet(options) {
    $sheetModelList.innerHTML = '';
    if (!options || options.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sheet-empty';
      empty.textContent = 'No models available';
      $sheetModelList.appendChild(empty);
      return;
    }
    const currentId = ((state.model || {}).currentId || '');
    const currentName = ((state.model || {}).current || '').toLowerCase();
    options.forEach(opt => {
      const isSelected = (currentId && opt.id === currentId) || opt.selected || currentName === opt.label.toLowerCase();
      const btn = document.createElement('button');
      btn.className = 'sheet-item' + (isSelected ? ' selected' : '');
      let inner = '<span class="sheet-item-label">' + escapeHtml(opt.label) + '</span>';
      const right = [];
      if (isSelected) right.push('<span class="sheet-item-check">\u2713</span>');
      inner += '<span class="sheet-item-right">' + right.join('') + '</span>';
      btn.innerHTML = inner;
      btn.addEventListener('click', () => {
        socket.emit('command:set_model', { commandId: newCommandId(), modelId: opt.id });
        closeSheet();
        showToast(`Model: ${opt.label}`, 'success');
      });
      $sheetModelList.appendChild(btn);
    });
  }

  function renderModelSheetLoading() {
    $sheetModelList.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'sheet-loading';
    loading.textContent = 'Loading models…';
    $sheetModelList.appendChild(loading);
  }

  function renderPlanModelSheet() {
    $sheetPlanModelList.innerHTML = '';
    const ctx = activePlanModelContext;
    $sheetPlanModelHeader.textContent = ctx && ctx.title ? `Plan Model · ${ctx.title}` : 'Plan Model';
    if (!ctx || !Array.isArray(ctx.options) || ctx.options.length === 0) return;
    ctx.options.forEach((opt) => {
      const btn = document.createElement('button');
      btn.className = 'sheet-item' + (opt.selected ? ' selected' : '');
      btn.innerHTML = `<span class="sheet-item-label">${escapeHtml(opt.label)}</span><span class="sheet-item-right">${opt.selected ? '<span class="sheet-item-check">\u2713</span>' : ''}</span>`;
      btn.addEventListener('click', async () => {
        const result = await sendCommandAwaitResult('command:set_plan_model', {
          commandId: newCommandId(), type: 'set_plan_model', selectorPath: ctx.selectorPath, planModelId: opt.id,
        });
        if (!result.ok) { showToast(result.error || 'Could not set plan model', 'error'); return; }
        closeSheet();
        showToast(`Plan model: ${opt.label}`, 'success');
      });
      $sheetPlanModelList.appendChild(btn);
    });
  }

  function showToast(message, type) {
    const toast = document.createElement('div');
    toast.className = 'toast ' + (type || '');
    toast.textContent = message;
    $toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  } // end bootstrap

  init();
})();
