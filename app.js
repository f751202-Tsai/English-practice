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
    const CHICKEN_TASK_KEYS = ['dailyLogin', 'listeningPractice', 'cardPractice', 'listeningPerfect', 'cardPerfect', 'advWin'];

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
        list_slot_1: { name: '題庫數量 +1',   desc: '增加 1 本空白題庫（可存放 100 個單字）' },
        mv_charge:   { name: '衝鋒撞擊',     desc: '雞塊大冒險新招式（字卡：輸入中文，威力 3）' },
        mv_slash2:   { name: '連續斬擊',     desc: '雞塊大冒險新招式（聽力：斬 2 下）' },
        mv_thrust:   { name: '突刺',         desc: '雞塊大冒險新招式（聽力：拼出英文，威力 3）' },
        mv_wave2:    { name: '雙重衝擊波',   desc: '雞塊大冒險新招式（朗讀：射 2 發）' },
        mv_wave3:    { name: '雞塊氣功波',   desc: '雞塊大冒險新招式（朗讀：威力 3）' },
        pack_toeic_job: { name: '多益-職場', desc: '購買後多一本「多益-職場」英文單字庫（300 個職場單字），不占用你原本的題庫數量。\n這本單字庫不能清空、刪除或更換語言。' }
    };
    let shopCatalog = {
        word_cap_50: { price: 30, max: 4 },
        list_slot_1: { price: 60, max: 89 },
        mv_charge: { price: 5, max: 1 },
        mv_slash2: { price: 3, max: 1 },
        mv_thrust: { price: 5, max: 1 },
        mv_wave2:  { price: 3, max: 1 },
        mv_wave3:  { price: 5, max: 1 },
        pack_toeic_job: { price: 700, max: 1 }
    };

    function walletQty(key) { return Number((wallet.purchases || {})[key]) || 0; }
    // 每本題庫各自的單字上限：基本 100 字 + 這本題庫兌換過幾次「單字上限 +50」
    function getListWordCap(list) {
        if (list && list.pack && WORD_PACKS[list.pack]) return Math.max(PACK_WORD_CAP, getListWordCount(list.content));
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

    // ── 官方單字庫（用雞塊購買，從後端下載；不占用題庫數量，不能清空／刪除／更換語言）──
    const WORD_PACKS = {
        toeic_job: { item: 'pack_toeic_job', title: '多益-職場', lang: 'en', words: 300 }
    };
    const PACK_WORD_CAP = 300;
    function isPackList(l) { return !!(l && l.pack && WORD_PACKS[l.pack]); }
    function countUserLists() { return wordLists.filter(l => !isPackList(l)).length; }
    function packOwned(key) { return !!WORD_PACKS[key] && walletQty(WORD_PACKS[key].item) > 0; }
    function packInstalled(key) { return wordLists.some(l => l.pack === key); }
    function packKeyByItem(item) { return Object.keys(WORD_PACKS).find(k => WORD_PACKS[k].item === item) || ''; }
    let packInstalling = {};
    async function installWordPack(key, silent) {
        let meta = WORD_PACKS[key];
        if (!meta) return false;
        if (packInstalled(key)) return true;
        if (packInstalling[key]) return false;
        packInstalling[key] = true;
        try {
            let data = await walletRpc('get_word_pack', { p_pack: key });
            let content = data && typeof data.content === 'string' ? data.content : '';
            if (!content.trim()) throw new Error('empty_pack');
            if (packInstalled(key)) return true;
            wordLists.push({ id: newListId(), title: (data.title || meta.title), content: content.trim(), createdAt: Date.now(), lang: data.lang === 'ko' ? 'ko' : 'en', pack: key });
            localStorage.setItem('dictation_word_lists', JSON.stringify(wordLists));
            triggerAutoSaveToCloud();
            refreshAllListViews();
            try { updateChickenShopUI(); } catch (e) {}
            if (!silent) alert(`✅ 已下載「${data.title || meta.title}」單字庫（${getListWordCount(content)} 個單字）！\n到「題庫清單」或各個練習頁就能看到它。`);
            return true;
        } catch (e) {
            console.warn('單字庫下載失敗:', e && e.message || e);
            if (!silent) {
                let m = String((e && e.message) || '');
                if (m.includes('get_word_pack') && (m.includes('function') || m.includes('schema'))) alert('伺服器還沒更新：請先在 Supabase 執行 supabase_adv_v3_3.sql。');
                else alert(`❌ 單字庫下載失敗：${walletErrorMessage(e)}\n已購買的不會重複扣雞塊，稍後到補給站再點一次就能重新下載。`);
            }
            return false;
        } finally {
            packInstalling[key] = false;
        }
    }
    // 已購買但這台裝置還沒有 → 自動下載；同一本重複出現時只留一本
    function ensureWordPacks() {
        let seen = {}, dup = false;
        wordLists.forEach(l => { if (isPackList(l)) { if (seen[l.pack]) dup = true; seen[l.pack] = true; } });
        if (dup) {
            let keep = {};
            wordLists = wordLists.filter(l => { if (!isPackList(l)) return true; if (keep[l.pack]) return false; keep[l.pack] = true; return true; });
            localStorage.setItem('dictation_word_lists', JSON.stringify(wordLists));
            refreshAllListViews();
        }
        Object.keys(WORD_PACKS).forEach(k => { if (packOwned(k) && !packInstalled(k)) installWordPack(k, true); });
    }
    // 每日登入：雞塊 +1（後端錢包）＋ 糖醋醬碎片 +3（存在大冒險進度裡）；其他任務照舊送雞塊
    const LOGIN_SHARDS = 3;
    function isLoginShardClaimed() { try { return advData.loginShardDay === chickenData.lastDate; } catch (e) { return false; } }
    function isTaskClaimed(key) {
        if (key === 'dailyLogin' && !isLoginShardClaimed()) return false;   // 每日登入：雞塊和碎片都領了才算領完
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
        if (m.includes('already_claimed')) return '今天已經領過了';
        if (m.includes('weekly_used')) return '這週已經兌換過了';
        if (m.includes('invalid_day')) return '日期異常，請確認手機的日期時間是否正確';
        if (m.includes('invalid_item') || m.includes('invalid_task')) return '商品或任務不存在';
        if (m.includes('not_purchased')) return '尚未購買這本單字庫';
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
        setTimeout(ensureWordPacks, 0);
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
        let rs = document.getElementById('rewardShardCount');
        if (rs) { try { rs.innerText = advData.shards; } catch (e) {} }
        let container = document.getElementById('rewardTasksContainer');
        if (!container) return;

        const taskDefs = [
            { key: 'dailyLogin', title: '1. 每日登入', desc: `雞塊 ×1、糖醋醬碎片 ×${LOGIN_SHARDS}` },
            { key: 'listeningPractice', title: '2. 完成一次聽力測驗', desc: '' },
            { key: 'cardPractice', title: '3. 完成一次字卡測驗', desc: '' },
            { key: 'listeningPerfect', title: '4. 聽力測驗 80 分且題數≥ 10 ', desc: '' },
            { key: 'cardPerfect', title: '5. 字卡測驗 80 分且題數≥ 10', desc: '' },
            { key: 'advWin', title: '6. 在大冒險中打贏一場敵人', desc: '雞塊 ×1' }
        ];

        let html = '';
        taskDefs.forEach(def => {
            let t = chickenData.tasks[def.key];
            let statusHtml = '';
            if (isTaskClaimed(def.key)) {
                statusHtml = `<span class="task-status-text completed">已領取</span>`;
            } else if (t.done) {
                statusHtml = `<button class="cloud-btn" data-on-click='[["claimChickenReward",["${def.key}"]]]'>${def.key === 'dailyLogin' ? '領取' : '領1個'}</button>`;
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
        if (taskKey === 'dailyLogin' && !isLoginShardClaimed()) {
            // 碎片先發（存在本機進度）；雞塊下面照原本的方式向後端領
            advData.shards += LOGIN_SHARDS;
            advData.loginShardDay = chickenData.lastDate;
            advSave();
            showChickenFloat('rewardShardCount', '+' + LOGIN_SHARDS, '#10B981');
            try { advRenderShopBox(); } catch (e) {}
            updateChickenBadgeUI();
            let alreadyChicken = wallet.day === chickenData.lastDate && (wallet.claimedToday || []).indexOf('dailyLogin') !== -1;
            if (alreadyChicken) { updateChickenModalUI(); return; }
        }
        walletBusy = true;
        try {
            let before = wallet.balance;
            // 大冒險勝利是後來新增的任務，用獨立的後端函式領取（見 supabase_adv_v3_4.sql）
            let data = taskKey === 'advWin'
                ? await walletRpc('claim_adv_win', { p_day: chickenData.lastDate })
                : await walletRpc('claim_reward', { p_task: taskKey, p_day: chickenData.lastDate });
            applyWallet(data, chickenData.lastDate);
            let gained = wallet.balance - before;
            if (gained > 0) showChickenFloat('chickenCountDisplay', '+' + gained, '#EF4444');
        } catch (e) {
            if (String((e && e.message) || '').includes('already_claimed')) {   // 同一個帳號在別台裝置已經領過
                if (!Array.isArray(wallet.claimedToday)) wallet.claimedToday = [];
                if (wallet.claimedToday.indexOf(taskKey) === -1) wallet.claimedToday.push(taskKey);
                wallet.day = chickenData.lastDate;
                try { localStorage.setItem(WALLET_CACHE_KEY, JSON.stringify(wallet)); } catch (e2) {}
                updateChickenModalUI(); updateChickenBadgeUI();
                return;
            }
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
        // 官方英文單字庫：學習語言是韓文時不顯示
        let hidePack = getLearningLanguage() === 'ko';
        let filler = document.getElementById('shopPackFiller');
        if (filler) filler.style.display = hidePack ? '' : 'none';
        Object.keys(SHOP_ITEM_META).forEach(key => {
            if (key.indexOf('mv_') === 0) return;      // 招式商品由 advRenderShopBox 負責畫
            let cell = document.getElementById('shopItem_' + key);
            if (!cell) return;
            let pk = packKeyByItem(key);
            if (pk) {
                cell.style.display = hidePack ? 'none' : '';
                let catP = shopCatalog[key], owned = walletQty(key) > 0, installed = packInstalled(pk);
                let needDl = owned && !installed;
                cell.classList.toggle('is-maxed', owned && installed);
                cell.classList.toggle('is-poor', !owned && wallet.balance < catP.price);
                let subP = document.getElementById('shopSub_' + key);
                if (subP) subP.textContent = needDl ? '點一下重新下載' : (owned ? '已在你的題庫裡' : `${WORD_PACKS[pk].words} 個職場單字`);
                let priceP = document.getElementById('shopPrice_' + key);
                if (priceP) priceP.innerHTML = owned ? (needDl ? '⬇️ 下載' : '已擁有') : `<span class="chicken-mini"></span><b>${catP.price}</b>`;
                return;
            }
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
        try { advRenderShopBox(); } catch (e) {}
    }

    async function buyShopItem(key) {
        let meta = SHOP_ITEM_META[key], cat = shopCatalog[key];
        if (!meta || !cat || walletBusy) return;
        if (!ensureLoginBeforeSpend()) return;

        // 官方單字庫：已購買就只要（重新）下載
        let packKey = packKeyByItem(key);
        if (packKey) {
            if (getLearningLanguage() === 'ko') return;
            if (walletQty(key) > 0) {
                if (packInstalled(packKey)) { alert(`已經擁有「${meta.name}」了，到「題庫清單」就能看到。`); return; }
                installWordPack(packKey, false);
                return;
            }
        }

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
            if (key.indexOf('mv_') === 0) advOnShopPurchase(key);
            if (packKey) await installWordPack(packKey, false);
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
            if (isPackList(l)) return;          // 官方單字庫不能擴增
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
                    if (!renewing) { cloudWalletKey = null; walletBoundThisLogin = false; advSwitchStore(); }   // 換成 Google 進度
                    accessToken = resp.access_token;
                    isCloudSyncActive = true;
                    updateCloudStatusText(`✅ 已連結 Google 雲端`);
                    if (!renewing) { loadDataFromGoogleDrive(); cloudFetchEmail(); }
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

        cloudRender();
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

    // ── Google 雲端狀態：首頁雲朵 + 系統設定區塊 ──
    //   ok：已登入同步中　bad：登入過但權杖失效（點一下重新連線）　off：這台裝置從沒登入過
    let cloudLastText = '', cloudHighlight = false;
    const CLOUD_SEEN_KEY = 'chicky_cloud_seen';     // 看過「未登入」提醒後，紅色驚嘆號就不再出現
    function cloudSeen() { try { return localStorage.getItem(CLOUD_SEEN_KEY) === '1'; } catch (e) { return false; } }
    const GOOGLE_EMAIL_KEY = 'chicky_google_email';
    function cloudState() {
        if (accessToken) return 'ok';
        let linked = false;
        try { linked = localStorage.getItem(GOOGLE_LINKED_FLAG) === '1'; } catch (e) {}
        if (!linked) return 'off';
        return /重新連線 Google 雲端中|同步中/.test(cloudLastText) ? 'busy' : 'bad';
    }
    function cloudRender() {
        let st = cloudState();
        let tip = document.getElementById('cloudTip'), seen = cloudSeen();
        document.querySelectorAll('.cloud-st-btn').forEach(btn => {
            btn.className = 'cloud-st-btn st-' + st + (st === 'off' && seen ? ' seen' : '') + (btn.classList.contains('in-nav') ? ' in-nav' : '');
            btn.setAttribute('aria-label', 'Google 雲端：' + ({ ok: '已連線', bad: '連線中斷', off: '未登入', busy: '連線中' })[st]);
            let dot = btn.querySelector('.cloud-st-dot');
            if (dot) dot.textContent = st === 'ok' ? '✓' : '!';
        });
        if (tip) tip.style.display = st === 'bad' ? '' : 'none';
        let box = document.getElementById('cloudSettingsBox');
        if (!box) return;
        let email = '';
        try { email = localStorage.getItem(GOOGLE_EMAIL_KEY) || ''; } catch (e) {}
        let html;
        if (st === 'ok') {
            let syncing = /同步中/.test(cloudLastText);
            html = `<div class="row"><div><b>☁️ Google 雲端</b><small>${email ? '已連結：' + escapeHTML(email) : '已連結 Google 帳號'}</small></div><span class="st">${syncing ? '🔄 同步中…' : '✅ 同步中'}</span></div>
                <div class="row" style="margin-top:10px"><small>題庫、測驗紀錄、大冒險進度會自動備份</small><button type="button" id="cloudAuthBtn" class="gbtn out" data-on-click='[["handleLogout",[]]]'>登出</button></div>`;
        } else if (st === 'off') {
            html = `<div class="row"><div><b>☁️ Google 雲端</b><small>💻 未登入（資料只存在這台裝置）</small></div><button type="button" id="cloudAuthBtn" class="gbtn" data-on-click='[["handleAuthClick",[]]]'>登入 Google 雲端${seen ? '' : '<span class="adv-alert" aria-label="尚未登入">!</span>'}</button></div>
                <div class="note">💡 登入後，題庫、測驗紀錄和大冒險進度會自動同步到雲端，換手機也不會不見。</div>`;
        } else {
            html = `<div class="row"><div><b>☁️ Google 雲端</b><small>${email ? escapeHTML(email) + '｜' : ''}${st === 'busy' ? '重新連線中…' : '雲端連線已中斷'}</small></div><span class="st bad">${st === 'busy' ? '🔄 連線中' : '⚠️ 已中斷'}</span></div>
                <div class="row" style="margin-top:10px"><button type="button" class="gbtn" data-on-click='[["cloudReconnect",[]]]'>重新連線</button><button type="button" id="cloudAuthBtn" class="gbtn out" data-on-click='[["handleLogout",[]]]'>登出</button></div>`;
        }
        box.innerHTML = html;
        box.classList.toggle('hl', cloudHighlight && st !== 'ok');
    }
    function openCloudSettings() {
        cloudHighlight = cloudState() === 'off';
        openSystemSettingsModal();
        cloudRender();
        let m = document.querySelector('#systemSettingsModal .modal-content'); if (m) m.scrollTop = 0;
    }
    function cloudReconnect() {
        if (getBrowserEnv().isInApp) { handleAuthClick(); return; }
        trySilentReconnect(true);
        cloudRender();
    }
    // 取得登入的 Google 帳號 email（只用來顯示在設定頁）
    async function cloudFetchEmail() {
        if (!accessToken) return;
        try {
            let r = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', { headers: { 'Authorization': `Bearer ${accessToken}` } });
            if (!r.ok) return;
            let j = await r.json();
            let em = j && j.user && j.user.emailAddress;
            if (em) { localStorage.setItem(GOOGLE_EMAIL_KEY, em); cloudRender(); }
        } catch (e) {}
    }
    function updateCloudStatusText(text) {
        cloudLastText = String(text || '');
        cloudRender();
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
        wordLists.forEach(l => { if (!isPackList(l)) c[getListLang(l)]++; });
        return c;
    }

    // 題庫頁上方：英文 4 ｜ 韓文 6 ｜ 剩餘 0
    function updateListQuotaBar() {
        let bar = document.getElementById('listQuotaBar');
        if (!bar) return;
        let c = countListsByLang(), cur = getLearningLanguage();
        let remain = Math.max(0, getMaxLists() - countUserLists());
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
        if (isPackList(list)) { alert('🔒 官方單字庫無法更換語言。'); return; }
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
        try { updateChickenShopUI(); } catch (e) {}
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
        cloudRender();
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
    async function handleLogout() {
        // 登出前先把還沒上傳的大冒險進度送上雲端
        if (accessToken && advCloudReady && advDirty) { clearTimeout(advCloudTimer); try { await triggerAutoSaveToCloud(); } catch (e) {} }
        localStorage.removeItem(GOOGLE_LINKED_FLAG);       // 不再自動重新連線
        if (!advDirty) { try { localStorage.removeItem(ADV_STORE_G); } catch (e) {} }   // 已經上傳完：清掉本機暫存（下次登入從雲端載入，也避免換帳號時混在一起）
        advSwitchStore();                                  // 換回離線進度（Google 進度留在雲端，不會被刪）
        clearTimeout(tokenRefreshTimer);
        if (!accessToken) {                                // 權杖已失效（等待重新連線）時，也要能登出
            try { localStorage.removeItem(GOOGLE_EMAIL_KEY); } catch (e) {}
            updateCloudStatusText(`💻 未登入`);
            return;
        }
        const tokenToRevoke = accessToken;
        // 登出只是「不再同步 Google 雲端」。錢包綁定不會解除，登出後的領取／購買仍進同一個錢包，不會回溯。
        cloudWalletKey = null; walletBoundThisLogin = false;
        // 先在本機完成登出（不依賴網路），再盡力通知 Google 撤銷授權
        accessToken = null; isCloudSyncActive = false;
        try { localStorage.removeItem(GOOGLE_EMAIL_KEY); } catch (e) {}
        updateCloudStatusText(`💻 未登入`);
        try { google.accounts.oauth2.revoke(tokenToRevoke, () => {}); } catch (e) { console.warn('撤銷授權失敗（本機已登出）', e); }
        alert("🔒 已登出 Google 帳號。");
    }

    async function loadDataFromGoogleDrive() {
        if (!accessToken) return;
        updateCloudStatusText(`☁️ 雲端資料同步中...`);
        let advNeedUpload = false;
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
                    // 大冒險進度：Google 進度和離線進度分開，這裡只處理 Google 進度
                    advNeedUpload = advMergeFromCloud(cloudData.advData, isValidWalletKey(cloudData.walletKey) ? cloudData.walletKey : '');
                } else advNeedUpload = advMergeFromCloud(null, '');
            } else advNeedUpload = advMergeFromCloud(null, '');
            advCloudReady = true;
            // 登入後第一次同步：把這台裝置的錢包和 Google 雲端的錢包綁在一起
            if (!walletBoundThisLogin) {
                walletBoundThisLogin = true;
                let usedKey = await bindWalletAfterLogin(cloudWalletKey);
                if (usedKey) {
                    let needUpload = usedKey !== cloudWalletKey;
                    cloudWalletKey = usedKey;
                    if (!advData.owner) { advData.owner = usedKey; advSave(); }
                    if (needUpload) { advNeedUpload = false; await triggerAutoSaveToCloud(); }
                } else {
                    walletBoundThisLogin = false;   // 連線失敗：下次同步時再試
                }
            }
            if (advNeedUpload) await triggerAutoSaveToCloud();
            updateCloudStatusText(`✅ 已連結 Google 雲端`);
        } catch (err) { 
            console.error("雲端載入失敗", err); 
            updateCloudStatusText(`⚠️ 雲端同步失敗`);
        }
    }

    async function triggerAutoSaveToCloud() {
        localStorage.setItem('dictation_word_lists', JSON.stringify(wordLists));
        if (!accessToken || !isCloudSyncActive) return;
        if (!advCloudReady) return;      // 雲端資料還沒載入完就上傳，會蓋掉雲端的大冒險進度
        updateCloudStatusText(`☁️ 上傳備份中...`);
        const tok = accessToken, sentTs = advData.ts;
        try {
            let query = encodeURIComponent(`name='${FILENAME}' and 'appDataFolder' in parents and trashed=false`);
            let res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&spaces=appDataFolder`, {
                headers: { 'Authorization': `Bearer ${tok}` }
            });
            if (res.status === 401) { handleDriveUnauthorized(); return; }
            let data = await res.json();
            let fileId = (data.files && data.files.length > 0) ? data.files[0].id : null;
            // 另一台裝置如果存了比較新的大冒險進度，先採用它，避免用舊進度蓋掉
            if (fileId && advIsGoogleMode()) {
                try {
                    let cr = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: { 'Authorization': `Bearer ${tok}` } });
                    let cj = await cr.json();
                    if (cj && cj.advData && (parseInt(cj.advData.ts) || 0) > advData.ts) advMergeFromCloud(cj.advData, '');
                } catch (e) { /* 讀不到就照原本流程上傳 */ }
            }
            let cloudData = { 
                activeDeviceId: myDeviceId, 
                wordLists, 
                examHistory: trimHistoryPerLang(examHistory), 
                cardExamHistory: trimHistoryPerLang(cardExamHistory), 
                walletKey: cloudWalletKey || undefined,
                chickenData,
                advData: advIsGoogleMode() ? advData : undefined,     // 只上傳 Google 進度；離線進度不會上傳
                appSettings: JSON.parse(localStorage.getItem('dictation_app_settings') || '{}') 
            };
            let fileContent = JSON.stringify(cloudData);

            let wr;
            if (fileId) {
                wr = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
                    method: 'PATCH',
                    headers: { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json' },
                    body: fileContent
                });
            } else {
                let metadata = { name: FILENAME, parents: ['appDataFolder'] };
                let form = new FormData();
                form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
                form.append('file', new Blob([fileContent], { type: 'application/json' }));
                wr = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
                    method: 'POST', headers: { 'Authorization': `Bearer ${tok}` }, body: form
                });
            }
            if (wr && wr.ok === false) throw new Error('上傳失敗 ' + wr.status);
            if (advIsGoogleMode() && advData.ts === sentTs) advDirty = false;
            updateCloudStatusText(`✅ 已連結 Google 雲端`);
        } catch(e) { 
            console.error("雲端存檔失敗", e); 
            updateCloudStatusText(`⚠️ 雲端同步失敗`);
        }
    }

    function switchView(viewId) {
        // 戰鬥中打字：鍵盤蓋在畫面上，不要把整個遊戲畫面往上推
        try { if (navigator.virtualKeyboard) navigator.virtualKeyboard.overlaysContent = (viewId === 'adventureBattleView'); } catch (e) {}
        document.querySelectorAll('.app-view').forEach(v => v.classList.remove('active'));
        document.getElementById(viewId).classList.add('active');
        if (viewId === 'homeDashboardView') { try { homeAdvBadge(); } catch (e) {} }
        
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
            let pack = isPackList(l);
            let menuItems = pack
                ? `<button class="dropdown-item" data-on-click='[["$stop",[]],["renameListTitleFromMenu",[${idx}]]]'>修改</button>
                            <div class="dropdown-note">🔒 官方單字庫無法清空、刪除或更換語言</div>`
                : `<button class="dropdown-item" data-on-click='[["$stop",[]],["renameListTitleFromMenu",[${idx}]]]'>修改</button>
                            <button class="dropdown-item" data-on-click='[["$stop",[]],["changeListLanguageFromMenu",[${idx}]]]'>更換語言</button>
                            <button class="dropdown-item" data-on-click='[["$stop",[]],["clearListContentFromMenu",[${idx}]]]'>清空</button>
                            <button class="dropdown-item danger" data-on-click='[["$stop",[]],["deleteListFromMenu",[${idx}]]]'>刪除</button>`;
            let cardHtml = `
                <div class="list-card-item${pack ? ' is-pack' : ''}" data-on-click='[["openEditorDetail",[${idx}]]]'>
                    <div class="list-card-info">
                        <div class="list-card-title">${shown}: ${escapeHTML(l.title)} <span class="lang-tag lang-tag-${lang}">${getLangName(lang)}</span>${pack ? ' <span class="pack-tag">🔒 官方</span>' : ''}</div>
                        <div class="list-card-count">(${count}/${getListWordCap(wordLists[idx])} 字)</div>
                    </div>
                    <div style="position: relative;">
                        <button class="list-card-menu-btn" data-on-click='[["$stop",[]],["toggleDropdownMenu",[${idx},"$event"]]]'>⋮</button>
                        <div class="dropdown-menu" id="dropdownMenu_${idx}">
                            ${menuItems}
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
        if (!wordLists[idx]) return;
        if (isPackList(wordLists[idx])) { alert('🔒 官方單字庫無法清空。'); return; }
        if (confirm(`確定要清空「${wordLists[idx].title}」裡的所有單字嗎？`)) {
            wordLists[idx].content = "";
            triggerAutoSaveToCloud();
            initEditorListCards();
            alert("🧹 題庫已清空並自動儲存！");
        }
    }

    function deleteListFromMenu(idx) {
        if (!wordLists[idx]) return;
        if (isPackList(wordLists[idx])) { alert('🔒 官方單字庫無法刪除。'); return; }
        if (countUserLists() <= 1) {
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
        if (countUserLists() >= getMaxLists()) {
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
        if (card.senses && card.senses.length > 1) {
            document.getElementById('fcCardChi').innerText = card.senses.map(s => s.m.join('、')).join(' ／ ');
            document.getElementById('fcCardPos').innerText = card.senses.map(s => s.p.join('、') || '—').join(' ／ ');
        } else {
            document.getElementById('fcCardChi').innerText = card.chinese || '(無中文)';
            document.getElementById('fcCardPos').innerText = card.pos || '單字';
        }
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
            cardExamAnswerTime: document.getElementById('cardExamAnswerTime').value,
            cardExamVoiceChi: document.getElementById('cardExamVoiceChi').checked
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
            if (s.cardExamVoiceChi !== undefined) document.getElementById('cardExamVoiceChi').checked = !!s.cardExamVoiceChi;
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

    async function startCardExamSession() {
        let text = document.getElementById('cardExamPreviewTextarea').value.trim();
        let words = parseWordsRaw(text);
        if (words.length && !voiceChiChecking) {
            voiceChiChecking = true;
            let micOk = await voiceChiPrepare('cardExamInputChi');
            voiceChiChecking = false;
            if (!micOk) return;
        } else if (voiceChiChecking) return;
        applyVoiceChiButtons();

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

        voiceChiStop();
        setupChiInputs('cardExamInputChi', card);
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

        try { document.getElementById('cardExamInputChi').focus(); } catch (e) {}

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
        let userChiArr = readChiInputs('cardExamInputChi');
        let userChi = userChiArr.filter(Boolean).join('、');
        let userPosArr = [];
        document.querySelectorAll('.card-exam-pos-chk:checked').forEach(chk => userPosArr.push(normPos(chk.value.trim())));

        let currentItem = cardExamActiveList[currentCardExamIndex];
        let chiMatch = matchChineseAnswers(userChiArr, currentItem);

        let correctPosArr = (currentItem.posList || (currentItem.pos ? currentItem.pos.split(/\s+/) : [])).map(s => normPos(s.trim())).filter(s => s.length > 0);
        correctPosArr = correctPosArr.filter((p, i) => correctPosArr.indexOf(p) === i);
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
            senseText: currentItem.senseText || '',
            line: currentItem.line || '',
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
            let correctInfo = r.senseText ? `${escapeHTML(r.english)} (${escapeHTML(r.senseText)})` : `${escapeHTML(r.english)} (${escapeHTML(r.chinese || '')}) ${r.pos ? '/ ' + escapeHTML(r.pos) : ''}`;

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
        document.getElementById('speakPracticeCardChi').innerText = wordMeaningLine(card);
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

    // ── 單字格式 ──
    //   apple 蘋果 名詞                 → 1 個意思、1 個詞性
    //   mature 成熟 動詞 形容詞          → 1 個意思、2 個詞性
    //   Perform 執行 表現 動詞           → 2 個意思、1 個詞性
    //   Star 星星 名詞 出演 動詞         → 2 組「意思＋詞性」
    // 中文部分用空白分開；詞性以外的字都當成「意思」，意思出現在詞性後面就開始新的一組
    const WORD_POS_LIST = ['名詞', '動詞', '形容詞', '副詞', '介係詞', '介系詞', '介詞', '連接詞', '連詞', '代名詞', '代詞', '感嘆詞', '感歎詞', '助動詞', '冠詞', '數詞', '量詞', '片語', '及物動詞', '不及物動詞', '動詞片語', '名詞片語', '形容詞片語', '副詞片語', '介係詞片語', '慣用語', '縮寫'];
    const WORD_POS_SET = new Set(WORD_POS_LIST);
    const WORD_POS_ALIAS = { '介系詞': '介係詞', '介詞': '介係詞', '連詞': '連接詞', '代詞': '代名詞', '感歎詞': '感嘆詞' };
    function isPosToken(t) {
        if (WORD_POS_SET.has(t)) return true;
        return /^(n|v|vt|vi|adj|adv|prep|conj|pron|int|interj|aux|phr|det|art|num)\.?$/i.test(t);
    }
    function normPos(p) { return WORD_POS_ALIAS[p] || p; }
    function parseMeaningPart(rest) {
        let tokens = String(rest || '').split(/\s+/).filter(Boolean);
        let senses = [], cur = null;
        tokens.forEach(t => {
            if (isPosToken(t)) {
                if (!cur) { cur = { m: [], p: [] }; senses.push(cur); }
                if (cur.p.indexOf(t) === -1) cur.p.push(t);
            } else {
                if (!cur || cur.p.length) { cur = { m: [], p: [] }; senses.push(cur); }
                cur.m.push(t);
            }
        });
        let meanings = [], posList = [];
        senses.forEach(s => {
            s.m.forEach(m => { if (meanings.indexOf(m) === -1) meanings.push(m); });
            s.p.forEach(p => { if (posList.indexOf(p) === -1) posList.push(p); });
        });
        return { senses: senses.filter(s => s.m.length || s.p.length), meanings, posList };
    }
    // 多組「意思＋詞性」時的顯示文字：星星（名詞）；出演（動詞）
    function wordSenseText(senses) {
        if (!senses || senses.length < 2) return '';
        return senses.map(s => s.m.join('、') + (s.p.length ? `（${s.p.join('、')}）` : '')).join('；');
    }
    // 給練習畫面用的一行說明：「詞性 意思」或多組時的「意思（詞性）；…」
    function wordMeaningLine(w) {
        if (!w) return '';
        if (w.senseText) return w.senseText;
        return w.chinese ? ((w.pos ? w.pos + ' ' : '') + w.chinese) : '';
    }

    function parseWordsRaw(text) {
        let lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        let allWords = [], seen = new Set();
        lines.forEach((line) => {
            let isStarred = line.startsWith('*');
            let cleanLine = isStarred ? line.substring(1).trim() : line;
            let firstChiIndex = cleanLine.search(/[一-龥]/);
            let engPart = firstChiIndex !== -1 ? cleanLine.substring(0, firstChiIndex).trim() : cleanLine.trim();
            let restPart = firstChiIndex !== -1 ? cleanLine.substring(firstChiIndex).trim() : "";
            let pm = parseMeaningPart(restPart);
            let key = engPart.toLowerCase();
            if (key && !seen.has(key)) {
                seen.add(key);
                allWords.push({
                    english: engPart,
                    chinese: pm.meanings.join('、'),      // 顯示用（多個意思用「、」連接）
                    pos: pm.posList.join(' '),
                    meanings: pm.meanings,
                    posList: pm.posList,
                    senses: pm.senses,
                    senseText: wordSenseText(pm.senses),
                    starred: isStarred,
                    rawLine: line,
                    line: cleanLine
                });
            }
        });
        return allWords;
    }

    // ── 測驗的中文作答欄：有幾個意思就顯示幾格（最多 3 格）──
    function chiBoxCount(item) { return Math.max(1, Math.min(3, ((item && item.meanings) || []).length || 1)); }
    function chiInputIds(prefix) { return [prefix, prefix + '2', prefix + '3']; }
    function setupChiInputs(prefix, item) {
        let n = chiBoxCount(item);
        chiInputIds(prefix).forEach((id, i) => {
            let el = document.getElementById(id);
            if (!el) return;
            el.value = '';
            el.style.display = i < n ? '' : 'none';
            el.placeholder = n > 1 ? `意思 ${i + 1}` : '輸入中文...';
        });
        let tip = document.getElementById(prefix + 'Tip');
        if (tip) tip.textContent = n > 1 ? `（這個單字有 ${n} 個意思，請各填一個，順序不拘）` : '';
    }
    function readChiInputs(prefix) {
        return chiInputIds(prefix).map(id => document.getElementById(id))
            .filter(el => el && el.style.display !== 'none')
            .map(el => el.value.trim());
    }
    function setChiInputsDisabled(prefix, disabled) {
        chiInputIds(prefix).forEach(id => { let el = document.getElementById(id); if (el) el.disabled = disabled; });
    }
    function engAnswerNorm(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC').trim().toLowerCase(); }
    function chiNorm(s) { return String(s || '').normalize('NFC').replace(/[（(][^）)]*[）)]/g, '').replace(/[\s　，,、；;。.！!？?\/／…~～]/g, ''); }
    // 每一格都要對到一個「還沒用過」的意思（順序不拘）；沒有中文的單字直接算對
    function matchChineseAnswers(userArr, item) {
        let meanings = (item && item.meanings) || [];
        if (!meanings.length) return true;
        let pool = meanings.map(chiNorm);
        let whole = chiNorm(meanings.join(''));
        for (let u of userArr) {
            let nu = chiNorm(u);
            if (!nu) return false;
            let i = pool.indexOf(nu);
            if (i === -1 && userArr.length === 1 && nu === whole) return true;
            if (i === -1) return false;
            pool.splice(i, 1);
        }
        return true;
    }
    function handleChiKeyDown(e, which, i) {
        if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        let prefix = which === 'card' ? 'cardExamInputChi' : 'examInputChi';
        let next = document.getElementById(prefix + (i + 2));
        if (next && next.style.display !== 'none' && !next.disabled) next.focus();
        else if (which === 'card') submitCardExamAnswer();
        else submitExamAnswer();
    }

    // ── 題庫編輯頁的「F」：格式說明 ──
    function openWordFormatModal() { document.getElementById('wordFormatModal').style.display = 'block'; }
    function closeWordFormatModal() { document.getElementById('wordFormatModal').style.display = 'none'; }

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
        let sayChi = document.getElementById('enableChinese').checked && item.chinese;
        let sayPos = document.getElementById('enablePOS').checked && item.pos;
        if (sayChi && sayPos && item.senses && item.senses.length > 1) {
            // 多組「意思＋詞性」：照順序一組一組念
            item.senses.forEach(s => { let t = [s.m.join('，'), s.p.join('，')].filter(Boolean).join('，'); if (t) queue.push({ text: t, isEng: false }); });
        } else {
            if (sayChi) queue.push({ text: (item.meanings && item.meanings.length ? item.meanings.join('，') : item.chinese), isEng: false });
            if (sayPos) queue.push({ text: item.pos, isEng: false });
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

    let voiceChiChecking = false;
    async function startExamMode() {
        let words = getSelectedExamWords();
        if (words.length === 0) { alert('⚠️ 請至少勾選一個考試範圍或確認範圍內有符合條件的單字！'); return; }
        if (voiceChiChecking) return;
        voiceChiChecking = true;
        let micOk = await voiceChiPrepare('examInputChi');
        voiceChiChecking = false;
        if (!micOk) return;
        applyVoiceChiButtons();

        let resultContainerEl = document.getElementById('resultContainer');
        if (resultContainerEl) {
            resultContainerEl.innerHTML = '';
            resultContainerEl.style.display = 'none';
        }

        window.scrollTo({ top: 0, behavior: 'smooth' });

        requestWakeLock();

        wordsData = words;
        currentWordIndex = 0; isPlaying = true; isExamRunning = true; examResults = [];
        clearExamInputs();
        
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
        voiceChiStop();
        setupChiInputs('examInputChi', item);
        setExamInputsDisabled(true);
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
                    setExamInputsDisabled(false);
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
        let userChiArr = readChiInputs('examInputChi');
        let userChi = userChiArr.filter(Boolean).join('、');

        let currentItem = wordsData[currentWordIndex];
        if (!currentItem) return;

        let engMatch = (engAnswerNorm(userEng) === engAnswerNorm(currentItem.english));
        let chiMatch = matchChineseAnswers(userChiArr, currentItem);

        let isCorrect = engMatch && chiMatch;

        examResults.push({
            english: currentItem.english,
            chinese: currentItem.chinese,
            senseText: currentItem.senseText || '',
            line: currentItem.line || '', 
            userEng, 
            userChi, 
            isCorrect,
            engMatch,
            chiMatch
        });

        currentWordIndex++;

        document.getElementById('examInputEng').value = '';
        chiInputIds('examInputChi').forEach(id => { let el = document.getElementById(id); if (el) el.value = ''; });
        setExamInputsDisabled(true);
        
        let pauseSec = parseInt(document.getElementById('examPauseTime').value);
        if (isNaN(pauseSec)) pauseSec = 1;
        setTimeout(playExamQuestion, pauseSec * 1000);
    }

    // 清掉上一次（或中途離開時）留在輸入框的字
    function clearExamInputs() {
        let e = document.getElementById('examInputEng'); if (e) e.value = '';
        chiInputIds('examInputChi').forEach(id => { let el = document.getElementById(id); if (el) el.value = ''; });
        voiceChiStop();
    }
    // ── 語音輸入中文（聽力測驗、字卡測驗） ──
    let voiceChiRec = null, voiceChiPrefix = '', voiceChiLastFocus = {};
    function voiceChiOn(prefix) {
        let el = document.getElementById(prefix === 'cardExamInputChi' ? 'cardExamVoiceChi' : 'examVoiceChi');
        return !!(el && el.checked && getSpeechRecognitionCtor());
    }
    function applyVoiceChiButtons() {
        [['examInputChi', 'examVoiceBtn'], ['cardExamInputChi', 'cardExamVoiceBtn']].forEach(([p, b]) => {
            let btn = document.getElementById(b);
            if (btn) btn.style.display = voiceChiOn(p) ? '' : 'none';
        });
    }
    // 記住最後點的是哪一格中文欄位（語音結果會填進那一格）
    document.addEventListener('focusin', (e) => {
        let id = e.target && e.target.id;
        if (id && /^(examInputChi|cardExamInputChi)\d?$/.test(id)) voiceChiLastFocus[id.replace(/\d$/, '')] = id;
    });
    function voiceChiTarget(prefix) {
        let ids = chiInputIds(prefix).filter(id => { let el = document.getElementById(id); return el && el.style.display !== 'none'; });
        let last = voiceChiLastFocus[prefix];
        if (last && ids.includes(last) && !document.getElementById(last).value.trim()) return document.getElementById(last);
        let empty = ids.find(id => !document.getElementById(id).value.trim());
        return document.getElementById(empty || (last && ids.includes(last) ? last : ids[0]));
    }
    function voiceChiStop() {
        if (voiceChiRec) { try { voiceChiRec.abort(); } catch (e) {} }
        voiceChiRec = null;
        document.querySelectorAll('.voice-chi-btn.recording').forEach(b => b.classList.remove('recording'));
    }
    function voiceChiToggle(prefix) {
        if (voiceChiRec) { voiceChiStop(); return; }
        let Ctor = getSpeechRecognitionCtor();
        if (!Ctor) { alert('此瀏覽器不支援語音辨識'); return; }
        let target = voiceChiTarget(prefix);
        if (!target || target.disabled) return;
        let btn = document.getElementById(prefix === 'cardExamInputChi' ? 'cardExamVoiceBtn' : 'examVoiceBtn');
        let rec = new Ctor();
        rec.lang = 'zh-TW';
        rec.interimResults = false;
        rec.maxAlternatives = 1;
        rec.onresult = (ev) => {
            let t = '';
            try { t = ev.results[0][0].transcript || ''; } catch (e) {}
            t = t.replace(/[。，,.！!？?\s]/g, '');
            if (t && !target.disabled) { target.value = t; target.dispatchEvent(new Event('input', { bubbles: true })); }
        };
        rec.onerror = (ev) => { if (ev && (ev.error === 'not-allowed' || ev.error === 'service-not-allowed')) { try { openMicHelpModal(); } catch (e) {} } };
        rec.onend = () => { if (voiceChiRec === rec) voiceChiStop(); };
        voiceChiRec = rec; voiceChiPrefix = prefix;
        if (btn) btn.classList.add('recording');
        try { rec.start(); } catch (e) { voiceChiStop(); }
    }
    // 開始考試前：有開語音輸入就先確認麥克風權限，避免第一題作答時間被開麥克風耽誤
    async function voiceChiPrepare(prefix) {
        if (!voiceChiOn(prefix)) return true;
        alert('🎙️ 已開啟「語音輸入中文」\n\n接下來會確認麥克風權限，允許後才會開始考試。');
        let mic = await ensureMicPermission(true);
        if (!mic.ok) { if (mic.denied) openMicHelpModal(); else alert(mic.message || '⚠️ 無法使用麥克風'); return false; }
        return true;
    }
    function setExamInputsDisabled(disabled) {
        document.getElementById('examInputEng').disabled = disabled;
        setChiInputsDisabled('examInputChi', disabled);
        document.getElementById('examSubmitBtn').disabled = disabled;
    }

    function stopExamMode() {
        isPlaying = false; isExamRunning = false; synth.cancel();
        clearExamInputs();
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
            let correctInfo = `${escapeHTML(r.english)} (${escapeHTML(r.senseText || r.chinese || '')})`;

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
    function closeSystemSettingsModal() {
        document.getElementById('systemSettingsModal').style.display = 'none'; cloudHighlight = false;
        if (cloudState() === 'off') { try { localStorage.setItem(CLOUD_SEEN_KEY, '1'); } catch (e) {} }   // 看過了 → 紅色驚嘆號消失
        cloudRender();
    }
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
            if (!isListInCurrentLang(l) || isPackList(l)) return;
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

                        let correctStr = `${escapeHTML(r.english)} (${escapeHTML(r.senseText || r.chinese || '')})`;
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
                        let correctStr = r.senseText ? `${escapeHTML(r.english)} (${escapeHTML(r.senseText)})` : `${escapeHTML(r.english)} (${escapeHTML(r.chinese || '')}) ${r.pos ? '/ ' + escapeHTML(r.pos) : ''}`;
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
                            listeningWrongMap[key] = { english: r.english, chinese: r.senseText || r.chinese, line: r.line || '', count: 0 };
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
                    <input type="checkbox" checked value="${escapeHTML(w.english)}" data-line="${escapeHTML(w.line || '')}"> 
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
                            cardWrongMap[key] = { english: r.english, chinese: r.senseText || r.chinese, line: r.line || '', count: 0 };
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
                    <input type="checkbox" checked value="${escapeHTML(w.english)}" data-line="${escapeHTML(w.line || '')}"> 
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
            let fullLine = (chk.getAttribute('data-line') || '').trim() || wordText;
            let currentContent = wordLists[targetListIdx].content || '';
            let exists = parseWordsRaw(currentContent).some(w => w.english.toLowerCase() === wordText.toLowerCase());
            if (!exists) {
                if (getListWordCount(currentContent) >= getListWordCap(wordLists[targetListIdx])) { skippedFull++; return; }
                wordLists[targetListIdx].content = currentContent + (currentContent ? '\n' : '') + fullLine;
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
            examRepeatCount: document.getElementById('examRepeatCount').value,
            examVoiceChi: document.getElementById('examVoiceChi').checked
        };
        localStorage.setItem('dictation_exam_app_settings', JSON.stringify(settings));
    }

    function loadExamAppSettings() {
        let saved = localStorage.getItem('dictation_exam_app_settings');
        if (saved) {
            let s = JSON.parse(saved);
            if (s.examOnlyStarred !== undefined) document.getElementById('examOnlyStarred').checked = s.examOnlyStarred;
            if (s.examVoiceChi !== undefined) document.getElementById('examVoiceChi').checked = !!s.examVoiceChi;
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

    // 測試密碼：testreset 大冒險回到第一次開 App 的狀態；testmoney 送測試用的道具
    function advRunTestCode(code) {
        code = String(code || '').trim().toLowerCase();
        if (code === 'testreset') {
            if (!confirm('⚠️ 要把雞塊大冒險的進度、道具、裝備、能力全部重設成第一次開 App 的狀態嗎？')) return true;
            try { localStorage.removeItem(advStoreKey()); } catch (e) {}
            advData = advLoad();
            advData.ts = Date.now();
            advSave();
            try { advRefreshViews(); } catch (e) {}
            alert('🔄 雞塊大冒險已重設。');
            return true;
        }
        if (code === 'testmoney') {
            advData.shards += 500;
            advData.sauce += 50; advData.tickets += 50; advData.potions += 50; advData.wipes += 50;
            advSave();
            try { advRefreshViews(); advRenderShopBox(); } catch (e) {}
            alert('💰 已送出：糖醋醬碎片 +500、糖醋醬／冒險卷／恢復藥水／濕紙巾各 +50');
            return true;
        }
        return false;
    }
    function advRunTestCodeInput() {
        let el = document.getElementById('devTestCodeInput');
        if (!el) return;
        if (!advRunTestCode(el.value)) alert('❌ 沒有這個測試密碼');
        el.value = '';
    }
    function verifyDevPassword() {
          if (advRunTestCode(document.getElementById('devPasswordInput').value)) { document.getElementById('devPasswordInput').value = ''; return; }
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
    const ADV_STORE = 'chicky_adv_data';          // 沒登入 Google：離線進度
    const ADV_STORE_G = 'chicky_adv_data_g';      // 登入 Google：雲端進度（本機暫存，會同步到 Google 雲端）
    function advIsGoogleMode() { try { return localStorage.getItem('chicky_google_linked') === '1'; } catch (e) { return false; } }
    function advStoreKey() { return advIsGoogleMode() ? ADV_STORE_G : ADV_STORE; }
    const ADV_SEL_KEY = 'chicky_adv_selected';
    const ADV_BASE_STATS = { hp: 3, atk: 0, agi: 3, def: 0, int: 1, luck: 0 };
    const ADV_MOVES_SHOWN = 4;               // 招式選擇一開始只顯示幾張，其餘收在「更多招式」
    let advMovesOpen = false;
    const ADV_REPLAY_PER_DAY = 3;           // 每天最多重複挑戰「已通關的關卡」幾次（沒通關的關卡不限次數）
    const ADV_UP_MAX = 10;
    const ADV_SHARDS_PER_SAUCE = 15;        // 15 個碎片 → 1 瓶糖醋醬
    const ADV_TOTAL_LEVELS = 20;
    const ADV_CHAPTERS = [
        { id: 1, from: 1, to: 10, name: '夜市' },
        { id: 2, from: 11, to: 20, name: '便利商店' }
    ];
    const ADV_WIPE_COST = 5;                // 濕紙巾：5 個碎片
    const ADV_HIT_N = 20;                   // 命中：看最近 20 題
    const ADV_HANDS = ['左手', '右手'];      // 兩個裝備欄
    // 裝備的稀有度（邊框顏色跟招式一樣：灰＝普通、深金＝稀有、亮紫＝傳說）
    const ADV_ITEM_RARITY = { boba: 'common', tofu: 'common', skewer: 'rare', bill: 'common', bag: 'common', soda: 'common' };
    function advItemRarityKey(k) { return ADV_ITEM_RARITY[k] || 'common'; }
    const ADV_SAUCE_COLOR = '#EE8F78';      // 糖醋醬的顏色（碎片圖示也用這個顏色）
    const ADV_POTION_HEAL = 5, ADV_POTION_COST = 5;     // 恢復藥水：1 個碎片 → HP +5
    const ADV_WEEKLY_SHARDS = 100, ADV_WEEKLY_CHICKENS = 2;   // 每週一次：100 碎片 → 2 雞塊
    const ADV_MAX_EQUIP = 4;
    const ADV_MIN_EQUIP = 3;                // 至少要帶 3 招
    const ADV_BASE_SECS = 15;               // 每題作答時間（秒）
    const ADV_LUCK_CAP = 3;                 // 幸運擲幣的加成最多 +3

    // 招式
    //   type：card 字卡 / listen 聽力 / speak 朗讀（用來決定這招需要什麼條件）
    //   mode：choice 選擇題 / typeCn 輸入中文 / listenChoice 聽音選英文 / listenCn 聽英文選中文 / listenSpell 聽音拼英文 / speak 朗讀
    //   power：每一下的威力；hits：打幾下（每一下各自扣掉對方防禦）；q：要連續答對幾題
    //   buy：free 一開始就有 / shards 用碎片買 / chicken 用雞塊買（item 是商店商品代號）
    // 招式圖示（SVG，會跟著文字大小縮放）
    const advSvg = (vb, inner) => `<svg viewBox="${vb}" width="1.2em" height="1.2em" style="vertical-align:-0.22em;overflow:visible" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${inner}</svg>`;
    // 斬擊、連續斬擊共用的那把劍
    const advSword = (r) => `<g transform="rotate(${r} 12 12)"><path d="M 12 1 L 14.2 4 V 15 H 9.8 V 4 Z" fill="#E2E8F0" stroke="#475569" stroke-width="1.2" stroke-linejoin="round"/><path d="M 12 3 V 14" stroke="#FFFFFF" stroke-width="1"/><rect x="7.5" y="15" width="9" height="2.4" rx="1" fill="#F59E0B" stroke="#92400E" stroke-width="1"/><rect x="10.8" y="17.4" width="2.4" height="4.6" fill="#92400E"/></g>`;
    const ADV_ICONS = {
        combo: () => { const c = (x, y, o) => `<g opacity="${o}"><ellipse cx="${x}" cy="${y}" rx="10" ry="10" fill="#F4A236" stroke="#231F20" stroke-width="2.2"/><circle cx="${x - 3.5}" cy="${y - 1.5}" r="1.5" fill="#231F20"/><circle cx="${x + 3.5}" cy="${y - 1.5}" r="1.5" fill="#231F20"/><path d="M ${x - 2.5} ${y + 3} Q ${x} ${y + 5} ${x + 2.5} ${y + 3}" stroke="#231F20" stroke-width="1.5" fill="none" stroke-linecap="round"/></g>`; return advSvg('0 0 52 28', `<path d="M 2 9 H 7 M 0 15 H 6 M 2 21 H 7" stroke="#94A3B8" stroke-width="2" stroke-linecap="round"/>${c(18, 14, 0.5)}${c(36, 14, 1)}<path d="M 44 4 l 4 -3 M 46 8 l 5 -1" stroke="#EF4444" stroke-width="2" stroke-linecap="round"/>`); },
        slash: () => advSvg('0 0 24 24', advSword(42)),
        slash2: () => { const sw = advSword; return advSvg('0 0 24 24', sw(-42) + sw(42)); },
        _old_slash2: () => { const sw = (r) => `<g transform="rotate(${r} 12 12)"><path d="M 12 1 L 14.2 4 V 15 H 9.8 V 4 Z" fill="#E2E8F0" stroke="#475569" stroke-width="1.2" stroke-linejoin="round"/><path d="M 12 3 V 14" stroke="#FFFFFF" stroke-width="1"/><rect x="7.5" y="15" width="9" height="2.4" rx="1" fill="#F59E0B" stroke="#92400E" stroke-width="1"/><rect x="10.8" y="17.4" width="2.4" height="4.6" fill="#92400E"/></g>`; return advSvg('0 0 24 24', sw(-42) + sw(42)); },
        wave2: () => { const cm = (y) => `<path d="M 0 ${y} Q 16 ${y - 6} 36 ${y - 4} L 36 ${y + 4} Q 16 ${y + 6} 0 ${y} Z" fill="#38BDF8" opacity="0.65"/><path d="M 8 ${y} Q 20 ${y - 3} 36 ${y - 2} L 36 ${y + 2} Q 20 ${y + 3} 8 ${y} Z" fill="#E0F2FE"/><circle cx="39" cy="${y}" r="6" fill="#7DD3FC" opacity="0.7"/><circle cx="39" cy="${y}" r="3.6" fill="#FFFFFF"/>`; return advSvg('0 0 48 30', cm(8) + cm(22)); },
        wave3: () => advSvg('0 0 52 30', '<circle cx="9" cy="15" r="10" fill="#FDE047" opacity="0.55"/><circle cx="9" cy="15" r="6.5" fill="#FACC15" stroke="#F59E0B" stroke-width="1.5"/><circle cx="9" cy="15" r="3" fill="#FFFFFF"/><path d="M 14 8 L 30 9 L 34 5 L 38 9 L 44 8 L 51 15 L 44 22 L 38 21 L 34 25 L 30 21 L 14 22 Z" fill="#FACC15" stroke="#F59E0B" stroke-width="1.3" stroke-linejoin="round"/><path d="M 15 12 H 46 L 49 15 L 46 18 H 15 Z" fill="#FFFFFF" opacity="0.9"/>')
    };
    // 招式說明只寫「怎麼答」：類型、題數、威力在畫面上已經有了
    const ADV_LEGEND_PRICE = 25;            // 傳說招式：補給站 25 個碎片
    const ADV_MOVES = [
        { key: 'tackle',  name: '衝撞',         icon: '💥', type: 'card',   mode: 'choice',      fx: 'dash',   power: 1, hits: 1, q: 1, tries: 1, buy: { kind: 'free' },                                              desc: '選出正確的中文意思' },
        { key: 'combo',   name: '連續衝撞',     icon: ADV_ICONS.combo(), type: 'card',   mode: 'choice',      fx: 'dash',   power: 1, hits: 2, q: 3, tries: 1, buy: { kind: 'reward', level: 3 },                         desc: '選擇題' },
        { key: 'charge',  name: '衝鋒撞擊',     icon: '🐗', type: 'card',   mode: 'typeCn',      fx: 'charge', power: 3, hits: 1, q: 2, tries: 1, buy: { kind: 'shards', price: ADV_LEGEND_PRICE, item: 'mv_charge' }, desc: '輸入中文意思' },
        { key: 'slash',   name: '斬擊',         icon: ADV_ICONS.slash(), type: 'listen', mode: 'listenChoice', fx: 'slash',  power: 2, hits: 1, q: 1, tries: 1, buy: { kind: 'free' },                                       desc: '聽發音，選出正確的單字' },
        { key: 'slash2',  name: '連續斬擊',     icon: ADV_ICONS.slash2(), type: 'listen', mode: 'listenCn',     fx: 'slash',  power: 2, hits: 2, q: 3, tries: 1, buy: { kind: 'reward', level: 4, item: 'mv_slash2' },       desc: '聽英文，選中文' },
        { key: 'thrust',  name: '突刺',         icon: '🔱', type: 'listen', mode: 'listenSpell',  fx: 'thrust', power: 3, hits: 1, q: 2, tries: 1, buy: { kind: 'shards', price: ADV_LEGEND_PRICE, item: 'mv_thrust' }, desc: '聽發音，拼出英文單字' },
        { key: 'wave',    name: '衝擊波',       icon: '🌊', type: 'speak',  mode: 'speak',        fx: 'wave',   power: 2, hits: 1, q: 1, tries: 2, buy: { kind: 'free' },                                       desc: '按住麥克風唸出單字' },
        { key: 'wave2',   name: '雙重衝擊波',   icon: ADV_ICONS.wave2(), type: 'speak',  mode: 'speak',        fx: 'wave',   power: 2, hits: 2, q: 2, tries: 2, buy: { kind: 'reward', level: 5, item: 'mv_wave2' },        desc: '按住麥克風唸出單字' },
        { key: 'wave3',   name: '雞塊氣功波',   icon: ADV_ICONS.wave3(), type: 'speak',  mode: 'speakCn',      fx: 'yellow', power: 3, hits: 1, q: 2, tries: 2, buy: { kind: 'shards', price: ADV_LEGEND_PRICE, item: 'mv_wave3' }, desc: '顯示中文，唸英文' }
    ];
    const ADV_TYPE_LABEL = { card: '字卡', listen: '聽力', speak: '朗讀' };
    // 稀有度：普通（灰框，熟練度上限 1）／稀有（深金框，上限 2）／傳說（亮紫框，上限 3）
    const ADV_RARITY = {
        common: { label: '普通', color: '#94A3B8', cap: 1 },
        rare:   { label: '稀有', color: '#B8860B', cap: 2 },
        legend: { label: '傳說', color: '#C026D3', cap: 3 }
    };
    const ADV_MOVE_RARITY = { tackle: 'common', slash: 'common', wave: 'common', combo: 'rare', slash2: 'rare', wave2: 'rare', charge: 'legend', thrust: 'legend', wave3: 'legend' };
    // 熟練度：累積使用 20 次 → 1、100 次 → 2、300 次 → 3（不超過稀有度上限）；每 1 級這招攻擊 +1
    const ADV_MASTERY_STEPS = [20, 100, 300];
    function advRarity(key) { return ADV_RARITY[ADV_MOVE_RARITY[key] || 'common']; }
    function advRarityKey(key) { return ADV_MOVE_RARITY[key] || 'common'; }
    function advMasteryInfo(key) {
        let uses = Math.max(0, parseInt((advData.mastery || {})[key]) || 0);
        let cap = advRarity(key).cap, lvl = 0;
        while (lvl < cap && uses >= ADV_MASTERY_STEPS[lvl]) lvl++;
        let maxed = lvl >= cap;
        return { uses, lvl, cap, maxed, next: maxed ? null : ADV_MASTERY_STEPS[lvl], prev: lvl ? ADV_MASTERY_STEPS[lvl - 1] : 0 };
    }
    function advMastery(key) { return advMasteryInfo(key).lvl; }
    // 用了一次招式：回傳「升級後的等級」，沒升級回傳 0
    function advAddMasteryUse(key) {
        if (!advData.mastery) advData.mastery = {};
        let before = advMastery(key);
        advData.mastery[key] = (parseInt(advData.mastery[key]) || 0) + 1;
        let after = advMastery(key);
        return after > before ? after : 0;
    }
    const ADV_DEFAULT_EQUIP = ['tackle', 'slash', 'wave'];
    function advMoveByKey(k) { return ADV_MOVES.find(m => m.key === k); }

    // 關卡：firstShards/firstSauce = 第一次通關的獎勵；repeatShards = 之後每次通關的獎勵
    //   special：stink 發臭（玩家的招式失敗時，無視防禦反擊 1 點）／heal 治癒（敵人攻擊結束時回 1 點體力）
    const ADV_LEVELS = [
        { id: 1, name: '貢丸',     sprite: 'meatball', minWords: 10, hp: 3,  atk: 1, agi: 1, def: 0, luck: 0, moveName: '彈跳撞擊', movePower: 0, firstShards: 1, firstSauce: 0, repeatShards: 1, firstMaxHp: 1, firstPotions: 1, firstItem: 'bag', special: '' },
        { id: 2, name: '烤玉米',   sprite: 'corn',     minWords: 15, hp: 4,  atk: 1, agi: 0, def: 1, luck: 0, moveName: '玉米粒連射', movePower: 0, firstShards: 1, firstSauce: 0, repeatShards: 1, firstMaxHp: 1, firstPotions: 1, special: '' },
        { id: 3, name: '蚵仔煎',   sprite: 'oyster',   minWords: 20, hp: 5,  atk: 2, agi: 1, def: 0, luck: 0, moveName: '黏稠甩擊', movePower: 0, firstShards: 2, firstSauce: 0, repeatShards: 1, firstMaxHp: 1, firstPotions: 1, special: '' },
        { id: 4, name: '臭豆腐',   sprite: 'tofu',     minWords: 20, hp: 7,  atk: 1, agi: 0, def: 1, luck: 0, moveName: '酸臭衝撞', movePower: 0, firstShards: 3, firstSauce: 0, repeatShards: 2, firstPotions: 2, firstItem: 'tofu', special: 'stink' },
        { id: 5, name: '珍珠奶茶', sprite: 'boba',     minWords: 30, hp: 10, atk: 2, agi: 0, def: 1, luck: 0, moveName: '珍珠連射', movePower: 0, firstShards: 0, firstSauce: 1, repeatShards: 2, firstPotions: 2, firstTickets: 1, firstItem: 'boba', special: 'heal' },
        { id: 6, name: '娃娃機',   sprite: 'claw',     minWords: 30, hp: 12, atk: 2, agi: 0, def: 2, int: 0, luck: 1, moveName: '夾子抓抓', movePower: 0, firstShards: 3, firstSauce: 0, repeatShards: 3, firstPotions: 1, firstTickets: 1, special: 'claw' },
        { id: 7, name: '射飛鏢',   sprite: 'darts',    minWords: 40, hp: 13, atk: 2, agi: 2, def: 1, int: 0, luck: 1, moveName: '飛鏢連射', movePower: 0, firstShards: 5, firstSauce: 0, repeatShards: 3, firstPotions: 1, special: 'darts' },
        { id: 8, name: '夜市麻將', sprite: 'mahjong',  minWords: 40, hp: 13, atk: 2, agi: 1, def: 2, int: 3, luck: 3, moveName: '自摸', movePower: 0, firstShards: 5, firstSauce: 0, repeatShards: 3, firstPotions: 1, special: 'mahjong' },
        { id: 9, name: '套圈圈',   sprite: 'ring',     minWords: 50, hp: 15, atk: 3, agi: 3, def: 0, int: 0, luck: 1, moveName: '圈圈投擲', movePower: 0, firstShards: 5, firstSauce: 0, repeatShards: 4, firstPotions: 1, firstTickets: 1, special: 'ring' },
        { id: 10, name: '彈珠台',  sprite: 'pinball',  minWords: 50, hp: 15, atk: 4, agi: 1, def: 2, int: 1, luck: 6, moveName: '彈珠發射', movePower: 0, firstShards: 0, firstSauce: 1, repeatShards: 5, firstPotions: 2, firstTickets: 2, special: 'pinball' },
        // ── 第二章：便利商店 ──
        { id: 11, name: '茶葉蛋',   sprite: 'egg',     minWords: 60, hp: 17, atk: 3, agi: 3, def: 2, int: 6, luck: 2, moveName: '滾燙蛋汁', movePower: 0, firstShards: 5, firstSauce: 0, repeatShards: 5, firstPotions: 1, special: 'egg' },
        { id: 12, name: '大亨堡',   sprite: 'bun',     minWords: 60, hp: 8,  atk: 3, agi: 2, def: 3, int: 9, luck: 2, moveName: '麵包夾擊', movePower: 0, firstShards: 5, firstSauce: 0, repeatShards: 5, firstPotions: 1, firstItem: 'skewer', special: 'bun',
          phases: [
              { name: '大亨堡', sprite: 'bun',    hp: 8, atk: 3, agi: 2, def: 3, int: 9, luck: 2, moveName: '麵包夾擊', special: 'bun' },
              { name: '熱狗',   sprite: 'hotdog', hp: 7, atk: 5, agi: 4, def: 2, int: 3, luck: 4, moveName: '熱油噴射', special: 'hotdog' }
          ] },
        { id: 13, name: '御飯糰',   sprite: 'onigiri', minWords: 70, hp: 15, atk: 5, agi: 3, def: 3, int: 9, luck: 3, shield: 12, moveName: '海苔捲擊', movePower: 0, firstShards: 5, firstSauce: 0, repeatShards: 6, firstPotions: 1, special: 'wrap' },
        { id: 14, name: '瓶裝無糖茶', sprite: 'tea',   minWords: 70, hp: 18, atk: 5, agi: 3, def: 4, int: 9, luck: 0, moveName: '冰鎮茶柱', movePower: 0, firstShards: 5, firstSauce: 0, repeatShards: 6, firstPotions: 2, special: 'tea' },
        { id: 15, name: 'ibon',   sprite: 'ibon',    minWords: 70, hp: 25, atk: 6, agi: 2, def: 7, int: 9, luck: -2, moveName: '列印繳費單', movePower: 0, firstShards: 0, firstSauce: 1, repeatShards: 6, firstPotions: 1, firstTickets: 3, firstItem: 'bill', potionChance: 0.2, special: 'seal' },
        { id: 16, name: '盒裝沙拉', sprite: 'salad',  minWords: 80, hp: 22, atk: 5, agi: 5, def: 3, int: 10, luck: 3, moveName: '生菜甩擊', movePower: 0, firstShards: 6, firstSauce: 0, repeatShards: 6, firstPotions: 1, firstTickets: 1, special: 'salad' },
        { id: 17, name: '微波爐',   sprite: 'microwave', minWords: 80, hp: 25, atk: 5, agi: 1, def: 6, int: 1, luck: 1, moveName: '叮！加熱', movePower: 0, firstShards: 6, firstSauce: 0, repeatShards: 6, firstPotions: 1, firstTickets: 1, special: 'microwave' },
        { id: 18, name: '微波便當', sprite: 'bento',  minWords: 90, hp: 20, atk: 3, agi: 3, def: 3, int: 9, luck: 2, moveName: '便當蓋飛擊', movePower: 0, firstShards: 7, firstSauce: 0, repeatShards: 6, firstPotions: 1, firstTickets: 1, special: 'bento',
          phases: [
              { name: '微波便當',   sprite: 'bento',  hp: 20, atk: 3, agi: 3, def: 3, int: 9, luck: 2, moveName: '便當蓋飛擊', special: 'bento' },
              { name: '愛珍食便當', sprite: 'bento2', hp: 40, atk: 7, agi: 6, def: 2, int: 6, luck: 6, moveName: '即期大反撲', special: 'expire' }
          ] }
    ];
    // 這些敵人對某一類招式有抗性：每一下最多只受到 1 點傷害
    const ADV_RESIST = { darts: 'listen', mahjong: 'card', ring: 'speak', hotdog: 'listen', tea: 'speak' };
    // 這些敵人完全不受某一類招式的傷害
    const ADV_IMMUNE = { salad: 'card', microwave: 'listen' };
    const ADV_WEAK_BONUS = { expire: { type: 'speak', bonus: 4 } };   // 愛珍食便當：朗讀類每一下 +4
    const ADV_MICRO_ATK_UP = 2;             // 微波爐：每次攻擊後攻擊力 +2
    const ADV_EXPIRE_SELF = 4;              // 愛珍食便當：攻擊完自己扣 4 點體力
    const ADV_EGG_CARD_BONUS = 2;           // 茶葉蛋：字卡類招式每一下傷害 +2
    // 裝備道具（裝備欄同時只能放 1 個，沒裝備的道具放在背包）
    const ADV_ITEMS = {
        boba: { name: '快喝光的珍珠奶茶', icon: (s) => `<span style="font-size:${s}px;line-height:1">🧋</span>`, desc: '一場戰鬥限用 1 次：HP 剩 3 以下可以喝，HP +1' },
        tofu: { name: '烤焦臭豆腐', icon: (s) => advTofuIcon(s), desc: '自己的招式失敗時，雙方各扣 1 點體力（無視防禦）' },
        skewer: { name: '竹籤', icon: (s) => advSkewerIcon(s), desc: '攻擊無視對方的護盾，直接扣體力' },
        bill: { name: '繁瑣的繳費單', icon: (s) => advBillIcon(s), desc: '？？？' },
        bag: { name: '夜市塑膠袋', icon: (s) => advPlasticBagIcon(s), desc: '每場戰鬥開始時護盾 +1' },
        soda: { name: '彈珠汽水', icon: (s) => advSodaIcon(s), desc: '戰鬥勝利後 HP +1' }
    };
    const ADV_SODA_PRICE = 2;               // 補給站：彈珠汽水 2 個碎片
    const ADV_BAG_SHIELD = 1;               // 夜市塑膠袋：護盾 +1
    function advPlasticBagIcon(size) {
        size = size || 24;
        return `<svg width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true" style="vertical-align:-4px;overflow:visible"><path d="M9 10 Q9 3 12.5 3 Q15 3 15 10 M17 10 Q17 3 19.5 3 Q23 3 23 10" stroke="#DC2626" stroke-width="2.2" fill="none" stroke-linecap="round"/><path d="M5 10 H27 L25 28 Q25 30 23 30 H9 Q7 30 7 28 Z" fill="#FFFFFF" stroke="#DC2626" stroke-width="2" stroke-linejoin="round"/><path d="M8 14 H24" stroke="#DC2626" stroke-width="1.6"/><text x="16" y="25" font-size="8" font-weight="900" text-anchor="middle" fill="#DC2626" font-family="'Noto Sans TC','PingFang TC','Microsoft JhengHei',sans-serif">謝謝</text></svg>`;
    }
    function advSodaIcon(size) {
        size = size || 24;
        return `<svg width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true" style="vertical-align:-4px;overflow:visible"><rect x="13" y="1.5" width="6" height="4" rx="1.2" fill="#2563EB" stroke="#1E3A8A" stroke-width="1"/><path d="M13 5.5 H19 V9 Q22 11 22 14 Q22 16 20 17 Q22 18 23 21 V27 Q23 30 20 30 H12 Q9 30 9 27 V21 Q10 18 12 17 Q10 16 10 14 Q10 11 13 9 Z" fill="#7DD3FC" stroke="#0369A1" stroke-width="1.6" stroke-linejoin="round" opacity="0.95"/><circle cx="16" cy="13.5" r="2.6" fill="#E0F2FE" stroke="#0369A1" stroke-width="1"/><circle cx="13" cy="24" r="1" fill="#FFFFFF"/><circle cx="17" cy="26" r="0.8" fill="#FFFFFF"/><circle cx="19" cy="22" r="1.1" fill="#FFFFFF"/><path d="M12 20 Q10.5 23 11 26" stroke="#FFFFFF" stroke-width="1.2" fill="none" stroke-linecap="round" opacity="0.8"/></svg>`;
    }
    function advSkewerIcon(size) {
        size = size || 24;
        return `<svg width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true" style="vertical-align:-4px;overflow:visible"><path d="M5 28 L26 4" stroke="#B45309" stroke-width="4.2" stroke-linecap="round"/><path d="M5 28 L26 4" stroke="#FCD34D" stroke-width="2" stroke-linecap="round"/><path d="M24.5 5.5 L28 2" stroke="#92400E" stroke-width="2.4" stroke-linecap="round"/><path d="M11 21 l2 2 M16 15.5 l2 2" stroke="#92400E" stroke-width="1.4" stroke-linecap="round"/></svg>`;
    }
    function advBillIcon(size) {
        size = size || 24;
        return `<svg width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true" style="vertical-align:-4px;overflow:visible"><path d="M7 3 H25 V29 L22 27 L19 29 L16 27 L13 29 L10 27 L7 29 Z" fill="#FFFFFF" stroke="#475569" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 8 H22 M10 12 H22 M10 16 H18" stroke="#94A3B8" stroke-width="1.6" stroke-linecap="round"/><path d="M10 20 v4 M12 20 v4 M13.5 20 v4 M16 20 v4 M17.5 20 v4 M20 20 v4 M22 20 v4" stroke="#0F172A" stroke-width="1"/><circle cx="23" cy="9" r="3.6" fill="#EF4444" opacity="0.85"/><text x="23" y="11" font-size="5.5" font-weight="900" text-anchor="middle" fill="#FFFFFF">!</text></svg>`;
    }
    function advTicketIcon(size) {
        size = size || 24;
        return `<svg width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true" style="vertical-align:-4px;overflow:visible"><path d="M3 9 Q3 7 5 7 H27 Q29 7 29 9 V12.5 Q26.5 13 26.5 16 Q26.5 19 29 19.5 V23 Q29 25 27 25 H5 Q3 25 3 23 V19.5 Q5.5 19 5.5 16 Q5.5 13 3 12.5 Z" fill="#F97316" stroke="#9A3412" stroke-width="1.6"/><path d="M21 8 V24" stroke="#FED7AA" stroke-width="1.4" stroke-dasharray="2 2"/><path d="M9 13 L11 16 L9 19 M13 13 L15 16 L13 19" stroke="#FFFFFF" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="25" cy="16" r="1.6" fill="#FFFFFF"/></svg>`;
    }
    function advWipeIcon(size) {
        size = size || 24;
        return `<svg width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true" style="vertical-align:-4px;overflow:visible"><rect x="3" y="8" width="26" height="18" rx="5" fill="#38BDF8" stroke="#075985" stroke-width="1.6"/><path d="M9 8 Q9 5 12 5 H20 Q23 5 23 8 V13 Q23 15 21 15 H11 Q9 15 9 13 Z" fill="#0EA5E9" stroke="#075985" stroke-width="1.4"/><path d="M12 10 Q16 7 20 10" stroke="#FFFFFF" stroke-width="1.6" fill="none" stroke-linecap="round"/><path d="M8 21 Q11 18 14 21 T20 21 T26 21" stroke="#E0F2FE" stroke-width="1.6" fill="none" stroke-linecap="round"/><circle cx="25" cy="11" r="1.4" fill="#FFFFFF"/></svg>`;
    }
    function advTofuIcon(size) {
        size = size || 24;
        return `<svg width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true" style="vertical-align:-4px;overflow:visible"><path d="M9 7 Q7 4 9 1 M16 7 Q14 4 16 1 M23 7 Q21 4 23 1" stroke="#84CC16" stroke-width="2" fill="none" stroke-linecap="round"/><rect x="4" y="9" width="24" height="20" rx="5" fill="#3F2A1D" stroke="#1C1009" stroke-width="2"/><rect x="8" y="13" width="16" height="12" rx="3" fill="#6B3E1F"/><circle cx="11" cy="17" r="1.4" fill="#1C1009"/><circle cx="20" cy="21" r="1.4" fill="#1C1009"/><path d="M13 23 l3 -4 l3 4" stroke="#F97316" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>`;
    }
    const ADV_SPECIAL_TEXT = {
        stink: '發臭：你的招式失敗時，會被臭味反擊，無視防禦扣 1 點體力',
        heal: '治癒：每次攻擊結束後，會回復 1 點體力',
        claw: '送你娃娃！',
        darts: '咻咻咻！',
        mahjong: '摸牌！',
        ring: '我要套那個娃娃！',
        pinball: '打彈珠！',
        egg: '請幫我剝殼 ❤️',
        bun: '熱狗',
        wrap: '拆不掉的包裝',
        tea: '現泡就是回甘！',
        seal: '取票失敗！',
        salad: '讓我來照顧你！',
        microwave: '轉吧！美味雞塊！',
        bento: '月底救星！',
        expire: '我快過期了..'
    };

    function advLoad() {
        let d = {};
        try { d = JSON.parse(localStorage.getItem(advStoreKey())) || {}; } catch (e) { d = {}; }
        let up = d.up || {};
        let clampUp = v => Math.max(0, Math.min(ADV_UP_MAX, parseInt(v) || 0));
        let n0 = v => Math.max(0, parseInt(v) || 0);
        let hasShards = d.shards !== undefined;
        let hp = parseInt(d.hp);
        let own = {};
        if (d.own && typeof d.own === 'object') ADV_MOVES.forEach(m => { if (d.own[m.key] === true) own[m.key] = true; });
        let eq = Array.isArray(d.eq) ? d.eq.filter(k => !!advMoveByKey(k)) : ADV_DEFAULT_EQUIP.slice();
        eq = eq.filter((k, i) => eq.indexOf(k) === i).slice(0, ADV_MAX_EQUIP);
        ADV_MOVES.forEach(m => { if (m.buy.kind === 'reward' && d.cleared && d.cleared[String(m.buy.level)]) own[m.key] = true; });   // 關卡送的招式（舊存檔也補發）
        let items = {};
        if (d.items && typeof d.items === 'object') Object.keys(ADV_ITEMS).forEach(k => { if (d.items[k] === true) items[k] = true; });
        if (d.cleared && d.cleared['1']) items.bag = true;      // 打贏貢丸送夜市塑膠袋（舊存檔也補發）
        if (d.cleared && d.cleared['4']) items.tofu = true;     // 打贏臭豆腐送烤焦臭豆腐（舊存檔也補發）
        if (d.cleared && d.cleared['5']) items.boba = true;     // 打贏珍珠奶茶送快喝光的珍珠奶茶
        if (d.cleared && d.cleared['12']) items.skewer = true;  // 打贏大亨堡（熱狗）送竹籤
        if (d.cleared && d.cleared['15']) items.bill = true;    // 打贏 IBON 機送繁瑣的繳費單
        let mastery = {};
        if (d.mastery && typeof d.mastery === 'object') ADV_MOVES.forEach(m => { let v = parseInt(d.mastery[m.key]); if (v > 0) mastery[m.key] = v; });
        return {
            items: items,                                       // 擁有的裝備道具
            gear: (() => {                                      // 裝備欄：[左手, 右手]
                let g = Array.isArray(d.gear) ? d.gear : [];
                g = [0, 1].map(i => (typeof g[i] === 'string' && items[g[i]]) ? g[i] : '');
                if (!g[0] && !g[1] && typeof d.equip === 'string' && items[d.equip]) g[0] = d.equip;   // 舊版只有一格
                if (g[0] && g[0] === g[1]) g[1] = '';
                return g;
            })(),
            hits: (() => {                                      // 命中：最近 20 題答對(1)／答錯(0)
                let hz = (d.hits && typeof d.hits === 'object') ? d.hits : {};
                const arr = a => Array.isArray(a) ? a.filter(v => v === 0 || v === 1).slice(-ADV_HIT_N) : [];
                return { card: arr(hz.card), listen: arr(hz.listen), speak: arr(hz.speak), all: arr(hz.all) };
            })(),
            hitPrev: Number.isFinite(d.hitPrev) ? d.hitPrev : null,
            shards: hasShards ? n0(d.shards) : n0(d.sauce),     // 舊版把碎片叫「糖醋醬」，改名後數量轉成碎片
            sauce: hasShards ? n0(d.sauce) : 0,
            cleared: (d.cleared && typeof d.cleared === 'object') ? d.cleared : {},
            up: { hp: clampUp(up.hp), atk: clampUp(up.atk), agi: clampUp(up.agi), def: clampUp(up.def), int: clampUp(up.int), luck: clampUp(up.luck) },
            hp: Number.isFinite(hp) ? hp : null,
            hpDay: typeof d.hpDay === 'string' ? d.hpDay : '',
            own: own,                     // 用碎片買到的招式
            eq: eq,                       // 目前裝備的招式（最多 4 招）
            potions: n0(d.potions),
            tickets: n0(d.tickets),                                        // 冒險卷：今天的重複挑戰次數 +1
            wipes: n0(d.wipes),                                            // 濕紙巾：把 1 點能力轉到另一項
            replayBonusDay: typeof d.replayBonusDay === 'string' ? d.replayBonusDay : '',
            replayBonus: n0(d.replayBonus),                                // 今天用冒險卷多出來的次數
            mastery: mastery,                                              // 每招累積使用次數（熟練度）
            weekDone: typeof d.weekDone === 'string' ? d.weekDone : '',    // 最近一次「碎片換雞塊」是哪一週
            replayDay: typeof d.replayDay === 'string' ? d.replayDay : '', // 重複挑戰次數是哪一天的
            replays: n0(d.replays),
            loginShardDay: typeof d.loginShardDay === 'string' ? d.loginShardDay : '',   // 每日登入碎片最後領取日
            ts: n0(d.ts),                                                  // 最後存檔時間（雲端同步用）
            owner: typeof d.owner === 'string' ? d.owner : ''              // 這份進度屬於哪個 Google 帳號（錢包代號）
        };
    }
    // 更新前就已登入 Google 的人：第一次把原本的進度複製成「Google 進度」，不會憑空消失
    try {
        if (advIsGoogleMode() && localStorage.getItem(ADV_STORE_G) === null && localStorage.getItem(ADV_STORE) !== null)
            localStorage.setItem(ADV_STORE_G, localStorage.getItem(ADV_STORE));
    } catch (e) {}
    let advData = advLoad();
    setTimeout(() => { try { homeAdvBadge(); } catch (e) {} }, 0);
    let advCloudReady = false, advCloudTimer = null, advDirty = false;   // advDirty：Google 進度有還沒上傳的變更
    function advSave(keepTs) {      // keepTs：只是每天體力重置這類自動整理，不算「新的進度」，不改存檔時間、也不上傳
        try { setTimeout(homeAdvBadge, 0); } catch (e) {}
        if (!keepTs) advData.ts = Date.now();
        if (advIsGoogleMode() && !advData.owner && typeof cloudWalletKey === 'string' && cloudWalletKey) advData.owner = cloudWalletKey;
        try { localStorage.setItem(advStoreKey(), JSON.stringify(advData)); } catch (e) {}
        if (keepTs) return;
        if (advIsGoogleMode()) advDirty = true;
        advQueueCloud();
    }
    // 登入 Google 時，進度存檔後稍等一下再上傳（連續存檔只上傳一次）
    function advQueueCloud() {
        if (!advIsGoogleMode() || !accessToken || !isCloudSyncActive || !advCloudReady) return;
        clearTimeout(advCloudTimer);
        advCloudTimer = setTimeout(() => { triggerAutoSaveToCloud(); }, 2500);
    }
    // 登入／登出時切換進度：離線一份、Google 一份，互不影響
    function advSwitchStore() {
        try { advAbort(); } catch (e) {}
        advCloudReady = false; advDirty = false;
        advData = advLoad();
        advSyncDaily();
        try { advRefreshViews(); } catch (e) {}
    }
    function advRefreshViews() {
        if (document.getElementById('advStatsBox')) advRenderStatsPage();
        if (document.getElementById('advLevelCard')) advRenderLevelPage();
        advRenderShopBox();
    }
    // 從 Google 雲端載入進度：以「最後存檔時間」較新的為準；不同 Google 帳號的進度不會混在一起
    function advMergeFromCloud(c, cloudOwner) {
        let local = advData;
        let mismatch = !!(cloudOwner && local.owner && local.owner !== cloudOwner);
        if (c && typeof c === 'object') {
            let cts = parseInt(c.ts) || 0;
            if (mismatch || cts > local.ts) {
                try { localStorage.setItem(ADV_STORE_G, JSON.stringify(c)); } catch (e) {}
                advData = advLoad();
                if (cloudOwner && !advData.owner) advData.owner = cloudOwner;
                advSyncDaily();
                advRefreshViews();
                return false;                    // 不用再上傳
            }
            return cts < local.ts;               // 本機比較新 → 要上傳
        }
        if (mismatch) {                          // 雲端是另一個帳號、沒有進度：本機暫存不能沿用
            try { localStorage.removeItem(ADV_STORE_G); } catch (e) {}
            advData = advLoad(); advSyncDaily(); advRefreshViews();
            return false;
        }
        return true;                             // 雲端還沒有進度：把本機的上傳
    }
    // 每天最多重複挑戰已通關關卡 3 次
    // 首頁「雞塊樂園」標題旁的小標籤：目前要打第幾關
    function homeAdvBadge() {
        let el = document.getElementById('funLvBadge');
        if (!el || typeof advData === 'undefined' || !advData) return;
        let n = ADV_LEVELS.length, next = 1;
        while (next <= n && advData.cleared[next]) next++;
        el.textContent = next > n ? '全破' : `第 ${next} 關`;
        el.style.display = '';
    }
    function advDevDone() { advSave(); try { advRefreshViews(); } catch (e) {} }

    function advReplayCap() { return ADV_REPLAY_PER_DAY + (advData.replayBonusDay === getLocalDateStr() ? advData.replayBonus : 0); }
    function advReplaysUsed() { return advData.replayDay === getLocalDateStr() ? advData.replays : 0; }
    function advReplaysLeft() { return Math.max(0, advReplayCap() - advReplaysUsed()); }
    // 這招有沒有擁有：一開始就有的、用碎片買的、用雞塊買的（雞塊的購買紀錄在後端錢包）
    function advOwns(key) {
        let m = advMoveByKey(key);
        if (!m) return false;
        if (m.buy.kind === 'free') return true;
        if (advData.own[key] === true) return true;
        return !!(m.buy.item && walletQty(m.buy.item) > 0);    // 以前用雞塊買過的

    }
    // 目前能用的招式：已裝備且確實擁有，最多 4 招，至少保留 1 招
    function advEquipped() {
        let list = advData.eq.filter(k => advOwns(k)).slice(0, ADV_MAX_EQUIP);
        // 舊存檔不到 3 招：自動補上擁有的招式
        for (let i = 0; i < ADV_MOVES.length && list.length < ADV_MIN_EQUIP; i++) if (advOwns(ADV_MOVES[i].key) && !list.includes(ADV_MOVES[i].key)) list.push(ADV_MOVES[i].key);
        return list.map(advMoveByKey);
    }
    // 第 N 關要先通關第 N−1 關才能挑戰
    function advUnlocked(id) { return id === 1 || !!advData.cleared[id - 1]; }
    function advPlayerStats() {
        return {
            hp: ADV_BASE_STATS.hp + advData.up.hp,
            atk: ADV_BASE_STATS.atk + advData.up.atk,
            agi: ADV_BASE_STATS.agi + advData.up.agi,
            def: ADV_BASE_STATS.def + advData.up.def,
            int: ADV_BASE_STATS.int + advData.up.int,
            luck: ADV_BASE_STATS.luck + advData.up.luck
        };
    }
    function advMaxHp() { return ADV_BASE_STATS.hp + advData.up.hp; }
    // 體力會繼承到下一場戰鬥；每天 00:00（本機時間）補滿
    function advSyncDaily() {
        let today = getLocalDateStr(), max = advMaxHp();
        if (advData.hp === null || advData.hpDay !== today) { advData.hpDay = today; advData.hp = max; advSave(true); }
        else if (advData.hp > max) { advData.hp = max; advSave(true); }
        else if (advData.hp < 0) { advData.hp = 0; advSave(true); }
    }
    // 幸運（兩種用途）：擲幣次數 = (自己的幸運 − 對方的幸運) ÷ 2 無條件捨去（最少 0）
    //   每擲出一次「正面」算一次加成，加成最多 +3
    //   ① 攻擊時：這次傷害 +加成　② 打贏之後：糖醋醬碎片 +加成
    function advLuckDice(myLuck, foeLuck) { return Math.max(0, Math.floor((myLuck - foeLuck) / 2)); }
    function advRollLuck(myLuck, foeLuck) {
        let flips = [];
        for (let i = 0; i < advLuckDice(myLuck, foeLuck); i++) flips.push(Math.random() < 0.5);
        return { flips, bonus: Math.min(ADV_LUCK_CAP, flips.filter(Boolean).length) };
    }
    function advCoinText(flips) { return flips.map(f => f ? '正' : '反').join('、'); }
    // 護盾：智慧 ÷ 2 無條件捨去，最多 5；每場戰鬥開始時補滿，擋掉等量的傷害（敵人也一樣）
    const ADV_SHIELD_CAP = 5;
    function advShieldMax(int) { return Math.min(ADV_SHIELD_CAP, Math.floor(Math.max(0, int || 0) / 2)); }
    // 每題作答秒數：15 秒 + 我方智慧；敵人智慧比我方高時，再扣掉差額（至少 5 秒）
    function advAnswerSecs(myInt, foeInt) { return Math.max(5, ADV_BASE_SECS + myInt - Math.max(0, foeInt - myInt)); }
    // 受到傷害：先扣護盾，剩下的才扣體力
    function advTakeDamage(t, dmg, ignoreShield) {
        let absorbed = ignoreShield ? 0 : Math.min(t.shield || 0, dmg);
        t.shield = (t.shield || 0) - absorbed;
        t.hp = Math.max(0, t.hp - (dmg - absorbed));
        return { absorbed, loss: dmg - absorbed };
    }
    function advHurtLabel(r) { return r.absorbed ? (r.loss ? `🛡️-${r.absorbed} -${r.loss}` : `🛡️-${r.absorbed}`) : '-' + r.loss; }
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
    function advFace(cx, cy, mad, extra) {
        // 共用的表情：眼睛 + 嘴，mad = true 是生氣的眉毛
        return `<circle cx="${cx - 14}" cy="${cy}" r="4.5" fill="#231F20"/><circle cx="${cx + 14}" cy="${cy}" r="4.5" fill="#231F20"/>
            ${mad ? `<path d="M ${cx - 24} ${cy - 11} L ${cx - 7} ${cy - 5} M ${cx + 24} ${cy - 11} L ${cx + 7} ${cy - 5}" stroke="#231F20" stroke-width="4.5" stroke-linecap="round"/>` : ''}
            <path d="M ${cx - 9} ${cy + 18} Q ${cx} ${cy + 10} ${cx + 9} ${cy + 18}" stroke="#231F20" stroke-width="4.5" stroke-linecap="round"/>
            <ellipse cx="${cx - 22}" cy="${cy + 11}" rx="6.5" ry="4.5" fill="#F87171" opacity="0.7"/><ellipse cx="${cx + 22}" cy="${cy + 11}" rx="6.5" ry="4.5" fill="#F87171" opacity="0.7"/>${extra || ''}`;
    }
    function advEnemySVG(kind) {
        const wrap = (inner) => `<svg viewBox="0 0 120 112" xmlns="http://www.w3.org/2000/svg" fill="none">${inner}</svg>`;
        const shadow = '<ellipse cx="60" cy="102" rx="32" ry="6" fill="rgba(0,0,0,0.15)"/>';
        if (kind === 'corn') {
            let kernels = '';
            for (let r = 0; r < 6; r++) for (let c = 0; c < 4; c++) kernels += `<circle cx="${44 + c * 11 + (r % 2) * 5}" cy="${24 + r * 12}" r="3.6" fill="#FDE68A"/>`;
            return wrap(`${shadow}
                <path d="M 30 96 Q 14 70 22 52 Q 34 70 46 86 Z" fill="#4ADE80" stroke="#231F20" stroke-width="4.5" stroke-linejoin="round"/>
                <path d="M 90 96 Q 106 70 98 52 Q 86 70 74 86 Z" fill="#4ADE80" stroke="#231F20" stroke-width="4.5" stroke-linejoin="round"/>
                <ellipse cx="60" cy="54" rx="31" ry="46" fill="#FBBF24" stroke="#231F20" stroke-width="5.5"/>
                ${kernels}
                <circle cx="76" cy="28" r="4.5" fill="#92400E" opacity="0.75"/><circle cx="48" cy="86" r="4" fill="#92400E" opacity="0.7"/><circle cx="80" cy="78" r="3.5" fill="#92400E" opacity="0.7"/>
                ${advFace(60, 54, true)}`);
        }
        if (kind === 'oyster') {
            return wrap(`<ellipse cx="60" cy="100" rx="44" ry="6" fill="rgba(0,0,0,0.15)"/>
                <ellipse cx="60" cy="64" rx="50" ry="34" fill="#F59E0B" stroke="#231F20" stroke-width="5.5"/>
                <ellipse cx="60" cy="58" rx="42" ry="27" fill="#FDE68A"/>
                <path d="M 24 50 Q 40 40 50 52 T 76 48 T 98 56" stroke="#DC2626" stroke-width="7" stroke-linecap="round" fill="none"/>
                <ellipse cx="30" cy="66" rx="7" ry="4.5" fill="#CBD5E1" stroke="#64748B" stroke-width="2"/><ellipse cx="92" cy="70" rx="7" ry="4.5" fill="#CBD5E1" stroke="#64748B" stroke-width="2"/>
                <path d="M 20 56 l 6 -3 M 80 40 l 6 3 M 100 62 l 5 -4 M 44 84 l 6 2" stroke="#16A34A" stroke-width="3.5" stroke-linecap="round"/>
                ${advFace(60, 62, true)}`);
        }
        if (kind === 'tofu') {
            return wrap(`${shadow}
                <path d="M 38 18 Q 30 8 38 2 M 60 16 Q 52 6 60 -2 M 82 18 Q 74 8 82 2" stroke="#84CC16" stroke-width="4.5" stroke-linecap="round" fill="none" transform="translate(0 6)"/>
                <rect x="20" y="22" width="80" height="76" rx="16" fill="#B45309" stroke="#231F20" stroke-width="5.5"/>
                <rect x="28" y="30" width="64" height="60" rx="11" fill="#D97706" opacity="0.55"/>
                <circle cx="30" cy="40" r="3" fill="#78350F"/><circle cx="92" cy="86" r="3" fill="#78350F"/><circle cx="88" cy="38" r="2.5" fill="#78350F"/>
                <path d="M 22 92 Q 40 80 62 92 T 100 90" stroke="#84CC16" stroke-width="5" stroke-linecap="round" fill="none"/>
                ${advFace(60, 56, true)}`);
        }
        if (kind === 'boba') {
            return wrap(`${shadow}
                <path d="M 66 10 L 78 -4" stroke="#F472B6" stroke-width="7" stroke-linecap="round"/><path d="M 62 24 L 66 8" stroke="#F472B6" stroke-width="7" stroke-linecap="round"/>
                <path d="M 24 32 Q 60 12 96 32 L 90 98 Q 60 106 30 98 Z" fill="#E7C9A2" stroke="#231F20" stroke-width="5.5" stroke-linejoin="round"/>
                <path d="M 22 32 Q 60 10 98 32" stroke="#231F20" stroke-width="5.5" fill="#F5F5F4" stroke-linejoin="round"/>
                <path d="M 28 62 L 92 62" stroke="#C99A6B" stroke-width="3" opacity="0.7"/>
                ${[[38, 90], [52, 93], [66, 93], [80, 90], [45, 80], [60, 82], [74, 80]].map(p => `<circle cx="${p[0]}" cy="${p[1]}" r="5" fill="#3F2A1D"/>`).join('')}
                ${advFace(60, 54, true)}`);
        }
        if (kind === 'claw') {
            return wrap(`${shadow}
                <rect x="22" y="6" width="76" height="94" rx="10" fill="#F472B6" stroke="#231F20" stroke-width="5"/>
                <rect x="30" y="14" width="60" height="42" rx="6" fill="#BAE6FD" stroke="#231F20" stroke-width="3"/>
                <path d="M 60 14 V 26 M 52 34 Q 52 26 60 26 Q 68 26 68 34" stroke="#475569" stroke-width="3" fill="none" stroke-linecap="round"/>
                <circle cx="42" cy="48" r="7" fill="#FCD34D"/><circle cx="77" cy="48" r="7" fill="#A7F3D0"/><circle cx="59" cy="50" r="6" fill="#FCA5A5"/>
                ${advFace(60, 72, true)}`);
        }
        if (kind === 'darts') {
            // 夜市射飛鏢：一顆生氣的大氣球（身體）＋後面幾顆小氣球＋插在氣球上的飛鏢
            const bal = (x, y, r, c, hi) => `<path d="M ${x} ${y + r + 1} q -3 6 1 12 q 3 6 -1 12" stroke="#94A3B8" stroke-width="1.6" fill="none"/>
                <ellipse cx="${x}" cy="${y}" rx="${r * 0.86}" ry="${r}" fill="${c}" stroke="#231F20" stroke-width="3"/>
                <path d="M ${x - 3} ${y + r - 1} L ${x + 3} ${y + r - 1} L ${x} ${y + r + 4} Z" fill="${c}" stroke="#231F20" stroke-width="2" stroke-linejoin="round"/>
                <ellipse cx="${x - r * 0.35}" cy="${y - r * 0.45}" rx="${r * 0.18}" ry="${r * 0.3}" fill="${hi}" opacity="0.8" transform="rotate(-25 ${x - r * 0.35} ${y - r * 0.45})"/>`;
            const dart = (x1, y1, x2, y2, c) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#334155" stroke-width="3.2" stroke-linecap="round"/>
                <line x1="${x1}" y1="${y1}" x2="${x1 + (x1 - x2) * 0.18}" y2="${y1 + (y1 - y2) * 0.18}" stroke="#CBD5E1" stroke-width="2.4" stroke-linecap="round"/>
                <path d="M ${x2} ${y2} l 6 -9 l 3 7 Z M ${x2} ${y2} l 9 -4 l -2 8 Z" fill="${c}" stroke="#231F20" stroke-width="1.4" stroke-linejoin="round"/>`;
            return wrap(`<ellipse cx="60" cy="108" rx="26" ry="4" fill="rgba(0,0,0,0.15)"/>
                ${bal(20, 26, 13, '#FACC15', '#FEF9C3')}${bal(101, 30, 12, '#3B82F6', '#DBEAFE')}${bal(16, 70, 11, '#22C55E', '#DCFCE7')}${bal(104, 72, 11, '#A855F7', '#F3E8FF')}
                <path d="M 60 92 q -5 6 0 12 q 4 5 -1 8" stroke="#94A3B8" stroke-width="2" fill="none"/>
                <ellipse cx="60" cy="52" rx="34" ry="39" fill="#EF4444" stroke="#231F20" stroke-width="5"/>
                <path d="M 55 90 L 65 90 L 60 97 Z" fill="#EF4444" stroke="#231F20" stroke-width="3" stroke-linejoin="round"/>
                <ellipse cx="44" cy="28" rx="6" ry="10" fill="#FECACA" opacity="0.85" transform="rotate(-28 44 28)"/>
                ${advFace(60, 54, true)}
                ${dart(86, 26, 108, 6, '#10B981')}
                ${dart(23, 64, 4, 50, '#F59E0B')}
                <path d="M 26 58 l -4 -5 M 30 56 l 1 -6 M 21 62 l -6 0" stroke="#FDE047" stroke-width="2" stroke-linecap="round"/>`);
        }
        if (kind === 'mahjong') {
            return wrap(`${shadow}
                <rect x="28" y="10" width="72" height="90" rx="12" fill="#16A34A" stroke="#231F20" stroke-width="5"/>
                <rect x="22" y="6" width="72" height="88" rx="12" fill="#FFFBEB" stroke="#231F20" stroke-width="5"/>
                <text x="58" y="42" text-anchor="middle" font-size="28" font-weight="900" fill="#DC2626">中</text>
                ${advFace(58, 60, true)}`);
        }
        if (kind === 'ring') {
            return wrap(`<ellipse cx="60" cy="102" rx="34" ry="6" fill="rgba(0,0,0,0.15)"/>
                <circle cx="60" cy="54" r="40" fill="none" stroke="#231F20" stroke-width="27"/>
                <circle cx="60" cy="54" r="40" fill="none" stroke="#F97316" stroke-width="18"/>
                <path d="M 30 30 A 40 40 0 0 1 58 14" stroke="#FED7AA" stroke-width="5" fill="none" stroke-linecap="round"/>
                ${advFace(60, 50, true)}`);
        }
        if (kind === 'pinball') {
            return wrap(`${shadow}
                <path d="M 24 100 L 32 8 L 88 8 L 96 100 Z" fill="#7C3AED" stroke="#231F20" stroke-width="5" stroke-linejoin="round"/>
                <rect x="38" y="15" width="44" height="34" rx="6" fill="#1E1B4B" stroke="#231F20" stroke-width="3"/>
                ${[[46, 23], [60, 23], [74, 23], [53, 32], [67, 32], [46, 41], [60, 41], [74, 41]].map(p => `<circle cx="${p[0]}" cy="${p[1]}" r="2" fill="#FCD34D"/>`).join('')}
                <circle cx="56" cy="36" r="3.6" fill="#E2E8F0" stroke="#64748B" stroke-width="1"/>
                ${advFace(60, 68, true)}`);
        }
        if (kind === 'egg') {
            return wrap(`${shadow}
                <ellipse cx="60" cy="56" rx="35" ry="45" fill="#9A5B2E" stroke="#231F20" stroke-width="5"/>
                <path d="M 30 38 l 8 6 l 7 -6 l 7 7 l 8 -7 l 7 6 l 8 -5 l 6 4 M 27 72 l 9 -5 l 7 6 l 8 -6 l 9 6 l 8 -5 l 8 5 l 6 -3 M 40 20 l 6 5 l 8 -4 l 7 5 l 9 -3" stroke="#4A2710" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
                <ellipse cx="44" cy="28" rx="6" ry="11" fill="#C98E5C" opacity="0.55" transform="rotate(-18 44 28)"/>
                <path d="M 92 16 c -3 -5 -10 -3 -9 3 c 1 4 9 9 9 9 c 0 0 8 -5 9 -9 c 1 -6 -6 -8 -9 -3 z" fill="#F43F5E" stroke="#231F20" stroke-width="2"/>
                ${advFace(60, 54, true)}`);
        }
        if (kind === 'bun') {
            return wrap(`${shadow}
                <path d="M 14 54 Q 14 26 60 24 Q 106 26 106 54 Z" fill="#E39A45" stroke="#231F20" stroke-width="5" stroke-linejoin="round"/>
                <rect x="3" y="42" width="114" height="24" rx="12" fill="#C2410C" stroke="#231F20" stroke-width="5"/>
                <path d="M 16 54 l 8 -6 l 8 6 l 8 -6 l 8 6 l 8 -6 l 8 6 l 8 -6 l 8 6 l 8 -6 l 8 6 l 8 -6" stroke="#FACC15" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M 10 58 Q 10 94 60 94 Q 110 94 110 58 Z" fill="#F2B865" stroke="#231F20" stroke-width="5" stroke-linejoin="round"/>
                <path d="M 30 32 Q 40 28 50 30" stroke="#F8D2A0" stroke-width="3.5" stroke-linecap="round"/>
                ${advFace(60, 68, true)}`);
        }
        if (kind === 'hotdog') {
            return wrap(`<ellipse cx="60" cy="104" rx="22" ry="5" fill="rgba(0,0,0,0.15)"/>
                <rect x="56" y="80" width="8" height="26" rx="3" fill="#E7C58C" stroke="#231F20" stroke-width="3"/>
                <rect x="32" y="4" width="56" height="86" rx="28" fill="#C2410C" stroke="#231F20" stroke-width="5"/>
                <path d="M 40 28 l 40 -8 M 40 72 l 40 -8" stroke="#7C2D12" stroke-width="3.5" stroke-linecap="round"/>
                <path d="M 44 14 Q 50 9 57 12" stroke="#FDBA74" stroke-width="4" stroke-linecap="round" opacity="0.8"/>
                ${advFace(60, 44, true)}`);
        }
        if (kind === 'onigiri') {
            return wrap(`${shadow}
                <path d="M 60 1 L 117 99 H 3 Z" fill="rgba(186,230,253,0.28)" stroke="#7DD3FC" stroke-width="2.4" stroke-dasharray="7 4" stroke-linejoin="round"/>
                <path d="M 60 8 Q 66 8 70 14 L 106 82 Q 110 95 97 95 H 23 Q 10 95 14 82 L 50 14 Q 54 8 60 8 Z" fill="#FFFFFF" stroke="#231F20" stroke-width="5" stroke-linejoin="round"/>
                <rect x="40" y="70" width="40" height="25" fill="#1F2937"/>
                <rect x="56" y="0" width="8" height="20" rx="2" fill="#EF4444" stroke="#7F1D1D" stroke-width="1.5"/>
                <circle cx="40" cy="62" r="1.6" fill="#CBD5E1"/><circle cx="82" cy="58" r="1.6" fill="#CBD5E1"/><circle cx="62" cy="28" r="1.6" fill="#CBD5E1"/>
                ${advFace(60, 46, true)}`);
        }
        if (kind === 'tea') {
            return wrap(`<ellipse cx="60" cy="106" rx="30" ry="5" fill="rgba(0,0,0,0.15)"/>
                <rect x="47" y="1" width="26" height="13" rx="3" fill="#16A34A" stroke="#231F20" stroke-width="4"/>
                <path d="M 50 14 H 70 L 72 22 Q 88 28 88 44 V 96 Q 88 104 80 104 H 40 Q 32 104 32 96 V 44 Q 32 28 48 22 Z" fill="#E7F7C1" stroke="#231F20" stroke-width="5" stroke-linejoin="round"/>
                <rect x="34.5" y="62" width="51" height="24" fill="#15803D"/>
                <text x="60" y="79" text-anchor="middle" font-size="14" font-weight="900" fill="#FFFFFF" font-family="'Noto Sans TC','PingFang TC','Microsoft JhengHei',sans-serif">無糖</text>
                <path d="M 40 34 Q 42 28 48 26" stroke="#FFFFFF" stroke-width="3.5" stroke-linecap="round" opacity="0.9"/>
                ${advFace(60, 38, true)}`);
        }
        if (kind === 'ibon') {
            return wrap(`${shadow}
                <rect x="24" y="3" width="72" height="98" rx="9" fill="#F8FAFC" stroke="#231F20" stroke-width="5"/>
                <path d="M 26.5 12 Q 26.5 5.5 33 5.5 H 87 Q 93.5 5.5 93.5 12 V 18 H 26.5 Z" fill="#F97316"/>
                <rect x="32" y="24" width="56" height="38" rx="4" fill="#1E3A8A" stroke="#231F20" stroke-width="3"/>
                <circle cx="48" cy="44" r="4.5" fill="#FFFFFF"/><circle cx="72" cy="44" r="4.5" fill="#FFFFFF"/>
                <path d="M 38 33 L 54 39 M 82 33 L 66 39" stroke="#FFFFFF" stroke-width="3.5" stroke-linecap="round"/>
                <path d="M 52 57 Q 60 51 68 57" stroke="#FFFFFF" stroke-width="3.5" fill="none" stroke-linecap="round"/>
                <rect x="38" y="70" width="44" height="7" rx="2.5" fill="#334155"/>
                <path d="M 43 75 H 77 V 97 L 73 94 L 69 97 L 65 94 L 61 97 L 57 94 L 53 97 L 49 94 L 45 97 L 43 95 Z" fill="#FFFFFF" stroke="#94A3B8" stroke-width="1.5"/>
                <path d="M 48 81 H 72 M 48 86 H 66" stroke="#94A3B8" stroke-width="1.6" stroke-linecap="round"/>
                <circle cx="88" cy="74" r="3" fill="#22C55E"/>`);
        }
        if (kind === 'salad') {
            return wrap(`<ellipse cx="60" cy="104" rx="42" ry="6" fill="rgba(0,0,0,0.15)"/>
                <path d="M 14 50 H 106 L 98 98 Q 97 102 92 102 H 28 Q 23 102 22 98 Z" fill="#F1F5F9" stroke="#231F20" stroke-width="5" stroke-linejoin="round"/>
                <path d="M 20 52 Q 26 30 40 38 Q 44 22 58 32 Q 66 18 78 32 Q 92 24 96 40 Q 108 40 102 52 Z" fill="#4ADE80" stroke="#166534" stroke-width="3" stroke-linejoin="round"/>
                <circle cx="38" cy="44" r="7" fill="#EF4444" stroke="#7F1D1D" stroke-width="2"/><circle cx="84" cy="42" r="6" fill="#FB923C" stroke="#9A3412" stroke-width="2"/>
                <path d="M 54 40 l 10 -6 M 60 44 l 9 -5" stroke="#FDE047" stroke-width="3.5" stroke-linecap="round"/>
                <path d="M 8 50 Q 60 34 112 50" stroke="#94A3B8" stroke-width="3" fill="none" stroke-dasharray="4 4" opacity="0.8"/>
                <path d="M 30 92 H 46" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" opacity="0.8"/>
                ${advFace(60, 74, true)}`);
        }
        if (kind === 'microwave') {
            return wrap(`${shadow}
                <rect x="6" y="20" width="108" height="76" rx="9" fill="#E2E8F0" stroke="#231F20" stroke-width="5"/>
                <rect x="14" y="28" width="68" height="60" rx="5" fill="#1E293B" stroke="#231F20" stroke-width="3"/>
                <ellipse cx="48" cy="72" rx="22" ry="5" fill="#FDE68A" opacity="0.35"/>
                <rect x="88" y="30" width="18" height="12" rx="2" fill="#0F172A"/><text x="97" y="40" font-size="9" font-weight="900" text-anchor="middle" fill="#22C55E" font-family="monospace">0:30</text>
                <circle cx="97" cy="56" r="5" fill="#94A3B8" stroke="#231F20" stroke-width="2"/><circle cx="97" cy="74" r="5" fill="#94A3B8" stroke="#231F20" stroke-width="2"/>
                <circle cx="38" cy="54" r="4.5" fill="#FDE68A"/><circle cx="58" cy="54" r="4.5" fill="#FDE68A"/>
                <path d="M 30 44 L 42 49 M 66 44 L 54 49" stroke="#FDE68A" stroke-width="3.5" stroke-linecap="round"/>
                <path d="M 40 68 Q 48 62 56 68" stroke="#FDE68A" stroke-width="3.5" fill="none" stroke-linecap="round"/>
                <path d="M 20 10 q -4 -5 0 -9 M 60 12 q -4 -5 0 -9 M 100 10 q -4 -5 0 -9" stroke="#F97316" stroke-width="2.5" fill="none" stroke-linecap="round"/>`);
        }
        if (kind === 'bento' || kind === 'bento2') {
            let old = kind === 'bento2';
            return wrap(`${shadow}
                <rect x="8" y="30" width="104" height="68" rx="8" fill="${old ? '#A16207' : '#1F2937'}" stroke="#231F20" stroke-width="5"/>
                <rect x="15" y="37" width="44" height="54" rx="4" fill="${old ? '#E7E5E4' : '#FFFFFF'}"/>
                <rect x="63" y="37" width="42" height="25" rx="4" fill="${old ? '#92400E' : '#B45309'}"/><rect x="63" y="66" width="42" height="25" rx="4" fill="${old ? '#65A30D' : '#22C55E'}"/>
                <circle cx="72" cy="78" r="4" fill="#FDE047"/><circle cx="88" cy="47" r="4" fill="#EF4444"/>
                <path d="M 4 28 Q 60 ${old ? 18 : 22} 116 28" stroke="#CBD5E1" stroke-width="3" fill="none" opacity="0.9"/>
                ${old ? `<g transform="rotate(-12 92 22)"><circle cx="92" cy="22" r="17" fill="#EF4444" stroke="#7F1D1D" stroke-width="2.5"/><text x="92" y="20" font-size="9" font-weight="900" text-anchor="middle" fill="#FFFFFF" font-family="'Noto Sans TC','PingFang TC','Microsoft JhengHei',sans-serif">愛珍食</text><text x="92" y="30" font-size="8" font-weight="900" text-anchor="middle" fill="#FEF08A" font-family="'Noto Sans TC','PingFang TC','Microsoft JhengHei',sans-serif">35折</text></g>` : ''}
                <circle cx="30" cy="60" r="4.5" fill="#231F20"/><circle cx="46" cy="60" r="4.5" fill="#231F20"/>
                ${old ? '<path d="M 24 52 L 34 55 M 52 52 L 42 55" stroke="#231F20" stroke-width="3.5" stroke-linecap="round"/><path d="M 30 77 Q 38 70 46 77" stroke="#231F20" stroke-width="3.5" fill="none" stroke-linecap="round"/><path d="M 52 64 q 3 5 0 9" stroke="#38BDF8" stroke-width="3" fill="none" stroke-linecap="round"/>' : '<path d="M 30 72 Q 38 79 46 72" stroke="#231F20" stroke-width="3.5" fill="none" stroke-linecap="round"/><ellipse cx="24" cy="70" rx="5" ry="3.5" fill="#F87171" opacity="0.7"/><ellipse cx="52" cy="70" rx="5" ry="3.5" fill="#F87171" opacity="0.7"/>'}`);
        }
        // 貢丸（預設）
        return wrap(`${shadow}
            <circle cx="60" cy="56" r="42" fill="#E9C7A0" stroke="#231F20" stroke-width="5.5"/>
            <circle cx="36" cy="76" r="3" fill="#C99A6B"/><circle cx="82" cy="80" r="3" fill="#C99A6B"/><circle cx="66" cy="90" r="2.5" fill="#C99A6B"/><circle cx="90" cy="58" r="2.5" fill="#C99A6B"/>
            <ellipse cx="42" cy="32" rx="9" ry="5" fill="#FFFFFF" opacity="0.5" transform="rotate(-25 42 32)"/>
            <ellipse cx="38" cy="66" rx="6.5" ry="4.5" fill="#F87171" opacity="0.7"/><ellipse cx="82" cy="66" rx="6.5" ry="4.5" fill="#F87171" opacity="0.7"/>
            <circle cx="46" cy="54" r="4.5" fill="#231F20"/><circle cx="74" cy="54" r="4.5" fill="#231F20"/>
            <path d="M 36 43 L 53 49 M 84 43 L 67 49" stroke="#231F20" stroke-width="4.5" stroke-linecap="round"/>
            <path d="M 51 72 Q 60 64 69 72" stroke="#231F20" stroke-width="4.5" stroke-linecap="round"/>`);
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
    // 地圖會依手機畫面的可用高度調整（K = 縱向縮放比例）；圖上的攤位、櫃子只移動位置、稍微縮小，不會被壓扁
    let advMapK = 1;
    function advMapH() { return Math.round(ADV_MAP_H * advMapK); }
    function advMapObj(cx, y0, inner, bottom) {
        // 以 (cx, y0) 為錨點：位置跟著地圖縮放，大小只縮到 K（最多不放大）
        let s = Math.min(1, advMapK), ny = bottom ? y0 + (advMapH() - ADV_MAP_H) : y0 * advMapK;
        return `<g transform="translate(${cx} ${ny.toFixed(1)}) scale(${s.toFixed(3)}) translate(${-cx} ${-y0})">${inner}</g>`;
    }
    function advMapPath() { return advSpline([[60, ADV_MAP_H], ...ADV_MAP_PTS].map(p => [p[0], +(p[1] * advMapK).toFixed(1)])); }
    function advMapRoad(path, c) {
        return `<path d="${path}" fill="none" stroke="${c[0]}" stroke-width="38" stroke-linecap="round" stroke-linejoin="round" transform="translate(0,3)"/>
        <path d="${path}" fill="none" stroke="${c[1]}" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="${path}" fill="none" stroke="${c[2]}" stroke-width="24" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="${path}" fill="none" stroke="${c[3]}" stroke-width="3" stroke-linecap="round" stroke-dasharray="2 10"/>`;
    }
    function advMapSVG() {
        const K = advMapK, H = advMapH();
        let seed = 11, stars = '';
        const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
        for (let i = 0; i < 40; i++) stars += `<circle cx="${(rnd() * 340).toFixed(1)}" cy="${(rnd() * H).toFixed(1)}" r="${(0.8 + rnd() * 1.2).toFixed(1)}" fill="#E0E7FF" opacity="${(0.4 + rnd() * 0.5).toFixed(2)}"/>`;
        const glow = (x, y, r, c) => `<circle cx="${x}" cy="${(y * K).toFixed(1)}" r="${r}" fill="${c}" opacity="0.18"/>`;
        const lan = (x, y) => advMapObj(x, y, advLantern(x, y));
        const stall = (x, y, w, label, emoji) => advMapObj(x + w / 2, y, advStall(x, y, w, label, emoji));
        return `<svg class="adv-map-svg" viewBox="0 0 ${ADV_MAP_W} ${H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <defs>
            <linearGradient id="mgNight" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#140F36"/><stop offset="0.5" stop-color="#2E1F5E"/><stop offset="1" stop-color="#1E1B4B"/></linearGradient>
        </defs>
        <rect width="340" height="${H}" fill="url(#mgNight)"/>
        ${stars}
        ${glow(36, 130, 60, '#FDE047')}${glow(304, 200, 60, '#FB923C')}${glow(36, 400, 60, '#F472B6')}${glow(304, 330, 60, '#FDE047')}${glow(36, 640, 60, '#FB923C')}${glow(304, 560, 60, '#F472B6')}
        ${advStringLights(150 * K, 16 * K)}${advStringLights(282 * K, 18 * K)}${advStringLights(432 * K, 18 * K)}${advStringLights(566 * K, 16 * K)}
        ${lan(24, 560)}${lan(24, 430)}${lan(24, 220)}${lan(316, 380)}${lan(316, 278)}${lan(316, 165)}
        <!-- 攤位：每一關的攤位放在那一關的旁邊（攤位中心 ≈ 關卡的高度） -->
        ${stall(8, 620, 56, '貢丸', '🍡')}
        ${stall(276, 574, 56, '烤玉米', '🌽')}
        ${stall(276, 506, 56, '麵線', '🍜')}
        ${stall(8, 506, 56, '蚵仔煎', '🍳')}
        ${stall(276, 438, 56, '臭豆腐', '🧆')}
        ${stall(8, 358, 56, '珍奶', '🧋')}
        ${stall(276, 330, 56, '雞排', '🍗')}
        ${stall(8, 286, 56, '娃娃機', '🧸')}
        ${stall(276, 226, 56, '射飛鏢', '🎯')}
        ${stall(8, 162, 56, '麻將', '🀄')}
        ${stall(276, 108, 56, '套圈圈', '⭕')}
        ${stall(8, 44, 56, '彈珠台', '🎱')}
        ${stall(276, 40, 56, '滷味', '🍢')}
        ${advMapRoad(advMapPath(), ['rgba(15,23,42,0.35)', '#F3D49B', '#FFF1D0', '#E7B96E'])}
        </svg>`;
    }
    // 第二章：便利商店（由外到內：最下面是店門口，越往上越裡面）
    function advStoreMapSVG() {
        const K = advMapK, H = advMapH(), dyB = H - ADV_MAP_H;      // dyB：貼齊下緣的東西要移動的量
        const FONT = `font-family="'Noto Sans TC','PingFang TC','Microsoft JhengHei',sans-serif"`;
        const tag = (x, y, w, t) => `<g><rect x="${x}" y="${y}" width="${w}" height="15" rx="4" fill="#FDE047" stroke="#A16207" stroke-width="1"/><text x="${x + w / 2}" y="${y + 11}" font-size="10.5" font-weight="800" text-anchor="middle" fill="#7C2D12" ${FONT}>${t}</text></g>`;
        const O = advMapObj;
        let s = '';
        // 店內地板（白色地磚）
        let floorH = 652 + dyB;
        s += `<rect width="340" height="${floorH}" fill="#EEF2F7"/>`;
        for (let x = 0; x <= 340; x += 34) s += `<line x1="${x}" y1="0" x2="${x}" y2="${floorH}" stroke="#DCE3EC" stroke-width="1"/>`;
        for (let y = 0; y <= floorH; y += 34) s += `<line x1="0" y1="${y}" x2="340" y2="${y}" stroke="#DCE3EC" stroke-width="1"/>`;
        [[90, 470], [250, 330], [100, 200], [250, 80], [170, 560]].forEach(p => { s += `<ellipse cx="${p[0]}" cy="${(p[1] * K).toFixed(1)}" rx="70" ry="${(40 * K).toFixed(1)}" fill="#FFFFFF" opacity="0.55"/>`; });
        // ── 店門口（第 11 關）：人行道 + 招牌 + 自動門（貼齊下緣，不縮放）──
        let front = `<rect x="0" y="664" width="340" height="36" fill="#475569"/>`;
        for (let x = 0; x <= 340; x += 20) front += `<line x1="${x}" y1="664" x2="${x}" y2="700" stroke="#3B4757" stroke-width="1"/>`;
        front += `<line x1="0" y1="682" x2="340" y2="682" stroke="#3B4757" stroke-width="1"/>`;
        front += `<rect x="0" y="648" width="340" height="16" fill="#1E3A8A"/><rect x="0" y="648" width="340" height="3" fill="#F97316"/><rect x="0" y="661" width="340" height="3" fill="#22C55E"/>`;
        front += `<text x="262" y="660" font-size="10" font-weight="900" text-anchor="middle" fill="#FFFFFF" ${FONT}>便利商店　24H</text>`;
        front += `<rect x="40" y="646" width="78" height="20" fill="#CBD5E1"/><rect x="40" y="646" width="10" height="20" fill="#BAE6FD" stroke="#64748B" stroke-width="1"/><rect x="108" y="646" width="10" height="20" fill="#BAE6FD" stroke="#64748B" stroke-width="1"/>`;
        s += `<g transform="translate(0 ${dyB})">${front}</g>`;
        // ── 第 12 關：熱食櫃（大亨堡）──
        s += O(302, 538, `<g><rect x="268" y="556" width="68" height="58" rx="5" fill="#E2E8F0" stroke="#64748B" stroke-width="2"/>
            <rect x="273" y="562" width="58" height="36" rx="3" fill="#FDE68A" opacity="0.6"/>
            ${[0, 1, 2, 3, 4].map(i => `<line x1="276" y1="${566 + i * 7}" x2="328" y2="${566 + i * 7}" stroke="#94A3B8" stroke-width="2"/>`).join('')}
            ${[0, 1, 2].map(i => `<rect x="${280 + i * 16}" y="${567 + i * 7}" width="13" height="5" rx="2.5" fill="#C2410C"/>`).join('')}
            <rect x="268" y="600" width="68" height="14" fill="#94A3B8"/></g>${tag(276, 538, 52, '大亨堡')}`);
        // ── 第 13 關：冷藏櫃（御飯糰）──
        s += O(34, 452, `<g><rect x="4" y="470" width="60" height="88" rx="4" fill="#E0F2FE" stroke="#0369A1" stroke-width="2"/>
            ${[0, 1, 2].map(r => `<line x1="6" y1="${498 + r * 22}" x2="62" y2="${498 + r * 22}" stroke="#0369A1" stroke-width="2"/>` + [0, 1, 2].map(c => `<path d="M ${16 + c * 18} ${478 + r * 22} l 7 14 h -14 z" fill="#FFFFFF" stroke="#334155" stroke-width="1.2"/><rect x="${11 + c * 18}" y="${488 + r * 22}" width="10" height="4" fill="#1F2937"/>`).join('')).join('')}</g>${tag(8, 452, 52, '御飯糰')}`);
        // ── 第 14 關：飲料櫃（瓶裝無糖茶）──
        s += O(307, 382, `<g><rect x="278" y="400" width="58" height="90" rx="4" fill="#DBEAFE" stroke="#1E40AF" stroke-width="2"/>
            <line x1="307" y1="402" x2="307" y2="488" stroke="#1E40AF" stroke-width="1.5"/>
            ${[0, 1, 2].map(r => [0, 1, 2, 3].map(c => `<rect x="${283 + c * 13}" y="${408 + r * 27}" width="7" height="20" rx="2.5" fill="${['#86EFAC', '#FCA5A5', '#FDE68A', '#93C5FD'][(r + c) % 4]}" stroke="#334155" stroke-width="0.8"/>`).join('')).join('')}</g>${tag(282, 382, 50, '飲料')}`);
        // ── 第 15 關：多媒體機（ibon）──
        s += O(297, 279, `<g><rect x="270" y="298" width="54" height="72" rx="6" fill="#F8FAFC" stroke="#334155" stroke-width="2"/>
            <rect x="270" y="298" width="54" height="11" rx="5" fill="#F97316"/>
            <rect x="277" y="314" width="40" height="26" rx="3" fill="#1E3A8A"/>
            <rect x="282" y="346" width="30" height="5" rx="2" fill="#334155"/><rect x="285" y="350" width="24" height="12" fill="#FFFFFF" stroke="#94A3B8" stroke-width="1"/></g>${tag(268, 279, 58, 'ibon')}`);
        // ── 更裡面（第 16～20 關）：冰櫃、零食架、咖啡機、櫃檯 ──
        // ── 第 16 關：沙拉冷藏櫃 ──
        s += O(33, 282, `<g><rect x="4" y="300" width="58" height="52" rx="5" fill="#F0FDF4" stroke="#16A34A" stroke-width="2"/>${[0, 1, 2].map(i => `<g><rect x="${9 + i * 17}" y="${312 + (i % 2) * 18}" width="14" height="12" rx="2" fill="#FFFFFF" stroke="#94A3B8" stroke-width="1"/><circle cx="${16 + i * 17}" cy="${316 + (i % 2) * 18}" r="4" fill="#4ADE80"/></g>`).join('')}</g>${tag(8, 282, 50, '沙拉')}`);
        // ── 第 18 關：便當冷藏櫃 ──
        s += O(32, 186, `<g><rect x="4" y="186" width="56" height="84" rx="3" fill="#E0F2FE" stroke="#0369A1" stroke-width="2"/>${[0, 1, 2].map(r => `<line x1="6" y1="${212 + r * 26}" x2="58" y2="${212 + r * 26}" stroke="#0369A1" stroke-width="1.5"/>` + [0, 1].map(c => `<rect x="${9 + c * 25}" y="${194 + r * 26}" width="21" height="14" rx="2" fill="#1F2937"/><rect x="${11 + c * 25}" y="${196 + r * 26}" width="9" height="10" fill="#FFFFFF"/><rect x="${21 + c * 25}" y="${196 + r * 26}" width="7" height="10" fill="#B45309"/>`).join('')).join('')}</g>${tag(10, 168, 44, '便當')}`);
        // ── 第 17 關：微波爐 ──
        s += O(308, 160, `<g><rect x="280" y="160" width="56" height="110" rx="3" fill="#FEF3C7" stroke="#B45309" stroke-width="2"/>${[0, 1].map(r => `<line x1="282" y1="${180 + r * 20}" x2="334" y2="${180 + r * 20}" stroke="#B45309" stroke-width="1.5"/>` + [0, 1, 2].map(c => `<rect x="${286 + c * 16}" y="${166 + r * 20}" width="11" height="12" rx="2" fill="${['#A78BFA', '#F472B6', '#FB923C', '#4ADE80'][(r + c) % 4]}"/>`).join('')).join('')}
            <rect x="280" y="206" width="56" height="64" fill="#CBD5E1" stroke="#475569" stroke-width="2"/><rect x="284" y="214" width="48" height="30" rx="3" fill="#E2E8F0" stroke="#334155" stroke-width="1.5"/><rect x="287" y="218" width="30" height="22" rx="2" fill="#1E293B"/><circle cx="325" cy="223" r="2.4" fill="#334155"/><circle cx="325" cy="233" r="2.4" fill="#334155"/></g>${tag(282, 248, 52, '微波爐')}`);
        s += O(305, 18, `<g><rect x="280" y="36" width="50" height="56" rx="5" fill="#334155" stroke="#0F172A" stroke-width="2"/><rect x="288" y="44" width="34" height="14" rx="2" fill="#0F172A"/><circle cx="305" cy="70" r="7" fill="#F8FAFC" stroke="#64748B" stroke-width="1.5"/><rect x="301" y="80" width="8" height="8" fill="#B45309"/></g>${tag(282, 18, 46, '咖啡機')}`);
        s += O(72, 30, `<g><rect x="4" y="30" width="136" height="50" rx="6" fill="#CBD5E1" stroke="#475569" stroke-width="2"/><rect x="18" y="38" width="30" height="22" rx="3" fill="#0F172A"/><rect x="22" y="42" width="22" height="10" fill="#22C55E" opacity="0.7"/><rect x="66" y="40" width="60" height="30" rx="4" fill="#E2E8F0"/></g>${tag(44, 84, 56, '結帳櫃檯')}`);
        // 茶葉蛋鍋（最後畫，標籤在最上層）：店內、一進門的左手邊（跟著門口一起貼齊下緣）
        s += O(33, 642, `<g><rect x="6" y="606" width="54" height="36" rx="4" fill="#CBD5E1" stroke="#64748B" stroke-width="1.5"/>
            <ellipse cx="33" cy="636" rx="22" ry="5" fill="rgba(0,0,0,0.18)"/>
            <path d="M 12 616 H 54 V 629 Q 54 636 47 636 H 19 Q 12 636 12 629 Z" fill="#7C2D12" stroke="#431407" stroke-width="2"/>
            <ellipse cx="33" cy="616" rx="21" ry="5.5" fill="#451A03" stroke="#431407" stroke-width="2"/>
            <ellipse cx="24" cy="615" rx="4.6" ry="3.3" fill="#A16207"/><ellipse cx="34" cy="614" rx="4.6" ry="3.3" fill="#92400E"/><ellipse cx="43" cy="616" rx="4.6" ry="3.3" fill="#A16207"/>
            <path d="M 24 607 q -3 -4 0 -8 M 34 605 q -3 -4 0 -8 M 43 607 q -3 -4 0 -8" stroke="#94A3B8" stroke-width="1.6" fill="none" opacity="0.9"/></g>${tag(11, 582, 44, '茶葉蛋')}`, true);
        return `<svg class="adv-map-svg" viewBox="0 0 ${ADV_MAP_W} ${H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        ${s}
        ${advMapRoad(advMapPath(), ['rgba(15,23,42,0.18)', '#93C5FD', '#DBEAFE', '#60A5FA'])}
        </svg>`;
    }
    let advMapChapter = 1;
    function advChapterOf(id) { let c = ADV_CHAPTERS.find(ch => id >= ch.from && id <= ch.to); return c ? c.id : 1; }
    function advHighestUnlocked() { let best = 1; ADV_LEVELS.forEach(l => { if (advUnlocked(l.id)) best = Math.max(best, l.id); }); return best; }
    function advMapStep(d) {
        advMapChapter = Math.max(1, Math.min(ADV_CHAPTERS.length, advMapChapter + (parseInt(d) || 0)));
        advRenderMap();
    }
    function advRenderMap() {
        let ch = ADV_CHAPTERS.find(c => c.id === advMapChapter) || ADV_CHAPTERS[0];
        let prev = document.getElementById('advMapPrev'), next = document.getElementById('advMapNext');
        if (prev) prev.disabled = ch.id <= 1;
        if (next) next.disabled = ch.id >= ADV_CHAPTERS.length;
        let sub = document.getElementById('advMapSub');
        if (sub) sub.textContent = `第 ${ch.id} 章：${ch.name}（第 ${ch.from}～${ch.to} 關）`;
        let nodes = ADV_MAP_PTS.map((p, i) => {
            let id = ch.from + i, lv = ADV_LEVELS.find(l => l.id === id);
            let st = (!lv || !advUnlocked(id)) ? 'locked' : (advData.cleared[id] ? 'cleared' : 'open');
            let pos = `left:${(p[0] / ADV_MAP_W * 100).toFixed(2)}%;top:${(p[1] / ADV_MAP_H * 100).toFixed(2)}%`;
            return (lv && st !== 'locked')
                ? `<button type="button" class="adv-node ${st}" style="${pos}" aria-label="第 ${id} 關" data-on-click='[["goToAdvLevel",[${id}]]]'>${id}</button>`
                : `<button type="button" class="adv-node locked" style="${pos}" disabled aria-label="第 ${id} 關（${lv ? '先通關上一關' : '敬請期待'}）">🔒</button>`;
        }).join('');
        let box = document.getElementById('advMap');
        if (!box) return;
        advFitMap(box);
        box.innerHTML = (ch.id === 2 ? advStoreMapSVG() : advMapSVG()) + nodes;
    }
    // 地圖高度 = 手機畫面剩下的高度（介於「寬 × 1.15」和原本比例之間），整張地圖不用捲動就看得完
    function advFitMap(box) {
        let w = box.offsetWidth;
        if (!w) { advMapK = 1; box.style.height = ''; return; }
        let r = box.getBoundingClientRect();
        let k = r.width / w || 1;                                   // 電腦版整個畫面有放大
        let avail = (window.innerHeight - r.top - 14) / k;
        let full = w * ADV_MAP_H / ADV_MAP_W;
        let h = Math.max(w * 1.15, Math.min(full, avail));
        box.style.height = Math.round(h) + 'px';
        advMapK = (h / w) * ADV_MAP_W / ADV_MAP_H;
    }
    window.addEventListener('resize', () => { try { if (document.getElementById('adventureView').classList.contains('active')) advRenderMap(); } catch (e) {} });

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
        let isCleared = !!advData.cleared[lv.id], left = advReplaysLeft();
        let canGo = ok && !tired && !(isCleared && left <= 0);
        let hearts = `♥ ${advData.hp}/${max}`;
        let shardIcon = advShardIcon(14);
        let first = lv.firstSauce ? `<span style="color:${ADV_SAUCE_COLOR};font-weight:800;">🍯 糖醋醬 ×${lv.firstSauce}</span>` : `${shardIcon} ×${lv.firstShards}`;
        let html = `
            <div class="adv-card adv-level">
                <div class="adv-lv-sprite">${advEnemySVG(lv.sprite)}</div>
                <div class="adv-lv-info">
                    <b>第 ${lv.id} 關：${lv.name} ${advData.cleared[lv.id] ? '✅' : ''}</b>
                    <span class="${ok ? 'adv-ok' : 'adv-bad'}">攻略條件：選取至少 ${lv.minWords} 題以上的單字${ok ? ' ✓' : `（目前 ${n} 題）`}</span><br>
                    <span class="${tired ? 'adv-bad' : ''}">體力：${hearts}${tired ? '　沒體力了，明天 00:00 恢復' : ''}</span><br>
                    ${isCleared ? `<span class="${left <= 0 ? 'adv-bad' : ''}">🔁 今天還能重複挑戰已通關關卡 ${left}/${advReplayCap()} 次</span><br>` : ''}
                    ${advData.cleared[lv.id] ? '' : `首次通關：${first}${lv.firstMaxHp ? '、❤️ 生命上限 +' + lv.firstMaxHp : ''}${lv.firstPotions ? '、🧪 恢復藥水 ×' + lv.firstPotions : ''}${lv.firstTickets ? '、' + advTicketIcon(15) + ' 冒險卷 ×' + lv.firstTickets : ''}${lv.firstItem ? '、' + ADV_ITEMS[lv.firstItem].icon(15) + ' ' + ADV_ITEMS[lv.firstItem].name : ''}<br>`}通關獎勵：${shardIcon} ×${lv.repeatShards}${lv.ticketChance ? `、${advTicketIcon(15)} 冒險卷（${Math.round(lv.ticketChance * 100)}% 機會）` : ''}${lv.potionChance ? `、🧪 恢復藥水（${Math.round(lv.potionChance * 100)}% 機會）` : ''}
                    ${ADV_MOVES.filter(m => m.buy.kind === 'reward' && m.buy.level === lv.id && !advOwns(m.key)).map(m => `<br><span style="color:var(--primary);font-weight:700;">🎁 首次通關額外獎勵：學會「${m.name}」</span>`).join('')}
                    ${lv.special ? `<br><span class="adv-special">⚠️ ${ADV_SPECIAL_TEXT[lv.special]}</span>` : ''}
                </div>
            </div>`;
        let box = document.getElementById('advLevelCard');
        if (box) box.innerHTML = html;
        advUpdateGearAlerts();
        let bar = document.getElementById('advGoBar');
        if (bar) bar.innerHTML = `<button type="button" class="adv-go adv-go-wide" ${canGo ? '' : 'disabled'} data-on-click='[["advStartBattle",[${lv.id}]]]'>開始戰鬥</button>`;
    }
    function goToAdvLevel(levelId) {
        advAbort();
        adv.pickLevel = (ADV_LEVELS.some(l => l.id === levelId) && advUnlocked(levelId)) ? levelId : 1;
        advInitGrid();
        advRenderLevelPage();
        switchView('advLevelView');
    }
    function advBackToLevel() { goToAdvLevel(adv.pickLevel || 1); }

    // ── 第 1 頁：地圖 ──
    function goToAdventurePage(fromLevel) {
        advAbort();
        advSyncDaily();
        advMapChapter = advChapterOf(fromLevel === true && adv.pickLevel ? adv.pickLevel : advHighestUnlocked());
        switchView('adventureView');
        advRenderMap();
    }

    // ── 第 3 頁：雞塊能力值（糖醋醬可讓任一能力 +1）──
    const ADV_STAT_DEFS = [
        { key: 'hp',   label: 'HP',   color: '#10B981' },
        { key: 'atk',  label: '攻擊', color: '#F43F5E' },
        { key: 'agi',  label: '敏捷', color: '#3B82F6' },
        { key: 'def',  label: '防禦', color: '#F59E0B' },
        { key: 'int',  label: '智慧', color: '#14B8A6' },
        { key: 'luck', label: '幸運', color: '#A855F7' }
    ];
    const ADV_BAR_MAX = 12;
    function goToAdvStats(tab) {
        advStatsTab = ['moves', 'gear'].indexOf(tab) !== -1 ? tab : 'stats';   // 每次進來預設「基本素質」
        advAbort();
        advSyncDaily();
        advRenderStatsPage();
        switchView('advStatsView');
        requestAnimationFrame(advFitMoveGrid);
    }
    // 糖醋醬碎片的圖示（顏色 = 糖醋醬的顏色）
    function advShardIcon(size) {
        size = size || 16;
        return `<svg class="adv-shard-ico" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" style="vertical-align:-3px;"><path d="M13 1.5 L21 8 L17.5 22 L5 18 L3.5 8 Z" fill="${ADV_SAUCE_COLOR}" stroke="#B8553F" stroke-width="1.8" stroke-linejoin="round"/><path d="M13 1.5 L11 11 L3.5 8 M11 11 L17.5 22" stroke="#FFE4DC" stroke-width="1.4" fill="none" stroke-linejoin="round" opacity="0.95"/></svg>`;
    }
    // 糖醋醬：小小的醬料杯（粉橘色蓋子 + 白色杯身）
    function advSauceIcon(size) {
        size = size || 16;
        return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" style="vertical-align:-3px;"><path d="M5 12.5 L6.6 20 Q6.9 21.2 8.2 21.2 H15.8 Q17.1 21.2 17.4 20 L19 12.5 Z" fill="#F8FAFC" stroke="#94A3B8" stroke-width="1.4" stroke-linejoin="round"/><rect x="2.8" y="5.5" width="18.4" height="8" rx="3.2" fill="#F5ADA3" stroke="#B8553F" stroke-width="1.5"/><path d="M6.5 9.5 H17.5 M8 11.8 H16" stroke="#FFFFFF" stroke-width="1.3" stroke-linecap="round" opacity="0.9"/><circle cx="6" cy="8" r="0.9" fill="#FFFFFF"/></svg>`;
    }
    // 背包圖示（紅色包包）
    function advBagIcon(size) {
        size = size || 20;
        return `<svg width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true" style="vertical-align:-5px;overflow:visible"><path d="M10.5 9 V7.5 A5.5 5.5 0 0 1 21.5 7.5 V9" stroke="#92400E" stroke-width="2.4" fill="none" stroke-linecap="round"/><rect x="3" y="9" width="26" height="19" rx="5" fill="#8B5CF6" stroke="#3B1D8F" stroke-width="2"/><path d="M3 15.5 H29" stroke="#3B1D8F" stroke-width="2"/><rect x="3" y="9" width="26" height="6.5" rx="5" fill="#6D28D9"/><path d="M3 15.5 H29" stroke="#3B1D8F" stroke-width="2"/><rect x="13" y="13.5" width="6" height="4.5" rx="1.2" fill="#FBBF24" stroke="#92400E" stroke-width="1.2"/><path d="M3.8 24.5 V27 Q3.8 28 5 28 H8 M28.2 24.5 V27 Q28.2 28 27 28 H24" stroke="#FBBF24" stroke-width="2.4" fill="none" stroke-linecap="round"/><circle cx="16" cy="22.2" r="4.6" fill="#F4A236" stroke="#231F20" stroke-width="1.4"/><circle cx="14.3" cy="21.5" r="0.9" fill="#231F20"/><circle cx="17.7" cy="21.5" r="0.9" fill="#231F20"/><path d="M14.8 23.6 Q16 24.6 17.2 23.6" stroke="#231F20" stroke-width="1" fill="none" stroke-linecap="round"/></svg>`;
    }

    let advStatsTab = 'stats';      // 能力值頁目前的分頁：stats 基本素質 / moves 招式
    let advMoveFocus = '';          // 招式分頁：正在看哪一招的詳細資料
    function advSetStatsTab(t) { advStatsTab = ['moves', 'gear'].indexOf(t) !== -1 ? t : 'stats'; advRenderStatsPage(); }
    function advRenderStatsPage() {
        let s = advPlayerStats();
        // 能力條統一綠色；HP 低於 30% 變紅色
        const GREEN = '#10B981', RED = '#EF4444';
        let rows = ADV_STAT_DEFS.map(d => {
            let lvl = advData.up[d.key], maxed = lvl >= ADV_UP_MAX;
            let pct = Math.min(100, s[d.key] / ADV_BAR_MAX * 100);
            let tile, bar;
            if (d.key === 'hp') {
                // HP：方塊顯示「目前 / 最大」；實心條 = 目前體力，淡色底 = 最大體力
                let cur = Math.max(0, Math.min(advData.hp, s.hp)), low = cur / s.hp < 0.3, c = low ? RED : GREEN;
                tile = `<div class="adv-stat-tile${low ? ' low' : ''}">${d.label}<b>${cur}/${s.hp}</b></div>`;
                bar = `<div class="adv-bar" title="目前體力 ${cur}／最大體力 ${s.hp}"><i class="adv-bar-max" style="width:${pct.toFixed(1)}%;background:${c}"></i><i class="adv-bar-cur" style="width:${Math.min(100, cur / ADV_BAR_MAX * 100).toFixed(1)}%;background:${c}"></i></div>`;
            } else {
                tile = `<div class="adv-stat-tile">${d.label}<b>${s[d.key]}</b></div>`;
                bar = `<div class="adv-bar" title="已強化 ${lvl}/${ADV_UP_MAX}"><i style="width:${Math.max(0, pct).toFixed(1)}%;background:${GREEN}"></i></div>`;
            }
            return `<div class="adv-stat-row adv-stat-click" data-stat="${d.key}" role="button" title="點一下看能力介紹" data-on-click='[["advOpenStatInfo",["${d.key}"]]]'>
                ${tile}${bar}
                ${maxed ? '<span class="adv-maxed">滿</span>' : ''}<span class="adv-hit-chev">›</span>
            </div>`;
        }).join('');
        let nav = document.getElementById('advNavCounts');
        if (nav) nav.innerHTML = `<div class="adv-count">${advShardIcon(15)} <b id="advShardCount2">${advData.shards}</b></div>`;
        let box = document.getElementById('advStatsBox');
        if (!box) return;
        let oldGrid = document.getElementById('advMoveGrid'), keepScroll = oldGrid ? oldGrid.scrollTop : 0;
        let statsBody = `${advHitRowHTML()}<hr class="adv-hit-divider">${rows}`;
        box.innerHTML = `
            <div class="adv-hero">
                <div class="adv-avatar">${advChickenSVG()}</div>
                <div class="adv-mini-gear">${[0, 1].map(i => advMiniGearHTML(i)).join('')}</div>
                <button type="button" class="adv-bag-btn" title="背包" aria-label="背包" data-on-click='[["advOpenBag",[]]]'>${advBagIcon(54)}</button>
            </div>
            <div class="adv-card adv-stats-panel">
                <div class="adv-tabs" role="tablist">
                    <button type="button" role="tab" class="adv-tab${advStatsTab === 'stats' ? ' on' : ''}" data-on-click='[["advSetStatsTab",["stats"]]]'>基本素質</button>
                    <button type="button" role="tab" class="adv-tab${advStatsTab === 'moves' ? ' on' : ''}" data-on-click='[["advSetStatsTab",["moves"]]]'>招式</button>
                    <button type="button" role="tab" class="adv-tab${advStatsTab === 'gear' ? ' on' : ''}" data-on-click='[["advSetStatsTab",["gear"]]]'>裝備${advGearAlert() ? ADV_ALERT : ''}</button>
                </div>
                ${advStatsTab === 'moves' ? advMovesTabHTML() : advStatsTab === 'gear' ? advGearTabHTML() : statsBody}
            </div>`;
        let g = document.getElementById('advMoveGrid');
        if (g) g.scrollTop = keepScroll;
        advFitMoveGrid();
        advBindMoveSwipe();
        advCarDir = 0;
        advUpdateGearAlerts();
    }
    // ── 招式分頁：上面用下拉選單篩選，中間左右輪播（一次看一招），下面是詳細資料 ──
    const ADV_MOVE_FILTERS = [['all', '全部'], ['eq', '已裝備'], ['card', '字卡'], ['listen', '聽力'], ['speak', '朗讀']];
    let advCarDir = 0;              // 剛剛往哪邊切換（做滑入動畫用）
    function advMoveShown() {
        let owned = ADV_MOVES.filter(m => advOwns(m.key));
        if (advMoveFilter === 'all') return owned;
        if (advMoveFilter === 'eq') { let eq = advEquipped().map(m => m.key); return owned.filter(m => eq.includes(m.key)); }
        return owned.filter(m => m.type === advMoveFilter);
    }
    function advCarTri(rot) { return `<svg viewBox="0 0 24 24" width="24" height="24" style="transform:rotate(${rot}deg)" aria-hidden="true"><path d="M7 3 L19 12 L7 21 Z" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"/></svg>`; }
    function advMovesTabHTML() {
        let eqKeys = advEquipped().map(m => m.key);
        let ownedMoves = ADV_MOVES.filter(m => advOwns(m.key));
        let shown = advMoveShown(), n = shown.length;
        if (!advMoveFocus || !shown.some(m => m.key === advMoveFocus)) advMoveFocus = n ? (shown.find(m => eqKeys.includes(m.key)) || shown[0]).key : (eqKeys[0] || (ownedMoves[0] ? ownedMoves[0].key : ''));
        let idx = shown.findIndex(m => m.key === advMoveFocus);
        let car;
        if (!n) {
            car = `<div class="adv-car adv-car-empty" id="advMoveGrid"><div class="adv-note" style="margin:0;">${advMoveFilter === 'eq' ? '還沒有裝備招式' : `還沒有${ADV_TYPE_LABEL[advMoveFilter]}類的招式`}</div></div>`;
        } else {
            let m = shown[idx], mi = advMasteryInfo(m.key), on = eqKeys.includes(m.key);
            let L = n >= 3 ? shown[(idx - 1 + n) % n] : null, R = n >= 2 ? shown[(idx + 1) % n] : null;
            let side = (x, d) => x ? `<button type="button" class="adv-car-side rar-${advRarityKey(x.key)}" title="${x.name}" aria-label="${x.name}" data-on-click='[["advMoveStep",[${d}]]]'>${x.icon}</button>` : '<span class="adv-car-side ghost"></span>';
            car = `<div class="adv-car" id="advMoveGrid">
                <button type="button" class="adv-car-arr${n < 2 ? ' off' : ''}" aria-label="上一招" data-on-click='[["advMoveStep",[-1]]]'>${advCarTri(180)}</button>
                ${side(L, -1)}
                <div class="adv-move-card adv-car-center focus rar-${advRarityKey(m.key)}${on ? ' selected' : ''}${advCarDir ? (advCarDir > 0 ? ' go-r' : ' go-l') : ''}" data-move="${m.key}">
                    ${on ? '<span class="adv-eq-tag">已裝備</span>' : ''}
                    <span class="ic">${m.icon}</span>
                    <b>${m.name}${mi.lvl ? ` <span class="adv-lv-chip">Lv.${mi.lvl}</span>` : ''}</b>
                </div>
                ${side(R, 1)}
                <button type="button" class="adv-car-arr${n < 2 ? ' off' : ''}" aria-label="下一招" data-on-click='[["advMoveStep",[1]]]'>${advCarTri(0)}</button>
                <div class="adv-car-dots">${shown.map((x, i) => `<i class="${i === idx ? 'on' : ''}"></i>`).join('')}</div>
            </div>
            <div class="adv-car-hint">${n >= 2 ? `◀ 左右滑動選擇招式 ▶（${idx + 1} / ${n}）` : '（1 / 1）'}</div>`;
        }
        return `
            <div class="adv-sec-title">招式選擇　<span id="advEquipCount">已裝備 ${eqKeys.length}/${ADV_MAX_EQUIP}</span>
                <select class="adv-move-filter" aria-label="篩選招式" data-on-change='[["advSetMoveFilter",["$value"]]]'>
                    ${ADV_MOVE_FILTERS.map(o => `<option value="${o[0]}"${advMoveFilter === o[0] ? ' selected' : ''}>${o[1]}</option>`).join('')}
                </select></div>
            ${car}
            <div class="adv-move-detail" id="advMoveDetail">${advMoveDetailHTML(advMoveFocus)}</div>`;
    }
    let advCarSwipeAt = 0;
    function advMoveStep(d) {
        if (Date.now() - advCarSwipeAt < 350) return;     // 剛用滑的切換過，忽略接著觸發的點擊
        advMoveStepGo(d);
    }
    function advMoveStepGo(d) {
        let shown = advMoveShown(), n = shown.length;
        if (n < 2) return;
        let idx = Math.max(0, shown.findIndex(m => m.key === advMoveFocus));
        d = parseInt(d) < 0 ? -1 : 1;
        advMoveFocus = shown[(idx + d + n) % n].key;
        advCarDir = d;
        advRenderStatsPage();
    }
    // 手機左右滑動（滑鼠拖曳也可以）
    function advBindMoveSwipe() {
        let el = document.getElementById('advMoveGrid');
        if (!el || !el.classList.contains('adv-car') || el._swipe) return;
        el._swipe = true;
        let x0 = null, y0 = 0;
        el.addEventListener('pointerdown', e => { x0 = e.clientX; y0 = e.clientY; });
        el.addEventListener('pointerup', e => {
            if (x0 === null) return;
            let dx = e.clientX - x0, dy = e.clientY - y0; x0 = null;
            if (Math.abs(dx) > 30 && Math.abs(dx) > Math.abs(dy)) { advMoveStepGo(dx < 0 ? 1 : -1); advCarSwipeAt = Date.now(); }
        });
        el.addEventListener('pointercancel', () => { x0 = null; });
    }
    function advMoveCardHTML(m, eqKeys) {
        let on = eqKeys.includes(m.key), mi = advMasteryInfo(m.key);
        return `<div class="select-card adv-move-card rar-${advRarityKey(m.key)}${on ? ' selected' : ''}${m.key === advMoveFocus ? ' focus' : ''}" data-move="${m.key}" data-on-click='[["advFocusMove",["${m.key}"]]]'>
                <div class="select-card-info">
                    <div class="select-card-title">${m.icon} ${m.name}${mi.lvl ? ` <span class="adv-lv-chip">Lv.${mi.lvl}</span>` : ''}</div>
                </div>
                ${on ? '<span class="adv-eq-tag">已裝備</span>' : ''}
            </div>`;
    }
    function advMoveDetailHTML(key) {
        let m = advMoveByKey(key);
        if (!m || !advOwns(key)) return '<div class="adv-note" style="margin:0;">點上面的招式，就會在這裡顯示詳細資料。</div>';
        let r = advRarity(key), rk = advRarityKey(key), mi = advMasteryInfo(key), on = advEquipped().some(x => x.key === key);
        let pct = mi.maxed ? 100 : Math.max(0, Math.min(100, (mi.uses - mi.prev) / (mi.next - mi.prev) * 100));
        let prog = mi.maxed ? `已達上限（共 ${mi.uses} 次）` : `${mi.uses} / ${mi.next}`;
        return `
            <div class="adv-md-stats">
                <div>類型<b>${ADV_TYPE_LABEL[m.type]}</b></div>
                <div>威力<b>${m.power}${mi.lvl ? `<em>+${mi.lvl}</em>` : ''}</b></div>
                <div>攻擊次數<b>${m.hits}</b></div>
                <div>題數<b>${m.q}</b></div>
            </div>
            <div class="adv-md-desc">${m.desc}</div>
            <div class="adv-md-mastery">
                <div class="adv-md-mrow"><span>熟練度 <b>${mi.lvl}</b><small>／${mi.cap}</small></span><small class="prog">${prog}</small></div>
                <div class="adv-bar adv-md-bar"><i style="width:${pct.toFixed(1)}%;background:${r.color}"></i></div>
            </div>
            <button type="button" class="adv-md-btn${on ? ' off' : ''}" data-on-click='[["advToggleMove",["${key}"]]]'>${on ? '卸下這招' : '裝備這招'}</button>`;
    }
    function advFocusMove(key) {
        if (!advOwns(key)) return;
        if (!advMoveShown().some(m => m.key === key)) advMoveFilter = 'all';
        advMoveFocus = key;
        advRenderStatsPage();
    }
    // 招式格子一次只看得到 4 張（手機 1 欄 × 4、寬螢幕 2 欄 × 2），其他用右邊的捲軸
    function advFitMoveGrid() {
        let g = document.getElementById('advMoveGrid');
        if (!g) return;
        let cards = g.querySelectorAll('.adv-move-card');
        if (cards.length <= 4 || !cards[3].offsetHeight) { g.style.maxHeight = ''; return; }
        g.style.maxHeight = Math.ceil(cards[3].offsetTop + cards[3].offsetHeight + 6) + 'px';
    }
    window.addEventListener('resize', () => { try { advFitMoveGrid(); } catch (e) {} });
    // ── 招式篩選（全部／字卡／聽力／朗讀）──
    let advMoveFilter = 'all';
    function advSetMoveFilter(v) {
        advMoveFilter = ADV_MOVE_FILTERS.some(o => o[0] === v) ? v : 'all';
        let g = document.getElementById('advMoveGrid'); if (g) g.scrollTop = 0;
        advRenderStatsPage();
    }
    // ── 裝備欄：左手、右手各放 1 個裝備 ──
    function advMiniGearHTML(i) {
        let k = advData.gear[i], it = k ? ADV_ITEMS[k] : null;
        return `<button type="button" class="adv-mini-slot${it ? ' rar-' + advItemRarityKey(k) : ' empty'}" title="${ADV_HANDS[i]}${it ? '：' + it.name : '（空的）'}" aria-label="${ADV_HANDS[i]}${it ? '：' + it.name : '（空的）'}" data-on-click='[["advOpenGearSlot",[${i}]]]'>${it ? it.icon(24) : '<span>＋</span>' + (advGearAlert() ? ADV_ALERT : '')}</button>`;
    }
    function advGearTabHTML() {
        let n = advData.gear.filter(Boolean).length;
        let slot = i => {
            let k = advData.gear[i], it = k ? ADV_ITEMS[k] : null;
            if (!it) return `<button type="button" class="adv-gear-slot empty" data-on-click='[["advOpenGearSlot",[${i}]]]'>＋ ${ADV_HANDS[i]}（空的）${advGearAlert() ? ADV_ALERT : ''}</button>`;
            return `<button type="button" class="adv-gear-slot rar-${advItemRarityKey(k)}" data-on-click='[["advOpenGearSlot",[${i}]]]'>
                <span class="ico">${it.icon(36)}</span><span class="txt"><span class="no">${ADV_HANDS[i]}</span><b>${it.name}</b><small>${it.desc}</small></span></button>`;
        };
        return `<div class="adv-sec-title">裝備欄　<span>已裝備 ${n}/2</span></div>
            <div class="adv-gear-slots">${slot(0)}${slot(1)}</div>`;
    }
    // 有空的裝備欄，而且背包裡還有沒裝備的裝備
    function advGearAlert() {
        let g = advData.gear;
        if (g.every(Boolean)) return false;
        return Object.keys(ADV_ITEMS).some(k => advData.items[k] && !g.includes(k));
    }
    const ADV_ALERT = '<span class="adv-alert" aria-label="還可以裝備">!</span>';
    function advUpdateGearAlerts() {
        let on = advGearAlert();
        document.querySelectorAll('.adv-btn-sm[data-on-click*="goToAdvStats"]').forEach(b => {
            let a = b.querySelector('.adv-alert');
            if (on && !a) b.insertAdjacentHTML('beforeend', ADV_ALERT);
            else if (!on && a) a.remove();
        });
    }
    function advOpenGearSlot(i) { advOpenBag('gear', parseInt(i) === 1 ? 1 : 0); }
    // 裝備／卸下：從左手或右手打開背包 → 放進那一手；從背包直接打開 → 放進空著的那一手
    function advToggleEquip(key) {
        if (!ADV_ITEMS[key] || !advData.items[key]) return;
        let g = advData.gear, at = g.indexOf(key), fromSlot = advBagSlot !== null;
        if (fromSlot) {
            if (g[advBagSlot] === key) g[advBagSlot] = '';
            else { if (at !== -1) g[at] = ''; g[advBagSlot] = key; }
        } else if (at !== -1) {
            g[at] = '';
        } else {
            let e = g.indexOf('');
            if (e === -1) { alert('左手、右手都已經有裝備了。\n請到「裝備」分頁點要更換的那一手。'); return; }
            g[e] = key;
        }
        advSave();
        advRenderStatsPage();
        if (fromSlot) advCloseBag(); else advBagBack();
    }
    // ── 命中：能力值頁最上面一條；點進去看字卡／聽力／朗讀 ──
    function advHitRowHTML() {
        let a = advHitAll(), t = advHitTotal();
        let tile = t === null ? `<div class="adv-stat-tile hit">命中<b class="wait">累積中</b></div>` : `<div class="adv-stat-tile hit">命中<b>${t}%</b></div>`;
        let bar = t === null
            ? `<div class="adv-bar"><i class="adv-hit-wait" style="width:${(Math.min(a.length, ADV_HIT_N) / ADV_HIT_N * 100).toFixed(1)}%"></i></div>`
            : `<div class="adv-bar"><i style="width:${t}%;background:#EAB308"></i></div>`;
        return `<div class="adv-stat-row adv-hit-row" data-stat="hit" role="button" title="點一下看字卡、聽力、朗讀的命中" data-on-click='[["advOpenHit",[]]]'>${tile}${bar}<span class="adv-hit-chev">›</span></div>`;
    }
    // ── 能力介紹：全部能力放同一頁，順序跟能力值頁一樣（只說用途，不寫公式）──
    const ADV_STAT_INFO = {
        hp:   '每點一次，HP 上限 +1。',
        atk:  '每點一次，攻擊力 +1。',
        agi:  '比對手快，一回合就能多出幾招。',
        def:  '減少每次被打到的傷害。',
        int:  '智慧越高護盾越高，護盾扣完才扣 HP；能增加作答時間。',
        luck: '攻擊時會擲幣，擲到正面就多打 1 點；打贏後也有機會多拿碎片。'
    };
    function advOpenStatInfo(key) {
        let body = document.getElementById('advHitBody');
        if (!body) return;
        body.innerHTML = `<div class="adv-hit-title">📖 能力介紹</div>
            <div class="adv-si-list">${ADV_STAT_DEFS.map(d => `<div class="adv-si-row${d.key === key ? ' on' : ''}" data-stat="${d.key}"><span class="adv-si-lab" style="background:${d.color}">${d.label}</span><p>${ADV_STAT_INFO[d.key]}</p></div>`).join('')}</div>`;
        document.getElementById('advHitModal').style.display = 'block';
    }
    // 命中率的評價（黃色框）
    function advHitComment(p) {
        if (p >= 100) return '👑 傳奇人物！每一題都答對，完美無缺！';
        if (p >= 90) return '🌟 根本是神！單字幾乎都難不倒你！';
        if (p >= 80) return '🔥 超強！敵人快要擋不住你了！';
        if (p >= 70) return '💪 很穩喔！大部分的單字你都記住了，繼續保持！';
        if (p >= 60) return '🙂 還不錯！再多練習一點，命中會越來越高。';
        return '📚 命中還不到 60%，先去多背幾個單字，再回來打會輕鬆很多！';
    }
    const ADV_HIT_TIPS = { card: '「字卡練習」或「字卡測驗」', listen: '「聽力練習」或「聽力測驗」', speak: '「朗讀練習」' };
    function advOpenHit() {
        let body = document.getElementById('advHitBody');
        if (!body) return;
        let a = advHitAll(), t = advHitTotal(), cur = advHitPct(a);
        let big, sub;
        if (t !== null) {
            let diff = advData.hitPrev === null ? 0 : t - advData.hitPrev;
            big = `${t}%`; sub = `總命中${diff ? `　<span class="${diff > 0 ? 'up' : 'down'}">${diff > 0 ? '↑' : '↓'} 比上次 ${diff > 0 ? '+' : ''}${diff}%</span>` : ''}`;
        } else if (a.length) {
            big = `${cur}%`; sub = `總命中（目前 ${a.length}/${ADV_HIT_N} 題，還在累積）`;
        } else {
            big = '—'; sub = '還沒有紀錄，去大冒險打一場吧！';
        }
        let weakest = null;
        let lines = ['card', 'listen', 'speak'].map(k => {
            let arr = advData.hits[k], p = advHitPct(arr), full = arr.length >= ADV_HIT_N;
            if (!full) return `<div class="adv-hit-line"><span class="lab">${ADV_TYPE_LABEL[k]}</span><div class="adv-bar"><i class="adv-hit-wait" style="width:${(arr.length / ADV_HIT_N * 100).toFixed(1)}%"></i></div><span class="val">累積中<small>${arr.length}/${ADV_HIT_N} 題</small></span></div>`;
            if (weakest === null || p < weakest.p) weakest = { k, p };
            return { k, p, html: (low) => `<div class="adv-hit-line"><span class="lab">${ADV_TYPE_LABEL[k]}</span><div class="adv-bar"><i style="width:${p}%;background:${low ? '#F97316' : '#EAB308'}"></i></div><span class="val${low ? ' low' : ''}">${p}%<small>${arr.reduce((x, y) => x + y, 0)}/${ADV_HIT_N} 題</small></span></div>` };
        });
        let weakKey = weakest && weakest.p < 70 ? weakest.k : '';
        let html = lines.map(l => typeof l === 'string' ? l : l.html(l.k === weakKey)).join('');
        let tip = t !== null ? advHitComment(t) : a.length ? advHitComment(cur) : '🗡️ 去大冒險打一場，就會開始累積命中！';
        body.innerHTML = `<div class="adv-hit-title">🎯 命中</div>
            <div class="adv-hit-sub">字卡、聽力、朗讀各算最近 ${ADV_HIT_N} 題（時間到算錯）</div>
            <div class="adv-hit-total">${big}<small>${sub}</small></div>
            ${html}
            <div class="adv-hit-tip">${tip}</div>`;
        document.getElementById('advHitModal').style.display = 'block';
    }
    function advCloseHit() { document.getElementById('advHitModal').style.display = 'none'; }

    // ── 背包：九宮格；右上角篩選（全部／道具／物品）；點格子看說明再使用 ──
    //   道具 = 可以放進裝備欄的東西（同時只能裝 1 個）；物品 = 用掉就沒了的消耗品
    let advBagFilter = 'all';
    function advPotionIcon(size) { return `<span style="font-size:${Math.round(size * 0.82)}px;line-height:1">🧪</span>`; }
    function advBagDefs() {
        let defs = [
            { key: 'sauce',  kind: 'item', name: '糖醋醬',   icon: s => advSauceIcon(s),  n: advData.sauce,   desc: `使用後讓任一項能力 +1（每項最多強化 ${ADV_UP_MAX} 次）`, act: '使用', fn: 'advBagSauce' },
            { key: 'potion', kind: 'item', name: '恢復藥水', icon: s => advPotionIcon(s), n: advData.potions, desc: `使用後 HP +${ADV_POTION_HEAL}（目前 ${advData.hp}/${advMaxHp()}）`, act: '使用', fn: 'advBagUsePotion' },
            { key: 'ticket', kind: 'item', name: '冒險卷',   icon: s => advTicketIcon(s), n: advData.tickets, desc: `今天「重複挑戰已通關關卡」的次數 +1（今天還能挑戰 ${advReplaysLeft()} 次）`, act: '使用', fn: 'advBagUseTicket' },
            { key: 'wipe',   kind: 'item', name: '濕紙巾',   icon: s => advWipeIcon(s),   n: advData.wipes,   desc: '把 1 點已強化的能力，轉移到另一項能力', act: '使用', fn: 'advBagWipe' }
        ];
        Object.keys(ADV_ITEMS).forEach(k => {
            if (!advData.items[k]) return;
            let it = ADV_ITEMS[k], at = advData.gear.indexOf(k), on = at !== -1;
            let act = advBagSlot !== null ? (advData.gear[advBagSlot] === k ? '卸下' : `裝備到${ADV_HANDS[advBagSlot]}`) : (on ? '卸下' : '裝備');
            defs.push({ key: k, kind: 'gear', name: it.name, icon: s => it.icon(s), n: 1, on: on, hand: on ? ADV_HANDS[at] : '', off: act === '卸下', desc: it.desc, act: act, fn: 'advToggleEquip' });
        });
        return defs;
    }
    function advBagCount() { return advData.sauce + advData.potions + advData.tickets + advData.wipes + Object.keys(advData.items).filter(k => advData.items[k]).length; }
    let advBagGearOnly = false;     // 從「裝備欄」打開：只顯示裝備
    let advBagSlot = null;          // 從左手(0)／右手(1)打開時，裝備會放進那一手
    let advBagSel = '';             // 目前點選、在下方顯示說明的東西
    function advSetBagFilter(v) { advBagFilter = ['all', 'gear', 'item'].indexOf(v) !== -1 ? v : 'all'; advBagSel = ''; advBagBack(); }
    function advOpenBag(mode, slot) {
        advBagGearOnly = mode === 'gear';
        advBagSlot = advBagGearOnly && (slot === 0 || slot === 1) ? slot : null;
        advBagFilter = advBagGearOnly ? 'gear' : 'all';
        advBagSel = advBagSlot !== null ? (advData.gear[advBagSlot] || '') : '';
        advBagBack();
        document.getElementById('advBagModal').style.display = 'block';
    }
    function advCloseBag() { document.getElementById('advBagModal').style.display = 'none'; }
    function advBagBack() {
        let body = document.getElementById('advBagBody');
        if (!body) return;
        if (advBagGearOnly) advBagFilter = 'gear';
        let defs = advBagDefs().filter(d => d.kind === 'gear' || d.n > 0).filter(d => advBagFilter === 'all' || d.kind === advBagFilter);
        if (advBagSel && !defs.some(d => d.key === advBagSel)) advBagSel = '';
        let cells = defs.map(d => `<button type="button" class="adv-bag-cell${d.on ? ' is-on' : ''}${d.kind === 'gear' ? ' rar-' + advItemRarityKey(d.key) : ''}${d.key === advBagSel ? ' sel' : ''}" data-on-click='[["advBagTap",["${d.key}"]]]'>
                <span class="adv-bag-cico">${d.icon(34)}</span><b>${d.name}</b><small>${d.kind === 'gear' ? (d.on ? d.hand : '裝備') : '×' + d.n}</small></button>`);
        let total = Math.max(9, Math.ceil(cells.length / 3) * 3);
        while (cells.length < total) cells.push('<div class="adv-bag-cell empty"></div>');
        if (!defs.length && advBagGearOnly) cells = [];
        body.innerHTML = `<div class="adv-bag-head">
                <div class="adv-bag-title">${advBagGearOnly ? `${advSkewerIcon(20)} ${advBagSlot !== null ? '選擇' + ADV_HANDS[advBagSlot] + '的裝備' : '裝備欄'}` : `${advBagIcon(22)} 背包`}</div>
                ${advBagGearOnly ? '' : `<select class="adv-bag-filter" aria-label="篩選背包" data-on-change='[["advSetBagFilter",["$value"]]]'>
                    ${[['all', '全部'], ['gear', '裝備'], ['item', '道具']].map(o => `<option value="${o[0]}"${advBagFilter === o[0] ? ' selected' : ''}>${o[1]}</option>`).join('')}
                </select>`}
            </div>
            <div class="adv-bag-grid">${cells.join('')}</div>
            <div class="adv-bag-info">${advBagInfoHTML(defs)}</div>`;
    }
    // 九宮格下面的說明欄（點了哪一格就顯示哪一格）
    function advBagInfoHTML(defs) {
        if (advBagGearOnly && !defs.length) return '<div class="adv-bag-hint">還沒有裝備（打贏第 4、5、12 關可以拿到）。</div>';
        let d = defs.find(x => x.key === advBagSel);
        if (!d) return '<div class="adv-bag-hint">點一下上面的東西，這裡會顯示說明。</div>';
        let rk = d.kind === 'gear' ? advItemRarityKey(d.key) : '';
        return `<div class="adv-bag-detail">
                <div class="adv-bag-dico">${d.icon(56)}</div>
                <div class="adv-bag-dtxt"><div class="adv-bag-dkind">${d.kind === 'gear' ? `🛡️ 裝備${d.on ? '（' + d.hand + '）' : ''}　<span class="adv-rar-badge rar-${rk}">${ADV_RARITY[rk].label}</span>` : `📦 道具　持有 ×${d.n}`}</div><b class="adv-bag-dname">${d.name}</b><p>${d.desc}</p></div>
            </div>
            <button type="button" class="adv-plain-btn ${d.off ? 'danger' : 'main'}" ${d.kind === 'item' && d.n < 1 ? 'disabled' : ''} data-on-click='[["${d.fn}",["${d.key}"]]]'>${d.act}</button>
            <button type="button" class="adv-plain-btn sub" style="margin-top:8px;" data-on-click='[["advBagUnselect",[]]]'>返回</button>`;
    }
    function advBagTap(key) { advBagSel = key; advBagBack(); }
    function advBagUnselect() { advBagSel = ''; advBagBack(); }
    // 冒險卷：今天的重複挑戰次數 +1
    function advBagUseTicket() {
        if (advData.tickets < 1) return;
        if (!confirm(`要使用 1 張冒險卷嗎？\n\n今天重複挑戰已通關關卡的次數 +1（目前還能挑戰 ${advReplaysLeft()} 次）`)) return;
        let today = getLocalDateStr();
        if (advData.replayBonusDay !== today) { advData.replayBonusDay = today; advData.replayBonus = 0; }
        advData.replayBonus += 1;
        advData.tickets -= 1;
        advSave();
        advBagBack();
        advRenderStatsPage();
        try { if (document.getElementById('advLevelView').classList.contains('active')) advRenderLevelPage(); } catch (e) {}
        alert(`🎫 使用冒險卷！今天還能重複挑戰 ${advReplaysLeft()} 次。`);
    }
    // 濕紙巾：把 1 點已強化的能力轉到另一項
    function advStatLabel(k) { let d = ADV_STAT_DEFS.find(x => x.key === k); return d ? d.label : k; }
    function advBagWipe() {
        let body = document.getElementById('advBagBody');
        if (!body || advData.wipes < 1) return;
        let s = advPlayerStats();
        let rows = ADV_STAT_DEFS.map(d => {
            let can = advData.up[d.key] > 0;
            return `<button type="button" class="adv-bag-item" ${can ? '' : 'disabled'} data-on-click='[["advWipeFrom",["${d.key}"]]]'>
                <span class="adv-bag-txt"><b>${d.label}</b><small>目前 ${s[d.key]}（已強化 ${advData.up[d.key]} 次）</small></span><span class="adv-bag-count">${can ? '選這項' : '—'}</span></button>`;
        }).join('');
        body.innerHTML = `<div class="adv-bag-title">${advWipeIcon(24)} 要從哪一項拿出 1 點？</div>${rows}
            <button type="button" class="adv-plain-btn sub" style="margin-top:8px;" data-on-click='[["advBagBack",[]]]'>返回</button>`;
    }
    function advWipeFrom(from) {
        let body = document.getElementById('advBagBody');
        if (!body || advData.wipes < 1 || !(advData.up[from] > 0)) return;
        let s = advPlayerStats();
        let rows = ADV_STAT_DEFS.filter(d => d.key !== from).map(d => {
            let can = advData.up[d.key] < ADV_UP_MAX;
            return `<button type="button" class="adv-bag-item" ${can ? '' : 'disabled'} data-on-click='[["advWipeApply",["${from}","${d.key}"]]]'>
                <span class="adv-bag-txt"><b>${d.label}</b><small>${s[d.key]} → ${s[d.key] + 1}</small></span><span class="adv-bag-count">${can ? '+1' : '已滿'}</span></button>`;
        }).join('');
        body.innerHTML = `<div class="adv-bag-title">${advWipeIcon(24)} 把 1 點「${advStatLabel(from)}」轉到哪一項？</div>
            <div class="adv-note" style="margin:0 0 8px;">${advStatLabel(from)}：${s[from]} → ${s[from] - 1}</div>${rows}
            <button type="button" class="adv-plain-btn sub" style="margin-top:8px;" data-on-click='[["advBagWipe",[]]]'>上一步</button>`;
    }
    function advWipeApply(from, to) {
        if (advData.wipes < 1 || from === to || !(advData.up[from] > 0) || !Object.prototype.hasOwnProperty.call(advData.up, to) || advData.up[to] >= ADV_UP_MAX) return;
        if (!confirm(`要用 1 張濕紙巾，把 1 點「${advStatLabel(from)}」轉到「${advStatLabel(to)}」嗎？`)) return;
        advSyncDaily();
        advData.wipes -= 1;
        advData.up[from] -= 1;
        advData.up[to] += 1;
        if (to === 'hp') advData.hp += 1;                      // 最大體力 +1 的同時，目前體力也 +1
        advData.hp = Math.max(0, Math.min(advData.hp, advMaxHp()));
        advSave();
        advCloseBag();
        advRenderStatsPage();
    }
    function advBagSauce() {
        let body = document.getElementById('advBagBody');
        if (!body || advData.sauce < 1) return;
        let s = advPlayerStats();
        let rows = ADV_STAT_DEFS.map(d => {
            let maxed = advData.up[d.key] >= ADV_UP_MAX;
            return `<button type="button" class="adv-bag-item" ${maxed ? 'disabled' : ''} data-on-click='[["advBagUseSauce",["${d.key}"]]]'>
                <span class="adv-bag-txt"><b>${d.label}</b><small>${s[d.key]} → ${s[d.key] + 1}</small></span><span class="adv-bag-count">${maxed ? '已滿' : '+1'}</span></button>`;
        }).join('');
        body.innerHTML = `<div class="adv-bag-title">${advSauceIcon(24)} 要強化哪一項？</div>${rows}
            <button type="button" class="adv-plain-btn sub" style="margin-top:8px;" data-on-click='[["advBagBack",[]]]'>返回</button>`;
    }
    function advBagUseSauce(key) {
        if (advData.sauce < 1) return;
        advUpgrade(key);
        advCloseBag();
    }
    function advBagUsePotion() {
        advSyncDaily();
        let max = advMaxHp();
        if (advData.potions < 1) return;
        if (advData.hp >= max) { alert('體力已經是滿的，不需要用藥水喔！'); return; }
        advData.potions -= 1;
        advData.hp = Math.min(max, advData.hp + ADV_POTION_HEAL);
        advSave();
        advCloseBag();
        advRenderStatsPage();
    }
    function advMoreLabel(owned, eqKeys) {
        let rest = owned.slice(ADV_MOVES_SHOWN), eqIn = rest.filter(m => eqKeys.includes(m.key)).length;
        return advMovesOpen ? '▲ 收起' : `▼ 更多招式（還有 ${rest.length} 招${eqIn ? `，其中 ${eqIn} 招已裝備` : ''}）`;
    }
    function advToggleMoreMoves() {
        advMovesOpen = !advMovesOpen;
        let g = document.getElementById('advMoveGrid'), b = document.getElementById('advMoreBtn');
        if (g) g.classList.toggle('adv-more-closed', !advMovesOpen);
        if (b) { let eq = advEquipped().map(m => m.key); b.textContent = advMoreLabel(ADV_MOVES.filter(m => advOwns(m.key)), eq); }
    }
    function advToggleMove(key) {
        let m = advMoveByKey(key);
        if (!m || !advOwns(key)) return;
        advData.eq = advData.eq.filter(k => advOwns(k));
        let i = advData.eq.indexOf(key);
        if (i >= 0) {
            if (advData.eq.length <= ADV_MIN_EQUIP) { alert(`至少要裝備 ${ADV_MIN_EQUIP} 招喔！`); return; }
            advData.eq.splice(i, 1);
        } else {
            if (advData.eq.length >= ADV_MAX_EQUIP) { alert(`最多只能裝備 ${ADV_MAX_EQUIP} 招，請先取消其他招式。`); return; }
            advData.eq.push(key);
        }
        advSave();
        advRenderStatsPage();
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

    // ── 雞塊補給站：三個分頁 ──
    //   0 單字庫（原本的兩個商品，寫在 HTML 裡）／1 雞塊大冒險／2 其他
    let advShopTab = 0;
    function setShopTab(i) { advShopTab = Math.max(0, Math.min(2, parseInt(i) || 0)); advShopFilter = 'all'; advRenderShopBox(); }
    function advWeekId() {
        // 每週從星期一開始，以台灣時間（UTC+8）計算；後端用同樣的規則
        let t = new Date(Date.now() + 8 * 3600 * 1000);
        let back = (t.getUTCDay() + 6) % 7;
        return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() - back)).toISOString().slice(0, 10);
    }
    // 補給站右上角的篩選：每個分頁各自的選項（之後新增單字庫再加）
    const ADV_SHOP_FILTERS = [
        [['all', '全部']],
        [['all', '全部'], ['item', '道具'], ['gear', '裝備'], ['move', '招式']],
        [['all', '全部']]
    ];
    let advShopFilter = 'all';
    function advSetShopFilter(v) { advShopFilter = String(v || 'all'); advRenderShopBox(); }
    function advShopCell(o) {
        return `<button type="button" id="${o.id}" data-kind="${o.kind || 'item'}" class="shop-cell shop-item${o.off ? ' is-maxed' : ''}${o.poor ? ' is-poor' : ''}${o.cls ? ' ' + o.cls : ''}" data-on-click='${o.action}'>
            <div class="shop-emoji">${o.icon}</div>
            <div class="shop-name">${o.name}</div>
            <div class="shop-sub">${o.sub}</div>
            <div class="shop-price">${o.price}</div>
        </button>`;
    }
    const advChickenPrice = (n) => `<span class="chicken-mini"></span><b>${n}</b>`;
    const advShardPrice = (n) => `${advShardIcon(15)}<b>${n}</b>`;
    function advRenderShopBox() {
        let sc = document.getElementById('advShopShardCount');
        if (sc) sc.textContent = advData.shards;
        for (let i = 0; i < 3; i++) {
            let tab = document.getElementById('shopTab' + i), pane = document.getElementById('shopPane' + i);
            if (tab) tab.classList.toggle('active', i === advShopTab);
            if (pane) pane.style.display = i === advShopTab ? '' : 'none';
        }
        advSyncDaily();
        let max = advMaxHp();
        // 分頁 2：雞塊大冒險
        let cells = [];
        cells.push(advShopCell({ id: 'advCell_sauce', icon: advSauceIcon(46), name: '糖醋醬', sub: `${ADV_SHARDS_PER_SAUCE} 碎片 → 1 瓶（持有 ${advData.sauce}）`, price: advShardPrice(ADV_SHARDS_PER_SAUCE), poor: advData.shards < ADV_SHARDS_PER_SAUCE, action: '[["advExchangeShards",[]]]' }));
        cells.push(advShopCell({ id: 'advCell_potion', icon: '🧪', name: '恢復藥水', sub: `HP +${ADV_POTION_HEAL}（持有 ${advData.potions}）`, price: advShardPrice(ADV_POTION_COST), poor: advData.shards < ADV_POTION_COST, action: '[["advBuyPotion",[]]]' }));
        cells.push(advShopCell({ id: 'advCell_wipe', icon: advWipeIcon(46), name: '濕紙巾', sub: `能力 1 點轉移（持有 ${advData.wipes}）`, price: advShardPrice(ADV_WIPE_COST), poor: advData.shards < ADV_WIPE_COST, action: '[["advBuyWipe",[]]]' }));
        let hasSoda = !!advData.items.soda;
        cells.push(advShopCell({ id: 'advCell_soda', kind: 'gear', icon: advSodaIcon(46), name: '彈珠汽水', sub: `普通裝備｜${ADV_ITEMS.soda.desc}`, price: hasSoda ? '已擁有' : advShardPrice(ADV_SODA_PRICE), off: hasSoda, poor: !hasSoda && advData.shards < ADV_SODA_PRICE, cls: 'rar-common', action: '[["advBuySoda",[]]]' }));
        ADV_MOVES.filter(m => m.buy.kind === 'shards').forEach(m => {
            let own = advOwns(m.key);
            let price = own ? '已擁有' : (m.buy.kind === 'shards' ? advShardPrice(m.buy.price) : advChickenPrice(m.buy.price));
            let poor = !own && (m.buy.kind === 'shards' ? advData.shards < m.buy.price : wallet.balance < m.buy.price);
            cells.push(advShopCell({ id: 'shopItem_' + (m.buy.item || 'mv_' + m.key), kind: 'move', icon: m.icon, name: m.name, sub: `${advRarity(m.key).label} ｜ 威力 ${m.power}${m.hits > 1 ? '×' + m.hits : ''} ｜ ${m.q} 題 ｜ ${ADV_TYPE_LABEL[m.type]}`, price: price, off: own, poor: poor, cls: 'rar-' + advRarityKey(m.key), action: `[["advBuyMove",["${m.key}"]]]` }));
        });
        // 篩選：全部／道具／裝備／招式（沒寫 kind 的是道具）
        let f = ADV_SHOP_FILTERS[advShopTab] || ADV_SHOP_FILTERS[0];
        if (!f.some(o => o[0] === advShopFilter)) advShopFilter = 'all';
        let sel = document.getElementById('shopFilter');
        if (sel) { sel.innerHTML = f.map(o => `<option value="${o[0]}"${o[0] === advShopFilter ? ' selected' : ''}>${o[1]}</option>`).join(''); sel.style.display = ''; }
        if (advShopTab === 1 && advShopFilter !== 'all') cells = cells.filter(c => (c.match(/data-kind="(\w+)"/) || [0, 'item'])[1] === advShopFilter);
        while (cells.length < 9) cells.push('<div class="shop-cell shop-empty"></div>');
        let p1 = document.getElementById('shopPane1');
        if (p1) p1.innerHTML = cells.join('');
        // 分頁 3：其他
        let week = advWeekId(), done = advData.weekDone === week;
        let c3 = [advShopCell({ id: 'advCell_weekly', icon: '<span class="chicken-mini" style="width:46px;height:46px;"></span>', name: '每週雞塊', sub: done ? '本週已兌換（下週一再來）' : `${ADV_WEEKLY_SHARDS} 碎片 → ${ADV_WEEKLY_CHICKENS} 雞塊（每週 1 次）`, price: done ? '已兌換' : advShardPrice(ADV_WEEKLY_SHARDS), off: done, poor: !done && advData.shards < ADV_WEEKLY_SHARDS, action: '[["advWeeklyExchange",[]]]' })];
        while (c3.length < 9) c3.push('<div class="shop-cell shop-empty"></div>');
        let p2 = document.getElementById('shopPane2');
        if (p2) p2.innerHTML = c3.join('');
    }
    // 補給站右上角的碎片數字旁，跳出「-15」之類的紅色數字（跟雞塊一樣）
    function advShardFloat(n) { if (n) showChickenFloat('advShopShardCount', (n > 0 ? '+' : '-') + Math.abs(n), n > 0 ? '#10B981' : '#EF4444'); }
    function advExchangeShards() {
        if (advData.shards < ADV_SHARDS_PER_SAUCE) { alert(`碎片不足！需要 ${ADV_SHARDS_PER_SAUCE} 個，目前有 ${advData.shards} 個。`); return; }
        advData.shards -= ADV_SHARDS_PER_SAUCE;
        advData.sauce += 1;
        advSave();
        advRenderShopBox();
        advShardFloat(-ADV_SHARDS_PER_SAUCE);
    }
    function advBuyPotion() {
        if (advData.shards < ADV_POTION_COST) { alert(`碎片不足！需要 ${ADV_POTION_COST} 個，目前有 ${advData.shards} 個。`); return; }
        advData.shards -= ADV_POTION_COST;
        advData.potions += 1;
        advSave();
        advRenderShopBox();
        advShardFloat(-ADV_POTION_COST);
    }
    function advBuySoda() {
        if (advData.items.soda) { alert('已經擁有彈珠汽水了。'); return; }
        if (advData.shards < ADV_SODA_PRICE) { alert(`碎片不足！需要 ${ADV_SODA_PRICE} 個，目前有 ${advData.shards} 個。`); return; }
        advData.shards -= ADV_SODA_PRICE;
        advData.items.soda = true;
        advSave();
        advRenderShopBox();
        advShardFloat(-ADV_SODA_PRICE);
        advUpdateGearAlerts();
        alert('🥤 買到彈珠汽水了！\n到「💪 能力值 → 裝備」把它裝備起來吧。');
    }
    function advBuyWipe() {
        if (advData.shards < ADV_WIPE_COST) { alert(`碎片不足！需要 ${ADV_WIPE_COST} 個，目前有 ${advData.shards} 個。`); return; }
        advData.shards -= ADV_WIPE_COST;
        advData.wipes += 1;
        advSave();
        advRenderShopBox();
        advShardFloat(-ADV_WIPE_COST);
    }
    function advBuyMove(key) {
        let m = advMoveByKey(key);
        if (!m || m.buy.kind === 'free') return;
        if (advOwns(key)) { alert(`已經擁有「${m.name}」了。`); return; }
        if (m.buy.kind === 'chicken') { buyShopItem(m.buy.item); return; }
        if (advData.shards < m.buy.price) { alert(`碎片不足！需要 ${m.buy.price} 個，目前有 ${advData.shards} 個。`); return; }
        if (!confirm(`要用 ${m.buy.price} 個碎片學會「${m.name}」嗎？\n\n${ADV_TYPE_LABEL[m.type]}｜威力 ${m.power}${m.hits > 1 ? '×' + m.hits : ''}｜${m.q} 題｜${m.desc}`)) return;
        advData.shards -= m.buy.price;
        advData.own[key] = true;
        advAutoEquip(key);
        advSave();
        advRenderShopBox();
        advShardFloat(-m.buy.price);
    }
    // 新學會的招式：如果還有空位就自動裝備
    function advAutoEquip(key) {
        advData.eq = advData.eq.filter(k => advOwns(k));
        if (advOwns(key) && !advData.eq.includes(key) && advData.eq.length < ADV_MAX_EQUIP) advData.eq.push(key);
        advSave();
    }
    function advOnShopPurchase(itemKey) {
        let m = ADV_MOVES.find(x => x.buy.item === itemKey);
        if (m) advAutoEquip(m.key);
        advRenderShopBox();
    }
    async function advWeeklyExchange() {
        let week = advWeekId();
        if (advData.weekDone === week) { alert('這週已經兌換過了，下週一（台灣時間）再來！'); return; }
        if (advData.shards < ADV_WEEKLY_SHARDS) { alert(`碎片不足！需要 ${ADV_WEEKLY_SHARDS} 個，目前有 ${advData.shards} 個。`); return; }
        if (walletBusy) return;
        if (!ensureLoginBeforeSpend()) return;
        if (!confirm(`要用 ${ADV_WEEKLY_SHARDS} 個碎片兌換 ${ADV_WEEKLY_CHICKENS} 個雞塊嗎？\n\n每週只能兌換 1 次。`)) return;
        walletBusy = true;
        try {
            let data = await walletRpc('weekly_exchange', {});
            advData.shards -= ADV_WEEKLY_SHARDS;
            advData.weekDone = week;
            advSave();
            let sc = document.getElementById('advShopShardCount'); if (sc) sc.textContent = advData.shards;
            advShardFloat(-ADV_WEEKLY_SHARDS);
            applyWallet(data, getLocalDateStr());
            showChickenFloat('chickenShopCountDisplay', '+' + ADV_WEEKLY_CHICKENS, '#10B981');
            updateChickenShopUI();
        } catch (e) {
            let m = String((e && e.message) || '');
            if (m.includes('weekly_used')) { advData.weekDone = week; advSave(); alert('這週已經兌換過了（伺服器紀錄），下週一再來！'); }
            else if (m.includes('weekly_exchange') && (m.includes('function') || m.includes('schema'))) alert('伺服器還沒更新：請先在 Supabase 執行 supabase_adv_v3_2.sql。');
            else alert(`❌ 兌換失敗：${walletErrorMessage(e)}`);
            refreshWallet();
        } finally {
            walletBusy = false;
            advRenderShopBox();
        }
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
    function advWordKey(w) { return String(w.english || '').toLowerCase(); }
    function advNextWord(kind) {
        let filt = kind === 'cn' ? (w => !!w.chinese) : (() => true);
        let pool = adv.words.filter(filt);
        if (!adv.seen) adv.seen = new Set();
        let fresh = pool.filter(w => !adv.seen.has(advWordKey(w)));
        if (!fresh.length) {                       // 全部出現過一輪了：重新開始一輪
            pool.forEach(w => adv.seen.delete(advWordKey(w)));
            fresh = pool.slice();
        }
        let w = fresh[Math.floor(Math.random() * fresh.length)];
        adv.seen.add(advWordKey(w));
        return w;
    }
    // 選項（干擾答案）：先從這場還沒出現過的單字挑，不夠才用出現過的；值不能重複、不能等於正確答案
    function advPickDistractors(answer, n, filt, valueOf) {
        let ans = valueOf(answer), vals = new Set([ans]), out = [];
        let pool = adv.words.filter(x => x !== answer && filt(x));
        let fresh = advShuffle(pool.filter(x => !adv.seen.has(advWordKey(x))));
        let used = advShuffle(pool.filter(x => adv.seen.has(advWordKey(x))));
        for (let x of fresh.concat(used)) {
            if (out.length >= n) break;
            let v = valueOf(x);
            if (!v || vals.has(v)) continue;
            vals.add(v); out.push(x);
        }
        out.forEach(x => adv.seen.add(advWordKey(x)));
        return out;
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
        if (pt) pt.textContent = `${Math.max(0, p.hp)}/${p.max}` + (p.shieldMax ? ` 🛡️${p.shield}` : '');
        if (et) et.textContent = `${Math.max(0, e.hp)}/${e.max}` + (e.shield ? ` 🛡️${e.shield}` : '');
        let info = document.getElementById('advTopInfo');
        if (info) info.textContent = `第 ${adv.level.id} 關 ｜ 回合 ${adv.round} ｜ 行動 ${Math.min(adv.actionsTotal - adv.actionsLeft + 1, adv.actionsTotal)}/${adv.actionsTotal}`;
    }
    // 戰鬥場景：夜市小吃攤街景（藍紅帆布攤 + 紅燈籠 + 木檯）
    function advStageBG() {
        const FONT = `font-family="'Noto Sans TC','PingFang TC','Microsoft JhengHei',sans-serif"`;
        let seed = 17;
        const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
        const glow = (x, y, r, c, o) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}" opacity="${o}"/>`;
        const lan = (x, y, r) => `<g><line x1="${x}" y1="${y - r * 1.4}" x2="${x}" y2="${y}" stroke="#1E1B4B" stroke-width="1"/><ellipse cx="${x}" cy="${y + r * 1.1}" rx="${r}" ry="${r * 1.25}" fill="#EF4444" stroke="#7F1D1D" stroke-width="0.8"/><rect x="${x - r * 0.45}" y="${y - 1}" width="${r * 0.9}" height="2.2" fill="#FCD34D"/><rect x="${x - r * 0.45}" y="${y + r * 2.2}" width="${r * 0.9}" height="2" fill="#FCD34D"/><ellipse cx="${x - r * 0.3}" cy="${y + r * 0.8}" rx="${r * 0.25}" ry="${r * 0.5}" fill="#FFFFFF" opacity="0.3"/></g>`;
        const sign = (x, y, w, h, txt, bg, fg, fs) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="${bg}" stroke="#00000055" stroke-width="0.8"/><text x="${x + w / 2}" y="${y + h / 2 + fs * 0.36}" text-anchor="middle" font-size="${fs}" font-weight="800" fill="${fg}" ${FONT}>${txt}</text>`;
        const people = (xs, y) => xs.map((x, i) => `<g opacity="0.9"><circle cx="${x}" cy="${y}" r="3" fill="#1F2937"/><path d="M ${x - 4} ${y + 12} q 0 -9 4 -9 q 4 0 4 9 z" fill="${['#334155', '#475569', '#1E293B', '#3F3F46'][i % 4]}"/></g>`).join('');
        let s = `<rect width="340" height="150" fill="url(#sgE1)"/><rect width="340" height="26" fill="#1B1740"/>`;
        s += sign(130, 4, 80, 18, '好吃小吃', '#B91C1C', '#FEF3C7', 12) + sign(10, 6, 56, 14, '排骨麵', '#E0F2FE', '#1D4ED8', 10) + sign(274, 6, 56, 14, '腳底按摩', '#FEF9C3', '#92400E', 9);
        for (let i = 0; i < 10; i++) s += lan(14 + i * 34, 22 + (i % 2) * 3, 4.8);
        s += `<path d="M 6 58 L 150 58 L 160 78 L -4 78 Z" fill="#2563EB"/><path d="M 6 58 L 40 58 L 30 78 L -4 78 Z" fill="#DC2626"/><path d="M 78 58 L 112 58 L 106 78 L 66 78 Z" fill="#DC2626"/>`;
        s += `<path d="M 190 58 L 334 58 L 344 78 L 180 78 Z" fill="#DC2626"/><path d="M 224 58 L 258 58 L 252 78 L 212 78 Z" fill="#2563EB"/><path d="M 300 58 L 334 58 L 344 78 L 290 78 Z" fill="#2563EB"/>`;
        s += `<rect x="14" y="78" width="136" height="30" fill="#3A2A55"/><rect x="190" y="78" width="136" height="30" fill="#3A2A55"/>`;
        s += glow(82, 88, 40, '#FDE68A', 0.28) + glow(258, 88, 40, '#FDE68A', 0.28);
        for (let i = 0; i < 6; i++) s += `<ellipse cx="${24 + i * 20}" cy="${86 + (i % 2) * 2}" rx="4" ry="7" fill="#B45309" stroke="#451A03" stroke-width="0.8"/>`;
        for (let i = 0; i < 6; i++) s += `<ellipse cx="${200 + i * 20}" cy="${86 + (i % 2) * 2}" rx="4" ry="7" fill="#92400E" stroke="#451A03" stroke-width="0.8"/>`;
        s += `<rect x="160" y="60" width="30" height="48" fill="#241A3D"/>` + glow(175, 70, 16, '#FCD34D', 0.3) + people([164, 172, 180, 187], 84);
        s += `<rect x="0" y="108" width="340" height="42" fill="url(#sgE2)"/><rect x="0" y="104" width="340" height="6" fill="#8B5E34"/><path d="M 0 106 H 340" stroke="#C08A52" stroke-width="1"/>`;
        const cols = ['#FCD34D', '#F87171', '#60A5FA'];
        for (let i = 0; i < 8; i++) s += glow(rnd() * 340, 100 + rnd() * 40, 2 + rnd() * 4, cols[i % 3], 0.35);
        return `<svg class="adv-stage-bg" viewBox="0 0 340 150" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs>
            <linearGradient id="sgE1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#120E30"/><stop offset="1" stop-color="#3A2342"/></linearGradient>
            <linearGradient id="sgE2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4A2E22"/><stop offset="1" stop-color="#1F110C"/></linearGradient></defs>${s}</svg>`;
    }
    // 戰鬥場景：便利商店店內（日光燈 + 貨架 + 冷藏櫃 + 地磚）
    function advStoreStageBG() {
        const FONT = `font-family="'Noto Sans TC','PingFang TC','Microsoft JhengHei',sans-serif"`;
        let seed = 23;
        const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
        const cols = ['#F87171', '#60A5FA', '#FBBF24', '#34D399', '#A78BFA', '#F472B6', '#FB923C'];
        let s = `<rect width="340" height="150" fill="url(#sgS1)"/>`;
        for (let i = 0; i < 4; i++) s += `<rect x="${18 + i * 84}" y="4" width="64" height="5" rx="2.5" fill="#FFFFFF"/><ellipse cx="${50 + i * 84}" cy="14" rx="44" ry="10" fill="#FFFFFF" opacity="0.25"/>`;
        s += `<rect x="0" y="22" width="340" height="12" fill="#1E3A8A"/><rect x="0" y="22" width="340" height="2" fill="#F97316"/><rect x="0" y="32" width="340" height="2" fill="#22C55E"/>`;
        s += `<text x="170" y="31.5" font-size="8" font-weight="900" text-anchor="middle" fill="#FFFFFF" ${FONT}>便利商店　24H</text>`;
        // 左邊：零食貨架
        s += `<rect x="6" y="38" width="140" height="68" fill="#F1F5F9" stroke="#94A3B8" stroke-width="1"/>`;
        for (let r = 0; r < 3; r++) {
            s += `<rect x="6" y="${58 + r * 22}" width="140" height="3" fill="#94A3B8"/>`;
            for (let x = 10; x < 140; x += 11 + Math.floor(rnd() * 4)) s += `<rect x="${x}" y="${43 + r * 22 + Math.floor(rnd() * 3)}" width="8" height="${13 - Math.floor(rnd() * 3)}" rx="1.5" fill="${cols[Math.floor(rnd() * cols.length)]}"/>`;
        }
        // 右邊：飲料冷藏櫃
        s += `<rect x="194" y="38" width="140" height="68" fill="#DBEAFE" stroke="#1E40AF" stroke-width="1.5"/>`;
        for (let i = 1; i < 4; i++) s += `<line x1="${194 + i * 35}" y1="38" x2="${194 + i * 35}" y2="106" stroke="#1E40AF" stroke-width="1.2"/>`;
        for (let r = 0; r < 3; r++) for (let x = 198; x < 330; x += 9) s += `<rect x="${x}" y="${42 + r * 21}" width="5" height="15" rx="2" fill="${['#86EFAC', '#FCA5A5', '#FDE68A', '#93C5FD'][(r + Math.floor(x / 9)) % 4]}" opacity="0.95"/>`;
        s += `<rect x="194" y="38" width="140" height="68" fill="#FFFFFF" opacity="0.18"/>`;
        // 中間：自動門
        s += `<rect x="150" y="38" width="40" height="68" fill="#BAE6FD" stroke="#64748B" stroke-width="1"/><line x1="170" y1="38" x2="170" y2="106" stroke="#64748B" stroke-width="1"/>`;
        // 地磚
        s += `<rect x="0" y="106" width="340" height="44" fill="url(#sgS2)"/>`;
        for (let i = -6; i <= 16; i++) s += `<line x1="${170 + i * 30}" y1="106" x2="${170 + i * 60}" y2="150" stroke="#CBD5E1" stroke-width="1"/>`;
        [118, 132].forEach(y => { s += `<line x1="0" y1="${y}" x2="340" y2="${y}" stroke="#CBD5E1" stroke-width="1"/>`; });
        return `<svg class="adv-stage-bg" viewBox="0 0 340 150" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs>
            <linearGradient id="sgS1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E2E8F0"/><stop offset="1" stop-color="#F8FAFC"/></linearGradient>
            <linearGradient id="sgS2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E5E7EB"/><stop offset="1" stop-color="#F9FAFB"/></linearGradient></defs>${s}</svg>`;
    }
    function advBuildStage() {
        let st = document.getElementById('advStage');
        st.innerHTML = (adv.level && adv.level.id >= 11 ? advStoreStageBG() : advStageBG()) + `
            <div class="adv-hud adv-hud-enemy"><div><span id="advEnemyName">${escapeHTML(adv.enemy.name)}</span> <span id="advEnemyHpText"></span></div><div class="adv-hpbar"><div class="adv-hpfill" id="advEnemyFill"></div></div></div>
            <div class="adv-actor adv-enemy" id="advEnemy">${advEnemySVG(adv.enemy.sprite)}</div>
            <div class="adv-actor adv-player" id="advPlayer">${advChickenSVG()}</div>
            <div class="adv-hud adv-hud-player"><div>雞塊 <span id="advPlayerHpText"></span></div><div class="adv-hpbar"><div class="adv-hpfill" id="advPlayerFill"></div></div></div>
            <div class="adv-fx" id="advFx"></div>`;
        advUpdateHud();
    }

    // ── 開始 / 結束 ──
    function advAbort() {
        advStopTimer();
        try { advCloseReward(); } catch (e) {}
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
    // 戰鬥畫面的高度：開戰時用當下的螢幕高度算好固定下來（打字跳出鍵盤時畫面不會被擠動）
    function advLockBattleHeight() {
        let b = document.querySelector('#adventureBattleView .adv-battle');
        if (!b) return;
        let h = window.innerWidth <= 768 ? Math.max(330, Math.round(window.innerHeight * 0.6 - 44)) : 440;
        b.style.setProperty('--adv-h', h + 'px');
    }
    function advStartBattle(levelId) {
        let lv = ADV_LEVELS.find(l => l.id === levelId);
        if (!lv || !advUnlocked(lv.id)) return;
        let words = advGetWords();
        if (words.length < lv.minWords) { alert(`⚠️ 這一關需要範圍內至少 ${lv.minWords} 個單字，請多勾選一些題庫。`); return; }
        advAbort();
        advSyncDaily();
        if (advData.hp <= 0) { alert('雞塊沒有體力了，明天 00:00 會恢復。'); advRenderLevelPage(); return; }
        if (advData.cleared[lv.id]) {      // 已通關的關卡：每天只能重複挑戰 3 次（沒通關的關卡不限次數）
            if (advReplaysLeft() <= 0) { alert(`今天重複挑戰已通關關卡的次數用完了（今天共 ${advReplayCap()} 次）。\n\n還沒通關的關卡可以一直挑戰；背包裡的「冒險卷」可以讓今天多挑戰 1 次。`); advRenderLevelPage(); return; }
            let used = advReplaysUsed();
            advData.replayDay = getLocalDateStr();
            advData.replays = used + 1;
            advSave();
        }
        adv.words = words;
        adv.cnWords = words.filter(w => w.chinese);
        adv.decks = { all: [], cn: [] };
        adv.seen = new Set();          // 這場戰鬥已經出現過的單字
        let s = advPlayerStats();
        adv.level = lv;
        adv.moves = advEquipped();
        adv.player = { hp: Math.min(advData.hp, s.hp), max: s.hp, atk: s.atk, agi: s.agi, def: s.def, int: s.int, luck: s.luck, shield: advShieldMax(s.int), shieldMax: advShieldMax(s.int) };
        adv.phases = Array.isArray(lv.phases) && lv.phases.length ? lv.phases : [lv];
        adv.phase = 0;
        adv.enemy = advMakeEnemy(adv.phases[0]);
        adv.sealed = [];
        adv.round = 1;
        adv.gear = advData.gear.filter(Boolean);    // 這場戰鬥帶的裝備（左手、右手）
        if (advHasGear('bag')) { adv.player.shield += ADV_BAG_SHIELD; adv.player.shieldMax += ADV_BAG_SHIELD; }
        advData.hitPrev = advHitTotal();             // 命中的「比上次」用這個比較
        adv.itemUsed = false;
        adv.micOk = false;
        adv.active = true;
        adv.busy = false;
        requestWakeLock();
        if (!document.getElementById('adventureBattleView').classList.contains('active')) advLockBattleHeight();
        switchView('adventureBattleView');
        advBuildStage();
        advBeginRound();
    }
    // 敵人資料：護盾 = 智慧 ÷ 2（最多 5）；有特別指定 shield 的（御飯糰 12 點）照指定
    function advMakeEnemy(d) {
        let sh = (typeof d.shield === 'number') ? d.shield : advShieldMax(d.int);
        return { name: d.name, sprite: d.sprite, special: d.special || '', hp: d.hp, max: d.hp, atk: d.atk, agi: d.agi, def: d.def, int: d.int || 0, shield: sh, shieldMax: sh, luck: d.luck || 0, moveName: d.moveName || '攻擊', movePower: d.movePower || 0 };
    }
    // 第一階段被打倒 → 下一個敵人登場（雞塊的體力、護盾延續）
    async function advNextPhase(id) {
        const E = document.getElementById('advEnemy');
        let old = adv.enemy;
        adv.phase++;
        let nxt = advMakeEnemy(adv.phases[adv.phase]);
        document.getElementById('advPanel').innerHTML = `<div class="adv-log" id="advLog">💥 ${escapeHTML(old.name)}被打倒了…等等！裡面的${escapeHTML(nxt.name)}跳出來了！</div>`;
        await advAnimate(E, [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0.2) rotate(200deg)', opacity: 0 }], { duration: 520, easing: 'ease-in' });
        if (id !== adv.runId) return;
        adv.enemy = nxt;
        // 新的敵人登場：雞塊的行動次數依新敵人的敏捷重新計算（+1 是因為打倒上一隻的這一招等一下會扣掉 1 次）
        adv.actionsTotal = advActionCount(adv.player.agi, nxt.agi);
        adv.actionsLeft = adv.actionsTotal + 1;
        adv.sealed = [];
        if (E) E.innerHTML = advEnemySVG(nxt.sprite);
        let nm = document.getElementById('advEnemyName');
        if (nm) nm.textContent = nxt.name;
        advUpdateHud();
        await advAnimate(E, [{ transform: 'translateY(-40px) scale(0.6)', opacity: 0 }, { transform: 'translateY(6px) scale(1.08)', opacity: 1, offset: 0.7 }, { transform: 'translateY(0) scale(1)', opacity: 1 }], { duration: 560, easing: 'ease-out' });
        if (id !== adv.runId) return;
        advFloat(E, '登場！', '#F97316');
        await advWait(500);
    }
    // 敵人倒下：還有下一階段就換人（回傳 false），沒有就勝利（回傳 true）
    async function advEnemyDown(id) {
        if (adv.enemy.hp > 0) return false;
        if (adv.phases && adv.phase < adv.phases.length - 1) { await advNextPhase(id); return false; }
        await advWin(id);
        return true;
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
        adv.sealed = [];
        if (adv.enemy.special === 'seal') {
            // 只封印「本來能用」的招式，而且一定留至少 1 招能用（避免剩下的招式剛好因為別的原因不能用而卡住）
            let keys = advShuffle(adv.moves.filter(m => !advMoveBlock(m)).map(m => m.key));
            adv.sealed = keys.slice(0, Math.min(2, Math.max(0, keys.length - 1)));
        }
        advShowMenu();
        if (adv.sealed.length) {
            advSetLog(`🧾 取票失敗！這回合有 ${adv.sealed.length} 招被封印（灰色的不能用）`);
            advFloat(document.getElementById('advEnemy'), '取票失敗！', '#F97316');
        }
    }
    // 這招每一下的傷害：攻擊力 + 招式威力 + 熟練度 − 對方防禦（至少 1）；茶葉蛋被字卡打時 +2
    function advHitDamage(m) {
        let bonus = (adv.enemy.special === 'egg' && m.type === 'card') ? ADV_EGG_CARD_BONUS : 0;
        let wk = ADV_WEAK_BONUS[adv.enemy.special];
        if (wk && wk.type === m.type) bonus += wk.bonus;
        return advDamage(adv.player.atk, m.power + advMastery(m.key) + bonus, adv.enemy.def);
    }
    // 這招因為題庫或瀏覽器的關係不能用：回傳原因（可以用就回傳空字串）
    function advMoveBlock(m) {
        if ((m.mode === 'choice' || m.mode === 'listenCn') && adv.cnWords.length < 4) return '缺中文';
        if (m.mode === 'speakCn' && adv.cnWords.length < 1) return '缺中文';
        if (m.mode === 'typeCn' && adv.cnWords.length < 1) return '缺中文';
        if (m.type === 'speak' && !getSpeechRecognitionCtor()) return '不支援';
        return '';
    }
    function advShowMenu() {
        adv.q = null;
        advUpdateHud();
        let speakOk = !!getSpeechRecognitionCtor();
        let moves = adv.moves.map(m => {
            let why = advMoveBlock(m), off = !!why;
            let sealed = (adv.sealed || []).includes(m.key);
            if (sealed) { off = true; why = '封印中'; }
            let lvl = advMastery(m.key);
            let per = adv.player.atk + m.power + lvl;      // 不扣敵人防禦：打下去才知道
            return `<button type="button" class="adv-move rar-${advRarityKey(m.key)}${sealed ? ' sealed' : ''}" ${off ? 'disabled' : ''} data-on-click='[["advChooseMove",["${m.key}"]]]'>
                <b class="nm">${m.icon} ${m.name}${lvl ? ` <span class="adv-lv-chip">Lv.${lvl}</span>` : ''}</b><span class="dmg">傷害 ${m.hits > 1 ? per + '×' + m.hits : per}</span><small>${ADV_TYPE_LABEL[m.type]}${why ? '｜' + why : ''}</small></button>`;
        }).join('');
        let itemBtn = '';
        if (advHasGear('boba')) {
            let can = !adv.itemUsed && adv.player.hp <= 3 && adv.player.hp < adv.player.max;
            itemBtn += `<button type="button" class="adv-item-btn" ${can ? '' : 'disabled'} data-on-click='[["advUseBoba",[]]]'>🧋 喝快喝光的珍珠奶茶　HP +1 <small>${adv.itemUsed ? '（這場已經喝過了）' : '（HP 3 以下可用，一場 1 次）'}</small></button>`;
        }
        if (advHasGear('tofu')) itemBtn += `<div class="adv-item-tip">${advTofuIcon(16)} 裝備烤焦臭豆腐：招式失敗時雙方各扣 1 點體力</div>`;
        if (advHasGear('skewer')) itemBtn += `<div class="adv-item-tip">${advSkewerIcon(16)} 裝備竹籤：攻擊無視對方護盾</div>`;
        document.getElementById('advPanel').innerHTML = `<div class="adv-log" id="advLog">選擇招式！（本回合還可行動 ${adv.actionsLeft} 次）</div><div class="adv-moves">${moves}</div>${itemBtn}`;
    }
    function advHasGear(k) { return Array.isArray(adv.gear) && adv.gear.includes(k); }
    // 快喝光的珍珠奶茶：一場戰鬥限用 1 次，HP 3 以下才能喝，不消耗行動次數
    function advUseBoba() {
        if (!adv.active || adv.busy || adv.q || !advHasGear('boba') || adv.itemUsed) return;
        if (adv.player.hp > 3 || adv.player.hp >= adv.player.max) return;
        adv.itemUsed = true;
        adv.player.hp = Math.min(adv.player.max, adv.player.hp + 1);
        advData.hp = adv.player.hp;
        advSave();
        advFloat(document.getElementById('advPlayer'), '+1', '#10B981');
        advShowMenu();
        advSetLog('🧋 喝了快喝光的珍珠奶茶，HP +1！');
    }

    async function advChooseMove(key) {
        if (!adv.active || adv.busy || adv.q) return;
        let m = adv.moves.find(x => x.key === key);
        if (!m || (adv.sealed || []).includes(key)) return;
        const id = adv.runId;
        adv.move = m;
        adv.moveSeq = (adv.moveSeq || 0) + 1;     // 這一次出招的編號：同一招只會結算一次
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
        advNextQuestion();
    }
    // 出下一題（多題的招式要連續答對 m.q 題）
    function advNextQuestion() {
        let m = adv.move;
        adv.triesLeft = m.tries;
        if (m.mode === 'choice') advAskCard();
        else if (m.mode === 'typeCn') advAskTypeCn();
        else if (m.mode === 'listenChoice' || m.mode === 'listenCn') advAskListenChoice();
        else if (m.mode === 'listenSpell') advAskListen();
        else advAskSpeak();
        advMountTimer();
    }
    function advProgText() { let m = adv.move; return m.q > 1 ? `（第 ${adv.progress + 1}/${m.q} 題）` : ''; }
    // 這一題答對了：還有下一題就繼續，題目答完就發動招式
    // 命中：每一題記一次（答對 1／答錯或時間到 0），各類與全部都只留最近 20 題
    function advRecordHit(ok) {
        let t = adv.move && adv.move.type;
        if (!t || !advData.hits[t]) return;
        [t, 'all'].forEach(k => { advData.hits[k].push(ok ? 1 : 0); if (advData.hits[k].length > ADV_HIT_N) advData.hits[k].splice(0, advData.hits[k].length - ADV_HIT_N); });
    }
    function advHitPct(arr) { return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 100) : null; }
    // 總命中 = 字卡、聽力、朗讀各自最近 20 題合起來算（不會只看最近 20 題而忽略比較弱的類別）
    function advHitAll() { return ['card', 'listen', 'speak'].reduce((x, k) => x.concat(advData.hits[k] || []), []); }
    function advHitTotal() { let a = advHitAll(); return a.length >= ADV_HIT_N ? advHitPct(a) : null; }
    function advQuestionPassed() {
        advRecordHit(true);
        adv.progress++;
        if (adv.progress < adv.move.q) { advNextQuestion(); return; }
        advResolveMove(true);
    }

    // ── 作答倒數：每題 15 秒（智慧可增減），時間到 = 招式失敗 ──
    function advStopTimer() { clearInterval(adv.timer); adv.timer = null; }
    function advMountTimer() {
        advStopTimer();
        let q = adv.q, log = document.getElementById('advLog');
        if (!adv.active || !q || q.done || !log) return;
        let total = advAnswerSecs(adv.player.int, adv.enemy.int);
        adv.timerEnd = Date.now() + total * 1000;
        adv.timerTotal = total;
        log.classList.add('has-timer');
        log.insertAdjacentHTML('beforeend', `<span class="adv-timer" id="advTimer"><svg viewBox="0 0 36 36" width="34" height="34"><circle cx="18" cy="18" r="15" fill="none" stroke="rgba(100,116,139,.25)" stroke-width="4"/><circle id="advTimerArc" cx="18" cy="18" r="15" fill="none" stroke="#10B981" stroke-width="4" stroke-linecap="round" stroke-dasharray="94.25" stroke-dashoffset="0" transform="rotate(-90 18 18)"/></svg><b id="advTimerNum">${total}</b></span>`);
        const tick = () => {
            let q2 = adv.q;
            if (!adv.active || !q2 || q2.done || q2 !== q) { advStopTimer(); return; }
            let left = Math.max(0, adv.timerEnd - Date.now());
            let arc = document.getElementById('advTimerArc'), num = document.getElementById('advTimerNum');
            if (arc) { arc.style.strokeDashoffset = String(94.25 * (1 - left / (adv.timerTotal * 1000))); arc.style.stroke = left <= 5000 ? '#EF4444' : '#10B981'; }
            if (num) { num.textContent = String(Math.ceil(left / 1000)); num.style.color = left <= 5000 ? '#EF4444' : ''; }
            if (left <= 0) { advStopTimer(); advTimeUp(); }
        };
        adv.timer = setInterval(tick, 100);
    }
    async function advTimeUp() {
        let q = adv.q;
        if (!adv.active || !q || q.done) return;
        const id = adv.runId;
        q.done = true;
        advIgnore = true;
        if (advRec && advListening) { try { advRec.abort(); } catch (e) {} advListening = false; }
        clearTimeout(advWatch);
        try { window.speechSynthesis.cancel(); } catch (e) {}
        let btns = document.querySelectorAll('#advPanel .adv-opt');
        if (q.type === 'card' || q.type === 'listenChoice') btns.forEach((b, i) => { if (i === q.correct) b.classList.add('ok'); });
        let sub = document.getElementById(q.type === 'typeCn' ? 'advCnSub' : q.type === 'listen' ? 'advListenSub' : 'advSpeakHint');
        if (sub && (q.type === 'typeCn' || q.type === 'listen')) sub.innerHTML = `⏰ 時間到！正確答案：<b>${escapeHTML(q.type === 'typeCn' ? q.word.chinese : q.word.english)}</b>`;
        else if (sub) sub.textContent = '⏰ 時間到！';
        let t = document.getElementById('advTimerNum'); if (t) t.textContent = '0';
        await advWait(1200);
        if (id !== adv.runId) return;
        advResolveMove(false);
    }

    // 字卡（選擇題）
    function advAskCard() {
        let w = advNextWord('cn');
        let wrong = advPickDistractors(w, 3, x => !!x.chinese, x => x.chinese).map(x => x.chinese);
        let opts = advShuffle([w.chinese, ...wrong]);
        adv.q = { type: 'card', word: w, opts, correct: opts.indexOf(w.chinese), done: false };
        let m = adv.move;
        document.getElementById('advPanel').innerHTML = `
            <div class="adv-log" id="advLog">${m.icon} ${m.name}${advProgText()}：選出正確的意思</div>
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
        if (ok) advQuestionPassed(); else advResolveMove(false);
    }

    // 字卡（輸入中文意思）
    function advCnNorm(s) { return String(s || '').normalize('NFC').replace(/[\s　，,、；;。.！!？?\/／]/g, '').toLowerCase(); }
    function advCnMatch(input, chinese) {
        let a = advCnNorm(input);
        if (!a) return false;
        if (a === advCnNorm(chinese)) return true;
        return String(chinese || '').split(/[；;,，、\/／]/).some(p => {
            let n = advCnNorm(p.replace(/[（(][^）)]*[）)]/g, ''));
            return n && n === a;
        });
    }
    function advAskTypeCn() {
        let w = advNextWord('cn');
        adv.q = { type: 'typeCn', word: w, done: false };
        let m = adv.move;
        document.getElementById('advPanel').innerHTML = `
            <div class="adv-log" id="advLog">${m.icon} ${m.name}${advProgText()}：輸入這個單字的中文意思</div>
            <div class="adv-qword">${escapeHTML(w.english)}</div>
            <div class="adv-input-row">
                <input type="text" id="advCnInput" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="輸入中文意思">
                <button type="button" data-on-click='[["advSubmitCn",[]]]'>送出</button>
            </div>
            <div class="adv-qsub" id="advCnSub"></div>`;
        let inp = document.getElementById('advCnInput');
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); advSubmitCn(); } });
        setTimeout(() => { try { inp.focus({ preventScroll: true }); } catch (e) {} }, 50);
    }
    async function advSubmitCn() {
        let q = adv.q;
        if (!adv.active || adv.busy || !q || q.type !== 'typeCn' || q.done) return;
        let inp = document.getElementById('advCnInput');
        let val = inp ? inp.value : '';
        if (!val.trim()) return;
        const id = adv.runId;
        q.done = true;
        let ok = advCnMatch(val, q.word.chinese);
        if (inp) inp.blur();
        document.getElementById('advCnSub').innerHTML = ok ? '✅ 正確！' : `❌ 正確答案：<b>${escapeHTML(q.word.chinese)}</b>`;
        await advWait(ok ? 500 : 1300);
        if (id !== adv.runId) return;
        if (ok) advQuestionPassed(); else advResolveMove(false);
    }

    // 聽力（聽發音，選出單字）
    function advNorm(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC').toLowerCase().replace(/[\s'’\-.,!?]/g, ''); }
    function advAskListenChoice() {
        let m = adv.move, cn = m.mode === 'listenCn';     // listenCn：聽英文，選中文意思
        let w = advNextWord(cn ? 'cn' : 'all');
        let wrong = cn ? advPickDistractors(w, 3, x => !!x.chinese, x => x.chinese).map(x => x.chinese)
                       : advPickDistractors(w, 3, x => !!advNorm(x.english), x => advNorm(x.english)).map(x => x.english);
        let ans = cn ? w.chinese : w.english;
        let opts = advShuffle([ans, ...wrong]);
        adv.q = { type: 'listenChoice', word: w, opts, correct: opts.indexOf(ans), done: false };
        document.getElementById('advPanel').innerHTML = `
            <div class="adv-log" id="advLog">${m.icon} ${m.name}${advProgText()}：${cn ? '聽英文，選出中文意思' : '聽發音，選出正確的單字'}</div>
            <div class="adv-opts">${opts.map((o, i) => `<button type="button" class="adv-opt" data-on-click='[["advAnswerListen",[${i}]]]'>${escapeHTML(o)}</button>`).join('')}</div>`;
        advSpeakWord(w.english);
    }
    async function advAnswerListen(i) {
        let q = adv.q;
        if (!adv.active || adv.busy || !q || q.type !== 'listenChoice' || q.done) return;
        const id = adv.runId;
        q.done = true;
        let btns = document.querySelectorAll('#advPanel .adv-opt');
        btns.forEach((b, idx) => { if (idx === q.correct) b.classList.add('ok'); else if (idx === i) b.classList.add('bad'); });
        let ok = i === q.correct;
        await advWait(ok ? 450 : 1000);
        if (id !== adv.runId) return;
        if (ok) advQuestionPassed(); else advResolveMove(false);
    }
    // 聽力（聽發音、拼單字）
    function advAskListen() {
        let w = advNextWord('all');
        adv.q = { type: 'listen', word: w, done: false };
        let m = adv.move;
        document.getElementById('advPanel').innerHTML = `
            <div class="adv-log" id="advLog">${m.icon} ${m.name}${advProgText()}：聽發音，拼出單字</div>
            <div class="adv-input-row">
                <input type="text" id="advListenInput" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="輸入聽到的單字">
                <button type="button" data-on-click='[["advSubmitListen",[]]]'>送出</button>
            </div>
            <div class="adv-qsub" id="advListenSub"></div>`;
        let inp = document.getElementById('advListenInput');
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); advSubmitListen(); } });
        advSpeakWord(w.english);
        setTimeout(() => { try { inp.focus({ preventScroll: true }); } catch (e) {} }, 50);
    }
    function advReplayListen() { if (adv.q && (adv.q.type === 'listen' || adv.q.type === 'listenChoice')) advSpeakWord(adv.q.word.english); }
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
        if (ok) advQuestionPassed(); else advResolveMove(false);
    }

    // 朗讀（按住麥克風）
    function advAskSpeak() {
        let m = adv.move, cn = m.mode === 'speakCn';     // speakCn：只顯示中文，要唸出英文
        let w = advNextWord(cn ? 'cn' : 'all');
        adv.q = { type: 'speak', word: w, done: false, cn };
        document.getElementById('advPanel').innerHTML = `
            <div class="adv-log" id="advLog">${m.icon} ${m.name}${advProgText()}：${cn ? '看中文，唸出英文單字' : '按住麥克風唸出單字'}</div>
            ${cn ? `<div class="adv-qword">${escapeHTML(w.chinese)}</div>
            <div class="adv-qsub">唸出這個意思的英文單字</div>` : `<div class="adv-qword">${escapeHTML(w.english)}</div>
            <div class="adv-qsub">${escapeHTML(w.chinese || '')}</div>`}
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
            advQuestionPassed();
        } else if (adv.triesLeft <= 0) {
            q.done = true;
            advSpeakHint(`❌ ${res.score} 分（需 ${getSpeakPassScore()} 分），沒有機會了${q.cn ? `｜答案：${q.word.english}` : ''}`);
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
    let advFxSeq = 0;
    // 藍色能量彗星（頭在右邊、尾巴往左變細），yellow = 黃色衝擊波
    function advCometSVG(kind) {
        const id = 'cm' + (++advFxSeq);
        const c = kind === 'yellow'
            ? { a: '#FEF9C3', b: '#FACC15', c: '#F59E0B', glow: '#FDE047' }
            : { a: '#E0F2FE', b: '#38BDF8', c: '#2563EB', glow: '#7DD3FC' };
        return `<svg viewBox="0 0 150 46" width="100%" height="100%" style="overflow:visible" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <linearGradient id="${id}t" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${c.c}" stop-opacity="0"/><stop offset="0.55" stop-color="${c.b}" stop-opacity="0.55"/><stop offset="1" stop-color="${c.a}" stop-opacity="0.95"/></linearGradient>
                <radialGradient id="${id}h"><stop offset="0" stop-color="#FFFFFF"/><stop offset="0.45" stop-color="${c.glow}" stop-opacity="0.95"/><stop offset="1" stop-color="${c.c}" stop-opacity="0"/></radialGradient>
            </defs>
            <path d="M 0 23 Q 46 6 118 8 L 118 38 Q 46 40 0 23 Z" fill="url(#${id}t)"/>
            <path d="M 18 23 Q 64 14 118 15 L 118 31 Q 64 32 18 23 Z" fill="${c.a}" opacity="0.6"/>
            <path d="M 30 12 Q 60 10 90 11 M 24 34 Q 60 36 92 35" stroke="${c.b}" stroke-width="2" stroke-linecap="round" fill="none" opacity="0.8"/>
            <circle cx="40" cy="14" r="2" fill="#FFFFFF"/><circle cx="62" cy="32" r="1.7" fill="#FFFFFF"/><circle cx="84" cy="12" r="1.6" fill="#FFFFFF"/><circle cx="18" cy="26" r="1.4" fill="#FFFFFF"/>
            <circle cx="124" cy="23" r="22" fill="url(#${id}h)"/>
            <circle cx="124" cy="23" r="10" fill="#FFFFFF"/>
        </svg>`;
    }
    function advFxBox(html, cx, cy, w, h) {
        let fx = document.getElementById('advFx');
        if (!fx) return null;
        let d = document.createElement('div');
        d.innerHTML = html;
        d.style.left = (cx - w / 2) + 'px';
        d.style.top = (cy - h / 2) + 'px';
        d.style.width = w + 'px';
        d.style.height = h + 'px';
        fx.appendChild(d);
        return d;
    }
    // 播放「一下」攻擊；招式打幾下就呼叫幾次
    async function advPlayAttack(m, hitNo) {
        const P = document.getElementById('advPlayer'), E = document.getElementById('advEnemy');
        if (!P || !E) return;
        const d = advDelta(P, E);
        const ec = advActorCenter(E), pc = advActorCenter(P);
        const dash = (f, dur, sc) => advAnimate(P, [
            { transform: 'translate(0,0) scale(1)' },
            { transform: `translate(${d.dx * f}px, ${d.dy * f}px) scale(${sc || 1.12})`, offset: 0.5 },
            { transform: 'translate(0,0) scale(1)' }], { duration: dur || 420, easing: 'ease-in-out' });
        const burst = (txt, size) => { let b = advFx(txt || '💥', ec.x + (Math.random() * 12 - 6), ec.y + (Math.random() * 12 - 6), size || 40); if (b) advAnimate(b, [{ opacity: 0, transform: 'scale(.3)' }, { opacity: 1, transform: 'scale(1.1)', offset: 0.4 }, { opacity: 0, transform: 'scale(1.4)' }], { duration: 380 }).then(() => b.remove()); };
        if (m.fx === 'dash') {
            let p = dash(0.78); await advWait(190); burst(m.icon); await p;
        } else if (m.fx === 'charge') {
            // 衝鋒撞擊：先往後蓄力，再一口氣衝過去
            await advAnimate(P, [{ transform: 'translate(0,0) scale(1)' }, { transform: `translate(${-d.dx * 0.12}px, ${-d.dy * 0.12}px) scale(0.9)` }], { duration: 220, fill: 'forwards', easing: 'ease-out' });
            let p = advAnimate(P, [
                { transform: `translate(${-d.dx * 0.12}px, ${-d.dy * 0.12}px) scale(0.9)` },
                { transform: `translate(${d.dx * 0.84}px, ${d.dy * 0.84}px) scale(1.25)`, offset: 0.6 },
                { transform: 'translate(0,0) scale(1)' }], { duration: 460, easing: 'cubic-bezier(.5,0,.3,1)' });
            await advWait(260); burst(m.icon, 64);
            advAnimate(document.getElementById('advStage'), [{ transform: 'translate(0,0)' }, { transform: 'translate(-3px,2px)' }, { transform: 'translate(3px,-2px)' }, { transform: 'translate(0,0)' }], { duration: 240 });
            await p;
        } else if (m.fx === 'slash') {
            let p = advAnimate(P, [{ transform: 'translate(0,0)' }, { transform: `translate(${d.dx * 0.5}px, ${d.dy * 0.5}px)`, offset: 0.5 }, { transform: 'translate(0,0)' }], { duration: 380, easing: 'ease-in-out' });
            await advWait(170);
            let flip = hitNo % 2 === 1;      // 第二下換個方向斬
            let s = advFx(`<svg viewBox="0 0 60 60" width="100%" height="100%"><path d="M8 8 Q 42 18 52 54" stroke="#FFFFFF" stroke-width="8" fill="none" stroke-linecap="round"/><path d="M8 8 Q 42 18 52 54" stroke="#FACC15" stroke-width="3.5" fill="none" stroke-linecap="round"/></svg>`, ec.x, ec.y, 64);
            if (s) await advAnimate(s, [{ opacity: 0, transform: `scale(${flip ? -.4 : .4}, .4) rotate(${flip ? 25 : -25}deg)` }, { opacity: 1, transform: `scale(${flip ? -1.1 : 1.1}, 1.1) rotate(0deg)`, offset: 0.45 }, { opacity: 0, transform: `scale(${flip ? -1.25 : 1.25}, 1.25) rotate(${flip ? -12 : 12}deg)` }], { duration: 380 }).then(() => s.remove());
            burst(m.icon, 40);
            await p;
        } else if (m.fx === 'thrust') {
            // 突刺：快速直線刺過去，留下一道光
            let ang = Math.atan2(d.dy, d.dx) * 180 / Math.PI;
            let p = advAnimate(P, [{ transform: 'translate(0,0) scale(1)' }, { transform: `translate(${d.dx * 0.82}px, ${d.dy * 0.82}px) scale(1.1)`, offset: 0.4 }, { transform: `translate(${d.dx * 0.82}px, ${d.dy * 0.82}px) scale(1.1)`, offset: 0.55 }, { transform: 'translate(0,0) scale(1)' }], { duration: 480, easing: 'ease-out' });
            let ln = advFxBox(`<svg viewBox="0 0 100 16" width="100%" height="100%" style="overflow:visible"><path d="M0 8 L 86 8" stroke="#E0F2FE" stroke-width="7" stroke-linecap="round"/><path d="M 8 8 L 92 8" stroke="#38BDF8" stroke-width="3" stroke-linecap="round"/><path d="M 90 1 L 100 8 L 90 15 Z" fill="#FFFFFF"/></svg>`, (pc.x + ec.x) / 2, (pc.y + ec.y) / 2, Math.max(50, Math.hypot(d.dx, d.dy) * 0.9), 16);
            if (ln) { ln.style.transformOrigin = '50% 50%'; advAnimate(ln, [{ opacity: 0, transform: `rotate(${ang}deg) scaleX(.3)` }, { opacity: 1, transform: `rotate(${ang}deg) scaleX(1)`, offset: 0.4 }, { opacity: 0, transform: `rotate(${ang}deg) scaleX(1)` }], { duration: 420 }).then(() => ln.remove()); }
            await advWait(200); burst(m.icon, 46); await p;
        } else if (m.fx === 'yellow') {
            // 黃色衝擊波：龜派氣功！先在雙手之間聚氣，再射出一道粗粗的光束
            let ang = Math.atan2(d.dy, d.dx) * 180 / Math.PI;
            let len = Math.max(80, Math.hypot(d.dx, d.dy));
            let orb = advFxBox('<div style="width:100%;height:100%;border-radius:50%;background:radial-gradient(circle,#FFFFFF 0%,#FDE047 45%,rgba(250,204,21,0) 72%)"></div>', pc.x + 20, pc.y, 34, 34);
            if (orb) await advAnimate(orb, [{ opacity: 0.2, transform: 'scale(.2)' }, { opacity: 1, transform: 'scale(1.1)' }], { duration: 380, easing: 'ease-out', fill: 'forwards' });
            let bm = advFxBox(`<svg viewBox="0 0 200 40" width="100%" height="100%" preserveAspectRatio="none" style="overflow:visible"><path d="M0 20 L14 4 L30 12 L46 2 L66 11 L88 1 L110 11 L134 2 L156 11 L178 4 L200 20 L178 36 L156 29 L134 38 L110 29 L88 39 L66 29 L46 38 L30 28 L14 36 Z" fill="#FACC15" stroke="#F59E0B" stroke-width="2" stroke-linejoin="round"/><path d="M0 20 L16 11 H182 L200 20 L182 29 H16 Z" fill="#FFFFFF" opacity="0.92"/></svg>`, pc.x + len / 2 + 14, pc.y, len, 34);
            if (bm) {
                bm.style.transformOrigin = '50% 50%';
                let hold = advAnimate(bm, [
                    { opacity: 1, transform: `rotate(${ang}deg) scaleX(0.02)`, transformOrigin: '0% 50%' },
                    { opacity: 1, transform: `rotate(${ang}deg) scaleX(1)`, transformOrigin: '0% 50%', offset: 0.35 },
                    { opacity: 1, transform: `rotate(${ang}deg) scaleX(1) scaleY(1.15)`, transformOrigin: '0% 50%', offset: 0.75 },
                    { opacity: 0, transform: `rotate(${ang}deg) scaleX(1) scaleY(.4)`, transformOrigin: '0% 50%' }], { duration: 760, easing: 'ease-out' }).then(() => bm.remove());
                await advWait(240); burst(m.icon, 72); advAnimate(document.getElementById('advStage'), [{ transform: 'translate(0,0)' }, { transform: 'translate(-3px,2px)' }, { transform: 'translate(3px,-2px)' }, { transform: 'translate(0,0)' }], { duration: 300 });
                await hold;
            }
            if (orb) { advAnimate(orb, [{ opacity: 1 }, { opacity: 0 }], { duration: 150 }).then(() => orb.remove()); }
        } else if (m.fx === 'wave') {
            // 衝擊波：藍（或黃）色能量彗星從雞塊飛向敵人
            await advAnimate(P, [{ transform: 'translateX(0) scale(1)' }, { transform: 'translateX(-8px) scale(0.92)', offset: 0.5 }, { transform: 'translateX(0) scale(1)' }], { duration: 280 });
            let ang = Math.atan2(d.dy, d.dx) * 180 / Math.PI;
            let big = m.fx === 'yellow';
            let w = big ? 124 : 104, h = w * 46 / 150;
            let c = advFxBox(advCometSVG(big ? 'yellow' : 'blue'), pc.x, pc.y, w, h);
            if (c) {
                await advAnimate(c, [
                    { opacity: 0, transform: `translate(0px, 0px) rotate(${ang}deg) scale(.5)` },
                    { opacity: 1, transform: `translate(${d.dx * 0.12}px, ${d.dy * 0.12}px) rotate(${ang}deg) scale(1)`, offset: 0.15 },
                    { opacity: 1, transform: `translate(${d.dx}px, ${d.dy}px) rotate(${ang}deg) scale(1.05)`, offset: 0.9 },
                    { opacity: 0, transform: `translate(${d.dx}px, ${d.dy}px) rotate(${ang}deg) scale(1.3)` }], { duration: 560, easing: 'ease-in' }).then(() => c.remove());
            }
            let ring = advFx('<div style="width:100%;height:100%;box-sizing:border-box;border-radius:50%;border:4px solid ' + (big ? '#FACC15' : '#38BDF8') + ';background:' + (big ? 'rgba(250,204,21,.3)' : 'rgba(56,189,248,.3)') + '"></div>', ec.x, ec.y, 40);
            if (ring) advAnimate(ring, [{ opacity: 0.9, transform: 'scale(.4)' }, { opacity: 0 , transform: 'scale(2)' }], { duration: 420 }).then(() => ring.remove());
            burst(m.icon, 46);
            await advWait(260);
        }
    }
    async function advHurt(actorEl, dmg, isEnemy, label) {
        advFloat(actorEl, label || ('-' + dmg));
        let dir = isEnemy ? 1 : -1;
        await advAnimate(actorEl, [
            { transform: 'translateX(0)', filter: 'brightness(1)' },
            { transform: `translateX(${8 * dir}px)`, filter: 'brightness(2) saturate(.4)', offset: 0.2 },
            { transform: `translateX(${-7 * dir}px)`, filter: 'brightness(1.6)', offset: 0.5 },
            { transform: `translateX(${4 * dir}px)`, offset: 0.75 },
            { transform: 'translateX(0)', filter: 'brightness(1)' }], { duration: 420 });
    }

    // 幸運擲幣：硬幣飄在攻擊者上方，每個「正面」傷害 +1（最多 +3）
    async function advShowCoins(actorEl, luck, who) {
        advSetLog(`🪙 ${who || ''}幸運擲幣中…`);
        let fx = document.getElementById('advFx');
        let row = null;
        if (fx && actorEl) {
            let c = advActorCenter(actorEl);
            row = document.createElement('div');
            row.className = 'adv-coin-row';
            row.style.left = c.x + 'px';
            row.style.top = Math.max(4, actorEl.offsetTop - 30) + 'px';
            row.innerHTML = luck.flips.map(f => `<div class="adv-coin"><div class="adv-coin-in${f ? ' heads' : ' tails'}"><span class="adv-coin-f">正</span><span class="adv-coin-b">反</span></div></div>`).join('');
            fx.appendChild(row);
            // 先往上拋、一邊翻轉，最後停在正面或反面
            row.querySelectorAll('.adv-coin').forEach((coin, i) => {
                advAnimate(coin, [{ transform: 'translateY(16px)', opacity: 0 }, { transform: 'translateY(-26px)', opacity: 1, offset: 0.45 }, { transform: 'translateY(0)', opacity: 1 }], { duration: 760, delay: i * 90, easing: 'ease-out', fill: 'both' });
                let inner = coin.firstChild, heads = inner.classList.contains('heads');
                advAnimate(inner, [{ transform: 'rotateY(0deg)' }, { transform: `rotateY(${heads ? 1440 : 1620}deg)` }], { duration: 760, delay: i * 90, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' });
            });
            await advWait(780 + luck.flips.length * 90);
            row.querySelectorAll('.adv-coin-in').forEach(el => el.classList.add('done'));
        } else {
            await advWait(600);
        }
        advSetLog(`🪙 ${who || ''}幸運擲幣：${advCoinText(luck.flips)}${luck.bonus ? `　正面 ${luck.bonus} 次！傷害 +${luck.bonus}` : '　沒有正面'}`);
        await advWait(550);
        if (row) await advAnimate(row, [{ opacity: 1 }, { opacity: 0 }], { duration: 220 }).then(() => row.remove());
        if (luck.bonus) { advFloat(actorEl, `+${luck.bonus}`, '#B45309'); await advWait(250); }
    }

    async function advResolveMove(ok) {
        if (!adv.active) return;
        // 防呆：同一次出招只結算一次（避免多題招式在最後一題被重複結算，一次扣掉兩次行動）
        if (adv.resolvedSeq === adv.moveSeq) { console.warn('同一招重複結算，已忽略'); return; }
        adv.resolvedSeq = adv.moveSeq;
        // 熟練度：不論成功或失敗，用一次就 +1（先算好，打倒敵人直接勝利時也會算到）
        let masteryUp = adv.move ? advAddMasteryUse(adv.move.key) : 0;
        advSave();
        if (!ok) advRecordHit(false);
        const id = adv.runId;
        adv.busy = true;
        const m = adv.move;
        const P = document.getElementById('advPlayer'), E = document.getElementById('advEnemy');
        advStopTimer();
        adv.q = null;
        if (ok) {
            document.getElementById('advPanel').innerHTML = `<div class="adv-log" id="advLog">${m.icon} 「${m.name}」發動成功！</div>`;
            // 每一下各自計算：攻擊力 + 招式威力 + 熟練度 − 對方防禦（至少 1）；每一下都各自擲一次幸運幣
            let total = 0;
            let pierce = advHasGear('skewer');         // 竹籤：無視對方護盾
            for (let h = 0; h < m.hits; h++) {
                await advPlayAttack(m, h);
                if (id !== adv.runId) return;
                let dmg = advHitDamage(m);
                let luck = advRollLuck(adv.player.luck, adv.enemy.luck);
                if (luck.flips.length) {
                    await advShowCoins(P, luck, m.hits > 1 ? `第 ${h + 1} 下` : '');
                    if (id !== adv.runId) return;
                    dmg += luck.bonus;
                }
                let immune = ADV_IMMUNE[adv.enemy.special] === m.type;
                let guarded = immune || ADV_RESIST[adv.enemy.special] === m.type;
                if (immune) dmg = 0;                    // 完全不受這類招式的傷害
                else if (guarded) dmg = Math.min(dmg, 1);    // 對這類招式有抗性：每一下最多 1 點
                let weak = ADV_WEAK_BONUS[adv.enemy.special];
                if (weak && weak.type === m.type && dmg > 0) advFloat(E, '💥 效果拔群！', '#DC2626');
                total += dmg;
                let hadShield = adv.enemy.shield > 0;
                let er = advTakeDamage(adv.enemy, dmg, pierce);
                advSetLog(immune
                    ? `🛡️ ${adv.enemy.name}防禦了${ADV_TYPE_LABEL[m.type]}招式！完全沒有受到傷害`
                    : guarded
                    ? `🛡️ ${adv.enemy.name}防禦了${ADV_TYPE_LABEL[m.type]}招式！${er.absorbed ? `護盾再擋下 ${er.absorbed} 點，` : ''}只受到 ${er.loss} 點傷害`
                    : `${weak && weak.type === m.type ? '💥 效果拔群！' : '✨'}「${m.name}」${m.hits > 1 ? `第 ${h + 1} 下` : ''}命中！${adv.enemy.name}${er.absorbed ? `護盾擋下 ${er.absorbed} 點，` : ''}${pierce && hadShield ? '竹籤刺穿護盾！' : ''}受到 ${er.loss} 點傷害`);
                advUpdateHud();
                await advHurt(E, dmg, true, (guarded ? '🛡️防禦 ' : '') + advHurtLabel(er));
                if (id !== adv.runId) return;
                if (adv.enemy.hp <= 0) {
                    if (await advEnemyDown(id)) return;
                    if (id !== adv.runId) return;
                    break;                               // 換下一個敵人：這招剩下的攻擊不再繼續
                }
            }
        } else {
            document.getElementById('advPanel').innerHTML = `<div class="adv-log" id="advLog">💨 「${m.name}」發動失敗…</div>`;
            advFloat(P, 'MISS', '#64748B');
            await advAnimate(P, [{ transform: 'translateX(0)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(5px)' }, { transform: 'translateX(0)' }], { duration: 320 });
            await advWait(300);
            if (id !== adv.runId) return;
            // 裝備「烤焦臭豆腐」：招式失敗時雙方各扣 1 點體力
            if (advHasGear('tofu')) {
                let er = advTakeDamage(adv.enemy, 1), pr = advTakeDamage(adv.player, 1);
                advData.hp = adv.player.hp;
                advSave();
                advSetLog('🔥 烤焦臭豆腐爆發！雙方各扣 1 點體力');
                advUpdateHud();
                await Promise.all([advHurt(E, 1, true, advHurtLabel(er)), advHurt(P, 1, false, advHurtLabel(pr))]);
                if (id !== adv.runId) return;
                if (adv.player.hp <= 0 && adv.enemy.hp > 0) { await advLose(id); return; }
                if (adv.enemy.hp <= 0) { if (await advEnemyDown(id)) return; if (id !== adv.runId) return; }
                if (adv.player.hp <= 0) { await advLose(id); return; }
            }
            // 臭豆腐的「發臭」：招式失敗就被臭味反擊，無視防禦，固定 1 點
            if (adv.enemy.special === 'stink') {
                let dr = advTakeDamage(adv.player, 1);
                advSetLog(`🤢 ${adv.enemy.name}散發臭味！無視防禦，${dr.absorbed ? '護盾擋下 1 點' : '雞塊受到 1 點傷害'}`);
                advData.hp = adv.player.hp;
                advSave();
                advUpdateHud();
                await advHurt(P, 1, false, advHurtLabel(dr));
                if (id !== adv.runId) return;
                if (adv.player.hp <= 0) { await advLose(id); return; }
            }
        }
        let up = masteryUp;
        if (up) {
            advFloat(P, `⬆️ 熟練度 ${up}`, '#4F46E5');
            advSetLog(`⬆️ 「${m.name}」熟練度提升到 ${up}！這招攻擊 +1`);
            await advWait(900);
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
            if (adv.enemy.special === 'pinball') {
                let r = 1 + Math.floor(Math.random() * 6);
                advFloat(E, '🎰技能骰 ' + r, '#0284C7');
                if (r <= 2) {
                    adv.enemy.hp = Math.min(adv.enemy.max, adv.enemy.hp + 2);
                    advSetLog(`🎰【打彈珠】技能骰 ${r}（不是幸運骰）　彈珠台回復 2 點體力`);
                    await advWait(500);
                    advUpdateHud();
                    advFloat(E, '+2', '#10B981');
                    await advWait(700);
                } else if (r <= 4) {
                    advSetLog(`🎰【打彈珠】技能骰 ${r}（不是幸運骰）　沒有效果`);
                    await advWait(1000);
                } else {
                    advSetLog(`🎰【打彈珠】技能骰 ${r}（不是幸運骰）　彈珠直擊！無視防禦扣 1 點體力`);
                    await advWait(500);
                    let pr = advTakeDamage(adv.player, 1);
                    advData.hp = adv.player.hp;
                    advSave();
                    advUpdateHud();
                    await advHurt(P, 1, false, advHurtLabel(pr));
                    if (id !== adv.runId) return;
                    if (adv.player.hp <= 0) { await advLose(id); return; }
                }
                if (id !== adv.runId) return;
                document.getElementById('advPanel').innerHTML = `<div class="adv-log" id="advLog">${escapeHTML(adv.enemy.name)}的「${escapeHTML(adv.enemy.moveName)}」攻擊！</div>`;
            }
            const d = advDelta(E, P);
            await advAnimate(E, [{ transform: 'translate(0,0) scale(1)' }, { transform: `translate(${d.dx * 0.8}px, ${d.dy * 0.8}px) scale(1.12)`, offset: 0.5 }, { transform: 'translate(0,0) scale(1)' }], { duration: 480, easing: 'ease-in-out' });
            if (id !== adv.runId) return;
            let dmg = advDamage(adv.enemy.atk, adv.enemy.movePower, adv.player.def);
            let luck = advRollLuck(adv.enemy.luck, adv.player.luck);
            if (luck.flips.length) {
                await advShowCoins(E, luck, adv.enemy.name + '的');
                if (id !== adv.runId) return;
                dmg += luck.bonus;
            }
            let dr = advTakeDamage(adv.player, dmg, adv.enemy.special === 'salad');   // 盒裝沙拉：無視雞塊的護盾
            advData.hp = adv.player.hp;          // 體力會繼承到之後的戰鬥
            advSave();
            advSetLog(`${adv.enemy.name}的攻擊！${dr.absorbed ? `護盾擋下 ${dr.absorbed} 點，` : ''}雞塊受到 ${dr.loss} 點傷害`);
            advUpdateHud();
            await advHurt(P, dmg, false, advHurtLabel(dr));
            if (id !== adv.runId) return;
            if (adv.player.hp <= 0) { await advLose(id); return; }
            if (adv.enemy.special === 'microwave') {
                adv.enemy.atk += ADV_MICRO_ATK_UP;
                advSetLog(`🔥 轉吧！美味雞塊！${adv.enemy.name}越來越燙，攻擊力 +${ADV_MICRO_ATK_UP}（現在 ${adv.enemy.atk}）`);
                advFloat(E, `攻擊 +${ADV_MICRO_ATK_UP}`, '#F97316');
                advUpdateHud();
                await advWait(800);
                if (id !== adv.runId) return;
            }
            if (adv.enemy.special === 'expire') {
                adv.enemy.hp = Math.max(0, adv.enemy.hp - ADV_EXPIRE_SELF);
                advSetLog(`🥀 我快過期了..（${adv.enemy.name}自己扣了 ${ADV_EXPIRE_SELF} 點體力）`);
                advUpdateHud();
                await advHurt(E, ADV_EXPIRE_SELF, true, '-' + ADV_EXPIRE_SELF);
                if (id !== adv.runId) return;
                advFloat(E, '我快過期了..', '#64748B');
                await advWait(500);
                if (id !== adv.runId) return;
                if (adv.enemy.hp <= 0) { await advEnemyDown(id); return; }
            }
        }
        // 珍珠奶茶的「治癒」：敵人攻擊結束後回 1 點體力
        if (adv.enemy.special === 'heal' && adv.enemy.hp < adv.enemy.max) {
            adv.enemy.hp = Math.min(adv.enemy.max, adv.enemy.hp + 1);
            advSetLog(`💚 ${adv.enemy.name}發動治癒，回復 1 點體力`);
            advUpdateHud();
            advFloat(E, '+1', '#10B981');
            await advWait(900);
            if (id !== adv.runId) return;
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
        try {   // 每日任務：在大冒險中打贏一場敵人
            checkDailyReset();
            if (chickenData.tasks.advWin && !chickenData.tasks.advWin.done && !isTaskClaimed('advWin')) { chickenData.tasks.advWin.done = true; saveChickenData(); }
        } catch (e) {}
        let gainShards = first ? lv.firstShards : lv.repeatShards;
        let gainSauce = first ? lv.firstSauce : 0;
        // 幸運的第二個用途：打贏後擲幣，每個正面碎片 +1（最多 +3）
        let loot = advRollLuck(adv.player.luck, adv.enemy.luck);
        let gotTicket = (!first && lv.ticketChance && Math.random() < lv.ticketChance) ? 1 : 0;
        if (first && lv.firstTickets) gotTicket += lv.firstTickets;
        if (gotTicket) advData.tickets += gotTicket;
        let dropPotion = (!first && lv.potionChance && Math.random() < lv.potionChance) ? 1 : 0;    // IBON 機：重複通關 20% 掉恢復藥水
        if (dropPotion) advData.potions += dropPotion;
        let sodaHeal = 0;
        if (advHasGear('soda') && advData.hp > 0 && advData.hp < advMaxHp()) { sodaHeal = 1; advData.hp += 1; adv.player.hp = advData.hp; }
        gainShards += loot.bonus;
        let clawBonus = (lv.special === 'claw' && Math.random() < 0.5) ? 1 : 0;   // 娃娃機：50% 機會碎片 +1
        gainShards += clawBonus;
        advData.shards += gainShards;
        advData.sauce += gainSauce;
        let gotCombo = false, gotMaxHp = 0, gotPotions = 0;
        if (first && lv.firstMaxHp && advData.up.hp < ADV_UP_MAX) { gotMaxHp = lv.firstMaxHp; advData.up.hp += gotMaxHp; advData.hp += gotMaxHp; }
        if (first && lv.firstPotions) { gotPotions = lv.firstPotions; advData.potions += gotPotions; }
        let gotMoves = [];
        if (first) ADV_MOVES.forEach(m => { if (m.buy.kind === 'reward' && m.buy.level === lv.id && !advData.own[m.key]) { advData.own[m.key] = true; advAutoEquip(m.key); gotMoves.push(m); } });
        gotCombo = gotMoves.length > 0;
        let gotItem = '';
        let hadGearBefore = Object.keys(advData.items).some(k => advData.items[k]);   // 之前就有裝備：不再顯示「去裝備」的紅字
        if (first && lv.firstItem && !advData.items[lv.firstItem]) { advData.items[lv.firstItem] = true; gotItem = lv.firstItem; }
        advSave();
        document.getElementById('advPanel').innerHTML = `<div class="adv-log" id="advLog">🎉 打敗了${escapeHTML(lv.name)}！</div>`;
        advAnimate(E, [{ transform: 'scale(1) rotate(0deg)', opacity: 1 }, { transform: 'scale(.15) rotate(540deg)', opacity: 0 }], { duration: 750, fill: 'forwards', easing: 'ease-in' });
        await advAnimate(P, [{ transform: 'translateY(0)' }, { transform: 'translateY(-16px)', offset: 0.3 }, { transform: 'translateY(0)', offset: 0.6 }, { transform: 'translateY(-10px)', offset: 0.8 }, { transform: 'translateY(0)' }], { duration: 800 });
        if (id !== adv.runId && adv.runId !== id) return;
        let lines = [], pop = [];
        if (gainShards > 0) { lines.push(`<div class="line">${advShardIcon(16)} 糖醋醬碎片 +${gainShards}</div>`); pop.push(`${advShardIcon(22)} 糖醋醬碎片 ×${gainShards}`); }
        if (loot.flips.length) {
            lines.push(`<div class="line" style="color:#B45309;font-weight:700;">🪙 幸運擲幣 ${advCoinText(loot.flips)}　${loot.bonus ? `正面 ${loot.bonus} 次，碎片多 +${loot.bonus}` : '沒有正面，沒有額外碎片'}</div>`);
            if (loot.bonus) pop.push(`🪙 幸運加成：糖醋醬碎片 +${loot.bonus}`);
        }
        if (gotTicket) { pop.push(`${advTicketIcon(22)} 冒險卷 ×${gotTicket}`); lines.push(`<div class="line" style="font-weight:800;">${advTicketIcon(16)} ${first ? '首次通關獎勵' : '掉落'}：冒險卷 ×${gotTicket}（到背包使用：今天重複挑戰次數 +1）</div>`); }
        if (dropPotion) { pop.push(`🧪 恢復藥水 ×1`); lines.push(`<div class="line" style="font-weight:800;">🧪 掉落恢復藥水 ×1</div>`); }
        if (sodaHeal) lines.push(`<div class="line" style="color:#0369A1;font-weight:800;">${advSodaIcon(16)} 喝了彈珠汽水，HP +1</div>`);
        if (clawBonus) pop.push(`🧸 送你娃娃！糖醋醬碎片 +1`);
        if (gotItem) pop.push(`${ADV_ITEMS[gotItem].icon(22)} 獲得裝備：${ADV_ITEMS[gotItem].name}${hadGearBefore ? '' : '<br><small style="color:#EF4444;font-weight:800;">❗ 到「能力值 → 裝備」裝備它</small>'}`);
        if (first && lv.id === 2) pop.push(`🛒 補給站可以用碎片買裝備囉！<br><small style="color:var(--text-muted);font-weight:700;">首頁「雞塊補給站」→ 雞塊大冒險（彈珠汽水 ${ADV_SODA_PRICE} 碎片）</small>`);
        if (gainSauce > 0) pop.push(`${advSauceIcon(22)} 糖醋醬 ×${gainSauce}`);
        if (gotMaxHp) pop.push(`❤️ 生命上限 +${gotMaxHp}`);
        if (gotPotions) pop.push(`🧪 恢復藥水 ×${gotPotions}`);
        gotMoves.forEach(m => pop.push(`${m.icon} 學會${m.name}`));
        if (gainSauce > 0) lines.push(`<div class="line" style="color:${ADV_SAUCE_COLOR};font-weight:800;">${advSauceIcon(16)} ${first ? '首次通關獎勵：' : ''}糖醋醬 +${gainSauce}</div>`);
        if (gotMaxHp) lines.push(`<div class="line" style="font-weight:800;">❤️ 首次通關獎勵：生命上限 +${gotMaxHp}</div>`);
        if (gotPotions) lines.push(`<div class="line" style="font-weight:800;">🧪 首次通關獎勵：恢復藥水 ×${gotPotions}</div>`);
        if (clawBonus) lines.push(`<div class="line" style="font-weight:800;">🧸 送你娃娃！糖醋醬碎片多 +1</div>`);
        if (gotItem) lines.push(`<div class="line" style="font-weight:800;">🎁 首次通關獎勵：${ADV_ITEMS[gotItem].icon(16)} ${ADV_ITEMS[gotItem].name}</div>${hadGearBefore ? '' : '<div class="line" style="color:#EF4444;font-weight:800;">❗ 到「💪 能力值 → 裝備」把它裝備起來吧！</div>'}`);
        if (first && lv.id === 2) lines.push(`<div class="line" style="color:var(--primary);font-weight:800;">🛒 可以到「雞塊補給站」用碎片購買裝備囉！</div>`);
        gotMoves.forEach(m => lines.push(`<div class="line" style="font-weight:800;">🎁 學會新招式：${m.icon} ${m.name}！</div>`));
        let nextLv = ADV_LEVELS.find(l => l.id === lv.id + 1);
        document.getElementById('advPanel').innerHTML = `
            <div class="adv-result">
                <div class="big">🎉 勝利！</div>
                ${lines.join('')}
                <div class="line" style="color:var(--text-muted);font-size:12px;">體力剩 ${advData.hp}/${advMaxHp()}（每天 00:00 恢復）</div>
            </div>
            ${advData.hp > 0 ? `<button type="button" class="adv-plain-btn main" data-on-click='[["advRetry",[]]]'>再戰一次</button>` : ''}
            ${nextLv ? `<button type="button" class="adv-plain-btn next" data-on-click='[["advNextLevel",[]]]'>挑戰下一關</button>` : `<button type="button" class="adv-plain-btn sub" data-on-click='[["advBackToMenu",[]]]'>回關卡</button>`}`;
        advShowReward(pop);
    }
    // 勝利後跳出的獎勵視窗：簡短列出拿到什麼
    function advShowReward(items) {
        let body = document.getElementById('advRewardBody');
        if (!body || !items.length) return;
        body.innerHTML = `<div class="adv-reward-title">🎉 獲得獎勵</div>${items.map(t => `<div class="adv-reward-item">${t}</div>`).join('')}`;
        document.getElementById('advRewardModal').style.display = 'block';
    }
    function advCloseReward() { document.getElementById('advRewardModal').style.display = 'none'; }
    function advNextLevel() {
        let id = adv.level ? adv.level.id + 1 : 1;
        advAbort();
        goToAdvLevel(id);
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
        toggleAdvCard, advToggleMove, advMapStep, advOpenGearSlot, advOpenHit, advCloseHit, advBagUnselect, advSetStatsTab, advFocusMove, advSetBagFilter, advBagTap, advBagUseTicket, advBagWipe, advWipeFrom, advWipeApply, advBuyWipe, advSetMoveFilter, advToggleEquip, advUseBoba, advToggleMoreMoves, advNextLevel, advCloseReward, advOpenBag, advCloseBag, advBagSauce, advBagBack, advBagUseSauce, advBagUsePotion, advBuyPotion, advBuyMove, advWeeklyExchange, setShopTab, advStartBattle, advChooseMove, advAnswerCard, advSubmitListen, advSubmitCn, advAnswerListen, advReplayListen, advGiveUpSpeak,
        advQuit, advRetry, advBackToMenu, advBackToLevel, goToAdvLevel, goToAdvStats, advOpenStatInfo, advMoveStep, advUpgrade, advExchangeShards,
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
        handleChiKeyDown,
        openWordFormatModal,
        closeWordFormatModal,
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
        handleLogout,
        openCloudSettings, cloudReconnect,
        voiceChiToggle, applyVoiceChiButtons,
        advSetShopFilter, advBuySoda, advRunTestCodeInput
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
