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
const adminMutedList = document.getElementById('adminMutedList');
let mutedList = []; // 被禁止操作的暱稱

const nicknameOverlay = document.getElementById('nicknameOverlay');
const nicknameInput = document.getElementById('nicknameInput');
const nicknameSubmitBtn = document.getElementById('nicknameSubmitBtn');
const nicknameError = document.getElementById('nicknameError');

const modalOverlay = document.getElementById('modalOverlay');
const modalHour = document.getElementById('modalHour');
const modalMinute = document.getElementById('modalMinute');
const modalTitle = document.getElementById('modalTitle');
const modalResetBtn = document.getElementById('modalResetBtn');
const modalCancelBtn = document.getElementById('modalCancelBtn');
const modalSaveBtn = document.getElementById('modalSaveBtn');
const adminClearLogBtn = document.getElementById('adminClearLogBtn');
const rangeHintEl = document.getElementById('rangeHint');

// ---------- 進入房間：暱稱 + 房間密碼 ----------
// 暱稱設定後鎖定（無法自行更改）；房間密碼相同的人會進到同一個房間。
// 兩者都存在 localStorage，重新整理或斷線重連時會自動回到原本的房間。
const ROOM_KEY = 'ch_timer_room_password';
const roomPasswordInput = document.getElementById('roomPasswordInput');
const togglePasswordBtn = document.getElementById('togglePasswordBtn');
const roomDisplay = document.getElementById('roomDisplay');
const roomPasswordText = document.getElementById('roomPasswordText');
const switchRoomBtn = document.getElementById('switchRoomBtn');

let myRoomPassword = null;
// 每個瀏覽器固定的識別碼：伺服器用它判斷「重新整理 / 重新連線的是同一個人」，
// 這樣重新整理時不會因為舊連線還沒斷而被判定「暱稱已有人使用」。
const CLIENT_ID_KEY = 'ch_timer_client_id';
const myClientId = (() => {
  let id = null;
  try { id = localStorage.getItem(CLIENT_ID_KEY); } catch (e) { /* ignore */ }
  if (!id || !/^[A-Za-z0-9-]{8,64}$/.test(id)) {
    id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
      : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
    try { localStorage.setItem(CLIENT_ID_KEY, id); } catch (e) { /* ignore */ }
  }
  return id;
})();
let joined = false;
let manualJoinPending = false; // 使用者手動按「進入房間」（用來決定要不要顯示「已建立 / 已進入」提示）
let showRoomPassword = false;

function storageGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function storageSet(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* ignore */ } }
function storageRemove(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } }

function initNickname() {
  const savedName = storageGet(NICKNAME_KEY);
  const savedPw = storageGet(ROOM_KEY);
  if (savedName) myNickname = savedName;
  if (savedPw) myRoomPassword = savedPw;

  if (savedName && savedPw) {
    hideNicknameOverlay(); // 連線後會自動進入原本的房間（見 socket 'connect'）
  } else {
    showNicknameOverlay();
  }
  updateNicknameDisplay();
}

// 顯示「進入房間」彈窗。已經有鎖定的暱稱時，暱稱欄位會帶入並設為唯讀；
// unlockNickname = true 時（暱稱在該房間重複 / 被移除）讓使用者重新輸入暱稱。
function showNicknameOverlay(errorMsg, opts = {}) {
  nicknameOverlay.classList.remove('hidden');

  const lockName = !!myNickname && !opts.unlockNickname;
  nicknameInput.value = lockName ? myNickname : (opts.keepNicknameValue ? nicknameInput.value : '');
  nicknameInput.readOnly = lockName;
  document.getElementById('nicknameHint').textContent = lockName
    ? '您的暱稱已鎖定，無法自行更改。'
    : '暱稱會顯示在您點擊的 CH 旁邊。設定後無法自行更改，請謹慎輸入。';

  if (!opts.keepPassword) roomPasswordInput.value = myRoomPassword || '';

  if (errorMsg) {
    nicknameError.textContent = errorMsg;
    nicknameError.classList.remove('hidden');
  } else {
    nicknameError.classList.add('hidden');
  }

  setTimeout(() => {
    if (opts.focus === 'password' || lockName) roomPasswordInput.focus();
    else nicknameInput.focus();
  }, 50);
}
function hideNicknameOverlay() {
  nicknameOverlay.classList.add('hidden');
}

function submitNickname() {
  const name = nicknameInput.value.trim().slice(0, 20);
  const pw = roomPasswordInput.value.trim();
  if (!name) {
    nicknameInput.focus();
    return;
  }
  if (!/^[A-Za-z0-9]{6}$/.test(pw)) {
    nicknameError.textContent = '房間密碼必須剛好 6 個字元，只能使用英文大小寫或數字';
    nicknameError.classList.remove('hidden');
    roomPasswordInput.focus();
    return;
  }
  manualJoinPending = true;
  // 被管理者移除時伺服器會中斷連線，這時要手動重新連線
  if (!socket.connected) socket.connect();
  socket.emit('joinRoom', { nickname: name, password: pw, clientId: myClientId });
  // 先不寫入 localStorage，等伺服器 join:ack 成功後才儲存（避免暱稱重複/被禁用卻鎖死）
  myRoomPassword = pw;
}

nicknameSubmitBtn.addEventListener('click', submitNickname);
nicknameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (!roomPasswordInput.value.trim()) roomPasswordInput.focus();
    else submitNickname();
  }
});
roomPasswordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitNickname();
});
// 輸入時自動濾掉英數字以外的字元（含空白、中文、符號），最多 6 碼
roomPasswordInput.addEventListener('input', () => {
  const cleaned = roomPasswordInput.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 6);
  if (cleaned !== roomPasswordInput.value) roomPasswordInput.value = cleaned;
});
// 產生隨機房間密碼（由伺服器產生，保證符合規則且不跟現有房間重複）
document.getElementById('randomPasswordBtn').addEventListener('click', () => {
  if (!socket.connected) {
    showToast('尚未連線到伺服器，請稍候再試');
    return;
  }
  socket.emit('generateRoomPassword', (pw) => {
    if (!pw) {
      showToast('產生失敗，請再按一次');
      return;
    }
    roomPasswordInput.value = pw;
    roomPasswordInput.type = 'text'; // 直接顯示出來，方便記下來分享給隊友
    togglePasswordBtn.textContent = '隱藏';
    nicknameError.classList.add('hidden');
    roomPasswordInput.focus();
  });
});

togglePasswordBtn.addEventListener('click', () => {
  const show = roomPasswordInput.type === 'password';
  roomPasswordInput.type = show ? 'text' : 'password';
  togglePasswordBtn.textContent = show ? '隱藏' : '顯示';
});

function updateNicknameDisplay() {
  myNicknameDisplay.textContent = myNickname ? `您的暱稱：${myNickname}${isAdmin ? '（👻 隱身中）' : ''}` : '';
  myNicknameDisplay.title = isAdmin ? '管理者不會出現在其他人的線上人數與名單中' : '';
}

function updateRoomDisplay() {
  if (joined && myRoomPassword) {
    roomDisplay.classList.remove('hidden');
    switchRoomBtn.classList.remove('hidden');
    roomPasswordText.textContent = showRoomPassword ? myRoomPassword : '••••';
  } else {
    roomDisplay.classList.add('hidden');
    switchRoomBtn.classList.add('hidden');
  }
}

roomDisplay.addEventListener('click', () => {
  showRoomPassword = !showRoomPassword;
  updateRoomDisplay();
});

// 換房間：清掉記住的房間密碼後重新載入（暱稱保留），重新輸入密碼
switchRoomBtn.addEventListener('click', () => {
  if (!confirm('確定要離開目前的房間嗎？之後需要重新輸入房間密碼。')) return;
  socket.emit('leaveRoom');
  storageRemove(ROOM_KEY);
  window.location.reload();
});

socket.on('join:ack', ({ nickname, created }) => {
  myNickname = nickname;
  joined = true;
  storageSet(NICKNAME_KEY, nickname);
  if (myRoomPassword) storageSet(ROOM_KEY, myRoomPassword);
  updateNicknameDisplay();
  updateRoomDisplay();
  hideNicknameOverlay();
  adminSwitchFrom = null;
  if (isAdmin) renderAdminRoomList();
  if (manualJoinPending) showToast(created ? '已建立新房間，把密碼分享給隊友就能一起使用' : '已進入房間');
  manualJoinPending = false;
});

socket.on('join:error', ({ field, code, message }) => {
  // 管理者從「所有房間」切換失敗（例如暱稱在那間已被使用）：留在原本的房間，只顯示提示
  if (adminSwitchFrom !== null) {
    myRoomPassword = adminSwitchFrom;
    adminSwitchFrom = null;
    manualJoinPending = false;
    showToast('無法進入該房間：' + message);
    return;
  }
  joined = false;
  manualJoinPending = false;
  updateRoomDisplay();
  if (code === 'banned') {
    // 這個暱稱被移出此房間：解除暱稱鎖定，讓使用者換一個
    storageRemove(NICKNAME_KEY);
    myNickname = null;
    updateNicknameDisplay();
  }
  if (field === 'nickname') {
    showNicknameOverlay(message, { unlockNickname: true, focus: 'nickname' });
  } else {
    showNicknameOverlay(message, { keepPassword: true, focus: 'password', keepNicknameValue: true });
  }
});

// 伺服器管理者強制修改了「我」的暱稱
socket.on('forceNickname', (name) => {
  myNickname = name;
  storageSet(NICKNAME_KEY, name);
  updateNicknameDisplay();
});

socket.on('removedByAdmin', () => {
  storageRemove(NICKNAME_KEY);
  myNickname = null;
  joined = false;
  updateNicknameDisplay();
  updateRoomDisplay();
  showNicknameOverlay('您已被管理者移出此房間，請使用其他暱稱，或輸入其他房間密碼', { unlockNickname: true });
});

socket.on('error:needNickname', () => {
  showNicknameOverlay();
});

socket.on('error:muted', () => showToast('您已被管理者禁止操作'));
socket.on('error:toast', (msg) => showToast(msg));

function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

initNickname();

// ---------- Admin ----------
// 管理者密鑰在每次連線（含斷線重連）時都會重新送出，而且一定在 joinRoom 之前，
// 這樣掛機太久斷線重連後，管理者仍然維持隱身（見 socket 'connect'）。
const adminKeyFromUrl = new URLSearchParams(window.location.search).get('admin');
let adminKeyRejected = false;

socket.on('adminAuth:result', (ok) => {
  isAdmin = ok;
  if (ok) {
    document.body.classList.add('is-admin');
    adminPanel.classList.remove('hidden');
    adminEditSelfBtn.classList.remove('hidden');
    adminClearLogBtn.classList.remove('hidden');
    renderAdminUserList();
    renderAdminMutedList();
    renderAdminRoomList();
    updateNicknameDisplay();
  } else if (!adminKeyRejected) {
    adminKeyRejected = true;
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
  // 隱身的管理者不列入（管理者自己看到的人數也跟一般人一樣）
  const visible = onlineUsers.filter((u) => !u.hidden);
  onlineCountEl.textContent = visible.length;
  onlineNamesEl.textContent = visible.map((u) => u.name).join('、');
}

function renderAdminUserList() {
  adminUserList.innerHTML = '';
  const players = onlineUsers.filter((u) => !u.hidden); // 不列出管理者（包含自己）
  if (players.length === 0) {
    adminUserList.innerHTML = '<span style="color:#64748b;">此房間目前沒有其他使用者</span>';
    return;
  }
  players.forEach((u) => {
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

    const isMutedUser = mutedList.some((n) => n.toLowerCase() === u.name.toLowerCase());
    const muteBtn = document.createElement('button');
    muteBtn.textContent = isMutedUser ? '解除禁止' : '禁止操作';
    muteBtn.title = '禁止此人進行任何操作（點 CH、擊殺、右鍵回報、分頁編輯），已存在的倒數不受影響';
    muteBtn.addEventListener('click', () => {
      if (isMutedUser) {
        socket.emit('adminUnmuteUser', { nickname: u.name });
      } else if (confirm(`確定要禁止「${u.name}」進行任何操作嗎？`)) {
        socket.emit('adminMuteUser', { nickname: u.name });
      }
    });
    row.appendChild(muteBtn);

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

// ---------- 管理者：所有房間列表（可一鍵進入任一房間） ----------
const adminRoomList = document.getElementById('adminRoomList');
const adminRoomCount = document.getElementById('adminRoomCount');
let adminRooms = [];
let adminSwitchFrom = null; // 管理者切換房間前所在的房間密碼（切換失敗時用來還原）

socket.on('admin:rooms', (list) => {
  adminRooms = list || [];
  if (isAdmin) renderAdminRoomList();
});

function renderAdminRoomList() {
  adminRoomCount.textContent = adminRooms.length;
  adminRoomList.innerHTML = '';
  if (adminRooms.length === 0) {
    adminRoomList.innerHTML = '<span style="color:#64748b;">目前沒有任何房間</span>';
    return;
  }
  adminRooms.forEach((r) => {
    const isCurrent = joined && r.password === myRoomPassword;
    const row = document.createElement('div');
    row.className = 'admin-user-row admin-room-row' + (isCurrent ? ' current' : '');
    row.title = r.users.length ? `線上：${r.users.join('、')}` : '目前沒有人在線';

    const pw = document.createElement('span');
    pw.className = 'r-pw';
    pw.textContent = r.password;
    row.appendChild(pw);

    const meta = document.createElement('span');
    meta.className = 'r-meta';
    meta.textContent = `👥${r.users.length} ⏳${r.activeCount}`;
    row.appendChild(meta);

    if (isCurrent) {
      const here = document.createElement('span');
      here.className = 'r-meta';
      here.textContent = '（目前所在）';
      row.appendChild(here);
    } else {
      const goBtn = document.createElement('button');
      goBtn.textContent = '進入';
      goBtn.title = '切換到這個房間';
      goBtn.addEventListener('click', () => adminJoinRoom(r.password));
      row.appendChild(goBtn);
    }
    adminRoomList.appendChild(row);
  });
}

function adminJoinRoom(password) {
  if (!myNickname) {
    myRoomPassword = password;
    showNicknameOverlay();
    return;
  }
  adminSwitchFrom = joined ? myRoomPassword : null;
  myRoomPassword = password;
  manualJoinPending = true;
  socket.emit('joinRoom', { nickname: myNickname, password, clientId: myClientId });
}

socket.on('admin:mutedList', (list) => {
  mutedList = list || [];
  if (isAdmin) {
    renderAdminMutedList();
    renderAdminUserList();
  }
});

function renderAdminMutedList() {
  adminMutedList.innerHTML = '';
  if (mutedList.length === 0) {
    adminMutedList.innerHTML = '<span style="color:#64748b;">目前沒有被禁止的使用者</span>';
    return;
  }
  mutedList.forEach((name) => {
    const row = document.createElement('div');
    row.className = 'admin-user-row';
    const label = document.createElement('span');
    label.className = 'u-name';
    label.textContent = name;
    row.appendChild(label);
    const btn = document.createElement('button');
    btn.textContent = '解除禁止';
    btn.addEventListener('click', () => socket.emit('adminUnmuteUser', { nickname: name }));
    row.appendChild(btn);
    adminMutedList.appendChild(row);
  });
}

// ---------- Socket connection status ----------
socket.on('connect', () => {
  connStatusEl.textContent = '已連線';
  connStatusEl.className = 'conn-status ok';
  if (adminKeyFromUrl && !adminKeyRejected) socket.emit('adminAuth', adminKeyFromUrl);
  // 已經有暱稱與房間密碼：自動進入（或斷線後重新進入）原本的房間
  if (myNickname && myRoomPassword && (joined || storageGet(ROOM_KEY))) {
    socket.emit('joinRoom', { nickname: myNickname, password: myRoomPassword, clientId: myClientId });
  }
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
    currentTabId = tabs.length ? tabs[0].id : null;
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
// 切換分頁後，主畫面與子母畫面（若開啟）都要一起刷新
function refreshAfterTabSwitch() {
  renderTabs();
  renderRangePanel();
  renderBossBanner();
  renderGrid();
  if (typeof renderStatusPanel === 'function') renderStatusPanel();
}

function renderTabs() {
  renderTabsInto(tabsListEl, false);
  if (pipTabsListEl) renderTabsInto(pipTabsListEl, true);
}

// compact = true：子母畫面用，只顯示王的圖示（沒有圖片的分頁才退回顯示文字），不顯示鎖頭/刪除鈕，節省橫向空間
function renderTabsInto(target, compact) {
  target.innerHTML = '';
  tabs.forEach((tab) => {
    const el = document.createElement('div');
    el.className = 'tab-item' + (tab.id === currentTabId ? ' active' : '') + (compact ? ' tab-item-compact' : '');
    el.title = tab.name;

    if (tab.image) {
      const img = document.createElement('img');
      img.src = `images/${tab.image}`;
      img.className = 'tab-thumb';
      img.alt = tab.name;
      el.appendChild(img);
    }

    // 有圖片的王只顯示圖片（滑鼠移上去會顯示名稱），沒有圖片的自訂分頁才顯示文字
    if (tab.image) el.classList.add('tab-item-image');
    if (!tab.image) {
      const nameSpan = document.createElement('span');
      nameSpan.textContent = tab.name;
      el.appendChild(nameSpan);
    }

    if (!compact && tab.locked && !tab.image) {
      const lockSpan = document.createElement('span');
      lockSpan.className = 'tab-lock';
      lockSpan.textContent = '🔒';
      lockSpan.title = '固定王，無法刪除或修改時間範圍';
      el.appendChild(lockSpan);
    }

    if (!compact && !tab.locked && tabs.length > 1) {
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
      refreshAfterTabSwitch();
    });

    el.addEventListener('dblclick', () => {
      const newName = prompt('輸入新的分頁名稱：', tab.name);
      if (newName !== null && newName.trim()) {
        socket.emit('renameTab', { tabId: tab.id, name: newName.trim() });
      }
    });

    target.appendChild(el);
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
  rangeHintEl.textContent = '右鍵輸入死亡時間或中鍵輸入重生時間';
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
// 回傳目前要渲染的所有網格容器（主畫面 + 子母畫面，若有開啟）
function getActiveGridTargets() {
  const targets = [gridEl];
  if (pipGridEl) targets.push(pipGridEl);
  return targets;
}

function renderGrid() {
  const tab = getCurrentTab();
  if (!tab) return;
  renderGridInto(gridEl, tab, false);
  if (pipGridEl) renderGridInto(pipGridEl, tab, true);
  updateGridDisplay();
}

// compact = true：子母畫面用，標籤只顯示數字（不顯示 "ch." 前綴），省空間、字體也較小
function renderGridInto(target, tab, compact) {
  target.innerHTML = '';
  for (let i = 0; i < CHANNEL_COUNT; i++) {
    const btn = document.createElement('div');
    btn.className = 'ch-btn';
    btn.dataset.idx = i;

    const label = document.createElement('div');
    label.className = 'ch-label';
    label.textContent = compact ? `${i + 1}` : `ch. ${i + 1}`;
    btn.appendChild(label);

    const timerEl = document.createElement('div');
    timerEl.className = 'ch-timer';
    btn.appendChild(timerEl);

    const spawnEl = document.createElement('div');
    spawnEl.className = 'ch-spawn';
    btn.appendChild(spawnEl);

    const whoEl = document.createElement('div');
    whoEl.className = 'ch-who';
    btn.appendChild(whoEl);

    btn.addEventListener('click', () => {
      if (!ensureNickname()) return;
      socket.emit('channelClick', { tabId: tab.id, channelIndex: i });
    });

    // 中鍵：輸入重生時間。mousedown 先擋掉瀏覽器的中鍵自動捲動
    btn.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault();
    });
    btn.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      if (!ensureNickname()) return;
      openSpawnModal(tab, i);
    });

    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!ensureNickname()) return;
      openModal(tab, i);
    });

    target.appendChild(btn);
  }
}

function ensureNickname() {
  if (!myNickname || !joined) {
    showNicknameOverlay();
    return false;
  }
  return true;
}

function updateGridDisplay() {
  const tab = getCurrentTab();
  if (!tab) return;
  const now = Date.now() + clockOffset;

  getActiveGridTargets().forEach((target) => {
    tab.channels.forEach((ch, i) => {
      const btn = target.querySelector(`[data-idx="${i}"]`);
      if (!btn) return;
      const timerEl = btn.querySelector('.ch-timer');
      const spawnEl = btn.querySelector('.ch-spawn');
      const whoEl = btn.querySelector('.ch-who');

      btn.classList.remove('counting', 'appearing');

      if (ch.state === 'idle' || ch.startTime === null) {
        timerEl.textContent = '';
        spawnEl.textContent = '';
        whoEl.textContent = '';
        return;
      }

      const minMs = (ch.customMin ?? tab.minMinutes) * 60000;
      const maxMs = (ch.customMax ?? tab.maxMinutes) * 60000;
      const elapsed = now - ch.startTime;

      spawnEl.textContent = `🕒${formatClock(ch.startTime + minMs)}`; // 出生時間 = 最小值倒數結束的時刻
      whoEl.textContent = ch.startedBy ? `👤${ch.startedBy}` : '';

      if (ch.state === 'counting') {
        btn.classList.add('counting');
        timerEl.textContent = formatMs(Math.max(0, minMs - elapsed));
      } else if (ch.state === 'appearing') {
        btn.classList.add('appearing');
        timerEl.textContent = appearingText(maxMs, elapsed);
      }
    });
  });
}

// 精準時刻 HH:MM:SS（24 小時制，使用者本地時區）
function formatClock(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// 出現中：未到最大值 -> 顯示距離最大值的剩餘時間；超過最大值 -> 顯示 +已超過多久（伺服器會在 10 分鐘後移除）
function appearingText(maxMs, elapsed) {
  return elapsed >= maxMs ? `+${formatMs(elapsed - maxMs)}` : formatMs(maxMs - elapsed);
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

// ---------- Status panel（本王 / 總頻道，分成 倒數中 / 出現中） ----------
let activeView = 'boss'; // 'boss' = 只看目前選的王；'all' = 總頻道（所有王）

function renderStatusPanel() {
  const now = Date.now() + clockOffset;
  const showAll = activeView === 'all';
  const countingRows = [];
  const appearingRows = [];

  tabs.forEach((tab) => {
    if (!showAll && tab.id !== currentTabId) return;
    tab.channels.forEach((ch, idx) => {
      if (ch.state === 'idle' || ch.startTime === null) return;
      const minMs = (ch.customMin ?? tab.minMinutes) * 60000;
      const maxMs = (ch.customMax ?? tab.maxMinutes) * 60000;
      const elapsed = now - ch.startTime;
      const spawnAt = ch.startTime + minMs; // 出生時間（最小值倒數結束的時刻）

      const base = {
        tabId: tab.id,
        tabName: tab.name,
        tabImage: tab.image,
        channelIndex: idx,
        who: ch.startedBy || '未知',
        spawnAt
      };

      if (ch.state === 'counting') {
        const remainingMs = Math.max(0, minMs - elapsed);
        countingRows.push({ ...base, remainingMs, timeText: formatMs(remainingMs), soon: remainingMs <= SOON_THRESHOLD_MS });
      } else if (ch.state === 'appearing') {
        appearingRows.push({ ...base, timeText: appearingText(maxMs, elapsed), overdue: elapsed >= maxMs });
      }
    });
  });

  // 倒數中：最接近變成出現中的排最上面；出現中：最早變成出現中的排最上面
  countingRows.sort((a, b) => a.remainingMs - b.remainingMs);
  appearingRows.sort((a, b) => a.spawnAt - b.spawnAt);

  const emptyC = showAll ? '目前沒有倒數中的 CH' : '這隻王目前沒有倒數中的 CH';
  const emptyA = showAll ? '目前沒有出現中的 CH' : '這隻王目前沒有出現中的 CH';
  renderStatusColumn(statusListCountingEl, countingRows, emptyC, showAll);
  renderStatusColumn(statusListAppearingEl, appearingRows, emptyA, showAll);
  if (pipStatusCountingEl) renderStatusColumn(pipStatusCountingEl, countingRows, emptyC, showAll);
  if (pipStatusAppearingEl) renderStatusColumn(pipStatusAppearingEl, appearingRows, emptyA, showAll);
}

function renderStatusColumn(container, rows, emptyText, showTabName) {
  const doc = container.ownerDocument;
  container.innerHTML = '';
  if (rows.length === 0) {
    const empty = doc.createElement('div');
    empty.className = 'status-empty';
    empty.textContent = emptyText;
    container.appendChild(empty);
    return;
  }

  rows.forEach((r) => {
    const row = doc.createElement('div');
    row.className = 'status-row' + (r.soon ? ' soon' : '');

    // 王的小圖示（「本王」只顯示圖示，「總頻道」顯示圖示 + 王名）
    if (r.tabImage) {
      const thumb = doc.createElement('img');
      thumb.className = 'status-thumb';
      thumb.src = new URL(`images/${r.tabImage}`, window.location.href).href;
      thumb.alt = r.tabName;
      thumb.title = r.tabName;
      row.appendChild(thumb);
    }

    if (showTabName) {
      const tag = doc.createElement('span');
      tag.className = 'status-tag';
      tag.textContent = r.tabName;
      row.appendChild(tag);
    }

    const chSpan = doc.createElement('span');
    chSpan.className = 'status-ch';
    chSpan.textContent = `ch. ${r.channelIndex + 1}`;
    row.appendChild(chSpan);

    const whoSpan = doc.createElement('span');
    whoSpan.className = 'status-who';
    whoSpan.textContent = `👤${r.who}`;
    row.appendChild(whoSpan);

    if (r.soon) {
      const soonTag = doc.createElement('span');
      soonTag.className = 'status-soon-tag';
      soonTag.textContent = '⚠即將出現';
      row.appendChild(soonTag);
    }

    const spawnSpan = doc.createElement('span');
    spawnSpan.className = 'status-spawn';
    spawnSpan.title = '出生時間（最小值倒數結束的時刻）';
    spawnSpan.textContent = `🕒${formatClock(r.spawnAt)}`;
    row.appendChild(spawnSpan);

    const timeSpan = doc.createElement('span');
    timeSpan.className = 'status-time' + (r.overdue ? ' overdue' : '');
    timeSpan.textContent = r.timeText;
    row.appendChild(timeSpan);

    const killBtn = doc.createElement('button');
    killBtn.className = 'kill-btn';
    killBtn.textContent = '擊殺';
    killBtn.title = '回報剛剛擊殺，重新開始倒數';
    killBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!ensureNickname()) return;
      socket.emit('channelKillNow', { tabId: r.tabId, channelIndex: r.channelIndex });
    });
    row.appendChild(killBtn);

    row.addEventListener('click', () => {
      currentTabId = r.tabId;
      refreshAfterTabSwitch();
      renderStatusPanel();
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

// 右鍵視窗裡的「改輸入重生時間」：給沒有滑鼠中鍵（例如筆電觸控板）的人用
document.getElementById('modalToSpawnBtn').addEventListener('click', () => {
  if (!modalContext) return;
  const tab = tabs.find((t) => t.id === modalContext.tabId);
  const idx = modalContext.channelIndex;
  closeModal();
  if (tab) openSpawnModal(tab, idx);
});

// ---------- Modal (中鍵：輸入重生時間，絕對時刻：月/日 時:分，預設為現在) ----------
const spawnOverlay = document.getElementById('spawnOverlay');
const spawnTitle = document.getElementById('spawnTitle');
const spawnMonth = document.getElementById('spawnMonth');
const spawnDay = document.getElementById('spawnDay');
const spawnHour = document.getElementById('spawnHour');
const spawnMinute = document.getElementById('spawnMinute');
const spawnPreview = document.getElementById('spawnPreview');
let spawnContext = null; // { tabId, channelIndex }

function openSpawnModal(tab, channelIndex) {
  spawnContext = { tabId: tab.id, channelIndex };
  spawnTitle.textContent = `輸入「${tab.name}」CH${channelIndex + 1} 重生時間`;
  const now = new Date(Date.now() + clockOffset);
  spawnMonth.value = now.getMonth() + 1;
  spawnDay.value = now.getDate();
  spawnHour.value = now.getHours();
  spawnMinute.value = now.getMinutes();
  updateSpawnPreview();
  spawnOverlay.classList.remove('hidden');
  setTimeout(() => { spawnHour.focus(); spawnHour.select(); }, 50);
}

function closeSpawnModal() {
  spawnOverlay.classList.add('hidden');
  spawnContext = null;
}

// 依輸入的 月/日 時:分 算出絕對時間（瀏覽器本地時區）；年份用今年，跨年時自動調整
function readSpawnDate() {
  const mo = Number(spawnMonth.value);
  const d = Number(spawnDay.value);
  const hh = Number(spawnHour.value);
  const mm = Number(spawnMinute.value);
  if (![mo, d, hh, mm].every(Number.isInteger)) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  const now = new Date(Date.now() + clockOffset);
  let date = new Date(now.getFullYear(), mo - 1, d, hh, mm, 0, 0);
  if (date.getMonth() !== mo - 1) return null; // 例如 2/30 這種不存在的日期
  const HALF_YEAR = 182 * 24 * 60 * 60 * 1000;
  if (date.getTime() - now.getTime() > HALF_YEAR) date.setFullYear(date.getFullYear() - 1);
  else if (now.getTime() - date.getTime() > HALF_YEAR) date.setFullYear(date.getFullYear() + 1);
  return date;
}

function updateSpawnPreview() {
  const date = readSpawnDate();
  if (!date) {
    spawnPreview.textContent = '請輸入正確的日期與時間';
    return;
  }
  const diff = date.getTime() - (Date.now() + clockOffset);
  spawnPreview.textContent = diff >= 0
    ? `距離重生還有 ${formatMs(diff)}，儲存後此 CH 會倒數到這個時刻變成「出現中」。`
    : `這個時間已經過了 ${formatMs(-diff)}，儲存後此 CH 會直接變成「出現中」。`;
}

[spawnMonth, spawnDay, spawnHour, spawnMinute].forEach((el) => {
  el.addEventListener('input', updateSpawnPreview);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('spawnSaveBtn').click();
    if (e.key === 'Escape') closeSpawnModal();
  });
});

document.getElementById('spawnCancelBtn').addEventListener('click', closeSpawnModal);
spawnOverlay.addEventListener('click', (e) => {
  if (e.target === spawnOverlay) closeSpawnModal();
});

document.getElementById('spawnSaveBtn').addEventListener('click', () => {
  if (!spawnContext) return;
  const date = readSpawnDate();
  if (!date) {
    alert('請輸入正確的日期與時間（月 1~12、日 1~31、時 0~23、分 0~59）');
    return;
  }
  socket.emit('channelSetSpawn', {
    tabId: spawnContext.tabId,
    channelIndex: spawnContext.channelIndex,
    spawnTimeEpoch: date.getTime(),
    spawnTimeLabel: `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  });
  closeSpawnModal();
});

// ---------- 子母畫面（Picture-in-Picture，浮動在螢幕最上層的小視窗） ----------
const pipBtn = document.getElementById('pipBtn');
let pipWindow = null;
let pipDoc = null;
let pipTabsListEl = null;
let pipGridEl = null;
let pipStatusCountingEl = null;
let pipStatusAppearingEl = null;

pipBtn.addEventListener('click', openPip);

async function openPip() {
  if (!('documentPictureInPicture' in window)) {
    alert('您的瀏覽器不支援子母畫面功能，請用電腦版 Chrome 或 Edge 開啟這個網站再試一次。');
    return;
  }
  if (pipWindow) {
    pipWindow.focus();
    return;
  }

  // 子母畫面預設尺寸：以原本的預設大小為基準，寬 x1.2、高 x1.4
  const rightRect = document.querySelector('.main-right').getBoundingClientRect();
  const aspect = rightRect.width / Math.max(1, rightRect.height);
  const baseHeight = Math.min(720, Math.max(380, Math.round((window.screen.height || 900) * 0.6)));
  const baseWidth = Math.max(260, Math.round(baseHeight * aspect));
  // 寬度：原本的 1.3 倍，且至少 460px，確保最上排能一次放下 10 隻王的圖示
  const targetWidth = Math.min(Math.max(Math.round(baseWidth * 1.3), 460), (window.screen.availWidth || 1600) - 40);
  const targetHeight = Math.min(Math.round(baseHeight * 1.4), (window.screen.availHeight || 900) - 40);

  try {
    pipWindow = await documentPictureInPicture.requestWindow({
      width: targetWidth,
      height: targetHeight
    });
  } catch (err) {
    alert('無法開啟子母畫面：' + err.message);
    pipWindow = null;
    return;
  }

  pipDoc = pipWindow.document;
  pipDoc.title = '巡王計時器';

  // 套用跟主頁一樣的樣式表
  const link = pipDoc.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('style.css', window.location.href).href;
  pipDoc.head.appendChild(link);

  if (document.body.classList.contains('is-admin')) {
    pipDoc.body.classList.add('is-admin');
  }
  pipDoc.body.classList.add('pip-body');

  pipDoc.body.innerHTML = `
    <div class="pip-root">
      <div class="tabs-row" id="pipTabsRow">
        <div class="tabs-list" id="pipTabsList"></div>
      </div>
      <div class="grid-wrapper">
        <div class="grid" id="pipGrid"></div>
      </div>
      <div class="panel active-panel" id="pipActivePanel">
        <div class="panel-title-row">
          <div class="panel-title">📋 進行中頻道</div>
          <div class="view-toggle"><button data-view="boss">本王</button><button data-view="all">總頻道</button></div>
        </div>
        <div class="active-columns">
          <div class="active-sub-panel">
            <div class="sub-panel-title">⏳ 倒數中</div>
            <div id="pipStatusCounting" class="status-list scrollable"></div>
          </div>
          <div class="active-sub-panel">
            <div class="sub-panel-title">🌟 出現中</div>
            <div id="pipStatusAppearing" class="status-list scrollable"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  pipTabsListEl = pipDoc.getElementById('pipTabsList');
  pipGridEl = pipDoc.getElementById('pipGrid');
  pipStatusCountingEl = pipDoc.getElementById('pipStatusCounting');
  pipStatusAppearingEl = pipDoc.getElementById('pipStatusAppearing');
  bindViewToggle(pipDoc);

  pipWindow.addEventListener('pagehide', () => {
    pipWindow = null;
    pipDoc = null;
    pipTabsListEl = null;
    pipGridEl = null;
    pipStatusCountingEl = null;
    pipStatusAppearingEl = null;
  });

  // 立刻把目前的資料畫進子母畫面
  refreshAfterTabSwitch();
  renderStatusPanel();
}

// ---------- 本王 / 總頻道 切換鈕（主畫面與子母畫面共用同一個狀態） ----------
function bindViewToggle(root) {
  root.querySelectorAll('.view-toggle button').forEach((b) => {
    b.addEventListener('click', () => {
      activeView = b.dataset.view;
      syncViewToggles();
      renderStatusPanel();
    });
  });
  syncViewToggles();
}

function syncViewToggles() {
  [document, pipDoc].forEach((d) => {
    if (!d) return;
    d.querySelectorAll('.view-toggle button').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === activeView);
    });
  });
}

bindViewToggle(document);

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
