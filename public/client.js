const socket = io();

const CHANNEL_COUNT = 60;

let tabs = [];
let currentTabId = null;
let clockOffset = 0; // serverTime - Date.now()

let modalContext = null; // { tabId, channelIndex }

const connStatusEl = document.getElementById('connStatus');
const tabsListEl = document.getElementById('tabsList');
const addTabBtn = document.getElementById('addTabBtn');
const minInput = document.getElementById('minInput');
const maxInput = document.getElementById('maxInput');
const gridEl = document.getElementById('grid');

const modalOverlay = document.getElementById('modalOverlay');
const modalMin = document.getElementById('modalMin');
const modalMax = document.getElementById('modalMax');
const modalTitle = document.getElementById('modalTitle');
const modalResetBtn = document.getElementById('modalResetBtn');
const modalCancelBtn = document.getElementById('modalCancelBtn');
const modalSaveBtn = document.getElementById('modalSaveBtn');

// ---------- Socket connection status ----------
socket.on('connect', () => {
  connStatusEl.textContent = '已連線';
  connStatusEl.className = 'conn-status ok';
});
socket.on('disconnect', () => {
  connStatusEl.textContent = '連線中斷，嘗試重新連線...';
  connStatusEl.className = 'conn-status err';
});

// ---------- Receiving state ----------
socket.on('state:init', handleState);
socket.on('state:update', handleState);

function handleState(data) {
  clockOffset = data.serverTime - Date.now();
  tabs = data.tabs;

  if (!currentTabId || !tabs.find((t) => t.id === currentTabId)) {
    currentTabId = tabs[0].id;
  }

  renderTabs();
  renderRangePanel();
  renderGrid();
}

socket.on('channelAlert', ({ tabId, channelIndex }) => {
  if (tabId !== currentTabId) return;
  const btn = gridEl.querySelector(`[data-idx="${channelIndex}"]`);
  if (btn) {
    btn.classList.add('flash');
    setTimeout(() => btn.classList.remove('flash'), 3000);
  }
  playBeep();
});

// ---------- Tabs ----------
function renderTabs() {
  tabsListEl.innerHTML = '';
  tabs.forEach((tab) => {
    const el = document.createElement('div');
    el.className = 'tab-item' + (tab.id === currentTabId ? ' active' : '');

    const nameSpan = document.createElement('span');
    nameSpan.textContent = tab.name;
    el.appendChild(nameSpan);

    if (tabs.length > 1) {
      const closeBtn = document.createElement('span');
      closeBtn.textContent = '✕';
      closeBtn.className = 'close-btn';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`確定要刪除分頁「${tab.name}」嗎？`)) {
          socket.emit('removeTab', tab.id);
        }
      });
      el.appendChild(closeBtn);
    }

    el.addEventListener('click', () => {
      currentTabId = tab.id;
      renderTabs();
      renderRangePanel();
      renderGrid();
    });

    el.addEventListener('dblclick', () => {
      const newName = prompt('輸入新的分頁名稱：', tab.name);
      if (newName !== null && newName.trim()) {
        socket.emit('renameTab', { tabId: tab.id, name: newName.trim() });
      }
    });

    tabsListEl.appendChild(el);
  });
}

addTabBtn.addEventListener('click', () => {
  const name = prompt('輸入新分頁名稱：', `分頁 ${tabs.length + 1}`);
  if (name !== null) {
    socket.emit('addTab', name.trim() || undefined);
  }
});

// ---------- Range panel ----------
function getCurrentTab() {
  return tabs.find((t) => t.id === currentTabId);
}

function renderRangePanel() {
  const tab = getCurrentTab();
  if (!tab) return;
  minInput.value = tab.minMinutes;
  maxInput.value = tab.maxMinutes;
}

function submitRangeChange() {
  const tab = getCurrentTab();
  if (!tab) return;
  socket.emit('updateTabRange', {
    tabId: tab.id,
    minMinutes: minInput.value,
    maxMinutes: maxInput.value
  });
}

minInput.addEventListener('change', submitRangeChange);
maxInput.addEventListener('change', submitRangeChange);

// ---------- Grid ----------
function renderGrid() {
  const tab = getCurrentTab();
  if (!tab) return;

  gridEl.innerHTML = '';
  for (let i = 0; i < CHANNEL_COUNT; i++) {
    const ch = tab.channels[i];
    const btn = document.createElement('div');
    btn.className = 'ch-btn';
    btn.dataset.idx = i;

    const label = document.createElement('div');
    label.className = 'ch-label';
    label.textContent = `CH${i + 1}`;
    btn.appendChild(label);

    const sub = document.createElement('div');
    sub.className = 'ch-sub';
    btn.appendChild(sub);

    const timerEl = document.createElement('div');
    timerEl.className = 'ch-timer';
    btn.appendChild(timerEl);

    if (ch.customMin !== null || ch.customMax !== null) {
      const flag = document.createElement('div');
      flag.className = 'custom-flag';
      flag.textContent = '★';
      flag.title = '此 CH 使用自訂時間';
      btn.appendChild(flag);
    }

    btn.addEventListener('click', () => {
      socket.emit('channelClick', { tabId: tab.id, channelIndex: i });
    });

    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openModal(tab, i);
    });

    gridEl.appendChild(btn);
  }

  updateGridDisplay();
}

function updateGridDisplay() {
  const tab = getCurrentTab();
  if (!tab) return;
  const now = Date.now() + clockOffset;

  tab.channels.forEach((ch, i) => {
    const btn = gridEl.querySelector(`[data-idx="${i}"]`);
    if (!btn) return;
    const sub = btn.querySelector('.ch-sub');
    const timerEl = btn.querySelector('.ch-timer');

    btn.classList.remove('counting', 'appearing');

    if (ch.state === 'idle' || ch.startTime === null) {
      sub.textContent = '';
      timerEl.textContent = '';
      return;
    }

    const minMs = (ch.customMin ?? tab.minMinutes) * 60000;
    const maxMs = (ch.customMax ?? tab.maxMinutes) * 60000;
    const elapsed = now - ch.startTime;

    if (ch.state === 'counting') {
      btn.classList.add('counting');
      sub.textContent = '倒數提醒';
      timerEl.textContent = formatMs(Math.max(0, minMs - elapsed));
    } else if (ch.state === 'appearing') {
      btn.classList.add('appearing');
      sub.textContent = '出現中';
      timerEl.textContent = formatMs(Math.max(0, maxMs - elapsed));
    }
  });
}

function formatMs(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

setInterval(updateGridDisplay, 1000);

// ---------- Modal (right-click custom time) ----------
function openModal(tab, channelIndex) {
  const ch = tab.channels[channelIndex];
  modalContext = { tabId: tab.id, channelIndex };
  modalTitle.textContent = `設定 CH${channelIndex + 1} 倒數時間`;
  modalMin.value = ch.customMin ?? tab.minMinutes;
  modalMax.value = ch.customMax ?? tab.maxMinutes;
  modalOverlay.classList.remove('hidden');
}

function closeModal() {
  modalOverlay.classList.add('hidden');
  modalContext = null;
}

modalCancelBtn.addEventListener('click', closeModal);

modalSaveBtn.addEventListener('click', () => {
  if (!modalContext) return;
  socket.emit('channelSetCustom', {
    tabId: modalContext.tabId,
    channelIndex: modalContext.channelIndex,
    customMin: modalMin.value,
    customMax: modalMax.value
  });
  closeModal();
});

modalResetBtn.addEventListener('click', () => {
  if (!modalContext) return;
  socket.emit('channelSetCustom', {
    tabId: modalContext.tabId,
    channelIndex: modalContext.channelIndex,
    customMin: null,
    customMax: null
  });
  closeModal();
});

modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

// ---------- Sound alert ----------
let audioCtx = null;
function playBeep() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.value = 0.15;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.35);
  } catch (e) {
    // 瀏覽器可能封鎖自動播放音效，忽略即可
  }
}
