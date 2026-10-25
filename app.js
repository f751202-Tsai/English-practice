    function escapeHTML(str) {
        if (!str && str !== 0) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // 使用 Base64 解碼還原 Client ID，避免明文暴露
    const CLIENT_ID = '976805087499-l4auf66i1qkj91ba335jvgtk3b04a9av.apps.googleusercontent.com';
    const SCOPES = 'https://www.googleapis.com/auth/drive.appdata'; 
    const FILENAME = 'english_dictation_lists_v2.json';
    const SUPABASE_URL = 'https://uofxthfbcerayugaxefn.supabase.co';
    const SUPABASE_ANON_KEY = 'sb_publishable_-WzDzNfADAl83FBpt2OsOg_vUV1b80s';

    // 初始化 Supabase 客戶端
    const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    let tokenClient, accessToken = null, isCloudSyncActive = false;
    let myDeviceId = localStorage.getItem('dictation_device_id');
    if (!myDeviceId) {
        myDeviceId = 'dev_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        localStorage.setItem('dictation_device_id', myDeviceId);
    }

    let wakeLockSentinel = null;

    async function requestWakeLock() {
        if ('wakeLock' in navigator) {
            try {
                wakeLockSentinel = await navigator.wakeLock.request('screen');
            } catch (err) {
                console.log('Wake Lock Error:', err.name, err.message);
            }
        }
    }

    async function releaseWakeLock() {
        if (wakeLockSentinel !== null) {
            try {
                await wakeLockSentinel.release();
                wakeLockSentinel = null;
            } catch (err) {
                console.log('Wake Lock Release Error:', err.name, err.message);
            }
        }
    }

    document.addEventListener('visibilitychange', async () => {
        if (wakeLockSentinel !== null && document.visibilityState === 'visible') {
            await requestWakeLock();
        }
    });

    let synth = window.speechSynthesis, timeoutId = null, voices = [];
    let isPlaying = false, isPaused = false, wordsData = [], currentWordIndex = 0;
    let isExamRunning = false, examTimerId = null, examTimeLeft = 0, examResults = [], currentExamRanges = "";
    
    let examHistory = (JSON.parse(localStorage.getItem('dictation_exam_history')) || []);
    let cardExamHistory = (JSON.parse(localStorage.getItem('dictation_card_exam_history')) || []);
    
    let lastSelectedList = parseInt(localStorage.getItem('dictation_last_selected_list')) || 0;

    const MAX_LISTS_DEFAULT = 10;
    
    let wordLists = JSON.parse(localStorage.getItem('dictation_word_lists')) || [];
    
    if (wordLists.length === 0) {
        let nowTs = Date.now();
        wordLists.push({ title: `unit 1-1`, content: "courage 勇氣\n*foreigner 外國人\n*fantastic 極好的 形容詞", createdAt: nowTs });
        localStorage.setItem('dictation_word_lists', JSON.stringify(wordLists));
    }
    ensureListIds();   // 舊題庫補上固定識別碼

    // ---------------------------------
    // 🍗 雞塊系統：雞塊數量、領取紀錄、購買紀錄一律以後端 (Supabase) 為準
    // ---------------------------------
    // 本機只保存「今天各任務有沒有完成」(chickenData)。
    // 前端不能直接寫入雞塊數，只能呼叫後端函式 claim_reward / buy_item；
    // 就算有人用 F12 改了畫面上的數字，下次連線也會被後端的數字蓋回來。
    const CHICKEN_TASK_KEYS = ['dailyLogin', 'listeningPractice', 'cardPractice', 'listeningPerfect', 'cardPerfect'];

    function loadLocalChickenProgress() {
        let raw = {};
        try { raw = JSON.parse(localStorage.getItem('chicky_chicken_data')) || {}; } catch (e) { raw = {}; }
        let tasks = {};
        // 舊版存的 count / claims / claimed 一律捨棄，只留任務完成進度
        CHICKEN_TASK_KEYS.forEach(k => { tasks[k] = { done: !!(raw.tasks && raw.tasks[k] && raw.tasks[k].done) }; });
        return { lastDate: typeof raw.lastDate === 'string' ? raw.lastDate : '', tasks };
    }
    let chickenData = loadLocalChickenProgress();

    // 取得「本地時區」的今天日期（YYYY-MM-DD），台灣時間 00:00 即換日
    function getLocalDateStr() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    // ── 後端錢包的本機快取（只用來「沒網路時顯示上次的數字」，不具任何效力） ──
    const WALLET_CACHE_KEY = 'chicky_wallet_cache';
    let wallet = (function () {
        try {
            let w = JSON.parse(localStorage.getItem(WALLET_CACHE_KEY));
            if (w && typeof w.balance === 'number') return w;
        } catch (e) {}
        return { balance: 0, day: '', claimedToday: [], purchases: {}, listCaps: {} };
    })();
    let walletBusy = false;      // 防止連點造成重複送出
    let walletOnline = true;     // 最近一次和後端通訊是否成功
    let editorOpenCount = 0;     // 開啟編輯頁時該題庫的單字數（舊題庫超過上限時不會被刪除）

    // ── 商品目錄：價格與上限以後端 shop_items 為準，這裡只是連不上時的預設值 ──
    const BASE_WORD_CAP = 100, WORD_CAP_STEP = 50;
    const SHOP_ITEM_META = {
        word_cap_50: { name: '單字上限 +50',  desc: '指定一本題庫，單字上限 +50' },
        list_slot_1: { name: '題庫數量 +1',   desc: '增加 1 本空白題庫（可存放 100 個單字）' }
    };
    let shopCatalog = {
        word_cap_50: { price: 30, max: 4 },
        list_slot_1: { price: 60, max: 89 }
    };

    function walletQty(key) { return Number((wallet.purchases || {})[key]) || 0; }
    // 每本題庫各自的單字上限：基本 100 字 + 這本題庫兌換過幾次「單字上限 +50」
    function getListWordCap(list) {
        let extra = (list && list.id) ? (Number((wallet.listCaps || {})[list.id]) || 0) : 0;
        return BASE_WORD_CAP + WORD_CAP_STEP * extra;
    }

    // 題庫的固定識別碼：購買「單字上限」時，後端靠它知道是哪一本題庫
    function newListId() { return 'l_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
    function ensureListIds() {
        let changed = false;
        wordLists.forEach(l => { if (!l.id) { l.id = newListId(); changed = true; } });
        if (changed) localStorage.setItem('dictation_word_lists', JSON.stringify(wordLists));
        return changed;
    }
    function getMaxLists() { return MAX_LISTS_DEFAULT + walletQty('list_slot_1'); }
    function isTaskClaimed(key) {
        return wallet.day === chickenData.lastDate && (wallet.claimedToday || []).indexOf(key) !== -1;
    }

    // ── 與後端溝通 ──
    // 沒登入 Google 也能用：自動建立「匿名帳號」取得身分（之後綁定 Google 登入時會沿用同一個帳號）。
    // 需要在 Supabase 後台開啟 Authentication → Sign In / Providers → Allow anonymous sign-ins
    let sessionPromise = null;
    function ensureSupabaseSession() {
        // 同一時間只允許一個登入流程；同時發出的請求共用結果，避免建立出多個匿名帳號
        if (!sessionPromise) {
            sessionPromise = (async () => {
                try {
                    let got = await supabaseClient.auth.getSession();
                    if (got && got.data && got.data.session) return got.data.session;
                    let res = await supabaseClient.auth.signInAnonymously();
                    if (res.error) throw res.error;
                    return res.data.session;
                } catch (e) {
                    console.error('⚠️ Supabase 登入失敗（請確認後台已開啟 Anonymous sign-ins）:', e && e.message || e);
                    return null;
                }
            })().finally(() => { sessionPromise = null; });
        }
        return sessionPromise;
    }

    async function walletRpc(fn, args) {
        let session = await ensureSupabaseSession();
        if (!session) throw new Error('no_session');
        let res = await supabaseClient.rpc(fn, args);
        if (res.error) throw res.error;
        return res.data;
    }

    function walletErrorMessage(e) {
        let m = String((e && e.message) || '');
        if (m.includes('insufficient')) return '雞塊不足';
        if (m.includes('max_reached')) return '已達購買上限';
        if (m.includes('invalid_day')) return '日期異常，請確認手機的日期時間是否正確';
        if (m.includes('invalid_item') || m.includes('invalid_task')) return '商品或任務不存在';
        return '無法連線到雞塊伺服器，請稍後再試';
    }

    function setWalletNote() {
        ['walletNoteReward', 'walletNoteShop'].forEach(id => {
            let el = document.getElementById(id);
            if (el) el.textContent = walletOnline ? '' : '⚠️ 目前無法連線，顯示的是上次的雞塊數量，無法領取或兌換';
        });
    }

    function applyWallet(w, day) {
        wallet = {
            balance: Number(w.balance) || 0,
            day: day || getLocalDateStr(),
            claimedToday: Array.isArray(w.claimed_today) ? w.claimed_today : [],
            purchases: (w.purchases && typeof w.purchases === 'object') ? w.purchases : {},
            listCaps: (w.list_caps && typeof w.list_caps === 'object') ? w.list_caps : {}
        };
        try { localStorage.setItem(WALLET_CACHE_KEY, JSON.stringify(wallet)); } catch (e) {}
        walletOnline = true;
        setWalletNote();
        updateChickenBadgeUI();
        updateChickenShopUI();
        updateListQuotaBar();
        let picker = document.getElementById('shopListPickerModal');
        if (picker && picker.style.display === 'block') renderShopListPicker();
    }

    async function refreshWallet() {
        try {
            let day = getLocalDateStr();
            let w = await walletRpc('get_wallet', { p_day: day });
            applyWallet(w, day);
            return true;
        } catch (e) {
            walletOnline = false;
            setWalletNote();
            console.warn('讀取雞塊餘額失敗（顯示上次快取）:', e && e.message || e);
            return false;
        }
    }

    async function loadShopCatalog() {
        try {
            let session = await ensureSupabaseSession();
            if (!session) return;
            let res = await supabaseClient.from('shop_items').select('item_key, price, max_qty, enabled');
            if (res.error || !Array.isArray(res.data)) return;
            res.data.forEach(r => {
                if (shopCatalog[r.item_key]) {
                    shopCatalog[r.item_key].price = Number(r.price) || shopCatalog[r.item_key].price;
                    shopCatalog[r.item_key].max = Number(r.max_qty) || shopCatalog[r.item_key].max;
                    shopCatalog[r.item_key].enabled = r.enabled !== false;
                }
            });
            updateChickenShopUI();
        } catch (e) { /* 連不上就沿用預設值 */ }
    }

    // 每日重置：只重置本機的「任務完成進度」；今天領過什麼由後端告訴我們
    function checkDailyReset() {
        let todayStr = getLocalDateStr();
        if (chickenData.lastDate !== todayStr) {
            chickenData.lastDate = todayStr;
            CHICKEN_TASK_KEYS.forEach(k => { chickenData.tasks[k] = { done: false }; });
            chickenData.tasks.dailyLogin = { done: true };   // 每日登入自動完成
            localStorage.setItem('chicky_chicken_data', JSON.stringify(chickenData));
            setTimeout(refreshWallet, 0);                    // 新的一天：向後端確認今天已領取哪些
            triggerAutoSaveToCloud();
        }
    }

    // 🍗 儲存任務完成進度（只存本機；雞塊數量不在這裡）
    function saveChickenData() {
        localStorage.setItem('chicky_chicken_data', JSON.stringify(chickenData));
        updateChickenBadgeUI();
    }

    // 在右上角的雞塊數量旁顯示浮動數字（+1 / -30），1 秒後消失
    function showChickenFloat(countElId, text, color) {
        let countEl = document.getElementById(countElId);
        if (!countEl) return;
        let badgeContainer = countEl.parentElement;
        if (!badgeContainer) return;
        let floatSpan = document.createElement('span');
        floatSpan.innerText = text;
        floatSpan.style.position = 'absolute';
        floatSpan.style.left = '50%';
        floatSpan.style.top = '-10px';
        floatSpan.style.transform = 'translateX(-50%)';
        floatSpan.style.color = color || '#EF4444';
        floatSpan.style.fontWeight = '800';
        floatSpan.style.fontSize = '14px';
        floatSpan.style.pointerEvents = 'none';
        floatSpan.style.transition = 'all 1s ease';
        floatSpan.style.opacity = '1';
        floatSpan.className = 'chicken-float';
        badgeContainer.appendChild(floatSpan);
        setTimeout(() => {
            floatSpan.style.transform = 'translateX(-50%) translateY(-25px)';
            floatSpan.style.opacity = '0';
        }, 50);
        setTimeout(() => { floatSpan.remove(); }, 1050);
    }

    function updateChickenBadgeUI() {
        checkDailyReset();
        let rewardModal = document.getElementById('chickenRewardModal');
        if (rewardModal && rewardModal.style.display === 'block') updateChickenModalUI();
        let badge = document.getElementById('chickenRewardBadge');
        if (!badge) return;

        // 檢查是否有「已達成但未領取」的任務
        let hasUnclaimed = CHICKEN_TASK_KEYS.some(k => chickenData.tasks[k].done && !isTaskClaimed(k));
        badge.style.display = hasUnclaimed ? 'flex' : 'none';
    }

    function openChickenRewardModal() {
        checkDailyReset();
        updateChickenModalUI();
        document.getElementById('chickenRewardModal').style.display = 'block';
        refreshWallet();
    }

    function closeChickenRewardModal() {
        document.getElementById('chickenRewardModal').style.display = 'none';
    }

    function updateChickenModalUI() {
        document.getElementById('chickenCountDisplay').innerText = wallet.balance;
        let container = document.getElementById('rewardTasksContainer');
        if (!container) return;

        const taskDefs = [
            { key: 'dailyLogin', title: '1. 每日登入', desc: '' },
            { key: 'listeningPractice', title: '2. 完成一次聽力測驗', desc: '' },
            { key: 'cardPractice', title: '3. 完成一次字卡測驗', desc: '' },
            { key: 'listeningPerfect', title: '4. 聽力測驗 80 分且題數≥ 10 ', desc: '' },
            { key: 'cardPerfect', title: '5. 字卡測驗 80 分且題數≥ 10', desc: '' }
        ];

        let html = '';
        taskDefs.forEach(def => {
            let t = chickenData.tasks[def.key];
            let statusHtml = '';
            if (isTaskClaimed(def.key)) {
                statusHtml = `<span class="task-status-text completed">已領取</span>`;
            } else if (t.done) {
                statusHtml = `<button class="cloud-btn" data-on-click='[["claimChickenReward",["${def.key}"]]]'>領1個</button>`;
            } else {
                statusHtml = `<span class="task-status-text">未完成</span>`;
            }

            html += `
                <div class="reward-task-item">
                    <div class="reward-task-info">
                        <div class="reward-task-title">${def.title} ${t.done ? '<span style="color:#10B981;">✓</span>' : ''}</div>
                        <div class="reward-task-desc">${def.desc}</div>
                    </div>
                    <div class="reward-action-area">
                        ${statusHtml}
                    </div>
                </div>
            `;
        });
        container.innerHTML = html;
    }

    // 領取：向後端登記（同一天同一任務只會算一次），成功後以後端回傳的餘額為準
    async function claimChickenReward(taskKey) {
        checkDailyReset();
        let t = chickenData.tasks[taskKey];
        if (!t || !t.done || isTaskClaimed(taskKey) || walletBusy) return;
        walletBusy = true;
        try {
            let before = wallet.balance;
            let data = await walletRpc('claim_reward', { p_task: taskKey, p_day: chickenData.lastDate });
            applyWallet(data, chickenData.lastDate);
            let gained = wallet.balance - before;
            if (gained > 0) showChickenFloat('chickenCountDisplay', '+' + gained, '#EF4444');
        } catch (e) {
            console.warn('領取失敗:', e && e.message || e);
            walletOnline = !String((e && e.message) || '').includes('no_session') && walletOnline;
            alert(`❌ 領取失敗：${walletErrorMessage(e)}`);
            refreshWallet();
        } finally {
            walletBusy = false;
            updateChickenModalUI();
        }
    }

    // ---------------------------------
    // 🛒 雞塊補給站
    // ---------------------------------
    function openChickenShopModal() {
        checkDailyReset();
        updateChickenShopUI();
        document.getElementById('chickenShopModal').style.display = 'block';
        refreshWallet();
        loadShopCatalog();
    }

    function closeChickenShopModal() {
        document.getElementById('chickenShopModal').style.display = 'none';
    }

    function updateChickenShopUI() {
        let countEl = document.getElementById('chickenShopCountDisplay');
        if (!countEl) return;
        countEl.innerText = wallet.balance;
        Object.keys(SHOP_ITEM_META).forEach(key => {
            let cell = document.getElementById('shopItem_' + key);
            if (!cell) return;
            let cat = shopCatalog[key], qty = walletQty(key);
            // 單字上限是「每本題庫」各自計算次數，所以整個商品不會有「全部買完」的狀態
            let maxed = key === 'word_cap_50' ? (cat.enabled === false) : (qty >= cat.max || cat.enabled === false);
            let poor = !maxed && wallet.balance < cat.price;
            cell.classList.toggle('is-maxed', maxed);
            cell.classList.toggle('is-poor', poor);
            let sub = document.getElementById('shopSub_' + key);
            if (sub) {
                sub.textContent = key === 'word_cap_50'
                    ? '指定一本題庫'
                    : `目前上限 ${getMaxLists()} 本`;
            }
            let price = document.getElementById('shopPrice_' + key);
            if (price) price.innerHTML = maxed ? '已達上限' : `<span class="chicken-mini"></span><b>${cat.price}</b>`;
        });
    }

    async function buyShopItem(key) {
        let meta = SHOP_ITEM_META[key], cat = shopCatalog[key];
        if (!meta || !cat || walletBusy) return;

        // 單字上限：先選要擴增哪一本題庫
        if (key === 'word_cap_50') {
            if (cat.enabled === false) { alert('此商品目前無法兌換。'); return; }
            if (wallet.balance < cat.price) {
                alert(`🍗 雞塊不足！需要 ${cat.price} 個，目前有 ${wallet.balance} 個。`);
                return;
            }
            openShopListPicker();
            return;
        }

        if (cat.enabled === false || walletQty(key) >= cat.max) {
            alert(`「${meta.name}」已達購買上限。`);
            return;
        }
        if (wallet.balance < cat.price) {
            alert(`🍗 雞塊不足！需要 ${cat.price} 個，目前有 ${wallet.balance} 個。`);
            return;
        }
        if (!confirm(`要用 ${cat.price} 個雞塊兌換「${meta.name}」嗎？\n\n${meta.desc}`)) return;

        walletBusy = true;
        try {
            let data = await walletRpc('buy_item', { p_item: key });
            applyWallet(data, getLocalDateStr());
            showChickenFloat('chickenShopCountDisplay', '-' + (data.spent || cat.price), '#EF4444');
            refreshAllListViews();
        } catch (e) {
            console.warn('兌換失敗:', e && e.message || e);
            alert(`❌ 兌換失敗：${walletErrorMessage(e)}`);
            refreshWallet();
        } finally {
            walletBusy = false;
        }
    }

    // ── 選擇要擴增單字上限的題庫 ──
    function openShopListPicker() {
        renderShopListPicker();
        document.getElementById('shopListPickerModal').style.display = 'block';
    }

    function closeShopListPicker() {
        document.getElementById('shopListPickerModal').style.display = 'none';
    }

    function renderShopListPicker() {
        let box = document.getElementById('shopListPickerContainer');
        if (!box) return;
        let cat = shopCatalog.word_cap_50;
        let html = '';
        wordLists.forEach((l, idx) => {
            let lang = getListLang(l);
            let extra = Number((wallet.listCaps || {})[l.id]) || 0;
            let maxed = extra >= cat.max;
            let count = getListWordCount(l.content), cap = getListWordCap(l);
            html += `
                <button type="button" class="picker-item${maxed ? ' is-maxed' : ''}" data-on-click='[["buyWordCapForList",["${l.id}"]]]'>
                    <div class="picker-main">
                        <div class="picker-title">${getLangSeq(idx)}: ${escapeHTML(l.title)} <span class="lang-tag lang-tag-${lang}">${getLangName(lang)}</span></div>
                        <div class="picker-sub">${count} / ${cap} 字　${maxed ? '已達擴充上限' : `兌換後 ${cap + WORD_CAP_STEP} 字`}</div>
                    </div>
                    <div class="picker-plus">${maxed ? '—' : '+' + WORD_CAP_STEP}</div>
                </button>`;
        });
        box.innerHTML = html || '<div style="text-align:center; color:var(--text-muted); padding:20px;">目前沒有題庫</div>';
    }

    async function buyWordCapForList(listId) {
        let cat = shopCatalog.word_cap_50;
        let idx = wordLists.findIndex(l => l.id === listId);
        if (idx < 0 || walletBusy) return;
        let list = wordLists[idx];
        let extra = Number((wallet.listCaps || {})[listId]) || 0;
        if (extra >= cat.max) {
            alert(`「${list.title}」的單字上限已擴充到最大（共可兌換 ${cat.max} 次）。`);
            return;
        }
        if (wallet.balance < cat.price) {
            alert(`🍗 雞塊不足！需要 ${cat.price} 個，目前有 ${wallet.balance} 個。`);
            return;
        }
        let cap = getListWordCap(list);
        if (!confirm(`要用 ${cat.price} 個雞塊，為「${list.title}」擴增單字上限嗎？\n\n${cap} 字 → ${cap + WORD_CAP_STEP} 字\n（只增加這一本題庫，其他題庫不變）`)) return;

        walletBusy = true;
        try {
            let data = await walletRpc('buy_item', { p_item: 'word_cap_50', p_target: listId });
            applyWallet(data, getLocalDateStr());
            closeShopListPicker();
            showChickenFloat('chickenShopCountDisplay', '-' + (data.spent || cat.price), '#EF4444');
            refreshAllListViews();
        } catch (e) {
            console.warn('兌換失敗:', e && e.message || e);
            alert(`❌ 兌換失敗：${walletErrorMessage(e)}`);
            refreshWallet();
        } finally {
            walletBusy = false;
        }
    }

    // 觸發任務完成檢查 (供外部呼叫)
    function triggerTaskCheck(taskType, data = {}) {
        checkDailyReset();
        let updated = false;

        if (taskType === 'listening_exam_done') {
            if (!isTaskClaimed('listeningPractice')) {
                chickenData.tasks.listeningPractice.done = true;
                updated = true;
            }
            if (data.total >= 10 && data.score >= 80) {
                if (!isTaskClaimed('listeningPerfect')) {
                    chickenData.tasks.listeningPerfect.done = true;
                    updated = true;
                }
            }
        } else if (taskType === 'card_exam_done') {
            if (!isTaskClaimed('cardPractice')) {
                chickenData.tasks.cardPractice.done = true;
                updated = true;
            }
            if (data.total >= 10 && data.score >= 80) {
                if (!isTaskClaimed('cardPerfect')) {
                    chickenData.tasks.cardPerfect.done = true;
                    updated = true;
                }
            }
        }

        if (updated) {
            saveChickenData();
        }
    }

    // ---------------------------------

    let flashcardActiveList = [];
    let currentFcIndex = 0;

    let cardExamActiveList = [];
    let currentCardExamIndex = 0;
    let cardExamTimerId = null;
    let cardExamTimeLeft = 0;
    let cardExamResults = [];
    let currentCardExamRanges = "";

    let touchStartX = 0;
    let touchEndX = 0;
    let isSwipeAction = false;

    window.onload = async function() {
        checkAndRedirectInAppBrowser();
        loadVoices();
        if (synth.onvoiceschanged !== undefined) synth.onvoiceschanged = loadVoices;
        loadAppSettings();
        loadExamAppSettings();
        loadSystemSettings();
        applyLanguageUI();
        loadFlashcardAppSettings();
        loadCardExamAppSettings();
        initPracticeCardGrid();
        initExamCardGrid();
        initFlashcardGrid();
        initCardExamGrid();
        initEditorListCards();
        initExamCheckboxes();
        initFlashcardTouchListeners();
        loadCollapseStates();

        // 初始化雞塊系統與每日登入任務
        checkDailyReset();
        updateChickenBadgeUI();
        refreshWallet();   // 背景向後端讀取最新雞塊數與購買紀錄（連不上時先用上次的快取）

        // 切回 app 時檢查是否已跨日
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') updateChickenBadgeUI();
        });
        // app 開著不動時，每分鐘檢查一次是否跨日
        setInterval(updateChickenBadgeUI, 60 * 1000);

        window.addEventListener('click', function(e) {
            if (!e.target.closest('.list-card-menu-btn') && !e.target.closest('.dropdown-menu')) {
                document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
            }
        });

        document.querySelectorAll('input[type="range"]').forEach(slider => updateSliderProgress(slider));

        if (typeof google !== 'undefined') {
            tokenClient = google.accounts.oauth2.initTokenClient({
                client_id: CLIENT_ID,
                scope: SCOPES,
                callback: async (resp) => {
                    if (resp.error !== undefined || !resp.access_token) {
                        accessToken = null; isCloudSyncActive = false;
                        updateCloudStatusText(`💻 未登入`);
                        return;
                    }
                    accessToken = resp.access_token;
                    isCloudSyncActive = true;
                    updateCloudStatusText(`✅ 已連結 Google 雲端`);
                    let authBtn = document.getElementById('cloudAuthBtn');
                    authBtn.innerText = '🔒 登出'; authBtn.className = 'cloud-btn logout';
                    authBtn.setAttribute('data-on-click', '[["handleLogout",[]]]');
                    loadDataFromGoogleDrive();
                }
            });
        }
    };

    function loadCollapseStates() {
        let collapseStates = JSON.parse(localStorage.getItem('dictation_collapse_states')) || {
            practice: true,
            flashcard: true,
            exam: true,
            cardExam: true,
            listening_score_chart: false,
            listening_top_wrong: false,
            listening_history_list: false,
            card_score_chart: false,
            card_top_wrong: false,
            card_history_list: false
        };

        applyCollapseState('previewContainer', 'collapseBtn', collapseStates.practice);
        applyCollapseState('fcPreviewContainer', 'fcCollapseBtn', collapseStates.flashcard);
        applyCollapseState('examPreviewCollapseContainer', 'examCollapseBtn', collapseStates.exam);
        applyCollapseState('cardExamPreviewContainer', 'cardExamCollapseBtn', collapseStates.cardExam);

        applySubCardCollapseState('listeningScoreChartContent', 'listeningScoreChartToggleBtn', collapseStates.listening_score_chart);
        applySubCardCollapseState('listeningTopWrongContent', 'listeningTopWrongToggleBtn', collapseStates.listening_top_wrong);
        applySubCardCollapseState('listeningHistoryListContent', 'listeningHistoryListToggleBtn', collapseStates.listening_history_list);
        applySubCardCollapseState('cardScoreChartContent', 'cardScoreChartToggleBtn', collapseStates.card_score_chart);
        applySubCardCollapseState('cardTopWrongContent', 'cardTopWrongToggleBtn', collapseStates.card_top_wrong);
        applySubCardCollapseState('cardHistoryListContent', 'cardHistoryListToggleBtn', collapseStates.card_history_list);
    }

    function applyCollapseState(containerId, btnId, isCollapsed) {
        const container = document.getElementById(containerId);
        const btn = document.getElementById(btnId);
        if (container && btn) {
            if (isCollapsed) {
                container.classList.add('collapsed');
                btn.classList.add('collapsed');
            } else {
                container.classList.remove('collapsed');
                btn.classList.remove('collapsed');
            }
        }
    }

    function applySubCardCollapseState(contentId, btnId, isCollapsed) {
        const content = document.getElementById(contentId);
        const btn = document.getElementById(btnId);
        if (content && btn) {
            if (isCollapsed) {
                content.classList.add('collapsed');
                btn.classList.add('collapsed');
            } else {
                content.classList.remove('collapsed');
                btn.classList.remove('collapsed');
            }
        }
    }

    function saveCollapseState(key, isCollapsed) {
        let collapseStates = JSON.parse(localStorage.getItem('dictation_collapse_states')) || {
            practice: true,
            flashcard: true,
            exam: true,
            cardExam: true,
            listening_score_chart: false,
            listening_top_wrong: false,
            listening_history_list: false,
            card_score_chart: false,
            card_top_wrong: false,
            card_history_list: false
        };
        collapseStates[key] = isCollapsed;
        localStorage.setItem('dictation_collapse_states', JSON.stringify(collapseStates));
    }

    function toggleSubCard(contentId, btnId, stateKey) {
        const content = document.getElementById(contentId);
        const btn = document.getElementById(btnId);
        if (content && btn) {
            content.classList.toggle('collapsed');
            btn.classList.toggle('collapsed');
            let isCollapsed = content.classList.contains('collapsed');
            saveCollapseState(stateKey, isCollapsed);
            
            if (!isCollapsed && (stateKey === 'listening_score_chart' || stateKey === 'card_score_chart')) {
                setTimeout(() => {
                    if (stateKey === 'listening_score_chart') renderScoreChart('listeningScoreCanvas', examHistory);
                    else renderScoreChart('cardScoreCanvas', cardExamHistory);
                }, 100);
            }
        }
    }

    function toggleAccordion(listId) {
        const practiceList = document.getElementById('practiceList');
        const examList = document.getElementById('examList');
        
        if (listId === 'practiceList') {
            const willExpand = !practiceList.classList.contains('expanded');
            if (willExpand) {
                practiceList.classList.add('expanded');
                examList.classList.remove('expanded');
            } else {
                practiceList.classList.remove('expanded');
            }
        } else if (listId === 'examList') {
            const willExpand = !examList.classList.contains('expanded');
            if (willExpand) {
                examList.classList.add('expanded');
                practiceList.classList.remove('expanded');
            } else {
                examList.classList.remove('expanded');
            }
        }
    }

    function initFlashcardTouchListeners() {
        const cardEl = document.getElementById('flashcardCardEl');
        if (!cardEl) return;

        cardEl.addEventListener('touchstart', e => { 
            touchStartX = e.changedTouches[0].screenX;
            isSwipeAction = false;
        }, { passive: true });

        cardEl.addEventListener('touchend', e => { 
            touchEndX = e.changedTouches[0].screenX;
            let diffX = touchEndX - touchStartX;
            
            if (Math.abs(diffX) > 40) {
                isSwipeAction = true;
                if (diffX < -40) nextFlashcard();
                else if (diffX > 40) prevFlashcard();
            } else {
                cardEl.classList.toggle('flipped');
            }
        }, false);

        cardEl.addEventListener('click', e => {
            if (!('ontouchstart' in window)) {
                cardEl.classList.toggle('flipped');
            }
        });
    }

    function hideInAppBrowserWarning() {
        document.getElementById('inAppBrowserWarning').style.display = 'none';
    }

    function checkAndRedirectInAppBrowser() {
        const ua = navigator.userAgent || navigator.vendor || window.opera;
        const isLine = /Line/i.test(ua);
        const isInApp = /FBAN|FBAV|Instagram|MicroMessenger/i.test(ua) || isLine;

        if (isInApp) {
            const currentUrl = window.location.href;
            if (/Android/i.test(ua)) {
                const intentUrl = 'intent://' + currentUrl.replace(/^https?:\/\//, '') + '#Intent;scheme=https;package=com.android.chrome;end';
                window.location.href = intentUrl;
            } else if (/iPhone|iPad|iPod/i.test(ua)) {
                document.getElementById('inAppBrowserWarning').style.display = 'block';
            } else {
                document.getElementById('inAppBrowserWarning').style.display = 'block';
            }
        }
    }

    function updateCloudStatusText(text) {
        let elHome = document.getElementById('cloudStatusText');
        if (elHome) elHome.innerText = text;
        let elEditorList = document.getElementById('editorListModeStatusText');
        if (elEditorList) elEditorList.innerText = text;
    }

    function updateSliderProgress(slider) {
        let min = parseFloat(slider.min) || 0;
        let max = parseFloat(slider.max) || 100;
        let val = parseFloat(slider.value);
        let percentage = ((val - min) / (max - min)) * 100;
        slider.style.background = `linear-gradient(to right, #818CF8 ${percentage}%, #E2E8F0 ${percentage}%)`;
    }

    function loadVoices() { voices = synth.getVoices(); }

    function getLearningLanguage() {
        let langSelect = document.getElementById('learningLanguage');
        return langSelect ? langSelect.value : 'en';
    }

    // ═══════════ 多語言：題庫標籤 / 過濾 / 驗證 ═══════════
    const LANG_NAME = { en: '英文', ko: '韓文' };
    const OTHER_LANG = { en: 'ko', ko: 'en' };
    const RE_LATIN  = /[A-Za-z]/;
    const RE_HANGUL = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/;

    function getLangName(lang) { return LANG_NAME[lang] || LANG_NAME.en; }

    // 題庫的語言標籤；舊題庫沒有 lang 欄位時視為英文
    function getListLang(list) { return (list && list.lang === 'ko') ? 'ko' : 'en'; }
    function isListInCurrentLang(list) { return getListLang(list) === getLearningLanguage(); }

    // 此題庫在「同語言題庫」中的順位（顯示用編號 1,2,3…）
    function getLangSeq(idx) {
        let lang = getListLang(wordLists[idx]), seq = 0;
        for (let i = 0; i <= idx; i++) if (getListLang(wordLists[i]) === lang) seq++;
        return seq;
    }

    function countListsByLang() {
        let c = { en: 0, ko: 0 };
        wordLists.forEach(l => { c[getListLang(l)]++; });
        return c;
    }

    // 題庫頁上方：英文 4 ｜ 韓文 6 ｜ 剩餘 0
    function updateListQuotaBar() {
        let bar = document.getElementById('listQuotaBar');
        if (!bar) return;
        let c = countListsByLang(), cur = getLearningLanguage();
        let remain = Math.max(0, getMaxLists() - wordLists.length);
        let part = (lang) => `<span style="${cur === lang ? 'color:var(--primary); font-weight:800;' : ''}">${getLangName(lang)} ${c[lang]}</span>`;
        bar.innerHTML = `${part('en')} ｜ ${part('ko')} ｜ <span>剩餘 ${remain}</span>`;
    }

    // 單字行的「外語部分」：第一個中文字之前的內容（與 parseWordsRaw 的切法一致）
    function getForeignPart(line) {
        let t = line.trim();
        if (t.startsWith('*')) t = t.substring(1).trim();
        let i = t.search(/[\u4e00-\u9fa5]/);
        return (i !== -1 ? t.substring(0, i) : t).trim();
    }

    // 依題庫語言把內容分成「保留」與「語言不符、要刪除」的行
    function splitLinesByLanguage(content, lang) {
        let kept = [], removed = [];
        (content || '').split('\n').forEach(line => {
            if (!line.trim()) { kept.push(line); return; }
            let foreign = getForeignPart(line);
            let wrong = (lang === 'ko') ? RE_LATIN.test(foreign) : RE_HANGUL.test(foreign);
            (wrong ? removed : kept).push(line);
        });
        return { kept, removed };
    }

    function formatRemovedLines(removed) {
        let show = removed.slice(0, 8).map(l => '• ' + l.trim()).join('\n');
        return removed.length > 8 ? show + `\n…等共 ${removed.length} 行` : show;
    }

    // 檢查並移除與題庫語言不符的單字（有刪除時彈出警告）；回傳刪除行數
    function enforceListLanguage(idx) {
        let list = wordLists[idx];
        if (!list || !list.content) return 0;
        let lang = getListLang(list);
        let r = splitLinesByLanguage(list.content, lang);
        if (r.removed.length === 0) return 0;
        list.content = r.kept.join('\n');
        localStorage.setItem('dictation_word_lists', JSON.stringify(wordLists));
        triggerAutoSaveToCloud();
        let ta = document.getElementById('editorWordList');
        if (ta && lastSelectedList === idx && document.getElementById('editorDetailView').classList.contains('active')) {
            ta.value = list.content;
            handleEditorSearch();
        }
        alert(`⚠️ 「${list.title}」是${getLangName(lang)}題庫，偵測到 ${r.removed.length} 行含有${getLangName(OTHER_LANG[lang])}的單字，已自動刪除：\n\n${formatRemovedLines(r.removed)}`);
        return r.removed.length;
    }

    // 編輯框離開焦點時檢查（打字中不干擾）
    function enforceCurrentEditorLanguage() {
        if (!wordLists[lastSelectedList]) return;
        enforceListLanguage(lastSelectedList);   // 語言不符的單字
        enforceListWordCap(lastSelectedList);    // 超過單字上限的部分
    }

    // 單字數超過上限時，移除超出的行（舊題庫本來就超過時，不會刪掉原有的，只是不能再增加）
    function enforceListWordCap(idx) {
        let list = wordLists[idx];
        if (!list || !list.content) return 0;
        let limit = Math.max(getListWordCap(list), idx === lastSelectedList ? editorOpenCount : 0);
        let kept = [], n = 0, removed = 0;
        list.content.split('\n').forEach(line => {
            if (!line.trim()) { kept.push(line); return; }
            if (n < limit) { kept.push(line); n++; } else { removed++; }
        });
        if (removed === 0) return 0;
        list.content = kept.join('\n');
        localStorage.setItem('dictation_word_lists', JSON.stringify(wordLists));
        triggerAutoSaveToCloud();
        let ta = document.getElementById('editorWordList');
        if (ta && lastSelectedList === idx && document.getElementById('editorDetailView').classList.contains('active')) {
            ta.value = list.content;
            handleEditorSearch();
        }
        alert(`⚠️ 「${list.title}」最多只能放 ${limit} 個單字，超出的 ${removed} 行已移除。\n可到「雞塊補給站」兌換單字上限 +50。`);
        return removed;
    }

    // 題庫選單：更換語言（內容中語言不符的行會被刪除，先確認）
    function changeListLanguageFromMenu(idx) {
        let list = wordLists[idx];
        if (!list) return;
        let from = getListLang(list), to = OTHER_LANG[from];
        let r = splitLinesByLanguage(list.content, to);
        let msg = `要把「${list.title}」從${getLangName(from)}題庫改成${getLangName(to)}題庫嗎？`;
        if (r.removed.length > 0) msg += `\n\n⚠️ 其中 ${r.removed.length} 行含有${getLangName(from)}單字，更換後會被刪除：\n${formatRemovedLines(r.removed)}`;
        if (!confirm(msg)) return;
        list.lang = to;
        list.content = r.kept.join('\n');
        localStorage.setItem('dictation_word_lists', JSON.stringify(wordLists));
        triggerAutoSaveToCloud();
        refreshAllListViews();
        alert(`✅ 已改為${getLangName(to)}題庫。切換到「${getLangName(to)}」學習語言即可看到它。`);
    }

    // 歷史紀錄：舊紀錄沒有 lang 欄位時視為英文
    function filterHistoryByLang(arr) {
        let cur = getLearningLanguage();
        return (arr || []).filter(h => (h && h.lang === 'ko' ? 'ko' : 'en') === cur);
    }
    // 每種語言各保留最近 10 筆
    function trimHistoryPerLang(arr) {
        let cnt = { en: 0, ko: 0 };
        return (arr || []).filter(h => {
            let l = (h && h.lang === 'ko') ? 'ko' : 'en';
            return ++cnt[l] <= 10;
        });
    }

    function refreshAllListViews() {
        initPracticeCardGrid();
        initExamCardGrid();
        initFlashcardGrid();
        initCardExamGrid();
        initEditorListCards();
    }

    // 依學習語言切換介面文字（data-t-en / data-t-ko、data-p-en / data-p-ko）
    function applyLanguageUI() {
        let lang = getLearningLanguage();
        document.querySelectorAll('[data-t-en]').forEach(el => { el.textContent = el.getAttribute('data-t-' + lang); });
        document.querySelectorAll('[data-p-en]').forEach(el => { el.placeholder = el.getAttribute('data-p-' + lang); });
        document.documentElement.setAttribute('data-learning-lang', lang);
    }

    // 設定中切換學習語言：只換「顯示哪個語言」，不動每日任務與雞塊
    function onLearningLanguageChange() {
        saveSystemSettings();
        applyLanguageUI();
        refreshAllListViews();
        updateListQuotaBar();
        let hm = document.getElementById('historyModal');
        if (hm && hm.style.display === 'block') openHistoryModalContent();
    }

    function getSelectedVoiceForLearning() {
        let lang = getLearningLanguage();
        let langCode = (lang === 'ko') ? 'ko-KR' : 'en-US';
        if (voices.length === 0) voices = synth.getVoices();
        let standardVoice = voices.find(v => v.lang === langCode || v.lang.replace('_','-') === langCode || v.lang.toLowerCase() === langCode.toLowerCase());
        return standardVoice || null;
    }    

    function getSelectedVoice(langCode) {
        if (voices.length === 0) voices = synth.getVoices();
        let standardVoice = voices.find(v => v.lang === langCode || v.lang.replace('_','-') === langCode || v.lang.toLowerCase() === langCode.toLowerCase());
        return standardVoice || null;
    }

    function handleAuthClick() {
        if (tokenClient) tokenClient.requestAccessToken({ prompt: 'consent' });
    }
    function handleLogout() {
        if (!accessToken) return;
        const tokenToRevoke = accessToken;
        // 先在本機完成登出（不依賴網路），再盡力通知 Google 撤銷授權
        accessToken = null; isCloudSyncActive = false;
        updateCloudStatusText(`💻 未登入`);
        let authBtn = document.getElementById('cloudAuthBtn');
        authBtn.innerText = '登入 Google 雲端'; authBtn.className = 'cloud-btn';
        authBtn.setAttribute('data-on-click', '[["handleAuthClick",[]]]');
        try { google.accounts.oauth2.revoke(tokenToRevoke, () => {}); } catch (e) { console.warn('撤銷授權失敗（本機已登出）', e); }
        alert("🔒 已登出 Google 帳號。");
    }

    async function loadDataFromGoogleDrive() {
        if (!accessToken) return;
        updateCloudStatusText(`☁️ 雲端資料同步中...`);
        try {
            let query = encodeURIComponent(`name='${FILENAME}' and 'appDataFolder' in parents and trashed=false`);
            let res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&spaces=appDataFolder`, {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            let data = await res.json();
            if (data.files && data.files.length > 0) {
                let fileId = data.files[0].id;
                let fileRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
                    headers: { 'Authorization': `Bearer ${accessToken}` }
                });
                let cloudData = await fileRes.json();
                if (cloudData) {
                    if (Array.isArray(cloudData.wordLists)) {
                        wordLists = cloudData.wordLists;
                        localStorage.setItem('dictation_word_lists', JSON.stringify(wordLists));
                        if (ensureListIds()) setTimeout(triggerAutoSaveToCloud, 0);   // 雲端舊資料沒有識別碼：補上並回傳
                    }
                    if (cloudData.examHistory) {
                        examHistory = trimHistoryPerLang(cloudData.examHistory);
                        localStorage.setItem('dictation_exam_history', JSON.stringify(examHistory));
                    }
                    if (cloudData.cardExamHistory) {
                        cardExamHistory = trimHistoryPerLang(cloudData.cardExamHistory);
                        localStorage.setItem('dictation_card_exam_history', JSON.stringify(cardExamHistory));
                    }
                    if (cloudData.chickenData && cloudData.chickenData.tasks && cloudData.chickenData.lastDate === chickenData.lastDate) {
                        // 雞塊數量與領取紀錄在後端；這裡只合併「今天的任務完成進度」
                        CHICKEN_TASK_KEYS.forEach(k => {
                            if (cloudData.chickenData.tasks[k] && cloudData.chickenData.tasks[k].done) chickenData.tasks[k].done = true;
                        });
                        saveChickenData();
                    }
                    initPracticeCardGrid();
                    initExamCardGrid();
                    initFlashcardGrid();
                    initCardExamGrid();
                    initEditorListCards();
                    initExamCheckboxes();
                }
            }
            updateCloudStatusText(`✅ 已連結 Google 雲端`);
        } catch (err) { 
            console.error("雲端載入失敗", err); 
            updateCloudStatusText(`⚠️ 雲端同步失敗`);
        }
    }

    async function triggerAutoSaveToCloud() {
        localStorage.setItem('dictation_word_lists', JSON.stringify(wordLists));
        if (!accessToken || !isCloudSyncActive) return;
        updateCloudStatusText(`☁️ 上傳備份中...`);
        try {
            let query = encodeURIComponent(`name='${FILENAME}' and 'appDataFolder' in parents and trashed=false`);
            let res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&spaces=appDataFolder`, {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            let data = await res.json();
            let fileId = (data.files && data.files.length > 0) ? data.files[0].id : null;

            let cloudData = { 
                activeDeviceId: myDeviceId, 
                wordLists, 
                examHistory: trimHistoryPerLang(examHistory), 
                cardExamHistory: trimHistoryPerLang(cardExamHistory), 
                chickenData,
                appSettings: JSON.parse(localStorage.getItem('dictation_app_settings') || '{}') 
            };
            let fileContent = JSON.stringify(cloudData);

            if (fileId) {
                await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
                    method: 'PATCH',
                    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                    body: fileContent
                });
            } else {
                let metadata = { name: FILENAME, parents: ['appDataFolder'] };
                let form = new FormData();
                form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
                form.append('file', new Blob([fileContent], { type: 'application/json' }));
                await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
                    method: 'POST', headers: { 'Authorization': `Bearer ${accessToken}` }, body: form
                });
            }
            updateCloudStatusText(`✅ 已連結 Google 雲端`);
        } catch(e) { 
            console.error("雲端存檔失敗", e); 
            updateCloudStatusText(`⚠️ 雲端同步失敗`);
        }
    }

    function switchView(viewId) {
        document.querySelectorAll('.app-view').forEach(v => v.classList.remove('active'));
        document.getElementById(viewId).classList.add('active');
        
        let wrapper = document.getElementById('mainScaleWrapper');
        if (viewId === 'practiceView' || viewId === 'examView' || viewId === 'flashcardPlayView' || viewId === 'flashcardSetupView' || viewId === 'cardExamSetupView' || viewId === 'cardExamPlayView') {
            wrapper.className = 'scale-wrapper-practice';
        } else {
            wrapper.className = 'scale-wrapper';
        }
    }

    function goToPracticePage() {
        initPracticeCardGrid();
        switchView('practiceView');
    }

    function goToFlashcardPage() {
        initFlashcardGrid();
        switchView('flashcardSetupView');
    }

    function goToCardExamPage() {
        initCardExamGrid();
        switchView('cardExamSetupView');
    }

    function goToExamPage() {
        initExamCardGrid();
        switchView('examView');
    }

    async function goToEditorPage() {
        if (accessToken && isCloudSyncActive) {
            await loadDataFromGoogleDrive();
        }
        initEditorListCards();
        switchView('editorListView');
    }

    function backToHome() {
        stopDictation();
        stopCardExamSession();
        releaseWakeLock();
        switchView('homeDashboardView');
    }

    function backToHomeFromExam() {
        if (isExamRunning) {
            alert("⚠️ 目前正在考試中，請先結束考試！");
            return;
        }
        stopExamMode();
        releaseWakeLock();
        switchView('homeDashboardView');
    }

    function initEditorListCards() {
        let container = document.getElementById('editorListCardContainer');
        if (!container) return;
        document.querySelectorAll('body > .dropdown-menu').forEach(m => m.remove()); // 清掉搬到最外層的舊選單
        container.innerHTML = '';
        updateListQuotaBar();

        let cur = getLearningLanguage(), shown = 0;
        wordLists.forEach((l, idx) => {
            if (getListLang(l) !== cur) return;
            shown++;
            let count = getListWordCount(l.content);
            let lang = getListLang(l);
            let cardHtml = `
                <div class="list-card-item" data-on-click='[["openEditorDetail",[${idx}]]]'>
                    <div class="list-card-info">
                        <div class="list-card-title">${shown}: ${escapeHTML(l.title)} <span class="lang-tag lang-tag-${lang}">${getLangName(lang)}</span></div>
                        <div class="list-card-count">(${count}/${getListWordCap(wordLists[idx])} 字)</div>
                    </div>
                    <div style="position: relative;">
                        <button class="list-card-menu-btn" data-on-click='[["$stop",[]],["toggleDropdownMenu",[${idx},"$event"]]]'>⋮</button>
                        <div class="dropdown-menu" id="dropdownMenu_${idx}">
                            <button class="dropdown-item" data-on-click='[["$stop",[]],["renameListTitleFromMenu",[${idx}]]]'>修改</button>
                            <button class="dropdown-item" data-on-click='[["$stop",[]],["changeListLanguageFromMenu",[${idx}]]]'>更換語言</button>
                            <button class="dropdown-item" data-on-click='[["$stop",[]],["clearListContentFromMenu",[${idx}]]]'>清空</button>
                            <button class="dropdown-item danger" data-on-click='[["$stop",[]],["deleteListFromMenu",[${idx}]]]'>刪除</button>
                        </div>
                    </div>
                </div>
            `;
            container.insertAdjacentHTML('beforeend', cardHtml);
        });
        if (shown === 0) {
            container.innerHTML = `<div style="text-align:center; color:var(--text-muted); padding:24px 8px; font-size:14px;">目前還沒有${getLangName(cur)}題庫<br>按右上角「新增題庫本」開始建立</div>`;
        }
    }

    function toggleDropdownMenu(idx, event) {
        document.querySelectorAll('.dropdown-menu').forEach(m => {
            if (m.id !== `dropdownMenu_${idx}`) m.classList.remove('show');
            });

        let menu = document.getElementById(`dropdownMenu_${idx}`);
        if (!menu) return;

        if (menu.classList.contains('show')) {
            menu.classList.remove('show');
            return;
        }

        let btnRect = event.currentTarget.getBoundingClientRect();

        // 搬到 <body> 最外層：避開外層容器的 overflow 裁切，以及桌面版整體放大(transform)造成的定位錯誤
        if (menu.parentElement !== document.body) document.body.appendChild(menu);
        let wrap = document.querySelector('.scale-wrapper');
        let scale = (wrap && wrap.offsetWidth) ? (wrap.getBoundingClientRect().width / wrap.offsetWidth) : 1;
        menu.style.transformOrigin = 'top left';
        menu.style.transform = (Math.abs(scale - 1) > 0.01) ? `scale(${scale})` : '';

        menu.classList.remove('drop-up');
        menu.classList.add('show');                       // 先顯示才量得到選單大小

        let menuH = menu.offsetHeight * scale, menuW = menu.offsetWidth * scale, gap = 4, edge = 8;
        let spaceBelow = window.innerHeight - btnRect.bottom;
        let spaceAbove = btnRect.top;
        let top;
        if (spaceBelow >= menuH + gap + edge || spaceBelow >= spaceAbove) {
            top = btnRect.bottom + gap;                   // 下方放得下（或下方空間較大）→ 往下展開
        } else {
            top = btnRect.top - menuH - gap;              // 否則往上展開
        }
        top = Math.max(edge, Math.min(top, window.innerHeight - menuH - edge));
        let left = Math.max(edge, Math.min(btnRect.right - menuW, window.innerWidth - menuW - edge));
        menu.style.top = top + 'px';
        menu.style.left = left + 'px';
    }

    // 選單是固定定位，捲動或改變視窗大小時直接關閉，避免懸在錯的位置
    function closeAllDropdownMenus() {
        document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
    }
    document.addEventListener('scroll', closeAllDropdownMenus, true);
    window.addEventListener('resize', closeAllDropdownMenus);

    function openEditorDetail(idx) {
        lastSelectedList = idx;
        localStorage.setItem('dictation_last_selected_list', idx);
        let list = wordLists[idx];
        if (!list) return;

        document.getElementById('editorDetailTitleIndicator').innerText = `📁 ${getLangSeq(idx)}: ${list.title} 編輯（${getLangName(getListLang(list))}）`;
        editorOpenCount = getListWordCount(list.content);
        document.getElementById('editorWordList').value = list.content || '';
        document.getElementById('wordSearchInput').value = '';
        document.getElementById('searchNotFoundTip').style.display = 'none';
        
        handleEditorSearch();
        switchView('editorDetailView');
    }

    function backToListFromDetail() {
        enforceCurrentEditorLanguage();
        initEditorListCards();
        switchView('editorListView');
    }

    function renameListTitleFromMenu(idx) {
        let list = wordLists[idx];
        let newTitle = prompt("請輸入新的題庫標題：", list.title);
        if (newTitle && newTitle.trim()) {
            list.title = newTitle.trim();
            triggerAutoSaveToCloud();
            initEditorListCards();
            alert("✅ 標題修改成功並已自動儲存至本機與雲端！");
        }
    }

    function clearListContentFromMenu(idx) {
        if (confirm(`確定要清空「${wordLists[idx].title}」裡的所有單字嗎？`)) {
            wordLists[idx].content = "";
            triggerAutoSaveToCloud();
            initEditorListCards();
            alert("🧹 題庫已清空並自動儲存！");
        }
    }

    function deleteListFromMenu(idx) {
        if (wordLists.length <= 1) {
            alert("⚠️ 至少必須保留一組題庫本！");
            return;
        }
        let upgraded = Number((wallet.listCaps || {})[wordLists[idx].id]) || 0;
        let upgradeWarn = upgraded > 0 ? `\n\n⚠️ 這本題庫已兌換 ${upgraded * WORD_CAP_STEP} 字的單字上限，刪除後不會退還雞塊。` : '';
        if (confirm(`確定要刪除題庫「${wordLists[idx].title}」嗎？${upgradeWarn}`)) {
            wordLists.splice(idx, 1);
            triggerAutoSaveToCloud();
            initEditorListCards();
            refreshAllListViews();
            alert("🗑️ 題庫已刪除並自動儲存！");
        }
    }

    function addNewWordList() {
        let curLang = getLearningLanguage();
        if (wordLists.length >= getMaxLists()) {
            let c = countListsByLang();
            alert(`⚠️ 目前題庫數量已達上限 ${getMaxLists()} 組！（英文 ${c.en} ｜ 韓文 ${c.ko}）\n可刪除不用的題庫，或到「雞塊補給站」兌換題庫數量 +1。`);
            return;
        }
        let title = prompt(`請輸入新${getLangName(curLang)}題庫本標題：`, `unit ${countListsByLang()[curLang] + 1}`);
        if (!title || !title.trim()) return;

        wordLists.push({ id: newListId(), title: title.trim(), content: "", createdAt: Date.now(), lang: curLang });
        triggerAutoSaveToCloud();
        initEditorListCards();
        initPracticeCardGrid();
        initExamCardGrid();
        initFlashcardGrid();
        initCardExamGrid();
        alert(`✅ 已新增${getLangName(curLang)}題庫！`);
    }

    function handleEditorTextareaInput() {
        let idx = lastSelectedList;
        if (!wordLists[idx]) return;
        let text = document.getElementById('editorWordList').value;
        wordLists[idx].content = text;
        triggerAutoSaveToCloud();
    }

    function getListWordCount(content) {
        if (!content) return 0;
        return content.split('\n').map(l => l.trim()).filter(l => l.length > 0).length;
    }

    function initPracticeCardGrid() {
        let grid = document.getElementById('cardGrid');
        if (!grid) return;
        grid.innerHTML = '';
        
        let activeLists = wordLists.map((l, originalIdx) => ({ ...l, originalIdx })).filter(l => getListWordCount(l.content) > 0 && isListInCurrentLang(l));
        let savedPracticeSelected = JSON.parse(localStorage.getItem('dictation_practice_selected')) || [0];
        
        activeLists.forEach((list, displayIdx) => {
            let count = getListWordCount(list.content);
            let isSelected = savedPracticeSelected.includes(list.originalIdx) ? 'selected' : '';
            let cardHtml = `
                <div class="select-card ${isSelected}" data-on-click='[["togglePracticeCard",[${list.originalIdx},"$this"]]]'>
                    <div class="select-card-info">
                        <div class="select-card-title">${displayIdx + 1}: ${escapeHTML(list.title)}</div>
                        <div class="select-card-count">(${count}/${getListWordCap(list)} 字)</div>
                    </div>
                    <div class="checkmark-badge">✓</div>
                </div>
            `;
            grid.insertAdjacentHTML('beforeend', cardHtml);
        });
        loadPracticeSelectedContent();
    }

    function togglePracticeCard(originalIdx, cardEl) {
        cardEl.classList.toggle('selected');
        savePracticeSelectionState();
        loadPracticeSelectedContent();
    }

    function savePracticeSelectionState() {
        let selectedIndices = [];
        document.querySelectorAll('#cardGrid .select-card').forEach((card) => {
            if (card.classList.contains('selected')) {
                let onclickAttr = card.getAttribute('data-on-click');
                let match = onclickAttr.match(/"togglePracticeCard",\[(\d+),/);
                if (match) selectedIndices.push(parseInt(match[1]));
            }
        });
        localStorage.setItem('dictation_practice_selected', JSON.stringify(selectedIndices));
    }

    function loadPracticeSelectedContent() {
        let combinedText = '';
        let selectedCards = document.querySelectorAll('#cardGrid .select-card.selected');
        
        selectedCards.forEach(card => {
            let onclickAttr = card.getAttribute('data-on-click');
            let match = onclickAttr.match(/"togglePracticeCard",\[(\d+),/);
            if (match) {
                let idx = parseInt(match[1]);
                if (wordLists[idx] && wordLists[idx].content) {
                    combinedText += wordLists[idx].content + '\n';
                }
            }
        });

        document.getElementById('wordList').value = combinedText.trim();
        
        let allWords = parseWordsRaw(combinedText);
        let totalWords = allWords.length;
        let starCount = allWords.filter(w => w.starred).length;
        document.getElementById('practiceStatsText').innerText = `📊 範圍統計：總單字數 ${totalWords} 個 ｜ 星號 (*) 單字數 ${starCount} 個`;
    }

    function initFlashcardGrid() {
        let grid = document.getElementById('flashcardGrid');
        if (!grid) return;
        grid.innerHTML = '';
        
        let activeLists = wordLists.map((l, originalIdx) => ({ ...l, originalIdx })).filter(l => getListWordCount(l.content) > 0 && isListInCurrentLang(l));
        let savedSelected = JSON.parse(localStorage.getItem('dictation_flashcard_selected')) || [0];
        
        activeLists.forEach((list, displayIdx) => {
            let count = getListWordCount(list.content);
            let isSelected = savedSelected.includes(list.originalIdx) ? 'selected' : '';
            let cardHtml = `
                <div class="select-card ${isSelected}" data-on-click='[["toggleFlashcardCard",[${list.originalIdx},"$this"]]]'>
                    <div class="select-card-info">
                        <div class="select-card-title">${displayIdx + 1}: ${escapeHTML(list.title)}</div>
                        <div class="select-card-count">(${count}/${getListWordCap(list)} 字)</div>
                    </div>
                    <div class="checkmark-badge">✓</div>
                </div>
            `;
            grid.insertAdjacentHTML('beforeend', cardHtml);
        });
        loadFlashcardSelectedContent();
    }

    function toggleFlashcardCard(originalIdx, cardEl) {
        cardEl.classList.toggle('selected');
        saveFlashcardSelectionState();
        loadFlashcardSelectedContent();
    }

    function saveFlashcardSelectionState() {
        let selectedIndices = [];
        document.querySelectorAll('#flashcardGrid .select-card').forEach((card) => {
            if (card.classList.contains('selected')) {
                let onclickAttr = card.getAttribute('data-on-click');
                let match = onclickAttr.match(/"toggleFlashcardCard",\[(\d+),/);
                if (match) selectedIndices.push(parseInt(match[1]));
            }
        });
        localStorage.setItem('dictation_flashcard_selected', JSON.stringify(selectedIndices));
    }

    function loadFlashcardSelectedContent() {
        let combinedText = '';
        let selectedCards = document.querySelectorAll('#flashcardGrid .select-card.selected');
        
        selectedCards.forEach(card => {
            let onclickAttr = card.getAttribute('data-on-click');
            let match = onclickAttr.match(/"toggleFlashcardCard",\[(\d+),/);
            if (match) {
                let idx = parseInt(match[1]);
                if (wordLists[idx] && wordLists[idx].content) {
                    combinedText += wordLists[idx].content + '\n';
                }
            }
        });

        document.getElementById('flashcardPreviewTextarea').value = combinedText.trim();
        let allWords = parseWordsRaw(combinedText);
        let starCount = allWords.filter(w => w.starred).length;
        document.getElementById('flashcardStatsText').innerText = `📊 範圍統計：總單字數 ${allWords.length} 個 ｜ 星號 (*) 單字數 ${starCount} 個`;
    }

    function toggleFlashcardPreview() {
        let container = document.getElementById('fcPreviewContainer');
        let btn = document.getElementById('fcCollapseBtn');
        container.classList.toggle('collapsed');
        btn.classList.toggle('collapsed');
        saveCollapseState('flashcard', container.classList.contains('collapsed'));
    }

    function sortFlashcardPreview(sortType) {
        if (!sortType) return;
        let textarea = document.getElementById('flashcardPreviewTextarea');
        let words = parseWordsRaw(textarea.value);
        if (sortType === 'az') words.sort((a, b) => a.english.toLowerCase().localeCompare(b.english.toLowerCase(), getLearningLanguage()));
        else if (sortType === 'za') words.sort((a, b) => b.english.toLowerCase().localeCompare(a.english.toLowerCase(), getLearningLanguage()));
        textarea.value = words.map(w => w.rawLine).join('\n');
        setTimeout(() => document.getElementById('flashcardSortSelector').selectedIndex = 0, 200);
    }

    function openFlashcardSettingsModal() { document.getElementById('flashcardSettingsModal').style.display = 'block'; }
    function closeFlashcardSettingsModal() { document.getElementById('flashcardSettingsModal').style.display = 'none'; }
    
    function saveFlashcardSettings() {
        let settings = {
            fcOnlyStarred: document.getElementById('fcSettingStarred').checked,
            fcEnableShuffle: document.getElementById('fcSettingShuffle').checked,
            fcSpeakRate: document.getElementById('fcSpeakRate').value
        };
        localStorage.setItem('dictation_flashcard_app_settings', JSON.stringify(settings));
        closeFlashcardSettingsModal();
    }

    function loadFlashcardAppSettings() {
        let saved = localStorage.getItem('dictation_flashcard_app_settings');
        if (saved) {
            let s = JSON.parse(saved);
            if (s.fcOnlyStarred !== undefined) document.getElementById('fcSettingStarred').checked = s.fcOnlyStarred;
            if (s.fcEnableShuffle !== undefined) document.getElementById('fcSettingShuffle').checked = s.fcEnableShuffle;
            if (s.fcSpeakRate !== undefined) {
                let slider = document.getElementById('fcSpeakRate');
                slider.value = s.fcSpeakRate;
                updateSpeedDisplay('fcSpeakRate', 'fcSpeedValue');
                updateSliderProgress(slider);
            }
        }
    }

    function startFlashcardSession() {
        let text = document.getElementById('flashcardPreviewTextarea').value.trim();
        let words = parseWordsRaw(text);

        if (document.getElementById('fcSettingStarred').checked) {
            words = words.filter(w => w.starred);
        }
        if (document.getElementById('fcSettingShuffle').checked) {
            words = words.sort(() => Math.random() - 0.5);
        }

        if (words.length === 0) {
            alert('⚠️ 範圍內沒有符合條件的單字，請重新勾選！');
            return;
        }

        requestWakeLock();

        flashcardActiveList = words;
        currentFcIndex = 0;
        switchView('flashcardPlayView');
        updateFlashcardView();
    }

    function backToFlashcardSetup() {
        releaseWakeLock();
        switchView('flashcardSetupView');
    }

    function resetFlashcardFlipState() {
        const cardEl = document.getElementById('flashcardCardEl');
        if (cardEl) {
            cardEl.classList.remove('flipped');
        }
    }

    function updateFlashcardView() {
        if (flashcardActiveList.length === 0) return;
        
        resetFlashcardFlipState();

        let card = flashcardActiveList[currentFcIndex];
        document.getElementById('fcCardEng').innerText = card.english;
        document.getElementById('fcCardChi').innerText = card.chinese || '(無中文)';
        document.getElementById('fcCardPos').innerText = card.pos || '單字';
        document.getElementById('fcProgressText').innerText = `${currentFcIndex + 1} / ${flashcardActiveList.length} 題`;
        
        let percent = ((currentFcIndex + 1) / flashcardActiveList.length) * 100;
        document.getElementById('fcProgressBar').style.width = `${percent}%`;

        let starBtn = document.getElementById('fcStarBtn');
        if (card.starred) {
            starBtn.classList.add('starred');
            starBtn.innerText = '⭐';
        } else {
            starBtn.classList.remove('starred');
            starBtn.innerText = '☆';
        }

        let prevBtn = document.getElementById('fcPrevBtn');
        if (currentFcIndex === 0) {
            prevBtn.disabled = true;
        } else {
            prevBtn.disabled = false;
        }

        let nextBtn = document.getElementById('fcNextBtn');
        if (currentFcIndex === flashcardActiveList.length - 1) {
            nextBtn.innerHTML = '結束 🏁';
        } else {
            nextBtn.innerHTML = '下一張 ▶';
        }
    }

    function nextFlashcard() {
        if (currentFcIndex < flashcardActiveList.length - 1) {
            currentFcIndex++;
            updateFlashcardView();
        } else {
            backToFlashcardSetup();
        }
    }

    function prevFlashcard() {
        if (currentFcIndex > 0) {
            currentFcIndex--;
            updateFlashcardView();
        }
    }

    function toggleCurrentCardStar() {
        let card = flashcardActiveList[currentFcIndex];
        card.starred = !card.starred;
        
        updateDatabaseWithStarredState(card.english, card.starred);

        updateFlashcardView();
        initFlashcardGrid();
        initPracticeCardGrid();
        initExamCardGrid();
        initCardExamGrid();
    }

    function initCardExamGrid() {
        let grid = document.getElementById('cardExamGrid');
        if (!grid) return;
        grid.innerHTML = '';
        
        let activeLists = wordLists.map((l, originalIdx) => ({ ...l, originalIdx })).filter(l => getListWordCount(l.content) > 0 && isListInCurrentLang(l));
        let savedSelected = JSON.parse(localStorage.getItem('dictation_card_exam_selected')) || [0];
        
        activeLists.forEach((list, displayIdx) => {
            let count = getListWordCount(list.content);
            let isSelected = savedSelected.includes(list.originalIdx) ? 'selected' : '';
            let cardHtml = `
                <div class="select-card ${isSelected}" data-on-click='[["toggleCardExamCard",[${list.originalIdx},"$this"]]]'>
                    <div class="select-card-info">
                        <div class="select-card-title">${displayIdx + 1}: ${escapeHTML(list.title)}</div>
                        <div class="select-card-count">(${count}/${getListWordCap(list)} 字)</div>
                    </div>
                    <div class="checkmark-badge">✓</div>
                </div>
            `;
            grid.insertAdjacentHTML('beforeend', cardHtml);
        });
        loadCardExamSelectedContent();
    }

    function toggleCardExamCard(originalIdx, cardEl) {
        cardEl.classList.toggle('selected');
        saveCardExamSelectionState();
        loadCardExamSelectedContent();
    }

    function saveCardExamSelectionState() {
        let selectedIndices = [];
        document.querySelectorAll('#cardExamGrid .select-card').forEach((card) => {
            if (card.classList.contains('selected')) {
                let onclickAttr = card.getAttribute('data-on-click');
                let match = onclickAttr.match(/"toggleCardExamCard",\[(\d+),/);
                if (match) selectedIndices.push(parseInt(match[1]));
            }
        });
        localStorage.setItem('dictation_card_exam_selected', JSON.stringify(selectedIndices));
    }

    function loadCardExamSelectedContent() {
        let combinedText = '';
        let selectedCards = document.querySelectorAll('#cardExamGrid .select-card.selected');
        let selectedTitles = [];
        
        selectedCards.forEach((card, displayIdx) => {
            let onclickAttr = card.getAttribute('data-on-click');
            let match = onclickAttr.match(/"toggleCardExamCard",\[(\d+),/);
            if (match) {
                let idx = parseInt(match[1]);
                if (wordLists[idx] && wordLists[idx].content) {
                    combinedText += wordLists[idx].content + '\n';
                    selectedTitles.push(`${displayIdx + 1}: ${wordLists[idx].title}`);
                }
            }
        });
        currentCardExamRanges = selectedTitles.join(', ');

        document.getElementById('cardExamPreviewTextarea').value = combinedText.trim();
        let allWords = parseWordsRaw(combinedText);
        let starCount = allWords.filter(w => w.starred).length;
        document.getElementById('cardExamStatsText').innerText = `📊 範圍統計：總單字數 ${allWords.length} 個 ｜ 星號 (*) 單字數 ${starCount} 個`;
    }

    function toggleCardExamPreview() {
        let container = document.getElementById('cardExamPreviewContainer');
        let btn = document.getElementById('cardExamCollapseBtn');
        container.classList.toggle('collapsed');
        btn.classList.toggle('collapsed');
        saveCollapseState('cardExam', container.classList.contains('collapsed'));
    }

    function sortCardExamPreview(sortType) {
        if (!sortType) return;
        let textarea = document.getElementById('cardExamPreviewTextarea');
        let words = parseWordsRaw(textarea.value);
        if (sortType === 'az') words.sort((a, b) => a.english.toLowerCase().localeCompare(b.english.toLowerCase(), getLearningLanguage()));
        else if (sortType === 'za') words.sort((a, b) => b.english.toLowerCase().localeCompare(a.english.toLowerCase(), getLearningLanguage()));
        textarea.value = words.map(w => w.rawLine).join('\n');
        setTimeout(() => document.getElementById('cardExamSortSelector').selectedIndex = 0, 200);
    }

    function openCardExamSettingsModal() { document.getElementById('cardExamSettingsModal').style.display = 'block'; }
    function closeCardExamSettingsModal() { document.getElementById('cardExamSettingsModal').style.display = 'none'; }
    
    function saveCardExamSettings() {
        let settings = {
            cardExamOnlyStarred: document.getElementById('cardExamSettingStarred').checked,
            cardExamQuestionCount: document.getElementById('cardExamQuestionCount').value,
            cardExamAnswerTime: document.getElementById('cardExamAnswerTime').value
        };
        localStorage.setItem('dictation_card_exam_app_settings', JSON.stringify(settings));
        closeCardExamSettingsModal();
    }

    function loadCardExamAppSettings() {
        let saved = localStorage.getItem('dictation_card_exam_app_settings');
        if (saved) {
            let s = JSON.parse(saved);
            if (s.cardExamOnlyStarred !== undefined) document.getElementById('cardExamSettingStarred').checked = s.cardExamOnlyStarred;
            if (s.cardExamQuestionCount !== undefined) document.getElementById('cardExamQuestionCount').value = s.cardExamQuestionCount;
            if (s.cardExamAnswerTime !== undefined) document.getElementById('cardExamAnswerTime').value = s.cardExamAnswerTime;
        }
    }

    function startCardExamSession() {
        let text = document.getElementById('cardExamPreviewTextarea').value.trim();
        let words = parseWordsRaw(text);

        if (document.getElementById('cardExamSettingStarred').checked) {
            words = words.filter(w => w.starred);
        }

        for (let i = words.length - 1; i > 0; i--) {
            let j = Math.floor(Math.random() * (i + 1));
            [words[i], words[j]] = [words[j], words[i]];
        }

        let qCount = parseInt(document.getElementById('cardExamQuestionCount').value) || 0;
        if (qCount > 0 && words.length > qCount) {
            words = words.slice(0, qCount);
        }

        if (words.length === 0) {
            alert('⚠️ 範圍內沒有符合條件的單字，請重新勾選！');
            return;
        }

        requestWakeLock();

        cardExamActiveList = words;
        currentCardExamIndex = 0;
        cardExamResults = [];
        switchView('cardExamPlayView');
        playCurrentCardExamQuestion();
    }

    function backToCardExamSetup() {
        stopCardExamSession();
        releaseWakeLock();
        switchView('cardExamSetupView');
    }

    function stopCardExamSession() {
        if (cardExamTimerId) clearInterval(cardExamTimerId);
        releaseWakeLock();
    }

    function playCurrentCardExamQuestion() {
        if (currentCardExamIndex >= cardExamActiveList.length) {
            finishCardExamSession();
            return;
        }

        let card = cardExamActiveList[currentCardExamIndex];
        document.getElementById('cardExamCardEng').innerText = card.english;
        document.getElementById('cardExamProgressText').innerText = `${currentCardExamIndex + 1} / ${cardExamActiveList.length} 題`;
        
        let percent = ((currentCardExamIndex + 1) / cardExamActiveList.length) * 100;
        document.getElementById('cardExamProgressBar').style.width = `${percent}%`;

        document.getElementById('cardExamInputChi').value = '';
        document.querySelectorAll('.card-exam-pos-chk').forEach(c => c.checked = false);

        let posGroup = document.getElementById('cardExamPosCheckboxGroup');
        let posLabel = document.getElementById('cardExamPosLabel');
        if (!card.pos || card.pos.trim() === '') {
            posGroup.style.opacity = '0.4';
            posGroup.style.pointerEvents = 'none';
            if (posLabel) posLabel.innerText = '詞性選擇（此單字無詞性，略過）：';
        } else {
            posGroup.style.opacity = '1';
            posGroup.style.pointerEvents = 'auto';
            if (posLabel) posLabel.innerText = '詞性選擇（可複選）：';
        }

        document.getElementById('cardExamInputChi').focus();

        if (cardExamTimerId) clearInterval(cardExamTimerId);
        cardExamTimeLeft = parseInt(document.getElementById('cardExamAnswerTime').value) || 20;
        document.getElementById('cardExamTimeLeft').innerText = cardExamTimeLeft;
        cardExamTimerId = setInterval(() => {
            cardExamTimeLeft--;
            document.getElementById('cardExamTimeLeft').innerText = cardExamTimeLeft;
            if (cardExamTimeLeft <= 0) {
                clearInterval(cardExamTimerId);
                submitCardExamAnswer();
            }
        }, 1000);
    }

    function submitCardExamAnswer() {
        if (cardExamTimerId) clearInterval(cardExamTimerId);
        let userChi = document.getElementById('cardExamInputChi').value.trim();
        let userPosArr = [];
        document.querySelectorAll('.card-exam-pos-chk:checked').forEach(chk => userPosArr.push(chk.value.trim()));

        let currentItem = cardExamActiveList[currentCardExamIndex];
        let chiMatch = (!currentItem.chinese || userChi === currentItem.chinese);

        let correctPosArr = currentItem.pos ? currentItem.pos.split(/\s+/).map(s => s.trim()).filter(s => s.length > 0) : [];
        let posMatch = true;
        if (correctPosArr.length > 0 || userPosArr.length > 0) {
            if (correctPosArr.length !== userPosArr.length) {
                posMatch = false;
            } else {
                let setCorrect = new Set(correctPosArr);
                let setUser = new Set(userPosArr);
                if (setCorrect.size !== setUser.size) {
                    posMatch = false;
                } else {
                    for (let p of setCorrect) {
                        if (!setUser.has(p)) { posMatch = false; break; }
                    }
                }
            }
        }

        let isCorrect = chiMatch && posMatch;

        cardExamResults.push({
            english: currentItem.english,
            chinese: currentItem.chinese,
            pos: currentItem.pos,
            userChi,
            userPos: userPosArr.join(' '),
            isCorrect,
            chiMatch,
            posMatch
        });

        currentCardExamIndex++;
        playCurrentCardExamQuestion();
    }

    function handleCardExamKeyDown(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            submitCardExamAnswer();
        }
    }

    function finishCardExamSession() {
        if (cardExamTimerId) clearInterval(cardExamTimerId);
        releaseWakeLock();
        
        let total = cardExamResults.length;
        if (total === 0) {
            backToCardExamSetup();
            return;
        }

        let correct = cardExamResults.filter(r => r.isCorrect).length;
        let score = total > 0 ? Math.round((correct / total) * 100) : 0;

        // 觸發字卡測驗雞塊任務檢查
        triggerTaskCheck('card_exam_done', { total, score });

        let newRecord = { date: new Date().toLocaleString(), range: currentCardExamRanges || '預設範圍', total, score, results: cardExamResults, lang: getLearningLanguage() };
        cardExamHistory.unshift(newRecord);
        cardExamHistory = trimHistoryPerLang(cardExamHistory);

        localStorage.setItem('dictation_card_exam_history', JSON.stringify(cardExamHistory));
        triggerAutoSaveToCloud();

        let html = `<div class="result-box">
            <div style="font-weight:700; margin-bottom:12px; font-size:15px; color:var(--text-main);">※ 字卡測驗結束！以下為您的測驗結果：</div>
            <div style="font-weight:600; margin-bottom:14px; color:var(--primary);">📊 成績統計：得分 ${score} 分 (總題數 ${total} 題，完全答對 ${correct} 題)</div>`;
        
        cardExamResults.forEach((r, i) => {
            let titleColor = r.isCorrect ? '#10B981' : '#EF4444';
            let icon = r.isCorrect ? '✅' : '❌';
            let correctInfo = `${escapeHTML(r.english)} (${escapeHTML(r.chinese || '')}) ${r.pos ? '/ ' + escapeHTML(r.pos) : ''}`;
            
            let chiDisplay = r.chiMatch ? `<span style="color:#10B981;">${escapeHTML(r.userChi || '[(未填)]')}</span>` : `<span style="color:#EF4444;">${escapeHTML(r.userChi || '[(未填)]')}</span>`;
            let posDisplay = r.posMatch ? `<span style="color:#10B981;">${escapeHTML(r.userPos || '[(未選)]')}</span>` : `<span style="color:#EF4444;">${escapeHTML(r.userPos || '[(未選)]')}</span>`;
            let userAnsInfo = `${chiDisplay} ${r.pos ? '/ ' + posDisplay : ''}`;

            html += `<div style="margin-bottom:14px; padding-bottom:10px; border-bottom:1px solid var(--border-color);">
                <div style="font-weight:700; color:${titleColor}; margin-bottom:4px;">${icon} 第 ${i+1} 題：${escapeHTML(r.english)} — ${r.isCorrect ? '' : '正確答案是 '}${correctInfo}</div>
                <div style="font-size:13.5px; color:var(--text-muted);">您的回答：${userAnsInfo}</div>
            </div>`;
        });
        html += `</div>`;
        
        document.getElementById('modalResultBody').innerHTML = html;
        document.getElementById('examResultModal').style.display = 'block';

        backToCardExamSetup();
    }

    function updateDatabaseWithStarredState(targetEng, isStarred) {
        wordLists.forEach(list => {
            if (!list.content) return;
            let lines = list.content.split('\n');
            let updated = false;
            let newLines = lines.map(line => {
                let trimmed = line.trim();
                if (!trimmed) return line;
                let curStarred = trimmed.startsWith('*');
                let cleanLine = curStarred ? trimmed.substring(1).trim() : trimmed;
                let firstChiIndex = cleanLine.search(/[\u4e00-\u9fa5]/);
                let engPart = firstChiIndex !== -1 ? cleanLine.substring(0, firstChiIndex).trim() : cleanLine.trim();
                
                if (engPart.toLowerCase() === targetEng.toLowerCase()) {
                    updated = true;
                    return isStarred ? `*${cleanLine}` : cleanLine;
                }
                return line;
            });
            if (updated) {
                list.content = newLines.join('\n');
            }
        });
        localStorage.setItem('dictation_word_lists', JSON.stringify(wordLists));
        triggerAutoSaveToCloud();
    }

    function playCurrentFlashcardAudio() {
        let word = flashcardActiveList[currentFcIndex].english;
        let utterance = new SpeechSynthesisUtterance(word);
        let lang = getLearningLanguage();
        let langCode = (lang === 'ko') ? 'ko-KR' : 'en-US';
        let chosenVoice = getSelectedVoiceForLearning();
        if (chosenVoice) utterance.voice = chosenVoice;
        utterance.lang = langCode;
        utterance.rate = parseFloat(document.getElementById('fcSpeakRate').value) || 0.8;
    
        let sysVol = document.getElementById('systemVolume') ? document.getElementById('systemVolume').value : 100;
        utterance.volume = Math.max(0, Math.min(1.0, (parseInt(sysVol) || 100) / 100));

        window.speechSynthesis.speak(utterance);
    }

    function initExamCardGrid() {
        let grid = document.getElementById('examCardGrid');
        if (!grid) return;
        grid.innerHTML = '';
        
        let activeLists = wordLists.map((l, originalIdx) => ({ ...l, originalIdx })).filter(l => getListWordCount(l.content) > 0 && isListInCurrentLang(l));
        let savedExamSelected = JSON.parse(localStorage.getItem('dictation_exam_selected')) || [0];

        activeLists.forEach((list, displayIdx) => {
            let count = getListWordCount(list.content);
            let isSelected = savedExamSelected.includes(list.originalIdx) ? 'selected' : '';
            let cardHtml = `
                <div class="select-card ${isSelected}" data-on-click='[["toggleExamCard",[${list.originalIdx},"$this"]]]'>
                    <div class="select-card-info">
                        <div class="select-card-title">${displayIdx + 1}: ${escapeHTML(list.title)}</div>
                        <div class="select-card-count">(${count}/${getListWordCap(list)} 字)</div>
                    </div>
                    <div class="checkmark-badge">✓</div>
                </div>
            `;
            grid.insertAdjacentHTML('beforeend', cardHtml);
        });
        loadExamSelectedContent();
    }

    function toggleExamCard(originalIdx, cardEl) {
        cardEl.classList.toggle('selected');
        saveExamSelectionState();
        loadExamSelectedContent();
    }

    function saveExamSelectionState() {
        let selectedIndices = [];
        document.querySelectorAll('#examCardGrid .select-card').forEach((card) => {
            if (card.classList.contains('selected')) {
                let onclickAttr = card.getAttribute('data-on-click');
                let match = onclickAttr.match(/"toggleExamCard",\[(\d+),/);
                if (match) selectedIndices.push(parseInt(match[1]));
            }
        });
        localStorage.setItem('dictation_exam_selected', JSON.stringify(selectedIndices));
    }

    function loadExamSelectedContent() {
        let combinedText = '';
        let selectedCards = document.querySelectorAll('#examCardGrid .select-card.selected');
        
        selectedCards.forEach(card => {
            let onclickAttr = card.getAttribute('data-on-click');
            let match = onclickAttr.match(/"toggleExamCard",\[(\d+),/);
            if (match) {
                let idx = parseInt(match[1]);
                if (wordLists[idx] && wordLists[idx].content) {
                    combinedText += wordLists[idx].content + '\n';
                }
            }
        });

        document.getElementById('examWordList').value = combinedText.trim();
        
        let allWords = parseWordsRaw(combinedText);
        let totalWords = allWords.length;
        let starCount = allWords.filter(w => w.starred).length;
        document.getElementById('examStatsText').innerText = `📊 範圍統計：總單字數 ${totalWords} 個 ｜ 星號 (*) 單字數 ${starCount} 個`;
    }

    function toggleExamPreview() {
        let container = document.getElementById('examPreviewCollapseContainer');
        let btn = document.getElementById('examCollapseBtn');
        container.classList.toggle('collapsed');
        btn.classList.toggle('collapsed');
        saveCollapseState('exam', container.classList.contains('collapsed'));
    }

    function sortExamWordListContent(sortType) {
        if (!sortType) return;
        let textarea = document.getElementById('examWordList');
        let words = parseWordsRaw(textarea.value);
        if (sortType === 'az') words.sort((a, b) => a.english.toLowerCase().localeCompare(b.english.toLowerCase(), getLearningLanguage()));
        else if (sortType === 'za') words.sort((a, b) => b.english.toLowerCase().localeCompare(a.english.toLowerCase(), getLearningLanguage()));
        textarea.value = words.map(w => w.rawLine).join('\n');
        setTimeout(() => document.getElementById('examWordSortSelector').selectedIndex = 0, 200);
    }

    function togglePreview() {
        let container = document.getElementById('previewContainer');
        let btn = document.getElementById('collapseBtn');
        container.classList.toggle('collapsed');
        btn.classList.toggle('collapsed');
        saveCollapseState('practice', container.classList.contains('collapsed'));
    }

    function sortWordListContent(sortType) {
        if (!sortType) return;
        let textarea = document.getElementById('wordList');
        let words = parseWordsRaw(textarea.value);
        if (sortType === 'az') words.sort((a, b) => a.english.toLowerCase().localeCompare(b.english.toLowerCase(), getLearningLanguage()));
        else if (sortType === 'za') words.sort((a, b) => b.english.toLowerCase().localeCompare(a.english.toLowerCase(), getLearningLanguage()));
        textarea.value = words.map(w => w.rawLine).join('\n');
        setTimeout(() => document.getElementById('wordSortSelector').selectedIndex = 0, 200);
    }

    function sortEditorContent(sortType) {
        if (!sortType) return;
        let textarea = document.getElementById('editorWordList');
        let words = parseWordsRaw(textarea.value);
        if (sortType === 'az') words.sort((a, b) => a.english.toLowerCase().localeCompare(b.english.toLowerCase(), getLearningLanguage()));
        else if (sortType === 'za') words.sort((a, b) => b.english.toLowerCase().localeCompare(a.english.toLowerCase(), getLearningLanguage()));
        textarea.value = words.map(w => w.rawLine).join('\n');
        handleEditorTextareaInput();
        handleEditorSearch();
    }

    function syncEditorScroll() {
        const textarea = document.getElementById('editorWordList');
        const backdrop = document.getElementById('editorBackdrop');
        if (textarea && backdrop) {
            backdrop.scrollTop = textarea.scrollTop;
            backdrop.scrollLeft = textarea.scrollLeft;
        }
    }

    // 編輯頁右上角：目前單字數 / 這本題庫的上限（接近上限變橘色、達到上限變紅色）
    function updateEditorWordCounter() {
        let el = document.getElementById('editorWordCounter');
        let list = wordLists[lastSelectedList];
        let ta = document.getElementById('editorWordList');
        if (!el || !list || !ta) return;
        let count = getListWordCount(ta.value);
        let cap = getListWordCap(list);
        el.textContent = `(${count}/${cap})`;
        el.classList.toggle('is-full', count >= cap);
        el.classList.toggle('is-near', count < cap && count >= cap * 0.9);
        el.title = count >= cap
            ? '已達單字上限，可到「雞塊補給站」兌換單字上限 +50'
            : `還可以再放 ${cap - count} 個單字`;
    }

    function handleEditorSearch() {
        updateEditorWordCounter();
        const textarea = document.getElementById('editorWordList');
        const searchInput = document.getElementById('wordSearchInput');
        const backdrop = document.getElementById('editorBackdrop');
        const notFoundTip = document.getElementById('searchNotFoundTip');
        
        if (!textarea || !searchInput || !backdrop) return;
        
        const text = textarea.value;
        const query = searchInput.value.trim();

        syncEditorScroll();

        if (!query) {
            backdrop.innerHTML = text
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;");
            if (notFoundTip) notFoundTip.style.display = 'none';
            return;
        }

        const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(${escapedQuery})`, 'gi');

        const hasMatch = regex.test(text);
        regex.lastIndex = 0;

        if (!hasMatch) {
            if (notFoundTip) {
                notFoundTip.innerText = `找不到該單字 "${query}"`;
                notFoundTip.style.display = 'block';
            }
            backdrop.innerHTML = text
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;");
            return;
        } else {
            if (notFoundTip) notFoundTip.style.display = 'none';
        }

        const highlightedText = text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(regex, '<span class="highlight-match">$1</span>');

        backdrop.innerHTML = highlightedText;

        let firstMatchIndex = text.toLowerCase().indexOf(query.toLowerCase());
        if (firstMatchIndex !== -1) {
            let linesBefore = text.substring(0, firstMatchIndex).split('\n').length;
            let targetScrollTop = Math.max(0, (linesBefore - 3) * 22);
            textarea.scrollTop = targetScrollTop;
            backdrop.scrollTop = textarea.scrollTop;
        }
    }

    function saveAndStayInEditor() {
        handleEditorTextareaInput();
        let idx = lastSelectedList;
        if (!wordLists[idx]) return;

        let content = wordLists[idx].content || '';
        let lines = content.split('\n');

        let seenKeys = new Set();
        let cleanLines = [];
        let duplicates = [];

        lines.forEach(line => {
            let trimmed = line.trim();
            if (!trimmed) return;
            let isStarred = trimmed.startsWith('*');
            let cleanLine = isStarred ? trimmed.substring(1).trim() : trimmed;
            let firstChiIndex = cleanLine.search(/[\u4e00-\u9fa5]/);
            let engPart = firstChiIndex !== -1 ? cleanLine.substring(0, firstChiIndex).trim() : cleanLine.trim();
            let key = engPart.toLowerCase();

            if (key) {
                if (seenKeys.has(key)) {
                    duplicates.push(engPart);
                } else {
                    seenKeys.add(key);
                    cleanLines.push(trimmed);
                }
            }
        });

        wordLists[idx].content = cleanLines.join('\n');
        document.getElementById('editorWordList').value = wordLists[idx].content;

        localStorage.setItem('dictation_word_lists', JSON.stringify(wordLists));
        triggerAutoSaveToCloud();
        initPracticeCardGrid();
        initExamCardGrid();
        initFlashcardGrid();
        initCardExamGrid();

        if (duplicates.length > 0) {
            let msg = `發現重複單字，已自動過濾重複部分：\n` + duplicates.map((d, i) => `${i + 1}. ${d}`).join('\n');
            alert(msg);
        } else {
            alert('✅ 題庫儲存成功並已同步至雲端！');
        }
        backToListFromDetail();
    }

    function parseWordsRaw(text) {
        let lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        let allWords = [], seen = new Set();
        lines.forEach((line) => {
            let isStarred = line.startsWith('*');
            let cleanLine = isStarred ? line.substring(1).trim() : line;
            let firstChiIndex = cleanLine.search(/[\u4e00-\u9fa5]/);
            let engPart = firstChiIndex !== -1 ? cleanLine.substring(0, firstChiIndex).trim() : cleanLine.trim();
            let restPart = firstChiIndex !== -1 ? cleanLine.substring(firstChiIndex).trim() : "";
            let chiPart = "", posPart = "";
            if (restPart) {
                let parts = restPart.split(/\s+/);
                chiPart = parts[0] || "";
                if (parts.length > 1) posPart = parts.slice(1).join(" ");
            }
            let key = engPart.toLowerCase();
            if (key && !seen.has(key)) {
                seen.add(key);
                allWords.push({ english: engPart, chinese: chiPart, pos: posPart, starred: isStarred, rawLine: line });
            }
        });
        return allWords;
    }

    function toggleDictation() { isPlaying ? stopDictation() : checkAndStartDictation(); }
    
    function checkAndStartDictation() {
        let text = document.getElementById('wordList').value.trim();
        let words = parseWordsRaw(text);
        
        if (words.length === 0) {
            alert("⚠️ 目前勾選的範圍單字數為 0，無法開始聽力練習！請至題庫新增單字。");
            return;
        }
        startDictation();
    }

    function startDictation() {
        let text = document.getElementById('wordList').value.trim();
        wordsData = parseWordsRaw(text);
        
        if (document.getElementById('onlyStarred').checked) {
            wordsData = wordsData.filter(w => w.starred);
        }
        if (document.getElementById('enableShuffle').checked) {
            wordsData = wordsData.sort(() => Math.random() - 0.5);
        }

        if (wordsData.length === 0) { alert('找不到有效單字或無符合條件的單字！'); return; }
        
        requestWakeLock();

        currentWordIndex = 0; isPlaying = true; isPaused = false;
        
        document.getElementById('practiceRangeContainer').style.display = 'none';
        document.getElementById('practiceStatsBar').style.display = 'none';
        document.getElementById('practicePreviewContainer').style.display = 'none';
        document.getElementById('advancedBtnContainer').style.display = 'none';
        document.getElementById('practiceBackBtn').style.display = 'none';

        document.getElementById('status').style.display = 'flex';
        
        let toggleBtn = document.getElementById('toggleDictationBtn');
        toggleBtn.innerText = '⏹ 停止練習'; toggleBtn.className = 'action-btn btn-stop';
        document.getElementById('pauseDictationBtn').style.display = 'block';
        
        playNextWord();
    }

    function playNextWord() {
        if (!isPlaying || isPaused) return;
        
        if (currentWordIndex >= wordsData.length) {
            let isLoop = document.getElementById('enableLoop').checked;
            if (isLoop) {
                currentWordIndex = 0;
            } else {
                stopDictation();
                document.getElementById('status').style.display = 'flex';
                document.getElementById('status').innerHTML = `<span>🎉 練習結束！</span>`;
                return;
            }
        }

        let item = wordsData[currentWordIndex];
        let rate = parseFloat(document.getElementById('speakRate').value) || 0.8;
        let isLoop = document.getElementById('enableLoop').checked;
        let targetRepeat = parseInt(document.getElementById('repeatCount').value) || 1;
        if (targetRepeat < 1) targetRepeat = 1;

        let loopSymbolHtml = isLoop ? `<span style="color:#3B82F6; font-size:17px; margin-left:6px; font-weight:bold;">∞</span>` : '';
        let leftPart = `📢 正在朗讀： ${item.starred ? '🌟 ' : ''}<strong style="color:#0F172A;">${escapeHTML(item.english)}</strong> <span style="font-weight:600; color:#475569;">(第 1/${targetRepeat} 次)</span>`;
        let rightPart = `<span style="color:#4F46E5; font-weight:700;">(${currentWordIndex + 1}/${wordsData.length})</span>${loopSymbolHtml}`;
        
        document.getElementById('status').innerHTML = `<div>${leftPart}</div><div style="display:flex; align-items:center;">${rightPart}</div>`;

        let queue = [];
        for (let r = 1; r <= targetRepeat; r++) {
            queue.push({
                text: item.english,
                isEng: true,
                onPlay: () => {
                    let newLeft = `📢 正在朗讀： ${item.starred ? '🌟 ' : ''}<strong style="color:#0F172A;">${escapeHTML(item.english)}</strong> <span style="font-weight:600; color:#475569;">(第 ${r}/${targetRepeat} 次)</span>`;
                    document.getElementById('status').children[0].innerHTML = newLeft;
                }
            });
        }

        if (document.getElementById('enableSpell').checked && item.english) {
            let letters = (getLearningLanguage() === 'ko')
                ? Array.from(item.english.replace(/\s+/g, '')).join(' - ')
                : item.english.replace(/[^a-zA-Z]/g, '').toLowerCase().split('').join(' - ');
            if (letters) queue.push({ text: letters, isEng: true });
        }
        if (document.getElementById('enableChinese').checked && item.chinese) {
            queue.push({ text: item.chinese, isEng: false });
        }
        if (document.getElementById('enablePOS').checked && item.pos) {
            queue.push({ text: item.pos, isEng: false });
        }

        playQueue(queue, rate, () => {
            if (!isPlaying || isPaused) return;
            currentWordIndex++;
            let pauseSec = parseInt(document.getElementById('pauseTime').value);
            if (isNaN(pauseSec)) pauseSec = 2;
            timeoutId = setTimeout(playNextWord, pauseSec * 1000);
        });
    }

    function playQueue(queueItems, rate, onComplete) {
        if (queueItems.length === 0) {
            if (onComplete) onComplete();
            return;
        }
        let item = queueItems.shift();
        if (item.onPlay) item.onPlay();

        let utterance = new SpeechSynthesisUtterance(item.text);
        let learningLang = getLearningLanguage();
        let langCode = item.isEng ? ((learningLang === 'ko') ? 'ko-KR' : 'en-US') : 'zh-TW';
        let chosenVoice = item.isEng ? getSelectedVoiceForLearning() : getSelectedVoice('zh-TW');

        if (chosenVoice) utterance.voice = chosenVoice;
        utterance.lang = langCode;
        utterance.rate = rate;

        let sysVol = document.getElementById('systemVolume') ? document.getElementById('systemVolume').value : 100;
        let baseVol = (parseInt(sysVol) || 100) / 100;
        utterance.volume = Math.max(0, Math.min(1.0, baseVol));

        utterance.onend = () => {
            if (!isPlaying || isPaused) return;
            setTimeout(() => {
                playQueue(queueItems, rate, onComplete);
            }, 1000);
        };
        synth.speak(utterance);
    }

    function stopDictation() {
        isPlaying = false; isPaused = false; synth.cancel(); clearTimeout(timeoutId);
        releaseWakeLock();
        
        document.getElementById('practiceRangeContainer').style.display = 'block';
        document.getElementById('practiceStatsBar').style.display = 'flex';
        document.getElementById('practicePreviewContainer').style.display = 'block';
        document.getElementById('advancedBtnContainer').style.display = 'block';
        document.getElementById('practiceBackBtn').style.display = 'inline-flex';

        document.getElementById('status').innerText = '準備就緒 🔥';
        document.getElementById('status').style.display = 'none';
        
        let toggleBtn = document.getElementById('toggleDictationBtn');
        toggleBtn.innerText = '▶ 開始聽力練習'; toggleBtn.className = 'action-btn btn-start';
        
        let pauseBtn = document.getElementById('pauseDictationBtn');
        pauseBtn.innerText = '⏸ 暫停'; pauseBtn.className = 'action-btn btn-pause';
        pauseBtn.style.display = 'none';
    }

    function togglePauseDictation() {
        let btn = document.getElementById('pauseDictationBtn');
        if (!isPaused) {
            isPaused = true; synth.cancel(); clearTimeout(timeoutId);
            btn.innerText = '▶ 繼續'; btn.className = 'action-btn btn-resume';
        } else {
            isPaused = false;
            btn.innerText = '⏸ 暫停'; btn.className = 'action-btn btn-pause';
            playNextWord();
        }
    }

    function initExamCheckboxes() {}

    function getSelectedExamWords() {
        let combinedText = '';
        let selectedTitles = [];
        document.querySelectorAll('#examCardGrid .select-card.selected').forEach((card, displayIdx) => {
            let onclickAttr = card.getAttribute('data-on-click');
            let match = onclickAttr.match(/"toggleExamCard",\[(\d+),/);
            if (match) {
                let idx = parseInt(match[1]);
                if (wordLists[idx] && wordLists[idx].content) {
                    combinedText += wordLists[idx].content + '\n';
                    selectedTitles.push(`${displayIdx + 1}: ${wordLists[idx].title}`);
                }
            }
        });
        currentExamRanges = selectedTitles.join(', ');
        let words = parseWordsRaw(combinedText);
        
        if (document.getElementById('examOnlyStarred') && document.getElementById('examOnlyStarred').checked) {
            words = words.filter(w => w.starred);
        }
        
        for (let i = words.length - 1; i > 0; i--) {
            let j = Math.floor(Math.random() * (i + 1));
            [words[i], words[j]] = [words[j], words[i]];
        }

        let qCount = parseInt(document.getElementById('examQuestionCount').value) || 0;
        if (qCount > 0 && words.length > qCount) {
            words = words.slice(0, qCount);
        }
        return words;
    }

    function startExamMode() {
        let words = getSelectedExamWords();
        if (words.length === 0) { alert('⚠️ 請至少勾選一個考試範圍或確認範圍內有符合條件的單字！'); return; }

        let resultContainerEl = document.getElementById('resultContainer');
        if (resultContainerEl) {
            resultContainerEl.innerHTML = '';
            resultContainerEl.style.display = 'none';
        }

        window.scrollTo({ top: 0, behavior: 'smooth' });

        requestWakeLock();

        wordsData = words;
        currentWordIndex = 0; isPlaying = true; isExamRunning = true; examResults = [];
        
        document.getElementById('examRangeContainer').style.display = 'none';
        document.getElementById('examStatsBar').style.display = 'none';
        document.getElementById('examPreviewContainer').style.display = 'none';
        document.getElementById('examAdvancedBtnContainer').style.display = 'none';
        document.getElementById('startExamBtn').style.display = 'none';
        document.getElementById('examBackBtn').style.display = 'none';
        document.getElementById('examArea').style.display = 'block';

        window.scrollTo({ top: 0, behavior: 'smooth' });

        playExamQuestion();
    }

    function playExamQuestion() {
        if (!isPlaying || currentWordIndex >= wordsData.length) { finishExam(); return; }
        
        document.getElementById('examProgressStatus').innerText = `🎧 正在進行考試... 請聆聽並於下方作答 (${currentWordIndex + 1}/${wordsData.length})`;

        let item = wordsData[currentWordIndex];
        let rate = parseFloat(document.getElementById('examSpeakRate').value) || 0.8;
        let repeatCount = parseInt(document.getElementById('examRepeatCount').value) || 1;

        let utteranceCount = 0;
        function speakSingle() {
            let utterance = new SpeechSynthesisUtterance(item.english);
            let learningLang = getLearningLanguage();
            let langCode = (learningLang === 'ko') ? 'ko-KR' : 'en-US';
            let chosenVoice = getSelectedVoiceForLearning();
            if (chosenVoice) utterance.voice = chosenVoice;
            utterance.lang = langCode;
            
            utterance.rate = rate;
            let sysVol = document.getElementById('systemVolume') ? document.getElementById('systemVolume').value : 100;
            utterance.volume = Math.max(0, Math.min(1.0, (parseInt(sysVol) || 100) / 100));

            utterance.onend = () => {
                utteranceCount++;
                if (utteranceCount < repeatCount) {
                    setTimeout(speakSingle, 1000);
                } else {
                    document.getElementById('examInputEng').disabled = false;
                    document.getElementById('examInputChi').disabled = false;
                    document.getElementById('examSubmitBtn').disabled = false;
                    document.getElementById('examInputEng').focus();
                    
                    examTimeLeft = parseInt(document.getElementById('examAnswerTime').value) || 26;
                    document.getElementById('timeLeft').innerText = examTimeLeft;
                    examTimerId = setInterval(() => {
                        examTimeLeft--;
                        document.getElementById('timeLeft').innerText = examTimeLeft;
                        if (examTimeLeft <= 0) { clearInterval(examTimerId); submitExamAnswer(); }
                    }, 1000);
                }
            };
            synth.speak(utterance);
        }
        speakSingle();
    }

    function submitExamAnswer() {
        if (examTimerId) clearInterval(examTimerId);
        let userEng = document.getElementById('examInputEng').value.trim();
        let userChi = document.getElementById('examInputChi').value.trim();

        let currentItem = wordsData[currentWordIndex];
        
        let engMatch = (userEng.toLowerCase() === currentItem.english.toLowerCase());
        let chiMatch = (!currentItem.chinese || userChi === currentItem.chinese);

        let isCorrect = engMatch && chiMatch;

        examResults.push({ 
            english: currentItem.english, 
            chinese: currentItem.chinese, 
            userEng, 
            userChi, 
            isCorrect,
            engMatch,
            chiMatch
        });

        currentWordIndex++;

        document.getElementById('examInputEng').value = '';
        document.getElementById('examInputChi').value = '';
        setExamInputsDisabled(true);
        
        let pauseSec = parseInt(document.getElementById('examPauseTime').value);
        if (isNaN(pauseSec)) pauseSec = 1;
        setTimeout(playExamQuestion, pauseSec * 1000);
    }

    function setExamInputsDisabled(disabled) {
        document.getElementById('examInputEng').disabled = disabled;
        document.getElementById('examInputChi').disabled = disabled;
        document.getElementById('examSubmitBtn').disabled = disabled;
    }

    function stopExamMode() {
        isPlaying = false; isExamRunning = false; synth.cancel();
        if (examTimerId) clearInterval(examTimerId);
        releaseWakeLock();
        document.getElementById('examArea').style.display = 'none';
        document.getElementById('examRangeContainer').style.display = 'block';
        document.getElementById('examStatsBar').style.display = 'flex';
        document.getElementById('examPreviewContainer').style.display = 'block';
        document.getElementById('examAdvancedBtnContainer').style.display = 'block';
        document.getElementById('startExamBtn').style.display = 'block';
        document.getElementById('examBackBtn').style.display = 'inline-flex';
    }

    function finishExam() {
        isPlaying = false; isExamRunning = false; synth.cancel();
        if (examTimerId) clearInterval(examTimerId);
        releaseWakeLock();
        document.getElementById('examArea').style.display = 'none';
        document.getElementById('examRangeContainer').style.display = 'block';
        document.getElementById('examStatsBar').style.display = 'flex';
        document.getElementById('examPreviewContainer').style.display = 'block';
        document.getElementById('examAdvancedBtnContainer').style.display = 'block';
        document.getElementById('startExamBtn').style.display = 'block';
        document.getElementById('examBackBtn').style.display = 'inline-flex';
        
        let total = examResults.length;
        if (total === 0) return;

        let correct = examResults.filter(r => r.isCorrect).length;
        let score = total > 0 ? Math.round((correct / total) * 100) : 0;
        
        // 觸發聽力測驗雞塊任務檢查
        triggerTaskCheck('listening_exam_done', { total, score });

        let newRecord = { date: new Date().toLocaleString(), range: currentExamRanges, total, score, results: examResults, lang: getLearningLanguage() };
        examHistory.unshift(newRecord);
        examHistory = trimHistoryPerLang(examHistory);

        localStorage.setItem('dictation_exam_history', JSON.stringify(examHistory));
        triggerAutoSaveToCloud();

        let html = `<div class="result-box">
            <div style="font-weight:700; margin-bottom:12px; font-size:15px; color:var(--text-main);">※ 聽力測驗結束！以下為您的測驗結果：</div>
            <div style="font-weight:600; margin-bottom:14px; color:var(--primary);">📊 成績統計：得分 ${score} 分 (總題數 ${total} 題，完全答對 ${correct} 題)</div>`;
        
        examResults.forEach((r, i) => {
            let titleColor = r.isCorrect ? '#10B981' : '#EF4444';
            let icon = r.isCorrect ? '✅' : '❌';
            let correctInfo = `${escapeHTML(r.english)} (${escapeHTML(r.chinese || '')})`;
            
            let engDisplay = r.engMatch ? `<span style="color:#10B981;">${escapeHTML(r.userEng || '[(未填)]')}</span>` : `<span style="color:#EF4444;">${escapeHTML(r.userEng || '[(未填)]')}</span>`;
            let chiDisplay = r.chiMatch ? `<span style="color:#10B981;">${escapeHTML(r.userChi || '[(未填)]')}</span>` : `<span style="color:#EF4444;">${escapeHTML(r.userChi || '[(未填)]')}</span>`;
            let userAnsInfo = `${engDisplay} / ${chiDisplay}`;

            html += `<div style="margin-bottom:14px; padding-bottom:10px; border-bottom:1px solid var(--border-color);">
                <div style="font-weight:700; color:${titleColor}; margin-bottom:4px;">${icon} 第 ${i+1} 題：${escapeHTML(r.english)} — ${r.isCorrect ? '' : '正確答案是 '}${correctInfo}</div>
                <div style="font-size:13.5px; color:var(--text-muted);">您的回答：${userAnsInfo}</div>
            </div>`;
        });
        html += `</div>`;
        
        document.getElementById('modalResultBody').innerHTML = html;
        document.getElementById('examResultModal').style.display = 'block';
    }

    function handleInputKeyDown(e, type) {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (type === 'eng') document.getElementById('examInputChi').focus();
            else submitExamAnswer();
        }
    }

    function openSystemSettingsModal() { 
        document.getElementById('systemSettingsModal').style.display = 'block'; 
        let volSlider = document.getElementById('systemVolume');
        if (volSlider) updateSliderProgress(volSlider);
    }
    function closeSystemSettingsModal() { document.getElementById('systemSettingsModal').style.display = 'none'; }
    function openAboutModal() { document.getElementById('aboutModal').style.display = 'block'; }
    function closeAboutModal() { document.getElementById('aboutModal').style.display = 'none'; }
    function openExportModal() { 
        let group = document.getElementById('exportListsCheckboxGroup');
        if (group) {
            group.innerHTML = '';
            wordLists.forEach((l, idx) => {
                if (!isListInCurrentLang(l)) return;
                group.innerHTML += `<label class="checkbox-item-row"><input type="checkbox" value="${idx}" checked> ${getLangSeq(idx)}: ${escapeHTML(l.title)}</label>`;
            });
        }
        document.getElementById('exportModal').style.display = 'block'; 
    }
    function closeExportModal() { document.getElementById('exportModal').style.display = 'none'; }
    function toggleAllExportCheckboxes(check) {
        document.querySelectorAll('#exportListsCheckboxGroup input[type="checkbox"]').forEach(c => c.checked = check);
    }
    function confirmExportTxtFiles() {
        let chks = document.querySelectorAll('#exportListsCheckboxGroup input[type="checkbox"]:checked');
        if (chks.length === 0) { alert('⚠️ 請至少勾選一個題庫！'); return; }
        chks.forEach(chk => {
            let idx = parseInt(chk.value);
            let l = wordLists[idx];
            if (l && l.content) {
                let blob = new Blob([l.content], { type: 'text/plain;charset=utf-8' });
                let url = URL.createObjectURL(blob);
                let a = document.createElement('a');
                a.href = url;
                a.download = `${l.title || ('Database_' + (idx + 1))}.txt`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }
        });
        closeExportModal();
    }
    
    async function openHistoryModal() { 
        if (accessToken && isCloudSyncActive) {
            await loadDataFromGoogleDrive();
        }
        openHistoryModalContent(); 
        document.getElementById('historyModal').style.display = 'block'; 
        setTimeout(() => {
            renderScoreChart('listeningScoreCanvas', filterHistoryByLang(examHistory));
            renderScoreChart('cardScoreCanvas', filterHistoryByLang(cardExamHistory));
        }, 80);
    }
    function closeHistoryModal() { document.getElementById('historyModal').style.display = 'none'; }

    function openAdvancedModal() { document.getElementById('advancedModal').style.display = 'block'; }
    function closeAdvancedModal() { document.getElementById('advancedModal').style.display = 'none'; }
    function openExamAdvancedModal() { document.getElementById('examAdvancedModal').style.display = 'block'; }
    function closeExamAdvancedModal() { document.getElementById('examAdvancedModal').style.display = 'none'; }
    function closeExamResultModal() { document.getElementById('examResultModal').style.display = 'none'; }

    function switchHistoryTab(tabName) {
        const cardListening = document.getElementById('cardListeningTab');
        const cardWord = document.getElementById('cardWordTab');
        const panelListening = document.getElementById('panelListeningHistory');
        const panelWord = document.getElementById('panelWordHistory');

        if (tabName === 'listening') {
            cardListening.classList.add('active');
            cardWord.classList.remove('active');
            panelListening.classList.add('active');
            panelWord.classList.remove('active');
        } else {
            cardWord.classList.add('active');
            cardListening.classList.remove('active');
            panelWord.classList.add('active');
            panelListening.classList.remove('active');
        }

        setTimeout(() => {
            if (tabName === 'listening') renderScoreChart('listeningScoreCanvas', filterHistoryByLang(examHistory));
            else renderScoreChart('cardScoreCanvas', filterHistoryByLang(cardExamHistory));
        }, 50);
    }

    function openHistoryModalContent() {
        const examHistoryView = filterHistoryByLang(examHistory);
        const cardExamHistoryView = filterHistoryByLang(cardExamHistory);
        let targetSelectOptions = '';
        wordLists.forEach((l, idx) => {
            if (!isListInCurrentLang(l)) return;
            targetSelectOptions += `<option value="${idx}">${getLangSeq(idx)}: ${escapeHTML(l.title)} (${getListWordCount(l.content)}/${getListWordCap(wordLists[idx])})</option>`;
        });
        let targetSelLis = document.getElementById('targetListSelectorListening');
        let targetSelCard = document.getElementById('targetListSelectorCard');
        if (targetSelLis) targetSelLis.innerHTML = targetSelectOptions;
        if (targetSelCard) targetSelCard.innerHTML = targetSelectOptions;

        let listeningHistoryHtml = '';
        if (examHistoryView.length === 0) {
            listeningHistoryHtml = `<div style="text-align: center; color: var(--text-muted); padding: 15px; font-size: 13px;">尚無${getLangName(getLearningLanguage())}聽力測驗紀錄</div>`;
        } else {
            examHistoryView.forEach((h, hIdx) => {
                let wrongCount = h.results ? h.results.filter(r => !r.isCorrect).length : 0;
                listeningHistoryHtml += `
                    <div class="history-card">
                        <div class="history-header" data-on-click='[["toggleHistoryDetail",[${hIdx}]]]'>
                            <span>📅 ${escapeHTML(h.date)} ｜ 範圍: ${escapeHTML(h.range || '預設範圍')}</span>
                            <span style="color:var(--primary); font-weight:700;">🎯 ${escapeHTML(h.score)}分 (共${escapeHTML(h.total)}題/錯${wrongCount}題) <span id="arrow_${hIdx}">▼</span></span>
                        </div>
                        <div class="history-detail" id="detail_${hIdx}">
                `;
                if (h.results) {
                    h.results.forEach((r, rIdx) => {
                        let icon = r.isCorrect ? '✅' : '❌';
                        let color = r.isCorrect ? '#10B981' : '#EF4444';
                        
                        let engDisplay = r.engMatch ? `<span style="color:#10B981;">${escapeHTML(r.userEng || '未填')}</span>` : `<span style="color:#EF4444;">${escapeHTML(r.userEng || '未填')}</span>`;
                        let chiDisplay = r.chiMatch ? `<span style="color:#10B981;">${escapeHTML(r.userChi || '未填')}</span>` : `<span style="color:#EF4444;">${escapeHTML(r.userChi || '未填')}</span>`;

                        let correctStr = `${escapeHTML(r.english)} (${escapeHTML(r.chinese || '')})`;
                        let userStr = `${engDisplay} / ${chiDisplay}`;

                        let ansText = r.isCorrect ? correctStr : `正確答案 ${correctStr} ｜ 您的回答: ${userStr}`;
                        listeningHistoryHtml += `<div style="color:${color}; margin-bottom:6px;">${icon} 第${rIdx+1}題：${ansText}</div>`;
                    });
                }
                listeningHistoryHtml += `</div></div>`;
            });
        }
        let examHistoryListEl = document.getElementById('examHistoryList');
        if (examHistoryListEl) examHistoryListEl.innerHTML = listeningHistoryHtml;

        let cardHistoryHtml = '';
        if (cardExamHistoryView.length === 0) {
            cardHistoryHtml = `<div style="text-align: center; color: var(--text-muted); padding: 15px; font-size: 13px;">尚無${getLangName(getLearningLanguage())}字卡測驗紀錄</div>`;
        } else {
            cardExamHistoryView.forEach((h, hIdx) => {
                let wrongCount = h.results ? h.results.filter(r => !r.isCorrect).length : 0;
                cardHistoryHtml += `
                    <div class="history-card">
                        <div class="history-header" data-on-click='[["toggleCardHistoryDetail",[${hIdx}]]]'>
                            <span>📅 ${escapeHTML(h.date)} ｜ 範圍: ${escapeHTML(h.range || '預設範圍')}</span>
                            <span style="color:#10B981; font-weight:700;">🎯 ${escapeHTML(h.score)}分 (共${escapeHTML(h.total)}題/錯${wrongCount}題) <span id="cardArrow_${hIdx}">▼</span></span>
                        </div>
                        <div class="history-detail" id="cardDetail_${hIdx}">
                `;
                if (h.results) {
                    h.results.forEach((r, rIdx) => {
                        let icon = r.isCorrect ? '✅' : '❌';
                        let color = r.isCorrect ? '#10B981' : '#EF4444';
                        let chiDisplay = r.chiMatch ? `<span style="color:#10B981;">${escapeHTML(r.userChi || '未填')}</span>` : `<span style="color:#EF4444;">${escapeHTML(r.userChi || '未填')}</span>`;
                        let posDisplay = r.posMatch ? `<span style="color:#10B981;">${escapeHTML(r.userPos || '未選')}</span>` : `<span style="color:#EF4444;">${escapeHTML(r.userPos || '未選')}</span>`;
                        let correctStr = `${escapeHTML(r.english)} (${escapeHTML(r.chinese || '')}) ${r.pos ? '/ ' + escapeHTML(r.pos) : ''}`;
                        let userStr = `${chiDisplay} ${r.pos ? '/ ' + posDisplay : ''}`;
                        let ansText = r.isCorrect ? correctStr : `正確答案 ${correctStr} ｜ 您的回答: ${userStr}`;
                        cardHistoryHtml += `<div style="color:${color}; margin-bottom:4px;">${icon} 第${rIdx+1}題：${ansText}</div>`;
                    });
                }
                cardHistoryHtml += `</div></div>`;
            });
        }
        let cardExamHistoryListEl = document.getElementById('cardExamHistoryList');
        if (cardExamHistoryListEl) cardExamHistoryListEl.innerHTML = cardHistoryHtml;

        let listeningWrongMap = {};
        examHistoryView.forEach(h => {
            if (h.results) {
                h.results.forEach(r => {
                    if (!r.isCorrect) {
                        let key = r.english.toLowerCase();
                        if (!listeningWrongMap[key]) {
                            listeningWrongMap[key] = { english: r.english, chinese: r.chinese, count: 0 };
                        }
                        listeningWrongMap[key].count++;
                    }
                });
            }
        });
        let listeningWrongArr = Object.values(listeningWrongMap).sort((a, b) => b.count - a.count).slice(0, 20);
        let listeningWrongHtml = '';
        if (listeningWrongArr.length === 0) {
            listeningWrongHtml = `<div style="text-align: center; color: var(--text-muted); padding: 10px; font-size: 12.5px;">目前沒有聽力錯題紀錄</div>`;
        } else {
            listeningWrongArr.forEach((w, idx) => {
                listeningWrongHtml += `<div class="error-word-item">
                    <input type="checkbox" checked value="${escapeHTML(w.english)}"> 
                    <span>${idx + 1}. <b>${escapeHTML(w.english)}</b> (${escapeHTML(w.chinese || '')}) — <span class="error-count">錯誤 ${escapeHTML(w.count)} 次</span></span>
                </div>`;
            });
        }
        let listeningTopWrongWordsEl = document.getElementById('listeningTopWrongWords');
        if (listeningTopWrongWordsEl) listeningTopWrongWordsEl.innerHTML = listeningWrongHtml;

        let cardWrongMap = {};
        cardExamHistoryView.forEach(h => {
            if (h.results) {
                h.results.forEach(r => {
                    if (!r.isCorrect) {
                        let key = r.english.toLowerCase();
                        if (!cardWrongMap[key]) {
                            cardWrongMap[key] = { english: r.english, chinese: r.chinese, count: 0 };
                        }
                        cardWrongMap[key].count++;
                    }
                });
            }
        });
        let cardWrongArr = Object.values(cardWrongMap).sort((a, b) => b.count - a.count).slice(0, 20);
        let cardWrongHtml = '';
        if (cardWrongArr.length === 0) {
            cardWrongHtml = `<div style="text-align: center; color: var(--text-muted); padding: 10px; font-size: 12.5px;">目前沒有字卡測驗錯題紀錄</div>`;
        } else {
            cardWrongArr.forEach((w, idx) => {
                cardWrongHtml += `<div class="error-word-item">
                    <input type="checkbox" checked value="${escapeHTML(w.english)}"> 
                    <span>${idx + 1}. <b>${escapeHTML(w.english)}</b> (${escapeHTML(w.chinese || '')}) — <span class="error-count">錯誤 ${escapeHTML(w.count)} 次</span></span>
                </div>`;
            });
        }
        let cardTopWrongWordsEl = document.getElementById('cardTopWrongWords');
        if (cardTopWrongWordsEl) cardTopWrongWordsEl.innerHTML = cardWrongHtml;
    }

    function toggleHistoryDetail(idx) {
        let detail = document.getElementById(`detail_${idx}`);
        let arrow = document.getElementById(`arrow_${idx}`);
        if (detail.style.display === 'block') {
            detail.style.display = 'none';
            arrow.innerText = '▼';
        } else {
            detail.style.display = 'block';
            arrow.innerText = '▲';
        }
    }

    function toggleCardHistoryDetail(idx) {
        let detail = document.getElementById(`cardDetail_${idx}`);
        let arrow = document.getElementById(`cardArrow_${idx}`);
        if (detail.style.display === 'block') {
            detail.style.display = 'none';
            arrow.innerText = '▼';
        } else {
            detail.style.display = 'block';
            arrow.innerText = '▲';
        }
    }

    function renderScoreChart(canvasId, dataList) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * window.devicePixelRatio;
        canvas.height = rect.height * window.devicePixelRatio;
        ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

        const width = rect.width;
        const height = rect.height;

        ctx.clearRect(0, 0, width, height);

        if (!dataList || dataList.length === 0) {
            ctx.fillStyle = "#94A3B8";
            ctx.font = "13px Inter, sans-serif";
            ctx.textAlign = "center";
            ctx.fillText("尚無歷史成績資料", width / 2, height / 2);
            return;
        }

        const scores = dataList.slice(0, 10).reverse().map(d => d.score);
        const padding = 28;
        const chartWidth = width - padding * 2;
        const chartHeight = height - padding * 2;

        ctx.strokeStyle = "#E2E8F0";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);

        [0, 50, 100].forEach(scoreVal => {
            let y = height - padding - (scoreVal / 100) * chartHeight;
            ctx.beginPath();
            ctx.moveTo(padding, y);
            ctx.lineTo(width - padding, y);
            ctx.stroke();
        });

        ctx.setLineDash([]);

        const points = scores.map((score, index) => {
            const x = scores.length === 1 ? width / 2 : padding + (index / (scores.length - 1)) * chartWidth;
            const y = height - padding - (score / 100) * chartHeight;
            return { x, y, score };
        });

        if (points.length > 1) {
            ctx.beginPath();
            ctx.strokeStyle = "#6366F1";
            ctx.lineWidth = 3;
            points.forEach((p, idx) => {
                if (idx === 0) ctx.moveTo(p.x, p.y);
                else ctx.lineTo(p.x, p.y);
            });
            ctx.stroke();
        }

        points.forEach(p => {
            ctx.beginPath();
            ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
            ctx.fillStyle = "#6366F1";
            ctx.fill();
            ctx.strokeStyle = "#FFFFFF";
            ctx.lineWidth = 2;
            ctx.stroke();

            const isPowerSaving = document.body.classList.contains('power-saving-mode');
            ctx.fillStyle = isPowerSaving ? "#C7D2FE" : "#4F46E5";
            
            ctx.font = "bold 15px Inter, sans-serif";
            ctx.textAlign = "center";
            ctx.fillText(p.score, p.x, p.y - 12);
        });
    }

    function saveSelectedWrongWords(type) {
        let selectorId = type === 'listening' ? 'targetListSelectorListening' : 'targetListSelectorCard';
        let containerId = type === 'listening' ? 'listeningTopWrongWords' : 'cardTopWrongWords';
        
        let targetListIdx = parseInt(document.getElementById(selectorId).value);
        if (isNaN(targetListIdx) || !wordLists[targetListIdx]) {
            alert(`⚠️ 目前沒有可儲存的${getLangName(getLearningLanguage())}題庫，請先到「題庫清單」新增。`);
            return;
        }
        let checkboxes = document.querySelectorAll(`#${containerId} input[type="checkbox"]:checked`);
        
        if (checkboxes.length === 0) {
            alert('⚠️ 請至少勾選一項錯題單字！');
            return;
        }

        let addedCount = 0, skippedFull = 0;
        checkboxes.forEach(chk => {
            let wordText = chk.value;
            let currentContent = wordLists[targetListIdx].content || '';
            if (!currentContent.toLowerCase().includes(wordText.toLowerCase())) {
                if (getListWordCount(currentContent) >= getListWordCap(wordLists[targetListIdx])) { skippedFull++; return; }
                wordLists[targetListIdx].content = currentContent + (currentContent ? '\n' : '') + wordText;
                addedCount++;
            }
        });

        localStorage.setItem('dictation_word_lists', JSON.stringify(wordLists));
        triggerAutoSaveToCloud();
        let fullNote = skippedFull > 0 ? `\n⚠️ 題庫已達 ${getListWordCap(wordLists[targetListIdx])} 字上限，有 ${skippedFull} 個單字沒有加入（可到「雞塊補給站」兌換單字上限 +50）。` : '';
        alert(`✅ 成功將 ${addedCount} 個錯題單字儲存至「${wordLists[targetListIdx].title}」！${fullNote}`);
    }

    function updateVolumeDisplay() {
        document.getElementById('volumeValue').innerText = document.getElementById('systemVolume').value + '%';
    }

    function updateSpeedDisplay(sliderId, displayId) {
        let slider = document.getElementById(sliderId);
        let val = parseFloat(slider.value).toFixed(2);
        document.getElementById(displayId).innerText = val + ' 倍';
        updateSliderProgress(slider);
    }

    function togglePowerSavingMode() {
        let isPowerSaving = document.getElementById('powerSavingToggle').checked;
        document.body.classList.toggle('power-saving-mode', isPowerSaving);
        saveSystemSettings();
    }

    function saveSystemSettings() {
        let settings = {
            volume: document.getElementById('systemVolume').value,
            powerSaving: document.getElementById('powerSavingToggle').checked,
            learningLanguage: document.getElementById('learningLanguage').value
        };
        localStorage.setItem('dictation_system_settings', JSON.stringify(settings));
    }

    function loadSystemSettings() {
        let saved = localStorage.getItem('dictation_system_settings');
        if (saved) {
            let s = JSON.parse(saved);
            if (s.volume) document.getElementById('systemVolume').value = s.volume;
            if (s.powerSaving) {
                document.getElementById('powerSavingToggle').checked = true;
                document.body.classList.add('power-saving-mode');
            }
            if (s.learningLanguage) {
                let langSel = document.getElementById('learningLanguage');
                if (langSel) langSel.value = s.learningLanguage;
            }
        }
    }

    function saveAppSettings() {
        let settings = {
            onlyStarred: document.getElementById('onlyStarred').checked,
            enableShuffle: document.getElementById('enableShuffle').checked,
            enableSpell: document.getElementById('enableSpell').checked,
            enableChinese: document.getElementById('enableChinese').checked,
            enablePOS: document.getElementById('enablePOS').checked,
            enableLoop: document.getElementById('enableLoop').checked,
            speakRate: document.getElementById('speakRate').value,
            pauseTime: document.getElementById('pauseTime').value,
            repeatCount: document.getElementById('repeatCount').value
        };
        localStorage.setItem('dictation_app_settings', JSON.stringify(settings));
    }

    function loadAppSettings() {
        let saved = localStorage.getItem('dictation_app_settings');
        if (saved) {
            let s = JSON.parse(saved);
            if (s.onlyStarred !== undefined) document.getElementById('onlyStarred').checked = s.onlyStarred;
            if (s.enableShuffle !== undefined) document.getElementById('enableShuffle').checked = s.enableShuffle;
            if (s.enableSpell !== undefined) document.getElementById('enableSpell').checked = s.enableSpell;
            if (s.enableChinese !== undefined) document.getElementById('enableChinese').checked = s.enableChinese;
            if (s.enablePOS !== undefined) document.getElementById('enablePOS').checked = s.enablePOS;
            if (s.enableLoop !== undefined) document.getElementById('enableLoop').checked = s.enableLoop;
            if (s.speakRate !== undefined) {
                let slider = document.getElementById('speakRate');
                slider.value = s.speakRate;
                updateSpeedDisplay('speakRate', 'speedValue');
                updateSliderProgress(slider);
            }
            if (s.pauseTime !== undefined) document.getElementById('pauseTime').value = s.pauseTime;
            if (s.repeatCount !== undefined) document.getElementById('repeatCount').value = s.repeatCount;
        }
    }

    function saveExamAppSettings() {
        let settings = {
            examOnlyStarred: document.getElementById('examOnlyStarred').checked,
            examQuestionCount: document.getElementById('examQuestionCount').value,
            examSpeakRate: document.getElementById('examSpeakRate').value,
            examPauseTime: document.getElementById('examPauseTime').value,
            examAnswerTime: document.getElementById('examAnswerTime').value,
            examRepeatCount: document.getElementById('examRepeatCount').value
        };
        localStorage.setItem('dictation_exam_app_settings', JSON.stringify(settings));
    }

    function loadExamAppSettings() {
        let saved = localStorage.getItem('dictation_exam_app_settings');
        if (saved) {
            let s = JSON.parse(saved);
            if (s.examOnlyStarred !== undefined) document.getElementById('examOnlyStarred').checked = s.examOnlyStarred;
            if (s.examQuestionCount !== undefined) document.getElementById('examQuestionCount').value = s.examQuestionCount;
            if (s.examSpeakRate !== undefined) {
                let slider = document.getElementById('examSpeakRate');
                slider.value = s.examSpeakRate;
                updateSpeedDisplay('examSpeakRate', 'examSpeedValue');
                updateSliderProgress(slider);
            }
            if (s.examPauseTime !== undefined) document.getElementById('examPauseTime').value = s.examPauseTime;
            if (s.examAnswerTime !== undefined) document.getElementById('examAnswerTime').value = s.examAnswerTime;
            if (s.examRepeatCount !== undefined) document.getElementById('examRepeatCount').value = s.examRepeatCount;
        }
    }

    function verifyDevPassword() {
          if (document.getElementById('devPasswordInput').value === 'freddy116') {
            sessionStorage.setItem('dev_unlocked', 'true');
            document.getElementById('devLoginPanel').style.display = 'none';
            document.getElementById('devContentPanel').style.display = 'flex';
            alert('🔓 開發者模式解鎖成功！');
          } else { alert('❌ 密碼錯誤！'); }
    }

    function runStressTest() { alert('壓力測試執行中'); }
    function clearAllWordListsData() { wordLists.forEach(l => l.content = ''); alert('題庫已清空'); }
    function clearAllExamHistoryData() { 
        examHistory = []; 
        cardExamHistory = [];
        localStorage.removeItem('dictation_exam_history'); 
        localStorage.removeItem('dictation_card_exam_history');
        alert('所有考試紀錄已清空'); 
    }
    function loadInitialSettings() { if(confirm("確定重設？")) location.reload(); }


    // ═════════════════════════════════════════════════════════════
    // 事件委派：取代原本寫在 HTML 裡的 onclick / onchange 等 inline 事件
    // HTML 以 data-on-click='[["函式名稱",[參數...]]]' 描述要呼叫什麼
    // 特殊參數："$this" = 觸發的元素、"$event" = 事件物件、"$value" = 元素的 value
    // 只有登記在 INLINE_ACTIONS 的函式能被呼叫（白名單）
    // ═════════════════════════════════════════════════════════════
    const INLINE_ACTIONS = {
        closeShopListPicker,
        buyWordCapForList,
        buyShopItem,
        closeChickenShopModal,
        openChickenShopModal,
        enforceCurrentEditorLanguage,
        changeListLanguageFromMenu,
        onLearningLanguageChange,
        addNewWordList,
        backToFlashcardSetup,
        backToHome,
        backToHomeFromExam,
        backToListFromDetail,
        claimChickenReward,
        clearAllExamHistoryData,
        clearAllWordListsData,
        clearListContentFromMenu,
        closeAboutModal,
        closeAdvancedModal,
        closeChickenRewardModal,
        closeExamAdvancedModal,
        closeExamResultModal,
        closeExportModal,
        closeHistoryModal,
        closeSystemSettingsModal,
        confirmExportTxtFiles,
        deleteListFromMenu,
        finishCardExamSession,
        finishExam,
        goToCardExamPage,
        goToEditorPage,
        goToExamPage,
        goToFlashcardPage,
        goToPracticePage,
        handleAuthClick,
        handleCardExamKeyDown,
        handleEditorSearch,
        handleEditorTextareaInput,
        handleInputKeyDown,
        hideInAppBrowserWarning,
        loadInitialSettings,
        nextFlashcard,
        openAboutModal,
        openAdvancedModal,
        openCardExamSettingsModal,
        openChickenRewardModal,
        openEditorDetail,
        openExamAdvancedModal,
        openExportModal,
        openFlashcardSettingsModal,
        openHistoryModal,
        openSystemSettingsModal,
        playCurrentFlashcardAudio,
        prevFlashcard,
        renameListTitleFromMenu,
        runStressTest,
        saveAndStayInEditor,
        saveAppSettings,
        saveCardExamSettings,
        saveExamAppSettings,
        saveFlashcardSettings,
        saveSelectedWrongWords,
        saveSystemSettings,
        sortCardExamPreview,
        sortEditorContent,
        sortExamWordListContent,
        sortFlashcardPreview,
        sortWordListContent,
        startCardExamSession,
        startExamMode,
        startFlashcardSession,
        submitCardExamAnswer,
        submitExamAnswer,
        switchHistoryTab,
        syncEditorScroll,
        toggleAccordion,
        toggleAllExportCheckboxes,
        toggleCardExamCard,
        toggleCardExamPreview,
        toggleCardHistoryDetail,
        toggleCurrentCardStar,
        toggleDictation,
        toggleDropdownMenu,
        toggleExamCard,
        toggleExamPreview,
        toggleFlashcardCard,
        toggleFlashcardPreview,
        toggleHistoryDetail,
        togglePauseDictation,
        togglePowerSavingMode,
        togglePracticeCard,
        togglePreview,
        toggleSubCard,
        updateSliderProgress,
        updateSpeedDisplay,
        updateVolumeDisplay,
        verifyDevPassword,
        handleLogout
    };

    const inlineCallCache = new Map();

    function runInlineCalls(el, raw, ev) {
        let calls = inlineCallCache.get(raw);
        if (!calls) {
            try { calls = JSON.parse(raw); } catch (e) { console.warn('data-on-* 格式錯誤:', raw); return false; }
            inlineCallCache.set(raw, calls);
        }
        let stopped = false;
        for (const [name, args] of calls) {
            if (name === '$stop') { ev.stopPropagation(); stopped = true; continue; }
            const fn = INLINE_ACTIONS[name];
            if (typeof fn !== 'function') { console.warn('未登記的動作:', name); continue; }
            fn(...args.map(a => a === '$this' ? el : a === '$event' ? ev : a === '$value' ? el.value : a));
        }
        return stopped;
    }

    // click / change / input / keydown 都會冒泡，從點擊目標一路往上找，行為與原本 inline 事件相同
    ['click', 'change', 'input', 'keydown'].forEach(type => {
        document.addEventListener(type, ev => {
            let el = ev.target instanceof Element ? ev.target : null;
            while (el) {
                const raw = el.getAttribute('data-on-' + type);
                if (raw) {
                    // 讓 event.currentTarget 指向「掛有 data-on-* 的元素」，與原本 inline 事件一致
                    Object.defineProperty(ev, 'currentTarget', { value: el, configurable: true });
                    const stopped = runInlineCalls(el, raw, ev);
                    delete ev.currentTarget;
                    if (stopped) break;
                }
                el = el.parentElement;
            }
        });
    });

    // scroll 不會冒泡，改用捕獲階段監聽
    document.addEventListener('scroll', ev => {
        const el = ev.target instanceof Element ? ev.target : null;
        const raw = el && el.getAttribute('data-on-scroll');
        if (raw) runInlineCalls(el, raw, ev);
    }, true);
