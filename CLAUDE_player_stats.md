## 玩家使用統計（player_stats）— 新增功能、關卡、招式時一定要檢查

### 架構
- App 端：app.js 的「玩家使用統計」區塊（搜尋 `PS_KEY`）。
  - 計數器：`psCount('名稱')`；每關打贏：`psWin(關卡編號)`；大冒險現況：`psSnap()`。
  - 一天回傳一次（新的一天第一次打開 App），呼叫後台 `report_stats`，順便帶回補發（`psApplyGifts`）。
- 後台：`player_stats.sql`。每個玩家一列，全部數字在 `stats` 這個 JSON 欄位。
  - `report_stats` 的合併規則：`c`、`win`、`days` 會加總，`snap` 整份覆蓋。
  - 補發信箱：`player_gifts`（雞塊直接加錢包，其他由 App 領取）。
- 匯出：`player_stats_export.sql` → CSV。
- 解碼 App：`chicky_stats_decoder.html`（獨立 HTML，不連網）。

### 什麼時候要改什麼
| 新增了什麼 | App（app.js） | 解碼 App（chicky_stats_decoder.html） | SQL |
|---|---|---|---|
| 玩家會按的新功能（新練習、新測驗、新玩法） | 在「真正開始」的地方加 `psCount('新名稱')`，並把名稱加到區塊開頭的註解清單 | `COUNTERS` 加 `['新名稱', '中文名稱']` | 不用改 |
| 新關卡（第 21 關以後） | 不用改（打贏次數用關卡編號自動記錄） | 不用改（圖表、每關打贏格子會自動延長） | 不用改 |
| 新招式 | 不用改（熟練度整份上傳） | `MOVES` 加 `代碼: '中文名稱'` | 不用改 |
| 新裝備／道具 | 不用改 | `ITEMS` 加 `代碼: '中文名稱'` | 不用改 |
| 新稱號 | 不用改 | `TITLES` 加 `代碼: '中文名稱'` | 不用改 |
| 想在後台看到新的大冒險存檔欄位 | 加進 `psSnap()` | 在玩家明細（`renderDetail` 的 `adv` 或 `info`）顯示 | 不用改 |
| 新的補發種類 | `psApplyGifts` 加上怎麼套用 | `GIFT_KINDS` 加選項 | `player_gifts` 的 `kind` check 要加上新種類 |

- 解碼 App 認不得的計數器、招式、裝備會照英文代碼顯示（計數器會標「新項目，請更新對照表」），資料不會漏，只是要記得補中文名稱。
- **不要改已經存在的計數器名稱**，否則舊資料會對不上。要停用就留著、不再累加。
- 統計的資料跟玩家 ID 連在一起：新增蒐集的項目時，記得同步更新隱私權政策和 Google Play「資料安全性」表單。

### 改完要做的檢查
1. 在 App 裡實際操作新功能，確認 `localStorage` 的 `chicky_pstats_v1` 有累加。
2. 把 `ps.since` 改成昨天，呼叫 `psMaybeSend()`，確認送出的內容有新項目、送完會清空。
3. 匯出 CSV（或用一份模擬資料）丟進解碼 App，確認新項目看得到、中文名稱正確、沒有錯誤訊息。
