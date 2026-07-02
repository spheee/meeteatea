const fs = require('fs');
const path = require('path');

const files = fs.readdirSync(__dirname)
  .filter(f => f.endsWith('.js') && f !== 'index.js')
  .sort();

const menus = files.map(f => require(path.join(__dirname, f)));

if (menus.length === 0) {
  throw new Error('menus/ 目录下没有任何菜单文件，请至少放一个（参考 menus/menu1.js 的格式）');
}

const ids = new Set();
menus.forEach(m => {
  if (!m.id || !m.name || !Array.isArray(m.categories)) {
    throw new Error(`菜单文件格式不对，缺少 id/name/categories 字段: ${JSON.stringify(m).slice(0,80)}`);
  }
  if (ids.has(m.id)) throw new Error(`菜单 id 重复: ${m.id}`);
  ids.add(m.id);
});

module.exports = menus;
