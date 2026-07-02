# 多人在线点菜系统

多人可以各自用手机打开同一个房间链接，实时同步点菜、看到彼此加的菜、按人自动汇总金额。支持同时维护多家餐厅的菜单，创建房间时选一份即可。

## 技术说明

- Node.js + Express 提供页面和接口
- WebSocket（`ws` 库）做实时同步：任何人加减菜品，房间内所有人立刻收到更新
- 数据用 JSON 文件保存在 `data/` 目录（每个房间一个文件），重启服务器数据不丢失
- 不需要数据库，部署非常简单

## 本地运行

```bash
npm install
npm start
```

默认挂载在 `/order` 子路径下，打开 http://localhost:3000/order/ 即可（注意末尾这个 `/order/`，不是根路径）。
如果想换个路径，启动前设置环境变量，比如：

```bash
BASE_PATH=/dianca npm start
```

## 部署到你的服务器（配合 Nginx，转发 /order 到本系统）

1. 把整个项目文件夹上传到服务器（比如 `/opt/order-system`）
2. 安装依赖：

   ```bash
   cd /opt/order-system
   npm install --production
   ```

3. 启动（推荐用 pm2 保持后台常驻和自动重启）：

   ```bash
   npm install -g pm2
   pm2 start server.js --name order-system
   pm2 save
   ```

   也可以直接 `PORT=3000 node server.js` 前台跑（调试用）。

4. **本系统默认挂载在 `/order` 子路径下**（不是站点根路径），所以 Nginx 只要把 `/order` 原样转发给它就行，**不要**做前缀 rewrite/strip。核心永远是这两段 `location`（完整可复制的独立站点版本见 [`deploy/nginx-order-system.conf`](./deploy/nginx-order-system.conf)）：

   ```nginx
   location /order/ {
       proxy_pass http://127.0.0.1:3000;   # 注意：这里不要在末尾加路径，让 /order 原样透传
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
   }

   # 访问 /order（没有末尾斜杠）时跳转到 /order/，避免相对路径的静态资源加载失败
   location = /order {
       return 301 /order/;
   }
   ```

   怎么放这两段，看你服务器的情况：

   **没有域名，只用 IP 访问 / 服务器上还没有别的站点（最简单，推荐）**

   直接把这两段加进 Ubuntu 自带的默认站点 `/etc/nginx/sites-available/default`，加在它原有的 `server { listen 80 default_server; ... }` 块内部（跟它已有的 `location /` 平级），然后：

   ```bash
   sudo nginx -t
   sudo systemctl reload nginx
   ```

   > **踩坑提醒**：如果你另外新建一个 `server { listen 80; }` 站点、又没设置 `server_name`，请求会被自带的 `default` 站点（带 `default_server` 标记）抢走，导致 `/order` 一直打不开或者显示别的页面。没有域名的情况下，最稳的做法就是直接改 `default` 站点，别新建。也可以反过来：`sudo rm /etc/nginx/sites-enabled/default`（只删软链接，不删源文件，随时可恢复）把默认站点禁用掉，只留你自己的站点。

   **已经有域名，想单独建一个站点**

   用 [`deploy/nginx-order-system.conf`](./deploy/nginx-order-system.conf) 这份完整配置，把里面的 `server_name` 换成你真实的域名，然后：

   ```bash
   sudo cp deploy/nginx-order-system.conf /etc/nginx/sites-available/order-system
   sudo nano /etc/nginx/sites-available/order-system   # 改 server_name
   sudo ln -s /etc/nginx/sites-available/order-system /etc/nginx/sites-enabled/
   sudo nginx -t
   sudo systemctl reload nginx
   ```

   配好后，访问 `http://yourdomain.com/order/`（或者 `http://服务器IP/order/`）就是首页。

   `WebSocket` 用的是同一个 `/order/ws` 路径，上面配置里的 `Upgrade`/`Connection` 两行就是专门保证 WebSocket 握手能通过 Nginx 转发，缺了会导致点菜页面一直显示"重连中"。

   如果以后给整个网站配了 https，前端会自动改用 `wss://` 连接（`public/order.js` 里已经按 `location.protocol` 自动判断了），Nginx 配置里把 `listen 80` 换成 `listen 443 ssl` 并加上证书路径即可，无需改这个项目的代码。

   如果你想换一个转发路径（不叫 `/order`），启动服务时改一下 `BASE_PATH` 环境变量，Nginx 里的 `location` 路径也同步改成一样的就行，前端代码不用动。

5. 防火墙记得放行 80（或者你用的端口）。Node 应用本身跑在 3000 端口，只对内网/本机开放即可，不用暴露给公网，公网只暴露 Nginx 的 80/443。

6. 之后每次改完代码 `git push`，服务器上拉最新代码、重启 pm2：

   ```bash
   cd /opt/order-system
   git pull
   npm install --production   # package.json 有变化时才需要，没变可以跳过
   pm2 restart order-system
   ```

   看日志确认启动正常：`pm2 logs order-system`。

## 使用方式

1. 任意一人打开首页（比如 `http://yourdomain.com/order/`），先在下拉框选这顿饭对应的餐厅菜单，再点"创建新房间"，得到一个类似 `/order/AB3K` 的链接和 4 位房间码
2. 把链接分享给同桌的人（微信发链接，或者报房间码让对方在首页输入加入）
3. 每个人第一次进入会被要求填一个昵称
4. 大家在自己手机上点 +/− 加减菜品，所有人的总价、清单、按人汇总会实时同步刷新
5. 只能清空"自己加的菜"（清空我的），避免误删别人点的菜
6. 点完之后，点"复制清单"就会自动把整桌点的菜（含每人分别点了什么、总价、按人汇总）复制到剪贴板，直接粘贴发到群里或者报给服务员；如果浏览器不支持自动复制（比如没上 https），会弹出一个文本框，手动全选复制即可

## 目录结构

```
order-system/
├── server.js          # 后端：Express + WebSocket + 房间数据读写
├── menus/              # 菜单数据目录，每个文件是一份菜单
│   ├── index.js          # 自动扫描本目录下所有菜单文件，不用改
│   ├── menu1.js           # 示例菜单1
│   └── menu2.js           # 示例菜单2
├── deploy/              # 部署相关的现成配置文件，照抄改改就能用
│   └── nginx-order-system.conf   # 独立站点版 Nginx 配置（有域名时用）
├── package.json
├── data/               # 每个房间一个 JSON 文件（自动生成，记录该房间用的菜单+点菜情况）
└── public/
    ├── index.html       # 首页：选菜单 + 创建/加入房间
    ├── order.html        # 点菜页面
    ├── order.js           # 点菜页前端逻辑（WebSocket 连接、渲染）
    └── notfound.html      # 房间不存在提示页
```

## 添加新餐厅的菜单

在 `menus/` 目录下新建一个 `.js` 文件（文件名随意，比如 `menus/haidilao.js`），照下面格式写：

```js
module.exports = {
  id: "haidilao",           // 唯一标识，不能跟其他菜单文件重复
  name: "海底捞火锅",         // 首页下拉框显示的名字
  categories: [
    {cat:"锅底", items:[
      {n:"番茄锅", p:38},
      {n:"麻辣锅", p:38},
    ]},
    {cat:"肉类", items:[
      {n:"肥牛卷", p:48},
      {n:"羊肉卷", opts:[["半份",38],["整份",68]]}, // 多规格菜品写法
    ]},
  ]
};
```

保存后重启服务（`npm start` 或 `pm2 restart order-system`），首页的"选择菜单"下拉框就会自动多出这一项，之后创建的房间就能选它了。已经开好的房间不受影响，仍然用创建时选的那份菜单。

不想要某份示例菜单，直接删掉对应文件即可（比如删 `menus/menu2.js`）。

## 常见问题

- **配好 Nginx，访问 `/order` 还是打不开** —— 先 `sudo nginx -t` 看语法错没错；再看 `curl -i http://127.0.0.1:3000/order/` 本机直连 Node 服务通不通（不通说明是 Node 服务没启动或端口不对，跟 Nginx 无关）；如果直连没问题但走 Nginx 不行，大概率是被 `default_server` 站点抢走了请求，参考上面部署部分的踩坑提醒。
- **点菜页面标题旁边一直显示"重连中"** —— WebSocket 没握手成功，检查 Nginx 配置里 `proxy_set_header Upgrade $http_upgrade;` 和 `proxy_set_header Connection "upgrade";` 这两行有没有漏。
- **改了 `menus/` 里的菜单文件不生效** —— 菜单是启动时读一次，改完文件要 `pm2 restart order-system` 才会生效；已经创建的房间会一直用创建时那份菜单，不会跟着变。

## 已测试功能

- 多个 WebSocket 客户端同时连接同一房间，加菜后所有客户端实时收到广播 ✅
- 每人加的数量分开记录，同一道菜显示"小明×2 小红×1" ✅
- 数据落盘到 `data/房间码.json`，服务器重启不丢单 ✅
- 房间不存在时访问返回 404 提示页 ✅
- 多规格菜品（半份/整份等）分别计价、分别同步 ✅
- 同一时间存在多份不同餐厅的菜单，各房间互不影响，可分别选择 ✅
- 部署在反向代理子路径（如 Nginx 的 `/order`）下正常工作，静态资源、接口、WebSocket 全部走同一前缀 ✅
- "复制清单"一键把点菜结果（含分人明细、合计、按人汇总）复制到剪贴板，非 https 环境下自动降级为手动复制 ✅
- "清空我的"只清除当前用户自己加的菜 ✅
