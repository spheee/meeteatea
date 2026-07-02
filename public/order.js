(function () {
  // 当前 URL 形如 {BASE}/AB3K，BASE 是反代挂载的前缀（比如 /order），最后一段是房间码。
  // 这样不用在代码里写死前缀，部署路径变了也不用改这个文件。
  const lastSlash = location.pathname.lastIndexOf('/');
  const BASE = location.pathname.substring(0, lastSlash);
  const roomId = location.pathname.substring(lastSlash + 1).toUpperCase();

  const nameKey = 'order_nickname_' + roomId;
  let myName = localStorage.getItem(nameKey) || '';
  let ws = null;
  let cart = {}; // itemKey -> { name, price, users:{name:qty} }
  let itemMeta = {}; // itemKey -> {n, p or opts, elements}
  let reconnectTimer = null;
  let menuName = '';

  document.getElementById('roomTag').textContent = '房间 ' + roomId;
  document.getElementById('roomTag').addEventListener('click', () => {
    copyText(location.href).then(() => {
      const tag = document.getElementById('roomTag');
      const old = tag.textContent;
      tag.textContent = '链接已复制';
      setTimeout(() => tag.textContent = old, 1200);
    });
  });

  function showNameModal() {
    const modal = document.getElementById('nameModal');
    modal.style.display = 'flex';
    const input = document.getElementById('nameInput');
    input.value = myName;
    input.focus();
    document.getElementById('nameConfirm').onclick = confirmName;
    input.addEventListener('keydown', e => { if (e.key === 'Enter') confirmName(); });
  }
  function confirmName() {
    const val = document.getElementById('nameInput').value.trim();
    if (!val) return;
    myName = val.slice(0, 12);
    localStorage.setItem(nameKey, myName);
    document.getElementById('nameModal').style.display = 'none';
    connect();
  }

  fetch(BASE + '/api/room/' + roomId).then(r => r.json()).then(roomInfo => {
    if (!roomInfo.exists) { location.href = BASE + '/'; return; }
    menuName = roomInfo.menuName || '';
    document.getElementById('menuTitle').textContent = menuName || '点菜中';
    return fetch(BASE + '/api/menu/' + roomInfo.menuId).then(r => r.json());
  }).then(menu => {
    if (!menu) return;
    renderMenu(menu.categories);
    if (myName) connect(); else showNameModal();
  });

  function renderMenu(menu) {
    const menuEl = document.getElementById('menu');
    menu.forEach(cat => {
      const details = document.createElement('details');
      details.className = 'category';
      details.open = true;
      const summary = document.createElement('summary');
      summary.innerHTML = `<span>${cat.cat}</span><span class="count">${cat.items.length} 道</span>`;
      details.appendChild(summary);

      cat.items.forEach(it => {
        const row = document.createElement('div');
        row.className = 'item';
        row.dataset.name = it.n;

        const main = document.createElement('div');
        main.className = 'item-main';
        const nameEl = document.createElement('div');
        nameEl.className = 'item-name';
        nameEl.textContent = it.n;
        main.appendChild(nameEl);
        const breakdownEl = document.createElement('div');
        breakdownEl.className = 'item-breakdown';
        main.appendChild(breakdownEl);
        row.appendChild(main);

        let selectEl = null;
        if (it.opts) {
          selectEl = document.createElement('select');
          it.opts.forEach((opt, idx) => {
            const o = document.createElement('option');
            o.value = idx;
            o.textContent = `${opt[0]} ¥${opt[1]}`;
            selectEl.appendChild(o);
          });
          row.appendChild(selectEl);
        } else {
          const priceEl = document.createElement('div');
          priceEl.className = 'item-price';
          priceEl.textContent = `¥${it.p}`;
          row.appendChild(priceEl);
        }

        const stepper = document.createElement('div');
        stepper.className = 'stepper';
        const minus = document.createElement('button');
        minus.textContent = '−';
        minus.type = 'button';
        const qtyEl = document.createElement('span');
        qtyEl.className = 'qty';
        qtyEl.textContent = '0';
        const plus = document.createElement('button');
        plus.textContent = '+';
        plus.type = 'button';
        stepper.appendChild(minus);
        stepper.appendChild(qtyEl);
        stepper.appendChild(plus);
        row.appendChild(stepper);

        function activeKey() {
          return it.opts ? `${it.id}__${selectEl.value}` : it.id;
        }
        minus.addEventListener('click', () => sendUpdate(activeKey(), -1));
        plus.addEventListener('click', () => sendUpdate(activeKey(), 1));
        if (selectEl) selectEl.addEventListener('change', () => refreshRow(it, selectEl, qtyEl, breakdownEl));

        itemMeta[it.opts ? it.id : it.id] = { it, selectEl, qtyEl, breakdownEl, row };
        if (it.opts) {
          it.opts.forEach((opt, idx) => {
            itemMeta[`${it.id}__${idx}`] = { it, selectEl, qtyEl, breakdownEl, row, isVariant: true };
          });
        }

        details.appendChild(row);
      });
      menuEl.appendChild(details);
    });
  }

  function refreshRow(it, selectEl, qtyEl, breakdownEl) {
    const key = it.opts ? `${it.id}__${selectEl.value}` : it.id;
    const entry = cart[key];
    const total = entry ? Object.values(entry.users).reduce((a, b) => a + b, 0) : 0;
    qtyEl.textContent = total;
    if (entry && total > 0) {
      breakdownEl.textContent = Object.entries(entry.users).map(([n, q]) => `${n}×${q}`).join('  ');
    } else {
      breakdownEl.textContent = '';
    }
  }

  function sendUpdate(itemKey, delta) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'update', itemKey, delta }));
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}${BASE}/ws?room=${roomId}&name=${encodeURIComponent(myName)}`);
    ws.onopen = () => setConn(true);
    ws.onclose = () => { setConn(false); scheduleReconnect(); };
    ws.onerror = () => setConn(false);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'state') {
        cart = msg.cart || {};
        renderAll();
      } else if (msg.type === 'presence') {
        document.getElementById('presenceList').textContent = msg.names.length ? msg.names.join('、') : '-';
      } else if (msg.type === 'error') {
        alert(msg.message);
      }
    };
  }
  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2000);
  }
  function setConn(ok) {
    const el = document.getElementById('connStatus');
    el.textContent = ok ? '已连接' : '重连中...';
    el.className = 'conn-status ' + (ok ? 'conn-ok' : 'conn-bad');
  }

  let lastTotal = 0, lastCount = 0, lastLines = [], lastPerUser = {};

  function renderAll() {
    // 更新每一行的数量与分摊显示
    const seen = new Set();
    Object.keys(itemMeta).forEach(key => {
      const meta = itemMeta[key];
      if (seen.has(meta.row)) return;
      refreshRow(meta.it, meta.selectEl, meta.qtyEl, meta.breakdownEl);
      seen.add(meta.row);
    });

    let total = 0, count = 0;
    const lines = [];
    const perUser = {};
    Object.values(cart).forEach(entry => {
      Object.entries(entry.users).forEach(([user, qty]) => {
        total += qty * entry.price;
        count += qty;
        perUser[user] = (perUser[user] || 0) + qty * entry.price;
      });
      lines.push(entry);
    });
    lastTotal = total; lastCount = count; lastLines = lines; lastPerUser = perUser;

    document.getElementById('totalValue').textContent = `¥${Math.round(total)}`;
    document.getElementById('totalCount').textContent = `共 ${count} 件`;

    const summary = document.getElementById('summary');
    if (lines.length === 0) {
      summary.innerHTML = '<div class="empty">还没有点菜，点下方 + 号开始点菜吧</div>';
    } else {
      summary.innerHTML = lines.map(l => {
        const qty = Object.values(l.users).reduce((a, b) => a + b, 0);
        return `<div class="summary-row"><span>${l.name} × ${qty}</span><span>¥${qty * l.price}</span></div>`;
      }).join('');
    }

    const peoplePanel = document.getElementById('peoplePanel');
    const peopleRows = document.getElementById('peopleRows');
    const peopleEntries = Object.entries(perUser);
    if (peopleEntries.length === 0) {
      peoplePanel.style.display = 'none';
    } else {
      peoplePanel.style.display = 'block';
      peopleRows.innerHTML = peopleEntries.map(([n, amt]) =>
        `<div class="people-row"><span>${n}</span><span>¥${Math.round(amt)}</span></div>`
      ).join('');
    }
  }

  document.getElementById('clearMineBtn').addEventListener('click', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (confirm('确定清空你加的所有菜吗？')) ws.send(JSON.stringify({ type: 'clear_mine' }));
  });

  document.getElementById('search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll('.item').forEach(row => {
      const name = row.dataset.name.toLowerCase();
      row.classList.toggle('hidden', q && !name.includes(q));
    });
    document.querySelectorAll('.category').forEach(cat => {
      const rows = cat.querySelectorAll('.item');
      const visible = Array.from(rows).some(r => !r.classList.contains('hidden'));
      cat.style.display = (q && !visible) ? 'none' : '';
      if (q) cat.open = true;
    });
  });

  // ---- 导出 / 复制清单 ----
  function buildExportText() {
    const now = new Date();
    const timeStr = `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const lines = [];
    lines.push(`【点菜清单】${menuName || ''} · 房间 ${roomId} · ${timeStr}`);
    lines.push('------------------------');
    if (lastLines.length === 0) {
      lines.push('（还没有点菜）');
    } else {
      lastLines.forEach(l => {
        const qty = Object.values(l.users).reduce((a, b) => a + b, 0);
        const breakdown = Object.entries(l.users).map(([n, q]) => `${n}x${q}`).join(' ');
        lines.push(`${l.name} x${qty} = ¥${qty * l.price}  (${breakdown})`);
      });
      lines.push('------------------------');
      lines.push(`合计：¥${Math.round(lastTotal)}，共 ${lastCount} 件`);
      const peopleEntries = Object.entries(lastPerUser);
      if (peopleEntries.length > 0) {
        lines.push('');
        lines.push('按人汇总：');
        peopleEntries.forEach(([n, amt]) => lines.push(`${n}：¥${Math.round(amt)}`));
      }
    }
    return lines.join('\n');
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    // 非 https 环境下 Clipboard API 通常不可用，退回到经典的 execCommand 方案
    return new Promise((resolve, reject) => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error('execCommand copy failed'));
      } catch (e) {
        document.body.removeChild(ta);
        reject(e);
      }
    });
  }

  document.getElementById('exportBtn').addEventListener('click', () => {
    const text = buildExportText();
    const modal = document.getElementById('exportModal');
    const textarea = document.getElementById('exportText');
    const hint = document.getElementById('exportHint');
    textarea.value = text;
    modal.style.display = 'flex';

    copyText(text).then(() => {
      hint.textContent = '已复制到剪贴板，可以直接粘贴发给大家';
    }).catch(() => {
      hint.textContent = '自动复制失败，请在下方文本框里手动全选复制';
      textarea.focus();
      textarea.select();
    });
  });

  document.getElementById('exportCopyAgainBtn').addEventListener('click', () => {
    const textarea = document.getElementById('exportText');
    const hint = document.getElementById('exportHint');
    copyText(textarea.value).then(() => {
      hint.textContent = '已复制到剪贴板';
    }).catch(() => {
      hint.textContent = '自动复制失败，请手动全选文本框内容复制';
      textarea.focus();
      textarea.select();
    });
  });

  document.getElementById('exportCloseBtn').addEventListener('click', () => {
    document.getElementById('exportModal').style.display = 'none';
  });
})();
