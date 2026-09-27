const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const CHANNEL_COUNT = 60;
const DEFAULT_MIN = 45;
const DEFAULT_MAX = 60;

app.use(express.static(path.join(__dirname, 'public')));

let nextTabId = 1;

function createChannel() {
  return {
    state: 'idle',      // idle | counting | appearing
    startTime: null,    // server epoch ms when left-click started
    customMin: null,    // null = 使用分頁預設值
    customMax: null
  };
}

function createTab(name) {
  const id = nextTabId++;
  return {
    id,
    name: (name && name.trim()) || `分頁 ${id}`,
    minMinutes: DEFAULT_MIN,
    maxMinutes: DEFAULT_MAX,
    channels: Array.from({ length: CHANNEL_COUNT }, createChannel)
  };
}

// 預設 1 個分頁
let tabs = [createTab('分頁 1')];

function findTab(tabId) {
  return tabs.find((t) => t.id === tabId);
}

function broadcastState() {
  io.emit('state:update', { tabs, serverTime: Date.now() });
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
        ch.attentionSent = false;
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

  socket.on('addTab', (name) => {
    tabs.push(createTab(name));
    broadcastState();
  });

  socket.on('removeTab', (tabId) => {
    if (tabs.length <= 1) return; // 至少保留一個分頁
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

  // 左鍵點擊：idle -> 開始計時；計時中再點 -> 手動提前重置
  socket.on('channelClick', ({ tabId, channelIndex }) => {
    const tab = findTab(tabId);
    if (!tab) return;
    const ch = tab.channels[channelIndex];
    if (!ch) return;

    if (ch.state === 'idle') {
      ch.state = 'counting';
      ch.startTime = Date.now();
    } else {
      ch.state = 'idle';
      ch.startTime = null;
    }
    broadcastState();
  });

  // 右鍵設定：針對單一 CH 的自訂 min/max（null 代表還原為分頁預設）
  socket.on('channelSetCustom', ({ tabId, channelIndex, customMin, customMax }) => {
    const tab = findTab(tabId);
    if (!tab) return;
    const ch = tab.channels[channelIndex];
    if (!ch) return;

    ch.customMin = (customMin === null || customMin === '') ? null : Number(customMin);
    ch.customMax = (customMax === null || customMax === '') ? null : Number(customMax);
    broadcastState();
  });
});

server.listen(PORT, () => {
  console.log(`伺服器已啟動：http://localhost:${PORT}`);
});
