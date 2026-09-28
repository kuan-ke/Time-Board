const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const CHANNEL_COUNT = 60;

// 管理者密鑰：用來讓網站擁有者強制修改別人的暱稱。
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

function createTab(name, minMinutes, maxMinutes, image) {
  const id = nextTabId++;
  return {
    id,
    name: (name && name.trim()) || `分頁 ${id}`,
    minMinutes: minMinutes || 45,
    maxMinutes: maxMinutes || 60,
    image: image || null,
    channels: Array.from({ length: CHANNEL_COUNT }, createChannel)
  };
}

// 啟動時建立 9 個預設王的分頁
let tabs = BOSS_PRESETS.map((b) => createTab(b.name, b.min, b.max, b.image));

// 目前連線中的使用者：socket.id -> nickname
const connectedUsers = new Map();

function findTab(tabId) {
  return tabs.find((t) => t.id === tabId);
}

function broadcastState() {
  io.emit('state:update', { tabs, serverTime: Date.now() });
}

function broadcastUsers() {
  const list = Array.from(connectedUsers.entries()).map(([id, name]) => ({ id, name }));
  io.emit('users:update', list);
}

// 每秒檢查所有 CH 是否跨過 min / max 門檻
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
  // 新連線的人先拿到完整現況
  socket.emit('state:init', { tabs, serverTime: Date.now() });
  socket.emit('adminConfig', { requiresKeyToUnlock: true });

  // ---------- 暱稱 ----------
  socket.on('setNickname', (name) => {
    const trimmed = (name || '').trim().slice(0, 20);
    if (!trimmed) return;
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

    targetSocket.data.nickname = trimmed;
    connectedUsers.set(targetSocketId, trimmed);
    targetSocket.emit('forceNickname', trimmed);
    broadcastUsers();
  });

  // ---------- 分頁 ----------
  socket.on('addTab', (name) => {
    tabs.push(createTab(name, 45, 60, null));
    broadcastState();
  });

  socket.on('removeTab', (tabId) => {
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
    if (!tab) return;
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
    } else {
      ch.state = 'idle';
      ch.startTime = null;
      ch.startedBy = null;
    }
    broadcastState();
  });

  // ---------- CH 右鍵：設定自訂 min/max。若目前是 idle，設定完會直接開始倒數 ----------
  socket.on('channelSetCustom', ({ tabId, channelIndex, customMin, customMax }) => {
    const nickname = socket.data.nickname;
    if (!nickname) {
      socket.emit('error:needNickname');
      return;
    }
    const tab = findTab(tabId);
    if (!tab) return;
    const ch = tab.channels[channelIndex];
    if (!ch) return;

    ch.customMin = (customMin === null || customMin === '') ? null : Number(customMin);
    ch.customMax = (customMax === null || customMax === '') ? null : Number(customMax);

    if (ch.state === 'idle') {
      ch.state = 'counting';
      ch.startTime = Date.now();
      ch.startedBy = nickname;
    }
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
