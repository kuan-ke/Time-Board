const socket = io();

const CHANNEL_COUNT = 60;
const NICKNAME_KEY = 'ch_timer_nickname';

let tabs = [];
let currentTabId = null;
let clockOffset = 0; // serverTime - Date.now()
let myNickname = null;
let isAdmin = false;
let onlineUsers = []; // [{id, name}]

let modalContext = null; // { tabId, channelIndex }

// ---------- DOM refs ----------
const connStatusEl = document.getElementById('connStatus');
const tabsListEl = document.getElementById('tabsList');
const addTabBtn = document.getElementById('addTabBtn');
const minInput = document.getElementById('minInput');
const maxInput = document.getElementById('maxInput');
const gridEl = document.getElementById('grid');
const bossImageEl = document.getElementById('bossImage');
const bossNameEl = document.getElementById('bossName');
const statusListEl = document.getElementById('statusList');

const myNicknameDisplay = document.getElementById('myNicknameDisplay');
const adminEditSelfBtn = document.getElementById('adminEditSelfBtn');
const adminPanel = document.getElementById('adminPanel');
const adminUserList = document.getElementById('adminUserList');

const nicknameOverlay = document.getElementById('nicknameOverlay');
const nicknameInput = document.getElementById('nicknameInput');
const nicknameSubmitBtn = document.getElementById('nicknameSubmitBtn');

const modalOverlay = document.getElementById('modalOverlay');
const modalMin = document.getElementById('modalMin');
const modalMax = document.getElementById('modalMax');
const modalTitle = document.getElementById('modalTitle');
const modalStateNote = document.getElementById('modalStateNote');
const modalResetBtn = document.getElementById('modalResetBtn');
const modalCancelBtn = document.getElementById('modalCancelBtn');
const modalSaveBtn = document.getElementById('modalSaveBtn');

// ---------- Nickname (mandatory, locked after set) ----------
function initNickname() {
  const saved = localStorage.getItem(NICKNAME_KEY);
  if (saved) {
    myNickname = saved;
    hideNicknameOverlay();
    socket.emit('setNickname', saved);
  } else {
    showNicknameOverlay();
  }
  updateNicknameDisplay();
}

function showNicknameOverlay() {
  nicknameOverlay.classList.remove('hidden');
  nicknameInput.value = '';
  setTimeout(() => nicknameInput.focus(), 50);
}
function hideNicknameOverlay() {
  nicknameOverlay.classList.add('hidden');
}

function submitNickname() {
  const val = nicknameInput.value.trim();
  if (!val) {
    nicknameInput.focus();
    return;
  }
  myNickname = val.slice(0, 20);
  localStorage.setItem(NICKNAME_KEY, myNickname);
  socket.emit('setNickname', myNickname);
  hideNicknameOverlay();
  updateNicknameDisplay();
}

nicknameSubmitBtn.addEventListener('click', submitNickname);
nicknameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitNickname();
});

function updateNicknameDisplay() {
  myNicknameDisplay.textContent = myNickname ? `您的暱稱：${myNickname}` : '';
}

socket.on('nickname:ack', (name) => {
  myNickname = name;
  updateNicknameDisplay();
});

// 伺服器管理者強制修改了「我」的暱稱
socket.on('forceNickname', (name) => {
  myNickname = name;
  localStorage.setItem(NICKNAME_KEY, name);
  updateNicknameDisplay();
  hideNicknameOverlay();
});

socket.on('error:needNickname', () => {
  showNicknameOverlay();
});

initNickname();

// ---------- Admin ----------
(function initAdmin() {
  const params = new URLSearchParams(window.location.search);
  const key = params.get('admin');
  if (key) {
    socket.emit('adminAuth', key);
  }
})();

socket.on('adminAuth:result', (ok) => {
  isAdmin = ok;
  if (ok) {
    adminPanel.classList.remove('hidden');
    adminEditSelfBtn.classList.remove('hidden');
    renderAdminUserList();
  } else {
    alert('管理者密鑰錯誤');
  }
});

adminEditSelfBtn.addEventListener('click', () => {
  const newName = prompt('（管理者）修改您自己的暱稱：', myNickname || '');
  if (newName !== null && newName.trim()) {
    myNickname = newName.trim().slice(0, 20);
    localStorage.setItem(NICKNAME_KEY, myNickname);
    socket.emit('setNickname', myNickname);
    updateNicknameDisplay();
  }
});

socket.on('users:update', (list) => {
  onlineUsers = list;
  if (isAdmin) renderAdminUserList();
});

function renderAdminUserList() {
  adminUserList.innerHTML = '';
  if (onlineUsers.length === 0) {
    adminUserList.innerHTML = '<span style="color:#9ca3af;">目前沒有已設定暱稱的使用者</span>';
    return;
  }
  onlineUsers.forEach((u) => {
    const row = document.createElement('div');
    row.className = 'admin-user-row';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = u.name;
    row.appendChild(nameSpan);

    const editBtn = document.createElement('button');
    editBtn.textContent = '修改';
    editBtn.addEventListener('click', () => {
      const newName = prompt(`修改「${u.name}」的暱稱：`, u.name);
      if (newName !== null && newName.trim()) {
        socket.emit('adminRenameUser', { targetSocketId: u.id, newName: newName.trim() });
      }
    });
    row.appendChild(editBtn);
    adminUserList.appendChild(row);
  });
}

// ---------- Socket connection status ----------
socket.on('connect', () => {
  connStatusEl.textContent = '已連線';
  connStatusEl.className = 'conn-status ok';
  if (myNickname) socket.emit('setNickname', myNickname);
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
  renderBossBanner();
  renderGrid();
  renderStatusPanel();
}

socket.on('channelAlert', ({ tabId, channelIndex }) => {
  if (tabId === currentTabId) {
    const btn = gridEl.querySelector(`[data-idx="${channelIndex}"]`);
    if (btn) {
      btn.classList.add('flash');
      setTimeout(() => btn.classList.remove('flash'), 3000);
    }
  }
  playBeep();
});

// ---------- Tabs ----------
function renderTabs() {
  tabsListEl.innerHTML = '';
  tabs.forEach((tab) => {
    const el = document.createElement('div');
    el.className = 'tab-item' + (tab.id === currentTabId ? ' active' : '');

    if (tab.image) {
      const img = document.createElement('img');
      img.src = `images/${tab.image}`;
      img.className = 'tab-thumb';
      img.alt = tab.name;
      el.appendChild(img);
    }

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
      renderBossBanner();
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

// ---------- Boss banner ----------
function renderBossBanner() {
  const tab = getCurrentTab();
  if (!tab) return;
  bossNameEl.textContent = tab.name;
  if (tab.image) {
    bossImageEl.src = `images/${tab.image}`;
    bossImageEl.alt = tab.name;
    bossImageEl.classList.remove('hidden');
  } else {
    bossImageEl.classList.add('hidden');
  }
}

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

    const whoEl = document.createElement('div');
    whoEl.className = 'ch-who';
    btn.appendChild(whoEl);

    if (ch.customMin !== null || ch.customMax !== null) {
      const flag = document.createElement('div');
      flag.className = 'custom-flag';
      flag.textContent = '★';
      flag.title = '此 CH 使用自訂時間';
      btn.appendChild(flag);
    }

    btn.addEventListener('click', () => {
      if (!ensureNickname()) return;
      socket.emit('channelClick', { tabId: tab.id, channelIndex: i });
    });

    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!ensureNickname()) return;
      openModal(tab, i);
    });

    gridEl.appendChild(btn);
  }

  updateGridDisplay();
}

function ensureNickname() {
  if (!myNickname) {
    showNicknameOverlay();
    return false;
  }
  return true;
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
    const whoEl = btn.querySelector('.ch-who');

    btn.classList.remove('counting', 'appearing');

    if (ch.state === 'idle' || ch.startTime === null) {
      sub.textContent = '';
      timerEl.textContent = '';
      whoEl.textContent = '';
      return;
    }

    const minMs = (ch.customMin ?? tab.minMinutes) * 60000;
    const maxMs = (ch.customMax ?? tab.maxMinutes) * 60000;
    const elapsed = now - ch.startTime;

    whoEl.textContent = ch.startedBy ? `👤 ${ch.startedBy}` : '';

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
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ---------- Status panel (all tabs, all active channels) ----------
function renderStatusPanel() {
  const now = Date.now() + clockOffset;
  const rows = [];

  tabs.forEach((tab) => {
    tab.channels.forEach((ch, idx) => {
      if (ch.state === 'idle' || ch.startTime === null) return;
      const minMs = (ch.customMin ?? tab.minMinutes) * 60000;
      const maxMs = (ch.customMax ?? tab.maxMinutes) * 60000;
      const elapsed = now - ch.startTime;
      const remainingMs = ch.state === 'counting' ? (minMs - elapsed) : (maxMs - elapsed);
      rows.push({
        tabId: tab.id,
        tabName: tab.name,
        channelIndex: idx,
        who: ch.startedBy || '未知',
        state: ch.state,
        remainingMs: Math.max(0, remainingMs)
      });
    });
  });

  rows.sort((a, b) => a.remainingMs - b.remainingMs);

  statusListEl.innerHTML = '';
  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'status-empty';
    empty.textContent = '目前沒有任何 CH 在倒數中';
    statusListEl.appendChild(empty);
    return;
  }

  rows.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'status-row';

    const tag = document.createElement('span');
    tag.className = 'status-tag';
    tag.textContent = r.tabName;
    row.appendChild(tag);

    const chSpan = document.createElement('span');
    chSpan.className = 'status-ch';
    chSpan.textContent = `CH${r.channelIndex + 1}`;
    row.appendChild(chSpan);

    const whoSpan = document.createElement('span');
    whoSpan.className = 'status-who';
    whoSpan.textContent = `👤 ${r.who}`;
    row.appendChild(whoSpan);

    const stateSpan = document.createElement('span');
    stateSpan.className = 'status-state ' + r.state;
    stateSpan.textContent = r.state === 'counting' ? '倒數中' : '出現中';
    row.appendChild(stateSpan);

    const timeSpan = document.createElement('span');
    timeSpan.className = 'status-time';
    timeSpan.textContent = formatMs(r.remainingMs);
    row.appendChild(timeSpan);

    row.addEventListener('click', () => {
      currentTabId = r.tabId;
      renderTabs();
      renderRangePanel();
      renderBossBanner();
      renderGrid();
    });

    statusListEl.appendChild(row);
  });
}

setInterval(() => {
  updateGridDisplay();
  renderStatusPanel();
}, 1000);

// ---------- Modal (right-click custom time) ----------
function openModal(tab, channelIndex) {
  const ch = tab.channels[channelIndex];
  modalContext = { tabId: tab.id, channelIndex };
  modalTitle.textContent = `設定 CH${channelIndex + 1} 倒數時間`;
  modalMin.value = ch.customMin ?? tab.minMinutes;
  modalMax.value = ch.customMax ?? tab.maxMinutes;

  if (ch.state === 'idle') {
    modalStateNote.textContent = '此 CH 目前待機中：儲存後將以此設定「立即開始倒數」。';
  } else {
    modalStateNote.textContent = '此 CH 正在倒數中：儲存只會更新之後的預設時間，不會中斷目前的倒數。';
  }

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
