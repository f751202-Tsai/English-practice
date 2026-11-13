// ═════════════════════════════════════════════════════════════
//  battle-core.js — 雞塊大冒險「戰鬥規則」唯一的來源
//
//  ⚠️ 給修改程式的人（包含 AI）：
//   1. 所有戰鬥數值、公式、敵人資料、招式、裝備效果、敵人特殊能力，都只能寫在這個檔案。
//   2. 這個檔案不能碰畫面：不能用 document / window / localStorage / 音效 / 網路 / setTimeout。
//   3. app.js 只負責「畫出來」：呼叫這裡的函式拿結果（事件），再播動畫。不要在 app.js 自己算傷害。
//   4. 大冒險敵人模擬器（simulator.html）也讀這個檔案，所以改這裡＝遊戲和模擬器一起改。
//   5. 改完打開 simulator.html →「規則檢查」→「全部執行」，全部通過才算完成。
//      如果是故意改規則（例如調整數值），結果不一樣是正常的，請在那裡按「這是我故意改的」。
//
//  戰鬥流程用「產生器」(function*) 寫：每做完一步就 yield 一個事件 { t: '事件名', ... }，
//  app.js 收到事件就播對應的動畫；模擬器則直接一路跑完。兩邊跑的是同一段規則。
//  亂數一律用參數 rng（預設 Math.random），模擬器可以傳固定亂數來重播同一場戰鬥。
// ═════════════════════════════════════════════════════════════
(function (root) {
    'use strict';
    const R = (rng) => (rng || Math.random)();

    // ── 基本設定 ──
    const BASE_STATS = { hp: 3, atk: 0, agi: 3, def: 0, int: 1, luck: 0 };
    const STAT_KEYS = ['hp', 'atk', 'agi', 'def', 'int', 'luck'];
    const STAT_MAX = 10;                    // 每項能力（含 HP、智慧）最多 10：能強化的次數 = 10 − 基礎值
    // XP_NEED[n-1] = 升到 Lv.n 需要的「累積」經驗值；從 Lv.0 開始，最高 Lv.20
    const XP_NEED = [3, 7, 37, 75, 124, 187, 268, 371, 503, 672, 888, 1165, 1519, 1903, 2317, 2771, 3265, 3799, 4373, 5007];
    const OLD_XP_RATE = 0.7;                // 已經打贏過的舊關卡：經驗值只有 70%
    const LOSE_XP_RATE = 0.2;               // 戰敗：拿這關勝利經驗值（不含每日 ×2）的 20%，至少 1；中途離開什麼都沒有
    const MAX_EQUIP = 4;
    const MIN_EQUIP = 3;
    const BASE_SECS = 15;                   // 每題作答時間（秒）
    const LUCK_CAP = 3;                     // 幸運擲幣的加成最多 +3
    const SHIELD_CAP = 10;
    const SPEED_MIN_SECS = 10;
    const RING_NEED = 4, RING_SECS = 15, RING_PEN = 2;   // 套圈圈開場：15 秒配 4 組，配錯扣 2 秒

    // 招式（icon 是文字版；app.js 會換成 SVG 圖示）
    //   type：card 字卡 / listen 聽力 / speak 朗讀 / speed 速答
    //   power：每一下的威力；hits：打幾下；q：要連續答對幾題
    const MOVES = [
        { key: 'tackle',  name: '衝撞',         icon: '💥', type: 'card',   mode: 'choice',      fx: 'dash',   power: 1, hits: 1, q: 1, tries: 1, buy: { kind: 'free' },                                              desc: '看單字，選出正確的中文意思' },
        { key: 'combo',   name: '連續衝撞',     icon: '💥', type: 'card',   mode: 'choice',      fx: 'dash',   power: 1, hits: 2, q: 3, tries: 1, buy: { kind: 'reward', level: 5 },                         desc: '看單字，選出正確的中文意思' },
        { key: 'charge',  name: '衝鋒撞擊',     icon: '🐗', type: 'card',   mode: 'typeCn',      fx: 'charge', power: 5, hits: 1, q: 2, tries: 1, buy: { kind: 'reward', level: 8 }, desc: '看英文單字，寫出中文意思' },
        { key: 'slash',   name: '斬擊',         icon: '⚔️', type: 'listen', mode: 'listenCn',     fx: 'slash',  power: 2, hits: 1, q: 1, tries: 1, buy: { kind: 'free' },                                       desc: '聽發音，選中文意思' },
        { key: 'slash2',  name: '連續斬擊',     icon: '⚔️', type: 'listen', mode: 'listenCn',     fx: 'slash',  power: 2, hits: 2, q: 3, tries: 1, buy: { kind: 'reward', level: 6, item: 'mv_slash2' },       desc: '聽發音，選中文意思' },
        { key: 'thrust',  name: '突刺',         icon: '🔱', type: 'listen', mode: 'listenSpell',  fx: 'thrust', power: 5, hits: 1, q: 2, tries: 1, buy: { kind: 'reward', level: 7 }, desc: '聽發音，拼出英文單字（提示第一個字母和字母數）' },
        { key: 'wave',    name: '衝擊波',       icon: '🌊', type: 'speak',  mode: 'speak',        fx: 'wave',   power: 2, hits: 1, q: 1, tries: 2, hidden: true, buy: { kind: 'none' },                                       desc: '看單字，並唸出單字' },
        { key: 'wave2',   name: '雙重衝擊波',   icon: '🌊', type: 'speak',  mode: 'speak',        fx: 'wave',   power: 2, hits: 2, q: 2, tries: 2, hidden: true, buy: { kind: 'none' },        desc: '看單字，並唸出單字' },
        // 速答類：20 秒內英中配對，配對成功的組數換成能力加成（不直接造成傷害）
        //   speed.secs 秒數；every 每配對幾組 +1；cap 加成上限；pen 配錯扣幾秒；lvSecs／lvCap 每 1 級熟練度加的秒數／上限；maxCap 上限的上限
        { key: 'meditate', name: '冥想',        icon: '🧘', type: 'speed', mode: 'speed', fx: '', power: 0, hits: 0, q: 0, tries: 0, buy: { kind: 'reward', level: 10 },
          speed: { stat: 'int', label: '智慧', secs: 20, every: 3, cap: 5, pen: 3, lvSecs: 2, lvCap: 2, maxCap: 7 }, desc: '20 秒內把英文和中文配成對，每配對 3 組智慧 +1；配錯扣 3 秒' },
        { key: 'chargeup', name: '蓄力',        icon: '⚡', type: 'speed', mode: 'speed', fx: '', power: 0, hits: 0, q: 0, tries: 0, buy: { kind: 'shards', price: 40, open: 24 },
          speed: { stat: 'atk', label: '下一招攻擊', secs: 20, every: 4, cap: 5, pen: 4, lvSecs: 2, lvCap: 1, maxCap: 99 }, desc: '20 秒內把英文和中文配成對，每配對 4 組下一招攻擊 +1；配錯扣 4 秒' },
        { key: 'wave3',   name: '雞塊氣功波',   icon: '🟡', type: 'speak',  mode: 'speakCn',      fx: 'yellow', power: 5, hits: 1, q: 2, tries: 2, hidden: true, buy: { kind: 'none' }, desc: '顯示中文，唸英文' }
    ];

    // 關卡：firstShards/firstSauce = 第一次通關的獎勵；repeatShards = 之後每次通關的獎勵
    //   special：舊版的特殊能力代號（寫在下面的規則裡）
    //   traits：新的「特殊能力積木」（見 TRAIT_TYPES），新敵人建議用這個
    const LEVELS = [
        { id: 1, name: '貢丸',     sprite: 'meatball', minWords: 10, hp: 3,  atk: 1, agi: 1, def: 0, luck: 0, moveName: '彈跳撞擊', movePower: 0, firstShards: 1, firstSauce: 0, repeatShards: 1, xp: 3, firstPotions: 1, firstItem: 'bag', special: '' },
        { id: 2, name: '烤玉米',   sprite: 'corn',     minWords: 15, hp: 4,  atk: 1, agi: 0, def: 1, luck: 0, moveName: '玉米粒連射', movePower: 0, firstShards: 1, firstSauce: 0, repeatShards: 1, xp: 4, firstPotions: 1, special: '' },
        { id: 3, name: '蚵仔煎',   sprite: 'oyster',   minWords: 20, hp: 5,  atk: 2, agi: 1, def: 0, luck: 0, moveName: '黏稠甩擊', movePower: 0, firstShards: 2, firstSauce: 0, repeatShards: 1, xp: 5, firstPotions: 1, special: '' },
        { id: 4, name: '臭豆腐',   sprite: 'tofu',     minWords: 20, hp: 7,  atk: 1, agi: 0, def: 1, luck: 0, moveName: '酸臭衝撞', movePower: 0, firstShards: 3, firstSauce: 0, repeatShards: 1, xp: 6, firstPotions: 2, firstItem: 'tofu', special: 'stink' },
        { id: 5, name: '珍珠奶茶', sprite: 'boba',     minWords: 30, hp: 10, atk: 2, agi: 0, def: 1, luck: 0, moveName: '珍珠連射', movePower: 0, firstShards: 0, firstSauce: 0, repeatShards: 2, xp: 7, firstPotions: 2, firstTickets: 1, special: 'heal' },
        { id: 6, name: '娃娃機',   sprite: 'claw',     minWords: 30, hp: 12, atk: 2, agi: 0, def: 2, int: 0, luck: 1, moveName: '夾子抓抓', movePower: 0, firstShards: 3, firstSauce: 0, repeatShards: 2, xp: 8, firstPotions: 1, firstTickets: 1, special: 'claw' },
        { id: 7, name: '射飛鏢',   sprite: 'darts',    minWords: 40, hp: 13, atk: 2, agi: 2, def: 1, int: 0, luck: 1, moveName: '飛鏢連射', movePower: 0, firstShards: 5, firstSauce: 0, repeatShards: 2, xp: 9, firstPotions: 1, special: 'darts' },
        { id: 8, name: '夜市麻將', sprite: 'mahjong',  minWords: 40, hp: 14, atk: 2, agi: 1, def: 2, int: 3, luck: 3, moveName: '自摸', movePower: 0, firstShards: 5, firstSauce: 0, repeatShards: 2, xp: 10, firstPotions: 1, special: 'mahjong' },
        { id: 9, name: '套圈圈',   sprite: 'ring',     minWords: 50, hp: 15, atk: 1, hits: 2, agi: 3, def: 0, int: 0, luck: 1, moveName: '圈圈投擲', movePower: 0, firstShards: 5, firstSauce: 0, repeatShards: 2, xp: 11, firstPotions: 1, firstTickets: 1, special: 'ring' },
        { id: 10, name: '彈珠台',  sprite: 'pinball',  minWords: 50, hp: 15, atk: 4, agi: 1, def: 2, int: 1, luck: 6, moveName: '彈珠發射', movePower: 0, firstShards: 0, firstSauce: 0, repeatShards: 3, xp: 15, firstPotions: 2, firstTickets: 2, firstWipes: 1, special: 'pinball' },
        // ── 第二章：便利商店 ──
        { id: 11, name: '茶葉蛋',   sprite: 'egg',     minWords: 60, hp: 17, atk: 3, agi: 3, def: 2, int: 6, luck: 2, moveName: '滾燙蛋汁', movePower: 0, firstShards: 5, firstSauce: 0, repeatShards: 3, xp: 13, special: 'egg' },
        { id: 12, name: '大亨堡',   sprite: 'bun',     minWords: 60, hp: 8,  atk: 3, agi: 2, def: 3, int: 9, luck: 2, moveName: '麵包夾擊', movePower: 0, firstShards: 5, firstSauce: 0, repeatShards: 3, xp: 17, firstItem: 'skewer', special: 'bun',
          phases: [
              { name: '大亨堡', sprite: 'bun',    hp: 8, atk: 3, agi: 2, def: 3, int: 9, luck: 2, moveName: '麵包夾擊', special: 'bun' },
              { name: '熱狗',   sprite: 'hotdog', hp: 7, atk: 5, agi: 4, def: 2, int: 3, luck: 4, moveName: '熱油噴射', special: 'hotdog' }
          ] },
        { id: 13, name: '御飯糰',   sprite: 'onigiri', minWords: 70, hp: 15, atk: 5, agi: 3, def: 3, int: 9, luck: 3, shield: 12, moveName: '海苔捲擊', movePower: 0, firstShards: 5, firstSauce: 0, repeatShards: 3, xp: 19, special: 'wrap' },
        { id: 14, name: '瓶裝無糖茶', sprite: 'tea',   minWords: 70, hp: 18, atk: 5, agi: 3, def: 4, int: 5, luck: 0, moveName: '冰鎮茶柱', movePower: 0, firstShards: 5, firstSauce: 0, repeatShards: 3, xp: 21, special: 'tea' },
        { id: 15, name: 'ibon',   sprite: 'ibon',    minWords: 70, hp: 25, atk: 6, agi: 2, def: 7, int: 5, luck: -2, moveName: '列印繳費單', movePower: 0, firstShards: 0, firstSauce: 0, repeatShards: 4, xp: 23, firstPotions: 1, firstTickets: 3, firstItem: 'bill', potionChance: 0.2, special: 'seal' },
        { id: 16, name: '盒裝沙拉', sprite: 'salad',  minWords: 80, hp: 22, atk: 5, agi: 5, def: 3, int: 5, luck: 3, moveName: '生菜甩擊', movePower: 0, firstShards: 6, firstSauce: 0, repeatShards: 4, xp: 23, firstTickets: 1, special: 'salad' },
        { id: 17, name: '微波爐',   sprite: 'microwave', minWords: 80, hp: 25, atk: 5, agi: 1, def: 6, int: 1, luck: 1, moveName: '叮！加熱', movePower: 0, firstShards: 6, firstSauce: 0, repeatShards: 4, xp: 26, firstTickets: 1, special: 'microwave' },
        { id: 18, name: '微波便當', sprite: 'bento',  minWords: 90, hp: 20, atk: 3, agi: 3, def: 3, int: 9, luck: 2, moveName: '便當蓋飛擊', movePower: 0, firstShards: 7, firstSauce: 0, repeatShards: 4, xp: 29, firstTickets: 1, special: 'bento',
          phases: [
              { name: '微波便當',   sprite: 'bento',  hp: 20, atk: 3, agi: 3, def: 3, int: 9, luck: 2, moveName: '便當蓋飛擊', special: 'bento' },
              { name: '愛珍食便當', sprite: 'bento2', hp: 40, atk: 7, agi: 6, def: 2, int: 6, luck: 6, moveName: '即期大反撲', special: 'expire' }
          ] },
        { id: 19, name: '美式咖啡', sprite: 'coffee', minWords: 90, hp: 30, atk: 5, agi: 5, def: 3, int: 2, luck: 2, moveName: '滾燙潑灑', movePower: 0, firstShards: 7, firstSauce: 0, repeatShards: 4, xp: 32, firstTickets: 1, special: 'coffee' },
        { id: 20, name: '全能便利商店員工', sprite: 'clerk', minWords: 100, hp: 40, atk: 6, agi: 4, def: 4, int: 4, luck: 2, moveName: '商品補貨', movePower: 0, firstShards: 0, firstSauce: 0, repeatShards: 5, xp: 35, firstPotions: 2, firstTickets: 2, special: 'clerk' }
    ];

    const TYPE_LABEL = { card: '字卡', listen: '聽力', speak: '朗讀', speed: '速答' };
    // 稀有度：普通（熟練度上限 1）／稀有（上限 2）／傳說（上限 3）
    const RARITY = {
        common: { label: '普通', color: '#94A3B8', cap: 1 },
        rare:   { label: '稀有', color: '#B8860B', cap: 2 },
        legend: { label: '傳說', color: '#C026D3', cap: 3 }
    };
    const MOVE_RARITY = { tackle: 'common', slash: 'common', wave: 'common', combo: 'rare', slash2: 'rare', wave2: 'rare', charge: 'rare', thrust: 'rare', wave3: 'legend', meditate: 'common', chargeup: 'rare' };
    // 熟練度：累積使用 20 次 → 1、100 次 → 2、300 次 → 3（不超過稀有度上限）；每 1 級這招攻擊 +1（傳說招式 +2）
    const MASTERY_STEPS = [20, 100, 300];

    // ── 敵人特殊能力用到的數字 ──
    const COFFEE_BURN = 6;                  // 美式咖啡：開戰燙傷 = 6 − 雞塊的智慧（無視防禦；有護盾先扣護盾，剩下的才扣體力）
    // 全能便利商店員工：每回合換崗位（第一階段），各自免疫一類招式
    const CLERK_POSTS = [{ name: '收銀台', immune: 'card' }, { name: '做餐中', immune: 'listen' }, { name: '點貨中', immune: 'speed' }];   // 點貨中：速答加成 −4（不是無效）
    const CLERK_SHIFT_HP = 20, CLERK_CD = 3;          // HP 低於 20 進入交班；下班倒數 3
    const CLERK_SHIFT_BUFF = { agi: 6, int: 4, atk: 3, heal: 10 };   // 交班：敏捷 +6、智慧 +4、攻擊 +3、回 10 點體力
    const STAMP_NEED = 2, STAMP_ATK = 2, STAMP_HEAL = 5;   // 集點：任兩種 → 兌換集點卡（攻擊 +2、HP +5）
    // 這些敵人對某一類招式有抗性：每一下最多只受到 1 點傷害
    const RESIST = { darts: 'listen', mahjong: 'card', hotdog: 'listen' };
    // 這些敵人完全不受某一類招式的傷害
    const IMMUNE = { salad: 'card', microwave: 'listen' };
    const WEAK_BONUS = {};
    // 速答招式：這些敵人會把能力加成扣掉幾點
    const SPEED_GUARD = { tea: 2, coffee: 3 };
    const CLERK_SPEED_GUARD = 4, TEA_SPEED_HEAL = 1, EXPIRE_SPEED_DMG = 1, EXPIRE_SPEED_EVERY = 2;   // 愛珍食便當：速答每配對 2 組扣牠 1 點
    const MICRO_ATK_UP = 2;                 // 微波爐：每次攻擊後攻擊力 +2
    const EXPIRE_SELF = 4;                  // 愛珍食便當：攻擊完自己扣 4 點體力
    const EGG_CARD_BONUS = 2;               // 茶葉蛋：字卡類招式每一下傷害 +2
    const IGNORE_SHIELD = { salad: true };  // 盒裝沙拉：攻擊無視雞塊的護盾

    // ── 裝備（只寫名稱與效果說明；圖示在 app.js）──
    const ITEMS = {
        boba: { name: '快喝光的珍珠奶茶', desc: '一場戰鬥限用 1 次：第 2 回合起、HP 剩 3 以下可以喝，HP +1' },
        tofu: { name: '烤焦臭豆腐', desc: '自己的招式失敗時，雙方各扣 1 點體力（無視防禦）' },
        skewer: { name: '竹籤', desc: '攻擊無視對方的護盾，直接扣體力' },
        bill: { name: '繁瑣的繳費單', desc: '？？？' },
        bag: { name: '夜市塑膠袋', desc: '每場戰鬥開始時護盾 +1' },
        soda: { name: '彈珠汽水', desc: '戰鬥勝利後 HP +1' },
        coaster: { name: '防燙杯套', desc: '智慧 +3' }
    };
    // 補給站的裝備：打完第幾關才開放（0 = 一開始就能買）；其他裝備是關卡的第一次通關獎勵（LEVELS 的 firstItem）
    const SHOP_OPEN = { soda: 0, boba: 4, coaster: 10 };
    // 命中加成：最近的命中率 ≥ 90% 時，每次攻擊多 1 次爆擊判定（擲 1 枚硬幣，正面 +1）
    const CRIT_AT = 90;
    const ITEM_RARITY = { boba: 'common', tofu: 'common', skewer: 'rare', bill: 'common', bag: 'common', soda: 'common', coaster: 'common' };
    const COASTER_INT = 3;
    const BAG_SHIELD = 1;
    const BOBA_HP_AT = 3;                   // 珍珠奶茶：HP 剩 3 以下才能喝
    const NECTAR_SHIELD = 2;                // 農場花蜜：護盾 +2
    const CROWN_ATK = 1;                    // 農場花環：攻擊 +1

    // ── 訓練場：木人（不會攻擊、敏捷 0）──
    //   immune 積木：某一類招式無效（跟冒險敵人共用同一個積木）
    //   unlock：打完第幾關才出現（0 = 一開始就有）；firstReward：第一次打到 HP 歸零（999）給一次的獎勵
    const DUMMIES = [
        { key: 'wood',  name: '木頭人',   sprite: 'dummy_wood',  hp: 999, def: 0, agi: 0, traits: [],                                   unlock: 0,  firstReward: { shards: 10 } },
        { key: 'noise', name: '抗噪木人', sprite: 'dummy_noise', hp: 999, def: 0, agi: 0, traits: [{ type: 'immune', moveType: 'listen' }], unlock: 7,  firstReward: { shards: 20 } },
        { key: 'card',  name: '字卡木人', sprite: 'dummy_card',  hp: 999, def: 0, agi: 0, traits: [{ type: 'immune', moveType: 'card' }],   unlock: 8,  firstReward: { shards: 20 } },
        { key: 'iron',  name: '鐵木人',   sprite: 'dummy_iron',  hp: 999, def: 10, agi: 0, traits: [],                                   unlock: 15, firstReward: { shards: 30 } }
    ];
    const TRAIN_ROUNDS = 10;                // 訓練：10 回合結束

    // ═════════ 敵人圖鑑 ═════════
    //   能力值、特殊能力的數字都直接讀上面的 LEVELS／常數（數值改了圖鑑會跟著變）；這裡只多「攻略」文字（圖鑑專用）
    const DEX_NEED = 3;                     // 情蒐 3 次完全解鎖（打完一場 +1，不論輸贏；中途離開不算）
    const DEX_REWARD = { shards: 2, xpRate: 0.5 };   // 每隻情蒐完成：冒險代幣 +2、經驗值 = 這關首勝經驗值 50%（至少 1）
    const DEX_CHAPTER_REWARD = { shards: 10 };       // 整章情蒐完成：冒險代幣 +10 ＋ 稱號
    const TITLES = {
        night: { chapter: 1, name: '夜市小霸王', desc: '（純稱號）', xpPct: 0 },
        store: { chapter: 2, name: '24小時不打烊', desc: '經驗值 +5%（無條件進位）', xpPct: 5 }
    };
    // 特殊能力（用上面的常數組字）＋攻略；key = 敵人圖（sprite）
    const DEX_TEXT = {
        meatball: { tip: '沒有特殊能力，答對就能穩穩打贏。' },
        corn: { tip: '有 1 點防禦，用威力高一點的招式比較痛。' },
        oyster: { tip: '牠比較快，加一點敏捷就能多出招。' },
        tofu: { ability: '發臭：你的招式失敗時，被臭味反擊扣 1 點體力（無視防禦）', tip: '選最有把握的招式，少失敗就不會被燻到。' },
        boba: { ability: '治癒：每回合攻擊完回 1 點體力', tip: '一回合多打幾下，打得比牠回血快。加敏捷很有用。' },
        claw: { ability: '送你娃娃：打贏多掉 1 個冒險代幣', tip: '很適合常來刷冒險代幣。' },
        darts: { ability: () => `聽力招式每一下只有 1 點傷害`, tip: '改帶字卡招式（衝撞、連續衝撞）比較打得痛。' },
        mahjong: { ability: () => `字卡招式每一下只有 1 點傷害`, tip: '改帶聽力招式。牠智慧高，答題時間會變短，加智慧可以多一點時間。' },
        ring: { ability: () => `天女散花：開場 ${RING_SECS} 秒配對，少配 1 組被砸 1 點`, tip: '開場配對要快，單字練熟就不怕。' },
        pinball: { ability: '打彈珠：每次攻擊前擲骰，可能回 2 點體力或多彈你 1 下', tip: '幸運很高、常爆擊。加 HP 或防禦撐久一點。' },
        egg: { ability: () => `剝殼：字卡招式每一下傷害 +${EGG_CARD_BONUS}`, tip: '多帶字卡招式，剝殼更快。' },
        bun: { ability: '打倒麵包後，熱狗會跳出來接著打', tip: '別把力氣用完，後面還有熱狗。' },
        hotdog: { ability: () => `聽力招式每一下只有 1 點傷害`, tip: '用字卡招式收尾。' },
        onigiri: { ability: '拆不掉的包裝：一開場就有很厚的護盾', tip: '御飯糰護盾很高，帶竹籤可以無視護盾直接打。' },
        tea: { ability: () => `回甘：速答招式的加成 −${SPEED_GUARD.tea}`, tip: '少用速答招式，直接攻擊比較划算。' },
        ibon: { ability: '取票失敗：每回合隨機封印你 2 個招式', tip: '招式帶滿 4 個，被封印也還有招可用。' },
        salad: { ability: '字卡招式完全無效；攻擊無視你的護盾', tip: '帶聽力招式。護盾沒用，多加 HP 或防禦。' },
        microwave: { ability: () => `聽力招式完全無效；每次攻擊後攻擊力 +${MICRO_ATK_UP}`, tip: '越拖越痛，用字卡招式速戰速決。' },
        bento: { ability: '打倒後會變成愛珍食便當', tip: '第一型態不要拖，後面的更硬。' },
        bento2: { ability: () => `快過期：攻擊完自己扣 ${EXPIRE_SELF} 點；速答每配對 ${EXPIRE_SPEED_EVERY} 組扣牠 ${EXPIRE_SPEED_DMG} 點`, tip: '撐住就好，牠會自己過期；速答也打得到牠。' },
        coffee: { ability: () => `太燙了：開戰燙傷 ${COFFEE_BURN} − 你的智慧；速答加成 −${SPEED_GUARD.coffee}`, tip: '加智慧或帶防燙杯套，燙傷就變小。' },
        clerk: { ability: () => `每回合換崗位，免疫一類招式；集滿 ${STAMP_NEED} 種招式點數可兌換集點卡`, tip: '看崗位換招式；集點卡可以回血、加攻擊。' },
        clerk2: { ability: () => `交班：HP 低於 ${CLERK_SHIFT_HP} 變快變強，${CLERK_CD} 回合內打不倒就下班（你輸）`, tip: '讓店員忙一點，降低他的敏捷（試試繳費單）。' }
    };
    // 圖鑑上的每一隻（兩階段的敵人拆成兩格；店員的交班也算一個型態）
    function dexForms() {
        let out = [];
        LEVELS.forEach(lv => {
            let list = lv.phases && lv.phases.length ? lv.phases : [lv];
            list.forEach((p, i) => out.push({ key: p.sprite, lv: lv.id, idx: i, name: p.name, sprite: p.sprite,
                stats: { hp: p.hp, atk: p.atk, def: p.def, agi: p.agi, int: p.int || 0, luck: p.luck || 0 }, shield: p.shield }));
            if (lv.special === 'clerk') {
                let B = CLERK_SHIFT_BUFF;
                out.push({ key: 'clerk2', lv: lv.id, idx: 1, name: lv.name + '（交班）', sprite: lv.sprite, form2: true,
                    stats: { hp: '≤' + Math.min(lv.hp, CLERK_SHIFT_HP - 1 + B.heal), atk: lv.atk + B.atk, def: lv.def, agi: lv.agi + B.agi, int: (lv.int || 0) + B.int, luck: lv.luck || 0 } });
            }
        });
        return out.map(f => {
            let t = DEX_TEXT[f.key] || {};
            let ab = typeof t.ability === 'function' ? t.ability() : t.ability;
            return Object.assign(f, { ability: ab || '', tip: t.tip || '' });
        });
    }
    // 情蒐完成的獎勵（等級已滿：經驗值改成等量的冒險代幣）
    function dexReward(lv, xpNow) {
        let xp = Math.max(1, Math.round((lv.xp || 0) * DEX_REWARD.xpRate));
        let full = levelOf(xpNow || 0) >= XP_NEED.length;
        return full ? { shards: DEX_REWARD.shards + xp, xp: 0, swapped: xp } : { shards: DEX_REWARD.shards, xp };
    }
    // 稱號的經驗值加成（無條件進位）
    function titleXp(x, title) { let t = TITLES[title]; return t && t.xpPct ? Math.ceil(x * (100 + t.xpPct) / 100) : x; }
    // 連擊倍率（只有訓練模式）：連續答對 5／10／20 題 → 攻擊力 ×2／×5／×10；答錯歸 0
    const COMBO_STEPS = [{ at: 20, mul: 10 }, { at: 10, mul: 5 }, { at: 5, mul: 2 }];
    // ── 特殊能力積木（traits）：新敵人用這些組合，不用再寫程式 ──
    //   每個 trait：{ type, ... }，可以放在關卡資料的 traits: [...] 裡
    const TRAIT_TYPES = {
        moveMod:     { label: '招式傷害增減', fields: 'moveType（card/listen/speed/all）, value（每一下 +/−）' },
        moveCap:     { label: '招式抗性（每下最多幾點）', fields: 'moveType, value' },
        immune:      { label: '招式免疫', fields: 'moveType' },
        speedGuard:  { label: '速答加成減少', fields: 'value' },
        speedPunish: { label: '速答答對會傷害敵人', fields: 'every（每配對幾組）, value（扣幾點，無視護盾）' },
        onAttack:    { label: '攻擊後機率觸發', fields: 'chance（0~100）, effect（enemyAtk/playerAtk/playerDef/enemyHeal/playerHurt）, value, once' },
        onPlayerMiss:{ label: '招式失敗時反擊', fields: 'value（無視防禦）' },
        burn:        { label: '燙傷', fields: 'when（start 開戰／round 每回合開始）, value, minusInt（減去雞塊智慧）' },
        ignoreShield:{ label: '攻擊無視護盾', fields: '' },
        regen:       { label: '攻擊後回血', fields: 'value' },
        seal:        { label: '回合開始封印招式', fields: 'count' }
    };

    // ═════════ 公式 ═════════
    function levelOf(xp) { let n = 0; while (n < XP_NEED.length && xp >= XP_NEED[n]) n++; return n; }
    function upMax(key) { return Math.max(0, STAT_MAX - (BASE_STATS[key] || 0)); }
    function moveByKey(k) { return MOVES.find(m => m.key === k); }
    function rarityKey(key) { return MOVE_RARITY[key] || 'common'; }
    function rarity(key) { return RARITY[rarityKey(key)]; }
    function masteryLevel(key, uses) {
        uses = Math.max(0, parseInt(uses) || 0);
        let cap = rarity(key).cap, lvl = 0;
        while (lvl < cap && uses >= MASTERY_STEPS[lvl]) lvl++;
        return lvl;
    }
    function masteryPerLv(key) { return rarityKey(key) === 'legend' ? 2 : 1; }
    function masteryAtk(key, lvl) { return (lvl || 0) * masteryPerLv(key); }
    // 幸運：擲幣次數 = (自己的幸運 − 對方的幸運) ÷ 2 無條件捨去（最少 0）；每個正面 +1，最多 +3
    function luckDice(myLuck, foeLuck) { return Math.max(0, Math.floor((myLuck - foeLuck) / 2)); }
    function rollLuck(myLuck, foeLuck, rng) {
        let flips = [];
        for (let i = 0; i < luckDice(myLuck, foeLuck); i++) flips.push(R(rng) < 0.5);
        return { flips, bonus: Math.min(LUCK_CAP, flips.filter(Boolean).length) };
    }
    // 護盾：智慧 ÷ 2 無條件捨去，最多 10
    function shieldMax(int) { return Math.min(SHIELD_CAP, Math.floor(Math.max(0, int || 0) / 2)); }
    // 每題作答秒數：15 秒 + 我方智慧；敵人智慧比我方高時，再扣掉差額（至少 5 秒）
    function answerSecs(myInt, foeInt) { return Math.max(5, BASE_SECS + myInt - Math.max(0, foeInt - myInt)); }
    // 受到傷害：先扣護盾，剩下的才扣體力
    function takeDamage(t, dmg, ignoreShield) {
        let absorbed = ignoreShield ? 0 : Math.min(t.shield || 0, dmg);
        t.shield = (t.shield || 0) - absorbed;
        t.hp = Math.max(0, t.hp - (dmg - absorbed));
        return { absorbed, loss: dmg - absorbed };
    }
    // 連續行動次數：(我方敏捷 − 敵方敏捷) ÷ 2，無條件捨去後 +1，至少 1 次
    function actionCount(myAgi, foeAgi) { return Math.max(1, Math.floor((myAgi - foeAgi) / 2) + 1); }
    // 傷害：攻擊力 + 招式威力 − 對方防禦，至少 1
    function damage(atk, power, def) { return Math.max(1, atk + power - def); }
    // 速答招式設定：秒數 = 20 + 熟練度加的秒數 +（雞塊智慧 − 敵人智慧），最少 10 秒
    function speedCfg(m, lvl, myInt, foeInt) {
        let c = m.speed; lvl = lvl || 0;
        let diff = (myInt || 0) - (foeInt || 0);
        return { label: c.label, stat: c.stat, every: c.every, pen: c.pen, base: c.secs + lvl * c.lvSecs, secs: Math.max(SPEED_MIN_SECS, c.secs + lvl * c.lvSecs + diff), cap: Math.min(c.maxCap, c.cap + lvl * c.lvCap) };
    }
    // 愛珍食便當：速答配對 pairs 組，牠要扣幾點（無視護盾）：每配對 2 組扣 1 點
    function expireSpeedDmg(pairs) { return Math.floor(Math.max(0, pairs || 0) / EXPIRE_SPEED_EVERY) * EXPIRE_SPEED_DMG; }
    function speedBonus(pairs, cfg) { return Math.min(cfg.cap, Math.floor(pairs / cfg.every)); }
    function playerStats(up) {
        let s = {};
        STAT_KEYS.forEach(k => { s[k] = BASE_STATS[k] + ((up && up[k]) || 0); });
        return s;
    }
    // 打贏的經驗值：舊關卡（打贏過的）只有 70%；每天第一場 ×2
    function winXp(lv, old, dbl) { let x = Math.max(1, Math.round((lv.xp || 0) * (old ? OLD_XP_RATE : 1))); return x * (dbl ? 2 : 1); }
    // 打輸的經驗值：勝利經驗值（舊關卡算 70%、不乘每日 ×2）的 20%，至少 1
    function loseXp(lv, old) { return Math.max(1, Math.round(winXp(lv, old, false) * LOSE_XP_RATE)); }

    // 連擊倍率
    function comboMul(n) { let s = COMBO_STEPS.find(x => (n || 0) >= x.at); return s ? s.mul : 1; }
    // 木人 → 關卡資料（給 initBattle 用）
    function dummyLevel(d) {
        if (typeof d === 'string') d = DUMMIES.find(x => x.key === d);
        if (!d) return null;
        return { id: 'T_' + d.key, name: d.name, sprite: d.sprite, hp: d.hp, atk: 0, agi: d.agi || 0, def: d.def || 0, int: 0, luck: 0, shield: 0, moveName: '', movePower: 0, special: '', traits: (d.traits || []).map(t => Object.assign({}, t)), noAttack: true, dummy: d.key };
    }
    function dummyUnlocked(d, cleared) { if (typeof d === 'string') d = DUMMIES.find(x => x.key === d); return !!d && isUnlocked(d.unlock || 0, cleared); }
    // 木人受損的樣子：0 完整（100%～50%）／1 裂痕（50%～30%）／2 缺一塊（30% 以下）
    function dummyStage(hp, max) { let r = max ? hp / max : 1; return r > 0.5 ? 0 : r > 0.3 ? 1 : 2; }
    // 訓練：每一題答完呼叫一次（答對 +1、答錯歸 0）；回傳新的連對數
    function comboAnswer(st, ok) { if (!st.training) return 0; st.combo = ok ? (st.combo || 0) + 1 : 0; return st.combo; }
    function critOn(hitPct) { return hitPct !== null && hitPct !== undefined && hitPct >= CRIT_AT; }
    // 打完第幾關才拿得到（Infinity = 1～20 關都拿不到）
    function moveUnlockAt(key) {
        let m = moveByKey(key); if (!m || m.hidden) return Infinity;
        if (m.buy.kind === 'free') return 0;
        if (m.buy.kind === 'reward') return m.buy.level;
        if (m.buy.kind === 'shards') return m.buy.open || (rarityKey(key) === 'legend' ? 20 : 0);
        return Infinity;
    }
    function gearUnlockAt(key) {
        if (SHOP_OPEN[key] !== undefined) return SHOP_OPEN[key];
        let lv = LEVELS.find(l => l.firstItem === key);
        return lv ? lv.id : Infinity;
    }
    // 解鎖了沒：at = moveUnlockAt／gearUnlockAt 的結果；cleared = 存檔的通關紀錄 { 關卡編號: true }
    //   0 = 一開始就有；Infinity = 拿不到；其他 = 要打完第 at 關
    function isUnlocked(at, cleared) { return at === 0 || (Number.isFinite(at) && !!(cleared && cleared[at])); }
    // 打完第 cleared 關時，拿得到哪些招式、裝備
    function unlocks(cleared) {
        return { moves: MOVES.filter(m => moveUnlockAt(m.key) <= cleared).map(m => m.key), gear: Object.keys(ITEMS).filter(k => gearUnlockAt(k) <= cleared) };
    }

    // ═════════ 戰鬥狀態 ═════════
    // 敵人資料：護盾 = 智慧 ÷ 2；有特別指定 shield 的（御飯糰 12 點）照指定
    function makeEnemy(d) {
        let sh = (typeof d.shield === 'number') ? d.shield : shieldMax(d.int);
        return { name: d.name, sprite: d.sprite, special: d.special || '', traits: (d.traits || []).map(t => Object.assign({}, t)), hp: d.hp, max: d.hp, atk: d.atk, agi: d.agi, def: d.def, int: d.int || 0, shield: sh, shieldMax: sh, luck: d.luck || 0, hits: d.hits || 1, moveName: d.moveName || '攻擊', movePower: d.movePower || 0, noAttack: !!d.noAttack };
    }
    // 裝備加的能力（只在戰鬥中）：防燙杯套 智慧 +3
    function gearStatBonus(gear, key) { return key === 'int' && (gear || []).includes('coaster') ? COASTER_INT : 0; }
    // 彈珠汽水：戰鬥勝利後 HP +1（不超過上限；已經倒下不算）
    function winHeal(gear, hp, max) { return (gear || []).includes('soda') && hp > 0 && hp < max ? 1 : 0; }
    function hasGear(st, k) { return Array.isArray(st.gear) && st.gear.includes(k); }
    function traitsOf(st, type) { return ((st.enemy && st.enemy.traits) || []).filter(t => t.type === type); }
    function typeMatch(t, type) { return !t.moveType || t.moveType === 'all' || t.moveType === type; }

    // 開戰：把戰鬥狀態寫進 st（app.js 傳 adv 進來；模擬器傳一個新物件）
    //   o = { level, stats, hp, gear:[鍵], moves:[招式物件或鍵], mastery:{鍵:等級}, critOn }
    function initBattle(st, o) {
        let s = o.stats, lv = o.level;
        st.level = lv;
        st.moves = (o.moves || []).map(m => typeof m === 'string' ? moveByKey(m) : m).filter(Boolean);
        st.mastery = Object.assign({}, o.mastery || {});
        st.player = { hp: Math.min(o.hp === undefined ? s.hp : o.hp, s.hp), max: s.hp, atk: s.atk, agi: s.agi, def: s.def, int: s.int, luck: s.luck, shield: shieldMax(s.int), shieldMax: shieldMax(s.int) };
        st.phases = Array.isArray(lv.phases) && lv.phases.length ? lv.phases : [lv];
        st.phase = 0;
        st.enemy = makeEnemy(st.phases[0]);
        st.sealed = [];
        st.round = 1;
        st.gear = (o.gear || []).filter(Boolean);
        if (gearStatBonus(st.gear, 'int')) { st.player.int += gearStatBonus(st.gear, 'int'); st.player.shield = st.player.shieldMax = shieldMax(st.player.int); }   // 防燙杯套：智慧 +3
        if (hasGear(st, 'bag')) { st.player.shield += BAG_SHIELD; st.player.shieldMax += BAG_SHIELD; }
        st.critOn = !!o.critOn;
        st.itemUsed = false;
        st.flowerUsed = {};
        st.stamps = new Set(); st.redeemed = false; st.stampTold = false;   // 店員：集點卡
        st.post = null; st.shifted = false; st.cd = 0; st.cdFresh = false; st.billNext = false;
        st.nextAtk = 0; st.intBuff = 0;
        st.actionsLeft = 0; st.actionsTotal = 0;
        st.traitOnce = {};
        // 訓練模式：10 回合、雞塊不扣血、不能用道具、連擊倍率
        st.training = !!o.training;
        st.combo = 0;
        st.trainRounds = TRAIN_ROUNDS;
        return st;
    }

    // 這一刻敵人免疫的招式類型
    function immuneType(st) {
        if (st.enemy && st.enemy.special === 'clerk' && st.post) return st.post.immune === 'speed' ? '' : st.post.immune;
        let legacy = IMMUNE[st.enemy && st.enemy.special] || '';
        if (legacy) return legacy;
        let t = traitsOf(st, 'immune')[0];
        return t ? t.moveType : '';
    }
    function isImmune(st, type) {
        if (immuneType(st) === type) return true;
        return traitsOf(st, 'immune').some(t => t.moveType === type);
    }
    // 速答招式的加成會被扣掉幾點
    function speedGuard(st) {
        let sp = st.enemy && st.enemy.special, g = 0;
        if (sp === 'clerk') g = st.post && st.post.immune === 'speed' && !st.shifted ? CLERK_SPEED_GUARD : 0;
        else g = SPEED_GUARD[sp] || 0;
        traitsOf(st, 'speedGuard').forEach(t => { g += t.value || 0; });
        return Math.max(0, g);
    }
    // 這招每一下的傷害：攻擊力 + 招式威力 + 熟練度 − 對方防禦（至少 1）；茶葉蛋被字卡打時 +2
    function hitDamage(st, m) {
        let bonus = (st.enemy.special === 'egg' && m.type === 'card') ? EGG_CARD_BONUS : 0;
        let wk = WEAK_BONUS[st.enemy.special];
        if (wk && wk.type === m.type) bonus += wk.bonus;
        // 積木「招式傷害增減」：加傷算進威力；減傷是最後才扣（可以扣到 0，不受「最少 1 點」保護）
        let cut = 0;
        traitsOf(st, 'moveMod').forEach(t => { if (!typeMatch(t, m.type)) return; let v = t.value || 0; if (v >= 0) bonus += v; else cut += -v; });
        bonus += st.nextAtk || 0;               // 蓄力：下一招攻擊 +N
        let pow = m.power + masteryAtk(m.key, st.mastery[m.key]) + bonus;
        // 訓練：先算原本的傷害（攻擊＋威力）× 連擊倍率，「再」扣木人的防禦（鐵木人）；最少 1 點
        let d = st.training ? Math.max(1, (st.player.atk + pow) * comboMul(st.combo) - st.enemy.def) : damage(st.player.atk, pow, st.enemy.def);
        return Math.max(0, d - cut);
    }
    // 這招每一下最多幾點（抗性）；沒有限制回傳 Infinity
    function hitCap(st, m) {
        let cap = RESIST[st.enemy.special] === m.type ? 1 : Infinity;
        traitsOf(st, 'moveCap').forEach(t => { if (typeMatch(t, m.type)) cap = Math.min(cap, t.value || 0); });
        return cap;
    }
    function enemyIgnoresShield(st) { return !!IGNORE_SHIELD[st.enemy.special] || traitsOf(st, 'ignoreShield').length > 0; }
    function sealCount(st) {
        if (st.enemy.special === 'seal') return 2;
        let t = traitsOf(st, 'seal')[0];
        return t ? (t.count || 1) : 0;
    }
    function shuffle(a, rng) {
        a = a.slice();
        for (let i = a.length - 1; i > 0; i--) { let j = Math.floor(R(rng) * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
        return a;
    }
    function moreGearShield(st) { return hasGear(st, 'bag') ? BAG_SHIELD : 0; }

    // ═════════ 不需要答題的動作 ═════════
    function canBoba(st) { return !st.training && hasGear(st, 'boba') && !st.itemUsed && (st.round || 1) >= 2 && st.player.hp <= BOBA_HP_AT && st.player.hp < st.player.max; }
    function useBoba(st) { if (!canBoba(st)) return 0; st.itemUsed = true; let b = st.player.hp; st.player.hp = Math.min(st.player.max, st.player.hp + 1); return st.player.hp - b; }
    function canRedeem(st) { return st.enemy.special === 'clerk' && st.stamps && st.stamps.size >= STAMP_NEED && !st.redeemed; }
    function redeemStamps(st) {
        if (!canRedeem(st)) return null;
        st.redeemed = true;
        st.player.atk += STAMP_ATK;
        let before = st.player.hp;
        st.player.hp = Math.min(st.player.max, st.player.hp + STAMP_HEAL);
        return { atk: STAMP_ATK, heal: st.player.hp - before };
    }
    // 農場道具：nectar 花蜜（護盾 +2，可以超過上限）／crown 花環（攻擊 +1）
    function useFlower(st, k) {
        if (!st.flowerUsed) st.flowerUsed = {};
        if (st.flowerUsed[k]) return false;
        st.flowerUsed[k] = true;
        if (k === 'nectar') { st.player.shield = (st.player.shield || 0) + NECTAR_SHIELD; st.player.shieldMax = Math.max(st.player.shieldMax || 0, st.player.shield); }
        else st.player.atk += CROWN_ATK;
        return true;
    }
    // 這回合結束出招：回傳 true = 輪到敵人
    function endAction(st) { st.actionsLeft--; return st.actionsLeft <= 0; }

    // ═════════ 戰鬥流程（產生器：yield 事件）═════════
    //   事件裡 src 表示傷害來源（模擬器用來統計輸的原因）
    function openingKind(st) {
        if (st.enemy.special === 'coffee') return 'coffee';
        if (st.enemy.special === 'ring') return 'ring';
        return '';
    }
    // 開戰的效果（美式咖啡燙傷、burn 積木的開戰燙傷）
    function* opening(st) {
        if (st.enemy.special === 'coffee') {
            let dmg = Math.max(0, COFFEE_BURN - st.player.int);
            let r = takeDamage(st.player, dmg);          // 先扣護盾，剩下的才扣體力
            yield { t: 'coffee', dmg, r, src: 'coffee' };
            if (st.player.hp <= 0) { yield { t: 'lose', why: 'hp', src: 'coffee' }; return; }
        }
        for (let tr of traitsOf(st, 'burn').filter(x => x.when !== 'round')) {
            let dmg = Math.max(0, (tr.value || 0) - (tr.minusInt ? st.player.int : 0));
            st.player.hp = Math.max(0, st.player.hp - dmg);
            yield { t: 'trait', kind: 'burn', target: 'player', dmg, text: `🔥 燙傷！雞塊受到 ${dmg} 點傷害`, float: dmg ? '-' + dmg : '燙！', src: 'burn' };
            if (st.player.hp <= 0) { yield { t: 'lose', why: 'hp', src: 'burn' }; return; }
        }
    }
    // 套圈圈開場「天女散花」：pairs = 15 秒內配對的組數
    function* ringResult(st, pairs) {
        let miss = Math.max(0, RING_NEED - pairs);
        if (!miss) { yield { t: 'ringDodge', pairs }; return; }
        yield { t: 'ringThrow', pairs, miss };
        let r = takeDamage(st.player, miss);
        yield { t: 'ringHit', pairs, miss, r, src: 'ring' };
        if (st.player.hp <= 0) yield { t: 'lose', why: 'hp', src: 'ring' };
    }
    // 回合開始；isBlocked(招式) = 這招因為題庫／瀏覽器不能用（模擬器不用傳）
    function* beginRound(st, rng, isBlocked) {
        if (st.enemy.special === 'clerk') {
            if (st.shifted) {
                if (st.cdFresh) st.cdFresh = false; else st.cd--;
                if (st.cd <= 0) { yield { t: 'lose', why: 'shift', src: 'shift' }; return; }
            } else {
                st.post = CLERK_POSTS[Math.floor(R(rng) * CLERK_POSTS.length)];
            }
        }
        if (st.round > 1) {
            for (let tr of traitsOf(st, 'burn').filter(x => x.when === 'round')) {
                let dmg = Math.max(0, (tr.value || 0) - (tr.minusInt ? st.player.int : 0));
                if (!dmg) continue;
                st.player.hp = Math.max(0, st.player.hp - dmg);
                yield { t: 'trait', kind: 'burn', target: 'player', dmg, text: `🔥 燙傷發作！雞塊受到 ${dmg} 點傷害`, float: '-' + dmg, src: 'burn' };
                if (st.player.hp <= 0) { yield { t: 'lose', why: 'hp', src: 'burn' }; return; }
            }
        }
        st.actionsTotal = actionCount(st.player.agi, st.enemy.agi);
        st.actionsLeft = st.actionsTotal;
        st.sealed = [];
        let n = sealCount(st);
        if (n) {
            // 只封印「本來能用」的招式，而且一定留至少 1 招能用
            let keys = shuffle(st.moves.filter(m => !(isBlocked && isBlocked(m))).map(m => m.key), rng);
            st.sealed = keys.slice(0, Math.min(n, Math.max(0, keys.length - 1)));
        }
        yield { t: 'menu' };                     // app.js：這時候畫出招式選單
        if (st.enemy.special === 'clerk' && !st.shifted && st.post) yield { t: 'post', post: st.post };
        if (st.billNext) { st.billNext = false; yield { t: 'billSlow' }; }
        if (st.sealed.length) yield { t: 'seal', keys: st.sealed.slice() };
    }
    // 敵人倒下：還有下一階段就換人（回傳 false），沒有就勝利（回傳 true）
    function* enemyDown(st) {
        if (st.enemy.hp > 0) return false;
        if (st.training) { yield { t: 'trainEnd', dmg: st.enemy.max, full: true, round: st.round }; return true; }   // 木人打到 0（999 全打完）
        if (st.phases && st.phase < st.phases.length - 1) {
            let old = st.enemy;
            st.phase++;
            let nxt = makeEnemy(st.phases[st.phase]);
            yield { t: 'phaseOut', old, next: nxt };
            st.enemy = nxt;
            // 新的敵人登場：行動次數依新敵人的敏捷重新計算（+1 是因為打倒上一隻的這一招等一下會扣掉 1 次）
            st.actionsTotal = actionCount(st.player.agi, nxt.agi);
            st.actionsLeft = st.actionsTotal + 1;
            st.sealed = [];
            yield { t: 'phaseIn', enemy: nxt };
            return false;
        }
        yield { t: 'win' };
        return true;
    }
    // 店員：HP 低於 20 → 交班（敏捷 +6、智慧 +4、攻擊 +3、HP +10；帶繳費單的話敏捷只剩 5、幸運 0）
    function* clerkShift(st) {
        let e = st.enemy;
        if (!e || e.special !== 'clerk' || st.shifted || e.hp <= 0 || e.hp >= CLERK_SHIFT_HP) return;
        st.shifted = true; st.post = null; st.cd = CLERK_CD; st.cdFresh = true;
        let B = CLERK_SHIFT_BUFF;
        e.agi += B.agi; e.int += B.int; e.atk += B.atk; e.hp = Math.min(e.max, e.hp + B.heal);
        e.shieldMax = shieldMax(e.int); e.shield = e.shieldMax;
        yield { t: 'shift' };
        if (hasGear(st, 'bill')) {
            e.agi = 5; e.luck = 0; st.billNext = true;
            yield { t: 'bill' };
        }
    }
    // 出招結算：ok = 題目全部答對
    //   ⚠️ 熟練度的累積在 app.js（存檔）；這裡讀 st.mastery[招式] 當作目前等級
    function* playerMove(st, m, ok, rng) {
        if (ok) {
            yield { t: 'moveOk', move: m };
            if (st.enemy.special === 'clerk' && st.stamps && !st.stamps.has(m.type)) {   // 店員：集點
                st.stamps.add(m.type);
                yield { t: 'stamp', type: m.type };
            }
            // 每一下各自計算，各自擲一次幸運幣
            let pierce = hasGear(st, 'skewer');         // 竹籤：無視對方護盾
            for (let h = 0; h < m.hits; h++) {
                yield { t: 'attack', move: m, h };
                let dmg = hitDamage(st, m);
                let luck = rollLuck(st.player.luck, st.enemy.luck, rng);
                if (luck.flips.length) { yield { t: 'coins', who: 'player', luck, h, hits: m.hits }; dmg += luck.bonus; }
                // 命中加成：每次攻擊多 1 次爆擊判定（跟幸運幣分開算）
                if (st.critOn) {
                    let f = R(rng) < 0.5, crit = { flips: [f], bonus: f ? 1 : 0 };
                    yield { t: 'coins', who: 'player', luck: crit, h, hits: m.hits, crit: true };
                    dmg += crit.bonus;
                }
                let immune = isImmune(st, m.type);
                let cap = hitCap(st, m);
                let guarded = immune || cap < Infinity;
                if (immune) dmg = 0;
                else if (guarded) dmg = Math.min(dmg, cap);
                let wk = WEAK_BONUS[st.enemy.special];
                let weak = !!(wk && wk.type === m.type && dmg > 0);
                let hadShield = st.enemy.shield > 0;
                let r = takeDamage(st.enemy, dmg, pierce);
                yield { t: 'enemyHurt', move: m, h, dmg, r, immune, guarded, weak, pierce: pierce && hadShield };
                if (st.enemy.hp <= 0) {
                    if (yield* enemyDown(st)) return;
                    break;                               // 換下一個敵人：這招剩下的攻擊不再繼續
                }
                yield* clerkShift(st);
            }
            if (st.enemy.special === 'clerk' && st.stamps && st.stamps.size >= STAMP_NEED && !st.redeemed && !st.stampTold) {
                st.stampTold = true;
                yield { t: 'stampsFull' };
            }
        } else {
            yield { t: 'miss', move: m };
            // 裝備「烤焦臭豆腐」：招式失敗時雙方各扣 1 點體力
            if (hasGear(st, 'tofu')) {
                let er = takeDamage(st.enemy, 1), pr = st.training ? { absorbed: 0, loss: 0 } : takeDamage(st.player, 1);   // 訓練：雞塊不扣血
                yield { t: 'tofu', er, pr, src: 'tofu' };
                if (st.player.hp <= 0 && st.enemy.hp > 0) { yield { t: 'lose', why: 'hp', src: 'tofu' }; return; }
                if (st.enemy.hp <= 0) { if (yield* enemyDown(st)) return; }
                if (st.player.hp <= 0) { yield { t: 'lose', why: 'hp', src: 'tofu' }; return; }
                yield* clerkShift(st);
            }
            // 臭豆腐的「發臭」：招式失敗就被臭味反擊，無視防禦，固定 1 點
            if (st.enemy.special === 'stink') {
                let r = takeDamage(st.player, 1);
                yield { t: 'stink', r, src: 'stink' };
                if (st.player.hp <= 0) { yield { t: 'lose', why: 'hp', src: 'stink' }; return; }
            }
            for (let tr of traitsOf(st, 'onPlayerMiss')) {
                let v = tr.value || 1;
                let r = takeDamage(st.player, v);
                yield { t: 'trait', kind: 'onPlayerMiss', target: 'player', r, text: `😈 ${st.enemy.name}趁機反擊！雞塊受到 ${r.loss} 點傷害`, src: 'trait' };
                if (st.player.hp <= 0) { yield { t: 'lose', why: 'hp', src: 'trait' }; return; }
            }
        }
        st.nextAtk = 0;                           // 蓄力的加成只給「下一招」
        yield { t: 'moveEnd' };
    }
    // 速答招式結束：pairs = 配對成功的組數；cfg = speedCfg(...) 開始時算好的設定
    function* speedEnd(st, m, pairs, cfg) {
        if (st.training && pairs > 0) st.combo = (st.combo || 0) + pairs;   // 訓練：速答答對的題數也累積連對（答錯不歸 0）
        let raw = speedBonus(pairs, cfg), guard = speedGuard(st), got = Math.max(0, raw - guard);
        let applied = got;
        if (m.speed.stat === 'int') {
            applied = Math.max(0, Math.min(got, cfg.cap - (st.intBuff || 0)));    // 冥想：一場戰鬥加的智慧合計不超過上限
            if (applied) {
                st.intBuff = (st.intBuff || 0) + applied;
                st.player.int += applied;
                let newMax = shieldMax(st.player.int) + moreGearShield(st);
                if (newMax > (st.player.shieldMax || 0)) { st.player.shield += newMax - st.player.shieldMax; st.player.shieldMax = newMax; }
            }
        } else {
            st.nextAtk = Math.max(st.nextAtk || 0, got);
        }
        if (st.enemy.special === 'clerk' && st.stamps && pairs > 0 && !st.stamps.has(m.type)) st.stamps.add(m.type);
        yield { t: 'speedResult', move: m, pairs, raw, guard, got, applied, cap: cfg.cap, combo: st.combo };
        // 愛珍食便當：速答答對會扣牠體力（扣幾點看 expireSpeedDmg）
        let exDmg = st.enemy.special === 'expire' ? expireSpeedDmg(pairs) : 0;
        if (exDmg > 0) {
            let r = takeDamage(st.enemy, exDmg, true);
            yield { t: 'speedHurt', dmg: exDmg, r };
            if (st.enemy.hp <= 0) { if (yield* enemyDown(st)) return; }
        }
        for (let tr of traitsOf(st, 'speedPunish')) {
            let dmg = Math.floor(pairs / Math.max(1, tr.every || 1)) * (tr.value || 1);
            if (!dmg) continue;
            let r = takeDamage(st.enemy, dmg, true);
            yield { t: 'speedHurt', dmg, r, trait: true };
            if (st.enemy.hp <= 0) { if (yield* enemyDown(st)) return; }
        }
        yield { t: 'speedEnd' };
    }
    // 積木：敵人攻擊後機率觸發
    function* onAttackTraits(st, rng) {
        for (let tr of traitsOf(st, 'onAttack')) {
            let key = JSON.stringify(tr);
            if (tr.once && st.traitOnce[key]) continue;
            let ch = tr.chance === undefined ? 100 : tr.chance;
            if (ch <= 0) continue;                                   // 0%：不擲骰，直接跳過
            if (ch < 100 && R(rng) * 100 >= ch) continue;            // 100%：一定觸發，也不擲骰
            st.traitOnce[key] = true;
            let v = tr.value || 0, e = st.enemy, p = st.player, ev = { t: 'trait', kind: 'onAttack', effect: tr.effect, value: v };
            if (tr.effect === 'enemyAtk') { e.atk += v; ev.target = 'enemy'; ev.text = `🔥 ${e.name}攻擊力 ${v >= 0 ? '+' : ''}${v}（現在 ${e.atk}）`; ev.float = `攻擊 ${v >= 0 ? '+' : ''}${v}`; }
            else if (tr.effect === 'playerAtk') { p.atk += v; ev.target = 'player'; ev.text = `💫 雞塊攻擊力 ${v >= 0 ? '+' : ''}${v}（現在 ${p.atk}）`; ev.float = `攻擊 ${v >= 0 ? '+' : ''}${v}`; }
            else if (tr.effect === 'playerDef') { p.def += v; ev.target = 'player'; ev.text = `💫 雞塊防禦 ${v >= 0 ? '+' : ''}${v}（現在 ${p.def}）`; ev.float = `防禦 ${v >= 0 ? '+' : ''}${v}`; }
            else if (tr.effect === 'enemyHeal') { let b = e.hp; e.hp = Math.min(e.max, e.hp + v); ev.target = 'enemy'; ev.text = `💚 ${e.name}回復 ${e.hp - b} 點體力`; ev.float = '+' + (e.hp - b); }
            else if (tr.effect === 'playerHurt') { let r = takeDamage(p, v, true); ev.target = 'player'; ev.r = r; ev.src = 'trait'; ev.text = `💥 追加傷害！雞塊受到 ${r.loss} 點傷害`; ev.float = '-' + r.loss; }
            yield ev;
            if (p.hp <= 0) { yield { t: 'lose', why: 'hp', src: 'trait' }; return true; }
        }
        return false;
    }
    // 敵人的回合
    function* enemyPhase(st, rng) {
        if (st.enemy.noAttack) {                  // 木人不會攻擊
            st.round++;
            yield { t: 'roundEnd' };
            if (st.training && st.round > st.trainRounds) yield { t: 'trainEnd', dmg: st.enemy.max - st.enemy.hp, full: false, round: st.round - 1 };
            return;
        }
        let n = actionCount(st.enemy.agi, st.player.agi);
        for (let i = 0; i < n; i++) {
            yield { t: 'enemyTurn', i, n };
            if (st.enemy.special === 'pinball') {
                let r = 1 + Math.floor(R(rng) * 6);
                if (r <= 2) {
                    st.enemy.hp = Math.min(st.enemy.max, st.enemy.hp + 2);
                    yield { t: 'pinball', r, effect: 'heal' };
                } else if (r <= 4) {
                    yield { t: 'pinball', r, effect: 'none' };
                } else {
                    let pr = takeDamage(st.player, 1);
                    yield { t: 'pinball', r, effect: 'hit', r2: pr, src: 'pinball' };
                    if (st.player.hp <= 0) { yield { t: 'lose', why: 'hp', src: 'pinball' }; return; }
                }
            }
            let eh = st.enemy.hits || 1;
            for (let hh = 0; hh < eh; hh++) {
                yield { t: 'enemyAttack', hh, eh };
                let dmg = damage(st.enemy.atk, st.enemy.movePower, st.player.def);
                let luck = rollLuck(st.enemy.luck, st.player.luck, rng);
                if (luck.flips.length) { yield { t: 'coins', who: 'enemy', luck }; dmg += luck.bonus; }
                let r = takeDamage(st.player, dmg, enemyIgnoresShield(st));
                yield { t: 'playerHurt', dmg, r, hh, eh, src: 'attack' };
                if (st.player.hp <= 0) { yield { t: 'lose', why: 'hp', src: 'attack' }; return; }
            }
            if (st.enemy.special === 'microwave') {
                st.enemy.atk += MICRO_ATK_UP;
                yield { t: 'microwave', atk: st.enemy.atk };
            }
            if (yield* onAttackTraits(st, rng)) return;
            if (st.enemy.special === 'expire') {
                st.enemy.hp = Math.max(0, st.enemy.hp - EXPIRE_SELF);
                yield { t: 'expireSelf', dmg: EXPIRE_SELF };
                if (st.enemy.hp <= 0) { yield* enemyDown(st); return; }
            }
        }
        // 珍珠奶茶的「治癒」：敵人攻擊結束後回 1 點體力
        if (st.enemy.special === 'heal' && st.enemy.hp < st.enemy.max) {
            st.enemy.hp = Math.min(st.enemy.max, st.enemy.hp + 1);
            yield { t: 'heal', value: 1 };
        }
        for (let tr of traitsOf(st, 'regen')) {
            if (st.enemy.hp >= st.enemy.max) continue;
            let b = st.enemy.hp;
            st.enemy.hp = Math.min(st.enemy.max, st.enemy.hp + (tr.value || 1));
            yield { t: 'heal', value: st.enemy.hp - b, trait: true };
        }
        st.round++;
        yield { t: 'roundEnd' };
    }
    // 一口氣跑完一個產生器（模擬器用）：回傳 { events, end: 'win'|'lose'|'' }
    function runAll(gen, onEvent) {
        let end = '', why = '', src = '';
        for (let ev of gen) {
            if (onEvent) onEvent(ev);
            if (ev.t === 'win') end = 'win';
            if (ev.t === 'lose') { end = 'lose'; why = ev.why; src = ev.src; }
            if (ev.t === 'trainEnd') end = 'train';
        }
        return { end, why, src };
    }

    const BattleCore = {
        // 資料
        BASE_STATS, STAT_KEYS, STAT_MAX, XP_NEED, OLD_XP_RATE, LOSE_XP_RATE, MAX_EQUIP, MIN_EQUIP, BASE_SECS, LUCK_CAP, SHIELD_CAP, SPEED_MIN_SECS,
        RING_NEED, RING_SECS, RING_PEN, MOVES, LEVELS, TYPE_LABEL, RARITY, MOVE_RARITY, MASTERY_STEPS,
        COFFEE_BURN, CLERK_POSTS, CLERK_SHIFT_HP, CLERK_CD, STAMP_NEED, STAMP_ATK, STAMP_HEAL, RESIST, IMMUNE, WEAK_BONUS,
        SPEED_GUARD, CLERK_SPEED_GUARD, TEA_SPEED_HEAL, EXPIRE_SPEED_DMG, EXPIRE_SPEED_EVERY, MICRO_ATK_UP, EXPIRE_SELF, EGG_CARD_BONUS, IGNORE_SHIELD,
        DUMMIES, TRAIN_ROUNDS, COMBO_STEPS, CLERK_SHIFT_BUFF, DEX_NEED, DEX_REWARD, DEX_CHAPTER_REWARD, TITLES, DEX_TEXT, ITEMS, ITEM_RARITY, SHOP_OPEN, CRIT_AT, COASTER_INT, BAG_SHIELD, BOBA_HP_AT, NECTAR_SHIELD, CROWN_ATK, TRAIT_TYPES,
        // 公式
        levelOf, upMax, moveByKey, rarityKey, rarity, masteryLevel, masteryPerLv, masteryAtk, luckDice, rollLuck, shieldMax, answerSecs,
        dexForms, dexReward, titleXp, comboMul, dummyLevel, dummyUnlocked, dummyStage, comboAnswer, critOn, moveUnlockAt, gearUnlockAt, isUnlocked, unlocks, takeDamage, actionCount, damage, speedCfg, speedBonus, expireSpeedDmg, playerStats, winXp, loseXp, makeEnemy, hasGear, gearStatBonus, winHeal, shuffle,
        // 戰鬥
        initBattle, immuneType, isImmune, speedGuard, hitDamage, hitCap, enemyIgnoresShield, sealCount,
        canBoba, useBoba, canRedeem, redeemStamps, useFlower, endAction,
        openingKind, opening, ringResult, beginRound, enemyDown, clerkShift, playerMove, speedEnd, enemyPhase, runAll
    };
    root.BattleCore = BattleCore;
    if (typeof module !== 'undefined' && module.exports) module.exports = BattleCore;
})(typeof self !== 'undefined' ? self : this);
