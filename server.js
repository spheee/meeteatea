const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer, WebSocket } = require('ws');
const MENUS = require('./menus');

// 反向代理挂载的子路径，比如 nginx 把 /order 转发进来，这里就要保持一致。
// 可以用环境变量覆盖：BASE_PATH=/order node server.js
const BASE_PATH = ('/' + (process.env.BASE_PATH || '/order').replace(/^\/|\/$/g, ''));

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: `${BASE_PATH}/ws` });

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

app.use(express.json());
app.use(BASE_PATH, express.static(path.join(__dirname, 'public')));

// 给每个菜单的每道菜分配稳定 id（服务端生成一次，客户端始终从接口读取，保证双方一致）
function withIds(menu) {
  let uid = 0;
  return {
    id: menu.id,
    name: menu.name,
    categories: menu.categories.map(cat => ({
      cat: cat.cat,
      items: cat.items.map(it => ({ ...it, id: 'i' + (uid++) }))
    }))
  };
}
const MENU_REGISTRY = MENUS.map(withIds); // [{id, name, categories}]
const DEFAULT_MENU_ID = MENU_REGISTRY[0].id;

function buildPriceMap(menu) {
  const map = {};
  menu.categories.forEach(cat => cat.items.forEach(it => {
    if (it.opts) {
      it.opts.forEach(([label, price], idx) => {
        map[`${it.id}__${idx}`] = { price, name: `${it.n}(${label})` };
      });
    } else {
      map[it.id] = { price: it.p, name: it.n };
    }
  }));
  return map;
}
const PRICE_MAPS = {}; // menuId -> priceMap
MENU_REGISTRY.forEach(m => { PRICE_MAPS[m.id] = buildPriceMap(m); });

function getMenu(menuId) {
  return MENU_REGISTRY.find(m => m.id === menuId) || null;
}

function roomFile(roomId) {
  return path.join(DATA_DIR, `${roomId.toUpperCase()}.json`);
}
function roomExists(roomId) {
  return /^[A-Z0-9]{4,8}$/i.test(roomId) && fs.existsSync(roomFile(roomId));
}
function loadRoom(roomId) {
  const file = roomFile(roomId);
  if (!fs.existsSync(file)) {
    const fresh = { cart: {}, menuId: DEFAULT_MENU_ID, createdAt: Date.now() };
    saveRoom(roomId, fresh);
    return fresh;
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!data.menuId || !getMenu(data.menuId)) data.menuId = DEFAULT_MENU_ID;
    return data;
  } catch (e) {
    return { cart: {}, menuId: DEFAULT_MENU_ID, createdAt: Date.now() };
  }
}
function saveRoom(roomId, data) {
  fs.writeFileSync(roomFile(roomId), JSON.stringify(data, null, 2));
}
function genRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do {
    id = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (fs.existsSync(roomFile(id)));
  return id;
}

// ---- 菜单相关接口 ----
app.get(`${BASE_PATH}/api/menus`, (req, res) => {
  res.json(MENU_REGISTRY.map(m => ({ id: m.id, name: m.name, itemCount: m.categories.reduce((s, c) => s + c.items.length, 0) })));
});

app.get(`${BASE_PATH}/api/menu/:menuId`, (req, res) => {
  const menu = getMenu(req.params.menuId);
  if (!menu) return res.status(404).json({ error: '菜单不存在' });
  res.json(menu);
});

// ---- 房间相关接口 ----
app.post(`${BASE_PATH}/api/room`, (req, res) => {
  const menuId = (req.body && req.body.menuId) || DEFAULT_MENU_ID;
  const menu = getMenu(menuId) ? menuId : DEFAULT_MENU_ID;
  const roomId = genRoomId();
  saveRoom(roomId, { cart: {}, menuId: menu, createdAt: Date.now() });
  res.json({ roomId, menuId: menu });
});

app.get(`${BASE_PATH}/api/room/:roomId`, (req, res) => {
  const exists = roomExists(req.params.roomId);
  if (!exists) return res.json({ exists: false });
  const state = loadRoom(req.params.roomId);
  const menu = getMenu(state.menuId);
  res.json({ exists: true, menuId: state.menuId, menuName: menu ? menu.name : '' });
});

// 点菜页面本身。注意：这条路由要放在 express.static 之后，
// 这样像 /order/order.js、/order/index.html 这些真实存在的静态文件会被 static 中间件优先处理，
// 不会被这里的 :roomId 通配吃掉。
app.get(`${BASE_PATH}/:roomId`, (req, res) => {
  if (!roomExists(req.params.roomId)) {
    return res.status(404).sendFile(path.join(__dirname, 'public', 'notfound.html'));
  }
  res.sendFile(path.join(__dirname, 'public', 'order.html'));
});

// ---- WebSocket 实时同步 ----
const rooms = {}; // roomId -> Set<ws>

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomIdRaw = url.searchParams.get('room') || '';
  const roomId = roomIdRaw.toUpperCase();
  const name = decodeURIComponent(url.searchParams.get('name') || '匿名').slice(0, 12) || '匿名';

  if (!roomExists(roomId)) {
    ws.send(JSON.stringify({ type: 'error', message: '房间不存在' }));
    ws.close();
    return;
  }

  ws.roomId = roomId;
  ws.userName = name;
  if (!rooms[roomId]) rooms[roomId] = new Set();
  rooms[roomId].add(ws);

  const state = loadRoom(roomId);
  ws.send(JSON.stringify({ type: 'state', cart: state.cart, menuId: state.menuId }));
  broadcastPresence(roomId);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (msg.type === 'update' && typeof msg.itemKey === 'string' && (msg.delta === 1 || msg.delta === -1)) {
      handleUpdate(roomId, ws.userName, msg.itemKey, msg.delta);
    } else if (msg.type === 'clear_mine') {
      handleClearUser(roomId, ws.userName);
    } else if (msg.type === 'clear_all') {
      handleClearAll(roomId);
    }
  });

  ws.on('close', () => {
    rooms[roomId] && rooms[roomId].delete(ws);
    broadcastPresence(roomId);
  });
});

function handleUpdate(roomId, userName, itemKey, delta) {
  const state = loadRoom(roomId);
  const priceMap = PRICE_MAPS[state.menuId] || PRICE_MAPS[DEFAULT_MENU_ID];
  const meta = priceMap[itemKey];
  if (!meta) return;
  if (!state.cart[itemKey]) {
    state.cart[itemKey] = { name: meta.name, price: meta.price, users: {} };
  }
  const entry = state.cart[itemKey];
  const cur = entry.users[userName] || 0;
  const next = Math.max(0, cur + delta);
  if (next === 0) delete entry.users[userName];
  else entry.users[userName] = next;
  if (Object.keys(entry.users).length === 0) delete state.cart[itemKey];
  saveRoom(roomId, state);
  broadcastState(roomId, state);
}

function handleClearUser(roomId, userName) {
  const state = loadRoom(roomId);
  Object.keys(state.cart).forEach(key => {
    if (state.cart[key].users[userName]) {
      delete state.cart[key].users[userName];
      if (Object.keys(state.cart[key].users).length === 0) delete state.cart[key];
    }
  });
  saveRoom(roomId, state);
  broadcastState(roomId, state);
}

function handleClearAll(roomId) {
  const prev = loadRoom(roomId);
  const state = { cart: {}, menuId: prev.menuId, createdAt: Date.now() };
  saveRoom(roomId, state);
  broadcastState(roomId, state);
}

function broadcastState(roomId, state) {
  const payload = JSON.stringify({ type: 'state', cart: state.cart, menuId: state.menuId });
  (rooms[roomId] || []).forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
}

function broadcastPresence(roomId) {
  const names = Array.from(rooms[roomId] || []).map(c => c.userName);
  const payload = JSON.stringify({ type: 'presence', names });
  (rooms[roomId] || []).forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`点菜系统运行在 http://localhost:${PORT}${BASE_PATH}/  (BASE_PATH=${BASE_PATH})`));
