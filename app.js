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
        if (m.includes('login_required')) return '請先登入 Google 雲端再兌換';
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

    // ── 錢包綁定（登入 Google 後，把這台裝置的錢包和 Google 雲端裡的錢包合併） ──
    // 原理：每個 Google 帳號的雲端檔案裡存一把隨機「錢包金鑰」。
    //   第一次登入：產生金鑰，綁在「目前這台裝置的錢包」上（登入前領的雞塊、買的東西都保留）。
    //   之後在別台裝置登入：讀到同一把金鑰，後端把兩邊的錢包合併（領取紀錄取聯集、購買紀錄全保留）。
    //   登出 Google 不會解除綁定，所以登出後的領取／購買仍然進同一個錢包，不會回溯。
    const WALLET_KEY_STORAGE = 'chicky_wallet_key';
    let cloudWalletKey = null;          // 這次登入的 Google 雲端裡的金鑰（存檔時要原樣寫回去）
    let walletBoundThisLogin = false;

    function isValidWalletKey(k) { return typeof k === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(k); }
    function generateWalletKey() {
        let a = new Uint8Array(32);
        crypto.getRandomValues(a);
        return btoa(String.fromCharCode.apply(null, a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    async function switchToFreshAnonymousWallet() {
        try { await supabaseClient.auth.signOut(); } catch (e) { console.warn('signOut 失敗', e); }
        sessionPromise = null;
    }

    // 回傳「目前使用的金鑰」（連線失敗時回傳 null，下次登入會再試一次）
    async function bindWalletAfterLogin(cloudKey) {
        let localKey = localStorage.getItem(WALLET_KEY_STORAGE);
        let key = null, fresh = false;
        if (isValidWalletKey(cloudKey)) {
            key = cloudKey;
        } else if (isValidWalletKey(localKey)) {
            // 這台裝置的錢包以前綁過 Google 帳號，但現在登入的帳號雲端裡沒有金鑰
            if (confirm('這台裝置的雞塊錢包以前已綁定過 Google 帳號，但你現在登入的 Google 雲端裡沒有錢包資料。\n\n按「確定」：沿用這台裝置的錢包（同一個帳號重新登入請選這個）\n按「取消」：這個 Google 帳號改用全新的錢包')) {
                key = localKey;
            } else {
                key = generateWalletKey(); fresh = true;
            }
        } else {
            key = generateWalletKey();
        }
        walletBusy = true;
        try {
            if (fresh) await switchToFreshAnonymousWallet();
            let r = await walletRpc('link_wallet', { p_key: key });
            if (r && r.status === 'conflict') {
                // 這台裝置已綁定另一個 Google 帳號：換成這個帳號自己的錢包
                await switchToFreshAnonymousWallet();
                r = await walletRpc('link_wallet', { p_key: key });
            }
            localStorage.setItem(WALLET_KEY_STORAGE, key);
            await refreshWallet();
            refreshAllListViews();
            return key;
        } catch (e) {
            console.warn('錢包綁定失敗（下次登入會再試）:', e && e.message || e);
            return null;
        } finally {
            walletBusy = false;
        }
    }

    // 錢包尚未綁定 Google 帳號時不能花雞塊（避免兩台裝置各自花掉同一批雞塊）
    function isWalletBound() { return isValidWalletKey(localStorage.getItem(WALLET_KEY_STORAGE)); }
    function ensureLoginBeforeSpend() {
        if (isWalletBound()) return true;
        if (confirm('兌換雞塊前，需要先登入 Google 雲端。\n\n這樣不同裝置的雞塊才能合併，不會被重複花掉。現在要登入嗎？')) handleAuthClick();
        return false;
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
        advRenderShopBox();
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
        if (!ensureLoginBeforeSpend()) return;

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
        if (!ensureLoginBeforeSpend()) return;
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

    // 朗讀練習
    // 評分標準：可在進階設定調整，最低 60、最高 100，預設 70
    function getSpeakPassScore() {
        let el = document.getElementById('speakPracticePassScore');
        let v = parseInt(el ? el.value : 70);
        if (isNaN(v)) v = 70;
        return Math.max(60, Math.min(100, v));
    }
    let speakPracticeActiveList = [];
    let currentSpeakPracticeIndex = 0;
    let speakPracticeResults = [];
    let currentSpeakPracticeRanges = "";
    let speakStarting = false;
    let speakRec = null, speakListening = false, speakPressAt = 0, speakShortTap = false, speakIgnoreResult = false, speakStarted = false, speakLatched = false, speakSkipUp = false;
    let speakHeardAlts = [], speakLastError = '', speakWatchdog = null;
    let speakQuestion = { attempts: 0, best: null, last: null };

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
        loadSpeakPracticeAppSettings();
        initSpeakMicButton();
        initPracticeCardGrid();
        initExamCardGrid();
        initFlashcardGrid();
        initCardExamGrid();
        initSpeakPracticeGrid();
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
                    authBusyUntil = 0;
                    let wasAuto = autoReconnecting; autoReconnecting = false;
                    if (resp.error !== undefined || !resp.access_token) {
                        if (wasAuto && accessToken) return;          // 換新失敗但舊權杖還能用：先不動
                        accessToken = null; isCloudSyncActive = false;
                        updateCloudStatusText(wasAuto ? `💻 未登入（請按「登入 Google 雲端」重新連線）` : `💻 未登入`);
                        return;
                    }
                    localStorage.setItem(GOOGLE_LINKED_FLAG, '1');
                    scheduleTokenRefresh(resp.expires_in);
                    let renewing = wasAuto && accessToken;           // 只是換新權杖：不必重新同步與綁定
                    if (!renewing) { cloudWalletKey = null; walletBoundThisLogin = false; }
                    accessToken = resp.access_token;
                    isCloudSyncActive = true;
                    updateCloudStatusText(`✅ 已連結 Google 雲端`);
                    let authBtn = document.getElementById('cloudAuthBtn');
                    authBtn.innerText = '🔒 登出'; authBtn.className = 'cloud-btn logout';
                    authBtn.setAttribute('data-on-click', '[["handleLogout",[]]]');
                    if (!renewing) loadDataFromGoogleDrive();
                },
                // 登入視窗打不開、被關閉等錯誤（例如 iOS 擋彈出視窗）
                error_callback: (err) => {
                    authBusyUntil = 0;
                    console.warn('Google 登入視窗錯誤:', err);
                    let t = err && err.type;
                    if (autoReconnecting) {                         // 自動重連被瀏覽器擋下：等使用者點一下畫面
                        autoReconnecting = false;
                        if (!accessToken) armReconnectOnNextClick();
                        return;
                    }
                    if (t === 'popup_failed_to_open') {
                        alert('⚠️ 無法開啟 Google 登入視窗。\n\n請確認瀏覽器沒有封鎖彈出視窗，並且不是在 LINE / Facebook 等 App 內開啟（請改用 Safari 或 Chrome）。');
                    } else if (t !== 'popup_closed') {
                        alert('⚠️ Google 登入失敗，請稍後再試。\n\n若畫面出現「400」，請關閉登入視窗，用 Safari / Chrome 重新開啟本網頁再登入；仍失敗可清除瀏覽器對 google.com 的網站資料後再試。');
                    }
                }
            });
        }

        // 上次登入過：重新整理後自動重新連線 Google 雲端
        if (localStorage.getItem(GOOGLE_LINKED_FLAG) === '1') trySilentReconnect(false);
    };

    function loadCollapseStates() {
        let collapseStates = JSON.parse(localStorage.getItem('dictation_collapse_states')) || {
            practice: true,
            flashcard: true,
            exam: true,
            cardExam: true,
            speakPractice: true,
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
        applyCollapseState('speakPracticePreviewContainer', 'speakPracticeCollapseBtn', collapseStates.speakPractice !== false);
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
            speakPractice: true,
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
                    if (stateKey === 'listening_score_chart') renderScoreChart('listeningScoreCanvas', filterHistoryByLang(examHistory));
                    else renderScoreChart('cardScoreCanvas', filterHistoryByLang(cardExamHistory));
                }, 100);
            }
        }
    }

    function toggleAccordion(listId) {
        const target = document.getElementById(listId);
        if (!target) return;
        const willExpand = !target.classList.contains('expanded');
        ['practiceList', 'examList', 'funList'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.remove('expanded');
        });
        if (willExpand) target.classList.add('expanded');
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

    // 判斷目前是不是在「App 內嵌瀏覽器」（LINE、Facebook、Instagram…）或 iOS 主畫面模式
    function getBrowserEnv() {
        const ua = navigator.userAgent || navigator.vendor || window.opera || '';
        const isIOS = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        const standalone = window.navigator.standalone === true || !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
        const knownInApp = /FBAN|FBAV|FB_IAB|Instagram|MicroMessenger|\bLine\/|Twitter|TikTok|musical_ly|BytedanceWebview|Snapchat|KAKAOTALK|NAVER\(inapp|Pinterest|LinkedInApp|GSA\//i.test(ua);
        // iOS 的 Safari 和 Chrome/Edge/Firefox 的 UA 都含 "Safari/"；內嵌 WebView 通常沒有（主畫面模式除外）
        const iosWebview = isIOS && !standalone && !/Safari\//i.test(ua);
        return { ua, isIOS, standalone, isAndroid: /Android/i.test(ua), isLine: /\bLine\//i.test(ua), isInApp: knownInApp || iosWebview };
    }

    function getCleanAppUrl() {
        return window.location.href.replace(/([?&])openExternalBrowser=1&?/, '$1').replace(/[?&]$/, '');
    }

    function copyAppUrl() {
        const url = getCleanAppUrl();
        const fallback = () => window.prompt('請長按選取並複製下面的網址，再貼到 Safari：', url);
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(() => alert('✅ 已複製網址，請打開 Safari 貼上。'), fallback);
        } else {
            fallback();
        }
    }

    function checkAndRedirectInAppBrowser() {
        const env = getBrowserEnv();
        if (!env.isInApp) return;
        const currentUrl = window.location.href;

        // LINE：官方支援網址加 ?openExternalBrowser=1 → 自動改用手機預設瀏覽器（iOS 是 Safari）
        if (env.isLine) {
            if (!/[?&]openExternalBrowser=1/.test(currentUrl)) {
                const sep = currentUrl.indexOf('?') === -1 ? '?' : '&';
                const hashIdx = currentUrl.indexOf('#');
                const base = hashIdx === -1 ? currentUrl : currentUrl.slice(0, hashIdx);
                const hash = hashIdx === -1 ? '' : currentUrl.slice(hashIdx);
                window.location.replace(base + sep + 'openExternalBrowser=1' + hash);
                return;
            }
        }
        if (env.isAndroid) {
            const intentUrl = 'intent://' + currentUrl.replace(/^https?:\/\//, '') + '#Intent;scheme=https;package=com.android.chrome;end';
            window.location.href = intentUrl;
            return;
        }
        // iOS 其他 App（Facebook、Instagram…）：Apple 不允許網頁自動跳到 Safari，只能提示使用者手動開啟
        document.getElementById('inAppBrowserWarning').style.display = 'block';
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
        initSpeakPracticeGrid();
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

    // ── 重新整理後自動重新連線 ──
    // Google 給的存取權杖只存在記憶體，重新整理就消失（也會在約 1 小時後過期）。
    // 所以登入成功後在本機記一個「已連結」旗標；之後開啟網頁時用「不跳同意畫面」的方式悄悄重新取得權杖。
    // 瀏覽器可能因為「不是使用者點擊」而擋掉彈出視窗，這時改成：使用者點畫面任何地方就自動重新連線。
    const GOOGLE_LINKED_FLAG = 'chicky_google_linked';
    let tokenRefreshTimer = null, reconnectClickArmed = false, autoReconnecting = false;

    function armReconnectOnNextClick() {
        if (reconnectClickArmed) return;
        reconnectClickArmed = true;
        updateCloudStatusText('🔑 雲端連線已中斷，點一下畫面任何地方即可重新連線');
        const h = () => {
            document.removeEventListener('pointerdown', h, true);
            reconnectClickArmed = false;
            trySilentReconnect(true);
        };
        document.addEventListener('pointerdown', h, true);
    }

    function trySilentReconnect(force) {
        if (!tokenClient || localStorage.getItem(GOOGLE_LINKED_FLAG) !== '1') return;
        if (accessToken && !force) return;
        if (getBrowserEnv().isInApp) return;
        autoReconnecting = true;
        updateCloudStatusText('☁️ 重新連線 Google 雲端中...');
        try { tokenClient.requestAccessToken({ prompt: '' }); }
        catch (e) { autoReconnecting = false; armReconnectOnNextClick(); }
    }

    function scheduleTokenRefresh(expiresInSec) {
        clearTimeout(tokenRefreshTimer);
        let ms = Math.max(60, (Number(expiresInSec) || 3600) - 120) * 1000;   // 到期前 2 分鐘換新
        tokenRefreshTimer = setTimeout(() => trySilentReconnect(true), ms);
    }

    // Google Drive 回 401 = 權杖已失效
    function handleDriveUnauthorized() {
        accessToken = null; isCloudSyncActive = false;
        let authBtn = document.getElementById('cloudAuthBtn');
        if (authBtn) {
            authBtn.innerText = '登入 Google 雲端'; authBtn.className = 'cloud-btn';
            authBtn.setAttribute('data-on-click', '[["handleAuthClick",[]]]');
        }
        if (localStorage.getItem(GOOGLE_LINKED_FLAG) === '1') armReconnectOnNextClick();
        else updateCloudStatusText('💻 未登入');
    }

    let authBusyUntil = 0;
    function handleAuthClick() {
        const env = getBrowserEnv();
        // Google 不允許在 App 內嵌瀏覽器登入（會出現 400 / 403），先請使用者改用 Safari
        if (env.isInApp) { document.getElementById('inAppBrowserWarning').style.display = 'block'; return; }
        if (!tokenClient) {
            alert('⚠️ Google 登入元件還沒載入完成（可能是網路較慢或被擋住），請稍等幾秒或重新整理頁面後再試。');
            return;
        }
        // 連點兩下會開出兩個登入視窗，其中一個容易出現 Google 的 400 錯誤
        if (Date.now() < authBusyUntil) return;
        authBusyUntil = Date.now() + 3000;
        if (env.isIOS && env.standalone) updateCloudStatusText('⚠️ 主畫面模式的 Google 登入可能失敗，建議改用 Safari 開啟');
        tokenClient.requestAccessToken({ prompt: 'consent' });
    }
    function handleLogout() {
        localStorage.removeItem(GOOGLE_LINKED_FLAG);       // 不再自動重新連線
        clearTimeout(tokenRefreshTimer);
        if (!accessToken) {                                // 權杖已失效（等待重新連線）時，也要能登出
            updateCloudStatusText(`💻 未登入`);
            let btn = document.getElementById('cloudAuthBtn');
            btn.innerText = '登入 Google 雲端'; btn.className = 'cloud-btn';
            btn.setAttribute('data-on-click', '[["handleAuthClick",[]]]');
            return;
        }
        const tokenToRevoke = accessToken;
        // 登出只是「不再同步 Google 雲端」。錢包綁定不會解除，登出後的領取／購買仍進同一個錢包，不會回溯。
        cloudWalletKey = null; walletBoundThisLogin = false;
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
            if (res.status === 401) { handleDriveUnauthorized(); return; }
            let data = await res.json();
            if (data.files && data.files.length > 0) {
                let fileId = data.files[0].id;
                let fileRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
                    headers: { 'Authorization': `Bearer ${accessToken}` }
                });
                let cloudData = await fileRes.json();
                if (cloudData) {
                    if (isValidWalletKey(cloudData.walletKey)) cloudWalletKey = cloudData.walletKey;
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
                    initSpeakPracticeGrid();
                    initEditorListCards();
                    initExamCheckboxes();
                }
            }
            // 登入後第一次同步：把這台裝置的錢包和 Google 雲端的錢包綁在一起
            if (!walletBoundThisLogin) {
                walletBoundThisLogin = true;
                let usedKey = await bindWalletAfterLogin(cloudWalletKey);
                if (usedKey) {
                    let needUpload = usedKey !== cloudWalletKey;
                    cloudWalletKey = usedKey;
                    if (needUpload) await triggerAutoSaveToCloud();
                } else {
                    walletBoundThisLogin = false;   // 連線失敗：下次同步時再試
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
            if (res.status === 401) { handleDriveUnauthorized(); return; }
            let data = await res.json();
            let fileId = (data.files && data.files.length > 0) ? data.files[0].id : null;

            let cloudData = { 
                activeDeviceId: myDeviceId, 
                wordLists, 
                examHistory: trimHistoryPerLang(examHistory), 
                cardExamHistory: trimHistoryPerLang(cardExamHistory), 
                walletKey: cloudWalletKey || undefined,
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
        if (viewId === 'practiceView' || viewId === 'examView' || viewId === 'flashcardPlayView' || viewId === 'flashcardSetupView' || viewId === 'cardExamSetupView' || viewId === 'cardExamPlayView' || viewId === 'speakPracticeSetupView' || viewId === 'speakPracticePlayView') {
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
        initSpeakPracticeGrid();
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
        stopSpeakPracticeSession();
        advAbort();
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
        initSpeakPracticeGrid();
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
        initSpeakPracticeGrid();
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

    function initSpeakPracticeGrid() {
        let grid = document.getElementById('speakPracticeGrid');
        if (!grid) return;
        grid.innerHTML = '';
        
        let activeLists = wordLists.map((l, originalIdx) => ({ ...l, originalIdx })).filter(l => getListWordCount(l.content) > 0 && isListInCurrentLang(l));
        let savedSelected = JSON.parse(localStorage.getItem('dictation_speak_practice_selected')) || [0];
        
        activeLists.forEach((list, displayIdx) => {
            let count = getListWordCount(list.content);
            let isSelected = savedSelected.includes(list.originalIdx) ? 'selected' : '';
            let cardHtml = `
                <div class="select-card ${isSelected}" data-on-click='[["toggleSpeakPracticeCard",[${list.originalIdx},"$this"]]]'>
                    <div class="select-card-info">
                        <div class="select-card-title">${displayIdx + 1}: ${escapeHTML(list.title)}</div>
                        <div class="select-card-count">(${count}/${getListWordCap(list)} 字)</div>
                    </div>
                    <div class="checkmark-badge">✓</div>
                </div>
            `;
            grid.insertAdjacentHTML('beforeend', cardHtml);
        });
        loadSpeakPracticeSelectedContent();
    }

    function toggleSpeakPracticeCard(originalIdx, cardEl) {
        cardEl.classList.toggle('selected');
        saveSpeakPracticeSelectionState();
        loadSpeakPracticeSelectedContent();
    }

    function saveSpeakPracticeSelectionState() {
        let selectedIndices = [];
        document.querySelectorAll('#speakPracticeGrid .select-card').forEach((card) => {
            if (card.classList.contains('selected')) {
                let onclickAttr = card.getAttribute('data-on-click');
                let match = onclickAttr.match(/"toggleSpeakPracticeCard",\[(\d+),/);
                if (match) selectedIndices.push(parseInt(match[1]));
            }
        });
        localStorage.setItem('dictation_speak_practice_selected', JSON.stringify(selectedIndices));
    }

    function loadSpeakPracticeSelectedContent() {
        let combinedText = '';
        let selectedCards = document.querySelectorAll('#speakPracticeGrid .select-card.selected');
        let selectedTitles = [];
        
        selectedCards.forEach((card, displayIdx) => {
            let onclickAttr = card.getAttribute('data-on-click');
            let match = onclickAttr.match(/"toggleSpeakPracticeCard",\[(\d+),/);
            if (match) {
                let idx = parseInt(match[1]);
                if (wordLists[idx] && wordLists[idx].content) {
                    combinedText += wordLists[idx].content + '\n';
                    selectedTitles.push(`${displayIdx + 1}: ${wordLists[idx].title}`);
                }
            }
        });
        currentSpeakPracticeRanges = selectedTitles.join(', ');

        document.getElementById('speakPracticePreviewTextarea').value = combinedText.trim();
        let allWords = parseWordsRaw(combinedText);
        let starCount = allWords.filter(w => w.starred).length;
        document.getElementById('speakPracticeStatsText').innerText = `📊 範圍統計：總單字數 ${allWords.length} 個 ｜ 星號 (*) 單字數 ${starCount} 個`;
    }

    function toggleSpeakPracticePreview() {
        let container = document.getElementById('speakPracticePreviewContainer');
        let btn = document.getElementById('speakPracticeCollapseBtn');
        container.classList.toggle('collapsed');
        btn.classList.toggle('collapsed');
        saveCollapseState('speakPractice', container.classList.contains('collapsed'));
    }

    function sortSpeakPracticePreview(sortType) {
        if (!sortType) return;
        let textarea = document.getElementById('speakPracticePreviewTextarea');
        let words = parseWordsRaw(textarea.value);
        if (sortType === 'az') words.sort((a, b) => a.english.toLowerCase().localeCompare(b.english.toLowerCase(), getLearningLanguage()));
        else if (sortType === 'za') words.sort((a, b) => b.english.toLowerCase().localeCompare(a.english.toLowerCase(), getLearningLanguage()));
        textarea.value = words.map(w => w.rawLine).join('\n');
        setTimeout(() => document.getElementById('speakPracticeSortSelector').selectedIndex = 0, 200);
    }

    function openSpeakPracticeSettingsModal() { document.getElementById('speakPracticeSettingsModal').style.display = 'block'; }
    function closeSpeakPracticeSettingsModal() { document.getElementById('speakPracticeSettingsModal').style.display = 'none'; }
    
    function saveSpeakPracticeSettings() {
        let settings = {
            speakPracticeOnlyStarred: document.getElementById('speakPracticeSettingStarred').checked,
            speakPracticeQuestionCount: document.getElementById('speakPracticeQuestionCount').value,
            speakPracticePassScore: getSpeakPassScore()
        };
        document.getElementById('speakPracticePassScore').value = settings.speakPracticePassScore;   // 超出範圍的數字會被修正回 60~100
        localStorage.setItem('dictation_speak_practice_app_settings', JSON.stringify(settings));
        closeSpeakPracticeSettingsModal();
    }

    function loadSpeakPracticeAppSettings() {
        let saved = localStorage.getItem('dictation_speak_practice_app_settings');
        if (saved) {
            let s = JSON.parse(saved);
            if (s.speakPracticeOnlyStarred !== undefined) document.getElementById('speakPracticeSettingStarred').checked = s.speakPracticeOnlyStarred;
            if (s.speakPracticeQuestionCount !== undefined) document.getElementById('speakPracticeQuestionCount').value = s.speakPracticeQuestionCount;
            if (s.speakPracticePassScore !== undefined) {
                document.getElementById('speakPracticePassScore').value = s.speakPracticePassScore;
                document.getElementById('speakPracticePassScore').value = getSpeakPassScore();
            }
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


    // ═════════════════════════════════════════════════════════════
    // 🎤 朗讀練習：按住麥克風朗讀單字 → 瀏覽器語音辨識 → 和目標單字比對相似度 → 70 分以上通過
    // 注意：這是「文字相似度」評分（辨識出來的字 vs 目標單字），不是專業的音素發音評測。
    // ═════════════════════════════════════════════════════════════
    function getSpeechRecognitionCtor() {
        return window.SpeechRecognition || window.webkitSpeechRecognition || null;
    }

    function goToSpeakPracticePage() {
        initSpeakPracticeGrid();
        switchView('speakPracticeSetupView');
    }

    function levenshtein(a, b) {
        if (a === b) return 0;
        if (!a.length) return b.length;
        if (!b.length) return a.length;
        let prev = new Array(b.length + 1), cur = new Array(b.length + 1);
        for (let j = 0; j <= b.length; j++) prev[j] = j;
        for (let i = 1; i <= a.length; i++) {
            cur[0] = i;
            for (let j = 1; j <= b.length; j++) {
                let cost = a[i - 1] === b[j - 1] ? 0 : 1;
                cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
            }
            let tmp = prev; prev = cur; cur = tmp;
        }
        return prev[b.length];
    }
    function similarity(a, b) {
        if (!a.length || !b.length) return 0;
        return Math.max(0, 1 - levenshtein(a, b) / Math.max(a.length, b.length));
    }

    // ── 英文：同音字、數字、發音相近的拼法都視為同一個字 ──
    // 語音辨識只會回傳「它猜的字」，唸得再標準也可能被寫成同音字（right/write、to/two…），所以先把這些統一。
    const EN_HOMOPHONES = [
        ['right','write','rite'],['2','to','too'],['their','there','theyre'],['buy','by','bye'],['see','sea'],['know','no'],
        ['hear','here'],['1','won'],['flower','flour'],['blue','blew'],['son','sun'],['sale','sail'],['meet','meat'],['week','weak'],
        ['road','rode'],['night','knight'],['wait','weight'],['pair','pear','pare'],['tail','tale'],['plane','plain'],['piece','peace'],
        ['hour','our'],['whole','hole'],['4','for','fore'],['eye','i','aye'],['be','bee'],['you','ewe','u'],['are','r'],['8','ate'],
        ['new','knew'],['red','read'],['would','wood'],['which','witch'],['where','wear','ware'],['weather','whether'],['bear','bare'],
        ['dear','deer'],['die','dye'],['fair','fare'],['flew','flu'],['hair','hare'],['heal','heel'],['mail','male'],['main','mane'],
        ['pain','pane'],['rain','reign','rein'],['steal','steel'],['sweet','suite'],['cell','sell'],['cent','scent','sent'],
        ['great','grate'],['pray','prey'],['sight','site','cite'],['tide','tied'],['toe','tow'],['waist','waste'],['way','weigh'],
        ['wine','whine'],['allowed','aloud'],['bored','board'],['break','brake'],['coarse','course'],['hi','high'],['lead','led'],
        ['might','mite'],['not','knot'],['oh','owe'],['ok','okay'],['color','colour'],['favorite','favourite'],['center','centre'],
        ['theater','theatre'],['gray','grey'],['organize','organise'],['realize','realise'],['program','programme'],['neighbor','neighbour']
    ];
    const EN_HOMO_MAP = (function () {
        let m = {};
        EN_HOMOPHONES.forEach(g => g.forEach(w => { m[w] = g[0]; }));
        return m;
    })();
    const EN_NUMBERS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
        thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };

    function enTokens(str) {
        let t = String(str || '').toLowerCase().replace(/\([^)]*\)|（[^）]*）/g, ' ')
            .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’]/g, '');
        return t.split(/[^a-z0-9]+/).filter(Boolean).map(w => {
            if (Object.prototype.hasOwnProperty.call(EN_NUMBERS, w)) return String(EN_NUMBERS[w]);
            return EN_HOMO_MAP[w] || w;
        });
    }
    // 簡化的「拼字 → 發音」：處理不發音的字母與同音的拼法（ph=f、ck=k、kn=n、ght=t…），保留母音
    function enPhoneticLite(w) {
        return w.replace(/^kn/, 'n').replace(/^gn/, 'n').replace(/^wr/, 'r').replace(/^ps/, 's').replace(/^wh/, 'w')
            .replace(/ph/g, 'f').replace(/ght/g, 't').replace(/ck/g, 'k').replace(/tch/g, 'ch').replace(/dge/g, 'j')
            .replace(/mb$/, 'm').replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k').replace(/q/g, 'k').replace(/x/g, 'ks')
            .replace(/z/g, 's').replace(/(.)\1+/g, '$1');
    }

    // ── 韓文：拆成字母 (jamo) 比對，並把「發音相同」的字母視為一樣 ──
    function koCanon(str) {
        let t = String(str || '').toLowerCase().replace(/\([^)]*\)|（[^）]*）/g, ' ').normalize('NFD');
        let out = '';
        for (const ch of t) {
            let c = ch.codePointAt(0);
            if (c < 0x1100 || c > 0x11FF) continue;       // 只留韓文字母
            if (c === 0x110B) continue;                   // 開頭的 ㅇ 不發音
            if (c === 0x1166) c = 0x1162;                 // ㅔ ≈ ㅐ
            else if (c === 0x1168) c = 0x1164;            // ㅖ ≈ ㅒ
            else if (c === 0x116B || c === 0x116C) c = 0x116F;   // ㅙ ㅚ ≈ ㅞ
            else if (c === 0x11A9 || c === 0x11BF) c = 0x11A8;   // 尾音 ㄲ ㅋ → ㄱ
            else if (c === 0x11BA || c === 0x11BB || c === 0x11BD || c === 0x11BE || c === 0x11C0) c = 0x11AE; // 尾音 ㅅ ㅆ ㅈ ㅊ ㅌ → ㄷ
            else if (c === 0x11C1) c = 0x11B8;            // 尾音 ㅍ → ㅂ
            out += String.fromCodePoint(c);
        }
        return out;
    }

    // 單一辨識結果 vs 目標單字 → 0~100
    function speakScoreOne(target, heard, lang) {
        if (lang === 'ko') {
            const t = koCanon(target), h = koCanon(heard);
            if (!t || !h) return 0;
            if (t === h) return 100;
            if (h.indexOf(t) !== -1) return 90;           // 多說了其他字，但目標有說到
            return Math.round(similarity(t, h) * 100);
        }
        const tt = enTokens(target), ht = enTokens(heard);
        if (!tt.length || !ht.length) return 0;
        const ts = tt.join(''), hs = ht.join('');
        if (ts === hs) return 100;
        let best = similarity(ts, hs) * 100;
        const tp = tt.map(enPhoneticLite).join(''), hp = ht.map(enPhoneticLite).join('');
        best = Math.max(best, tp === hp ? 92 : similarity(tp, hp) * 95);
        if (ht.length > tt.length) {                      // 例如目標 apple、辨識成 "an apple"
            const key = tt.join(' ');
            for (let i = 0; i + tt.length <= ht.length; i++) {
                if (ht.slice(i, i + tt.length).join(' ') === key) { best = Math.max(best, 90); break; }
            }
        }
        return Math.round(best);
    }

    // 回傳 { score: 0~100, heard: 分數最高的那個辨識結果 }（瀏覽器會給好幾個候選，取最高分）
    function scoreSpeakAttempt(target, alts, lang) {
        let best = { score: 0, heard: (alts[0] && alts[0].transcript || '').trim() };
        let found = false;
        alts.forEach(a => {
            let sc = speakScoreOne(target, a.transcript, lang);
            if (!found || sc > best.score) { best = { score: sc, heard: String(a.transcript).trim() }; found = true; }
        });
        return best;
    }

    function setSpeakHint(text, warn) {
        let el = document.getElementById('speakMicHint');
        if (!el) return;
        el.textContent = text;
        el.classList.toggle('warn', !!warn);
    }

    function speakErrorMessage(code) {
        switch (code) {
            case 'not-allowed':
            case 'service-not-allowed': return '麥克風權限被拒絕。請到瀏覽器的網站設定允許使用麥克風，然後重新整理頁面。';
            case 'no-speech': return '沒有聽到聲音，請靠近麥克風，按住後再開口。';
            case 'audio-capture': return '找不到麥克風，請確認裝置有麥克風且沒有被其他程式占用。';
            case 'network': return '語音辨識需要網路連線，請檢查網路後再試。';
            case 'language-not-supported': return '這個瀏覽器不支援這個語言的語音辨識。';
            default: return '沒有辨識到內容，請再按住說一次。';
        }
    }

    // 開始測驗前先確認麥克風權限（會跳出瀏覽器的「允許使用麥克風」詢問）
    async function ensureMicPermission(silent) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return { ok: true };
        if (location.protocol === 'file:' && !silent) return { ok: true };   // 檔案模式瀏覽器不會記住權限，預先詢問只會多問一次   // 無法預先詢問，改由辨識器自己詢問
        try {
            let stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(tr => tr.stop());   // 立刻釋放，避免和語音辨識搶麥克風
            return { ok: true };
        } catch (e) {
            let name = (e && e.name) || '';
            if (name === 'NotAllowedError' || name === 'SecurityError') {
                return { ok: false, denied: true };
            }
            if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
                return { ok: false, message: '⚠️ 找不到麥克風，請確認裝置有麥克風。' };
            }
            return { ok: true };   // 其他錯誤：讓辨識器自己再試一次
        }
    }

    // 網頁沒辦法直接打開系統/瀏覽器的設定頁（瀏覽器的安全限制），所以改成依裝置顯示「照著點就到」的步驟
    function micHelpHTML(status) {
        const env = getBrowserEnv();
        const host = escapeHTML(location.protocol === 'file:' ? '（本機檔案）' : location.host);
        const steps = {
            android: '<b>🤖 Android（Chrome）</b><ol><li>Chrome 右上角 <b>⋮ → 設定 → 網站設定 → 麥克風</b></li><li>最上面的開關要是開的（顯示「詢問」）；往下找到 <b>' + host + '</b>，如果在「已封鎖」裡就點進去改成 <b>「允許」</b></li><li>回到網頁，<b>重新整理</b>後再按麥克風</li></ol>另一個常見原因：手機本身沒讓 Chrome 用麥克風 → <b>手機「設定」→ 應用程式 → Chrome → 權限 → 麥克風 → 允許</b>。<br>也可以點網址列左邊的圖示 → 權限（<b>麥克風只有在被詢問過之後才會出現在這裡</b>，沒看到是正常的）。',
            ios: '<b>📱 iPhone / iPad（Safari）</b><ol><li>點網址列左邊的 <b>「AA」</b> → <b>網站設定</b> → <b>麥克風</b> → <b>允許</b></li><li>回到網頁，重新整理後再按麥克風</li></ol>若找不到：<b>設定 → App → Safari → 麥克風</b>（舊版 iOS：設定 → Safari → 麥克風）改成「詢問」或「允許」。<br>語音辨識還需要開啟：<b>設定 → 一般 → 鍵盤 → 啟用聽寫</b>。',
            desktop: '<b>💻 電腦（Chrome / Edge）</b><ol><li>點網址列左邊的 <b>鎖頭 / 調整圖示</b></li><li><b>麥克風</b> 切換成 <b>「允許」</b>（或按「重設權限」）</li><li>重新整理頁面後再試</li></ol>'
        };
        const order = env.isIOS ? ['ios', 'android', 'desktop'] : env.isAndroid ? ['android', 'ios', 'desktop'] : ['desktop', 'android', 'ios'];
        let html = '<div class="mic-help-note">網頁不能直接打開系統的設定頁（瀏覽器基於安全限制不允許），請照下面的步驟操作：</div>';
        if (location.protocol === 'file:') {
            html += '<div class="mic-help-block main">ℹ️ 你現在是用「檔案」方式開啟網頁。這種方式瀏覽器<b>不會記住</b>麥克風權限，每次都會再問。<br>請改用網站網址（https）開啟；真的要用檔案開啟時，按麥克風後<b>點一下就好、不用按住</b>，按瀏覽器的「允許」後直接說話。</div>';
        }
        if (status === 'denied') {
            html += '<div class="mic-help-status">❌ 目前狀態：本網站的麥克風被封鎖了，要手動改回「允許」：</div>';
            order.forEach((k, i) => { html += '<div class="mic-help-block' + (i === 0 ? ' main' : '') + '">' + steps[k] + '</div>'; });
        } else {
            html += '<div class="mic-help-status">❔ 目前狀態：瀏覽器還沒有得到你的回答</div>' +
                '<div class="mic-help-block main"><b>先按下面的「再詢問一次」</b>，瀏覽器會跳出詢問視窗，請選 <b>「允許」</b>（或「造訪這個網站時允許」）。<br>' +
                '<b>這個時候在網址列的權限清單裡看不到麥克風是正常的</b>——要被詢問並回答過，才會出現在清單裡。</div>' +
                '<div class="mic-help-note">如果按了沒有跳出詢問視窗，或之前選過「不允許」，才需要照下面的步驟手動開啟：</div>';
            order.forEach((k) => { html += '<div class="mic-help-block">' + steps[k] + '</div>'; });
        }
        return html;
    }

    async function openMicHelpModal() {
        let status = '';
        try {
            if (navigator.permissions && navigator.permissions.query) {
                let p = await navigator.permissions.query({ name: 'microphone' });
                status = p.state;
            }
        } catch (e) {}
        document.getElementById('micHelpBody').innerHTML = micHelpHTML(status);
        document.getElementById('micHelpModal').style.display = 'block';
    }
    function closeMicHelpModal() { document.getElementById('micHelpModal').style.display = 'none'; }

    async function recheckMicPermission() {
        let mic = await ensureMicPermission(true);
        if (mic.ok) {
            closeMicHelpModal();
            setSpeakHint('✅ 麥克風已可使用，請按住麥克風說話');
        } else {
            await openMicHelpModal();
        }
    }

    async function startSpeakPracticeSession() {
        if (speakStarting) return;
        let text = document.getElementById('speakPracticePreviewTextarea').value.trim();
        let words = parseWordsRaw(text);
        if (document.getElementById('speakPracticeSettingStarred').checked) words = words.filter(w => w.starred);
        for (let i = words.length - 1; i > 0; i--) {
            let j = Math.floor(Math.random() * (i + 1));
            [words[i], words[j]] = [words[j], words[i]];
        }
        let qCount = parseInt(document.getElementById('speakPracticeQuestionCount').value) || 0;
        if (qCount > 0 && words.length > qCount) words = words.slice(0, qCount);
        if (words.length === 0) {
            alert('⚠️ 範圍內沒有符合條件的單字，請重新勾選！');
            return;
        }

        let env = getBrowserEnv();
        if (env.isInApp) { document.getElementById('inAppBrowserWarning').style.display = 'block'; return; }
        if (location.protocol === 'file:' && !sessionStorage.getItem('speak_file_warned')) {
            sessionStorage.setItem('speak_file_warned', '1');
            alert('ℹ️ 你目前是用「檔案」方式（file://）開啟網頁，瀏覽器不會記住麥克風權限，每次按住說話都會再問一次。\n\n把網頁放到網站（https）上開啟，並在詢問時選「造訪這個網站時允許」，之後就只會問一次。');
        }
        if (!getSpeechRecognitionCtor()) {
            alert('⚠️ 這個瀏覽器不支援語音辨識，無法進行朗讀練習。\n\n請改用 Safari（iPhone / iPad）或 Chrome / Edge（電腦、Android）開啟。');
            return;
        }

        speakStarting = true;
        try {
            let mic = await ensureMicPermission();
            if (!mic.ok) { if (mic.denied) openMicHelpModal(); else alert(mic.message); return; }
        } finally {
            speakStarting = false;
        }

        requestWakeLock();
        speakPracticeActiveList = words;
        currentSpeakPracticeIndex = 0;
        speakPracticeResults = [];
        switchView('speakPracticePlayView');
        showSpeakPracticeQuestion();
    }

    function stopSpeakPracticeSession() {
        abortSpeakListening();
        releaseWakeLock();
    }

    function backToSpeakPracticeSetup() {
        stopSpeakPracticeSession();
        switchView('speakPracticeSetupView');
    }

    function updateSpeakNextBtn() {
        let btn = document.getElementById('speakPracticeNextBtn');
        if (!btn) return;
        let isLast = currentSpeakPracticeIndex >= speakPracticeActiveList.length - 1;
        if (speakQuestion.attempts === 0) btn.innerText = isLast ? '略過並結束 🏁' : '略過此題 ⏭';
        else btn.innerText = isLast ? '完成 🏁' : '下一題 ▶';
    }

    function showSpeakPracticeQuestion() {
        if (currentSpeakPracticeIndex >= speakPracticeActiveList.length) {
            finishSpeakPracticeSession();
            return;
        }
        let card = speakPracticeActiveList[currentSpeakPracticeIndex];
        document.getElementById('speakPracticeCardEng').innerText = card.english;
        document.getElementById('speakPracticeCardChi').innerText = card.chinese ? ((card.pos ? card.pos + ' ' : '') + card.chinese) : '';
        document.getElementById('speakPracticeProgressText').innerText = `${currentSpeakPracticeIndex + 1} / ${speakPracticeActiveList.length} 題`;
        document.getElementById('speakPracticeProgressBar').style.width = `${((currentSpeakPracticeIndex + 1) / speakPracticeActiveList.length) * 100}%`;

        speakQuestion = { attempts: 0, best: null, last: null };
        let box = document.getElementById('speakResultBox');
        box.classList.remove('show');
        box.innerHTML = '';
        let env = getBrowserEnv();
        let note = (currentSpeakPracticeIndex === 0 && env.isIOS && env.standalone) ? '（主畫面模式的語音辨識可能無法使用，沒反應請改用 Safari 開啟）' : '';
        setSpeakHint('按住麥克風朗讀上面的單字，說完再放開 ' + note, !!note);
        updateSpeakNextBtn();
    }

    function renderSpeakResult() {
        let r = speakQuestion.last, best = speakQuestion.best;
        if (!r) return;
        let pass = r.score >= getSpeakPassScore();
        let box = document.getElementById('speakResultBox');
        box.innerHTML = `
            <div class="speak-score ${pass ? 'pass' : 'fail'}">${r.score}<small>分</small></div>
            <div style="font-weight:700; margin-top:4px;">${pass ? '✅ 通過！' : `❌ 未通過（需 ${getSpeakPassScore()} 分以上）`}</div>
            <div class="speak-sub">辨識到：<b>${escapeHTML(r.heard || '(沒有內容)')}</b></div>
            <div class="speak-sub">已嘗試 ${speakQuestion.attempts} 次 ｜ 本題最高 ${best.score} 分</div>`;
        box.classList.add('show');
    }

    function abortSpeakListening() {
        speakIgnoreResult = true;
        clearTimeout(speakWatchdog);
        if (speakRec && speakListening) { try { speakRec.abort(); } catch (e) {} }
        speakListening = false;
        let btn = document.getElementById('speakMicBtn');
        if (btn) btn.classList.remove('recording');
    }

    function startSpeakListening() {
        if (speakListening || speakStarting) return;
        let playView = document.getElementById('speakPracticePlayView');
        if (!playView || !playView.classList.contains('active')) return;
        const SR = getSpeechRecognitionCtor();
        if (!SR) { setSpeakHint('這個瀏覽器不支援語音辨識', true); return; }
        try { window.speechSynthesis.cancel(); } catch (e) {}

        // 每次按住都建立新的辨識物件（iOS 重複使用同一個物件容易卡住）
        let rec = new SR();
        rec.lang = getLearningLanguage() === 'ko' ? 'ko-KR' : 'en-US';
        rec.interimResults = true;
        rec.continuous = false;
        rec.maxAlternatives = 10;
        speakHeardAlts = []; speakLastError = ''; speakShortTap = false; speakIgnoreResult = false;
        speakPressAt = Date.now();
        speakStarted = false; speakLatched = false; speakSkipUp = false;
        rec.onaudiostart = () => { speakStarted = true; if (speakRec === rec && speakListening && speakLatched) setSpeakHint(SPEAK_LATCH_HINT); };

        rec.onresult = (ev) => {
            let alts = [];
            for (let i = 0; i < ev.results.length; i++) {
                let res = ev.results[i];
                for (let j = 0; j < res.length; j++) alts.push({ transcript: res[j].transcript, confidence: res[j].confidence });
            }
            speakHeardAlts = alts;
            if (speakListening && alts.length && !speakIgnoreResult) setSpeakHint('🎙️ ' + alts[0].transcript);
        };
        rec.onerror = (ev) => { speakLastError = (ev && ev.error) || 'error'; };
        rec.onend = () => finishSpeakListening(rec, false);

        speakRec = rec;
        speakListening = true;
        document.getElementById('speakMicBtn').classList.add('recording');
        setSpeakHint('🎙️ 聆聽中…說完請放開');
        try {
            rec.start();
        } catch (e) {
            speakListening = false;
            document.getElementById('speakMicBtn').classList.remove('recording');
            setSpeakHint('無法啟動語音辨識，請再按一次', true);
        }
    }

    const SPEAK_TAIL_MS = 1200;   // 放開後再多收音的時間

    const SPEAK_LATCH_HINT = '🎙️ 聆聽中…說完會自動結束，或再點一下麥克風結束';

    // 放開手指時：
    //  ‧ 還沒真正開始收音（通常是瀏覽器正在跳出「允許麥克風」的詢問，使用者得放開手去按「允許」），或只是輕點一下
    //    → 改成「點一下模式」：不中斷，等授權後直接說話，說完會自動結束（也可以再點一下結束）
    //  ‧ 否則照原本「按住說話、放開評分」
    function stopSpeakListening() {
        if (!speakListening || !speakRec) return;
        let rec = speakRec;
        if (!speakStarted || Date.now() - speakPressAt < 350) {
            speakLatched = true;
            setSpeakHint(speakStarted ? SPEAK_LATCH_HINT : '⏳ 等待麥克風授權…請按瀏覽器的「允許」，然後直接說話');
            clearTimeout(speakWatchdog);
            speakWatchdog = setTimeout(() => {
                if (speakListening && speakRec === rec) { try { rec.abort(); } catch (e) {} finishSpeakListening(rec, true); }
            }, 25000);
            return;
        }
        speakFinishHold(rec, SPEAK_TAIL_MS);
    }

    function speakFinishHold(rec, tailMs) {
        let btn = document.getElementById('speakMicBtn');
        if (btn) btn.classList.remove('recording');
        // 再多收一小段，避免單字最後一個音被切掉（切掉會被辨識成別的字）
        setSpeakHint('🎙️ 收音中…');
        setTimeout(() => { if (speakRec === rec && speakListening) { try { rec.stop(); } catch (e) {} } }, tailMs);
        // 保險：有些瀏覽器偶爾不會觸發 onend，8 秒後強制收尾
        clearTimeout(speakWatchdog);
        speakWatchdog = setTimeout(() => {
            if (speakListening && speakRec === rec) { try { rec.abort(); } catch (e) {} finishSpeakListening(rec, true); }
        }, 8000 + tailMs);
    }

    function finishSpeakListening(rec, forced) {
        if (speakRec !== rec || !speakListening) return;     // 已處理過（或已被中止）
        speakListening = false;
        clearTimeout(speakWatchdog);
        document.getElementById('speakMicBtn').classList.remove('recording');
        if (speakShortTap) { setSpeakHint('請「按住」麥克風說話，說完再放開', true); return; }
        if (speakIgnoreResult) return;

        let alts = speakHeardAlts.filter(a => a.transcript && a.transcript.trim());
        if (alts.length === 0) {
            setSpeakHint(forced ? '辨識逾時，請再按住說話一次' : speakErrorMessage(speakLastError), true);
            if (speakLastError === 'not-allowed' || speakLastError === 'service-not-allowed') openMicHelpModal();
            return;
        }
        let card = speakPracticeActiveList[currentSpeakPracticeIndex];
        if (!card) return;
        let res = scoreSpeakAttempt(card.english, alts, getLearningLanguage());
        speakQuestion.attempts++;
        speakQuestion.last = res;
        if (!speakQuestion.best || res.score > speakQuestion.best.score) speakQuestion.best = res;
        renderSpeakResult();
        updateSpeakNextBtn();
        setSpeakHint('可以再按住麥克風重說一次，或按「下一題」');
    }

    function playSpeakPracticeSample() {
        let card = speakPracticeActiveList[currentSpeakPracticeIndex];
        if (!card) return;
        abortSpeakListening();
        let utterance = new SpeechSynthesisUtterance(card.english);
        let langCode = getLearningLanguage() === 'ko' ? 'ko-KR' : 'en-US';
        let chosenVoice = getSelectedVoiceForLearning();
        if (chosenVoice) utterance.voice = chosenVoice;
        utterance.lang = langCode;
        utterance.rate = 0.8;
        let sysVol = document.getElementById('systemVolume') ? document.getElementById('systemVolume').value : 100;
        utterance.volume = Math.max(0, Math.min(1.0, (parseInt(sysVol) || 100) / 100));
        try { window.speechSynthesis.cancel(); } catch (e) {}
        window.speechSynthesis.speak(utterance);
    }

    function initSpeakMicButton() {
        const btn = document.getElementById('speakMicBtn');
        if (!btn) return;
        const down = () => {
            if (speakListening && speakLatched) {          // 點一下模式中再點 = 結束
                speakLatched = false; speakSkipUp = true;
                speakFinishHold(speakRec, 500);
                return;
            }
            startSpeakListening();
        };
        const up = () => { if (speakSkipUp) { speakSkipUp = false; return; } stopSpeakListening(); };
        btn.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            try { if (btn.setPointerCapture && e.pointerId !== undefined) btn.setPointerCapture(e.pointerId); } catch (err) {}
            down();
        });
        ['pointerup', 'pointercancel'].forEach(t => btn.addEventListener(t, (e) => { e.preventDefault(); up(); }));
        btn.addEventListener('contextmenu', (e) => e.preventDefault());
        // 鍵盤：按住空白鍵說話（電腦測試用）
        btn.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); down(); } });
        btn.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); up(); } });
    }

    function pushCurrentSpeakResult() {
        let card = speakPracticeActiveList[currentSpeakPracticeIndex];
        if (!card) return;
        let best = speakQuestion.best;
        speakPracticeResults.push({
            english: card.english,
            chinese: card.chinese,
            pos: card.pos,
            heard: best ? best.heard : '',
            score: best ? best.score : 0,
            isCorrect: !!best && best.score >= getSpeakPassScore(),
            attempts: speakQuestion.attempts,
            skipped: !best
        });
    }

    function nextSpeakPracticeQuestion() {
        abortSpeakListening();
        if (currentSpeakPracticeIndex >= speakPracticeActiveList.length) return;
        pushCurrentSpeakResult();
        currentSpeakPracticeIndex++;
        showSpeakPracticeQuestion();
    }

    function finishSpeakPracticeSession() {
        abortSpeakListening();
        releaseWakeLock();
        // 已經說過、但還沒按「下一題」就結束：這一題也要算進成績
        if (currentSpeakPracticeIndex < speakPracticeActiveList.length && speakQuestion.attempts > 0 && speakPracticeResults.length === currentSpeakPracticeIndex) {
            pushCurrentSpeakResult();
        }
        let total = speakPracticeResults.length;
        if (total === 0) {
            backToSpeakPracticeSetup();
            return;
        }
        let passed = speakPracticeResults.filter(r => r.isCorrect).length;
        let score = Math.round((passed / total) * 100);
        let avg = Math.round(speakPracticeResults.reduce((sum, r) => sum + r.score, 0) / total);

        let html = `<div class="result-box">
            <div style="font-weight:700; margin-bottom:12px; font-size:15px; color:var(--text-main);">※ 朗讀練習結束！以下為您的練習結果：</div>
            <div style="font-weight:600; margin-bottom:14px; color:var(--primary);">📊 練習統計：通過率 ${score}%（通過 ${passed} / ${total} 題，平均發音 ${avg} 分，${getSpeakPassScore()} 分以上算通過）</div>`;
        speakPracticeResults.forEach((r, i) => {
            let titleColor = r.isCorrect ? '#10B981' : '#EF4444';
            let icon = r.isCorrect ? '✅' : '❌';
            html += `<div style="margin-bottom:14px; padding-bottom:10px; border-bottom:1px solid var(--border-color);">
                <div style="font-weight:700; color:${titleColor}; margin-bottom:4px;">${icon} 第 ${i + 1} 題：${escapeHTML(r.english)}${r.chinese ? ' (' + escapeHTML(r.chinese) + ')' : ''} — ${r.score} 分</div>
                <div style="font-size:13.5px; color:var(--text-muted);">${r.skipped ? '您略過了這一題' : '辨識到：' + escapeHTML(r.heard || '(沒有內容)') + '（嘗試 ' + r.attempts + ' 次，取最高分）'}</div>
            </div>`;
        });
        html += `</div>`;

        document.getElementById('modalResultBody').innerHTML = html;
        document.getElementById('examResultModal').style.display = 'block';

        backToSpeakPracticeSetup();
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
        initSpeakPracticeGrid();

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
        const tabs = {
            listening: { tab: 'cardListeningTab', panel: 'panelListeningHistory', canvas: 'listeningScoreCanvas', data: () => examHistory },
            word:      { tab: 'cardWordTab',      panel: 'panelWordHistory',      canvas: 'cardScoreCanvas',      data: () => cardExamHistory }
        };
        if (!tabs[tabName]) tabName = 'listening';
        Object.keys(tabs).forEach(k => {
            const on = (k === tabName);
            const tabEl = document.getElementById(tabs[k].tab);
            const panelEl = document.getElementById(tabs[k].panel);
            if (tabEl) tabEl.classList.toggle('active', on);
            if (panelEl) panelEl.classList.toggle('active', on);
        });
        setTimeout(() => {
            renderScoreChart(tabs[tabName].canvas, filterHistoryByLang(tabs[tabName].data()));
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
    // ═════════════════════════════════════════════════════════════
    //  🏰 雞塊大冒險（原型：第 1 關）
    //  戰鬥流程：選招式 → 發動招式（答題）→ 成功就造成傷害 → 依敏捷決定連續行動次數 → 敵人攻擊
    // ═════════════════════════════════════════════════════════════
    const ADV_STORE = 'chicky_adv_data';
    const ADV_SEL_KEY = 'chicky_adv_selected';
    const ADV_BASE_STATS = { hp: 3, atk: 1, agi: 3, def: 0, luck: 0 };
    const ADV_UP_MAX = 10;
    const ADV_SHARDS_PER_SAUCE = 10;
    const ADV_TOTAL_LEVELS = 10;

    // 招式：type = card 字卡選擇題 / listen 聽力拼字 / speak 朗讀；威力越強越難發動
    const ADV_MOVES = [
        { key: 'tackle', name: '衝撞',     icon: '💥', type: 'card',   power: 1, streak: 1, tries: 1, desc: '字卡：選出正確的中文意思' },
        { key: 'slash',  name: '斬擊',     icon: '⚔️', type: 'listen', power: 2, streak: 1, tries: 1, desc: '聽力：聽發音，拼出單字' },
        { key: 'wave',   name: '衝擊波',   icon: '🌊', type: 'speak',  power: 3, streak: 1, tries: 2, desc: '朗讀：按住麥克風唸出單字' },
        { key: 'combo',  name: '連續衝撞', icon: '🔥', type: 'card',   power: 3, streak: 3, tries: 1, desc: '字卡：連續答對 3 題' }
    ];

    const ADV_LEVELS = [
        { id: 1, name: '貢丸', sprite: 'meatball', minWords: 10, hp: 3, atk: 1, agi: 1, def: 0, luck: 0, moveName: '彈跳撞擊', movePower: 0, rewardShards: 1, rewardChicken: 1 }
    ];

    function advLoad() {
        let d = {};
        try { d = JSON.parse(localStorage.getItem(ADV_STORE)) || {}; } catch (e) { d = {}; }
        let up = d.up || {};
        let clampUp = v => Math.max(0, Math.min(ADV_UP_MAX, parseInt(v) || 0));
        let n0 = v => Math.max(0, parseInt(v) || 0);
        let hasShards = d.shards !== undefined;
        let hp = parseInt(d.hp);
        return {
            shards: hasShards ? n0(d.shards) : n0(d.sauce),     // 舊版把碎片叫「糖醋醬」，改名後數量轉成碎片
            sauce: hasShards ? n0(d.sauce) : 0,
            cleared: (d.cleared && typeof d.cleared === 'object') ? d.cleared : {},
            up: { hp: clampUp(up.hp), atk: clampUp(up.atk), agi: clampUp(up.agi), def: clampUp(up.def), luck: clampUp(up.luck) },
            hp: Number.isFinite(hp) ? hp : null,
            hpDay: typeof d.hpDay === 'string' ? d.hpDay : ''
        };
    }
    let advData = advLoad();
    function advSave() { try { localStorage.setItem(ADV_STORE, JSON.stringify(advData)); } catch (e) {} }
    function advPlayerStats() {
        return {
            hp: ADV_BASE_STATS.hp + advData.up.hp,
            atk: ADV_BASE_STATS.atk + advData.up.atk,
            agi: ADV_BASE_STATS.agi + advData.up.agi,
            def: ADV_BASE_STATS.def + advData.up.def,
            luck: ADV_BASE_STATS.luck + advData.up.luck
        };
    }
    function advMaxHp() { return ADV_BASE_STATS.hp + advData.up.hp; }
    // 體力會繼承到下一場戰鬥；每天 00:00（本機時間）補滿
    function advSyncDaily() {
        let today = getLocalDateStr(), max = advMaxHp();
        if (advData.hp === null || advData.hpDay !== today) { advData.hpDay = today; advData.hp = max; advSave(); }
        else if (advData.hp > max) { advData.hp = max; advSave(); }
        else if (advData.hp < 0) { advData.hp = 0; advSave(); }
    }
    // 幸運：骰子數 = (自己的幸運 − 對方的幸運) ÷ 2 無條件捨去（最少 0）；每顆骰子擲到 6，這次攻擊傷害 +1
    function advLuckDice(myLuck, foeLuck) { return Math.max(0, Math.floor((myLuck - foeLuck) / 2)); }
    function advRollLuck(myLuck, foeLuck) {
        let rolls = [];
        for (let i = 0; i < advLuckDice(myLuck, foeLuck); i++) rolls.push(1 + Math.floor(Math.random() * 6));
        return { rolls, bonus: rolls.filter(r => r === 6).length };
    }
    // 連續行動次數：(我方敏捷 − 敵方敏捷) ÷ 2，無條件捨去後 +1，至少 1 次
    function advActionCount(myAgi, foeAgi) { return Math.max(1, Math.floor((myAgi - foeAgi) / 2) + 1); }
    // 傷害：攻擊力 + 招式威力 − 對方防禦，至少 1
    function advDamage(atk, power, def) { return Math.max(1, atk + power - def); }

    // ── 角色圖（雞塊就是首頁那隻）──
    function advChickenSVG() {
        return `<svg viewBox="4 22 128 100" xmlns="http://www.w3.org/2000/svg" fill="none">
            <path d="M 52 108 L 46 118 M 46 118 L 38 118 M 84 108 L 88 118 M 88 118 L 96 118" stroke="#231F20" stroke-width="6" stroke-linecap="round"/>
            <ellipse cx="68" cy="68" rx="40" ry="42" fill="#F4A236" stroke="#231F20" stroke-width="5.5"/>
            <circle cx="36" cy="80" r="4" fill="#E2861E"/><circle cx="66" cy="98" r="3.5" fill="#E2861E"/><circle cx="94" cy="74" r="3.5" fill="#E2861E"/>
            <ellipse cx="48" cy="74" rx="7.5" ry="5.5" fill="#F87171"/><ellipse cx="86" cy="74" rx="7.5" ry="5.5" fill="#F87171"/>
            <circle cx="54" cy="64" r="4.5" fill="#231F20"/><circle cx="80" cy="64" r="4.5" fill="#231F20"/>
            <path d="M 61 73 Q 67 80 73 73" stroke="#231F20" stroke-width="4.5" stroke-linecap="round"/>
            <path d="M 28 68 C 18 68, 12 72, 14 80" stroke="#231F20" stroke-width="6" stroke-linecap="round"/>
            <path d="M 108 68 C 118 68, 124 72, 122 80" stroke="#231F20" stroke-width="6" stroke-linecap="round"/>
        </svg>`;
    }
    function advEnemySVG(kind) {
        return `<svg viewBox="0 0 120 112" xmlns="http://www.w3.org/2000/svg" fill="none">
            <ellipse cx="60" cy="102" rx="32" ry="6" fill="rgba(0,0,0,0.15)"/>
            <circle cx="60" cy="56" r="42" fill="#E9C7A0" stroke="#231F20" stroke-width="5.5"/>
            <circle cx="36" cy="76" r="3" fill="#C99A6B"/><circle cx="82" cy="80" r="3" fill="#C99A6B"/><circle cx="66" cy="90" r="2.5" fill="#C99A6B"/><circle cx="90" cy="58" r="2.5" fill="#C99A6B"/>
            <ellipse cx="42" cy="32" rx="9" ry="5" fill="#FFFFFF" opacity="0.5" transform="rotate(-25 42 32)"/>
            <ellipse cx="38" cy="66" rx="6.5" ry="4.5" fill="#F87171" opacity="0.7"/><ellipse cx="82" cy="66" rx="6.5" ry="4.5" fill="#F87171" opacity="0.7"/>
            <circle cx="46" cy="54" r="4.5" fill="#231F20"/><circle cx="74" cy="54" r="4.5" fill="#231F20"/>
            <path d="M 36 43 L 53 49 M 84 43 L 67 49" stroke="#231F20" stroke-width="4.5" stroke-linecap="round"/>
            <path d="M 51 72 Q 60 64 69 72" stroke="#231F20" stroke-width="4.5" stroke-linecap="round"/>
        </svg>`;
    }

    // ── 地圖（第 1 頁）：夜市(1~4) → 過橋(5) → 城市(6~7) → 速食店(8~10) ──
    const ADV_MAP_W = 340, ADV_MAP_H = 700;
    const ADV_MAP_PTS = [[90, 640], [236, 588], [108, 520], [238, 452], [170, 372], [98, 300], [238, 240], [106, 176], [236, 122], [150, 58]];
    function advSpline(pts) {
        let d = `M ${pts[0][0]} ${pts[0][1]}`;
        for (let i = 0; i < pts.length - 1; i++) {
            let p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
            let c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
            let c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
            d += ` C ${c1[0].toFixed(1)} ${c1[1].toFixed(1)}, ${c2[0].toFixed(1)} ${c2[1].toFixed(1)}, ${p2[0]} ${p2[1]}`;
        }
        return d;
    }
    function advStall(x, y, w, label, emoji) {
        let stripes = '';
        let n = 6, sw = w / n;
        for (let i = 0; i < n; i++) stripes += `<rect x="${(x + i * sw).toFixed(1)}" y="${y}" width="${sw.toFixed(1)}" height="14" fill="${i % 2 ? '#FFF7ED' : '#F97316'}"/>`;
        return `<g>
            <rect x="${x + 3}" y="${y + 14}" width="${w - 6}" height="30" fill="#4C1D95" stroke="#2E1065" stroke-width="2"/>
            ${stripes}<rect x="${x}" y="${y}" width="${w}" height="14" fill="none" stroke="#2E1065" stroke-width="2" rx="3"/>
            <text x="${x + w / 2}" y="${y + 37}" font-size="17" text-anchor="middle">${emoji}</text>
            <rect x="${x + 6}" y="${y - 16}" width="${w - 12}" height="14" rx="4" fill="#FDE047"/>
            <text x="${x + w / 2}" y="${y - 5.5}" font-size="10.5" font-weight="800" text-anchor="middle" fill="#7C2D12">${label}</text>
        </g>`;
    }
    function advStringLights(y, sag) {
        let d = `M 0 ${y} Q 170 ${y + sag} 340 ${y}`;
        let bulbs = '';
        for (let i = 0; i <= 16; i++) {
            let t = i / 16, x = 340 * t, yy = (1 - t) * (1 - t) * y + 2 * (1 - t) * t * (y + sag) + t * t * y;
            bulbs += `<circle cx="${x.toFixed(1)}" cy="${(yy + 4).toFixed(1)}" r="3.4" fill="${i % 2 ? '#FDE047' : '#FB923C'}"/>`;
        }
        return `<path d="${d}" fill="none" stroke="#1E1B4B" stroke-width="1.6"/>${bulbs}`;
    }
    function advLantern(x, y) {
        return `<g><line x1="${x}" y1="${y - 10}" x2="${x}" y2="${y}" stroke="#1E1B4B" stroke-width="1.5"/><ellipse cx="${x}" cy="${y + 9}" rx="7.5" ry="9.5" fill="#EF4444" stroke="#7F1D1D" stroke-width="1.5"/><rect x="${x - 4}" y="${y - 1}" width="8" height="3" fill="#FDE047"/><rect x="${x - 4}" y="${y + 17}" width="8" height="3" fill="#FDE047"/><line x1="${x}" y1="${y + 20}" x2="${x}" y2="${y + 26}" stroke="#FDE047" stroke-width="1.5"/></g>`;
    }
    function advBuildings(baseY, rows) {
        let out = '', seed = 7;
        const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
        rows.forEach(r => {
            let x = r.x0 - 10;
            while (x < 340) {
                let w = 20 + rnd() * 16, h = r.h0 + rnd() * r.hv;
                out += `<rect x="${x.toFixed(1)}" y="${(baseY - h).toFixed(1)}" width="${w.toFixed(1)}" height="${(h + 8).toFixed(1)}" fill="${r.fill}"/>`;
                for (let wy = baseY - h + 6; wy < baseY - 4; wy += 9) for (let wx = x + 4; wx < x + w - 5; wx += 8) if (rnd() > 0.35) out += `<rect x="${wx.toFixed(1)}" y="${wy.toFixed(1)}" width="3.6" height="4.6" fill="${r.win}" opacity="${(0.6 + rnd() * 0.4).toFixed(2)}"/>`;
                x += w + 2;
            }
        });
        return out;
    }
    function advMapSVG() {
        const path = advSpline([[60, 700], ...ADV_MAP_PTS]);
        const wave = (y, amp) => `M 0 ${y} Q 42 ${y - amp} 85 ${y} T 170 ${y} T 255 ${y} T 340 ${y} V 700 H 0 Z`;
        const pill = (x, y, w, t) => `<g><rect x="${x}" y="${y}" width="${w}" height="18" rx="9" fill="rgba(30,27,75,0.62)"/><text x="${x + w / 2}" y="${y + 12.5}" font-size="10.5" font-weight="800" text-anchor="middle" fill="#FFFFFF">${t}</text></g>`;
        return `<svg class="adv-map-svg" viewBox="0 0 ${ADV_MAP_W} ${ADV_MAP_H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <defs>
            <linearGradient id="mgFood" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FEF3C7"/><stop offset="1" stop-color="#FCD34D"/></linearGradient>
            <linearGradient id="mgCity" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#C4B5FD"/><stop offset="1" stop-color="#7C6FE0"/></linearGradient>
            <linearGradient id="mgRiver" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7DD3FC"/><stop offset="1" stop-color="#0EA5E9"/></linearGradient>
            <linearGradient id="mgNight" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3730A3"/><stop offset="1" stop-color="#1E1B4B"/></linearGradient>
            <pattern id="mgStripe" width="26" height="26" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><rect width="13" height="26" fill="#F87171" opacity="0.13"/></pattern>
        </defs>
        <rect width="340" height="700" fill="url(#mgFood)"/>
        <rect width="340" height="230" fill="url(#mgStripe)"/>
        <!-- 速食店 -->
        <g>
            <rect x="96" y="9" width="108" height="22" rx="11" fill="#EF4444" stroke="#7F1D1D" stroke-width="2"/>
            <text x="150" y="25" font-size="13" font-weight="900" text-anchor="middle" fill="#FFFFFF">🍔 速食店</text>
            <!-- 漢堡 -->
            <g transform="translate(6,92)">
                <path d="M4 22 Q4 2 30 2 Q56 2 56 22 Z" fill="#F59E0B" stroke="#7C2D12" stroke-width="2.4"/>
                <circle cx="20" cy="12" r="1.6" fill="#FEF3C7"/><circle cx="31" cy="8" r="1.6" fill="#FEF3C7"/><circle cx="41" cy="13" r="1.6" fill="#FEF3C7"/>
                <path d="M2 26 Q10 20 18 26 T34 26 T50 26 T58 26 V30 H2 Z" fill="#65A30D" stroke="#365314" stroke-width="2"/>
                <rect x="3" y="30" width="54" height="9" rx="4" fill="#78350F" stroke="#431407" stroke-width="2"/>
                <path d="M3 41 H57 V46 Q57 54 48 54 H12 Q3 54 3 46 Z" fill="#F59E0B" stroke="#7C2D12" stroke-width="2.4"/>
            </g>
            <!-- 薯條 -->
            <g transform="translate(278,44)">
                <rect x="10" y="0" width="7" height="26" rx="2" fill="#FDE047" stroke="#A16207" stroke-width="1.6" transform="rotate(-10 13 14)"/>
                <rect x="20" y="-4" width="7" height="28" rx="2" fill="#FACC15" stroke="#A16207" stroke-width="1.6"/>
                <rect x="30" y="1" width="7" height="25" rx="2" fill="#FDE047" stroke="#A16207" stroke-width="1.6" transform="rotate(10 33 14)"/>
                <path d="M6 22 H44 L40 56 H10 Z" fill="#EF4444" stroke="#7F1D1D" stroke-width="2.2"/>
                <rect x="14" y="32" width="22" height="12" rx="3" fill="#FEF3C7" opacity="0.9"/>
            </g>
            <!-- 汽水 -->
            <g transform="translate(14,34)">
                <line x1="30" y1="-14" x2="24" y2="8" stroke="#2563EB" stroke-width="3" stroke-linecap="round"/>
                <rect x="8" y="6" width="34" height="7" rx="3" fill="#F8FAFC" stroke="#475569" stroke-width="1.8"/>
                <path d="M11 13 H39 L35 46 H15 Z" fill="#F43F5E" stroke="#881337" stroke-width="2"/>
                <rect x="14" y="24" width="22" height="9" fill="#FFF1F2" opacity="0.9"/>
            </g>
            ${pill(244, 150, 90, '🍟 速食店 8–10')}
        </g>
        <!-- 城市 -->
        <path d="${wave(214, 8)}" fill="url(#mgCity)"/>
        ${advBuildings(352, [{ x0: 0, h0: 70, hv: 34, fill: '#8B7BE8', win: '#FEF9C3' }, { x0: 12, h0: 38, hv: 40, fill: '#5B4BC4', win: '#FDE68A' }])}
        ${pill(8, 224, 82, '🏙️ 城市 6–7')}
        <!-- 河 -->
        <path d="${wave(340, 7)}" fill="url(#mgRiver)"/>
        <path d="M 18 372 q 10 -6 20 0 t 20 0 M 250 360 q 10 -6 20 0 t 20 0 M 40 392 q 10 -6 20 0 t 20 0 M 262 392 q 10 -6 20 0 t 20 0" stroke="#E0F2FE" stroke-width="2.4" fill="none" stroke-linecap="round" opacity="0.85"/>
        <!-- 夜市 -->
        <path d="${wave(410, 7)}" fill="url(#mgNight)"/>
        ${[[30, 430], [96, 438], [190, 436], [310, 430]].map(p => `<circle cx="${p[0]}" cy="${p[1]}" r="1.4" fill="#E0E7FF" opacity="0.8"/>`).join('')}
        ${advStringLights(432, 18)}
        ${advStringLights(566, 16)}
        ${advLantern(24, 440)}${advLantern(318, 446)}${advLantern(24, 576)}${advLantern(316, 572)}
        ${advStall(8, 480, 56, '雞排', '🍗')}
        ${advStall(276, 520, 56, '珍奶', '🧋')}
        ${advStall(8, 612, 56, '滷味', '🍢')}
        ${advStall(276, 636, 56, '麵線', '🍜')}
        ${pill(8, 416, 84, '🏮 夜市 1–4')}
        <!-- 路 -->
        <path d="${path}" fill="none" stroke="rgba(15,23,42,0.28)" stroke-width="38" stroke-linecap="round" stroke-linejoin="round" transform="translate(0,3)"/>
        <path d="${path}" fill="none" stroke="#F3D49B" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="${path}" fill="none" stroke="#FFF1D0" stroke-width="24" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="${path}" fill="none" stroke="#E7B96E" stroke-width="3" stroke-linecap="round" stroke-dasharray="2 10"/>
        <!-- 橋 -->
        <g transform="translate(170 372) rotate(47)">
            <rect x="-44" y="-27" width="88" height="54" rx="6" fill="#A16207" stroke="#451A03" stroke-width="2.4"/>
            ${[-34, -24, -14, -4, 6, 16, 26, 36].map(x => `<line x1="${x}" y1="-26" x2="${x}" y2="26" stroke="#78350F" stroke-width="1.6"/>`).join('')}
            <rect x="-44" y="-31" width="88" height="6" rx="3" fill="#E5E7EB" stroke="#475569" stroke-width="1.6"/>
            <rect x="-44" y="25" width="88" height="6" rx="3" fill="#E5E7EB" stroke="#475569" stroke-width="1.6"/>
        </g>
        </svg>`;
    }
    function advRenderMap() {
        let nodes = ADV_MAP_PTS.map((p, i) => {
            let id = i + 1, lv = ADV_LEVELS.find(l => l.id === id);
            let st = !lv ? 'locked' : (advData.cleared[id] ? 'cleared' : 'open');
            let pos = `left:${(p[0] / ADV_MAP_W * 100).toFixed(2)}%;top:${(p[1] / ADV_MAP_H * 100).toFixed(2)}%`;
            return lv
                ? `<button type="button" class="adv-node ${st}" style="${pos}" aria-label="第 ${id} 關" data-on-click='[["goToAdvLevel",[${id}]]]'>${id}</button>`
                : `<button type="button" class="adv-node locked" style="${pos}" disabled aria-label="第 ${id} 關（敬請期待）">🔒</button>`;
        }).join('');
        let box = document.getElementById('advMap');
        if (box) box.innerHTML = advMapSVG() + nodes;
    }

    // ── 第 2 頁：關卡（攻略條件 + 出題範圍）──
    let advSelected = [];
    function advLoadSelected() {
        try { let s = JSON.parse(localStorage.getItem(ADV_SEL_KEY)); advSelected = Array.isArray(s) ? s.filter(n => Number.isInteger(n)) : [0]; }
        catch (e) { advSelected = [0]; }
    }
    function advGetWords() {
        let text = '';
        advSelected.forEach(i => { if (wordLists[i] && wordLists[i].content && isListInCurrentLang(wordLists[i])) text += wordLists[i].content + '\n'; });
        return parseWordsRaw(text);
    }
    function advInitGrid() {
        let grid = document.getElementById('advGrid');
        if (!grid) return;
        advLoadSelected();
        grid.innerHTML = '';
        let lists = wordLists.map((l, originalIdx) => ({ ...l, originalIdx })).filter(l => getListWordCount(l.content) > 0 && isListInCurrentLang(l));
        lists.forEach((list, displayIdx) => {
            let sel = advSelected.includes(list.originalIdx) ? 'selected' : '';
            grid.insertAdjacentHTML('beforeend', `
                <div class="select-card ${sel}" data-on-click='[["toggleAdvCard",[${list.originalIdx},"$this"]]]'>
                    <div class="select-card-info">
                        <div class="select-card-title">${displayIdx + 1}: ${escapeHTML(list.title)}</div>
                        <div class="select-card-count">(${getListWordCount(list.content)}/${getListWordCap(list)} 字)</div>
                    </div>
                    <div class="checkmark-badge">✓</div>
                </div>`);
        });
    }
    function toggleAdvCard(idx, cardEl) {
        let i = advSelected.indexOf(idx);
        if (i >= 0) advSelected.splice(i, 1); else advSelected.push(idx);
        cardEl.classList.toggle('selected', advSelected.includes(idx));
        try { localStorage.setItem(ADV_SEL_KEY, JSON.stringify(advSelected)); } catch (e) {}
        advRenderLevelPage();
    }
    function advRenderLevelPage() {
        let lv = ADV_LEVELS.find(l => l.id === adv.pickLevel) || ADV_LEVELS[0];
        let words = advGetWords();
        let n = words.length;
        let stat = document.getElementById('advStatsText');
        if (stat) stat.textContent = `📊 範圍統計：${n} 個單字`;
        advSyncDaily();
        let ok = n >= lv.minWords;
        let tired = advData.hp <= 0;
        let max = advMaxHp();
        let canGo = ok && !tired;
        let hearts = `♥ ${advData.hp}/${max}`;
        let html = `
            <div class="adv-card adv-level">
                <div class="adv-lv-sprite">${advEnemySVG(lv.sprite)}</div>
                <div class="adv-lv-info">
                    <b>第 ${lv.id} 關：${lv.name} ${advData.cleared[lv.id] ? '✅' : ''}</b>
                    <span class="${ok ? 'adv-ok' : 'adv-bad'}">攻略條件：選取至少 ${lv.minWords} 題以上的單字${ok ? ' ✓' : `（目前 ${n} 題）`}</span><br>
                    <span class="${tired ? 'adv-bad' : ''}">體力：${hearts}${tired ? '　沒體力了，明天 00:00 恢復' : ''}</span><br>
                    獎勵：🧩 糖醋醬碎片 ×${lv.rewardShards}${advData.cleared[lv.id] ? '' : `<br>首次通關：🍗 雞塊 ×${lv.rewardChicken}`}
                </div>
                <button type="button" class="adv-go" ${canGo ? '' : 'disabled'} data-on-click='[["advStartBattle",[${lv.id}]]]'>出擊</button>
            </div>`;
        let box = document.getElementById('advLevelCard');
        if (box) box.innerHTML = html;
    }
    function goToAdvLevel(levelId) {
        advAbort();
        adv.pickLevel = ADV_LEVELS.some(l => l.id === levelId) ? levelId : 1;
        advInitGrid();
        advRenderLevelPage();
        switchView('advLevelView');
    }
    function advBackToLevel() { goToAdvLevel(adv.pickLevel || 1); }

    // ── 第 1 頁：地圖 ──
    function goToAdventurePage() {
        advAbort();
        advSyncDaily();
        advRenderMap();
        switchView('adventureView');
    }

    // ── 第 3 頁：雞塊能力值（糖醋醬可讓任一能力 +1）──
    const ADV_STAT_DEFS = [
        { key: 'hp',   label: 'HP',   color: '#10B981' },
        { key: 'atk',  label: '攻擊', color: '#F43F5E' },
        { key: 'agi',  label: '敏捷', color: '#3B82F6' },
        { key: 'def',  label: '防禦', color: '#F59E0B' },
        { key: 'luck', label: '幸運', color: '#A855F7' }
    ];
    const ADV_BAR_MAX = 12;
    function goToAdvStats() {
        advAbort();
        advSyncDaily();
        advRenderStatsPage();
        switchView('advStatsView');
    }
    function advRenderStatsPage() {
        let s = advPlayerStats();
        let rows = ADV_STAT_DEFS.map(d => {
            let lvl = advData.up[d.key], maxed = lvl >= ADV_UP_MAX, can = advData.sauce >= 1 && !maxed;
            let pct = Math.min(100, s[d.key] / ADV_BAR_MAX * 100);
            return `<div class="adv-stat-row">
                <div class="adv-stat-tile">${d.label}<b>${s[d.key]}</b></div>
                <div class="adv-bar" title="已強化 ${lvl}/${ADV_UP_MAX}"><i style="width:${pct.toFixed(1)}%;background:${d.color}"></i></div>
                <button type="button" class="adv-plus" ${can ? '' : 'disabled'} aria-label="${d.label} +1" data-on-click='[["advUpgrade",["${d.key}"]]]'>${maxed ? '滿' : '+1'}</button>
            </div>`;
        }).join('');
        let box = document.getElementById('advStatsBox');
        if (!box) return;
        box.innerHTML = `
            <div class="adv-hero">
                <div class="adv-avatar">${advChickenSVG()}</div>
                <div class="adv-hero-info">
                    <div>♥ 目前體力 <b>${advData.hp}/${s.hp}</b></div>
                    <div>🍯 糖醋醬 <b id="advSauceCount">${advData.sauce}</b> 瓶</div>
                </div>
            </div>
            ${rows}
            <div class="adv-note">糖醋醬可以讓任何一項能力 +1（每項最多強化 ${ADV_UP_MAX} 次）。<br>糖醋醬碎片請到「雞塊補給站」兌換成糖醋醬。<br>體力每天 00:00 恢復。</div>`;
    }
    function advUpgrade(key) {
        if (!Object.prototype.hasOwnProperty.call(advData.up, key)) return;
        if (advData.sauce < 1 || advData.up[key] >= ADV_UP_MAX) return;
        advSyncDaily();
        advData.sauce -= 1;
        advData.up[key] += 1;
        if (key === 'hp') advData.hp += 1;     // 最大體力 +1 的同時，目前體力也 +1
        advSave();
        advRenderStatsPage();
    }

    // ── 雞塊補給站：糖醋醬碎片 → 糖醋醬 ──
    function advRenderShopBox() {
        let box = document.getElementById('advShopBox');
        if (!box) return;
        let can = advData.shards >= ADV_SHARDS_PER_SAUCE;
        box.innerHTML = `
            <div style="font-size:14px; font-weight:700;">🧩 糖醋醬碎片 ×<span id="advShardCount">${advData.shards}</span>　🍯 糖醋醬 ×${advData.sauce}</div>
            <button type="button" class="adv-btn-sm" style="margin-top:8px; ${can ? '' : 'opacity:.5;cursor:not-allowed;'}" ${can ? '' : 'disabled'} data-on-click='[["advExchangeShards",[]]]'>${ADV_SHARDS_PER_SAUCE} 個碎片 → 兌換 1 瓶糖醋醬</button>
            <div style="font-size:12px; color:var(--text-muted); margin-top:4px;">在大冒險打贏敵人可得碎片；糖醋醬用在「大冒險 → 能力值」強化雞塊。（不需要雞塊）</div>`;
    }
    function advExchangeShards() {
        if (advData.shards < ADV_SHARDS_PER_SAUCE) return;
        advData.shards -= ADV_SHARDS_PER_SAUCE;
        advData.sauce += 1;
        advSave();
        advRenderShopBox();
    }

    // ── 戰鬥狀態 ──
    let adv = { pickLevel: 1, runId: 0, active: false, busy: false, level: null, words: [], cnWords: [], decks: { all: [], cn: [] }, player: null, enemy: null, round: 1, actionsLeft: 0, actionsTotal: 0, move: null, q: null, micOk: false };
    let advRec = null, advListening = false, advAlts = [], advErr = '', advPressAt = 0, advIgnore = false, advShort = false, advWatch = null, advStarted = false, advLatched = false, advSkipUp = false;

    function advWait(ms) { return new Promise(r => setTimeout(r, ms)); }
    function advAnimate(el, frames, opts) {
        if (!el) return advWait((opts && opts.duration) || 300);
        try { return el.animate(frames, opts).finished.catch(() => {}); } catch (e) { return advWait((opts && opts.duration) || 300); }
    }
    function advShuffle(a) {
        for (let i = a.length - 1; i > 0; i--) { let j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
        return a;
    }
    function advNextWord(kind) {
        let pool = kind === 'cn' ? adv.cnWords : adv.words;
        if (!adv.decks[kind].length) adv.decks[kind] = advShuffle(pool.slice());
        return adv.decks[kind].pop();
    }
    function advSetLog(text) {
        let el = document.getElementById('advLog');
        if (el) el.textContent = text;
    }
    function advSpeakWord(text) {
        try {
            let u = new SpeechSynthesisUtterance(text);
            let v = getSelectedVoiceForLearning();
            if (v) u.voice = v;
            u.lang = getLearningLanguage() === 'ko' ? 'ko-KR' : 'en-US';
            u.rate = 0.85;
            let sysVol = document.getElementById('systemVolume') ? document.getElementById('systemVolume').value : 100;
            u.volume = Math.max(0, Math.min(1, (parseInt(sysVol) || 100) / 100));
            window.speechSynthesis.cancel();
            window.speechSynthesis.speak(u);
        } catch (e) {}
    }
    function advActorCenter(el) {
        let stage = document.getElementById('advStage');
        return { x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop + el.offsetHeight / 2, w: stage ? stage.clientWidth : 300 };
    }
    // 兩個角色中心的位移量（要除以畫面縮放比例，電腦版整個畫面有放大）
    function advDelta(fromEl, toEl) {
        let a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect();
        let k = (fromEl.offsetWidth ? a.width / fromEl.offsetWidth : 1) || 1;
        return { dx: ((b.left + b.width / 2) - (a.left + a.width / 2)) / k, dy: ((b.top + b.height / 2) - (a.top + a.height / 2)) / k };
    }
    function advFloat(actorEl, text, color) {
        let stage = document.getElementById('advStage');
        if (!stage || !actorEl) return;
        let c = advActorCenter(actorEl);
        let d = document.createElement('div');
        d.className = 'adv-float';
        d.textContent = text;
        if (color) d.style.color = color;
        d.style.left = c.x + 'px';
        d.style.top = (actorEl.offsetTop - 4) + 'px';
        stage.appendChild(d);
        advAnimate(d, [{ opacity: 1, transform: 'translate(-50%, 0)' }, { opacity: 1, transform: 'translate(-50%, -22px)', offset: 0.6 }, { opacity: 0, transform: 'translate(-50%, -34px)' }], { duration: 900, easing: 'ease-out' }).then(() => d.remove());
    }
    function advFx(html, x, y, size) {
        let fx = document.getElementById('advFx');
        if (!fx) return null;
        let d = document.createElement('div');
        d.innerHTML = html;
        d.style.left = (x - size / 2) + 'px';
        d.style.top = (y - size / 2) + 'px';
        d.style.width = size + 'px';
        d.style.height = size + 'px';
        d.style.fontSize = (size * 0.8) + 'px';
        d.style.lineHeight = size + 'px';
        d.style.textAlign = 'center';
        fx.appendChild(d);
        return d;
    }
    function advUpdateHud() {
        let p = adv.player, e = adv.enemy;
        if (!p || !e) return;
        let pf = document.getElementById('advPlayerFill'), ef = document.getElementById('advEnemyFill');
        if (pf) { pf.style.width = (Math.max(0, p.hp) / p.max * 100) + '%'; pf.classList.toggle('low', p.hp / p.max <= 0.34); }
        if (ef) { ef.style.width = (Math.max(0, e.hp) / e.max * 100) + '%'; ef.classList.toggle('low', e.hp / e.max <= 0.34); }
        let pt = document.getElementById('advPlayerHpText'), et = document.getElementById('advEnemyHpText');
        if (pt) pt.textContent = `${Math.max(0, p.hp)}/${p.max}`;
        if (et) et.textContent = `${Math.max(0, e.hp)}/${e.max}`;
        let info = document.getElementById('advTopInfo');
        if (info) info.textContent = `第 ${adv.level.id} 關 ｜ 回合 ${adv.round} ｜ 行動 ${Math.min(adv.actionsTotal - adv.actionsLeft + 1, adv.actionsTotal)}/${adv.actionsTotal}`;
    }
    // 戰鬥場景：夜市（和地圖第 1~4 關同一個風格）
    function advStageBG() {
        const stall = (x, y, label, emoji) => `<g transform="translate(${x} ${y}) scale(0.82)" opacity="0.95">${advStall(0, 0, 56, label, emoji)}</g>`;
        let tiles = '';
        for (let y = 104; y < 150; y += 15) tiles += `<line x1="0" y1="${y}" x2="340" y2="${y}" stroke="#3A3478" stroke-width="1.2"/>`;
        for (let x = -20; x < 360; x += 34) tiles += `<line x1="${x}" y1="92" x2="${x + (x - 170) * 0.5}" y2="150" stroke="#3A3478" stroke-width="1.2"/>`;
        return `<svg class="adv-stage-bg" viewBox="0 0 340 150" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <defs><linearGradient id="sgSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1E1B4B"/><stop offset="1" stop-color="#4338CA"/></linearGradient></defs>
            <rect width="340" height="150" fill="url(#sgSky)"/>
            ${[[40, 14], [96, 30], [150, 12], [210, 28], [262, 10]].map(p => `<circle cx="${p[0]}" cy="${p[1]}" r="1.3" fill="#E0E7FF" opacity="0.85"/>`).join('')}
            <circle cx="304" cy="22" r="9" fill="#FEF9C3"/><circle cx="308" cy="19" r="8" fill="#2A2570"/>
            ${stall(34, 50, '雞排', '🍗')}${stall(150, 44, '滷味', '🍢')}${stall(250, 50, '珍奶', '🧋')}
            <rect y="90" width="340" height="60" fill="#2A2560"/>
            ${tiles}
            ${advStringLights(24, 12)}
            ${advLantern(24, 28)}${advLantern(316, 30)}
        </svg>`;
    }
    function advBuildStage() {
        let st = document.getElementById('advStage');
        st.innerHTML = advStageBG() + `
            <div class="adv-hud adv-hud-enemy"><div>${escapeHTML(adv.enemy.name)} <span id="advEnemyHpText"></span></div><div class="adv-hpbar"><div class="adv-hpfill" id="advEnemyFill"></div></div></div>
            <div class="adv-actor adv-enemy" id="advEnemy">${advEnemySVG(adv.enemy.sprite)}</div>
            <div class="adv-actor adv-player" id="advPlayer">${advChickenSVG()}</div>
            <div class="adv-hud adv-hud-player"><div>雞塊 <span id="advPlayerHpText"></span></div><div class="adv-hpbar"><div class="adv-hpfill" id="advPlayerFill"></div></div></div>
            <div class="adv-fx" id="advFx"></div>`;
        advUpdateHud();
    }

    // ── 開始 / 結束 ──
    function advAbort() {
        adv.runId++;
        adv.active = false;
        adv.busy = false;
        adv.q = null;
        clearTimeout(advWatch);
        advIgnore = true;
        if (advRec && advListening) { try { advRec.abort(); } catch (e) {} }
        advListening = false;
        try { window.speechSynthesis.cancel(); } catch (e) {}
        releaseWakeLock();
    }
    function advStartBattle(levelId) {
        let lv = ADV_LEVELS.find(l => l.id === levelId);
        if (!lv) return;
        let words = advGetWords();
        if (words.length < lv.minWords) { alert(`⚠️ 這一關需要範圍內至少 ${lv.minWords} 個單字，請多勾選一些題庫。`); return; }
        advAbort();
        advSyncDaily();
        if (advData.hp <= 0) { alert('雞塊沒有體力了，明天 00:00 會恢復。'); advRenderLevelPage(); return; }
        adv.words = words;
        adv.cnWords = words.filter(w => w.chinese);
        adv.decks = { all: [], cn: [] };
        let s = advPlayerStats();
        adv.level = lv;
        adv.player = { hp: Math.min(advData.hp, s.hp), max: s.hp, atk: s.atk, agi: s.agi, def: s.def, luck: s.luck };
        adv.enemy = { name: lv.name, sprite: lv.sprite, hp: lv.hp, max: lv.hp, atk: lv.atk, agi: lv.agi, def: lv.def, luck: lv.luck || 0, moveName: lv.moveName, movePower: lv.movePower };
        adv.round = 1;
        adv.micOk = false;
        adv.active = true;
        adv.busy = false;
        requestWakeLock();
        switchView('adventureBattleView');
        advBuildStage();
        advBeginRound();
    }
    function advQuit() {
        if (adv.active && !confirm('要離開戰鬥嗎？這場戰鬥不會有任何獎勵。')) return;
        advAbort();
        advBackToLevel();
    }
    function advBackToMenu() { advAbort(); advBackToLevel(); }
    function advRetry() { if (adv.level) advStartBattle(adv.level.id); }

    // ── 回合 ──
    function advBeginRound() {
        adv.actionsTotal = advActionCount(adv.player.agi, adv.enemy.agi);
        adv.actionsLeft = adv.actionsTotal;
        adv.busy = false;
        advShowMenu();
    }
    function advShowMenu() {
        adv.q = null;
        advUpdateHud();
        let cardOk = adv.cnWords.length >= 4;
        let speakOk = !!getSpeechRecognitionCtor();
        let moves = ADV_MOVES.map(m => {
            let off = (m.type === 'card' && !cardOk) || (m.type === 'speak' && !speakOk);
            let why = (m.type === 'card' && !cardOk) ? '（單字缺中文解釋，無法出題）' : (m.type === 'speak' && !speakOk) ? '（此瀏覽器不支援語音辨識）' : '';
            return `<button type="button" class="adv-move" ${off ? 'disabled' : ''} data-on-click='[["advChooseMove",["${m.key}"]]]'>
                <b>${m.icon} ${m.name}　傷害 ${advDamage(adv.player.atk, m.power, adv.enemy.def)}</b><small>${m.desc}${why}</small></button>`;
        }).join('');
        document.getElementById('advPanel').innerHTML = `<div class="adv-log" id="advLog">選擇招式！（本回合還可行動 ${adv.actionsLeft} 次）</div><div class="adv-moves">${moves}</div>`;
    }

    async function advChooseMove(key) {
        if (!adv.active || adv.busy || adv.q) return;
        let m = ADV_MOVES.find(x => x.key === key);
        if (!m) return;
        const id = adv.runId;
        adv.move = m;
        adv.q = { type: 'pending' };
        if (m.type === 'speak' && !adv.micOk) {
            adv.busy = true;
            let mic = await ensureMicPermission();
            if (id !== adv.runId) return;
            adv.busy = false;
            if (!mic.ok) { adv.q = null; if (mic.denied) openMicHelpModal(); else alert(mic.message); return; }
            adv.micOk = true;
        }
        adv.progress = 0;
        adv.triesLeft = m.tries;
        if (m.type === 'card') advAskCard();
        else if (m.type === 'listen') advAskListen();
        else advAskSpeak();
    }

    // 字卡（選擇題）
    function advAskCard() {
        let w = advNextWord('cn');
        let wrong = advShuffle(adv.cnWords.filter(x => x.chinese !== w.chinese)).slice(0, 3).map(x => x.chinese);
        let opts = advShuffle([w.chinese, ...wrong]);
        adv.q = { type: 'card', word: w, opts, correct: opts.indexOf(w.chinese), done: false };
        let m = adv.move;
        let prog = m.streak > 1 ? `（第 ${adv.progress + 1}/${m.streak} 題）` : '';
        document.getElementById('advPanel').innerHTML = `
            <div class="adv-log" id="advLog">${m.icon} ${m.name}${prog}：選出正確的意思</div>
            <div class="adv-qword">${escapeHTML(w.english)}</div>
            <div class="adv-opts">${opts.map((o, i) => `<button type="button" class="adv-opt" data-on-click='[["advAnswerCard",[${i}]]]'>${escapeHTML(o)}</button>`).join('')}</div>`;
    }
    async function advAnswerCard(i) {
        let q = adv.q;
        if (!adv.active || adv.busy || !q || q.type !== 'card' || q.done) return;
        const id = adv.runId;
        q.done = true;
        let btns = document.querySelectorAll('#advPanel .adv-opt');
        btns.forEach((b, idx) => { if (idx === q.correct) b.classList.add('ok'); else if (idx === i) b.classList.add('bad'); });
        let ok = i === q.correct;
        await advWait(ok ? 450 : 1000);
        if (id !== adv.runId) return;
        if (ok) {
            adv.progress++;
            if (adv.progress < adv.move.streak) { advAskCard(); return; }
        }
        advResolveMove(ok);
    }

    // 聽力（聽發音、拼單字）
    function advNorm(s) { return String(s || '').normalize('NFC').toLowerCase().replace(/[\s'’\-.,!?]/g, ''); }
    function advAskListen() {
        let w = advNextWord('all');
        adv.q = { type: 'listen', word: w, done: false };
        let m = adv.move;
        document.getElementById('advPanel').innerHTML = `
            <div class="adv-log" id="advLog">${m.icon} ${m.name}：聽發音，拼出單字</div>
            <button type="button" class="adv-speak-btn" data-on-click='[["advReplayListen",[]]]'>🔊 再聽一次</button>
            <div class="adv-input-row">
                <input type="text" id="advListenInput" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="輸入聽到的單字">
                <button type="button" data-on-click='[["advSubmitListen",[]]]'>送出</button>
            </div>
            <div class="adv-qsub" id="advListenSub"></div>`;
        let inp = document.getElementById('advListenInput');
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); advSubmitListen(); } });
        advSpeakWord(w.english);
        setTimeout(() => { try { inp.focus(); } catch (e) {} }, 50);
    }
    function advReplayListen() { if (adv.q && adv.q.type === 'listen') advSpeakWord(adv.q.word.english); }
    async function advSubmitListen() {
        let q = adv.q;
        if (!adv.active || adv.busy || !q || q.type !== 'listen' || q.done) return;
        let inp = document.getElementById('advListenInput');
        let val = inp ? inp.value : '';
        if (!val.trim()) return;
        const id = adv.runId;
        q.done = true;
        let ok = advNorm(val) === advNorm(q.word.english);
        if (inp) inp.blur();
        document.getElementById('advListenSub').innerHTML = ok ? '✅ 正確！' : `❌ 正確答案：<b>${escapeHTML(q.word.english)}</b>`;
        await advWait(ok ? 500 : 1200);
        if (id !== adv.runId) return;
        advResolveMove(ok);
    }

    // 朗讀（按住麥克風）
    function advAskSpeak() {
        let w = advNextWord('all');
        adv.q = { type: 'speak', word: w, done: false };
        let m = adv.move;
        document.getElementById('advPanel').innerHTML = `
            <div class="adv-log" id="advLog">${m.icon} ${m.name}：按住麥克風唸出單字</div>
            <div class="adv-qword">${escapeHTML(w.english)}</div>
            <div class="adv-qsub">${escapeHTML(w.chinese || '')}</div>
            <button type="button" class="adv-mic" id="advMicBtn" aria-label="按住麥克風說話"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0"></path><line x1="12" y1="18" x2="12" y2="22"></line><line x1="8" y1="22" x2="16" y2="22"></line></svg></button>
            <div class="adv-qsub" id="advSpeakHint">剩 ${adv.triesLeft} 次機會 ｜ 說完再多按住約 2 秒</div>
            <button type="button" class="adv-speak-btn" data-on-click='[["advGiveUpSpeak",[]]]'>放棄這招</button>`;
        let btn = document.getElementById('advMicBtn');
        const down = () => {
            if (advListening && advLatched) { advLatched = false; advSkipUp = true; advFinishHold(advRec, 500); return; }
            advSpeakStart();
        };
        const up = () => { if (advSkipUp) { advSkipUp = false; return; } advSpeakStop(); };
        btn.addEventListener('pointerdown', (e) => { e.preventDefault(); try { if (btn.setPointerCapture && e.pointerId !== undefined) btn.setPointerCapture(e.pointerId); } catch (err) {} down(); });
        ['pointerup', 'pointercancel'].forEach(t => btn.addEventListener(t, (e) => { e.preventDefault(); up(); }));
        btn.addEventListener('contextmenu', (e) => e.preventDefault());
        btn.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); down(); } });
        btn.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); up(); } });
    }
    function advSpeakHint(t) { let el = document.getElementById('advSpeakHint'); if (el) el.textContent = t; }
    function advSpeakStart() {
        let q = adv.q;
        if (advListening || adv.busy || !adv.active || !q || q.type !== 'speak' || q.done) return;
        const SR = getSpeechRecognitionCtor();
        if (!SR) { advSpeakHint('這個瀏覽器不支援語音辨識'); return; }
        try { window.speechSynthesis.cancel(); } catch (e) {}
        let rec = new SR();
        rec.lang = getLearningLanguage() === 'ko' ? 'ko-KR' : 'en-US';
        rec.interimResults = true;
        rec.continuous = false;
        rec.maxAlternatives = 10;
        advAlts = []; advErr = ''; advShort = false; advIgnore = false; advPressAt = Date.now();
        advStarted = false; advLatched = false; advSkipUp = false;
        rec.onaudiostart = () => { advStarted = true; if (advRec === rec && advListening && advLatched) advSpeakHint(SPEAK_LATCH_HINT); };
        rec.onresult = (ev) => {
            let alts = [];
            for (let i = 0; i < ev.results.length; i++) for (let j = 0; j < ev.results[i].length; j++) alts.push({ transcript: ev.results[i][j].transcript, confidence: ev.results[i][j].confidence });
            advAlts = alts;
            if (advListening && alts.length && !advIgnore) advSpeakHint('🎙️ ' + alts[0].transcript);
        };
        rec.onerror = (ev) => { advErr = (ev && ev.error) || 'error'; };
        rec.onend = () => advSpeakFinish(rec, false);
        advRec = rec;
        advListening = true;
        let btn = document.getElementById('advMicBtn');
        if (btn) btn.classList.add('recording');
        advSpeakHint('🎙️ 聆聽中…說完請再多按住一下');
        try { rec.start(); } catch (e) {
            advListening = false;
            if (btn) btn.classList.remove('recording');
            advSpeakHint('無法啟動語音辨識，請再按一次');
        }
    }
    function advSpeakStop() {
        if (!advListening || !advRec) return;
        let rec = advRec;
        if (!advStarted || Date.now() - advPressAt < 350) {        // 還在等授權、或只是輕點：改成「點一下模式」
            advLatched = true;
            advSpeakHint(advStarted ? SPEAK_LATCH_HINT : '⏳ 等待麥克風授權…請按瀏覽器的「允許」，然後直接說話');
            clearTimeout(advWatch);
            advWatch = setTimeout(() => { if (advListening && advRec === rec) { try { rec.abort(); } catch (e) {} advSpeakFinish(rec, true); } }, 25000);
            return;
        }
        advFinishHold(rec, SPEAK_TAIL_MS);
    }
    function advFinishHold(rec, tailMs) {
        let btn = document.getElementById('advMicBtn');
        if (btn) btn.classList.remove('recording');
        advSpeakHint('🎙️ 收音中…');
        setTimeout(() => { if (advRec === rec && advListening) { try { rec.stop(); } catch (e) {} } }, tailMs);
        clearTimeout(advWatch);
        advWatch = setTimeout(() => { if (advListening && advRec === rec) { try { rec.abort(); } catch (e) {} advSpeakFinish(rec, true); } }, 8000 + tailMs);
    }
    async function advSpeakFinish(rec, forced) {
        if (advRec !== rec || !advListening) return;
        advListening = false;
        clearTimeout(advWatch);
        let btn = document.getElementById('advMicBtn');
        if (btn) btn.classList.remove('recording');
        let q = adv.q;
        if (!adv.active || !q || q.type !== 'speak' || q.done) return;
        if (advShort) { advSpeakHint('請「按住」麥克風說話，說完再放開'); return; }
        if (advIgnore) return;
        let alts = advAlts.filter(a => a.transcript && a.transcript.trim());
        if (!alts.length) {
            advSpeakHint(forced ? '辨識逾時，請再按住說一次' : speakErrorMessage(advErr));
            if (advErr === 'not-allowed' || advErr === 'service-not-allowed') openMicHelpModal();
            return;
        }
        const id = adv.runId;
        let res = scoreSpeakAttempt(q.word.english, alts, getLearningLanguage());
        let pass = res.score >= getSpeakPassScore();
        adv.triesLeft--;
        if (pass) {
            q.done = true;
            advSpeakHint(`✅ ${res.score} 分（辨識到：${res.heard || ''}）`);
            await advWait(600);
            if (id !== adv.runId) return;
            advResolveMove(true);
        } else if (adv.triesLeft <= 0) {
            q.done = true;
            advSpeakHint(`❌ ${res.score} 分（需 ${getSpeakPassScore()} 分），沒有機會了`);
            await advWait(1100);
            if (id !== adv.runId) return;
            advResolveMove(false);
        } else {
            advSpeakHint(`❌ ${res.score} 分（需 ${getSpeakPassScore()} 分）｜ 辨識到：${res.heard || '(沒有內容)'} ｜ 剩 ${adv.triesLeft} 次機會`);
        }
    }
    async function advGiveUpSpeak() {
        let q = adv.q;
        if (!adv.active || adv.busy || !q || q.type !== 'speak' || q.done) return;
        const id = adv.runId;
        q.done = true;
        advIgnore = true;
        if (advRec && advListening) { try { advRec.abort(); } catch (e) {} advListening = false; }
        await advWait(200);
        if (id !== adv.runId) return;
        advResolveMove(false);
    }

    // ── 招式結算與動畫 ──
    async function advPlayAttack(m) {
        const P = document.getElementById('advPlayer'), E = document.getElementById('advEnemy');
        if (!P || !E) return;
        const d = advDelta(P, E);
        const ec = advActorCenter(E), pc = advActorCenter(P);
        const dash = (f) => advAnimate(P, [
            { transform: 'translate(0,0) scale(1)' },
            { transform: `translate(${d.dx * f}px, ${d.dy * f}px) scale(1.12)`, offset: 0.5 },
            { transform: 'translate(0,0) scale(1)' }], { duration: 420, easing: 'ease-in-out' });
        const burst = (txt) => { let b = advFx(txt || '💥', ec.x + (Math.random() * 12 - 6), ec.y + (Math.random() * 12 - 6), 40); if (b) advAnimate(b, [{ opacity: 0, transform: 'scale(.3)' }, { opacity: 1, transform: 'scale(1.1)', offset: 0.4 }, { opacity: 0, transform: 'scale(1.4)' }], { duration: 380 }).then(() => b.remove()); };
        if (m.key === 'tackle') {
            let p = dash(0.78); await advWait(190); burst(); await p;
        } else if (m.key === 'combo') {
            for (let i = 0; i < 3; i++) { let p = dash(0.78); await advWait(190); burst('🔥'); await p; }
        } else if (m.key === 'slash') {
            let p = advAnimate(P, [{ transform: 'translate(0,0)' }, { transform: `translate(${d.dx * 0.5}px, ${d.dy * 0.5}px)`, offset: 0.5 }, { transform: 'translate(0,0)' }], { duration: 380, easing: 'ease-in-out' });
            await advWait(170);
            let s = advFx(`<svg viewBox="0 0 60 60" width="100%" height="100%"><path d="M8 8 Q 42 18 52 54" stroke="#FFFFFF" stroke-width="8" fill="none" stroke-linecap="round"/><path d="M8 8 Q 42 18 52 54" stroke="#FACC15" stroke-width="3.5" fill="none" stroke-linecap="round"/></svg>`, ec.x, ec.y, 64);
            if (s) await advAnimate(s, [{ opacity: 0, transform: 'scale(.4) rotate(-25deg)' }, { opacity: 1, transform: 'scale(1.1) rotate(0deg)', offset: 0.45 }, { opacity: 0, transform: 'scale(1.25) rotate(12deg)' }], { duration: 380 }).then(() => s.remove());
            await p;
        } else if (m.key === 'wave') {
            await advAnimate(P, [{ transform: 'translateX(0) scale(1)' }, { transform: 'translateX(-8px) scale(0.92)', offset: 0.5 }, { transform: 'translateX(0) scale(1)' }], { duration: 300 });
            let rings = [];
            for (let i = 0; i < 3; i++) {
                let r = advFx('<div style="width:100%;height:100%;box-sizing:border-box;border-radius:50%;border:4px solid #38BDF8;background:rgba(56,189,248,.25)"></div>', pc.x, pc.y, 30);
                if (r) rings.push(advAnimate(r, [{ opacity: 0.9, transform: 'translate(0,0) scale(.6)' }, { opacity: 0.9, transform: `translate(${d.dx}px, ${d.dy}px) scale(1.5)`, offset: 0.85 }, { opacity: 0, transform: `translate(${d.dx}px, ${d.dy}px) scale(1.9)` }], { duration: 560, delay: i * 110, easing: 'ease-in', fill: 'backwards' }).then(() => r.remove()));
            }
            await advWait(560 + 110); burst('🌊'); await Promise.all(rings);
        }
    }
    async function advHurt(actorEl, dmg, isEnemy) {
        advFloat(actorEl, '-' + dmg);
        let dir = isEnemy ? 1 : -1;
        await advAnimate(actorEl, [
            { transform: 'translateX(0)', filter: 'brightness(1)' },
            { transform: `translateX(${8 * dir}px)`, filter: 'brightness(2) saturate(.4)', offset: 0.2 },
            { transform: `translateX(${-7 * dir}px)`, filter: 'brightness(1.6)', offset: 0.5 },
            { transform: `translateX(${4 * dir}px)`, offset: 0.75 },
            { transform: 'translateX(0)', filter: 'brightness(1)' }], { duration: 420 });
    }

    // 幸運骰：骰子飄在攻擊者上方，擲到 6 傷害 +1
    async function advShowDice(actorEl, luck) {
        advSetLog(`🎲 幸運骰：${luck.rolls.join('、')}${luck.bonus ? `　擲出 6！傷害 +${luck.bonus}` : '　沒有擲出 6'}`);
        advFloat(actorEl, '🎲' + luck.rolls.join(' '), luck.bonus ? '#7C3AED' : '#64748B');
        await advWait(1000);
    }

    async function advResolveMove(ok) {
        if (!adv.active) return;
        const id = adv.runId;
        adv.busy = true;
        const m = adv.move;
        const P = document.getElementById('advPlayer'), E = document.getElementById('advEnemy');
        adv.q = null;
        if (ok) {
            document.getElementById('advPanel').innerHTML = `<div class="adv-log" id="advLog">✨ 「${m.name}」發動成功！</div>`;
            await advPlayAttack(m);
            if (id !== adv.runId) return;
            let dmg = advDamage(adv.player.atk, m.power, adv.enemy.def);
            let luck = advRollLuck(adv.player.luck, adv.enemy.luck);
            if (luck.rolls.length) {
                await advShowDice(P, luck);
                if (id !== adv.runId) return;
                dmg += luck.bonus;
            }
            adv.enemy.hp = Math.max(0, adv.enemy.hp - dmg);
            advSetLog(`✨「${m.name}」命中！${adv.enemy.name}受到 ${dmg} 點傷害`);
            advUpdateHud();
            await advHurt(E, dmg, true);
            if (id !== adv.runId) return;
            if (adv.enemy.hp <= 0) { await advWin(id); return; }
        } else {
            document.getElementById('advPanel').innerHTML = `<div class="adv-log" id="advLog">💨 「${m.name}」發動失敗…</div>`;
            advFloat(P, 'MISS', '#64748B');
            await advAnimate(P, [{ transform: 'translateX(0)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(5px)' }, { transform: 'translateX(0)' }], { duration: 320 });
            await advWait(300);
            if (id !== adv.runId) return;
        }
        adv.actionsLeft--;
        if (adv.actionsLeft > 0) { adv.busy = false; advShowMenu(); }
        else await advEnemyPhase(id);
    }

    async function advEnemyPhase(id) {
        const P = document.getElementById('advPlayer'), E = document.getElementById('advEnemy');
        let n = advActionCount(adv.enemy.agi, adv.player.agi);
        for (let i = 0; i < n; i++) {
            document.getElementById('advPanel').innerHTML = `<div class="adv-log" id="advLog">${escapeHTML(adv.enemy.name)}的「${escapeHTML(adv.enemy.moveName)}」攻擊！</div>`;
            await advWait(350);
            if (id !== adv.runId) return;
            const d = advDelta(E, P);
            await advAnimate(E, [{ transform: 'translate(0,0) scale(1)' }, { transform: `translate(${d.dx * 0.8}px, ${d.dy * 0.8}px) scale(1.12)`, offset: 0.5 }, { transform: 'translate(0,0) scale(1)' }], { duration: 480, easing: 'ease-in-out' });
            if (id !== adv.runId) return;
            let dmg = advDamage(adv.enemy.atk, adv.enemy.movePower, adv.player.def);
            let luck = advRollLuck(adv.enemy.luck, adv.player.luck);
            if (luck.rolls.length) {
                await advShowDice(E, luck);
                if (id !== adv.runId) return;
                dmg += luck.bonus;
            }
            adv.player.hp = Math.max(0, adv.player.hp - dmg);
            advData.hp = adv.player.hp;          // 體力會繼承到之後的戰鬥
            advSave();
            advSetLog(`${adv.enemy.name}的攻擊！雞塊受到 ${dmg} 點傷害`);
            advUpdateHud();
            await advHurt(P, dmg, false);
            if (id !== adv.runId) return;
            if (adv.player.hp <= 0) { await advLose(id); return; }
        }
        adv.round++;
        advBeginRound();
    }

    async function advWin(id) {
        const P = document.getElementById('advPlayer'), E = document.getElementById('advEnemy');
        adv.active = false;
        releaseWakeLock();
        let lv = adv.level;
        let first = !advData.cleared[lv.id];
        advData.cleared[lv.id] = true;
        advData.shards += lv.rewardShards;
        advSave();
        document.getElementById('advPanel').innerHTML = `<div class="adv-log" id="advLog">🎉 打敗了${escapeHTML(lv.name)}！</div>`;
        advAnimate(E, [{ transform: 'scale(1) rotate(0deg)', opacity: 1 }, { transform: 'scale(.15) rotate(540deg)', opacity: 0 }], { duration: 750, fill: 'forwards', easing: 'ease-in' });
        await advAnimate(P, [{ transform: 'translateY(0)' }, { transform: 'translateY(-16px)', offset: 0.3 }, { transform: 'translateY(0)', offset: 0.6 }, { transform: 'translateY(-10px)', offset: 0.8 }, { transform: 'translateY(0)' }], { duration: 800 });
        if (id !== adv.runId && adv.runId !== id) return;
        document.getElementById('advPanel').innerHTML = `
            <div class="adv-result">
                <div class="big">🎉 勝利！</div>
                <div class="line">🧩 糖醋醬碎片 +${lv.rewardShards}（目前 ${advData.shards} 個）</div>
                <div class="line" style="color:var(--text-muted);font-size:12px;">體力剩 ${advData.hp}/${advMaxHp()}（每天 00:00 恢復）</div>
                ${first ? `<div class="line">🍗 首次通關獎勵：雞塊 ×${lv.rewardChicken}<br><span style="color:var(--text-muted);font-size:12px;">（原型版還沒連上雞塊錢包，這次先不發放）</span></div>` : ''}
            </div>
            ${advData.hp > 0 ? `<button type="button" class="adv-plain-btn main" data-on-click='[["advRetry",[]]]'>再戰一次</button>` : ''}
            <button type="button" class="adv-plain-btn sub" data-on-click='[["advBackToMenu",[]]]'>回關卡</button>`;
    }
    async function advLose(id) {
        const P = document.getElementById('advPlayer');
        adv.active = false;
        releaseWakeLock();
        document.getElementById('advPanel').innerHTML = `<div class="adv-log" id="advLog">雞塊倒下了…</div>`;
        await advAnimate(P, [{ transform: 'rotate(0deg)', opacity: 1 }, { transform: 'rotate(80deg) translateY(10px)', opacity: 0.55 }], { duration: 600, fill: 'forwards' });
        if (id !== adv.runId) return;
        document.getElementById('advPanel').innerHTML = `
            <div class="adv-result"><div class="big">😵 挑戰失敗</div><div class="line">雞塊沒有體力了，明天 00:00 恢復。<br>先去練習單字，或用糖醋醬提升能力吧！</div></div>
            <button type="button" class="adv-plain-btn sub" data-on-click='[["advBackToMenu",[]]]'>回關卡</button>`;
    }

    // 只有登記在 INLINE_ACTIONS 的函式能被呼叫（白名單）
    // ═════════════════════════════════════════════════════════════
    const INLINE_ACTIONS = {
        copyAppUrl,
        playSpeakPracticeSample,
        toggleAdvCard, advStartBattle, advChooseMove, advAnswerCard, advSubmitListen, advReplayListen, advGiveUpSpeak,
        advQuit, advRetry, advBackToMenu, advBackToLevel, goToAdvLevel, goToAdvStats, advUpgrade, advExchangeShards,
        openMicHelpModal,
        closeMicHelpModal,
        recheckMicPermission,
        goToAdventurePage,
        goToSpeakPracticePage,
        toggleSpeakPracticeCard,
        toggleSpeakPracticePreview,
        sortSpeakPracticePreview,
        openSpeakPracticeSettingsModal,
        saveSpeakPracticeSettings,
        startSpeakPracticeSession,
        finishSpeakPracticeSession,
        nextSpeakPracticeQuestion,
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
