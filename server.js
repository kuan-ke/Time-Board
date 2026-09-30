const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const CHANNEL_COUNT = 60;
const MAX_LOG = 500; // 操作紀錄最多保留筆數（避免伺服器記憶體無限成長）

// 管理者密鑰：用來讓網站擁有者強制修改 / 隱藏 / 移除別人。
// 建議在 Render 的環境變數設定 ADMIN_KEY，不要用預設值。
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me-admin-key';

app.use(express.static(path.join(__dirname, 'public')));

let nextTabId = 1;

// 預設 9 個分頁（王名 / 最小值 / 最大值 / 圖片檔名）
const BOSS_PRESETS = [
  { name: '紅寶王',     min: 45,  max: 45,  image: 'red-king.png' },
  { name: '樹妖王',     min: 45,  max: 45,  image: 'tree-demon-king.png' },
  { name: '巨居蟹',     min: 45,  max: 45,  image: 'giant-crab.png' },
  { name: '殭屍猴王',   min: 45,  max: 45,  image: 'zombie-monkey-king.png' },
  { name: '蘑菇王',     min: 45,  max: 60,  image: 'mushroom-king.png' },
  { name: '殭屍蘑菇王', min: 45,  max: 60,  image: 'zombie-mushroom-king.png' },
  { name: '沼澤巨鱷',   min: 45,  max: 45,  image: 'swamp-crocodile.png' },
  { name: '巴洛古',     min: 240, max: 360, image: 'barogu.png' },
  { name: '雪毛怪人',   min: 45,  max: 60,  image: 'snow-fur-monster.png' }
];

function createChannel() {
  return {
    state: 'idle',      // idle | counting | appearing
    startTime: null,    // server epoch ms
    customMin: null,    // null = 使用分頁預設值
    customMax: null,
    startedBy: null      // 是誰觸發這次倒數的暱稱
  };
}

function createTab(name, minMinutes, maxMinutes, image, locked) {
  const id = nextTabId++;
  return {
    id,
    name: (name && name.trim()) || `分頁 ${id}`,
    minMinutes: minMinutes || 45,
    maxMinutes: maxMinutes || 60,
    image: image || null,
    locked: !!locked, // 鎖定的分頁：無法刪除、無法修改最小值/最大值
    channels: Array.from({ length: CHANNEL_COUNT }, createChannel)
  };
}

// 啟動時建立 9 個預設王的分頁（固定鎖定，不可刪除、不可改時間範圍）
let tabs = BOSS_PRESETS.map((b) => createTab(b.name, b.min, b.max, b.image, true));

// 目前連線中的使用者：socket.id -> nickname
const connectedUsers = new Map();
// 已被管理者移除、不可再使用的暱稱（小寫比對）
const bannedNicknames = new Set();
// 永久操作紀錄（伺服器記憶體內，重啟會清空；最多保留 MAX_LOG 筆）
let activityLog = [];

function normalizeName(name) {
  return (name || '').trim().toLowerCase();
}

function findTab(tabId) {
  return tabs.find((t) => t.id === tabId);
}

function isNicknameTaken(name, excludeSocketId) {
  const norm = normalizeName(name);
  for (const [id, n] of connectedUsers.entries()) {
    if (id !== excludeSocketId && normalizeName(n) === norm) return true;
  }
  return false;
}

function broadcastState() {
  io.emit('state:update', { tabs, serverTime: Date.now() });
}

function broadcastUsers() {
  const list = Array.from(connectedUsers.entries()).map(([id, name]) => ({ id, name }));
  io.emit('users:update', list);
}

function addLog(message, type) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    time: Date.now(),
    message,
    type: type || 'user'
  };
  activityLog.unshift(entry);
  if (activityLog.length > MAX_LOG) activityLog.length = MAX_LOG;
  io.emit('log:new', entry);
}

// 每秒檢查所有 CH 是否跨過 min / max 門檻（自動觸發，不寫入操作紀錄）
function tick() {
  const now = Date.now();
  let changed = false;

  for (const tab of tabs) {
    tab.channels.forEach((ch, idx) => {
      if (ch.state === 'idle' || ch.startTime === null) return;

      const minMs = (ch.customMin ?? tab.minMinutes) * 60000;
      const maxMs = (ch.customMax ?? tab.maxMinutes) * 60000;
      const elapsed = now - ch.startTime;

      if (elapsed >= maxMs) {
        ch.state = 'idle';
        ch.startTime = null;
        ch.startedBy = null;
        changed = true;
      } else if (elapsed >= minMs && ch.state !== 'appearing') {
        ch.state = 'appearing';
        changed = true;
        io.emit('channelAlert', { tabId: tab.id, channelIndex: idx });
      }
    });
  }

  if (changed) broadcastState();
}

setInterval(tick, 1000);

io.on('connection', (socket) => {
  // 新連線的人先拿到完整現況 + 操作紀錄
  socket.emit('state:init', { tabs, serverTime: Date.now() });
  socket.emit('log:init', activityLog);

  // ---------- 暱稱 ----------
  socket.on('setNickname', (name) => {
    const trimmed = (name || '').trim().slice(0, 20);
    if (!trimmed) return;

    if (bannedNicknames.has(normalizeName(trimmed))) {
      socket.emit('nickname:banned');
      return;
    }
    if (isNicknameTaken(trimmed, socket.id)) {
      socket.emit('nickname:taken');
      return;
    }

    socket.data.nickname = trimmed;
    connectedUsers.set(socket.id, trimmed);
    socket.emit('nickname:ack', trimmed);
    broadcastUsers();
  });

  // ---------- 管理者驗證 ----------
  socket.on('adminAuth', (key) => {
    const ok = typeof key === 'string' && key === ADMIN_KEY;
    socket.data.isAdmin = ok;
    socket.emit('adminAuth:result', ok);
  });

  // 管理者強制修改「目前仍連線中」某個使用者的暱稱
  socket.on('adminRenameUser', ({ targetSocketId, newName }) => {
    if (!socket.data.isAdmin) return;
    const trimmed = (newName || '').trim().slice(0, 20);
    if (!trimmed) return;
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (!targetSocket) return;

    const oldName = targetSocket.data.nickname;
    targetSocket.data.nickname = trimmed;
    connectedUsers.set(targetSocketId, trimmed);
    targetSocket.emit('forceNickname', trimmed);
    broadcastUsers();
    addLog(`管理者將「${oldName}」的暱稱改為「${trimmed}」`, 'admin');
  });

  // 管理者隱藏（清除）某位使用者目前所有進行中的計時器
  socket.on('adminHideUserTimers', ({ nickname }) => {
    if (!socket.data.isAdmin) return;
    if (!nickname) return;
    let changed = false;
    tabs.forEach((tab) => {
      tab.channels.forEach((ch) => {
        if (ch.startedBy === nickname && ch.state !== 'idle') {
          ch.state = 'idle';
          ch.startTime = null;
          ch.startedBy = null;
          changed = true;
        }
      });
    });
    if (changed) {
      broadcastState();
      addLog(`管理者隱藏了「${nickname}」目前所有進行中的計時器`, 'admin');
    }
  });

  // 管理者移除成員：中斷連線 + 禁用該暱稱
  socket.on('adminRemoveUser', ({ targetSocketId, nickname }) => {
    if (!socket.data.isAdmin) return;
    if (!nickname) return;

    bannedNicknames.add(normalizeName(nickname));
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      targetSocket.emit('removedByAdmin');
      targetSocket.disconnect(true);
    }
    connectedUsers.delete(targetSocketId);
    broadcastUsers();
    addLog(`管理者將「${nickname}」移除出網站`, 'admin');
  });

  // 管理者刪除單筆操作紀錄
  socket.on('adminDeleteLogEntry', (logId) => {
    if (!socket.data.isAdmin) return;
    const idx = activityLog.findIndex((e) => e.id === logId);
    if (idx !== -1) {
      activityLog.splice(idx, 1);
      io.emit('log:remove', logId);
    }
  });

  // 管理者清空全部操作紀錄
  socket.on('adminClearLog', () => {
    if (!socket.data.isAdmin) return;
    activityLog = [];
    io.emit('log:clear');
    addLog('管理者清空了所有操作紀錄', 'admin');
  });

  // ---------- 分頁 ----------
  socket.on('addTab', (name) => {
    tabs.push(createTab(name, 45, 60, null, false));
    broadcastState();
  });

  socket.on('removeTab', (tabId) => {
    const tab = findTab(tabId);
    if (!tab || tab.locked) return; // 鎖定的分頁不可刪除
    if (tabs.length <= 1) return;
    tabs = tabs.filter((t) => t.id !== tabId);
    broadcastState();
  });

  socket.on('renameTab', ({ tabId, name }) => {
    const tab = findTab(tabId);
    if (tab && name && name.trim()) {
      tab.name = name.trim();
      broadcastState();
    }
  });

  socket.on('updateTabRange', ({ tabId, minMinutes, maxMinutes }) => {
    const tab = findTab(tabId);
    if (!tab || tab.locked) return; // 鎖定的分頁不可修改最小值/最大值
    const min = Number(minMinutes);
    const max = Number(maxMinutes);
    if (Number.isFinite(min) && min > 0) tab.minMinutes = min;
    if (Number.isFinite(max) && max > 0) tab.maxMinutes = max;
    if (tab.maxMinutes < tab.minMinutes) tab.maxMinutes = tab.minMinutes;
    broadcastState();
  });

  // ---------- CH 左鍵：idle -> 開始計時；計時中再點 -> 手動提前重置 ----------
  socket.on('channelClick', ({ tabId, channelIndex }) => {
    const nickname = socket.data.nickname;
    if (!nickname) {
      socket.emit('error:needNickname');
      return;
    }
    const tab = findTab(tabId);
    if (!tab) return;
    const ch = tab.channels[channelIndex];
    if (!ch) return;

    if (ch.state === 'idle') {
      ch.state = 'counting';
      ch.startTime = Date.now();
      ch.startedBy = nickname;
      addLog(`${nickname} 在「${tab.name}」啟動了 CH${channelIndex + 1} 倒數`, 'start');
    } else {
      ch.state = 'idle';
      ch.startTime = null;
      ch.startedBy = null;
      addLog(`${nickname} 手動停止了「${tab.name}」CH${channelIndex + 1} 的倒數`, 'stop');
    }
    broadcastState();
  });

  // ---------- CH 右鍵：輸入王的「死亡時間」（例如 23:50），從那個過去的時刻開始倒數 ----------
  // deathTime 為 "HH:MM" 字串；傳 null 代表清除、恢復待機
  socket.on('channelSetCustom', ({ tabId, channelIndex, deathTime }) => {
    const nickname = socket.data.nickname;
    if (!nickname) {
      socket.emit('error:needNickname');
      return;
    }
    const tab = findTab(tabId);
    if (!tab) return;
    const ch = tab.channels[channelIndex];
    if (!ch) return;

    if (deathTime === null || deathTime === '') {
      const wasActive = ch.state !== 'idle';
      ch.state = 'idle';
      ch.startTime = null;
      ch.customMin = null;
      ch.customMax = null;
      ch.startedBy = null;
      if (wasActive) {
        addLog(`${nickname} 透過右鍵重設了「${tab.name}」CH${channelIndex + 1}（恢復待機）`, 'stop');
        broadcastState();
      }
      return;
    }

    const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(deathTime).trim());
    if (!match) return;
    const hh = Number(match[1]);
    const mm = Number(match[2]);

    const now = new Date();
    const death = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
    if (death.getTime() > now.getTime()) {
      death.setDate(death.getDate() - 1); // 該時刻還沒到 -> 視為昨天（死亡時間一定是過去式）
    }

    // 死亡時間直接當作起算點，之後照分頁的最小值/最大值自動計算提醒與重置
    ch.customMin = null;
    ch.customMax = null;
    ch.state = 'counting';
    ch.startTime = death.getTime();
    ch.startedBy = nickname;

    const timeLabel = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    addLog(`${nickname} 回報「${tab.name}」CH${channelIndex + 1} 的死亡時間為 ${timeLabel}，開始倒數`, 'start');
    broadcastState();
  });

  socket.on('disconnect', () => {
    connectedUsers.delete(socket.id);
    broadcastUsers();
  });
});

server.listen(PORT, () => {
  console.log(`伺服器已啟動：http://localhost:${PORT}`);
});
