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
const statusListCountingEl = document.getElementById('statusListCounting');
const statusListAppearingEl = document.getElementById('statusListAppearing');
const SOON_THRESHOLD_MS = 5 * 60 * 1000; // 5 分鐘內視為「即將出現」
const logListEl = document.getElementById('logList');

const onlineCountEl = document.getElementById('onlineCount');
const onlineNamesEl = document.getElementById('onlineNames');

const myNicknameDisplay = document.getElementById('myNicknameDisplay');
const adminEditSelfBtn = document.getElementById('adminEditSelfBtn');
const adminPanel = document.getElementById('adminPanel');
const adminUserList = document.getElementById('adminUserList');

const nicknameOverlay = document.getElementById('nicknameOverlay');
const nicknameInput = document.getElementById('nicknameInput');
const nicknameSubmitBtn = document.getElementById('nicknameSubmitBtn');
const nicknameError = document.getElementById('nicknameError');

const modalOverlay = document.getElementById('modalOverlay');
const modalHour = document.getElementById('modalHour');
const modalMinute = document.getElementById('modalMinute');
const modalTitle = document.getElementById('modalTitle');
const modalStateNote = document.getElementById('modalStateNote');
const modalResetBtn = document.getElementById('modalResetBtn');
const modalCancelBtn = document.getElementById('modalCancelBtn');
const modalSaveBtn = document.getElementById('modalSaveBtn');
const adminClearLogBtn = document.getElementById('adminClearLogBtn');
const rangeHintEl = document.getElementById('rangeHint');

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

function showNicknameOverlay(errorMsg) {
  nicknameOverlay.classList.remove('hidden');
  nicknameInput.value = '';
  if (errorMsg) {
    nicknameError.textContent = errorMsg;
    nicknameError.classList.remove('hidden');
  } else {
    nicknameError.classList.add('hidden');
  }
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
  const candidate = val.slice(0, 20);
  socket.emit('setNickname', candidate);
  // 先不鎖定 localStorage，等伺服器 ack 成功後才儲存（避免暱稱重複/被禁用卻鎖死）
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
  localStorage.setItem(NICKNAME_KEY, name);
  updateNicknameDisplay();
  hideNicknameOverlay();
});

socket.on('nickname:taken', () => {
  showNicknameOverlay('這個暱稱已經有人在使用，請換一個');
});

socket.on('nickname:banned', () => {
  localStorage.removeItem(NICKNAME_KEY);
  showNicknameOverlay('這個暱稱已被管理者移除，請使用其他暱稱');
});

// 伺服器管理者強制修改了「我」的暱稱
socket.on('forceNickname', (name) => {
  myNickname = name;
  localStorage.setItem(NICKNAME_KEY, name);
  updateNicknameDisplay();
  hideNicknameOverlay();
});

socket.on('removedByAdmin', () => {
  localStorage.removeItem(NICKNAME_KEY);
  myNickname = null;
  updateNicknameDisplay();
  showNicknameOverlay('您已被管理者移除，請重新輸入暱稱加入');
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
    document.body.classList.add('is-admin');
    adminPanel.classList.remove('hidden');
    adminEditSelfBtn.classList.remove('hidden');
    adminClearLogBtn.classList.remove('hidden');
    renderAdminUserList();
  } else {
    alert('管理者密鑰錯誤');
  }
});

adminClearLogBtn.addEventListener('click', () => {
  if (confirm('確定要清空全部操作紀錄嗎？此動作無法復原。')) {
    socket.emit('adminClearLog');
  }
});

adminEditSelfBtn.addEventListener('click', () => {
  const newName = prompt('（管理者）修改您自己的暱稱：', myNickname || '');
  if (newName !== null && newName.trim()) {
    socket.emit('setNickname', newName.trim().slice(0, 20));
  }
});

socket.on('users:update', (list) => {
  onlineUsers = list;
  renderOnlineUsersBar();
  if (isAdmin) renderAdminUserList();
});

function renderOnlineUsersBar() {
  onlineCountEl.textContent = onlineUsers.length;
  onlineNamesEl.textContent = onlineUsers.map((u) => u.name).join('、');
}

function renderAdminUserList() {
  adminUserList.innerHTML = '';
  if (onlineUsers.length === 0) {
    adminUserList.innerHTML = '<span style="color:#64748b;">目前沒有已設定暱稱的使用者</span>';
    return;
  }
  onlineUsers.forEach((u) => {
    const row = document.createElement('div');
    row.className = 'admin-user-row';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'u-name';
    nameSpan.textContent = u.name;
    row.appendChild(nameSpan);

    const renameBtn = document.createElement('button');
    renameBtn.textContent = '改名';
    renameBtn.title = '修改此人的暱稱';
    renameBtn.addEventListener('click', () => {
      const newName = prompt(`修改「${u.name}」的暱稱：`, u.name);
      if (newName !== null && newName.trim()) {
        socket.emit('adminRenameUser', { targetSocketId: u.id, newName: newName.trim() });
      }
    });
    row.appendChild(renameBtn);

    const hideBtn = document.createElement('button');
    hideBtn.textContent = '隱藏計時器';
    hideBtn.title = '清除此人目前所有進行中的倒數';
    hideBtn.addEventListener('click', () => {
      if (confirm(`確定要隱藏（清除）「${u.name}」目前所有進行中的計時器嗎？`)) {
        socket.emit('adminHideUserTimers', { nickname: u.name });
      }
    });
    row.appendChild(hideBtn);

    const removeBtn = document.createElement('button');
    removeBtn.textContent = '移除';
    removeBtn.className = 'danger';
    removeBtn.title = '將此人移出網站';
    removeBtn.addEventListener('click', () => {
      if (confirm(`確定要將「${u.name}」移除出網站嗎？此暱稱之後將無法再使用。`)) {
        socket.emit('adminRemoveUser', { targetSocketId: u.id, nickname: u.name });
      }
    });
    row.appendChild(removeBtn);

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

// ---------- Activity log (persistent) ----------
socket.on('log:init', (entries) => {
  logListEl.innerHTML = '';
  if (!entries || entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'status-empty';
    empty.textContent = '尚無任何操作紀錄';
    logListEl.appendChild(empty);
    return;
  }
  entries.forEach((e) => logListEl.appendChild(buildLogRow(e)));
});

socket.on('log:new', (entry) => {
  const empty = logListEl.querySelector('.status-empty');
  if (empty) empty.remove();
  logListEl.insertBefore(buildLogRow(entry), logListEl.firstChild);
});

socket.on('log:remove', (logId) => {
  const row = logListEl.querySelector(`[data-id="${logId}"]`);
  if (row) row.remove();
  if (!logListEl.querySelector('.log-row')) {
    const empty = document.createElement('div');
    empty.className = 'status-empty';
    empty.textContent = '尚無任何操作紀錄';
    logListEl.appendChild(empty);
  }
});

socket.on('log:clear', () => {
  logListEl.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'status-empty';
  empty.textContent = '尚無任何操作紀錄';
  logListEl.appendChild(empty);
});

function buildLogRow(entry) {
  const row = document.createElement('div');
  row.className = 'log-row' + (entry.type === 'admin' ? ' admin' : '');
  row.dataset.id = entry.id;

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = formatDateTime(entry.time);
  row.appendChild(time);

  const msg = document.createElement('span');
  msg.className = 'log-message';
  msg.textContent = entry.message;
  row.appendChild(msg);

  const delBtn = document.createElement('button');
  delBtn.className = 'log-del-btn';
  delBtn.textContent = '✕';
  delBtn.title = '刪除這筆紀錄';
  delBtn.addEventListener('click', () => {
    socket.emit('adminDeleteLogEntry', entry.id);
  });
  row.appendChild(delBtn);

  return row;
}

function formatDateTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

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

    if (tab.locked) {
      const lockSpan = document.createElement('span');
      lockSpan.className = 'tab-lock';
      lockSpan.textContent = '🔒';
      lockSpan.title = '固定王，無法刪除或修改時間範圍';
      el.appendChild(lockSpan);
    }

    if (!tab.locked && tabs.length > 1) {
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
  minInput.disabled = !!tab.locked;
  maxInput.disabled = !!tab.locked;
  rangeHintEl.textContent = tab.locked
    ? '🔒 固定王，時間範圍無法修改（CH 仍可右鍵設定目標時刻）'
    : 'CH 可右鍵自訂目標時刻';
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

    whoEl.textContent = ch.startedBy ? `👤${ch.startedBy}` : '';

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

// ---------- Status panel (all tabs, split into 倒數中 / 出現中) ----------
function renderStatusPanel() {
  const now = Date.now() + clockOffset;
  const countingRows = [];
  const appearingRows = [];

  tabs.forEach((tab) => {
    tab.channels.forEach((ch, idx) => {
      if (ch.state === 'idle' || ch.startTime === null) return;
      const minMs = (ch.customMin ?? tab.minMinutes) * 60000;
      const maxMs = (ch.customMax ?? tab.maxMinutes) * 60000;

      const base = {
        tabId: tab.id,
        tabName: tab.name,
        channelIndex: idx,
        who: ch.startedBy || '未知'
      };

      if (ch.state === 'counting') {
        const remainingMs = Math.max(0, minMs - (now - ch.startTime));
        countingRows.push({ ...base, remainingMs, soon: remainingMs <= SOON_THRESHOLD_MS });
      } else if (ch.state === 'appearing') {
        const becameAppearingAt = ch.startTime + minMs; // 這個頻道「變成出現中」的時間點
        const remainingMs = Math.max(0, maxMs - (now - ch.startTime));
        appearingRows.push({ ...base, remainingMs, becameAppearingAt });
      }
    });
  });

  // 倒數中：最接近變成出現中的排最上面
  countingRows.sort((a, b) => a.remainingMs - b.remainingMs);
  // 出現中：最早變成出現中的排最上面
  appearingRows.sort((a, b) => a.becameAppearingAt - b.becameAppearingAt);

  renderStatusColumn(statusListCountingEl, countingRows, 'counting', '目前沒有倒數中的 CH');
  renderStatusColumn(statusListAppearingEl, appearingRows, 'appearing', '目前沒有出現中的 CH');
}

function renderStatusColumn(container, rows, state, emptyText) {
  container.innerHTML = '';
  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'status-empty';
    empty.textContent = emptyText;
    container.appendChild(empty);
    return;
  }

  rows.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'status-row' + (r.soon ? ' soon' : '');

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
    whoSpan.textContent = `👤${r.who}`;
    row.appendChild(whoSpan);

    if (r.soon) {
      const soonTag = document.createElement('span');
      soonTag.className = 'status-soon-tag';
      soonTag.textContent = '⚠即將出現';
      row.appendChild(soonTag);
    }

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

    container.appendChild(row);
  });
}

setInterval(() => {
  updateGridDisplay();
  renderStatusPanel();
}, 1000);

// ---------- Modal (右鍵：回報死亡時間，手動輸入時/分，24 小時制) ----------
function pad2(n) { return String(n).padStart(2, '0'); }

function openModal(tab, channelIndex) {
  const ch = tab.channels[channelIndex];
  modalContext = { tabId: tab.id, channelIndex };
  modalTitle.textContent = `回報 CH${channelIndex + 1} 死亡時間`;

  // 預設帶入「現在」（使用者裝置的本地時間），代表王剛剛才死
  const now = new Date(Date.now() + clockOffset);
  modalHour.value = now.getHours();
  modalMinute.value = now.getMinutes();

  modalStateNote.textContent = '請輸入王被擊殺的時間（24 小時制，例如 23 點 50 分）。若輸入的時間比現在晚，會自動視為昨天的這個時間，因為死亡時間一定是過去式。儲存後會以此時間重新計算倒數，並覆蓋此 CH 目前的狀態。';

  modalOverlay.classList.remove('hidden');
}

function closeModal() {
  modalOverlay.classList.add('hidden');
  modalContext = null;
}

modalCancelBtn.addEventListener('click', closeModal);

modalSaveBtn.addEventListener('click', () => {
  if (!modalContext) return;

  const hh = Number(modalHour.value);
  const mm = Number(modalMinute.value);
  if (!Number.isInteger(hh) || hh < 0 || hh > 23 || !Number.isInteger(mm) || mm < 0 || mm > 59) {
    alert('請輸入正確的時間（時：0~23，分：0~59）');
    return;
  }

  // 在使用者自己的瀏覽器本地時區計算絕對時間戳記，避免伺服器與使用者時區不同造成誤差
  const nowLocal = new Date();
  const death = new Date(nowLocal.getFullYear(), nowLocal.getMonth(), nowLocal.getDate(), hh, mm, 0, 0);
  if (death.getTime() > nowLocal.getTime()) {
    death.setDate(death.getDate() - 1); // 該時刻還沒到 -> 視為昨天（死亡時間一定是過去式）
  }

  socket.emit('channelSetCustom', {
    tabId: modalContext.tabId,
    channelIndex: modalContext.channelIndex,
    deathTimeEpoch: death.getTime(),
    deathTimeLabel: `${pad2(hh)}:${pad2(mm)}`
  });
  closeModal();
});

modalResetBtn.addEventListener('click', () => {
  if (!modalContext) return;
  socket.emit('channelSetCustom', {
    tabId: modalContext.tabId,
    channelIndex: modalContext.channelIndex,
    deathTimeEpoch: null
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
    gain.gain.value = 0.045; // 原本 0.15 的 30%
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.35);
  } catch (e) {
    // 瀏覽器可能封鎖自動播放音效，忽略即可
  }
}
