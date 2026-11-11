# Chicky Vocab：給改程式的 AI 看的規則

## 大冒險的戰鬥規則只能寫在 `battle-core.js`

| 檔案 | 負責什麼 |
|---|---|
| `battle-core.js` | **所有戰鬥規則**：關卡／敵人資料（LEVELS）、招式（MOVES）、裝備效果（ITEMS）、傷害公式、幸運、護盾、行動次數、速答加成、敵人特殊能力、出招與敵人回合的流程，還有雞塊能力、經驗值、等級、熟練度、爆擊門檻、招式／裝備第幾關拿到 |
| `app.js` | 只負責**畫面**：答題、動畫、音效、存檔、獎勵。戰鬥時呼叫 `BattleCore` 拿事件，再用 `advOnEvent()` 演出來 |
| `simulator.html` | 大冒險敵人模擬器，讀同一份 `battle-core.js` |

### 一定要遵守

1. **不要在 `app.js` 計算任何戰鬥數字**（傷害、扣血、加攻擊、特殊能力判定都不行）。要改規則就改 `battle-core.js`。
   - `app.js` 裡的 `ADV_LEVELS`、`ADV_MOVES`、`ADV_COFFEE_BURN`… 只是 `BattleCore` 的別名，不要改回寫死的數字。
   - `advLevel`、`advWinXp`、`advPlayerStats`、`advMastery…`、`advGearBonus` 這些函式也只是轉呼叫 `BattleCore`，不要在裡面重寫算法。
   - 同一個算法不要在 `app.js` 和 `battle-core.js` 各寫一份：模擬器只檢查 `battle-core.js`，`app.js` 的副本改了也檢查不出來。
2. `battle-core.js` 不能碰畫面：不能用 `document`、`window`、`localStorage`、`setTimeout`、音效、網路。亂數一律用參數 `rng`。
3. 戰鬥流程是產生器（`function*`）：每做完一步 `yield { t: '事件名', ... }`。
   - 新增會出現在畫面上的效果時：在 `battle-core.js` yield 一個事件 → 在 `app.js` 的 `advOnEvent()` 加一個 `case` 播動畫。
   - 通用的 `{ t: 'trait', text, target, float }` 事件 app 已經會演，用「特殊能力積木」做的新敵人不用改 `app.js`。
4. 新敵人的特殊能力，優先用關卡資料裡的 `traits: [...]`（積木，種類見 `BattleCore.TRAIT_TYPES`），不要再加新的 `special` 代號和 `if (special === ...)`。
5. `index.html` 要先載入 `battle-core.js` 再載入 `app.js`。改了任一檔案都要更新兩個 `?v=` 版本號。

### 改完一定要檢查

打開 `simulator.html` →「規則檢查」→「全部執行」。

- 全部通過才算完成。
- 有紅字：照紅字裡「應該／現在」修好 `battle-core.js`。
- 如果是使用者**要求**改規則或數值，結果不一樣是正常的：請使用者按「這是我故意改的 → 更新答案」，不要為了讓檢查通過而去改模擬器裡的答案。

## 其他

- 模擬器裡「AI 怎麼選招式」（`chooseMove` / `moveValue`）屬於模擬器，不是遊戲規則；改它會讓整場重播的答案改變，改完也要請使用者更新答案。
- 文字說明（例如 `ADV_SPECIAL_TEXT`、戰鬥訊息）放在 `app.js` 沒關係，那是畫面。
