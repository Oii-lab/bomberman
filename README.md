# 💣 Bomberman Online

兩人連線炸彈超人對戰遊戲，使用 Node.js + Socket.io 實作即時連線。

## 快速啟動

```bash
npm install
npm start
```

瀏覽器開啟 http://localhost:3000

## 玩法

| 玩家 | 移動 | 放炸彈 |
|------|------|--------|
| 🔴 P1 | `WASD` | `Space` |
| 🔵 P2 | `↑↓←→` | `Enter` |

1. 兩人開啟同一個伺服器網址
2. 輸入名字 + 相同的房間 ID
3. 等對方進入後自動開始

## 部署到遠端（讓兩台電腦對戰）

### 方法 A：本機區網（最簡單）
1. `npm start`
2. 查自己的 IP：`ipconfig`（Windows）或 `ifconfig`（Mac/Linux）
3. 朋友連 `http://你的IP:3000`（需在同一 WiFi）

### 方法 B：Render.com（免費，可跨網路）
1. 上傳到 GitHub
2. 到 https://render.com 新增 Web Service
3. Build command：`npm install`
4. Start command：`node server/index.js`
5. 分享 Render 給的網址

### 方法 C：Railway / Fly.io
同樣支援，設定方式相似。

## 規則
- 💣 炸彈 3 秒後爆炸，射程 2 格
- 🧱 橘色磚塊可以被炸毀
- 💀 被火焰波及即淘汰
- 可連鎖爆炸
- 先讓對方死亡者獲勝

## 技術架構
- **後端**：Node.js + Express + Socket.io
- **前端**：原生 HTML/CSS/Canvas（無框架）
- **連線**：WebSocket（Socket.io）
