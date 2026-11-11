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
    // supabase 套件沒載到（網路慢／被擋，或舊版 iOS 看不懂新版套件）時不能讓整個 app 停掉：
    // 沒有它只是雞塊錢包連不上，其他功能照常（之後呼叫到時會被 try/catch 接住）
    let supabaseClient = null;
    try {
        if (window.supabase && window.supabase.createClient) supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        else console.error('⚠️ supabase 套件沒有載入，雞塊錢包暫時無法使用');
    } catch (e) { console.error('⚠️ supabase 初始化失敗:', e); }
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
    
    const OB_FIRST_RUN = localStorage.getItem('dictation_word_lists') === null;   // 第一次打開 App（新手教學用）
    let wordLists = JSON.parse(localStorage.getItem('dictation_word_lists')) || [];

    if (wordLists.length === 0) {
        let nowTs = Date.now();
        // 新玩家：先給一個空的「我的單字」，新手教學最後一步會帶他放進第一個字
        wordLists.push(OB_FIRST_RUN ? { title: '我的單字', content: '', createdAt: nowTs }
                                    : { title: `unit 1-1`, content: "courage 勇氣\n*foreigner 外國人\n*fantastic 極好的 形容詞", createdAt: nowTs });
        localStorage.setItem('dictation_word_lists', JSON.stringify(wordLists));
    }
    ensureListIds();   // 舊題庫補上固定識別碼

    // ---------------------------------
    // 🍗 雞塊系統：雞塊數量、領取紀錄、購買紀錄一律以後端 (Supabase) 為準
    // ---------------------------------
    // 本機只保存「今天各任務有沒有完成」(chickenData)。
    // 前端不能直接寫入雞塊數，只能呼叫後端函式 claim_reward / buy_item；
    // 就算有人用 F12 改了畫面上的數字，下次連線也會被後端的數字蓋回來。
    // 每日任務（2026/11 改版）：每日登入／任一練習 10 題／任一測驗 10 題／大冒險打敗敵人／農場澆水或收成
    const CHICKEN_TASK_KEYS = ['dailyLogin', 'practice10', 'exam10', 'advWin', 'farmCare'];

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
        pack_toeic_job: { name: '多益-職場', desc: '購買後多一本「多益-職場」英文單字庫（300 個職場單字），不占用你原本的題庫數量。\n這本單字庫不能清空、刪除或更換語言。' }
    };
    let shopCatalog = {
        word_cap_50: { price: 30, max: 4 },
        list_slot_1: { price: 60, max: 89 },
        mv_charge: { price: 5, max: 1 },
        mv_slash2: { price: 3, max: 1 },
        mv_thrust: { price: 5, max: 1 },
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
        basic_noun: { free: true, title: '多益-基礎名詞', oldTitles: ['基礎單字-名詞'], lang: 'en', words: 300, kind: 'toeic' },
        basic_verb: { free: true, title: '多益-基礎動詞形容詞', oldTitles: ['基礎單字-動詞形容詞'], lang: 'en', words: 300, kind: 'toeic' },
        toeic_job: { item: 'pack_toeic_job', title: '多益-職場', lang: 'en', words: 300, kind: 'toeic' },
        toeic_people: { free: true, title: '多益-人際溝通', lang: 'en', words: 300, kind: 'toeic' },
        toeic_office: { free: true, title: '多益-辦公室常用', lang: 'en', words: 300, kind: 'toeic' },
        adv_night: { free: true, title: '冒險・夜市篇', lang: 'en', words: 50, kind: 'adv', chapter: 1 },
        adv_store: { free: true, title: '冒險・便利商店篇', lang: 'en', words: 80, kind: 'adv', chapter: 2 },
        farm_1_5: { free: true, title: '農場・Lv1～5', lang: 'en', words: 82, kind: 'farm' }    // 雞塊農場的題庫（蜜蜂採蜜也從這裡出題）
    };
    // 精選單字庫的圖示：同一類共用一張（多益：TOEIC 字樣／基礎：ABC 字樣），紫色實心
    function packIconHTML(packKey, size) {
        size = size || 30;
        let kind = (WORD_PACKS[packKey] || {}).kind || 'basic';
        if (kind === 'farm') return `<svg class="pk-ic" width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="11" fill="#22A06B"/><path d="M20 31 V18" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round"/><path d="M20 20 C20 13 14 10 9 11 C9 17 13 21 20 20 Z" fill="#FFFFFF"/><path d="M20 17 C20 11 25 8 31 9 C31 15 27 18 20 17 Z" fill="#D9F99D"/><path d="M10 31 H30" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round"/></svg>`;
        if (kind === 'adv') return `<svg class="pk-ic" width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="11" fill="#F59E0B"/><path d="M8 12 L15 9.5 L25 12.5 L32 10 V28 L25 30.5 L15 27.5 L8 30 Z" fill="#FFFFFF"/><path d="M12 25 Q16 18 21 21 T28 14" stroke="#F59E0B" stroke-width="2" fill="none" stroke-dasharray="2.6 2.4" stroke-linecap="round"/><circle cx="28" cy="14" r="2.4" fill="#F59E0B"/></svg>`;
        let txt = kind === 'toeic' ? '<text x="20" y="24.2" text-anchor="middle" font-size="11" font-weight="900" fill="#FFFFFF" textLength="30" lengthAdjust="spacingAndGlyphs" font-family="Inter,Arial,sans-serif">TOEIC</text>'
                                   : '<text x="20" y="25.4" text-anchor="middle" font-size="14" font-weight="900" fill="#FFFFFF" textLength="27" lengthAdjust="spacingAndGlyphs" font-family="Inter,Arial,sans-serif">ABC</text>';
        return `<svg class="pk-ic" width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="11" fill="#5B54EA"/>${txt}</svg>`;
    }
    // 免費附贈的精選單字庫：直接放在 App 裡，不用下載
    const FREE_PACK_CONTENT = {
        toeic_people: "accommodating 樂於助人的 形容詞\nacknowledge 承認 告知收到 動詞\naddress 處理 動詞 地址 名詞\nadmire 欽佩 動詞\nadvice 建議 名詞\nadvise 建議 勸告 動詞\nagreeable 令人愉快的 欣然同意的 形容詞\nannoyed 惱怒的 形容詞\nanxious 焦慮的 渴望的 形容詞\napologetic 歉疚的 形容詞\napologize 道歉 動詞\napology 道歉 名詞\napology letter 致歉信 名詞\nappreciate 感激 欣賞 動詞\napproachable 平易近人的 形容詞\nargue 爭論 動詞\nargument 爭論 論點 名詞\nas requested 依照要求 副詞\nask for 要求 動詞\nassist 協助 動詞\nassistance 協助 名詞\nassure 向…保證 動詞\nattend to 處理 照料 動詞\nattention 注意力 名詞\nattentive 體貼的 專心的 形容詞\nattitude 態度 名詞\navailable 有空的 可取得的 形容詞\nawkward 尷尬的 形容詞\nbehave 表現 守規矩 動詞\nbehavior 行為 名詞\nbody language 肢體語言 名詞\nbother 打擾 動詞 麻煩 名詞\nbring up 提出 動詞\ncall back 回電 動詞\ncall center 客服中心 名詞\ncaller 來電者 名詞\ncalm 冷靜的 形容詞 使平靜 動詞\ncare 關心 照顧 名詞 動詞\ncaring 關懷的 形容詞\ncasual 隨意的 非正式的 形容詞\ncatch up 趕上 補做 動詞\nchat 聊天 動詞 名詞\ncheck with 向…確認 動詞\ncheerful 開朗的 形容詞\nclarification 澄清 名詞\nclarify 澄清 動詞\nclear up 澄清 解決 動詞\nclient 客戶 名詞\ncolleague 同事 名詞\ncomment 評論 名詞 動詞\ncommunicate 溝通 動詞\ncommunication 溝通 通訊 名詞\ncompensate 補償 動詞\ncomplain 抱怨 動詞\ncomplaint 抱怨 客訴 名詞\ncompliment 讚美 名詞 動詞\ncomplimentary 免費贈送的 讚美的 形容詞\nconcern 擔憂 名詞 涉及 動詞\nconcerning 關於 介系詞\nconfidence 信心 名詞\nconfident 有自信的 形容詞\nconfirm 確認 動詞\nconfirmation 確認 名詞\nconflict 衝突 名詞\nconfuse 使困惑 動詞\nconfusion 困惑 混亂 名詞\nconnect 聯繫 動詞\nconsiderate 體貼的 形容詞\nconsideration 體諒 考慮 名詞\nconsult 諮詢 動詞\nconsumer 消費者 名詞\ncontact 聯絡 動詞 聯絡人 名詞\ncontribute 貢獻 動詞\nconvenience 便利 名詞\nconvenient 方便的 形容詞\nconversation 對話 名詞\nconvince 說服 動詞\ncooperate 合作 配合 動詞\ncooperation 合作 名詞\ncooperative 合作的 形容詞\ncordial 熱誠的 形容詞\ncount on 指望 動詞\ncourteous 有禮貌的 形容詞\ncourtesy 禮貌 名詞\ncriticism 批評 名詞\ncriticize 批評 動詞\ncustomer 顧客 名詞\ncustomer complaint 顧客投訴 名詞\ncustomer feedback 顧客意見 名詞\ncustomer inquiry 顧客詢問 名詞\ncustomer satisfaction 顧客滿意度 名詞\ncustomer service 客戶服務 名詞\ncustomer support 客戶支援 名詞\ncustomer-oriented 顧客導向的 形容詞\ndamaged 損壞的 形容詞\ndeal 處理 動詞 交易 名詞\ndeal with 處理 應付 動詞\ndedicate 致力於 動詞\ndelighted 高興的 形容詞\ndemanding 要求高的 形容詞\ndeny 否認 拒絕 動詞\ndescribe 描述 動詞\ndescription 描述 名詞\ndialogue 對話 名詞\ndisagree 不同意 動詞\ndisappoint 使失望 動詞\ndisappointed 失望的 形容詞\ndiscourteous 失禮的 形容詞\ndissatisfaction 不滿 名詞\ndissatisfied 不滿意的 形容詞\neager 渴望的 形容詞\nemotion 情緒 名詞\nempathize 同理 動詞\nempathy 同理心 名詞\nemphasize 強調 動詞\nencourage 鼓勵 動詞\nenthusiastic 熱情的 形容詞\nescalate 升級處理 動詞\netiquette 禮儀 名詞\nexchange 交換 退換 動詞 名詞\nexcuse 藉口 名詞 原諒 動詞\nexpectation 期望 名詞\nexplanation 解釋 說明 名詞\nexpress 表達 動詞 快遞的 形容詞\nextension 分機 延長 名詞\nface-to-face 面對面的 形容詞\nfault 過錯 名詞\nfaulty 有瑕疵的 形容詞\nfeedback 回饋 意見 名詞\nfile a complaint 提出投訴 動詞\nfollow up 後續追蹤 動詞\nfollow-up 後續追蹤 名詞\nfrank 坦白的 形容詞\nfriendly 友善的 形容詞\nfrustrated 沮喪的 形容詞\ngenerous 慷慨的 形容詞\ngentle 溫和的 形容詞\ngenuine 真誠的 真正的 形容詞\ngesture 手勢 姿態 名詞\nget along with 與…相處融洽 動詞\nget back to 回覆 動詞\nget in touch with 與…聯絡 動詞\nget through 打通電話 動詞\ngrateful 感激的 形容詞\ngratitude 感激 名詞\ngreet 問候 迎接 動詞\ngreeting 問候 名詞\nguarantee 保證 名詞 動詞\nhandle 處理 動詞 把手 名詞\nhang up 掛電話 動詞\nharmony 和諧 名詞\nhear from 收到…的消息 動詞\nhelp desk 服務台 名詞\nhelpful 有幫助的 形容詞\nhesitate 猶豫 動詞\nhold on 稍等 動詞\nhold time 等候時間 名詞\nhonest 誠實的 形容詞\nhospitable 好客的 形容詞\nhospitality 款待 名詞\nhotline 熱線 名詞\nhumble 謙虛的 形容詞\nignore 忽視 動詞\nimpatient 不耐煩的 形容詞\nimpolite 沒禮貌的 形容詞\nimpression 印象 名詞\nin a timely manner 及時地 副詞\nin person 親自 副詞\ninconvenience 不便 名詞 造成不便 動詞\ninform 通知 動詞\ninquire 詢問 動詞\ninquiry 詢問 名詞\ninsist 堅持 動詞\ninteract 互動 動詞\ninteraction 互動 名詞\ninterpersonal 人際的 形容詞\ninterrupt 打斷 動詞\nintroduce 介紹 動詞\nissue 問題 議題 名詞 發行 動詞\nkeep in touch 保持聯絡 動詞\nkindly 好心地 副詞\nkindness 親切 名詞\nleave a message 留言 動詞\nlive chat 線上客服 名詞\nlook into 調查 動詞\nloyal 忠誠的 形容詞\nloyalty 忠誠 名詞\nmake up for 彌補 動詞\nmanner 方式 名詞\nmanners 禮貌 名詞\nmention 提及 動詞\nmisunderstand 誤會 動詞\nmisunderstanding 誤會 名詞\nmutual 互相的 形容詞\noffend 冒犯 動詞\non behalf of 代表 介系詞\non hold 等候中 形容詞\nopinion 意見 名詞\novercharge 多收費 動詞\npass on 轉達 動詞\npatience 耐心 名詞\npatient 有耐心的 形容詞 病人 名詞\npersonality 個性 名詞\npersuade 說服 動詞\npleasant 令人愉快的 形容詞\npleasure 榮幸 樂趣 名詞\npoint out 指出 動詞\npolite 有禮貌的 形容詞\npositive 正面的 積極的 形容詞\npraise 稱讚 動詞 名詞\nprofessionalism 專業素養 名詞\nprompt 迅速的 形容詞 促使 動詞\npromptly 迅速地 準時地 副詞\nproper 適當的 形容詞\nput through 轉接電話 動詞\nquery 疑問 名詞 詢問 動詞\nreach out 主動聯繫 動詞\nreasonable 合理的 形容詞\nreassure 使安心 動詞\nreassuring 令人安心的 形容詞\nreceipt 收據 名詞\nreception 接待處 歡迎會 名詞\nreceptionist 接待員 名詞\nrecognize 認出 認可 動詞\nrecommend 推薦 動詞\nrecommendation 推薦 建議 名詞\nrefer 提及 轉介 動詞\nrefund 退款 名詞 動詞\nregarding 關於 介系詞\nregret 遺憾 後悔 動詞 名詞\nrelationship 關係 名詞\nreliable 可靠的 形容詞\nrely on 依賴 動詞\nremind 提醒 動詞\nrepair 修理 動詞 名詞\nreplace 替換 動詞\nreplacement 更換 替代品 名詞\nreply to 回覆 動詞\nrepresentative 代表 名詞 有代表性的 形容詞\nrequest 請求 名詞 動詞\nresolution 解決 決議 名詞\nresolve 解決 動詞\nrespect 尊重 名詞 動詞\nrespectful 恭敬的 形容詞\nrespond 回應 動詞\nresponse 回應 名詞\nresponsive 反應迅速的 形容詞\nresponsiveness 回應速度 名詞\nreturn policy 退貨政策 名詞\nreview 評論 名詞 審查 動詞\nrude 無禮的 形容詞\nrun into 遇到 偶遇 動詞\nsatisfaction 滿意 名詞\nsatisfaction survey 滿意度調查 名詞\nsatisfactory 令人滿意的 形容詞\nsatisfied 滿意的 形容詞\nsatisfy 使滿意 動詞\nsensitive 敏感的 形容詞\nserve 服務 供應 動詞\nservice 服務 名詞\nservice representative 客服專員 名詞\nsincere 真誠的 形容詞\nsincerely 真誠地 副詞\nsmooth 順利的 形容詞\nsolution 解決方法 名詞\nsolve 解決 動詞\nsort out 解決 整理 動詞\nspeak up 大聲說 動詞\nstore credit 購物抵用金 名詞\nstraightforward 直接的 簡單的 形容詞\nsupport 支持 名詞 動詞\nsympathetic 同情的 形容詞\nsympathy 同情 名詞\ntactful 圓滑的 得體的 形容詞\ntake a message 記下留言 動詞\ntalk over 商量 動詞\nthank-you note 感謝函 名詞\nthankful 感謝的 形容詞\nthoughtful 體貼的 形容詞\ntolerate 容忍 動詞\ntoll-free 免付費的 形容詞\ntone 語氣 名詞\ntroubleshoot 排解問題 動詞\ntrust 信任 名詞 動詞\ntrustworthy 值得信賴的 形容詞\nunderstanding 理解 諒解 名詞\nunfortunately 不幸地 遺憾地 副詞\nunhappy 不高興的 形容詞\nupset 心煩的 形容詞 使心煩 動詞\nurgent 緊急的 形容詞\nvalued 珍視的 形容詞\nvalued customer 重要顧客 名詞\nvoice 聲音 名詞\nvoicemail 語音信箱 名詞\nwalk-in 無預約的 形容詞\nwarmly 熱情地 副詞\nwelcome 歡迎 動詞 名詞\nwilling 願意的 形容詞\nwith regard to 關於 介系詞\nwork out 解決 想出 動詞",
        toeic_office: "absent 缺席的 形容詞\naccess 存取 名詞 動詞\naccess card 門禁卡 名詞\naccessory 配件 名詞\naccuracy 準確性 名詞\naccurate 準確的 形容詞\nadministration 行政 管理 名詞\nadministrative 行政的 形容詞\nadministrator 管理員 名詞\nagenda 議程 名詞\nahead of schedule 提前 副詞\nannounce 宣布 動詞\nannouncement 公告 名詞\nappointment 約會 預約 名詞\napproval 批准 名詞\napprove 批准 動詞\narchive 檔案庫 名詞 歸檔 動詞\narrange 安排 整理 動詞\nas soon as possible 盡快 副詞\nassign 分派 動詞\nassignment 任務 名詞\nassistant 助理 名詞\nattach 附加 動詞\nattachment 附件 名詞\nattend 出席 動詞\nattendance 出勤 出席人數 名詞\nauthorization 授權 名詞\nauthorize 授權 動詞\navailability 可用性 有空 名詞\nback up 備份 動詞\nbackup 備份 名詞\nbadge 識別證 名詞\nbehind schedule 落後進度 副詞\nbinder 活頁夾 名詞\nboard 董事會 公告板 名詞\nboard meeting 董事會議 名詞\nbranch 分公司 名詞\nbreak room 員工休息室 名詞\nbrief 簡短的 形容詞 簡報 名詞\nbriefing 簡報 名詞\nbroken 故障的 形容詞\nbudget 預算 名詞\nbulletin 公告 名詞\nbulletin board 公告欄 名詞\nbusiness hours 營業時間 名詞\ncabinet 櫃子 名詞\ncalculate 計算 動詞\ncalculator 計算機 名詞\ncall a meeting 召開會議 動詞\ncancel 取消 動詞\ncarpool 共乘 名詞 動詞\ncartridge 墨水匣 名詞\nchairperson 主席 名詞\nchecklist 檢查清單 名詞\ncirculate 傳閱 動詞\nclerk 職員 名詞\nclip 迴紋針 名詞 夾住 動詞\nclipboard 寫字夾板 名詞\nclock in 打卡上班 動詞\ncoffee machine 咖啡機 名詞\ncommittee 委員會 名詞\ncompany policy 公司政策 名詞\ncompile 彙編 動詞\ncompletion 完成 名詞\nconference 會議 研討會 名詞\nconference call 電話會議 名詞\nconference room 會議室 名詞\nconfidential 機密的 形容詞\ncoordinate 協調 動詞\ncopier 影印機 名詞\ncopy room 影印室 名詞\ncorrespond 通信 動詞\ncorrespondence 信件往來 名詞\ncorridor 走廊 名詞\ncourier 快遞員 名詞\ncover for 代理 動詞\ncoworker 同事 名詞\ncrowded 擁擠的 形容詞\ncubicle 辦公隔間 名詞\ndata 資料 名詞\ndatabase 資料庫 名詞\nday off 休假日 名詞\ndeadline 截止日期 名詞\ndelegate 委派 動詞 代表 名詞\ndelete 刪除 動詞\ndepartment 部門 名詞\ndesignate 指定 動詞\ndesktop 桌上型電腦 名詞\ndetail 細節 名詞\ndetailed 詳細的 形容詞\ndevice 裝置 名詞\ndiagram 圖表 名詞\ndigital copy 電子檔 名詞\ndirector 主任 董事 名詞\ndirectory 通訊錄 目錄 名詞\ndiscard 丟棄 動詞\ndispenser 取用機 分配器 名詞\ndispose 處理 丟棄 動詞\ndistribute 分發 動詞\ndivision 部門 名詞\ndocument 文件 名詞 記錄 動詞\ndownload 下載 動詞\ndraft 草稿 名詞 起草 動詞\ndrawer 抽屜 名詞\ndue date 截止日 到期日 名詞\nduplicate 複本 名詞 複製 動詞\nedit 編輯 動詞\nefficient 有效率的 形容詞\nelectronic 電子的 形容詞\nenclose 隨函附上 動詞\nenclosure 附件 名詞\nenvelope 信封 名詞\nerrand 差事 名詞\nerror 錯誤 名詞\nexecutive 主管 名詞 行政的 形容詞\nextension cord 延長線 名詞\nfacilitate 促進 主持 動詞\nfasten 固定 繫緊 動詞\nfax 傳真 名詞 動詞\nfile 檔案 名詞 歸檔 動詞\nfile a report 提交報告 動詞\nfile cabinet 檔案櫃 名詞\nfiling 歸檔 名詞\nfiling system 歸檔系統 名詞\nfill in for 代班 動詞\nfill out 填寫 動詞\nfolder 資料夾 名詞\nform 表格 名詞\nformat 格式 名詞\nforward 轉寄 動詞\nfront desk 櫃台 名詞\nfurniture 家具 名詞\ngo over 檢查 複習 動詞\nguideline 指引 名詞\nhand out 分發 動詞\nhandbook 手冊 名詞\nhandout 講義 名詞\nhard copy 紙本 名詞\nheadquarters 總部 名詞\nheadset 耳機麥克風 名詞\nhighlighter 螢光筆 名詞\nhole punch 打孔機 名詞\nin advance 事先 副詞\nin charge 負責的 形容詞\ninbox 收件匣 名詞\nink 墨水 名詞\ninstall 安裝 動詞\ninstruction 說明 指示 名詞\ninternal memo 內部備忘錄 名詞\nIT department 資訊部門 名詞\nitemized 逐項列出的 形容詞\njanitor 清潔工 名詞\nkeep track of 追蹤 記錄 動詞\nlabel 標籤 名詞 貼標籤 動詞\nletterhead 信頭 名詞\nlobby 大廳 名詞\nlocker 置物櫃 名詞\nlog 日誌 名詞 記錄 動詞\nlog in 登入 動詞\nlog out 登出 動詞\nlook over 瀏覽 檢查 動詞\nlounge 休息室 名詞\nmail 郵件 名詞 郵寄 動詞\nmailing list 郵寄名單 名詞\nmailroom 收發室 名詞\nmaintenance request 報修單 名詞\nmalfunction 故障 名詞 動詞\nmanager 經理 名詞\nmanual 手冊 名詞 手動的 形容詞\nmarker 麥克筆 名詞\nmeeting 會議 名詞\nmemo 備忘錄 名詞\nminutes 會議紀錄 名詞\nmonitor 螢幕 名詞 監控 動詞\nmultitask 多工處理 動詞\nnetwork 網路 名詞\nnotepad 便條紙 名詞\nnotification 通知 名詞\nnotify 通知 動詞\noffice equipment 辦公設備 名詞\noffice hours 辦公時間 名詞\noffice manager 辦公室經理 名詞\noffice supplies 辦公用品 名詞\non schedule 按進度 副詞\norder 訂購 動詞 訂單 名詞\norganize 整理 組織 動詞\norganizer 籌辦者 收納用品 名詞\nout of order 故障的 形容詞\noutline 大綱 名詞 概述 動詞\noversee 監督 動詞\novertime 加班 名詞 副詞\npackage 包裹 名詞\npantry 茶水間 名詞\npaper jam 卡紙 名詞\npaperless 無紙化的 形容詞\npaperwork 文書工作 名詞\nparcel 包裹 名詞\npermission 許可 名詞\npetty cash 零用金 名詞\nphotocopier 影印機 名詞\nphotocopy 影印 動詞 影本 名詞\nplace an order 下訂單 動詞\npolicy 政策 規定 名詞\npostpone 延後 動詞\npresident 總裁 名詞\nprint 列印 動詞\nprint out 列印出來 動詞\nprinter 印表機 名詞\nprintout 列印文件 名詞\nprioritize 排定優先順序 動詞\npriority 優先事項 名詞\nprocedure 程序 名詞\nprojector 投影機 名詞\nproofread 校對 動詞\npunctual 準時的 形容詞\nrearrange 重新安排 動詞\nreception area 接待區 名詞\nrecord 紀錄 名詞 記錄 動詞\nrecurring 定期的 形容詞\nrecycling bin 回收桶 名詞\nreference number 參考編號 名詞\nrefill 補充 動詞 補充品 名詞\nregister 登記 動詞 名詞\nregistration 登記 註冊 名詞\nregulation 規定 名詞\nreimburse 核銷 償還 動詞\nreminder 提示 名詞\nrenovate 翻修 動詞\nrenovation 整修 名詞\nreschedule 重新安排 動詞\nresponsibility 責任 名詞\nresponsible 負責的 形容詞\nretrieve 取回 動詞\nrevise 修改 動詞\nrevision 修訂 名詞\nrotate 輪流 動詞\nrotation 輪調 輪替 名詞\nroutine 例行公事 名詞 例行的 形容詞\nscan 掃描 動詞\nscanner 掃描器 名詞\nschedule 時程表 名詞 安排 動詞\nscissors 剪刀 名詞\nsecretary 祕書 名詞\nsecurity 保全 安全 名詞\nserver 伺服器 名詞\nsetup 設置 名詞\nshelf 架子 名詞\nshift 輪班 名詞\nshred 用碎紙機切碎 動詞\nshredder 碎紙機 名詞\nsick leave 病假 名詞\nsign in 簽到 動詞\nsign off 簽核 動詞\nsignature 簽名 名詞\nsoftware 軟體 名詞\nsort 分類 動詞 種類 名詞\nspreadsheet 試算表 名詞\nstack 一疊 名詞 堆疊 動詞\nstaff meeting 員工會議 名詞\nstamp 郵票 印章 名詞 蓋章 動詞\nstaple 釘書針 名詞 用釘書機釘 動詞\nstapler 釘書機 名詞\nstationery 文具 名詞\nsticky note 便利貼 名詞\nstoreroom 儲藏室 名詞\nsubmit 提交 動詞\nsubmit a request 提出申請 動詞\nsummarize 總結 動詞\nsummary 摘要 名詞\nsupervisor 主管 名詞\nsupplies 用品 名詞\nsupply 供應 名詞 動詞\nsupply room 用品室 名詞\nswipe 刷卡 動詞\ntake minutes 做會議記錄 動詞\ntape 膠帶 名詞\ntask 任務 名詞\ntechnical support 技術支援 名詞\ntechnician 技術人員 名詞\ntelecommute 遠距工作 動詞\ntemplate 範本 名詞\ntimesheet 工時表 名詞\nto-do list 待辦清單 名詞\ntoner 碳粉 名詞\ntrash can 垃圾桶 名詞\ntroubleshooting 疑難排解 名詞\nupdate 更新 動詞 名詞\nupload 上傳 動詞\nvending machine 自動販賣機 名詞\nverify 核對 驗證 動詞\nvice president 副總裁 名詞\nvideo conference 視訊會議 名詞\nvisitor 訪客 名詞\nvoice message 語音留言 名詞\nwater cooler 飲水機 名詞\nwhiteboard 白板 名詞\nwork from home 在家工作 動詞\nwork order 工單 名詞\nworkload 工作量 名詞\nworkstation 工作站 名詞",
        farm_1_5: "January 1月 名詞\nFebruary 2月 名詞\nMarch 3月 名詞\nApril 4月 名詞\nMay 5月 名詞\nJune 6月 名詞\nJuly 7月 名詞\nAugust 8月 名詞\nSeptember 9月 名詞\nOctober 10月 名詞\nNovember 11月 名詞\nDecember 12月 名詞\nMonday 星期一 名詞\nTuesday 星期二 名詞\nWednesday 星期三 名詞\nThursday 星期四 名詞\nFriday 星期五 名詞\nSaturday 星期六 名詞\nSunday 星期日 名詞\nspring 春天 名詞\nsummer 夏天 名詞\nautumn 秋天 名詞\nwinter 冬天 名詞\ntoday 今天 名詞 副詞\ntomorrow 明天 名詞 副詞\nyesterday 昨天 名詞 副詞\nmorning 早上 名詞\nnight 夜晚 名詞\nsun 太陽 名詞\nrain 雨 名詞\nwind 風 名詞\ncloud 雲 名詞\nsnow 雪 名詞\nwarm 溫暖的 形容詞\nseed 種子 名詞\nflower 花 名詞\nleaf 葉子 名詞\ntree 樹 名詞\ngrass 草 名詞\nroot 根 名詞\nfruit 水果 名詞\ncorn 玉米 名詞\nrice 米 名詞\npotato 馬鈴薯 名詞\ncarrot 紅蘿蔔 名詞\napple 蘋果 名詞\nbanana 香蕉 名詞\nwatermelon 西瓜 名詞\nsunflower 向日葵 名詞\nchicken 雞 名詞\ndog 狗 名詞\ncat 貓 名詞\ncow 乳牛 名詞\npig 豬 名詞\nduck 鴨 名詞\nbird 鳥 名詞\nbee 蜜蜂 名詞\nhoney 蜂蜜 名詞\nplant 種植 動詞\nwater 澆水 動詞\ngrow 生長 動詞\npick 摘 動詞\ndig 挖 動詞\nfeed 餵 動詞\nwait 等待 動詞\nsell 賣 動詞\nharvest 收成 動詞\nfarm 農場 名詞\nfield 田地 名詞\ngarden 花園 名詞\nfence 圍籬 名詞\nhouse 房子 名詞\nbasket 籃子 名詞\nmarket 市場 名詞\nvegetable 蔬菜 名詞\nstrawberry 草莓 名詞\npineapple 鳳梨 名詞\nbutterfly 蝴蝶 名詞\nafternoon 下午 名詞\nbeautiful 美麗的 形容詞\ntemperature 溫度 名詞\nscarecrow 稻草人 名詞",
        adv_night: "hot 熱的 形容詞\ncup 杯子 名詞\nsoup 湯 名詞\nmeatball 貢丸 肉丸 名詞\neat 吃 動詞\ngood 好的 好吃的 形容詞\ncorn 玉米 名詞\ngrill 烤 動詞 烤架 名詞\nsalt 鹽 名詞\nbutter 奶油 名詞\nsweet 甜的 形容詞\nbuy 買 動詞\noyster 蚵仔 牡蠣 名詞\negg 蛋 名詞\nrice 飯 米 名詞\nsauce 醬料 名詞\nspicy 辣的 形容詞\norder 點餐 動詞\ntofu 豆腐 名詞\nstinky 臭的 形容詞\nbubble tea 珍珠奶茶 名詞\nmilk tea 奶茶 名詞\nice 冰塊 名詞\nsugar 糖 名詞\nstraw 吸管 名詞\ndoll 娃娃 名詞\ncoin 硬幣 名詞\ngrab 抓 動詞\ntry 嘗試 動詞\nprize 獎品 名詞\nplay 玩 動詞\ndart 飛鏢 名詞\nthrow 丟 投擲 動詞\nhit 打中 動詞\nmiss 沒打中 錯過 動詞\nscore 分數 名詞 得分 動詞\nlucky 幸運的 形容詞\nwin 贏 動詞\nlose 輸 動詞\neast 東方 名詞\nwest 西方 名詞\nsouth 南方 名詞\nnorth 北方 名詞\nring 圈圈 戒指 名詞\nstall 攤位 名詞\nline 隊伍 名詞 排隊 動詞\ncrowded 擁擠的 形容詞\ncheap 便宜的 形容詞\nprice 價格 名詞\nnight market 夜市 名詞",
        adv_store: "convenience store 便利商店 名詞\nopen 營業中的 形容詞 打開 動詞\nclose 關門 關閉 動詞\nwelcome 歡迎 動詞 形容詞\nclerk 店員 名詞\ntea egg 茶葉蛋 名詞\nboil 煮 煮沸 動詞\nhungry 餓的 形容詞\nsnack 零食 名詞\nbreakfast 早餐 名詞\nhot dog 熱狗 名詞\nbun 小圓麵包 名詞\nbread 麵包 名詞\nsandwich 三明治 名詞\nketchup 番茄醬 名詞\ncheese 起司 名詞\nnapkin 餐巾紙 名詞\ninstant noodles 泡麵 名詞\nfull 飽的 滿的 形容詞\ndelicious 好吃的 美味的 形容詞\nrice ball 飯糰 名詞\nseaweed 海苔 名詞\ntuna 鮪魚 名詞\nsalmon 鮭魚 名詞\ntriangle 三角形 名詞\nwrap 包裝 名詞 包起來 動詞\ntear 撕開 動詞\nplastic 塑膠 名詞\nfridge 冰箱 名詞\ncold 冰的 冷的 形容詞\nbottle 瓶子 名詞\nwater 水 名詞\ndrink 飲料 名詞 喝 動詞\nsugar-free 無糖的 形容詞\ngreen tea 綠茶 名詞\nprint 列印 動詞\nticket 票 名詞\nmachine 機器 名詞\nbill 帳單 名詞\nreceipt 收據 發票 名詞\nsalad 沙拉 名詞\nvegetable 蔬菜 名詞\nfresh 新鮮的 形容詞\nlid 蓋子 名詞\nfork 叉子 名詞\nhealthy 健康的 形容詞\nlettuce 生菜 萵苣 名詞\ntomato 番茄 名詞\ndressing 沙拉醬 名詞\nlight 清淡的 輕的 形容詞\nmicrowave 微波爐 名詞 微波加熱 動詞\nheat 加熱 動詞 熱度 名詞\nwarm 溫的 溫暖的 形容詞\nminute 分鐘 名詞\nsecond 秒 名詞\nbutton 按鈕 名詞\nwait 等待 動詞\ncareful 小心的 形容詞\nsteam 蒸氣 名詞\nnoise 噪音 聲音 名詞\nlunch box 便當 名詞\nchopsticks 筷子 名詞\nspoon 湯匙 名詞\nexpire 過期 動詞\ndiscount 折扣 名詞\nhalf price 半價 名詞\nsticker 貼紙 名詞\nmeat 肉 名詞\nchicken 雞肉 名詞\npoint 點數 名詞\ncoffee 咖啡 名詞\nlatte 拿鐵 名詞\niced 加冰的 形容詞\nbitter 苦的 形容詞\nsleepy 想睡的 形容詞\ncashier 收銀員 名詞\ncustomer 顧客 名詞\npay 付錢 動詞\ncash 現金 名詞\ncredit card 信用卡 名詞",
        basic_noun: "activity 活動 名詞\nafternoon 下午 名詞\nage 年齡 名詞\napplication form 申請表 名詞\narea 區域 名詞\nart 藝術 美術 名詞\nauditorium 禮堂 名詞\nback 後面 名詞\nbackpack 背包 名詞\nbag 包包 名詞\nbank 銀行 名詞\nbe late for 遲到 動詞\nbeginner 初學者 名詞\nbike 腳踏車 名詞\nbirthday 生日 名詞\nbook 書籍 名詞 預訂 動詞\nbookshelf 書架 名詞\nbookstore 書店 名詞\nboss 老闆 名詞\nbottle 瓶子 名詞\nbottom 底部 名詞\nbox 箱子 名詞\nbreakfast 早餐 名詞\nbuilding 建築物 名詞\nbus 公車 名詞\nbusiness card 名片 名詞\ncafeteria 自助餐廳 名詞\ncalendar 日曆 名詞\ncampus 校園 名詞\ncar 汽車 名詞\ncard 卡片 名詞\ncenter 中心 名詞\nchair 椅子 名詞\nchance 機會 名詞\nchapter 章節 名詞\nchild 小孩 名詞\ncity 城市 名詞\nclass 班級 課堂 名詞\nclassmate 同學 名詞\nclassroom 教室 名詞\nclock 時鐘 名詞\nclosing time 打烊時間 名詞\nclothes 衣服 名詞\nclub 社團 俱樂部 名詞\ncoffee 咖啡 名詞\ncoffee break 休息時間 名詞\ncoin 硬幣 名詞\ncollege 大學 學院 名詞\ncolor 顏色 名詞\ncompany 公司 名詞\ncomputer 電腦 名詞\ncontest 比賽 名詞\ncorner 角落 轉角 名詞\ncountry 國家 名詞\ncourse 課程 名詞\ncup 杯子 名詞\ndaily 每日的 形容詞 每天 副詞\ndate 日期 名詞\nday 天 名詞\nday shift 日班 名詞\ndebate 辯論 名詞 動詞\ndesk 書桌 名詞\ndictionary 字典 名詞\ndinner 晚餐 名詞\ndiscussion 討論 名詞\ndoctor 醫生 名詞\ndoor 門 名詞\ndormitory 宿舍 名詞\ndrawing 圖畫 名詞\ndream 夢想 名詞 做夢 動詞\ndriver 司機 名詞\neducation 教育 名詞\nelevator 電梯 名詞\nemail 電子郵件 名詞 寄電子郵件 動詞\nemail address 電子郵件地址 名詞\nenrollment 註冊 名詞\nentrance 入口 名詞\neraser 橡皮擦 名詞\nessay 短文 論文 名詞\nevening 傍晚 名詞\nevent 活動 事件 名詞\nexam 考試 名詞\nexample 例子 名詞\nexcited 興奮的 形容詞\nexit 出口 名詞 離開 動詞\nexperience 經驗 名詞\nextracurricular 課外的 形容詞\nfaculty 全體教職員 名詞\nfamily 家庭 名詞\nfirst day 第一天 名詞\nfirst job 第一份工作 名詞\nfirst name 名字 名詞\nfloor 地板 樓層 名詞\nfood 食物 名詞\nfriend 朋友 名詞\nfront 前面 名詞\nfull-time 全職的 形容詞\ngame 遊戲 比賽 名詞\ngift 禮物 名詞\ngoal 目標 名詞\ngrade 成績 年級 名詞\ngraduate 畢業 動詞 畢業生 名詞\ngraduation 畢業 畢業典禮 名詞\ngroup 群體 小組 名詞\ngroup project 小組作業 名詞\nguest 客人 來賓 名詞\nguidance 輔導 指導 名詞\ngym 體育館 健身房 名詞\nhabit 習慣 名詞\nhall 大廳 走廊 名詞\nhallway 走廊 名詞\nhand in 繳交 動詞\nhardworking 努力的 形容詞\nhat 帽子 名詞\nheadphones 耳機 名詞\nhealth 健康 名詞\nhelper 幫手 名詞\nhistory 歷史 名詞\nhobby 嗜好 名詞\nholiday 假日 名詞\nhometown 家鄉 名詞\nhomework 家庭作業 名詞\nhospital 醫院 名詞\nhour 小時 名詞\nidea 主意 想法 名詞\ninstructor 講師 名詞\ninternet 網際網路 名詞\nintroduction 介紹 名詞\njob 工作 名詞\njob hunting 找工作 名詞\njob title 職稱 名詞\nkey 鑰匙 關鍵 名詞\nkeyboard 鍵盤 名詞\nknowledge 知識 名詞\nlaboratory 實驗室 名詞\nlanguage 語言 名詞\nlaptop 筆記型電腦 名詞\nlast name 姓氏 名詞\nleader 領導者 名詞\nlecture 講課 名詞 演講 動詞\nlesson 課程 教訓 名詞\nletter 信件 字母 名詞\nlevel 程度 等級 名詞\nlibrarian 圖書館員 名詞\nlibrary 圖書館 名詞\nline 線 隊伍 名詞\nlist 清單 名詞 列出 動詞\nlocation 地點 位置 名詞\nlunch 午餐 名詞\nlunch break 午休 名詞\nlunchroom 員工餐廳 名詞\nlunchtime 午餐時間 名詞\nmagazine 雜誌 名詞\nmajor 主修 名詞 動詞\nmap 地圖 名詞\nmark 分數 名詞 打分數 動詞\nmarket 市場 名詞\nmath 數學 名詞\nmeal 餐點 名詞\nmeasure 測量 動詞 措施 名詞\nmember 成員 名詞\nmessage 訊息 名詞\nmiddle 中間 名詞\nminute 分鐘 名詞\nmistake 錯誤 名詞\nmoney 金錢 名詞\nmonth 月份 名詞\nmorning 早晨 名詞\nmusic 音樂 名詞\nnameplate 名牌 名詞\nnationality 國籍 名詞\nnervous 緊張的 形容詞\nnewcomer 新人 名詞\nnews 新聞 消息 名詞\nnewspaper 報紙 名詞\nnight 夜晚 名詞\nnight shift 夜班 名詞\nnote 筆記 名詞 記下 動詞\nnotebook 筆記本 名詞\nnumber 數字 號碼 名詞\nnurse 護士 名詞\noffice 辦公室 名詞\noffice worker 上班族 名詞\nowner 擁有者 老闆 名詞\npage 頁 名詞\npaper 紙張 報告 名詞\nparent 父母 名詞\npark 公園 名詞 停車 動詞\nparking lot 停車場 名詞\npart-time 兼職的 形容詞\npart-time job 打工 名詞\npartner 夥伴 名詞\nparty 派對 名詞\npassword 密碼 名詞\npay attention to 注意 動詞\npen 原子筆 名詞\npencil 鉛筆 名詞\npeople 人們 名詞\nperson 個人 名詞\nphone 電話 名詞\nphone number 電話號碼 名詞\nphoto 照片 名詞\nphysics 物理 名詞\npicture 圖片 照片 名詞\npiece 一片 一件 名詞\npost 郵件 名詞 張貼 動詞\npractice 練習 名詞 動詞\npresentation 簡報 名詞\nprice 價格 名詞\nprincipal 校長 名詞 主要的 形容詞\nprize 獎品 名詞\nproblem 問題 名詞\nprofessor 教授 名詞\nproject 專案 計畫 名詞\nquestion 問題 名詞 質問 動詞\nquiz 小考 名詞\nreason 原因 理由 名詞\nresearch 研究 名詞 動詞\nrestaurant 餐廳 名詞\nrestroom 洗手間 名詞\nresult 結果 名詞\nroad 道路 名詞\nroom 房間 空間 名詞\nroommate 室友 名詞\nrule 規則 名詞\nsalesclerk 店員 名詞\nsalesperson 售貨員 名詞\nscholarship 獎學金 名詞\nschool 學校 名詞\nscience 科學 名詞\nscore 分數 名詞 得分 動詞\nseat 座位 名詞\nsemester 學期 名詞\nseminar 研討會 名詞\nsentence 句子 名詞\nshape 形狀 名詞\nshirt 襯衫 名詞\nshoe 鞋子 名詞\nshop 商店 名詞 購物 動詞\nside 旁邊 一側 名詞\nsign 招牌 標誌 名詞 簽名 動詞\nsize 尺寸 名詞\nskill 技能 名詞\nsmart 聰明的 形容詞\nsnack 點心 名詞\nspace 空間 名詞\nspeaker 演講者 喇叭 名詞\nspeech 演講 名詞\nsport 運動 名詞\nstairs 樓梯 名詞\nstation 車站 名詞\nstep 步驟 名詞\nstore 商店 名詞 儲存 動詞\nstory 故事 樓層 名詞\nstreet 街道 名詞\nstudent 學生 名詞\nstudy group 讀書會 名詞\nsubject 科目 主題 名詞\nsubway 地鐵 名詞\ntable 桌子 表格 名詞\ntake notes 做筆記 動詞\ntaxi 計程車 名詞\ntea 茶 名詞\nteacher 老師 名詞\nteam 團隊 名詞\nteam member 團隊成員 名詞\nteammate 隊友 名詞\ntelephone 電話 名詞\nterm 學期 期限 名詞\ntest 測驗 名詞 測試 動詞\nticket 票 名詞\ntime 時間 次數 名詞\ntoday 今天 名詞 副詞\ntomorrow 明天 名詞 副詞\ntop 頂端 名詞\ntopic 主題 名詞\ntown 城鎮 名詞\ntrain 火車 名詞 訓練 動詞\ntranslate 翻譯 動詞\ntranslation 翻譯 名詞\ntype 類型 名詞 打字 動詞\numbrella 雨傘 名詞\nuniform 制服 名詞 一致的 形容詞\nvocabulary 字彙 名詞\nvolunteer 志工 名詞 自願 動詞\nwaiter 服務生 名詞\nwall 牆壁 名詞\nwater 水 名詞\nweather 天氣 名詞\nwebsite 網站 名詞\nweek 星期 名詞\nweekday 平日 名詞\nweekend 週末 名詞\nwindow 窗戶 名詞\nword 單字 名詞\nwork hours 工作時數 名詞\nworker 工人 員工 名詞\nyear 年 名詞\nyearly 每年的 形容詞\nyesterday 昨天 名詞 副詞",
        basic_verb: "able 有能力的 形容詞\naccept 接受 動詞\nachieve 達成 動詞\nact 行動 動詞\nactive 積極的 形容詞\nadd 增加 動詞\nafford 負擔得起 動詞\nafraid 害怕的 形容詞\nagree 同意 動詞\nallow 允許 動詞\nalone 單獨的 形容詞\nangry 生氣的 形容詞\nanswer 回答 動詞 名詞\narrive 到達 動詞\nask 詢問 動詞\navoid 避免 動詞\nbad 壞的 形容詞\nbeautiful 美麗的 形容詞\nbegin 開始 動詞\nbelieve 相信 動詞\nbelong 屬於 動詞\nbig 大的 形容詞\nborrow 借入 動詞\nbreak 打破 動詞 休息 名詞\nbright 明亮的 聰明的 形容詞\nbring 帶來 動詞\nbuild 建造 動詞\nbusy 忙碌的 形容詞\nbuy 購買 動詞\ncall 打電話 呼叫 動詞\ncall off 取消 動詞\ncarry 攜帶 搬運 動詞\ncarry out 執行 動詞\ncatch 抓住 趕上 動詞\nchange 改變 動詞 零錢 名詞\ncheap 便宜的 形容詞\nchoose 選擇 動詞\nclean 打掃 動詞 乾淨的 形容詞\nclear 清楚的 形容詞\nclose 關閉 動詞 接近的 形容詞\ncold 冷的 形容詞 感冒 名詞\ncome 來 動詞\ncome up with 想出 動詞\ncomfortable 舒適的 形容詞\ncompare 比較 動詞\ncomplete 完成 動詞 完整的 形容詞\nconsider 考慮 動詞\ncontinue 繼續 動詞\ncook 烹調 動詞 廚師 名詞\ncopy 複製 動詞 副本 名詞\ncorrect 正確的 形容詞 改正 動詞\ncreate 創造 動詞\ncross 穿越 動詞\ncut 切 剪 動詞\ndark 黑暗的 形容詞\ndecide 決定 動詞\ndeliver 遞送 動詞\ndepend 依賴 動詞\ndevelop 發展 動詞\ndifferent 不同的 形容詞\ndifficult 困難的 形容詞\ndirty 髒的 形容詞\ndisappear 消失 動詞\ndiscover 發現 動詞\ndiscuss 討論 動詞\ndo 做 動詞\ndraw 畫畫 動詞\ndrink 喝 動詞 飲料 名詞\ndrive 開車 動詞\ndrop 落下 動詞\ndrop off 放下 送達 動詞\nearly 早的 形容詞\neasy 簡單的 形容詞\neat 吃 動詞\nempty 空的 形容詞\nenjoy 享受 動詞\nenter 進入 動詞\nexpect 期待 預期 動詞\nexpensive 昂貴的 形容詞\nexplain 解釋 動詞\nfail 失敗 動詞\nfall 落下 動詞\nfamous 有名的 形容詞\nfast 快的 形容詞\nfeel 感覺 動詞\nfew 很少的 形容詞\nfigure out 想出 弄清楚 動詞\nfill 填滿 填寫 動詞\nfind 找到 動詞\nfind out 查明 發現 動詞\nfine 好的 形容詞 罰款 名詞\nfinish 完成 動詞\nfit 合身 動詞 健康的 形容詞\nfix 修理 固定 動詞\nfly 飛 搭飛機 動詞\nfollow 跟隨 遵循 動詞\nforget 忘記 動詞\nfree 免費的 自由的 形容詞\nfresh 新鮮的 形容詞\nfull 滿的 形容詞\nget 得到 動詞\nget rid of 擺脫 丟掉 動詞\ngive 給予 動詞\ngive up 放棄 動詞\ngo 去 動詞\ngood 好的 形容詞\ngreat 很棒的 偉大的 形容詞\ngrow 生長 成長 動詞\nguess 猜測 動詞\nhang 懸掛 動詞\nhappen 發生 動詞\nhappy 快樂的 形容詞\nhard 困難的 堅硬的 形容詞\nhave 有 動詞\nhealthy 健康的 形容詞\nhear 聽到 動詞\nheavy 重的 形容詞\nhelp 幫助 動詞 名詞\nhigh 高的 形容詞\nhold 握住 舉行 動詞\nhope 希望 動詞\nhot 熱的 形容詞\nhuge 巨大的 形容詞\nhurry 趕快 動詞\nimagine 想像 動詞\nimportant 重要的 形容詞\nimprove 改善 動詞\ninclude 包含 動詞\ninteresting 有趣的 形容詞\ninvite 邀請 動詞\njoin 加入 動詞\nkeep 保持 動詞\nkind 親切的 形容詞 種類 名詞\nknow 知道 動詞\nlarge 大的 形容詞\nlate 遲的 晚的 形容詞\nlaugh 笑 動詞\nlearn 學習 動詞\nleave 離開 動詞\nlift 舉起 動詞\nlight 輕的 形容詞 光線 名詞\nlike 喜歡 動詞\nlisten 聽 動詞\nlittle 小的 形容詞\nlive 居住 動詞\nlong 長的 形容詞\nlook 看 動詞\nlook for 尋找 動詞\nlook forward to 期待 動詞\nlose 失去 動詞\nloud 大聲的 形容詞\nlow 低的 形容詞\nlucky 幸運的 形容詞\nmain 主要的 形容詞\nmake 製作 動詞\nmake sure 確定 動詞\nmany 許多的 形容詞\nmature 成熟的 形容詞 成熟 動詞\nmean 意指 動詞 刻薄的 形容詞\nmeet 見面 動詞\nmind 介意 動詞 頭腦 名詞\nmiss 錯過 想念 動詞\nmodern 現代的 形容詞\nmove 移動 搬家 動詞\nmuch 許多的 形容詞\nnarrow 狹窄的 形容詞\nnear 接近的 形容詞\nneed 需要 動詞\nnew 新的 形容詞\nnice 不錯的 形容詞\nnoisy 吵鬧的 形容詞\nnormal 正常的 形容詞\nnotice 注意到 動詞 通知 名詞\nold 老的 舊的 形容詞\nopen 打開 動詞 開放的 形容詞\npack 打包 動詞\npay 支付 動詞\npick 挑選 撿起 動詞\npick up 撿起 接送 動詞\nplace 放置 動詞 地方 名詞\nplan 計劃 動詞 名詞\nplay 玩 動詞\npoint 指向 動詞\npoor 貧窮的 差的 形容詞\npopular 受歡迎的 形容詞\npossible 可能的 形容詞\nprefer 更喜歡 動詞\nprepare 準備 動詞\nprotect 保護 動詞\nprove 證明 動詞\nprovide 提供 動詞\npull 拉 動詞\npush 推 動詞\nput 放置 動詞\nput off 延後 動詞\nquick 快速的 形容詞\nquiet 安靜的 形容詞\nread 閱讀 動詞\nready 準備好的 形容詞\nreal 真實的 形容詞\nreceive 收到 動詞\nreduce 減少 動詞\nremember 記得 動詞\nremove 移除 動詞\nrepeat 重複 動詞\nreply 回覆 動詞 名詞\nrest 休息 動詞 名詞\nreturn 返回 歸還 動詞\nrich 富有的 形容詞\nride 騎 搭乘 動詞\nright 正確的 右邊的 形容詞\nring 響 動詞 戒指 名詞\nrise 上升 動詞\nrun 跑 動詞\nrun out of 用完 動詞\nsafe 安全的 形容詞\nsame 相同的 形容詞\nsave 節省 拯救 動詞\nsay 說 動詞\nsee 看見 動詞\nseem 似乎 動詞\nsell 銷售 動詞\nsend 寄出 動詞\nserious 嚴重的 認真的 形容詞\nset up 設立 安排 動詞\nshare 分享 動詞\nshort 短的 矮的 形容詞\nshow 顯示 動詞 表演 名詞\nshow up 出現 動詞\nshut 關上 動詞\nsick 生病的 形容詞\nsign up 報名 動詞\nsimple 簡單的 形容詞\nsit 坐 動詞\nsleep 睡眠 動詞 名詞\nslow 慢的 形容詞\nsmall 小的 形容詞\nsmell 聞 動詞 氣味 名詞\nsmile 微笑 動詞 名詞\nsoft 柔軟的 形容詞\nspeak 說話 動詞\nspecial 特別的 形容詞\nspend 花費 動詞\nstand 站立 動詞\nstart 開始 動詞\nstay 停留 動詞\nstop 停止 動詞\nstrong 強壯的 形容詞\nstudy 學習 動詞\nsucceed 成功 動詞\nsuggest 建議 動詞\nsure 確定的 形容詞\nsweet 甜的 形容詞\ntake 拿取 動詞\ntake care of 照顧 處理 動詞\ntalk 談話 動詞\ntall 高的 形容詞\ntaste 品嚐 動詞 味道 名詞\nteach 教導 動詞\ntell 告訴 動詞\nthick 厚的 形容詞\nthin 薄的 瘦的 形容詞\nthink 想 動詞\nthrow 投擲 動詞\ntired 疲倦的 形容詞\ntouch 觸摸 動詞\ntrue 真實的 形容詞\ntry 嘗試 動詞\ntry on 試穿 動詞\nturn 轉動 動詞\nturn down 拒絕 調低 動詞\nturn off 關掉 動詞\nturn on 打開 動詞\nunderstand 理解 動詞\nuse 使用 動詞\nuseful 有用的 形容詞\nusual 通常的 形容詞\nvisit 參觀 拜訪 動詞\nwait 等待 動詞\nwake 醒來 動詞\nwake up 醒來 動詞\nwalk 走路 動詞\nwant 想要 動詞\nwarm 溫暖的 形容詞\nwash 洗 動詞\nwatch 觀看 動詞 手錶 名詞\nweak 虛弱的 形容詞\nwear 穿戴 動詞\nwet 濕的 形容詞\nwide 寬的 形容詞\nwin 贏 動詞\nwise 明智的 形容詞\nwish 希望 動詞\nwonder 想知道 動詞\nwonderful 美好的 形容詞\nwork 工作 動詞 名詞\nworry 擔心 動詞\nwrite 書寫 動詞\nwrong 錯誤的 形容詞\nyoung 年輕的 形容詞"
    };
    const PACK_WORD_CAP = 300;
    function isPackList(l) { return !!(l && l.pack && WORD_PACKS[l.pack]); }
    function countUserLists() { return wordLists.filter(l => !isPackList(l)).length; }
    function packOwned(key) { return !!WORD_PACKS[key] && (WORD_PACKS[key].free || walletQty(WORD_PACKS[key].item) > 0); }
    function packInstalled(key) { return wordLists.some(l => l.pack === key); }
    function packKeyByItem(item) { return Object.keys(WORD_PACKS).find(k => WORD_PACKS[k].item === item) || ''; }
    let packInstalling = {};
    async function installWordPack(key, silent) {
        let meta = WORD_PACKS[key];
        if (!meta) return false;
        if (packInstalled(key)) return true;
        if (packInstalling[key]) return false;
        if (meta.free) {        // 免費的：內容就在 App 裡
            wordLists.push({ id: newListId(), title: meta.title, content: FREE_PACK_CONTENT[key], createdAt: Date.now(), lang: meta.lang, pack: key });
            localStorage.setItem('dictation_word_lists', JSON.stringify(wordLists));
            try { triggerAutoSaveToCloud(); refreshAllListViews(); } catch (e) {}
            return true;
        }
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
        // 冒險題庫：內容跟著 App 更新（每關分組有改過）
        let advUpd = false;
        wordLists.forEach(l => { let m = isPackList(l) && WORD_PACKS[l.pack]; if (m && (m.kind === 'adv' || m.kind === 'farm') && FREE_PACK_CONTENT[l.pack] && l.content !== FREE_PACK_CONTENT[l.pack]) { l.content = FREE_PACK_CONTENT[l.pack]; advUpd = true; } });
        if (advUpd) { localStorage.setItem('dictation_word_lists', JSON.stringify(wordLists)); try { triggerAutoSaveToCloud(); refreshAllListViews(); } catch (e) {} }
        // 改名：舊的預設名稱換成新名稱（玩家自己改過名字的不動）
        let renamed = false;
        wordLists.forEach(l => { let m = isPackList(l) && WORD_PACKS[l.pack]; if (m && m.oldTitles && m.oldTitles.includes(l.title)) { l.title = m.title; renamed = true; } });
        if (renamed) { localStorage.setItem('dictation_word_lists', JSON.stringify(wordLists)); try { triggerAutoSaveToCloud(); refreshAllListViews(); } catch (e) {} }
        Object.keys(WORD_PACKS).forEach(k => { if (packOwned(k) && !packInstalled(k)) installWordPack(k, true); });
    }
    setTimeout(() => { try { ensureWordPacks(); } catch (e) {} }, 0);
    setTimeout(() => { let el = document.getElementById('shopPackIcon_toeic_job'); if (el) el.innerHTML = packIconHTML('toeic_job', 46); }, 0);
    // 每日登入：雞塊 +1（後端錢包）＋ 糖醋醬碎片 +3（存在大冒險進度裡）；其他任務照舊送雞塊
    const LOGIN_SHARDS = 3;
    function isLoginShardClaimed() { try { return advData.loginShardDay === chickenData.lastDate; } catch (e) { return false; } }
    function isLoginFlowerClaimed() { try { return farm.loginFlowerDay === chickenData.lastDate; } catch (e) { return true; } }
    // 任務算完成：這台裝置做過，或後台記錄今天已經領過（換裝置時本機沒有完成紀錄，但後台有領取紀錄）
    function taskDoneOrClaimed(key) { return !!((chickenData.tasks[key] && chickenData.tasks[key].done) || isTaskClaimed(key)); }
    function isTaskClaimed(key) {
        if (key === 'dailyLogin' && (!isLoginShardClaimed() || !isLoginFlowerClaimed())) return false;   // 每日登入：雞塊、碎片、花都領了才算領完
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

    // 這台裝置上「哪把錢包金鑰屬於哪個 Google 帳號」（換帳號登入時，用來避免兩個帳號共用同一個錢包／農場）
    const WALLET_OWNERS_KEY = 'chicky_wallet_owners';
    function walletOwners() { try { let o = JSON.parse(localStorage.getItem(WALLET_OWNERS_KEY)); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; } }
    function setWalletOwner(key, email) { if (!key || !email) return; let o = walletOwners(); o[key] = email; try { localStorage.setItem(WALLET_OWNERS_KEY, JSON.stringify(o)); } catch (e) {} }
    // 換成另一個錢包時：清掉這台裝置暫存的農場（不然會把上一個帳號的作物搬進新帳號）
    function resetLocalFarmCache() {
        try { localStorage.removeItem(FARM_KEY); } catch (e) {}
        try { farm = farmParse({}); farmXpShown = null; } catch (e) {}
    }
    // 移除「目前錢包沒有買」的付費題庫（例如上一個帳號買的多益職場）；錢包讀取成功後才做
    function prunePaidPacks() {
        let before = wordLists.length;
        wordLists = wordLists.filter(l => !(isPackList(l) && !WORD_PACKS[l.pack].free && !packOwned(l.pack)));
        if (wordLists.length !== before) { localStorage.setItem('dictation_word_lists', JSON.stringify(wordLists)); try { refreshAllListViews(); } catch (e) {} return true; }
        return false;
    }

    // 回傳「目前使用的金鑰」（連線失敗時回傳 null，下次登入會再試一次）
    async function bindWalletAfterLogin(cloudKey, email) {
        let localKey = localStorage.getItem(WALLET_KEY_STORAGE);
        let key = null, fresh = false, owners = walletOwners();
        if (isValidWalletKey(cloudKey)) {
            key = cloudKey;
            let other = owners[cloudKey];
            // 這個帳號雲端裡的錢包，其實是另一個帳號的（以前在這台裝置換帳號時被合併過）
            if (email && other && other !== email) {
                if (confirm(`這個 Google 帳號（${email}）的雞塊錢包，跟 ${other} 是同一個（以前在這台裝置換帳號登入時被合併了）。

按「確定」：${email} 改用全新的錢包（雞塊、農場、買的題庫從頭開始；${other} 的東西不受影響）
按「取消」：維持兩個帳號共用`)) { key = generateWalletKey(); fresh = true; }
                else setWalletOwner(cloudKey, email);
            }
        } else if (isValidWalletKey(localKey) && email && owners[localKey] && owners[localKey] !== email) {
            key = generateWalletKey(); fresh = true;     // 這台裝置的錢包屬於另一個帳號：新帳號直接用全新的錢包（不再問）
        } else if (isValidWalletKey(localKey) && email && owners[localKey] === email) {
            key = localKey;
        } else if (isValidWalletKey(localKey)) {
            // 這台裝置的錢包以前綁過 Google 帳號，但現在登入的帳號雲端裡沒有金鑰
            if (confirm(`這台裝置的雞塊錢包，以前綁定過另一次 Google 登入，但 ${email || '這個帳號'} 的雲端裡沒有錢包資料。\n\n按「確定」：沿用這台裝置的錢包（只有「同一個帳號」重新登入才選這個）\n按「取消」：${email || '這個帳號'} 改用全新的錢包（換成另一個人的帳號請選這個，雞塊、農場、買的題庫會分開）`)) {
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
            if (key !== localKey && isValidWalletKey(localKey)) resetLocalFarmCache();    // 換了錢包：農場也跟著換
            localStorage.setItem(WALLET_KEY_STORAGE, key);
            setWalletOwner(key, email);
            if (await refreshWallet()) { prunePaidPacks(); try { ensureWordPacks(); } catch (e) {} }
            refreshAllListViews();
            try { farmSync(); } catch (e) {}
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
        try { renderHomeToday(); } catch (e) {}
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

    // 今日任務的「去做 ›」：直接跳到那個功能
    function goDoTask(key) {
        closeChickenRewardModal();
        if (key === 'practice10') setHomeTab('practice');
        else if (key === 'exam10') setHomeTab('exam');
        else if (key === 'advWin') { homeTab = 'fun'; goToAdventurePage(); }
        else if (key === 'farmCare') { homeTab = 'fun'; goToFarmPage(); }
    }
    function closeChickenRewardModal() {
        document.getElementById('chickenRewardModal').style.display = 'none';
    }

    // 今日任務視窗（chicky-daily）：任務列狀態 todo＝去做／ready＝可領取／claimed＝已領取
    const DT_TASKS = [
        { key: 'dailyLogin', title: '每日登入' },
        { key: 'practice10', title: '完成 10 題以上的任一練習' },
        { key: 'exam10', title: '完成 10 題以上的任一測驗' },
        { key: 'advWin', title: '在雞塊大冒險打敗任一敵人' },
        { key: 'farmCare', title: '在雞塊農場澆花或收成' }
    ];
    function dtRewards(key) {
        let r = [{ icon: TK_NUGGET_IMG, n: 1, label: '雞塊' }];
        if (key === 'dailyLogin') { r.push({ icon: advShardIcon(18), n: LOGIN_SHARDS, label: '冒險代幣' }); r.push({ icon: farmFlowerIcon(18), n: 1, label: '花' }); }
        return r;
    }
    function dtResetText() {
        let now = new Date(), next = new Date(now); next.setHours(24, 0, 0, 0);
        let min = Math.max(1, Math.ceil((next - now) / 60000));
        return min >= 60 ? `${Math.floor(min / 60)} 小時後更新` : `${min} 分鐘後更新`;
    }
    function dtState(key) { return isTaskClaimed(key) ? 'claimed' : (chickenData.tasks[key] && chickenData.tasks[key].done) ? 'ready' : 'todo'; }
    function updateChickenModalUI() {
        let cd = document.getElementById('chickenCountDisplay'); if (cd) cd.innerText = wallet.balance;
        let container = document.getElementById('rewardTasksContainer');
        if (!container) return;
        let claimed = 0, ready = 0;
        container.innerHTML = DT_TASKS.map(def => {
            let st = dtState(def.key);
            if (st === 'claimed') claimed++;
            if (st === 'ready') ready++;
            let rw = dtRewards(def.key).map(r => `<span class="dt-reward" role="img" aria-label="${r.label} ×${r.n}">${r.icon}<b>×${r.n}</b></span>`).join('');
            return `<li class="dt-task" data-state="${st}" data-key="${def.key}">
                <div class="dt-task__info"><span class="dt-task__name">${def.title}</span><span class="dt-rewards">${rw}</span></div>
                <div class="dt-action">
                    <button class="dt-btn dt-btn--go" type="button" data-on-click='[["goDoTask",["${def.key}"]]]'>前往 ›</button>
                    <button class="dt-btn dt-btn--claim" type="button" data-on-click='[["claimChickenReward",["${def.key}","$this"]]]'>領取</button>
                    <span class="dt-done">✓ 已領取</span>
                </div></li>`;
        }).join('');
        let el;
        if ((el = document.getElementById('dtDone'))) el.textContent = claimed;
        if ((el = document.getElementById('dtFill'))) el.style.width = (claimed / DT_TASKS.length * 100) + '%';
        if ((el = document.getElementById('dtReset'))) el.textContent = dtResetText();
        if ((el = document.getElementById('dtClaimAll'))) el.hidden = ready < 2;      // 可領取 2 個以上才顯示「全部領取」
        try { renderHomeToday(); } catch (e) {}
    }
    function dtBackdrop(e) { if (e && e.target && e.target.id === 'chickenRewardModal') closeChickenRewardModal(); }
    // 全部領取：每個可領取的任務都按一次領取（依序向後端登記，動畫一起播）
    async function claimAllChickenRewards() {
        let keys = DT_TASKS.map(d => d.key).filter(k => dtState(k) === 'ready');
        let rects = {};
        keys.forEach(k => { let b = document.querySelector(`#rewardTasksContainer [data-key="${k}"] .dt-btn--claim`); if (b) rects[k] = b.getBoundingClientRect(); });
        for (let k of keys) { await claimChickenReward(k, null, rects[k]); }
    }

    // 每日登入的花 +1：連得到後台就由 farm_act('login_flower') 發（同一天只能一次），連不到先記在這台裝置
    async function claimLoginFlower() {
        let day = chickenData.lastDate;
        if (farm.loginFlowerDay === day) return;
        if (farmSrv !== true) { try { await farmSync(); } catch (e) {} }      // 先跟後台對一次農場，避免花被後台的資料蓋掉
        if (farm.loginFlowerDay === day) return;
        farm.loginFlowerDay = day;
        if (farmSrv === true) {
            try { farmApply(await walletRpc('farm_act', { p_action: 'login_flower', p_args: { day } })); }
            catch (e) { if (!String((e && e.message) || '').includes('already_claimed')) { farm.flowers += 1; } farm.loginFlowerDay = day; }
        } else {
            farm.flowers += 1;
        }
        farmSave();
        try { farmRefresh(); } catch (e) {}
        updateChickenModalUI(); updateChickenBadgeUI();
    }

    // 領取：向後端登記（同一天同一任務只會算一次），成功後以後端回傳的餘額為準
    // 領取特效：在按鈕的位置浮出拿到的道具（圖示＋數量），浮 1 秒後慢慢淡掉；每個道具並排，不會疊在一起
    const TK_NUGGET_IMG = `<img src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='10 10 80 80'><path d='M 32 30 C 24 38, 20 50, 24 64 C 27 75, 36 82, 50 82 C 64 82, 76 76, 78 62 C 81 48, 76 35, 68 28 C 58 20, 40 22, 32 30 Z' fill='%23F3A63B' stroke='%23C27803' stroke-width='3'/><circle cx='46' cy='38' r='2' fill='%23C27803'/><circle cx='54' cy='68' r='2' fill='%23C27803'/><circle cx='64' cy='42' r='2.5' fill='%23C27803'/><circle cx='34' cy='58' r='2' fill='%23C27803'/><circle cx='48' cy='52' r='2.5' fill='%23C27803'/></svg>" alt="雞塊">`;
    function claimFx(rect, items) {
        if (!rect || !items.length) return;
        items.forEach((it, i) => {
            let el = document.createElement('span');
            el.className = 'dt-fly';
            el.style.left = (rect.left + rect.width / 2) + 'px';
            el.style.top = (rect.top + 2) + 'px';
            el.style.animationDelay = (i * 0.15) + 's';
            el.innerHTML = `${it.icon}<b>+${it.n}</b>`;
            document.body.appendChild(el);
            el.addEventListener('animationend', () => el.remove());
            setTimeout(() => el.remove(), 2500);
        });
    }
    async function claimChickenReward(taskKey, btnEl, rectIn) {
        checkDailyReset();
        let t = chickenData.tasks[taskKey];
        if (!t || !t.done || isTaskClaimed(taskKey)) return;
        for (let i = 0; walletBusy && i < 40; i++) await new Promise(r => setTimeout(r, 100));    // 全部領取：等上一個領完
        if (walletBusy) return;
        let fxRect = rectIn || (btnEl && btnEl.getBoundingClientRect ? btnEl.getBoundingClientRect() : null), fx = [];
        if (taskKey === 'dailyLogin' && !isLoginFlowerClaimed()) { claimLoginFlower(); fx.push({ icon: farmFlowerIcon(22), n: 1, k: 'flower' }); }     // 花 +1（存在農場；後台 farm_act login_flower 把關）
        if (taskKey === 'dailyLogin' && !isLoginShardClaimed()) {
            // 碎片先發（存在本機進度）；雞塊下面照原本的方式向後端領
            advData.shards += LOGIN_SHARDS;
            advData.loginShardDay = chickenData.lastDate;
            advSave();
            fx.push({ icon: advShardIcon(22), n: LOGIN_SHARDS, k: 'shard' });
            try { advRenderShopBox(); } catch (e) {}
            updateChickenBadgeUI();
        }
        if (taskKey === 'dailyLogin' && wallet.day === chickenData.lastDate && (wallet.claimedToday || []).indexOf('dailyLogin') !== -1) { claimFx(fxRect, fx); updateChickenModalUI(); updateChickenBadgeUI(); return; }
        walletBusy = true;
        try {
            let before = wallet.balance;
            // 大冒險勝利是後來新增的任務，用獨立的後端函式領取（見 supabase_adv_v3_4.sql）
            let data = taskKey === 'advWin'
                ? await walletRpc('claim_adv_win', { p_day: chickenData.lastDate })
                : await walletRpc('claim_reward', { p_task: taskKey, p_day: chickenData.lastDate });
            applyWallet(data, chickenData.lastDate);
            let gained = wallet.balance - before;
            fx.unshift({ icon: TK_NUGGET_IMG, n: Math.max(1, gained), k: 'nugget' });
            claimFx(fxRect, fx); fx = [];
        } catch (e) {
            claimFx(fxRect, fx);             // 雞塊沒領到也照樣顯示已經發出的碎片／花
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
            if (wallet.balance < cat.price) return;          // 雞塊不夠：格子已經是灰底，不另外跳訊息
            openShopListPicker();
            return;
        }

        if (cat.enabled === false || walletQty(key) >= cat.max) {
            alert(`「${meta.name}」已達購買上限。`);
            return;
        }
        if (wallet.balance < cat.price) return;              // 雞塊不夠：格子已經是灰底，不另外跳訊息
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
        let key = '';
        if (taskType === 'practice_done' && (data.total || 0) >= 10) key = 'practice10';                  // 任一練習完成 10 題以上
        else if ((taskType === 'listening_exam_done' || taskType === 'card_exam_done') && (data.total || 0) >= 10) key = 'exam10';   // 任一測驗 10 題以上
        else if (taskType === 'farm_care') key = 'farmCare';                                             // 農場澆水或收成
        if (!key || !chickenData.tasks[key] || chickenData.tasks[key].done || isTaskClaimed(key)) return;
        chickenData.tasks[key].done = true;
        saveChickenData();
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
    let speakBooks = '', speakRecChunks = [], speakRecorder = null, speakRecStream = null, speakRecUrl = '';

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
                    if (!renewing) { loadDataFromGoogleDrive(); }
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
                fcFlip();
            }
        }, false);

        cardEl.addEventListener('click', e => {
            if (!('ontouchstart' in window)) fcFlip();
        });
        // 電腦版：← → 換卡、空白鍵翻面
        document.addEventListener('keydown', e => {
            if (!document.getElementById('flashcardPlayView').classList.contains('active')) return;
            if (/INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '')) return;
            if ([...document.querySelectorAll('.modal')].some(m => m.style.display === 'block')) return;
            if (e.key === 'ArrowRight') { e.preventDefault(); nextFlashcard(); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); if (currentFcIndex > 0) prevFlashcard(); }
            else if (e.code === 'Space') { e.preventDefault(); fcFlip(); }
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
        let gd = document.getElementById('gearDot');
        if (gd) gd.style.display = ((st === 'off' && !seen) || st === 'bad') ? '' : 'none';
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
    // 取得登入的 Google 帳號 email（換帳號時用來分開題庫、錢包）
    async function cloudGetEmail() {
        if (!accessToken) return '';
        try {
            let r = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', { headers: { 'Authorization': `Bearer ${accessToken}` } });
            if (!r.ok) return '';
            let j = await r.json();
            let em = (j && j.user && j.user.emailAddress) || '';
            if (em) { localStorage.setItem(GOOGLE_EMAIL_KEY, em); cloudRender(); }
            return em;
        } catch (e) { return ''; }
    }
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
        let remain = Math.max(0, getMaxLists() - countUserLists());
        bar.textContent = `還可新增 ${remain} 本`;
    }

    // 單字行的「外語部分」：第一個中文字之前的內容（與 parseWordsRaw 的切法一致）
    // 中文意思從哪裡開始：第一個中文字；如果前面緊貼著數字（例如「5號」「10元」），數字也算中文意思的一部分
    function meaningStart(s) {
        let i = s.search(/[一-龥]/);
        if (i <= 0) return i;
        let j = i;
        while (j > 0 && /[0-9０-９.,％%~～\-]/.test(s[j - 1])) j--;
        if (j < i && (j === 0 || /\s/.test(s[j - 1]))) return j;   // 數字前面要是空白，才不會把英文單字裡的數字拆走
        return i;
    }
    function getForeignPart(line) {
        let t = line.trim();
        if (t.startsWith('*')) t = t.substring(1).trim();
        let i = meaningStart(t);
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
    function historyLang(h) {
        if (!h) return 'en';
        if ((h.results || []).some(r => RE_HANGUL.test(String(r.english || '')))) return 'ko';
        if ((h.results || []).length && (h.results || []).every(r => !RE_HANGUL.test(String(r.english || '')))) return 'en';
        return h.lang === 'ko' ? 'ko' : 'en';
    }
    function filterHistoryByLang(arr) {
        let cur = getLearningLanguage();
        return (arr || []).filter(h => historyLang(h) === cur);
    }
    // 每種語言各保留最近 10 筆
    function trimHistoryPerLang(arr) {
        let cnt = { en: 0, ko: 0 };
        return (arr || []).filter(h => {
            let l = historyLang(h);
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
        return getSelectedVoice((lang === 'ko') ? 'ko-KR' : 'en-US');
    }

    // iPhone / iPad（含 iPadOS 偽裝成 Mac 的情況）
    const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    // iOS 會列出一堆「搞笑音效」聲音，也會列出還沒下載的高品質聲音；指定到這些聲音會整句沒聲音
    const NOVELTY_VOICES = /albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|deranged|hysterical|pipe organ|eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley/i;
    function getSelectedVoice(langCode) {
        // iOS：不要指定聲音，只設定 utterance.lang，讓系統用已安裝的預設聲音（最穩定）
        if (IS_IOS) return null;
        if (voices.length === 0) voices = synth.getVoices();
        let lc = langCode.toLowerCase();
        let list = voices.filter(v => v.lang && v.lang.replace('_', '-').toLowerCase() === lc && !NOVELTY_VOICES.test(v.name));
        if (!list.length) return null;
        return list.find(v => v.default) || list.find(v => v.localService) || list[0];
    }

    // iOS 第一次發音必須在使用者點擊當下發生；之後在計時器裡唸才會有聲音。
    // 所以第一次碰觸畫面時，先唸一個聽不到的空句子把語音「解鎖」。
    (function unlockSpeechOnFirstTouch() {
        if (!window.speechSynthesis) return;
        const h = () => {
            document.removeEventListener('touchend', h, true);
            document.removeEventListener('click', h, true);
            try {
                let u = new SpeechSynthesisUtterance(' ');
                u.volume = 0;
                window.speechSynthesis.speak(u);
                window.speechSynthesis.resume();
            } catch (e) {}
        };
        document.addEventListener('touchend', h, true);
        document.addEventListener('click', h, true);
    })();

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
        // 安卓／電腦：手指一按下（pointerdown）就重連。
        // iPhone：要等「點擊」完成（click）才重連。按下的瞬間開 Google 視窗、改畫面文字，
        // iPhone 會把這次點擊吃掉（按鈕沒反應）；等點擊送出後再連，按鈕照常有反應。
        const type = IS_IOS ? 'click' : 'pointerdown';
        const h = (e) => {
            // 點的是設定裡的雲端按鈕（重新連線／登出）：交給按鈕自己處理，不要重複連線
            if (e && e.target && e.target.closest && e.target.closest('#cloudSettingsBox')) return;
            document.removeEventListener(type, h, true);
            reconnectClickArmed = false;
            trySilentReconnect(true);   // 要在點擊當下呼叫，Safari 才允許開 Google 視窗
        };
        document.addEventListener(type, h, true);
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

    const LOCAL_OWNER_KEY = 'chicky_local_owner';      // 這台裝置上的題庫、測驗紀錄是哪個 Google 帳號的
    async function loadDataFromGoogleDrive() {
        if (!accessToken) return;
        updateCloudStatusText(`☁️ 雲端資料同步中...`);
        let advNeedUpload = false;
        let email = await cloudGetEmail();
        let gotCloudLists = false;
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
                        gotCloudLists = true;
                        wordLists = cloudData.wordLists;
                        localStorage.setItem('dictation_word_lists', JSON.stringify(wordLists));
                        setTimeout(() => { try { ensureWordPacks(); } catch (e) {} }, 0);   // 雲端舊資料沒有免費單字庫：補上
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
            // 雲端還沒有題庫（新帳號）：這台裝置的題庫如果是「另一個帳號」的，就不要帶進來，從空白開始
            let owner = '';
            try { owner = localStorage.getItem(LOCAL_OWNER_KEY) || ''; } catch (e) {}
            if (!gotCloudLists && email && owner && owner !== email) {
                wordLists = []; examHistory = []; cardExamHistory = [];
                localStorage.setItem('dictation_word_lists', '[]');
                localStorage.setItem('dictation_exam_history', '[]');
                localStorage.setItem('dictation_card_exam_history', '[]');
                try { ensureWordPacks(); } catch (e) {}
                try { refreshAllListViews(); initEditorListCards(); } catch (e) {}
            }
            if (email) try { localStorage.setItem(LOCAL_OWNER_KEY, email); } catch (e) {}
            advCloudReady = true;
            // 登入後第一次同步：把這台裝置的錢包和 Google 雲端的錢包綁在一起
            if (!walletBoundThisLogin) {
                walletBoundThisLogin = true;
                let usedKey = await bindWalletAfterLogin(cloudWalletKey, email);
                if (usedKey) {
                    let needUpload = usedKey !== cloudWalletKey;
                    cloudWalletKey = usedKey;
                    if (!advData.owner) { advData.owner = usedKey; advSave(true); }
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
                    if (cj && cj.advData && cj.advData.ver === ADV_DATA_VER && !advConflict) advMergeFromCloud(cj.advData, '');
                } catch (e) { /* 讀不到就照原本流程上傳 */ }
            }
            let cloudData = { 
                activeDeviceId: myDeviceId, 
                wordLists, 
                examHistory: trimHistoryPerLang(examHistory), 
                cardExamHistory: trimHistoryPerLang(cardExamHistory), 
                walletKey: cloudWalletKey || undefined,
                chickenData,
                advData: advIsGoogleMode() ? (advConflict ? advConflict.c : advData) : undefined,     // 只上傳 Google 進度；兩邊進度衝突、玩家還沒選之前：雲端那份原封不動
                appSettings: JSON.parse(localStorage.getItem('dictation_app_settings') || '{}') 
            };
            let fileContent = JSON.stringify(cloudData);
            let sentAdvTs = cloudData.advData ? (parseInt(cloudData.advData.ts) || 0) : 0;

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
            if (advIsGoogleMode() && !advConflict) { advSetSyncBase(sentAdvTs); if (advData.ts === sentTs) advDirty = false; }
            updateCloudStatusText(`✅ 已連結 Google 雲端`);
        } catch(e) { 
            console.error("雲端存檔失敗", e); 
            updateCloudStatusText(`⚠️ 雲端同步失敗`);
        }
    }

    function switchView(viewId) {
        try { if (viewId !== 'adventureView') faStop(); if (viewId !== 'adventureBattleView') advHideResult(); } catch (e) {}
        if (viewId !== 'adventureBattleView') document.body.classList.remove('bt-on');
        // 戰鬥中打字：鍵盤蓋在畫面上，不要把整個遊戲畫面往上推
        try { if (navigator.virtualKeyboard) navigator.virtualKeyboard.overlaysContent = (viewId === 'adventureBattleView'); } catch (e) {}
        document.querySelectorAll('.app-view').forEach(v => v.classList.remove('active'));
        document.getElementById(viewId).classList.add('active');
        document.body.classList.toggle('farm-on', viewId.indexOf('farm') === 0);     // 雞塊農場：整頁暖色背景
        // 雞塊農場有自己的配色：在農場裡不套用省電模式（深色），離開農場再照設定恢復
        try { let ps = document.getElementById('powerSavingToggle'); document.body.classList.toggle('power-saving-mode', !/^(farm|adv)/.test(viewId) && !!(ps && ps.checked)); } catch (e) {}   // 遊戲（大冒險、農場）畫面不受省電模式影響
        if (viewId !== 'farmView') { try { farmShopOpen = false; farmBeeOpen = false; } catch (e) {} }
        if (viewId.indexOf('farm') !== 0) { let fo = document.getElementById('farmOverlay'); if (fo) fo.innerHTML = ''; }
        if (viewId === 'homeDashboardView') { try { homeAdvBadge(); } catch (e) {} }
        try { syncHomeChrome(viewId); } catch (e) {}
        try { setTimeout(updateStickyBar, 0); } catch (e) {}
        
        let wrapper = document.getElementById('mainScaleWrapper');
        // 新版練習頁（cp-）與建立單字頁（we-）：不放大，照設計稿的寬度（手機 480、電腦 780）
        const CP_VIEWS = ['practiceView', 'examView', 'flashcardSetupView', 'flashcardPlayView', 'cardExamSetupView', 'cardExamPlayView', 'speakPracticeSetupView', 'speakPracticePlayView', 'advLevelView', 'advStatsView'];
        let cpOn = CP_VIEWS.includes(viewId), weOn = viewId === 'editorDetailView';
        document.body.classList.toggle('cp-on', cpOn);
        document.body.classList.toggle('we-on', weOn);
        if (!weOn) document.body.classList.remove('we-sub');
        document.body.classList.toggle('qz-on', viewId === 'cardExamPlayView' || (viewId === 'examView' && typeof isExamRunning !== 'undefined' && isExamRunning));   // 測驗作答中：手機整頁高度跟著可見區域（鍵盤）
        document.body.classList.toggle('cp-tall', viewId === 'flashcardPlayView' || viewId === 'speakPracticePlayView' || viewId === 'advLevelView' || viewId === 'advStatsView' || (viewId === 'practiceView' && typeof isPlaying !== 'undefined' && isPlaying));
        if (cpOn || weOn) { wrapper.className = 'scale-wrapper-cp'; }
        else if (['practiceView', 'examView', 'flashcardPlayView', 'flashcardSetupView', 'cardExamSetupView', 'cardExamPlayView', 'speakPracticeSetupView', 'speakPracticePlayView', 'homeDashboardView', 'editorListView', 'editorDetailView', 'historyView'].includes(viewId)) {
            wrapper.className = 'scale-wrapper-practice';
        } else {
            wrapper.className = 'scale-wrapper';
        }
    }

    function goToPracticePage() {
        initPracticeCardGrid();
        if (!isPlaying) lpShowPart(false);
        switchView('practiceView');
        cpRenderResume('listen');
    }

    function goToFlashcardPage() {
        initFlashcardGrid();
        switchView('flashcardSetupView');
        cpRenderResume('flash');
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

    // 先用手機裡的資料馬上顯示，雲端在背景同步，同步完再更新畫面（30 秒內不重複同步）
    let lastDriveSync = 0;
    function syncDriveInBackground(after) {
        if (!(accessToken && isCloudSyncActive) || Date.now() - lastDriveSync < 30000) return;
        lastDriveSync = Date.now();
        showSyncChick(true);
        Promise.resolve().then(() => loadDataFromGoogleDrive()).catch(() => {}).finally(() => { showSyncChick(false); try { after && after(); } catch (e) {} });
    }
    function showSyncChick(on) {
        let el = document.getElementById('syncChick');
        if (!el) {
            if (!on) return;
            document.body.insertAdjacentHTML('beforeend', `<div id="syncChick" class="sync-chick" role="status"><span class="ck">${advChickenSVG()}</span>雲端同步中…</div>`);
            el = document.getElementById('syncChick');
        }
        el.classList.toggle('show', !!on);
    }
    function goToEditorPage() {
        initEditorListCards();
        switchView('editorListView');
        syncDriveInBackground(() => { if (document.getElementById('editorListView').classList.contains('active')) initEditorListCards(); });
    }

    // ── 首頁分頁：練習／測驗／題庫／樂園（手機在底部、電腦在上方）──
    let homeTab = 'practice';
    const HOME_TAB_VIEWS = ['homeDashboardView', 'editorListView'];
    function setHomeTab(t) {
        homeTab = ['practice', 'exam', 'lists', 'fun'].includes(t) ? t : 'practice';
        if (homeTab === 'lists') { goToEditorPage(); return; }
        if (!document.getElementById('homeDashboardView').classList.contains('active')) switchView('homeDashboardView');
        else syncHomeChrome('homeDashboardView');
        window.scrollTo(0, 0);
    }
    function syncHomeChrome(viewId) {
        let on = HOME_TAB_VIEWS.includes(viewId);
        if (viewId === 'editorListView') homeTab = 'lists';
        else if (viewId === 'homeDashboardView' && homeTab === 'lists') homeTab = 'practice';
        let chrome = document.getElementById('appChrome');
        if (chrome) chrome.style.display = on ? '' : 'none';
        document.body.classList.toggle('home-tabbed', on);
        let bar = document.getElementById('acTabs');      // 手機：卡片往下延伸到底部分頁列
        if (on && bar) requestAnimationFrame(() => { if (bar.offsetHeight) document.documentElement.style.setProperty('--tabh', bar.offsetHeight + 'px'); });
        document.querySelectorAll('#acTabs .ac-tab').forEach(b => { let me = b.getAttribute('data-tab') === homeTab; b.classList.toggle('on', me); b.setAttribute('aria-selected', me ? 'true' : 'false'); });
        document.querySelectorAll('#acMascot .m').forEach(m => m.classList.toggle('on', m.getAttribute('data-tab') === homeTab));
        document.querySelectorAll('#homeDashboardView .hm-pane').forEach(p => p.style.display = p.getAttribute('data-pane') === homeTab ? '' : 'none');
        if (on) renderHomeToday();
    }
    setTimeout(() => { try { let v = document.querySelector('.app-view.active'); syncHomeChrome(v ? v.id : 'homeDashboardView'); } catch (e) {} }, 0);
    // ── 有返回鍵的頁面：往下捲時，頂部縮成和卡片同寬的細長條（返回鍵＋標題）──
    function stickyBarEl() {
        let el = document.getElementById('stickyNavBar');
        if (!el) {
            document.body.insertAdjacentHTML('beforeend', `<div id="stickyNavBar" aria-hidden="true"><button type="button" class="sb-back" aria-label="返回"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg></button><b class="sb-title"></b></div>`);
            el = document.getElementById('stickyNavBar');
            el.querySelector('.sb-back').addEventListener('click', () => { let b = activeBackBtn(); if (b) b.click(); });
        }
        return el;
    }
    function activeBackBtn() {
        let v = document.querySelector('.app-view.active');
        if (!v) return null;
        return [...v.querySelectorAll('.top-nav-bar .back-home-btn, .adv-topbar .back-home-btn, .cp-header .cp-back, .we-header .we-back')].find(b => b.offsetParent !== null) || null;
    }
    function updateStickyBar() {
        let el = stickyBarEl();
        let v = document.querySelector('.app-view.active'), nav = v && v.querySelector('.top-nav-bar');
        let back = activeBackBtn();
        let show = !!(nav && back && !HOME_TAB_VIEWS.includes(v.id) && v.id !== 'adventureBattleView' && nav.getBoundingClientRect().bottom < 0);
        if (show) {
            let card = document.querySelector('.paper-card-container').getBoundingClientRect();
            el.style.left = card.left + 'px'; el.style.width = card.width + 'px';
            let t = nav.querySelector('.current-mode-indicator');
            el.querySelector('.sb-title').textContent = t ? t.textContent.replace(/^[^\w一-鿿가-힯]+/, '').trim() : '';
        }
        el.classList.toggle('show', show);
    }
    window.addEventListener('scroll', () => { try { updateStickyBar(); } catch (e) {} }, { passive: true });
    window.addEventListener('resize', () => { try { updateStickyBar(); } catch (e) {} });
    // ── 手機的返回手勢／Android 返回鍵：回到 App 的上一頁，而不是離開網頁 ──
    let backGuard = false;
    function armBackGuard() {
        if (backGuard) return;
        try { history.pushState({ chicky: 1 }, ''); backGuard = true; } catch (e) {}
    }
    window.addEventListener('popstate', () => {
        backGuard = false;
        let v = document.querySelector('.app-view.active');
        let openModal = [...document.querySelectorAll('.modal')].find(m => m.style.display === 'block');
        if (openModal) {
            let x = openModal.querySelector('.close-modal, .modal-back-btn');
            if (x) x.click(); else openModal.style.display = 'none';
            armBackGuard(); return;
        }
        if (v && !HOME_TAB_VIEWS.includes(v.id)) {
            let b = activeBackBtn();
            if (b) b.click();
            armBackGuard(); return;
        }
        if (homeTab !== 'practice') { setHomeTab('practice'); armBackGuard(); return; }
        // 已經在首頁「練習」：再按一次返回就照瀏覽器原本的行為
    });
    document.addEventListener('click', () => { if (!backGuard) armBackGuard(); }, true);

    // 練習分頁最上面：今日任務
    function renderHomeToday() {
        if (typeof chickenData === 'undefined') return;
        try {   // 右上角的雞塊：外圈是今日任務進度，有可以領的就亮紅點
            let n0 = CHICKEN_TASK_KEYS.length, d0 = CHICKEN_TASK_KEYS.filter(k => taskDoneOrClaimed(k)).length;
            let ring = document.getElementById('acTaskRing'), dot = document.getElementById('acTaskDot');
            if (ring) ring.setAttribute('stroke-dasharray', `${(d0 / n0 * 106.8).toFixed(1)} 106.8`);
            if (dot) dot.style.display = CHICKEN_TASK_KEYS.some(k => chickenData.tasks[k] && chickenData.tasks[k].done && !isTaskClaimed(k)) ? '' : 'none';
            let ok = document.getElementById('acTaskOk'); if (ok) ok.style.display = d0 >= n0 ? '' : 'none';     // 今日任務 100%：雞塊上打綠勾
        } catch (e) {}
        let box = document.getElementById('homeToday');
        if (!box) return;
        let keys = CHICKEN_TASK_KEYS, n = keys.length;
        let done = keys.filter(k => taskDoneOrClaimed(k)).length;
        let unclaimed = keys.filter(k => chickenData.tasks[k] && chickenData.tasks[k].done && !isTaskClaimed(k)).length;
        let sub = unclaimed ? `有 ${unclaimed} 項可以領雞塊！` : done >= n ? '今天的任務全部完成了！' : `再完成 ${n - done} 項，就能多領雞塊`;
        box.innerHTML = `<div class="tx"><b>今日任務 ${done} / ${n}</b><small>${sub}</small><div class="bar"><i style="width:${(done / n * 100).toFixed(0)}%"></i></div></div>
            <button type="button" class="go${unclaimed ? ' hot' : ''}" data-on-click='[["openChickenRewardModal",[]]]'>${unclaimed ? '領取' : '查看'}</button>`;
    }

    function backToHome() {
        if (advPrac) { stopDictation(); advPracDone(); return; }
        stopDictation();
        stopCardExamSession();
        stopSpeakPracticeSession();
        advAbort();
        releaseWakeLock();
        switchView('homeDashboardView');
    }

    function backToHomeFromExam() {
        if (isExamRunning) {               // 作答中按返回：先確認，再結束測驗（取代舊的紅色「結束並停止考試」）
            if (confirm('要結束這次聽力測驗嗎？\n\n已經作答的題目會計分。')) finishExam();
            return;
        }
        stopExamMode();
        releaseWakeLock();
        switchView('homeDashboardView');
    }

    // ── 題庫清單：上面「精選／自訂」切換，下面精簡清單 ──
    let listSeg = 'custom';
    function setListSeg(k) { listSeg = k === 'pack' ? 'pack' : 'custom'; initEditorListCards(); }
    function initEditorListCards() {
        let container = document.getElementById('editorListCardContainer');
        if (!container) return;
        document.querySelectorAll('body > .dropdown-menu').forEach(m => m.remove()); // 清掉搬到最外層的舊選單
        updateListQuotaBar();
        let cur = getLearningLanguage();
        let items = wordLists.map((l, idx) => ({ l, idx })).filter(x => getListLang(x.l) === cur);
        let packs = items.filter(x => isPackList(x.l)), mine = items.filter(x => !isPackList(x.l));
        let seg = document.getElementById('listSeg');
        if (seg) seg.innerHTML = `<button type="button" class="${listSeg === 'pack' ? 'on' : ''}" data-on-click='[["setListSeg",["pack"]]]'>精選單字庫<small>${packs.length}</small></button><button type="button" class="${listSeg === 'custom' ? 'on' : ''}" data-on-click='[["setListSeg",["custom"]]]'>自訂單字庫<small>${mine.length}</small></button>`;
        let bar = document.getElementById('listBar');
        if (bar) bar.style.display = listSeg === 'custom' ? '' : 'none';
        let tag = lang => `<span class="lang-tag lang-tag-${lang}">${getLangName(lang)}</span>`;
        let html;
        if (listSeg === 'pack') {
            // 分兩組：多益／大冒險（照章節）
            let row = ({ l, idx }) => {
                let m = WORD_PACKS[l.pack] || {}, ch = m.chapter && ADV_CHAPTERS.find(c => c.id === m.chapter);
                let sub = `${getListWordCount(l.content)} 字${ch ? `・第 ${ch.from}～${ch.to} 關` : ''}`;
                return `<div class="lst-row" data-on-click='[["openEditorDetail",[${idx}]]]'><span class="lst-no pk">${packIconHTML(l.pack, 30)}</span><span class="lst-tx"><b>${escapeHTML(l.title)}</b> ${tag(getListLang(l))}<small>${sub}</small></span><span class="lst-ar">›</span></div>`;
            };
            let advP = packs.filter(x => (WORD_PACKS[x.l.pack] || {}).kind === 'adv').sort((x, y) => (WORD_PACKS[x.l.pack].chapter || 0) - (WORD_PACKS[y.l.pack].chapter || 0));
            let farmP = packs.filter(x => (WORD_PACKS[x.l.pack] || {}).kind === 'farm');
            let others = packs.filter(x => ['adv', 'farm'].indexOf((WORD_PACKS[x.l.pack] || {}).kind) === -1);
            let shop = `<div class="lst-row lst-shop" data-on-click='[["openChickenShopModal",[]]]'><span class="lst-no">🛒</span><span class="lst-tx"><b>到雞塊補給站看更多</b></span><span class="lst-ar">›</span></div>`;
            // 多益放上面；大冒險題庫比較不重要，放在下面
            html = `<div class="lst-grp">多益</div><div class="lst-list">${others.map(row).join('')}${shop}</div>`
                + (advP.length ? `<div class="lst-grp">大冒險</div><div class="lst-list">${advP.map(row).join('')}</div>` : '')
                + (farmP.length ? `<div class="lst-grp">農場</div><div class="lst-list">${farmP.map(row).join('')}</div>` : '');
            container.classList.remove('two');
            container.classList.add('grouped');
        } else if ((container.classList.remove('grouped'), !mine.length)) {
            html = `<div class="lst-empty">目前還沒有${getLangName(cur)}題庫，按右上角「＋ 新增」開始建立</div>`;
            container.classList.remove('two');
        } else {
            html = mine.map(({ l, idx }, k) => {
                let count = getListWordCount(l.content), cap = getListWordCap(l);
                return `<div class="lst-row" data-on-click='[["openEditorDetail",[${idx}]]]'><span class="lst-no">${k + 1}</span><span class="lst-tx"><b>${escapeHTML(l.title)}</b> ${tag(getListLang(l))}<small><span class="${count >= cap * 0.9 ? 'warn' : ''}">${count}</span> / ${cap} 字</small></span>
                    <span class="lst-menu"><button class="list-card-menu-btn" data-on-click='[["$stop",[]],["toggleDropdownMenu",[${idx},"$event"]]]'>⋮</button>
                        <div class="dropdown-menu" id="dropdownMenu_${idx}">
                            <button class="dropdown-item" data-on-click='[["$stop",[]],["renameListTitleFromMenu",[${idx}]]]'>修改</button>
                            <button class="dropdown-item" data-on-click='[["$stop",[]],["clearListContentFromMenu",[${idx}]]]'>清空</button>
                            <button class="dropdown-item danger" data-on-click='[["$stop",[]],["deleteListFromMenu",[${idx}]]]'>刪除</button>
                        </div></span></div>`;
            }).join('');
            container.classList.add('two');
        }
        container.innerHTML = html;
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

    // ═════════ 建立單字頁（表格編輯；三種畫面：list 表格／add 新增一列（也用來編輯）／paste 批次貼上）═════════
    const WE_POS = ['名詞', '動詞', '形容詞', '副詞', '連接詞', '介係詞', '片語', '代名詞', '感嘆詞'];
    const WE_STAR_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z"/></svg>';
    let weWords = [], weSort = null, weDirty = false, weMax = 100, wePack = false, weDraft = null, weEditAt = -1, weParsed = [];
    const we$ = (sel) => document.querySelector(sel);
    function weEl(tag, cls, text) { let n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
    // 鍵盤打開時，畫面高度＝看得到的高度（底部按鈕停在鍵盤上方）
    function weFitViewport() {
        let h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        document.documentElement.style.setProperty('--we-vh', h + 'px');
    }
    if (window.visualViewport) window.visualViewport.addEventListener('resize', weFitViewport);
    window.addEventListener('resize', weFitViewport); weFitViewport();
    function weToast(msg) {
        let t = we$('#weToast'); if (!t) return;
        t.textContent = msg; t.hidden = false;
        clearTimeout(weToast._t); weToast._t = setTimeout(() => { t.hidden = true; }, 1800);
    }
    function weLangName() { return getListLang(wordLists[lastSelectedList]) === 'ko' ? '韓文' : '英文'; }
    // 題庫內容 → 表格資料
    function weFromContent(content) {
        return parseWordsRaw(content || '').map(w => ({
            star: !!w.starred, en: w.english,
            means: (w.senses && w.senses.length ? w.senses : [{ m: w.meanings, p: w.posList }]).map(s => ({ zh: (s.m || []).join(' '), pos: (s.p || []).slice() })),
            raw: w.rawLine
        }));
    }
    function weLine(w) {
        if (w.raw) return (w.star ? '*' : '') + w.raw.replace(/^\s*\*\s*/, '');
        return (w.star ? '*' : '') + w.en + ' ' + w.means.map(m => [m.zh].concat(m.pos).filter(Boolean).join(' ')).join(' ');
    }
    function weCount(extra) {
        let n = weWords.length + (extra || 0);
        document.querySelectorAll('#editorDetailView .js-count').forEach(e => { e.textContent = n; });
        document.querySelectorAll('#editorDetailView .js-max').forEach(e => { e.textContent = weMax; });
        let f = we$('#weFill'); if (f) f.style.width = Math.min(100, weWords.length / weMax * 100) + '%';
    }
    function weSetMode(m) {
        let root = we$('#editorDetailView');
        root.dataset.mode = m;
        root.querySelectorAll('[data-view]').forEach(v => { v.hidden = v.dataset.view !== m; });
        document.body.classList.toggle('we-sub', m !== 'list');
        weClosePos();
        weCount();
    }
    function openEditorDetail(idx) {
        lastSelectedList = idx;
        localStorage.setItem('dictation_last_selected_list', idx);
        let list = wordLists[idx];
        if (!list) return;
        wePack = isPackList(list);
        editorOpenCount = getListWordCount(list.content);
        document.getElementById('editorWordList').value = list.content || '';
        weWords = weFromContent(list.content);
        weMax = wePack ? Math.max(weWords.length, 1) : Math.max(getListWordCap(list), editorOpenCount);
        weSort = null; weDirty = false;
        let root = we$('#editorDetailView');
        root.classList.toggle('we-pack', wePack);
        root.classList.toggle('ed-pack', wePack);
        root.querySelectorAll('.js-book').forEach(e => { e.textContent = list.title; });
        root.querySelectorAll('.js-lang').forEach(e => { e.textContent = weLangName(); });
        we$('#weDraftEn').placeholder = weLangName();
        we$('#wePasteBox').placeholder = getListLang(list) === 'ko' ? '사과 蘋果 名詞\n*친구 朋友' : 'honest 誠實的 形容詞\n*generous 慷慨的';
        we$('#weSearch').value = '';
        we$('#weSortLabel').textContent = 'A-Z';
        switchView('editorDetailView');
        weSetMode('list');
        weRenderRows();
        window.scrollTo(0, 0);
    }
    function weRenderRows() {
        let q = we$('#weSearch').value.trim().toLowerCase();
        let list = weWords.map((w, i) => ({ w, i }));
        if (q) list = list.filter(({ w }) => w.en.toLowerCase().includes(q) || w.means.some(m => m.zh.toLowerCase().includes(q)));
        if (weSort) list.sort((a, b) => a.w.en.localeCompare(b.w.en, getLearningLanguage(), { sensitivity: 'base' }) * (weSort === 'az' ? 1 : -1));
        let body = we$('#weRows'); body.textContent = '';
        if (!list.length) { body.appendChild(weEl('div', 'we-empty', q ? '找不到符合的單字' : (wePack ? '這本沒有單字' : '還沒有單字，按「新增一列」開始'))); weCount(); return; }
        list.forEach(({ w, i }) => {
            let row = weEl('div', 'we-grid we-row' + (wePack ? '' : ' we-row--tap'));
            let star = weEl('button', 'we-star'); star.type = 'button';
            star.innerHTML = WE_STAR_SVG;
            star.setAttribute('aria-pressed', w.star ? 'true' : 'false');
            star.setAttribute('aria-label', (w.star ? '取消星號：' : '加星號：') + w.en);
            star.addEventListener('click', (e) => { e.stopPropagation(); weToggleStar(i); });
            let en = weEl('span', 'we-en', w.en);
            let means = weEl('div', 'we-means');
            w.means.forEach(m => {
                let line = weEl('div', 'we-mean');
                line.appendChild(weEl('span', 'we-zh', m.zh));
                m.pos.forEach(p => line.appendChild(weEl('span', 'we-pos', p)));
                means.appendChild(line);
            });
            row.append(star, en, means);
            if (!wePack) { row.title = '點一下編輯'; row.addEventListener('click', () => weOpenEdit(i)); }
            body.appendChild(row);
        });
        weCount();
    }
    function weToggleStar(i) {
        let w = weWords[i]; if (!w) return;
        w.star = !w.star;
        if (wePack) weSave(true); else weDirty = true;      // 精選單字庫：只能加星號，點了直接存
        weRenderRows();
    }
    // 存回題庫（跟原本的「儲存」一樣：存本機＋雲端，更新各個選題庫畫面）
    function weSave(silent) {
        let idx = lastSelectedList, list = wordLists[idx];
        if (!list) return;
        list.content = weWords.map(weLine).join('\n');
        document.getElementById('editorWordList').value = list.content;
        localStorage.setItem('dictation_word_lists', JSON.stringify(wordLists));
        triggerAutoSaveToCloud();
        if (wePack) refreshListViewsSoon();
        else { try { initPracticeCardGrid(); initExamCardGrid(); initFlashcardGrid(); initCardExamGrid(); initSpeakPracticeGrid(); } catch (e) {} }
        weDirty = false;
        if (!silent) weToast('已儲存');
    }
    function backToListFromDetail() {
        weClosePos();
        if (weDirty) weSave(true);          // 還沒按儲存就返回：自動幫你存起來
        document.body.classList.remove('we-sub');
        enforceCurrentEditorLanguage();
        initEditorListCards();
        switchView('editorListView');
    }
    // ---- 新增一列／編輯 ----
    function weNewDraft() { weDraft = { star: false, en: '', means: [{ zh: '', pos: [] }] }; }
    function weRenderDraft() {
        we$('#weDraftEn').value = weDraft.en;
        we$('#weDraftStar').setAttribute('aria-pressed', weDraft.star ? 'true' : 'false');
        we$('#weDraftStarIcon').setAttribute('aria-pressed', weDraft.star ? 'true' : 'false');
        let box = we$('#weDraftMeans'); box.textContent = '';
        weDraft.means.forEach((m, k) => {
            let line = weEl('div', 'we-edit__mean');
            let zh = weEl('input', 'we-input'); zh.value = m.zh; zh.placeholder = '中文'; zh.setAttribute('aria-label', '中文意思 ' + (k + 1));
            zh.addEventListener('input', () => { m.zh = zh.value; weCheckDraft(); });
            zh.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); if (!we$('#weAddConfirm').disabled) weConfirmDraft(); } });
            let pb = weEl('button', 'we-pos-btn' + (m.pos.length ? ' has-value' : ''), m.pos.length ? m.pos.join('\n') : '詞性');
            pb.type = 'button'; pb.style.whiteSpace = 'pre-line';
            pb.setAttribute('aria-label', '選擇詞性');
            pb.addEventListener('click', (e) => { e.stopPropagation(); weOpenPos(pb, m); });
            line.append(zh, pb); box.appendChild(line);
        });
        weCheckDraft();
    }
    function weDraftError() {
        let en = weDraft.en.trim(), lang = getListLang(wordLists[lastSelectedList]);
        if (!en || !weDraft.means.some(m => m.zh.trim())) return 'empty';
        if (/[一-龥]/.test(en)) return `${weLangName()}欄不能有中文`;
        if (lang === 'ko' ? RE_LATIN.test(en) : RE_HANGUL.test(en)) return `這本是${weLangName()}題庫`;
        let dup = weWords.findIndex(w => w.en.toLowerCase() === en.toLowerCase());
        if (dup !== -1 && dup !== weEditAt) return `已經有「${weWords[dup].en}」了`;
        return '';
    }
    function weCheckDraft() {
        let full = weEditAt < 0 && weWords.length >= weMax;
        we$('#weAddConfirm').disabled = !!weDraftError() || full;
    }
    function weOpenAdd() {
        if (weWords.length >= weMax) { weToast(`已達單字上限 ${weMax} 字`); }
        weEditAt = -1; weNewDraft();
        we$('#weAddTitle').textContent = '新增單字';
        we$('#weAddConfirm').textContent = '加入';
        we$('#weDelBtn').hidden = true;
        weSetMode('add'); weRenderDraft(); we$('#weDraftEn').focus();
    }
    function weOpenEdit(i) {
        let w = weWords[i]; if (!w) return;
        weEditAt = i;
        weDraft = { star: w.star, en: w.en, means: w.means.map(m => ({ zh: m.zh, pos: m.pos.slice() })) };
        if (!weDraft.means.length) weDraft.means.push({ zh: '', pos: [] });
        we$('#weAddTitle').textContent = '編輯單字';
        we$('#weAddConfirm').textContent = '儲存';
        we$('#weDelBtn').hidden = false;
        weSetMode('add'); weRenderDraft();
    }
    function weConfirmDraft() {
        let err = weDraftError();
        if (err) { if (err !== 'empty') weToast(err); return; }
        let w = { star: weDraft.star, en: weDraft.en.trim().replace(/\s+/g, ' '), means: weDraft.means.filter(m => m.zh.trim()).map(m => ({ zh: m.zh.trim(), pos: m.pos })), raw: '' };
        if (weEditAt >= 0) { weWords[weEditAt] = w; }
        else { weWords.unshift(w); weSort = null; we$('#weSortLabel').textContent = 'A-Z'; }
        weDirty = true;
        let msg = (weEditAt >= 0 ? '已更新 ' : '已加入 ') + w.en;
        weEditAt = -1;
        weSetMode('list'); weRenderRows(); weToast(msg);
        try { let c = document.getElementById('obCoach'); if (c) c.remove(); } catch (e) {}
    }
    function weDeleteDraft() {
        if (weEditAt < 0) return;
        let w = weWords[weEditAt];
        if (!confirm(`要刪除「${w.en}」嗎？`)) return;
        weWords.splice(weEditAt, 1); weEditAt = -1; weDirty = true;
        weSetMode('list'); weRenderRows(); weToast('已刪除 ' + w.en);
    }
    // 詞性選單（可複選）
    function weOpenPos(btn, mean) {
        let menu = we$('#wePosMenu'); menu.textContent = '';
        WE_POS.forEach(p => {
            let b = weEl('button', '', p); b.type = 'button';
            b.setAttribute('aria-pressed', mean.pos.includes(p) ? 'true' : 'false');
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                mean.pos = mean.pos.includes(p) ? mean.pos.filter(x => x !== p) : mean.pos.concat(p);
                b.setAttribute('aria-pressed', mean.pos.includes(p) ? 'true' : 'false');
                btn.textContent = mean.pos.length ? mean.pos.join('\n') : '詞性';
                btn.classList.toggle('has-value', mean.pos.length > 0);
            });
            menu.appendChild(b);
        });
        let r = btn.getBoundingClientRect();
        menu.hidden = false;
        let left = Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, r.right - menu.offsetWidth));
        let top = r.bottom + 6;
        if (top + menu.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - menu.offsetHeight - 6);
        menu.style.left = left + window.scrollX + 'px';
        menu.style.top = top + window.scrollY + 'px';
    }
    function weClosePos() { let m = we$('#wePosMenu'); if (m) m.hidden = true; }
    // ---- 批次貼上 ----
    function weParseLine(line) {
        let s = line.trim(); if (!s) return null;
        let star = s.startsWith('*'); if (star) s = s.slice(1).trim();
        let lang = getListLang(wordLists[lastSelectedList]);
        let i = meaningStart(s);
        let en = (i === -1 ? s : s.slice(0, i)).trim(), rest = i === -1 ? '' : s.slice(i).trim();
        if (!en) return { error: '缺少' + weLangName() };
        if (lang === 'ko' ? RE_LATIN.test(en) : RE_HANGUL.test(en)) return { error: '不是' + weLangName() };
        if (!rest) return { error: '缺少中文' };
        let pm = parseMeaningPart(rest);
        if (!pm.senses.length || pm.senses.some(x => !x.m.length)) return { error: '缺少中文' };
        return { word: { star, en: en.replace(/\s+/g, ' '), means: pm.senses.map(x => ({ zh: x.m.join(' '), pos: x.p.slice() })), raw: '' } };
    }
    function weCheckPaste() {
        let lines = we$('#wePasteBox').value.split('\n');
        weParsed = []; let errors = [], dups = 0, seen = new Set(weWords.map(w => w.en.toLowerCase()));
        lines.forEach((l, i) => {
            let r = weParseLine(l); if (!r) return;
            if (r.error) { errors.push('第 ' + (i + 1) + ' 行' + r.error); return; }
            let k = r.word.en.toLowerCase();
            if (seen.has(k)) { dups++; return; }
            seen.add(k); weParsed.push(r.word);
        });
        let room = Math.max(0, weMax - weWords.length);
        let over = Math.max(0, weParsed.length - room);
        if (over) weParsed = weParsed.slice(0, room);
        let st = we$('#wePasteStatus'); st.textContent = '';
        if (weParsed.length) st.appendChild(weEl('span', 'we-chip we-chip--ok', '✓ 可加入 ' + weParsed.length + ' 個'));
        errors.slice(0, 2).forEach(m => st.appendChild(weEl('span', 'we-chip we-chip--warn', '⚠ ' + m + '，會先略過')));
        if (errors.length > 2) st.appendChild(weEl('span', 'we-chip we-chip--warn', '還有 ' + (errors.length - 2) + ' 行有問題'));
        if (dups) st.appendChild(weEl('span', 'we-chip we-chip--warn', dups + ' 個已經在題庫裡，會略過'));
        if (over) st.appendChild(weEl('span', 'we-chip we-chip--warn', '超過上限，' + over + ' 個沒加入'));
        let btn = we$('#wePasteConfirm');
        btn.disabled = !weParsed.length; btn.textContent = weParsed.length ? '加入 ' + weParsed.length + ' 個' : '加入';
        weCount(weParsed.length);
    }
    function weOpenPaste() { we$('#wePasteBox').value = ''; weSetMode('paste'); weCheckPaste(); we$('#wePasteBox').focus(); }
    function weConfirmPaste() {
        if (!weParsed.length) return;
        weWords = weParsed.concat(weWords); weDirty = true; weSort = null; we$('#weSortLabel').textContent = 'A-Z';
        let n = weParsed.length; weSetMode('list'); weRenderRows(); weToast('已加入 ' + n + ' 個單字');
        try { let c = document.getElementById('obCoach'); if (c) c.remove(); } catch (e) {}
    }
    // ---- 綁定事件（畫面元素是固定的，綁一次就好）----
    (function weBind() {
        let on = (sel, ev, fn) => { let n = we$(sel); if (n) n.addEventListener(ev, fn); };
        on('#weBackBtn', 'click', () => backToListFromDetail());
        on('#weSearch', 'input', weRenderRows);
        on('#weSortBtn', 'click', () => { weSort = weSort === 'az' ? 'za' : 'az'; we$('#weSortLabel').textContent = weSort === 'az' ? 'A-Z' : 'Z-A'; weRenderRows(); });
        on('#weSaveBtn', 'click', () => weSave(false));
        on('#weToAdd', 'click', weOpenAdd);
        on('#weToPaste', 'click', weOpenPaste);
        on('#weDraftEn', 'input', (e) => { weDraft.en = e.target.value; weCheckDraft(); });
        on('#weDraftEn', 'keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); let z = document.querySelector('#weDraftMeans .we-input'); if (z) z.focus(); } });
        on('#weDraftStar', 'click', () => { weDraft.star = !weDraft.star; weRenderDraft(); });
        on('#weAddMean', 'click', () => { weDraft.means.push({ zh: '', pos: [] }); weRenderDraft(); let ins = document.querySelectorAll('#weDraftMeans .we-input'); ins[ins.length - 1].focus(); });
        on('#weAddConfirm', 'click', weConfirmDraft);
        on('#weDelBtn', 'click', weDeleteDraft);
        on('#wePasteBox', 'input', weCheckPaste);
        on('#wePasteConfirm', 'click', weConfirmPaste);
        document.querySelectorAll('#editorDetailView .js-cancel').forEach(b => b.addEventListener('click', () => { weEditAt = -1; weSetMode('list'); }));
        document.addEventListener('click', (e) => { let m = we$('#wePosMenu'); if (m && !m.hidden && !m.contains(e.target)) weClosePos(); });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') weClosePos(); });
    })();

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
        if (!wordLists[idx] || isPackList(wordLists[idx])) return;
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
            let cardHtml = pickRowHTML(list, count, isSelected, 'togglePracticeCard');
            grid.insertAdjacentHTML('beforeend', cardHtml);
        });
        loadPracticeSelectedContent();
    }

    // ── 選題庫頁共用：每一列、精選／自訂切換、已選幾本、全選 ──
    function pickRowHTML(list, count, isSelected, fn) {
        let pack = isPackList(list);
        {                                    // 新版練習／測驗／大冒險開始頁：一列 = 題庫名稱＋字數，選到的右邊打勾
            return `<div class="select-card cp-book ${isSelected}" role="button" tabindex="0" data-kind="${pack ? 'pack' : 'custom'}" data-on-click='[["${fn}",[${list.originalIdx},"$this"]]]'>
                    <span class="cp-book__text"><span class="cp-book__name">${pack ? packIconHTML(list.pack, 20) : ''}${escapeHTML(list.title)}</span><span class="cp-book__count">${count} 字</span></span>
                    <svg class="cp-book__check" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>
                </div>`;
        }
        return `<div class="select-card pk-row ${isSelected}" data-kind="${pack ? 'pack' : 'custom'}" data-on-click='[["${fn}",[${list.originalIdx},"$this"]]]'>
                    <div class="select-card-info">
                        <div class="select-card-title">${pack ? packIconHTML(list.pack, 20) + ' ' : ''}${escapeHTML(list.title)}</div>
                        <div class="select-card-count">${count} 字</div>
                    </div>
                    <div class="checkmark-badge">✓</div>
                </div>`;
    }
    let pickSeg = {};
    const PICK_STATS = { cardGrid: 'practiceStatsText', flashcardGrid: 'flashcardStatsText', cardExamGrid: 'cardExamStatsText', speakPracticeGrid: 'speakPracticeStatsText', examCardGrid: 'examStatsText' };
    function pickFns(gid) {
        return ({ cardGrid: [savePracticeSelectionState, loadPracticeSelectedContent], flashcardGrid: [saveFlashcardSelectionState, loadFlashcardSelectedContent],
                  cardExamGrid: [saveCardExamSelectionState, loadCardExamSelectedContent], speakPracticeGrid: [saveSpeakPracticeSelectionState, loadSpeakPracticeSelectedContent],
                  examCardGrid: [saveExamSelectionState, loadExamSelectedContent], advGrid: [advSyncSelFromGrid, advRenderLevelPage] })[gid];
    }
    // 大冒險：依畫面上勾選的列更新 advSelected（其他語言的題庫保留原本的選擇）
    function advSyncSelFromGrid() {
        let grid = document.getElementById('advGrid');
        if (!grid) return;
        let inGrid = [], on = [];
        grid.querySelectorAll('.select-card').forEach(c => {
            let m = (c.getAttribute('data-on-click') || '').match(/"toggleAdvCard",\[(\d+),/);
            if (!m) return;
            let i = parseInt(m[1]); inGrid.push(i); if (c.classList.contains('selected')) on.push(i);
        });
        advSelected = advSelected.filter(i => !inGrid.includes(i)).concat(on);
        try { localStorage.setItem(ADV_SEL_KEY, JSON.stringify(advSelected)); } catch (e) {}
    }
    function setPickSummary(statsId, gid, words, stars) {
        let grid = document.getElementById(gid);
        if (!grid) return;
        let rows = [...grid.querySelectorAll('.select-card')];
        let cnt = k => rows.filter(r => r.dataset.kind === k).length;
        let sel = k => rows.filter(r => r.dataset.kind === k && r.classList.contains('selected')).length;
        let cur = pickSeg[gid] || (cnt('custom') ? 'custom' : 'pack');
        grid.classList.toggle('seg-pack', cur === 'pack');
        grid.classList.toggle('seg-custom', cur === 'custom');
        let shown = rows.filter(r => r.dataset.kind === cur), lastRow = shown.length - (shown.length % 2 ? 1 : 2);
        shown.forEach((r, i) => { r.classList.toggle('pk-first', i === 0); r.classList.toggle('pk-odd', i % 2 === 0); r.classList.toggle('pk-bb', i < lastRow); r.classList.toggle('cp-l', i % 2 === 0 && i < shown.length - 1); r.classList.toggle('cp-last1', i === shown.length - 1); r.classList.toggle('cp-last2', i >= lastRow); });
        let seg = document.querySelector(`[data-grid="${gid}"]`);
        let badge = n => n ? `<em>已選 ${n}</em>` : '';
        if (seg && seg.classList.contains('cp-tabs')) {
            let cb = n => n ? ` <span class="cp-badge">已選 ${n}</span>` : '';
            seg.innerHTML = `<button class="cp-tab${cur === 'pack' ? ' is-active' : ''}" type="button"${cur === 'pack' ? ' aria-current="true"' : ''} data-on-click='[["setPickSeg",["${gid}","pack"]]]'>精選單字庫${cb(sel('pack'))}</button><button class="cp-tab${cur === 'custom' ? ' is-active' : ''}" type="button"${cur === 'custom' ? ' aria-current="true"' : ''} data-on-click='[["setPickSeg",["${gid}","custom"]]]'>自訂單字庫${cb(sel('custom'))}</button>`;
        } else if (seg) seg.innerHTML = `<button type="button" class="${cur === 'pack' ? 'on' : ''}" data-on-click='[["setPickSeg",["${gid}","pack"]]]'>精選單字庫${badge(sel('pack'))}</button><button type="button" class="${cur === 'custom' ? 'on' : ''}" data-on-click='[["setPickSeg",["${gid}","custom"]]]'>自訂單字庫${badge(sel('custom'))}</button>`;
        let empty = grid.querySelector('.pk-empty');
        if (!cnt(cur)) { if (!empty) grid.insertAdjacentHTML('beforeend', '<div class="pk-empty"></div>'); grid.querySelector('.pk-empty').textContent = cur === 'pack' ? '還沒有精選單字庫' : '還沒有放了單字的自訂題庫'; }
        else if (empty) empty.remove();
        let st = document.getElementById(statsId);
        if (st) st.innerHTML = `已選 <b>${sel('pack') + sel('custom')} 本</b>・<b>${words}</b> 字・星號 <b>${stars}</b> 個`;
    }
    function setPickSeg(gid, k) {
        pickSeg[gid] = k === 'pack' ? 'pack' : 'custom';
        let f = pickFns(gid); if (f) f[1]();
    }
    function pickSelectAll(gid) {
        let grid = document.getElementById(gid), f = pickFns(gid);
        if (!grid || !f) return;
        let cur = grid.classList.contains('seg-pack') ? 'pack' : 'custom';
        let rows = [...grid.querySelectorAll(`.select-card[data-kind="${cur}"]`)];
        let all = rows.length && rows.every(r => r.classList.contains('selected'));
        rows.forEach(r => r.classList.toggle('selected', !all));
        f[0](); f[1]();
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
        setPickSummary('practiceStatsText', 'cardGrid', totalWords, starCount);
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
            let cardHtml = pickRowHTML(list, count, isSelected, 'toggleFlashcardCard');
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
        setPickSummary('flashcardStatsText', 'flashcardGrid', allWords.length, starCount);
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

    // ═════════ 字卡練習（新版畫面；返回保留進度，開始頁可以繼續）═════════
    let fcBooks = '', fcSeen = new Set();
    // 單字太長（一個字、沒有空格）時把字縮小，讓它在一行內放得下
    function cpFitWord(el) {
        if (!el) return;
        el.style.fontSize = ''; el.style.whiteSpace = '';
        let t = el.textContent || '';
        if (/\s/.test(t.trim()) || !el.offsetParent) return;         // 片語可以換行；看不到的元素先不量
        el.style.whiteSpace = 'nowrap';
        let box = el.closest('.cp-panel') || el.parentElement;
        let cs = getComputedStyle(box), avail = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 8;
        let w = el.scrollWidth, fs = parseFloat(getComputedStyle(el).fontSize);
        if (w > avail && avail > 0) el.style.fontSize = Math.max(14, Math.floor(fs * avail / w)) + 'px';
    }
    window.addEventListener('resize', () => { ['fcCardEng', 'fcCardEngBack', 'lpEn'].forEach(id => { try { cpFitWord(document.getElementById(id)); } catch (e) {} }); });
    function startFlashcardSession(resume) {
        let words;
        if (resume && Array.isArray(resume.words)) {
            words = resume.words.map(l => parseWordsRaw(l)[0]).filter(Boolean);
            fcBooks = resume.books || '';
            fcSeen = new Set(resume.seen || []);
        } else {
            words = parseWordsRaw(document.getElementById('flashcardPreviewTextarea').value.trim());
            if (document.getElementById('fcSettingStarred').checked) words = words.filter(w => w.starred);
            if (document.getElementById('fcSettingShuffle').checked) words = words.sort(() => Math.random() - 0.5);
            fcBooks = cpSelectedTitles('flashcardGrid');
            fcSeen = new Set();
        }
        if (words.length === 0) { alert('⚠️ 範圍內沒有符合條件的單字，請重新勾選！'); return; }
        requestWakeLock();
        flashcardActiveList = words;
        currentFcIndex = resume ? Math.min(resume.idx || 0, words.length - 1) : 0;
        switchView('flashcardPlayView');
        document.body.classList.add('cp-tall');
        updateFlashcardView();
    }
    function fcSaveResume() {
        try {
            if (!flashcardActiveList.length) return;
            localStorage.setItem('chicky_flash_resume', JSON.stringify({ words: flashcardActiveList.map(w => w.rawLine), idx: currentFcIndex, books: fcBooks, ts: Date.now(), lang: getLearningLanguage(), seen: [...fcSeen].slice(0, 500) }));
        } catch (e) {}
    }
    function backToFlashcardSetup() {
        fcSaveResume();
        if (advPracDone()) return;
        releaseWakeLock();
        goToFlashcardPage();
    }
    function fcFinish() {
        try { localStorage.removeItem('chicky_flash_resume'); } catch (e) {}
        flashcardActiveList = [];
        if (advPracDone()) return;
        releaseWakeLock();
        goToFlashcardPage();
    }
    function fcFlip() {
        let el = document.getElementById('flashcardCardEl');
        if (!el) return;
        let f = el.classList.toggle('is-flipped');
        cpFitWord(document.getElementById(f ? 'fcCardEngBack' : 'fcCardEng'));
        el.setAttribute('aria-label', f ? '翻回英文' : '翻面看中文');
    }
    function resetFlashcardFlipState() {
        const cardEl = document.getElementById('flashcardCardEl');
        if (cardEl) { cardEl.classList.remove('is-flipped'); cardEl.setAttribute('aria-label', '翻面看中文'); }
    }
    function updateFlashcardView() {
        if (flashcardActiveList.length === 0) return;
        resetFlashcardFlipState();
        let card = flashcardActiveList[currentFcIndex], total = flashcardActiveList.length;
        fcSeen.add(String(card.english).toLowerCase());
        if (fcSeen.size >= 10) triggerTaskCheck('practice_done', { total: fcSeen.size });   // 同一場看過 10 張以上
        let set = (id, v, html) => { let el = document.getElementById(id); if (el) el[html ? 'innerHTML' : 'textContent'] = v; };
        set('fcBook', fcBooks ? `題庫 ${fcBooks}` : '題庫');
        set('fcFrontChip', getLearningLanguage() === 'ko' ? '韓文' : '英文');
        set('fcCardEng', card.english);
        set('fcCardEngBack', card.english);
        cpFitWord(document.getElementById('fcCardEng'));
        let senses = (card.senses && card.senses.length) ? card.senses : [{ m: card.meanings && card.meanings.length ? card.meanings : [card.chinese || '(無中文)'], p: card.posList || [] }];
        set('fcCardChi', senses.map(x => (x.m || []).join('、')).join(' ／ '));
        let pos = []; senses.forEach(x => (x.p || []).forEach(q => { if (pos.indexOf(q) === -1) pos.push(q); }));
        set('fcCardPos', pos.map(q => `<span class="cp-pos">${escapeHTML(q)}</span>`).join(''), true);
        set('fcProgressText', `${currentFcIndex + 1} <small>/ ${total}</small>`, true);
        let bar = document.getElementById('fcProgressBar'); if (bar) bar.style.width = ((currentFcIndex + 1) / total * 100) + '%';
        let starBtn = document.getElementById('fcStarBtn');
        if (starBtn) { starBtn.setAttribute('aria-pressed', card.starred ? 'true' : 'false'); starBtn.setAttribute('aria-label', card.starred ? '取消星號' : '加星號'); }
        let prevBtn = document.getElementById('fcPrevBtn'); if (prevBtn) prevBtn.disabled = currentFcIndex === 0;
        let last = currentFcIndex === total - 1;
        set('fcNextLabel', last ? '完成' : '下一張');
        let nb = document.getElementById('fcNextBtn'); if (nb) nb.setAttribute('aria-label', last ? '完成' : '下一張');
        fcSaveResume();
    }

    function nextFlashcard() {
        if (currentFcIndex < flashcardActiveList.length - 1) {
            currentFcIndex++;
            updateFlashcardView();
        } else {
            fcFinish();
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
            let cardHtml = pickRowHTML(list, count, isSelected, 'toggleCardExamCard');
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
        setPickSummary('cardExamStatsText', 'cardExamGrid', allWords.length, starCount);
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
            let cardHtml = pickRowHTML(list, count, isSelected, 'toggleSpeakPracticeCard');
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
        setPickSummary('speakPracticeStatsText', 'speakPracticeGrid', allWords.length, starCount);
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
        cardExamBuildPos(words);
        let bk = document.getElementById('cardExamBookName'); if (bk) bk.textContent = currentCardExamRanges ? `題庫 ${currentCardExamRanges}・測驗` : '';
        switchView('cardExamPlayView');
        qzFitViewport();
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

    // 詞性：只列出這次題目實際有出現的詞性（按鈕可複選，aria-pressed）
    const QZ_POS_ORDER = ['動詞', '名詞', '形容詞', '副詞', '連接詞', '介係詞', '片語', '代名詞', '感嘆詞'];
    const QZ_CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>';
    function cardPosOf(item) {
        let arr = (item.posList || (item.pos ? item.pos.split(/\s+/) : [])).map(x => normPos(String(x).trim())).filter(Boolean);
        return arr.filter((p, i) => arr.indexOf(p) === i);
    }
    function cardExamBuildPos(words) {
        let seen = new Set();
        words.forEach(w => cardPosOf(w).forEach(p => seen.add(p)));
        let list = QZ_POS_ORDER.filter(p => seen.has(p)).concat([...seen].filter(p => !QZ_POS_ORDER.includes(p)));
        let g = document.getElementById('cardExamPosCheckboxGroup');
        if (!g) return;
        g.innerHTML = list.map(p => `<button type="button" aria-pressed="false" data-pos="${escapeHTML(p)}">${QZ_CHECK}${escapeHTML(p)}</button>`).join('');
        if (!g._bound) {
            g._bound = true;
            g.addEventListener('pointerdown', e => { if (e.target.closest('button')) e.preventDefault(); });   // 點詞性時保留輸入框焦點 → 鍵盤不收起
            g.addEventListener('click', e => {
                let b = e.target.closest('button'); if (!b) return;
                b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
                cardExamEnterKey();
            });
        }
    }
    function cardExamHasPos() { return !!document.querySelector('#cardExamPosCheckboxGroup [aria-pressed="true"]'); }
    function cardExamNeedsPos() { let it = cardExamActiveList[currentCardExamIndex]; return !!(it && cardPosOf(it).length); }
    // 鍵盤右下角：已選詞性（或這題沒有詞性）顯示「送出」，還沒選顯示「下一步」
    function cardExamEnterKey() {
        let hint = (!cardExamNeedsPos() || cardExamHasPos()) ? 'send' : 'next';
        chiInputIds('cardExamInputChi').forEach(id => { let el = document.getElementById(id); if (el) el.setAttribute('enterkeyhint', hint); });
    }
    function quitCardExam() {
        if (confirm('要結束這次字卡測驗嗎？\n\n已經作答的題目會計分。')) finishCardExamSession();
    }
    let cardExamLocked = false;
    function playCurrentCardExamQuestion() {
        if (currentCardExamIndex >= cardExamActiveList.length) {
            finishCardExamSession();
            return;
        }
        cardExamLocked = false;
        let card = cardExamActiveList[currentCardExamIndex];
        let n = cardExamActiveList.length;
        let w = document.getElementById('cardExamCardEng');
        w.innerText = card.english;
        try { cpFitWord(w); } catch (e) {}
        document.getElementById('cardExamProgressText').innerHTML = `${currentCardExamIndex + 1} <small>/ ${n}</small>`;
        document.getElementById('cardExamProgressBar').style.width = `${((currentCardExamIndex + 1) / n * 100).toFixed(1)}%`;
        qzStatus('cardExamStatus', getLearningLanguage() === 'ko' ? '韓文' : '英文');

        voiceChiStop();
        setupChiInputs('cardExamInputChi', card);
        document.querySelectorAll('#cardExamPosCheckboxGroup button').forEach(b => b.setAttribute('aria-pressed', 'false'));
        let posField = document.getElementById('cardExamPosField');
        let anyPos = !!document.querySelector('#cardExamPosCheckboxGroup button');
        if (posField) posField.style.display = (anyPos && cardPosOf(card).length) ? '' : 'none';     // 這題沒有詞性：不用選
        cardExamEnterKey();
        try { document.getElementById('cardExamInputChi').focus({ preventScroll: true }); } catch (e) {}

        if (cardExamTimerId) clearInterval(cardExamTimerId);
        cardExamTimeLeft = parseInt(document.getElementById('cardExamAnswerTime').value) || 20;
        qzShow('cardExamTimer', true); qzTimer('cardExamTimer', cardExamTimeLeft);
        cardExamTimerId = setInterval(() => {
            cardExamTimeLeft--;
            qzTimer('cardExamTimer', Math.max(0, cardExamTimeLeft));
            if (cardExamTimeLeft <= 0) {
                clearInterval(cardExamTimerId);
                submitCardExamAnswer(true);
            }
        }, 1000);
    }

    function submitCardExamAnswer(timeUp) {
        if (cardExamLocked || currentCardExamIndex >= cardExamActiveList.length) return;
        // 還沒選詞性就送出：收起鍵盤、詞性那排搖一下提醒，不送出（時間到則直接送出）
        if (timeUp !== true && cardExamNeedsPos() && !cardExamHasPos()) {
            try { document.activeElement && document.activeElement.blur(); } catch (e) {}
            let g = document.getElementById('cardExamPosCheckboxGroup');
            if (g) { g.classList.remove('is-remind'); void g.offsetWidth; g.classList.add('is-remind'); }
            return;
        }
        cardExamLocked = true;
        if (cardExamTimerId) clearInterval(cardExamTimerId);
        let userChiArr = readChiInputs('cardExamInputChi');
        let userChi = userChiArr.filter(Boolean).join('、');
        let userPosArr = [];
        document.querySelectorAll('#cardExamPosCheckboxGroup [aria-pressed="true"]').forEach(b => userPosArr.push(normPos(b.dataset.pos.trim())));

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

        // 顯示對錯約 1 秒 → 自動換下一題（輸入框不 blur）
        qzShow('cardExamTimer', false);
        let ans = `${currentItem.senseText || currentItem.chinese || ''}${correctPosArr.length ? `（${correctPosArr.join('、')}）` : ''}`;
        qzStatus('cardExamStatus', isCorrect ? '✓ 答對了' : `✗ ${escapeHTML(ans)}`, isCorrect ? 'is-ok' : 'is-bad');
        currentCardExamIndex++;
        setTimeout(() => { if (document.getElementById('cardExamPlayView').classList.contains('active')) playCurrentCardExamQuestion(); }, 1000);
    }

    function handleCardExamKeyDown(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            submitCardExamAnswer();
        }
    }

    function finishCardExamSession() {
        if (cardExamTimerId) clearInterval(cardExamTimerId);
        cardExamLocked = true;
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
        cpRenderResume('speak');
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
    // 很短的單字，語音辨識常常寫成別的字：目標是左邊的字時，聽成右邊這些也算對（只有單向）
    const EN_SPEAK_ALIKE = {
        till: ['til', 'until', 'tell', 'teal', 'tilt', 'tilly', 'tele'],
        win: ['when', 'wing', 'wind', 'wins', 'wen', 'whin']
    };
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
        if (tt.length === 1 && ht.length === 1 && (EN_SPEAK_ALIKE[ts] || []).includes(hs)) return 90;
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
        el.textContent = text || '';
        el.classList.toggle('warn', !!warn);
        let panel = document.getElementById('speakPanel');
        if (panel) panel.classList.toggle('sp-has-msg', !!text);
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

    async function startSpeakPracticeSession(resume) {
        if (speakStarting) return;
        let words;
        if (resume && Array.isArray(resume.words)) {
            words = resume.words.map(l => parseWordsRaw(l)[0]).filter(Boolean);
        } else {
            resume = null;
            let text = document.getElementById('speakPracticePreviewTextarea').value.trim();
            words = parseWordsRaw(text);
            if (document.getElementById('speakPracticeSettingStarred').checked) words = words.filter(w => w.starred);
            for (let i = words.length - 1; i > 0; i--) {
                let j = Math.floor(Math.random() * (i + 1));
                [words[i], words[j]] = [words[j], words[i]];
            }
            let qCount = parseInt(document.getElementById('speakPracticeQuestionCount').value) || 0;
            if (qCount > 0 && words.length > qCount) words = words.slice(0, qCount);
        }
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
        currentSpeakPracticeIndex = resume ? Math.min(resume.idx || 0, words.length - 1) : 0;
        speakPracticeResults = resume && Array.isArray(resume.results) ? resume.results.slice(0, currentSpeakPracticeIndex) : [];
        speakBooks = resume ? (resume.books || '') : cpSelectedTitles('speakPracticeGrid');
        speakSaveResume();
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
        cpRenderResume('speak');
    }
    // 左上返回：離開並保留進度（下次在開始頁可以「繼續練習」）
    function leaveSpeakPractice() {
        abortSpeakListening();
        speakSaveResume();
        backToSpeakPracticeSetup();
    }
    const SPEAK_RESUME_KEY = 'chicky_speak_resume';
    function speakSaveResume() {
        try {
            if (!speakPracticeActiveList.length || currentSpeakPracticeIndex >= speakPracticeActiveList.length) { localStorage.removeItem(SPEAK_RESUME_KEY); return; }
            localStorage.setItem(SPEAK_RESUME_KEY, JSON.stringify({ words: speakPracticeActiveList.map(w => w.rawLine), idx: currentSpeakPracticeIndex, results: speakPracticeResults.slice(0, 500), books: speakBooks, ts: Date.now(), lang: getLearningLanguage() }));
        } catch (e) {}
    }
    function setSpeakState(st) {
        let v = document.getElementById('speakPracticePlayView');
        if (v) v.dataset.state = st;
        let b = document.getElementById('speakMicBtn');
        if (b) b.setAttribute('aria-label', st === 'rec' ? '放開送出' : st === 'done' ? '再唸一次' : '按住朗讀');
    }

    function updateSpeakNextBtn() {
        let isLast = currentSpeakPracticeIndex >= speakPracticeActiveList.length - 1;
        let lb = document.getElementById('speakNextLabel');
        if (lb) lb.textContent = isLast ? '完成' : '下一個';
        let btn = document.getElementById('speakPracticeNextBtn');
        if (btn) btn.setAttribute('aria-label', isLast ? '完成' : '下一個');
    }

    function showSpeakPracticeQuestion() {
        if (currentSpeakPracticeIndex >= speakPracticeActiveList.length) {
            finishSpeakPracticeSession();
            return;
        }
        let card = speakPracticeActiveList[currentSpeakPracticeIndex], total = speakPracticeActiveList.length;
        let set = (id, v, html) => { let el = document.getElementById(id); if (el) el[html ? 'innerHTML' : 'textContent'] = v; };
        set('speakBook', speakBooks ? `題庫 ${speakBooks}` : '題庫');
        set('speakPracticeCardEng', card.english);
        let senses = (card.senses && card.senses.length) ? card.senses : [{ m: card.meanings && card.meanings.length ? card.meanings : [card.chinese || ''], p: card.posList || [] }];
        set('speakPracticeCardChi', senses.map(x => (x.m || []).join('、')).join(' ／ '));
        let pos = []; senses.forEach(x => (x.p || []).forEach(q => { if (pos.indexOf(q) === -1) pos.push(q); }));
        set('speakPracticeCardPos', pos.map(q => `<span class="cp-pos">${escapeHTML(q)}</span>`).join(''), true);
        set('speakPracticeProgressText', `${currentSpeakPracticeIndex + 1} <small>/ ${total}</small>`, true);
        let bar = document.getElementById('speakPracticeProgressBar'); if (bar) bar.style.width = ((currentSpeakPracticeIndex + 1) / total * 100) + '%';
        try { cpFitWord(document.getElementById('speakPracticeCardEng')); } catch (e) {}

        speakQuestion = { attempts: 0, best: null, last: null };
        speakClearRecording();
        setSpeakState('idle');
        let env = getBrowserEnv();
        let note = (currentSpeakPracticeIndex === 0 && env.isIOS && env.standalone) ? '主畫面模式的語音辨識可能無法使用，沒反應請改用 Safari 開啟' : '';
        setSpeakHint(note, !!note);
        updateSpeakNextBtn();
    }

    function renderSpeakResult() {
        let r = speakQuestion.last, best = speakQuestion.best;
        if (!r) return;
        let pass = r.score >= getSpeakPassScore();
        let set = (id, v) => { let el = document.getElementById(id); if (el) el.textContent = v; };
        set('speakScoreLabel', pass ? '很棒！' : '再試試看・');
        set('speakScore', r.score);
        let chip = document.getElementById('speakScoreChip'); if (chip) chip.classList.toggle('is-fail', !pass);
        setSpeakState('done');
        setSpeakHint(`辨識到：${r.heard || '(沒有內容)'}`);
    }

    function abortSpeakListening() {
        speakIgnoreResult = true;
        clearTimeout(speakWatchdog);
        if (speakRec && speakListening) { try { speakRec.abort(); } catch (e) {} }
        speakListening = false;
        speakStopRecording(true);
        let v = document.getElementById('speakPracticePlayView');
        if (v && v.dataset.state === 'rec') setSpeakState(speakQuestion.last ? 'done' : 'idle');
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
        // 按住期間持續收音（continuous），放開才結束：單音節的短字（win、切）不會因為瀏覽器太早判定「說完了」而沒有結果
        rec.continuous = true;
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
        setSpeakState('rec');
        setSpeakHint('');
        try {
            rec.start();
            speakStartRecording();
        } catch (e) {
            speakListening = false;
            setSpeakState(speakQuestion.last ? 'done' : 'idle');
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
        // 再多收一小段，避免單字最後一個音被切掉（切掉會被辨識成別的字）
        setSpeakHint('收音中…');
        setTimeout(() => { speakStopRecording(); if (speakRec === rec && speakListening) { try { rec.stop(); } catch (e) {} } }, tailMs);
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
        speakStopRecording();
        setSpeakState(speakQuestion.last ? 'done' : 'idle');
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
    }

    // ── 聽我的錄音：只在電腦版開（手機上同時錄音＋語音辨識會搶麥克風，iPhone / Android 容易讓辨識失敗）──
    function speakCanRecord() {
        let env = getBrowserEnv();
        return !env.isIOS && !env.isAndroid && !!window.MediaRecorder && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && location.protocol !== 'file:';
    }
    function speakClearRecording() {
        speakStopRecording(true);
        if (speakRecUrl) { try { URL.revokeObjectURL(speakRecUrl); } catch (e) {} speakRecUrl = ''; }
        let b = document.getElementById('speakReplayBtn'); if (b) b.hidden = true;
    }
    function speakStartRecording() {
        if (!speakCanRecord()) return;
        speakStopRecording(true);
        speakRecChunks = [];
        navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
            if (!speakListening) { stream.getTracks().forEach(t => t.stop()); return; }
            speakRecStream = stream;
            let mr = new MediaRecorder(stream);
            mr.ondataavailable = e => { if (e.data && e.data.size) speakRecChunks.push(e.data); };
            mr.onstop = () => {
                stream.getTracks().forEach(t => t.stop());
                if (mr._discard || !speakRecChunks.length) return;
                if (speakRecUrl) { try { URL.revokeObjectURL(speakRecUrl); } catch (e) {} }
                speakRecUrl = URL.createObjectURL(new Blob(speakRecChunks, { type: mr.mimeType || 'audio/webm' }));
                let b = document.getElementById('speakReplayBtn'); if (b) b.hidden = false;
            };
            speakRecorder = mr;
            mr.start();
        }).catch(() => {});
    }
    function speakStopRecording(discard) {
        let mr = speakRecorder; speakRecorder = null;
        if (mr) { mr._discard = !!discard; try { if (mr.state !== 'inactive') mr.stop(); } catch (e) {} }
        else if (speakRecStream) { speakRecStream.getTracks().forEach(t => t.stop()); }
        speakRecStream = null;
    }
    function playSpeakMyRecording() {
        if (!speakRecUrl) return;
        try { window.speechSynthesis.cancel(); } catch (e) {}
        try { new Audio(speakRecUrl).play(); } catch (e) {}
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
        // 電腦版：在朗讀頁任何地方按住空白鍵 = 按住麥克風
        const onPage = () => { let v = document.getElementById('speakPracticePlayView'); return v && v.classList.contains('active'); };
        const typing = (e) => { let t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable); };
        let spaceDown = false;
        document.addEventListener('keydown', (e) => {
            if (e.key !== ' ' || !onPage() || typing(e)) return;
            e.preventDefault();
            if (e.repeat || spaceDown) return;
            spaceDown = true; down();
        });
        document.addEventListener('keyup', (e) => {
            if (e.key !== ' ' || !spaceDown) return;
            e.preventDefault(); spaceDown = false; up();
        });
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
        if (speakPracticeResults.length >= 10) triggerTaskCheck('practice_done', { total: speakPracticeResults.length });   // 每日任務：朗讀練習 10 題
    }

    function nextSpeakPracticeQuestion() {
        abortSpeakListening();
        if (currentSpeakPracticeIndex >= speakPracticeActiveList.length) return;
        pushCurrentSpeakResult();
        currentSpeakPracticeIndex++;
        speakSaveResume();
        showSpeakPracticeQuestion();
    }

    function finishSpeakPracticeSession() {
        abortSpeakListening();
        releaseWakeLock();
        try { localStorage.removeItem(SPEAK_RESUME_KEY); } catch (e) {}
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
                let firstChiIndex = meaningStart(cleanLine);
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
            let cardHtml = pickRowHTML(list, count, isSelected, 'toggleExamCard');
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
        setPickSummary('examStatsText', 'examCardGrid', totalWords, starCount);
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
        if (isPackList(list)) {
            let stars = (list.content || '').split('\n').filter(l => l.trim().startsWith('*')).length;
            el.innerHTML = `${count} 字・<span class="star">★</span> ${stars}`;
            el.classList.remove('is-full', 'is-near');
            el.title = '';
            return;
        }
        el.innerHTML = `<b>${count}</b> / ${cap} 字`;
        el.classList.toggle('is-full', count >= cap);
        el.classList.toggle('is-near', count < cap && count >= cap * 0.9);
        el.title = count >= cap
            ? '已達單字上限，可到「雞塊補給站」兌換單字上限 +50'
            : `還可以再放 ${cap - count} 個單字`;
    }

    // ── 單字編輯頁的搜尋：打字時只列出找到的單字；點一列就回到那一行 ──
    function editorBackdropPlain() {
        let ta = document.getElementById('editorWordList'), bd = document.getElementById('editorBackdrop');
        if (ta && bd) bd.innerHTML = escapeHTML(ta.value);
        syncEditorScroll();
    }
    function editorSearchHL(s, q) {
        let i = s.toLowerCase().indexOf(q.toLowerCase());
        if (i < 0) return escapeHTML(s);
        return escapeHTML(s.slice(0, i)) + '<span class="hit">' + escapeHTML(s.slice(i, i + q.length)) + '</span>' + escapeHTML(s.slice(i + q.length));
    }
    function editorWordRowHTML(line, q) {
        let starred = line.trim().startsWith('*'), clean = line.trim().replace(/^\*\s*/, '');
        let fi = getForeignPart(clean).length, en = clean.slice(0, fi).trim(), rest = clean.slice(fi).trim();
        return `${starred ? '<span class="star">*</span>' : ''}<b>${q ? editorSearchHL(en, q) : escapeHTML(en)}</b> <span class="mut">${q ? editorSearchHL(rest, q) : escapeHTML(rest)}</span>`;
    }
    function handleEditorSearch() {
        updateEditorWordCounter();
        const ta = document.getElementById('editorWordList');
        const input = document.getElementById('wordSearchInput');
        const res = document.getElementById('edSearchResults'), main = document.getElementById('edMain');
        if (!ta || !input || !res || !main) return;
        editorBackdropPlain();
        const q = input.value.trim();
        document.getElementById('edSearchBox').classList.toggle('has-q', !!q);
        const pack = document.getElementById('editorDetailView').classList.contains('ed-pack');
        if (pack) {           // 精選單字庫：直接篩選下面的星號清單
            res.style.display = 'none'; main.style.display = '';
            let n = 0;
            document.querySelectorAll('#packStarList .ed-srow').forEach(r => {
                let on = !q || r.getAttribute('data-text').toLowerCase().includes(q.toLowerCase());
                r.style.display = on ? '' : 'none'; if (on) n++;
            });
            let empty = document.getElementById('packStarEmpty');
            if (empty) { empty.style.display = q && !n ? '' : 'none'; empty.textContent = `找不到「${q}」`; }
            return;
        }
        if (!q) { res.style.display = 'none'; main.style.display = ''; return; }
        let hits = [];
        ta.value.split('\n').forEach((line, i) => { if (line.trim() && line.toLowerCase().includes(q.toLowerCase())) hits.push(i); });
        main.style.display = 'none'; res.style.display = '';
        if (!hits.length) { res.innerHTML = `<div class="ed-empty">找不到「${escapeHTML(q)}」</div>`; return; }
        let lines = ta.value.split('\n');
        res.innerHTML = `<div class="ed-found">找到 <b>${hits.length}</b> 個</div><div class="ed-list">${hits.map(i =>
            `<div class="ed-row" data-on-click='[["jumpToEditorLine",[${i}]]]'><span class="t">${editorWordRowHTML(lines[i], q)}</span><span class="ar">›</span></div>`).join('')}</div>`;
    }
    function clearEditorSearch() {
        let input = document.getElementById('wordSearchInput');
        if (input) input.value = '';
        handleEditorSearch();
    }
    // 點搜尋結果：回到完整的編輯框，捲到那一行並選起來
    function jumpToEditorLine(i) {
        i = parseInt(i) || 0;
        clearEditorSearch();
        let ta = document.getElementById('editorWordList');
        if (!ta) return;
        let lines = ta.value.split('\n'), start = 0;
        for (let k = 0; k < i && k < lines.length; k++) start += lines[k].length + 1;
        let lh = parseFloat(getComputedStyle(ta).lineHeight) || 22;
        try { ta.focus({ preventScroll: true }); } catch (e) { ta.focus(); }
        ta.setSelectionRange(start, start + (lines[i] || '').length);
        ta.scrollTop = Math.max(0, (i - 1) * lh);
        syncEditorScroll();
    }
    let editorSortDir = 'az';
    function toggleEditorSort() {
        sortEditorContent(editorSortDir);
        editorSortDir = editorSortDir === 'az' ? 'za' : 'az';
        let b = document.getElementById('edSortBtn');
        if (b) b.textContent = (editorSortDir === 'az' ? 'A-Z' : 'Z-A') + ' ⇅';
    }
    // ── 精選單字庫：不能編輯，只能點單字加／取消星號 ──
    function renderPackStarList() {
        let box = document.getElementById('packStarList'), list = wordLists[lastSelectedList];
        if (!box || !list) return;
        let lines = (list.content || '').split('\n');
        box.innerHTML = `<div class="ed-list">${lines.map((line, i) => line.trim() ? `<div class="ed-srow${line.trim().startsWith('*') ? ' on' : ''}" data-line="${i}" data-text="${escapeHTML(line.replace(/^\s*\*\s*/, ''))}" data-on-click='[["togglePackStar",[${i}]]]'><span class="st">${line.trim().startsWith('*') ? '★' : '☆'}</span><span class="t">${editorWordRowHTML(line.replace(/^\s*\*\s*/, ''), '')}</span></div>` : '').join('')}</div><div class="ed-empty" id="packStarEmpty" style="display:none"></div>`;
    }
    function togglePackStar(i) {
        let list = wordLists[lastSelectedList];
        if (!list || !isPackList(list)) return;
        i = parseInt(i);
        let lines = (list.content || '').split('\n');
        if (!lines[i] || !lines[i].trim()) return;
        let on = lines[i].trim().startsWith('*');
        lines[i] = on ? lines[i].replace(/^\s*\*\s*/, '') : '*' + lines[i].trim();
        list.content = lines.join('\n');
        document.getElementById('editorWordList').value = list.content;
        localStorage.setItem('dictation_word_lists', JSON.stringify(wordLists));
        triggerAutoSaveToCloud();
        refreshListViewsSoon();
        let row = document.querySelector(`#packStarList .ed-srow[data-line="${i}"]`);
        if (row) { row.classList.toggle('on', !on); row.querySelector('.st').textContent = on ? '☆' : '★'; }
        updateEditorWordCounter();
    }
    function refreshListViewsSoon() { clearTimeout(refreshListViewsSoon.t); refreshListViewsSoon.t = setTimeout(() => { try { refreshAllListViews(); } catch (e) {} }, 300); }

    function saveAndStayInEditor() {
        handleEditorTextareaInput();
        let idx = lastSelectedList;
        if (!wordLists[idx] || isPackList(wordLists[idx])) return;

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
            let firstChiIndex = meaningStart(cleanLine);
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

    // 單字開頭的大寫 I 改成小寫（大寫 I 跟小寫 l 分不出來）；I 本身、IT 這類縮寫不改
    function lowerLeadingI(w) { return String(w || '').replace(/^I(?=[a-z])/, 'i'); }
    function parseWordsRaw(text) {
        let lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        let allWords = [], seen = new Set();
        lines.forEach((line) => {
            let isStarred = line.startsWith('*');
            let cleanLine = isStarred ? line.substring(1).trim() : line;
            let firstChiIndex = meaningStart(cleanLine);
            let engPart = firstChiIndex !== -1 ? cleanLine.substring(0, firstChiIndex).trim() : cleanLine.trim();
            let restPart = firstChiIndex !== -1 ? cleanLine.substring(firstChiIndex).trim() : "";
            let pm = parseMeaningPart(restPart);
            let key = engPart.toLowerCase();
            if (key && !seen.has(key)) {
                seen.add(key);
                allWords.push({
                    english: lowerLeadingI(engPart),     // Island → island：大寫 I 跟小寫 l 太像
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
    // 中文數字、全形數字都換成阿拉伯數字（「十月」和「10月」算同一個答案）
    const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    const CN_UNIT = { 十: 10, 百: 100, 千: 1000 };
    function cnNumRun(run) {
        if (!/[十百千]/.test(run)) return run.split('').map(c => CN_DIGIT[c]).join('');   // 一二三 → 123（像「二〇二六」）
        let total = 0, cur = 0;
        for (const c of run) {
            if (c in CN_DIGIT) cur = CN_DIGIT[c];
            else { total += (cur || 1) * CN_UNIT[c]; cur = 0; }
        }
        return String(total + cur);
    }
    function cnDigits(s) {
        return String(s || '').replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
            .replace(/[零〇一二兩三四五六七八九十百千]+/g, cnNumRun);
    }
    function chiNorm(s) { return cnDigits(String(s || '').normalize('NFC').replace(/[（(][^）)]*[）)]/g, '').replace(/[\s　，,、；;。.！!？?\/／…~～]/g, '')); }
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

    // ═════════ 聽力練習（新版畫面：開始頁＋練習頁，返回會保留進度）═════════
    // 播放用「場次編號」把每一輪播放綁在一起：按暫停、返回、重新開始時編號 +1，
    // 舊的那一輪（包括還在排隊的 setTimeout、被 cancel 後才觸發的 onend）一看到編號不同就直接停下，
    // 這樣快速「暫停 → 繼續」也不會有兩段語音同時播放。
    const LP_RESUME_KEY = 'chicky_listen_resume';
    let lpGen = 0, lpGapTimer = null, lpRepeatNow = 1, lpBooks = '', lpDoneCount = 0;
    function lpKill() {                       // 停掉目前所有的播放與排程
        lpGen++;
        clearTimeout(timeoutId); clearTimeout(lpGapTimer);
        try { synth.cancel(); } catch (e) {}
    }
    function toggleDictation() { isPlaying ? stopDictation() : checkAndStartDictation(); }
    function checkAndStartDictation() {
        let words = parseWordsRaw(document.getElementById('wordList').value.trim());
        if (words.length === 0) { alert("⚠️ 目前勾選的範圍單字數為 0，無法開始聽力練習！請至題庫新增單字。"); return; }
        startDictation();
    }
    function cpSelectedTitles(gridId) {
        return [...document.querySelectorAll(`#${gridId} .select-card.selected`)].map(c => {
            let m = (c.getAttribute('data-on-click') || '').match(/\[(\d+),/);
            return m && wordLists[parseInt(m[1])] ? wordLists[parseInt(m[1])].title : '';
        }).filter(Boolean).join('、');
    }
    function lpShowPart(play) {
        let s = document.getElementById('lpSetupPart'), p = document.getElementById('lpPlayPart');
        if (s) s.hidden = !!play;
        if (p) p.hidden = !play;
        let v = document.getElementById('practiceView');
        if (v) { v.classList.toggle('cp-playing', !!play); v.classList.remove('is-paused'); v.classList.remove('is-done'); }
        let st = document.getElementById('lpStatus'); if (st) st.textContent = '正在朗讀';
        document.body.classList.toggle('cp-tall', !!play);
        window.scrollTo(0, 0);
    }
    function startDictation(resume) {
        lpKill();
        if (resume) {
            wordsData = resume.words.map(l => parseWordsRaw(l)[0]).filter(Boolean);
            currentWordIndex = Math.min(resume.idx || 0, Math.max(0, wordsData.length - 1));
            lpBooks = resume.books || '';
            lpDoneCount = resume.done || 0;
        } else {
            wordsData = parseWordsRaw(document.getElementById('wordList').value.trim());
            if (document.getElementById('onlyStarred').checked) wordsData = wordsData.filter(w => w.starred);
            if (document.getElementById('enableShuffle').checked) wordsData = wordsData.sort(() => Math.random() - 0.5);
            currentWordIndex = 0;
            lpBooks = cpSelectedTitles('cardGrid');
            lpDoneCount = 0;
        }
        if (wordsData.length === 0) { alert('找不到有效單字或無符合條件的單字！'); return; }
        requestWakeLock();
        isPlaying = true; isPaused = false;
        lpShowPart(true);
        playNextWord();
    }
    function lpRepeatTarget() { let n = parseInt(document.getElementById('repeatCount').value) || 1; return Math.max(1, n); }
    function lpRender(item, rep) {
        let total = wordsData.length, n = Math.min(currentWordIndex + 1, total), target = lpRepeatTarget();
        let set = (id, v, html) => { let el = document.getElementById(id); if (el) el[html ? 'innerHTML' : 'textContent'] = v; };
        set('lpBook', lpBooks ? `題庫 ${lpBooks}` : '題庫');
        let loop = document.getElementById('lpLoop'); if (loop) loop.hidden = !document.getElementById('enableLoop').checked;
        set('lpCount', `${n} <small>/ ${total}</small>`, true);
        let fill = document.getElementById('lpFill'); if (fill) fill.style.width = (n / total * 100) + '%';
        if (item) {
            set('lpEn', item.english);
            cpFitWord(document.getElementById('lpEn'));
            let senses = (item.senses && item.senses.length) ? item.senses : [{ m: item.meanings || [item.chinese], p: item.posList || [] }];
            set('lpMeaning', senses.map(s => `<span class="cp-meaning__zh">${escapeHTML((s.m || []).join('、'))}</span>${(s.p || []).map(p => `<span class="cp-pos">${escapeHTML(p)}</span>`).join('')}`).join(''), true);
        }
        let r = Math.min(rep || 1, target);
        set('lpDots', Array.from({ length: target }, (_, i) => `<span${i < r ? ' class="is-on"' : ''}></span>`).join(''), true);
        set('lpRepNum', `${r}/${target}`);
    }
    function lpSaveResume() {
        try {
            if (!wordsData.length || currentWordIndex >= wordsData.length) { localStorage.removeItem(LP_RESUME_KEY); return; }
            localStorage.setItem(LP_RESUME_KEY, JSON.stringify({ words: wordsData.map(w => w.rawLine), idx: currentWordIndex, books: lpBooks, ts: Date.now(), lang: getLearningLanguage(), done: lpDoneCount }));
        } catch (e) {}
    }
    function lpNoteDone() {                   // 每聽完一個字算一題；同一場累積 10 題就完成每日任務
        lpDoneCount++;
        if (lpDoneCount >= 10) triggerTaskCheck('practice_done', { total: lpDoneCount });
    }
    function playNextWord() {
        if (!isPlaying || isPaused) return;
        if (currentWordIndex >= wordsData.length) {
            if (document.getElementById('enableLoop').checked) currentWordIndex = 0;
            else { lpFinish(); return; }
        }
        let gen = lpGen;
        let item = wordsData[currentWordIndex];
        let rate = parseFloat(document.getElementById('speakRate').value) || 0.8;
        let targetRepeat = lpRepeatTarget();
        lpRender(item, 1);
        let queue = [];
        for (let r = 1; r <= targetRepeat; r++) queue.push({ text: item.english, isEng: true, onPlay: () => lpRender(null, r) });
        if (document.getElementById('enableSpell').checked && item.english) {
            let letters = (getLearningLanguage() === 'ko')
                ? Array.from(item.english.replace(/\s+/g, '')).join(' - ')
                : item.english.replace(/[^a-zA-Z]/g, '').toLowerCase().split('').join(' - ');
            if (letters) queue.push({ text: letters, isEng: true });
        }
        let sayChi = document.getElementById('enableChinese').checked && item.chinese;
        let sayPos = document.getElementById('enablePOS').checked && item.pos;
        if (sayChi && sayPos && item.senses && item.senses.length > 1) {
            item.senses.forEach(s => { let t = [s.m.join('，'), s.p.join('，')].filter(Boolean).join('，'); if (t) queue.push({ text: t, isEng: false }); });
        } else {
            if (sayChi) queue.push({ text: (item.meanings && item.meanings.length ? item.meanings.join('，') : item.chinese), isEng: false });
            if (sayPos) queue.push({ text: item.pos, isEng: false });
        }
        playQueue(queue, rate, () => {
            if (gen !== lpGen || !isPlaying || isPaused) return;
            currentWordIndex++;
            lpNoteDone();
            lpSaveResume();
            let pauseSec = parseInt(document.getElementById('pauseTime').value);
            if (isNaN(pauseSec)) pauseSec = 2;
            timeoutId = setTimeout(() => { if (gen === lpGen) playNextWord(); }, pauseSec * 1000);
        }, gen);
    }
    function playQueue(queueItems, rate, onComplete, gen) {
        if (gen === undefined) gen = lpGen;
        if (gen !== lpGen || !isPlaying || isPaused) return;     // 這一輪已經被暫停／取消
        if (queueItems.length === 0) { if (onComplete) onComplete(); return; }
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
        utterance.volume = Math.max(0, Math.min(1.0, (parseInt(sysVol) || 100) / 100));
        let ended = false;
        utterance.onend = utterance.onerror = () => {
            if (ended) return; ended = true;
            if (gen !== lpGen || !isPlaying || isPaused) return;
            clearTimeout(lpGapTimer);
            lpGapTimer = setTimeout(() => playQueue(queueItems, rate, onComplete, gen), 1000);
        };
        synth.speak(utterance);
    }
    function lpFinish() {
        lpKill();
        isPlaying = false; isPaused = false;
        try { localStorage.removeItem(LP_RESUME_KEY); } catch (e) {}
        releaseWakeLock();
        let st = document.getElementById('lpStatus'); if (st) st.textContent = '🎉 練習結束！';
        let v = document.getElementById('practiceView'); if (v) v.classList.add('is-done');
        setTimeout(() => { if (!isPlaying && document.getElementById('practiceView').classList.contains('active')) { lpShowPart(false); cpRenderResume('listen'); } }, 1600);
    }
    // 停止（離開頁面時呼叫）：停掉語音；練習中的進度會保留
    function stopDictation() {
        if (isPlaying) lpSaveResume();
        lpKill();
        isPlaying = false; isPaused = false;
        releaseWakeLock();
        lpShowPart(false);
        cpRenderResume('listen');
    }
    // 練習頁左上角返回：保留進度，回到開始頁
    function lpBack() {
        if (advPracDone && advPrac) { stopDictation(); advPracDone(); return; }
        stopDictation();
    }
    function lpTogglePause() {
        let v = document.getElementById('practiceView'), btn = document.getElementById('lpPlayBtn');
        if (!isPlaying) return;
        if (!isPaused) {
            isPaused = true; lpKill();
            lpSaveResume();
            if (v) v.classList.add('is-paused');
            if (btn) btn.setAttribute('aria-label', '繼續');
        } else {
            lpKill();                         // 保險：繼續前再清一次，確保不會有上一輪殘留
            isPaused = false;
            if (v) v.classList.remove('is-paused');
            if (btn) btn.setAttribute('aria-label', '暫停');
            playNextWord();
        }
    }
    function togglePauseDictation() { lpTogglePause(); }

    // ── 開始頁：繼續練習卡片、開始新練習（有未完成紀錄時先確認）──
    const CP_RESUME_KEYS = { listen: LP_RESUME_KEY, flash: 'chicky_flash_resume', speak: 'chicky_speak_resume' };
    function cpGetResume(kind) {
        try {
            let r = JSON.parse(localStorage.getItem(CP_RESUME_KEYS[kind]));
            if (r && Array.isArray(r.words) && r.words.length && r.idx < r.words.length && (r.lang || 'en') === getLearningLanguage()) return r;
        } catch (e) {}
        return null;
    }
    function cpAgo(ts) {
        let m = Math.max(0, Math.round((Date.now() - (ts || 0)) / 60000));
        if (m < 1) return '剛剛';
        if (m < 60) return `${m} 分鐘前`;
        let h = Math.round(m / 60); if (h < 24) return `${h} 小時前`;
        return `${Math.round(h / 24)} 天前`;
    }
    function cpRenderResume(kind) {
        let card = document.getElementById(kind + 'ResumeCard'), btn = document.getElementById(kind === 'listen' ? 'lpStartBtn' : kind === 'speak' ? 'spStartBtn' : 'fcStartBtn');
        if (!card || !btn) return;
        let r = cpGetResume(kind);
        card.hidden = !r;
        let PLUS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
        let PLAY = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4v16a1 1 0 001.5.86l13-8a1 1 0 000-1.72l-13-8A1 1 0 006 4z"/></svg>';
        if (r) {
            let done = kind === 'flash' ? r.idx + 1 : r.idx, total = r.words.length;
            document.getElementById(kind + 'ResumeTime').textContent = cpAgo(r.ts);
            document.getElementById(kind + 'ResumeBooks').textContent = r.books || '';
            document.getElementById(kind + 'ResumeFill').style.width = (done / total * 100) + '%';
            document.getElementById(kind + 'ResumeCount').innerHTML = `${done} <small>/ ${total} 個</small>`;
            btn.className = 'cp-btn cp-btn--secondary';
            btn.innerHTML = PLUS + '開始新練習';
        } else {
            btn.className = 'cp-btn cp-btn--primary';
            btn.innerHTML = PLAY + btn.getAttribute('data-cp-text');
        }
    }
    function cpResume(kind) {
        let r = cpGetResume(kind);
        if (!r) { cpRenderResume(kind); return; }
        if (kind === 'listen') startDictation(r); else if (kind === 'speak') startSpeakPracticeSession(r); else startFlashcardSession(r);
    }
    let cpConfirmKind = '';
    function cpAskNew(kind) {
        let r = cpGetResume(kind);
        if (!r) { if (kind === 'listen') checkAndStartDictation(); else if (kind === 'speak') startSpeakPracticeSession(); else startFlashcardSession(); return; }
        cpConfirmKind = kind;
        let done = kind === 'flash' ? r.idx + 1 : r.idx;
        document.getElementById('cpConfirmText').innerHTML = `上次 <b>${escapeHTML(r.books || '這次的範圍')}</b> 練到 <b class="cp-hl">${done} / ${r.words.length}</b> 個還沒完成，<br>開始新練習會取代這筆進度。`;
        document.getElementById('cpConfirm').hidden = false;
        try { document.getElementById('cpConfirmOk').focus(); } catch (e) {}
    }
    function cpStartNew() { cpAskNew('listen'); }
    function cpStartNewFlash() { cpAskNew('flash'); }
    function cpStartNewSpeak() { cpAskNew('speak'); }
    function cpConfirmClose() { document.getElementById('cpConfirm').hidden = true; }
    function cpConfirmBg(e) { if (e && e.target && e.target.id === 'cpConfirm') cpConfirmClose(); }
    function cpConfirmOk() {
        cpConfirmClose();
        try { localStorage.removeItem(CP_RESUME_KEYS[cpConfirmKind]); } catch (e) {}
        if (cpConfirmKind === 'listen') checkAndStartDictation(); else if (cpConfirmKind === 'speak') startSpeakPracticeSession(); else startFlashcardSession();
    }
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { let d = document.getElementById('cpConfirm'); if (d && !d.hidden) cpConfirmClose(); } });

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
        // 手機：語音要在「按下開始」的當下先唸一次（聽不到的空白），之後自動播放的題目才會有聲音
        try { synth.cancel(); let u = new SpeechSynthesisUtterance(' '); u.volume = 0; u.lang = getLearningLanguage() === 'ko' ? 'ko-KR' : 'en-US'; synth.speak(u); } catch (e) {}
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
        document.getElementById('examArea').style.display = 'flex';
        let bk = document.getElementById('examBookName'); if (bk) bk.textContent = currentExamRanges ? `題庫 ${currentExamRanges}・測驗` : '';
        document.body.classList.add('qz-on');
        qzFitViewport();

        window.scrollTo({ top: 0, behavior: 'smooth' });

        // 第一題前先等 1.5 秒（手機的語音引擎剛啟動時，第一句常常被吃掉）
        let n0 = wordsData.length;
        let cnt = document.getElementById('examCount'); if (cnt) cnt.innerHTML = `1 <small>/ ${n0}</small>`;
        qzStatus('examProgressStatus', '準備開始…');
        qzShow('examTimer', false);
        setExamInputsDisabled(false);
        try { document.getElementById('examInputEng').focus({ preventScroll: true }); } catch (e) {}
        setTimeout(() => { if (isExamRunning && currentWordIndex === 0) playExamQuestion(); }, 1500);
    }

    // 測驗共用：題目卡上的狀態膠囊、計時膠囊
    const QZ_WAVE = '<span class="cp-wave" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></span>';
    function qzStatus(id, html, cls) {
        let el = document.getElementById(id);
        if (!el) return;
        el.innerHTML = html;
        el.classList.remove('is-ok', 'is-bad');
        if (cls) el.classList.add(cls);
    }
    function qzTimer(id, secs) {
        let box = document.getElementById(id);
        if (!box) return;
        let b = box.querySelector('b'); if (b) b.textContent = secs;
        box.classList.toggle('is-danger', secs <= 5);
    }
    function qzShow(id, on) { let el = document.getElementById(id); if (el) el.style.visibility = on ? '' : 'hidden'; }
    function qzFitViewport() { try { weFitViewport(); } catch (e) {} }
    let examLocked = false;          // 送出後顯示對錯的那 1 秒：不能再送出
    function playExamQuestion() {
        if (!isPlaying || currentWordIndex >= wordsData.length) { finishExam(); return; }
        examLocked = false;
        let item = wordsData[currentWordIndex];
        let n = wordsData.length;
        let cnt = document.getElementById('examCount'); if (cnt) cnt.innerHTML = `${currentWordIndex + 1} <small>/ ${n}</small>`;
        let fill = document.getElementById('examFill'); if (fill) fill.style.width = `${((currentWordIndex + 1) / n * 100).toFixed(1)}%`;
        qzStatus('examProgressStatus', QZ_WAVE + '正在播放');
        document.getElementById('examCard').classList.add('is-playing');
        let ansSecs = parseInt(document.getElementById('examAnswerTime').value) || 26;
        qzShow('examTimer', true); qzTimer('examTimer', ansSecs);
        voiceChiStop();
        let eng = document.getElementById('examInputEng'); eng.value = '';
        setupChiInputs('examInputChi', item);
        setExamInputsDisabled(false);                 // 換題時不 disable／blur，手機鍵盤才不會收起又跳出
        try { eng.focus({ preventScroll: true }); } catch (e) {}
        let rate = parseFloat(document.getElementById('examSpeakRate').value) || 0.8;
        let repeatCount = parseInt(document.getElementById('examRepeatCount').value) || 1;
        let gen = currentWordIndex;
        let utteranceCount = 0, started = false;
        function startAnswerTimer() {
            if (started || gen !== currentWordIndex || !isExamRunning || examLocked) return;
            started = true;
            document.getElementById('examCard').classList.remove('is-playing');
            qzStatus('examProgressStatus', '請作答');
            examTimeLeft = ansSecs;
            qzTimer('examTimer', examTimeLeft);
            if (examTimerId) clearInterval(examTimerId);
            examTimerId = setInterval(() => {
                examTimeLeft--;
                qzTimer('examTimer', Math.max(0, examTimeLeft));
                if (examTimeLeft <= 0) { clearInterval(examTimerId); submitExamAnswer(); }      // 時間到還沒送出：算答錯
            }, 1000);
        }
        function speakSingle() {
            if (gen !== currentWordIndex || !isExamRunning) return;
            let utterance = new SpeechSynthesisUtterance(item.english);
            let learningLang = getLearningLanguage();
            let langCode = (learningLang === 'ko') ? 'ko-KR' : 'en-US';
            let chosenVoice = getSelectedVoiceForLearning();
            if (chosenVoice) utterance.voice = chosenVoice;
            utterance.lang = langCode;
            utterance.rate = rate;
            let sysVol = document.getElementById('systemVolume') ? document.getElementById('systemVolume').value : 100;
            utterance.volume = Math.max(0, Math.min(1.0, (parseInt(sysVol) || 100) / 100));
            let done = false;
            utterance.onend = utterance.onerror = () => {
                if (done) return; done = true;
                utteranceCount++;
                if (utteranceCount < repeatCount) setTimeout(speakSingle, 1000);
                else startAnswerTimer();
            };
            synth.speak(utterance);
        }
        speakSingle();
        // 保險：語音沒有回報播完（有些手機會這樣）時，最多等 6 秒就開始倒數
        setTimeout(startAnswerTimer, 6000 * repeatCount);
    }

    function submitExamAnswer() {
        if (!isExamRunning || examLocked) return;
        examLocked = true;
        if (examTimerId) clearInterval(examTimerId);
        try { synth.cancel(); } catch (e) {}
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

        // 顯示對錯約 1 秒 → 自動換下一題（輸入框不 blur）
        document.getElementById('examCard').classList.remove('is-playing');
        qzShow('examTimer', false);
        qzStatus('examProgressStatus', isCorrect ? '✓ 答對了' : `✗ ${escapeHTML(currentItem.english)}　${escapeHTML(currentItem.senseText || currentItem.chinese || '')}`, isCorrect ? 'is-ok' : 'is-bad');
        currentWordIndex++;
        let pauseSec = parseInt(document.getElementById('examPauseTime').value);
        if (isNaN(pauseSec)) pauseSec = 1;
        setTimeout(() => { if (isExamRunning) playExamQuestion(); }, Math.max(1000, pauseSec * 1000));
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
        document.body.classList.remove('qz-on');
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
        document.body.classList.remove('qz-on');
        
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
    
    // ── 測驗紀錄（一般頁面）──
    let hist = { type: 'listening', mode: 'main', idx: 0, onlyWrong: false, sel: new Set() };
    function histData() { return filterHistoryByLang(hist.type === 'listening' ? examHistory : cardExamHistory); }
    function histDate(s) {
        let m = String(s || '').match(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})\D+?(上午|下午|AM|PM)?\s*(\d{1,2}):(\d{2})/i);
        if (!m) return String(s || '');
        let hr = parseInt(m[5]); if (/下午|PM/i.test(m[4] || '') && hr < 12) hr += 12; if (/上午|AM/i.test(m[4] || '') && hr === 12) hr = 0;
        return `${parseInt(m[2])}/${parseInt(m[3])} ${String(hr).padStart(2, '0')}:${m[6]}`;
    }
    function histWrongList() {
        let map = {};
        histData().forEach(h => (h.results || []).forEach(r => {
            if (r.isCorrect || !r.english) return;
            let key = r.english.toLowerCase();
            if (!map[key]) map[key] = { english: r.english, chinese: r.senseText || r.chinese || '', line: r.line || '', count: 0 };
            map[key].count++;
        }));
        return Object.values(map).sort((x, y) => y.count - x.count).slice(0, 20);
    }
    function histChartSVG(list) {
        let sc = list.slice(0, 10).reverse().map(h => Number(h.score) || 0);
        if (!sc.length) return '';
        let bw = (document.getElementById('histBody') || {}).clientWidth || 360;
        let w = Math.max(300, Math.min(760, bw - 24)), hgt = 120, px = 18, py = 20, n = sc.length;   // 寬度跟著畫面，高度固定
        let xs = sc.map((s, i) => n === 1 ? w / 2 : px + i * (w - 2 * px) / (n - 1));
        let y = s => hgt - py - Math.max(0, Math.min(100, s)) / 100 * (hgt - 2 * py);
        let pts = sc.map((s, i) => `${xs[i].toFixed(0)},${y(s).toFixed(0)}`).join(' ');
        let dots = sc.map((s, i) => `<circle cx="${xs[i].toFixed(0)}" cy="${y(s).toFixed(0)}" r="${i === n - 1 ? 5 : 3.5}" class="${i === n - 1 ? 'last' : ''}"/>`).join('');
        let dates = list.slice(0, 10).reverse().map(h => histDate(h.date).split(' ')[0]);
        return `<div class="hs-chart"><svg viewBox="0 0 ${w} ${hgt}" width="100%" aria-label="成績曲線"><line class="ref" x1="${px}" x2="${w - px}" y1="${y(60).toFixed(0)}" y2="${y(60).toFixed(0)}"/><text class="ref" x="${w - px}" y="${(y(60) - 5).toFixed(0)}" text-anchor="end">60</text>
            ${n > 1 ? `<polyline points="${pts}"/>` : ''}${dots}<text class="val" x="${xs[n - 1].toFixed(0)}" y="${(y(sc[n - 1]) - 10).toFixed(0)}" text-anchor="middle">${sc[n - 1]}</text></svg>
            <div class="dates">${dates.map(d => `<span>${escapeHTML(d)}</span>`).join('')}</div></div>`;
    }
    function renderHistoryPage() {
        let body = document.getElementById('histBody'), title = document.getElementById('historyTitle');
        if (!body) return;
        let list = histData(), name = hist.type === 'listening' ? '聽力測驗' : '字卡測驗';
        let wordRow = (e, c, right) => `<span class="t"><b>${escapeHTML(e)}</b> <span class="mut">${escapeHTML(c || '')}</span></span>${right || ''}`;
        if (hist.mode === 'detail' && list[hist.idx]) {
            let h = list[hist.idx], rs = h.results || [], wrong = rs.filter(r => !r.isCorrect).length;
            title.textContent = `📊 ${histDate(h.date).split(' ')[0]} ${name}`;
            let rows = rs.map(r => {
                if (hist.onlyWrong && r.isCorrect) return '';
                let yours = hist.type === 'listening' ? [r.userEng || '未填', r.userChi || '未填'].join('／') : [r.userChi || '未填', r.pos ? (r.userPos || '未選') : ''].filter(Boolean).join('／');
                return `<div class="hs-row"><span class="${r.isCorrect ? 'ok' : 'no'}">${r.isCorrect ? '✓' : '✕'}</span><span class="t"><b>${escapeHTML(r.english || '')}</b> <span class="mut">${escapeHTML(r.senseText || r.chinese || '')}</span>${r.isCorrect ? '' : `<small class="yours">你的答案：${escapeHTML(yours)}</small>`}</span></div>`;
            }).join('');
            body.innerHTML = `<div class="hs-dhead"><span><b>${escapeHTML(histDate(h.date))}</b>　<span class="mut">${escapeHTML(h.range || '')}</span></span><span class="hs-big">${escapeHTML(h.score)}<small> 分</small></span></div>
                <div class="pk-bar"><span>${escapeHTML(h.total)} 題・答錯 <b class="warn">${wrong}</b> 題</span><button type="button" class="addb${hist.onlyWrong ? ' on' : ''}" data-on-click='[["histToggleWrong",[]]]'>${hist.onlyWrong ? '顯示全部' : '只看錯的'}</button></div>
                <div class="hs-list">${rows || '<div class="hs-empty">這次全部答對！</div>'}</div>`;
            return;
        }
        if (hist.mode === 'save') {
            title.textContent = '📥 存到題庫';
            let wl = histWrongList();
            let opts = wordLists.map((l, i) => ({ l, i })).filter(x => isListInCurrentLang(x.l) && !isPackList(x.l))
                .map(x => `<option value="${x.i}">${escapeHTML(x.l.title)}（${getListWordCount(x.l.content)}/${getListWordCap(x.l)}）</option>`).join('');
            body.innerHTML = `<div class="pk-bar"><span>選要存的單字・已選 <b>${hist.sel.size}</b> 個</span><button type="button" class="addb" data-on-click='[["histSelectAll",[]]]'>全選</button></div>
                <div class="hs-list">${wl.map((w, i) => `<div class="hs-row pick${hist.sel.has(i) ? ' on' : ''}" data-on-click='[["histToggleSel",[${i}]]]'>${wordRow(w.english, w.chinese, `<span class="cnt">錯 ${w.count} 次</span><span class="ck">${hist.sel.has(i) ? '✓' : ''}</span>`)}</div>`).join('') || '<div class="hs-empty">目前沒有錯題</div>'}</div>
                <div class="hs-save"><select id="histTarget">${opts || '<option value="">（還沒有自訂題庫）</option>'}</select><button type="button" data-on-click='[["histSaveWords",[]]]'>存入</button></div>`;
            return;
        }
        title.textContent = '📊 測驗紀錄';
        let avg = list.length ? Math.round(list.reduce((s, h) => s + (Number(h.score) || 0), 0) / list.length) : 0;
        let best = list.length ? Math.max(...list.map(h => Number(h.score) || 0)) : 0;
        let wl = histWrongList().slice(0, 5);
        body.innerHTML = `<div class="pk-seg"><button type="button" class="${hist.type === 'listening' ? 'on' : ''}" data-on-click='[["histSetType",["listening"]]]'>聽力測驗</button><button type="button" class="${hist.type === 'card' ? 'on' : ''}" data-on-click='[["histSetType",["card"]]]'>字卡測驗</button></div>
            ${list.length ? `<div class="hs-sum">共 <b>${list.length}</b> 次・平均 <b>${avg}</b> 分・最高 <b>${best}</b> 分</div>${histChartSVG(list)}
            <div class="hs-sec"><b>常錯單字</b>${wl.length ? `<button type="button" class="hs-link" data-on-click='[["histOpenSave",[]]]'>存到題庫 ›</button>` : ''}</div>
            <div class="hs-list">${wl.map(w => `<div class="hs-row">${wordRow(w.english, w.chinese, `<span class="cnt">錯 ${w.count} 次</span>`)}</div>`).join('') || '<div class="hs-empty">目前沒有錯題，太厲害了！</div>'}</div>
            <div class="hs-sec"><b>歷史紀錄</b></div>
            <div class="hs-list">${list.map((h, i) => `<div class="hs-row link" data-on-click='[["histOpenDetail",[${i}]]]'><span class="t"><b>${escapeHTML(histDate(h.date))}</b><small>${escapeHTML(h.range || '')}・${escapeHTML(h.total)} 題</small></span><span class="sc${Number(h.score) < 60 ? ' low' : ''}">${escapeHTML(h.score)}</span><span class="ar">›</span></div>`).join('')}</div>`
            : `<div class="hs-empty" style="margin-top:4px">還沒有${getLangName(getLearningLanguage())}${name}紀錄，去考一次吧！</div>`}`;
    }
    function histSetType(t) { hist.type = t === 'card' ? 'card' : 'listening'; hist.mode = 'main'; renderHistoryPage(); }
    function histOpenDetail(i) { hist.mode = 'detail'; hist.idx = parseInt(i) || 0; hist.onlyWrong = false; renderHistoryPage(); window.scrollTo(0, 0); }
    function histToggleWrong() { hist.onlyWrong = !hist.onlyWrong; renderHistoryPage(); }
    function histOpenSave() { hist.mode = 'save'; hist.sel = new Set([0, 1, 2].filter(i => i < histWrongList().length)); renderHistoryPage(); window.scrollTo(0, 0); }
    function histToggleSel(i) { i = parseInt(i); hist.sel.has(i) ? hist.sel.delete(i) : hist.sel.add(i); renderHistoryPage(); }
    function histSelectAll() { let n = histWrongList().length; hist.sel = hist.sel.size === n ? new Set() : new Set([...Array(n).keys()]); renderHistoryPage(); }
    function histSaveWords() {
        let sel = document.getElementById('histTarget'), idx = sel ? parseInt(sel.value) : NaN;
        if (isNaN(idx) || !wordLists[idx]) { alert(`⚠️ 目前沒有可儲存的${getLangName(getLearningLanguage())}題庫，請先到「題庫」新增。`); return; }
        let wl = histWrongList().filter((w, i) => hist.sel.has(i));
        if (!wl.length) { alert('⚠️ 請至少選一個單字！'); return; }
        let added = 0, full = 0;
        wl.forEach(w => {
            let cur = wordLists[idx].content || '';
            if (parseWordsRaw(cur).some(x => x.english.toLowerCase() === w.english.toLowerCase())) return;
            if (getListWordCount(cur) >= getListWordCap(wordLists[idx])) { full++; return; }
            wordLists[idx].content = cur + (cur ? '\n' : '') + ((w.line || '').trim() || `${w.english} ${w.chinese}`.trim());
            added++;
        });
        localStorage.setItem('dictation_word_lists', JSON.stringify(wordLists));
        triggerAutoSaveToCloud();
        try { refreshAllListViews(); } catch (e) {}
        alert(`✅ 已將 ${added} 個單字存到「${wordLists[idx].title}」！${full ? `\n⚠️ 題庫已達上限，有 ${full} 個沒有加入。` : ''}`);
        hist.mode = 'main'; renderHistoryPage();
    }
    function historyBack() {
        if (hist.mode !== 'main') { hist.mode = 'main'; renderHistoryPage(); window.scrollTo(0, 0); return; }
        backToHome();
    }
    async function openHistoryModal() {
        hist.mode = 'main';
        switchView('historyView');
        renderHistoryPage();
        syncDriveInBackground(() => { if (document.getElementById('historyView').classList.contains('active')) renderHistoryPage(); });
        window.scrollTo(0, 0);
        return;
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
        let v = document.getElementById('systemVolume'), t = document.getElementById('volumeValue');
        if (v && t) t.innerText = v.value + '%';
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
            powerSaving: document.getElementById('powerSavingToggle').checked,
            learningLanguage: document.getElementById('learningLanguage').value
        };
        localStorage.setItem('dictation_system_settings', JSON.stringify(settings));
    }

    function loadSystemSettings() {
        let saved = localStorage.getItem('dictation_system_settings');
        if (saved) {
            let s = JSON.parse(saved);
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
            let keepOwner = advData.owner;
            try { localStorage.removeItem(advStoreKey()); } catch (e) {}
            advData = advLoad();
            advData.owner = keepOwner;
            advData.legendReset = true;          // 傳說招式全部回到補給站（熟練度跟著進度一起歸 0）
            advData.ts = Date.now();
            advSave();
            try { advRefreshViews(); } catch (e) {}
            try { advRenderShopBox(); } catch (e) {}
            alert('🔄 雞塊大冒險已重設：進度、道具、裝備、能力、經驗值、熟練度都回到初始值，傳說招式已回到補給站。');
            return true;
        }
        if (code === 'newplayer') {
            try { localStorage.setItem(OB_FORCE_KEY, '1'); localStorage.removeItem(OB_DONE_KEY); } catch (e) {}
            alert('🐣 下次打開 App 會再跑一次新手教學。');
            return true;
        }
        if (code === 'flower') {
            walletRpc('farm_act', { p_action: 'dev', p_args: { code: 'flower' } })
                .then(res => { farmApply(res); farmSrv = true; farmRefresh(); alert('🌸 花 +500（雲端）'); })
                .catch(() => { farm.flowers += 500; farmSave(); farmRefresh(); alert('🌸 花 +500（這台裝置；後台還沒執行 supabase_006_farm.sql）'); });
            return true;
        }
        if (code === 'testmoney') {
            advData.shards += 500;
            advData.potions += 100; advData.wipes += 100;
            advSave();
            try { advRefreshViews(); advRenderShopBox(); } catch (e) {}
            alert('💰 已送出：冒險代幣 +500、小型恢復藥水／濕紙巾各 +100');
            return true;
        }
        if (code === 'testsync') {
            // 檢查用：看這台裝置的大冒險存檔是哪一版、存在哪裡、最後存檔時間
            let t = advData.ts ? new Date(advData.ts).toLocaleString() : '（0）';
            let raw = {}; try { raw = JSON.parse(localStorage.getItem(advStoreKey())) || {}; } catch (e) {}
            let b = advSyncBase();
            alert(`🔍 大冒險存檔檢查\n\nApp 版本：經驗值版（程式存檔版本 ${ADV_DATA_VER}）\n這份存檔的版本：${raw.ver === undefined ? '（舊版，沒有版本）' : raw.ver}\n上次跟雲端同步：${b ? new Date(b).toLocaleString() : '（還沒同步過）'}\n存檔位置：${advIsGoogleMode() ? 'Google 雲端進度' : '離線進度（沒有登入 Google）'}\n最後存檔：${t}\n已通關：${Object.keys(advData.cleared || {}).length} 關\n等級：Lv.${advLevel()}（經驗值 ${advData.xp || 0}）`);
            return true;
        }
        if (code === 'testlevel') {
            let lv = advLevel();
            if (lv >= ADV_XP_NEED.length) { alert(`已經是最高等級 Lv.${lv} 了。`); return true; }
            advData.xp = ADV_XP_NEED[lv];          // 剛好升到下一級
            advSave();
            try { advRefreshViews(); } catch (e) {}
            alert(`⬆️ 雞塊升到 Lv.${lv + 1}！可分配能力點 ${advPtsLeft()} 點`);
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
          alert('❌ 密碼錯誤！');
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
    const ADV_BASE_STATS = BattleCore.BASE_STATS;   // ⚔️ 戰鬥規則都在 battle-core.js（這裡只是取別名）
    // ── 等級：打贏大冒險得經驗值，每升 1 級得 1 點能力點（取代糖醋醬）──
    //   ADV_XP_NEED[n-1] = 升到 Lv.n 需要的「累積」經驗值；從 Lv.0 開始，最高 Lv.20
    const ADV_DATA_VER = 2;                  // 存檔版本：2 = 經驗值系統（舊版糖醋醬存檔會整個重來）
    const ADV_XP_NEED = BattleCore.XP_NEED;
    const ADV_LOSE_XP_RATE = 0.2;            // 戰敗：拿勝利經驗值的 20%（至少 1）；中途離開什麼都沒有
    // 經驗值、等級的算法在 battle-core.js
    const ADV_OLD_XP_RATE = BattleCore.OLD_XP_RATE;   // 已經打贏過的舊關卡：經驗值只有 70%
    function advWinXp(lv, old, dbl) { return BattleCore.winXp(lv, old, dbl); }
    function advLevel(xp) { return BattleCore.levelOf(xp === undefined ? (advData.xp || 0) : xp); }
    function advLevelInfo() {
        let xp = advData.xp || 0, lv = advLevel(xp), max = lv >= ADV_XP_NEED.length;
        let prev = lv ? ADV_XP_NEED[lv - 1] : 0, next = max ? prev : ADV_XP_NEED[lv];
        return { lv, xp, prev, next, max, pct: max ? 100 : Math.max(0, Math.min(100, (xp - prev) / (next - prev) * 100)) };
    }
    function advPtsUsed() { let u = advData.up || {}; return BattleCore.STAT_KEYS.reduce((t, k) => t + (u[k] || 0), 0); }
    function advPtsLeft() { return Math.max(0, advLevel() - advPtsUsed()); }
    const ADV_MOVES_SHOWN = 4;               // 招式選擇一開始只顯示幾張，其餘收在「更多招式」
    let advMovesOpen = false;
    const ADV_REPLAY_PER_DAY = 3;           // 已通關的關卡可以無限重複挑戰；每天前 3 次打贏才有通關獎勵
    const ADV_UP_MAX = 10;
    const ADV_STAT_MAX = BattleCore.STAT_MAX;       // 每項能力（含 HP、智慧）最多 10：能強化的次數 = 10 − 基礎值
    function advUpMax(key) { return BattleCore.upMax(key); }
    const ADV_SHARDS_PER_SAUCE = 15;        // 15 個碎片 → 1 瓶糖醋醬
    const ADV_TOTAL_LEVELS = 20;
    const ADV_CHAPTERS = [
        { id: 1, from: 1, to: 10, name: '夜市' },
        { id: 2, from: 11, to: 20, name: '便利商店' }
    ];
    const ADV_WIPE_COST = 30;               // 濕紙巾：30 個冒險代幣
    const ADV_HIT_N = 20;                   // 命中：看最近 20 題
    const ADV_HANDS = ['裝備 1', '裝備 2'];      // 兩個裝備欄
    // 裝備的稀有度（邊框顏色跟招式一樣：灰＝普通、深金＝稀有、亮紫＝傳說）
    const ADV_ITEM_RARITY = BattleCore.ITEM_RARITY;
    function advItemRarityKey(k) { return ADV_ITEM_RARITY[k] || 'common'; }
    const ADV_SAUCE_COLOR = '#EE8F78';      // 糖醋醬的顏色（碎片圖示也用這個顏色）
    const ADV_POTION_HEAL = 5, ADV_POTION_COST = 10;    // 恢復藥水：10 個冒險代幣 → HP +5
    const ADV_WEEKLY_SHARDS = 100, ADV_WEEKLY_CHICKENS = 2;   // 每週一次：100 碎片 → 2 雞塊
    const ADV_MAX_EQUIP = BattleCore.MAX_EQUIP;
    const ADV_MIN_EQUIP = BattleCore.MIN_EQUIP;     // 至少要帶 3 招
    const ADV_BASE_SECS = BattleCore.BASE_SECS;     // 每題作答時間（秒）
    const ADV_LUCK_CAP = BattleCore.LUCK_CAP;       // 幸運擲幣的加成最多 +3

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
        // 蓄力：雞塊全身冒出金黃色的氣（像超級賽亞人）
        chargeup: () => advSvg('0 0 24 24', '<path d="M12 .8 L14.1 6.4 L17.8 2.9 L17.3 8.6 L22 7 L19.3 12.3 L22.6 15 L18.4 16.4 L19.4 22 H4.6 L5.6 16.4 L1.4 15 L4.7 12.3 L2 7 L6.7 8.6 L6.2 2.9 L9.9 6.4 Z" fill="#FDE047" stroke="#CA8A04" stroke-width="1.2" stroke-linejoin="round"/><path d="M12 5.2 L13.4 9.4 L16 7.4 L15.6 11.2 L18.4 11 L16.6 14.4 L17.6 21 H6.4 L7.4 14.4 L5.6 11 L8.4 11.2 L8 7.4 L10.6 9.4 Z" fill="#FEF9C3"/><circle cx="12" cy="16.4" r="5.2" fill="#F4A236" stroke="#231F20" stroke-width="1.5"/><path d="M9.3 14.9 L11 15.7 M14.7 14.9 L13 15.7" stroke="#231F20" stroke-width="1.3" stroke-linecap="round"/><path d="M10.6 18.4 H13.4" stroke="#231F20" stroke-width="1.2" stroke-linecap="round"/><path d="M19.6 4.4 l1.6 -1.6 M3 4 l-1.4 -1.4" stroke="#F59E0B" stroke-width="1.2" stroke-linecap="round"/>'),
        // 冥想：閉眼盤坐的雞塊，背後淡紫色光圈
        meditate: () => advSvg('0 0 24 24', '<ellipse cx="12" cy="12.6" rx="10.8" ry="10.2" fill="#EDE9FE" stroke="#A78BFA" stroke-width="1.1"/><path d="M5.2 19.6 Q12 23.2 18.8 19.6" stroke="#231F20" stroke-width="1.6" fill="none" stroke-linecap="round"/><circle cx="12" cy="13" r="6.6" fill="#F4A236" stroke="#231F20" stroke-width="1.6"/><path d="M8.9 12.4 Q9.9 13.6 10.9 12.4 M13.1 12.4 Q14.1 13.6 15.1 12.4" stroke="#231F20" stroke-width="1.2" fill="none" stroke-linecap="round"/><path d="M10.9 15.6 Q12 16.4 13.1 15.6" stroke="#231F20" stroke-width="1.1" fill="none" stroke-linecap="round"/><path d="M6.4 16.6 Q8.6 19.4 11 18.2 M17.6 16.6 Q15.4 19.4 13 18.2" stroke="#231F20" stroke-width="1.5" fill="none" stroke-linecap="round"/><circle cx="4.6" cy="5.6" r="1" fill="#A78BFA"/><circle cx="19.6" cy="4.8" r="1.2" fill="#A78BFA"/><circle cx="12" cy="2.6" r=".9" fill="#C4B5FD"/>'),
        wave3: () => advSvg('0 0 52 30', '<circle cx="9" cy="15" r="10" fill="#FDE047" opacity="0.55"/><circle cx="9" cy="15" r="6.5" fill="#FACC15" stroke="#F59E0B" stroke-width="1.5"/><circle cx="9" cy="15" r="3" fill="#FFFFFF"/><path d="M 14 8 L 30 9 L 34 5 L 38 9 L 44 8 L 51 15 L 44 22 L 38 21 L 34 25 L 30 21 L 14 22 Z" fill="#FACC15" stroke="#F59E0B" stroke-width="1.3" stroke-linejoin="round"/><path d="M 15 12 H 46 L 49 15 L 46 18 H 15 Z" fill="#FFFFFF" opacity="0.9"/>')
    };
    // 招式說明只寫「怎麼答」：類型、題數、威力在畫面上已經有了
    const ADV_LEGEND_PRICE = 30;            // 傳說招式：補給站 30 個碎片（打倒第 20 關後才能買）
    // 招式資料在 battle-core.js；這裡只把圖示換成 SVG
    const ADV_MOVES = BattleCore.MOVES.map(m => ADV_ICONS[m.key] ? Object.assign({}, m, { icon: ADV_ICONS[m.key]() }) : m);
    const ADV_TYPE_LABEL = BattleCore.TYPE_LABEL;
    // 稀有度：普通（灰框，熟練度上限 1）／稀有（深金框，上限 2）／傳說（亮紫框，上限 3）
    const ADV_RARITY = BattleCore.RARITY;
    const ADV_RARITY_SKILL = { common: '一般技能', rare: '稀有技能', legend: '傳奇技能' };
    const ADV_MOVE_RARITY = BattleCore.MOVE_RARITY;
    // 熟練度：累積使用 20 次 → 1、100 次 → 2、300 次 → 3（不超過稀有度上限）；每 1 級這招攻擊 +1（傳說招式 +2）
    const ADV_MASTERY_STEPS = BattleCore.MASTERY_STEPS;
    function advRarity(key) { return ADV_RARITY[ADV_MOVE_RARITY[key] || 'common']; }
    function advRarityKey(key) { return BattleCore.rarityKey(key); }
    function advMasteryInfo(key) {
        let uses = Math.max(0, parseInt((advData.mastery || {})[key]) || 0);
        let cap = advRarity(key).cap, lvl = BattleCore.masteryLevel(key, uses);   // 熟練度怎麼升級：battle-core.js
        let maxed = lvl >= cap;
        return { uses, lvl, cap, maxed, next: maxed ? null : ADV_MASTERY_STEPS[lvl], prev: lvl ? ADV_MASTERY_STEPS[lvl - 1] : 0 };
    }
    function advMastery(key) { return advMasteryInfo(key).lvl; }
    // 熟練度加的攻擊：每 1 級 +1，傳說招式每 1 級 +2
    function advMasteryPerLv(key) { return BattleCore.masteryPerLv(key); }
    function advMasteryAtk(key) { return BattleCore.masteryAtk(key, advMastery(key)); }
    // 用了一次招式：回傳「升級後的等級」，沒升級回傳 0
    function advAddMasteryUse(key) {
        if (!advData.mastery) advData.mastery = {};
        let before = advMastery(key);
        advData.mastery[key] = (parseInt(advData.mastery[key]) || 0) + 1;
        let after = advMastery(key);
        return after > before ? after : 0;
    }
    const ADV_DEFAULT_EQUIP = ['tackle', 'slash'];
    function advMoveByKey(k) { return ADV_MOVES.find(m => m.key === k); }

    // 關卡資料、敵人特殊能力的數字：都在 battle-core.js
    const ADV_LEVELS = BattleCore.LEVELS;
    const ADV_COFFEE_BURN = BattleCore.COFFEE_BURN;
    const ADV_CLERK_POSTS = BattleCore.CLERK_POSTS;
    const ADV_CLERK_SHIFT_HP = BattleCore.CLERK_SHIFT_HP, ADV_CLERK_CD = BattleCore.CLERK_CD;
    const ADV_STAMP_NEED = BattleCore.STAMP_NEED, ADV_STAMP_ATK = BattleCore.STAMP_ATK, ADV_STAMP_HEAL = BattleCore.STAMP_HEAL;
    const ADV_RESIST = BattleCore.RESIST;
    const ADV_IMMUNE = BattleCore.IMMUNE;
    function advImmuneType() { return adv.enemy ? BattleCore.immuneType(adv) : ''; }   // 這一刻敵人免疫的招式類型
    const ADV_WEAK_BONUS = BattleCore.WEAK_BONUS;
    const ADV_SPEED_GUARD = BattleCore.SPEED_GUARD;
    const ADV_CLERK_SPEED_GUARD = BattleCore.CLERK_SPEED_GUARD, ADV_TEA_SPEED_HEAL = BattleCore.TEA_SPEED_HEAL, ADV_EXPIRE_SPEED_DMG = BattleCore.EXPIRE_SPEED_DMG;
    function advSpeedGuard() { return adv.enemy ? BattleCore.speedGuard(adv) : 0; }
    function advPostRule(post) { return post.immune === 'speed' ? `速答加成 −${ADV_CLERK_SPEED_GUARD}` : `${ADV_TYPE_LABEL[post.immune]}無效`; }
    const ADV_MICRO_ATK_UP = BattleCore.MICRO_ATK_UP;
    const ADV_EXPIRE_SELF = BattleCore.EXPIRE_SELF;
    const ADV_EGG_CARD_BONUS = BattleCore.EGG_CARD_BONUS;
    // 裝備道具：名稱、效果說明在 battle-core.js，這裡加上圖示
    const ADV_ITEM_ICONS = {
        boba: (s) => `<span style="font-size:${s}px;line-height:1">🧋</span>`,
        tofu: (s) => advTofuIcon(s), skewer: (s) => advSkewerIcon(s), bill: (s) => advBillIcon(s),
        bag: (s) => advPlasticBagIcon(s), soda: (s) => advSodaIcon(s), coaster: (s) => advCoasterIcon(s)
    };
    const ADV_ITEMS = {};
    Object.keys(BattleCore.ITEMS).forEach(k => { ADV_ITEMS[k] = Object.assign({}, BattleCore.ITEMS[k], { icon: ADV_ITEM_ICONS[k] || ((s) => '') }); });
    const ADV_COASTER_PRICE = 30;           // 補給站：防燙杯套 30 個冒險代幣（第 11 關開放＝打完第 10 關）
    const ADV_COASTER_INT = BattleCore.COASTER_INT;
    // 防燙杯套：外帶咖啡紙杯＋牛皮紙瓦楞杯套
    function advCoasterIcon(size) {
        size = size || 24;
        return `<svg width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true" style="vertical-align:-4px;overflow:visible"><path d="M9 9.5 L23 9.5 L21 29 L11 29 Z" fill="#FFFFFF" stroke="#64748B" stroke-width="1.3" stroke-linejoin="round"/><rect x="10.2" y="3.4" width="11.6" height="2.8" rx="1.2" fill="#CBD5E1" stroke="#64748B" stroke-width="1.1"/><rect x="7.6" y="5.8" width="16.8" height="4.2" rx="1.6" fill="#E2E8F0" stroke="#64748B" stroke-width="1.3"/><path d="M9.7 14 L22.3 14 L21.5 23 L10.5 23 Z" fill="#C98A4B" stroke="#7C4A1E" stroke-width="1.2" stroke-linejoin="round"/><path d="M12.4 14.6 L12.25 22.4" stroke="#8B5A2B" stroke-width="0.9" opacity="0.7"/><path d="M14.2 14.6 L14.049999999999999 22.4" stroke="#8B5A2B" stroke-width="0.9" opacity="0.7"/><path d="M16 14.6 L16.15 22.4" stroke="#8B5A2B" stroke-width="0.9" opacity="0.7"/><path d="M17.8 14.6 L17.95 22.4" stroke="#8B5A2B" stroke-width="0.9" opacity="0.7"/><path d="M19.6 14.6 L19.75 22.4" stroke="#8B5A2B" stroke-width="0.9" opacity="0.7"/><path d="M13.6 17.2 C13.6 15.9 15.3 15.6 16 16.8 C16.7 15.6 18.4 15.9 18.4 17.2 C18.4 18.7 16 20.2 16 20.2 C16 20.2 13.6 18.7 13.6 17.2 Z" fill="#FFF7ED" stroke="#7C4A1E" stroke-width="0.8"/></svg>`;
    }
    const ADV_BOBA_PRICE = 10;              // 補給站：快喝光的珍珠奶茶 10 個冒險代幣（第 5 關開放＝打完第 4 關）
    const ADV_SODA_PRICE = 2;               // 補給站：彈珠汽水 2 個碎片
    const ADV_BAG_SHIELD = BattleCore.BAG_SHIELD;               // 夜市塑膠袋：護盾 +1
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
        darts: '聽力招式只造成 1 點傷害',
        mahjong: '摸牌！字卡招式只造成 1 點傷害',
        ring: '天女散花！',
        pinball: '打彈珠！',
        egg: '請幫我剝殼 ❤️',
        bun: '熱狗',
        wrap: '拆不掉的包裝',
        tea: '現泡就是回甘！',
        seal: '取票失敗！',
        salad: '蓋子霧霧的，看不清楚字',
        microwave: '運轉中..聽不到你在說什麼？',
        bento: '月底救星！',
        expire: '我快過期了..',
        coffee: '太燙了！速答招式的能力加成 −3',
        clerk: '集點卡'
    };

    function advLoad() {
        let d = {};
        try { d = JSON.parse(localStorage.getItem(advStoreKey())) || {}; } catch (e) { d = {}; }
        // 改成經驗值系統：舊存檔（糖醋醬版）的進度、道具、裝備、能力、熟練度全部重來，傳說招式回到補給站
        //   只留：帳號、今天的登入代幣有沒有領過、錯字紀錄（學習用）
        if (d && typeof d === 'object' && Object.keys(d).length && d.ver !== ADV_DATA_VER) {
            d = { owner: d.owner, loginShardDay: d.loginShardDay, wrongCnt: d.wrongCnt, lastWrong: d.lastWrong, legendReset: true, ts: 0, ver: ADV_DATA_VER, resetNotice: true };   // ts 0：改版重來的空白進度不能蓋掉雲端上已經是新版的進度
        }
        let up = d.up || {};
        let clampUp = (v, k) => Math.max(0, Math.min(advUpMax(k), parseInt(v) || 0));
        // 能力上限改成 10：超過的部分退回糖醋醬
        let upRefund = ['hp', 'atk', 'agi', 'def', 'int', 'luck'].reduce((s, k) => s + Math.max(0, Math.min(ADV_UP_MAX, parseInt(up[k]) || 0) - advUpMax(k)), 0);
        let n0 = v => Math.max(0, parseInt(v) || 0);
        let hasShards = d.shards !== undefined;
        let hp = parseInt(d.hp);
        let own = {};
        if (d.own && typeof d.own === 'object') ADV_MOVES.forEach(m => { if (d.own[m.key] === true) own[m.key] = true; });
        let eq = Array.isArray(d.eq) ? d.eq.filter(k => !!advMoveByKey(k) && !advMoveByKey(k).hidden) : ADV_DEFAULT_EQUIP.slice();
        eq = eq.filter((k, i) => eq.indexOf(k) === i).slice(0, ADV_MAX_EQUIP);
        ADV_MOVES.forEach(m => { if (m.buy.kind === 'reward' && d.cleared && d.cleared[String(m.buy.level)]) own[m.key] = true; });   // 關卡送的招式（舊存檔也補發）
        let items = {};
        if (d.items && typeof d.items === 'object') Object.keys(ADV_ITEMS).forEach(k => { if (d.items[k] === true) items[k] = true; });
        if (d.cleared && d.cleared['1']) items.bag = true;      // 打贏貢丸送夜市塑膠袋（舊存檔也補發）
        if (d.cleared && d.cleared['4']) items.tofu = true;     // 打贏臭豆腐送烤焦臭豆腐（舊存檔也補發）
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
                return { card: arr(hz.card), listen: arr(hz.listen), speak: arr(hz.speak), speed: arr(hz.speed), all: arr(hz.all) };
            })(),
            hitPrev: Number.isFinite(d.hitPrev) ? d.hitPrev : null,
            shards: n0(d.shards),                               // 冒險代幣（程式代號沿用 shards）
            sauce: 0,                                           // 糖醋醬已移除（改成升級加點）
            xp: n0(d.xp),                                       // 經驗值（等級由累積經驗值算出來）
            xpDay: typeof d.xpDay === 'string' ? d.xpDay : '',  // 最近一次拿到「每日首勝 ×2」是哪一天
            ver: ADV_DATA_VER,
            lvUpAt: n0(d.lvUpAt),
            lvSeenAt: n0(d.lvSeenAt),
            // 看過的招式／裝備（新拿到、還沒點開看過的會有紅色驚嘆號）；舊存檔第一次載入時，已擁有的都算看過
            seen: (d.seen && typeof d.seen === 'object') ? { m: Object.assign({}, d.seen.m || {}), g: Object.assign({}, d.seen.g || {}), init: 1 } : null,                               // 最近一次升級的時間（紅點動畫用）
            resetNotice: d.resetNotice === true,                // 改版重來：下次進大冒險時告訴玩家一次
            cleared: (d.cleared && typeof d.cleared === 'object') ? d.cleared : {},
            up: { hp: clampUp(up.hp, 'hp'), atk: clampUp(up.atk, 'atk'), agi: clampUp(up.agi, 'agi'), def: clampUp(up.def, 'def'), int: clampUp(up.int, 'int'), luck: clampUp(up.luck, 'luck') },
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
            legendReset: d.legendReset === true,                           // testreset 過：以前用雞塊買的傳說招式也不算擁有（回到補給站）
            loseTipShown: d.loseTipShown === true,                         // 第一次戰敗時提醒過恢復藥水了
            wrongCnt: (() => { let o = {}; if (d.wrongCnt && typeof d.wrongCnt === 'object') Object.keys(d.wrongCnt).slice(-400).forEach(k => { let v = parseInt(d.wrongCnt[k]); if (v > 0) o[String(k).slice(0, 60)] = Math.min(999, v); }); return o; })(),   // 大冒險每個字答錯幾次
            lastWrong: (() => { let o = {}; if (d.lastWrong && typeof d.lastWrong === 'object') Object.keys(d.lastWrong).forEach(k => { if (Array.isArray(d.lastWrong[k])) o[k] = d.lastWrong[k].filter(x => typeof x === 'string').slice(0, 50); }); return o; })(),   // 每關上次打錯的字
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
    // ── 雲端同步衝突 ──
    //   記住「這台裝置最後一次跟雲端同步」的存檔時間（base）
    //   雲端比 base 新（別台玩過）＋本機也比 base 新（這台也玩過）→ 不自動蓋掉，跳出視窗讓玩家選
    const ADV_SYNC_BASE_KEY = 'chicky_adv_sync_base';
    let advConflict = null;           // { c: 雲端那份, owner }：視窗開著、玩家還沒選
    function advSyncBase() { try { let v = localStorage.getItem(ADV_SYNC_BASE_KEY); return v === null ? null : (parseInt(v) || 0); } catch (e) { return null; } }
    function advSetSyncBase(ts) { try { localStorage.setItem(ADV_SYNC_BASE_KEY, String(parseInt(ts) || 0)); } catch (e) {} }
    function advProgSig(d) {          // 比較兩份進度是不是「真的不一樣」（只差時間不算）
        d = d || {};
        let keys = o => (o && typeof o === 'object') ? Object.keys(o).filter(k => o[k]).sort().join(',') : '';
        return JSON.stringify([d.xp || 0, keys(d.cleared), d.shards || 0, d.potions || 0, d.wipes || 0, keys(d.items), keys(d.own), d.up || {}, d.mastery || {}]);
    }
    function advConflictCard(d, title, sub) {
        d = d || {};
        let xp = parseInt(d.xp) || 0, lv = advLevel(xp), n = Object.keys(d.cleared || {}).filter(k => d.cleared[k]).length;
        let t = d.ts ? new Date(parseInt(d.ts)).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
        return `<div class="sc-card"><div class="sc-card__title">${title}</div><div class="sc-card__sub">${sub}</div>
            <dl><dt>等級</dt><dd>Lv.${lv}</dd><dt>已通關</dt><dd>${n} 關</dd><dt>經驗值</dt><dd>${xp}</dd><dt>冒險代幣</dt><dd>${parseInt(d.shards) || 0}</dd><dt>最後存檔</dt><dd>${t}</dd></dl></div>`;
    }
    function advShowConflict(c, owner) {
        advConflict = { c, owner: owner || '' };
        let old = document.getElementById('advSyncConflict'); if (old) old.remove();
        let el = document.createElement('div');
        el.id = 'advSyncConflict';
        el.className = 'sc-wrap';
        el.innerHTML = `<div class="sc-box" role="dialog" aria-modal="true" aria-labelledby="scTitle">
            <div class="sc-title" id="scTitle">☁️ 兩台裝置的大冒險進度不一樣</div>
            <p class="sc-desc">上次同步之後，這台和另一台裝置都玩過了。要留下哪一份進度？<br><b>沒選的那一份會被蓋掉</b>。</p>
            <div class="sc-cards">${advConflictCard(advData, '📱 這台裝置', '目前這台的進度')}${advConflictCard(c, '☁️ 雲端', '另一台裝置存的進度')}</div>
            <div class="sc-btns">
                <button type="button" class="sc-btn" data-on-click='[["advConflictUse",["local"]]]'>用這台的</button>
                <button type="button" class="sc-btn sc-btn--cloud" data-on-click='[["advConflictUse",["cloud"]]]'>用雲端的</button>
            </div></div>`;
        document.body.appendChild(el);
    }
    function advConflictUse(which) {
        let cf = advConflict;
        let el = document.getElementById('advSyncConflict'); if (el) el.remove();
        if (!cf) return;
        advConflict = null;
        let cts = parseInt(cf.c.ts) || 0;
        if (which === 'cloud') {
            try { localStorage.setItem(ADV_STORE_G, JSON.stringify(cf.c)); } catch (e) {}
            try { advAbort(); } catch (e) {}
            advData = advLoad();
            if (cf.owner && !advData.owner) advData.owner = cf.owner;
            advSetSyncBase(cts);
            advSyncDaily();
            advSave(true);
            try { advRefreshViews(); homeAdvBadge(); } catch (e) {}
        } else {
            advSetSyncBase(cts);
            advData.ts = Math.max(Date.now(), cts + 1);        // 這台的變成最新的 → 上傳蓋掉雲端
            try { localStorage.setItem(advStoreKey(), JSON.stringify(advData)); } catch (e) {}
            advDirty = true;
            if (advIsGoogleMode() && accessToken && isCloudSyncActive && advCloudReady) triggerAutoSaveToCloud();
        }
    }
    // 回到這個分頁（或 App）時：先把雲端最新的進度拉下來比對，避免一直開著的舊分頁用舊進度蓋掉
    let advPullAt = 0;
    async function advPullCloud() {
        if (!advIsGoogleMode() || !accessToken || !isCloudSyncActive || !advCloudReady || advConflict) return;
        if (Date.now() - advPullAt < 20000) return;
        advPullAt = Date.now();
        const tok = accessToken;
        try {
            let query = encodeURIComponent(`name='${FILENAME}' and 'appDataFolder' in parents and trashed=false`);
            let res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&spaces=appDataFolder`, { headers: { 'Authorization': `Bearer ${tok}` } });
            if (!res.ok) return;
            let data = await res.json();
            let fileId = (data.files && data.files.length > 0) ? data.files[0].id : null;
            if (!fileId) return;
            let cr = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: { 'Authorization': `Bearer ${tok}` } });
            if (!cr.ok) return;
            let cj = await cr.json();
            if (!cj || !cj.advData || cj.advData.ver !== ADV_DATA_VER || adv.active) return;      // 戰鬥中先不動（等下次）
            if (advMergeFromCloud(cj.advData, '') && advDirty) advQueueCloud();
        } catch (e) {}
    }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(() => { try { advPullCloud(); } catch (e) {} }, 400); });
    window.addEventListener('focus', () => { setTimeout(() => { try { advPullCloud(); } catch (e) {} }, 400); });
    // 從 Google 雲端載入進度：以「最後存檔時間」較新的為準；不同 Google 帳號的進度不會混在一起
    function advMergeFromCloud(c, cloudOwner) {
        let local = advData;
        let mismatch = !!(cloudOwner && local.owner && local.owner !== cloudOwner);
        if (c && typeof c === 'object') {
            let cts = parseInt(c.ts) || 0;
            // 雲端是舊版（糖醋醬版）存檔、本機已經是新版：不管時間，都以本機為準（不然舊版會把新進度整個重來）
            if (!mismatch && c.ver !== ADV_DATA_VER && local.ver === ADV_DATA_VER && local.ts > 0) return true;
            // 兩邊都有新進度：上次同步之後，這台玩過、別台也玩過（而且內容不一樣）→ 跳出視窗讓玩家選要留哪一份
            let base = advSyncBase();
            if (!mismatch && c.ver === ADV_DATA_VER && base !== null && cts > base && local.ts > base && cts !== local.ts && advProgSig(c) !== advProgSig(local)) {
                advShowConflict(c, cloudOwner);
                return false;
            }
            if (mismatch || cts > local.ts) {
                try { localStorage.setItem(ADV_STORE_G, JSON.stringify(c)); } catch (e) {}
                advData = advLoad();
                if (cloudOwner && !advData.owner) advData.owner = cloudOwner;
                advSetSyncBase(cts);
                advSyncDaily();
                advRefreshViews();
                return false;                    // 不用再上傳
            }
            if (cts === local.ts) advSetSyncBase(cts);
            return cts < local.ts;               // 本機比較新 → 要上傳
        }
        if (mismatch) {                          // 雲端是另一個帳號、沒有進度：本機暫存不能沿用
            try { localStorage.removeItem(ADV_STORE_G); } catch (e) {}
            advData = advLoad(); advSyncDaily(); advRefreshViews();
            return false;
        }
        return true;                             // 雲端還沒有進度：把本機的上傳
    }
    // 每天前 3 次重複通關有獎勵
    // 首頁「雞塊樂園」標題旁的小標籤：目前要打第幾關
    function homeAdvBadge() {
        let el = document.getElementById('funLvBadge');
        if (!el || typeof advData === 'undefined' || !advData) return;
        let n = ADV_LEVELS.length, next = 1;
        while (next <= n && advData.cleared[next]) next++;
        el.textContent = next > n ? '全破' : `第 ${next} 關`;
        el.style.display = '';
        try { advUpdateGearAlerts(); } catch (e) {}
    }
    function advDevDone() { advSave(); try { advRefreshViews(); } catch (e) {} }

    function advReplayCap() { return ADV_REPLAY_PER_DAY; }      // 每天前 3 次重複通關有獎勵（冒險卷已移除）
    function advReplaysUsed() { return advData.replayDay === getLocalDateStr() ? advData.replays : 0; }
    function advReplaysLeft() { return Math.max(0, advReplayCap() - advReplaysUsed()); }
    // 這招有沒有擁有：一開始就有的、用碎片買的、用雞塊買的（雞塊的購買紀錄在後端錢包）
    function advOwns(key) {
        let m = advMoveByKey(key);
        if (!m || m.hidden) return false;              // 朗讀招式先隱藏（衝擊波系列）
        if (m.buy.kind === 'free') return true;
        if (advData.own[key] === true) return true;
        if (advData.legendReset && advRarityKey(key) === 'legend') return false;   // testreset 後：傳說招式要重新在補給站買
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
        return BattleCore.playerStats(advData.up);   // 基礎能力 + 加的點數：battle-core.js
    }
    function advMaxHp() { return advPlayerStats().hp; }
    // 裝備帶來的加成（只在戰鬥中生效，可以讓能力超過 10）
    function advGearBonus(key) { return BattleCore.gearStatBonus((advData.gear || []).filter(Boolean), key); }
    // 體力會繼承到下一場戰鬥；每天 00:00（本機時間）補滿
    // 招式獎勵改到已經通關的關卡（例如突刺＝第 7 關、衝鋒撞擊＝第 8 關）：之前就通關的人直接補發
    function advGrantPastRewards() {
        let got = false;
        try { advSeen(); } catch (e) {}
        ADV_MOVES.forEach(m => {
            if (m.buy.kind === 'reward' && advData.cleared[m.buy.level] && !advData.own[m.key] && !m.hidden) { advData.own[m.key] = true; got = true; }
        });
        if (got) { ADV_MOVES.forEach(m => { if (advData.own[m.key] && m.buy.kind === 'reward' && !advData.eq.includes(m.key) && advData.eq.length < ADV_MAX_EQUIP) advData.eq.push(m.key); }); advSave(true); }
    }
    function advSyncDaily() {
        try { advGrantPastRewards(); } catch (e) {}
        let today = getLocalDateStr(), max = advMaxHp();
        if (advData.hp === null || advData.hpDay !== today) { advData.hpDay = today; advData.hp = max; advSave(true); }
        else if (advData.hp > max) { advData.hp = max; advSave(true); }
        else if (advData.hp < 0) { advData.hp = 0; advSave(true); }
    }
    // 戰鬥公式：都在 battle-core.js
    function advLuckDice(myLuck, foeLuck) { return BattleCore.luckDice(myLuck, foeLuck); }
    function advRollLuck(myLuck, foeLuck) { return BattleCore.rollLuck(myLuck, foeLuck); }
    function advCoinText(flips) { return flips.map(f => f ? '正' : '反').join('、'); }
    const ADV_SHIELD_CAP = BattleCore.SHIELD_CAP;
    function advShieldMax(int) { return BattleCore.shieldMax(int); }
    function advAnswerSecs(myInt, foeInt) { return BattleCore.answerSecs(myInt, foeInt); }
    function advTakeDamage(t, dmg, ignoreShield) { return BattleCore.takeDamage(t, dmg, ignoreShield); }
    function advHurtLabel(r) { return r.absorbed ? (r.loss ? `🛡️-${r.absorbed} -${r.loss}` : `🛡️-${r.absorbed}`) : '-' + r.loss; }
    function advActionCount(myAgi, foeAgi) { return BattleCore.actionCount(myAgi, foeAgi); }
    function advDamage(atk, power, def) { return BattleCore.damage(atk, power, def); }

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
    // 雞塊背面（戰鬥新版面：雞塊背對畫面、看著敵人）
    function advChickenBackSVG() {
        return `<svg viewBox="4 22 128 100" xmlns="http://www.w3.org/2000/svg" fill="none">
            <path d="M 52 108 L 46 118 M 46 118 L 38 118 M 84 108 L 88 118 M 88 118 L 96 118" stroke="#231F20" stroke-width="6" stroke-linecap="round"/>
            <path d="M 28 68 C 18 68, 12 72, 14 80" stroke="#231F20" stroke-width="6" stroke-linecap="round"/>
            <path d="M 108 68 C 118 68, 124 72, 122 80" stroke="#231F20" stroke-width="6" stroke-linecap="round"/>
            <ellipse cx="68" cy="68" rx="40" ry="42" fill="#F4A236" stroke="#231F20" stroke-width="5.5"/>
            <ellipse cx="68" cy="72" rx="27" ry="29" fill="#E99A2E" opacity="0.55"/>
            <path d="M 44 44 Q 56 34 72 35" stroke="#FFD58A" stroke-width="5" stroke-linecap="round" opacity="0.8"/>
            <circle cx="50" cy="86" r="3.5" fill="#E2861E"/><circle cx="82" cy="58" r="3" fill="#E2861E"/><circle cx="76" cy="96" r="3.5" fill="#E2861E"/><circle cx="92" cy="80" r="2.6" fill="#E2861E"/><circle cx="58" cy="60" r="2.4" fill="#E2861E"/>
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
                <circle cx="60" cy="54" r="27" fill="#FFFFFF"/>
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
        if (kind === 'coffee') {
            return wrap(`${shadow}
                <path d="M 44 14 q -5 -6 0 -12 M 60 12 q -5 -6 0 -12 M 76 14 q -5 -6 0 -12" stroke="#CBD5E1" stroke-width="3.5" fill="none" stroke-linecap="round"/>
                <path d="M 26 28 H 94 L 86 96 Q 85 100 80 100 H 40 Q 35 100 34 96 Z" fill="#FFFFFF" stroke="#231F20" stroke-width="5" stroke-linejoin="round"/>
                <rect x="22" y="20" width="76" height="12" rx="5" fill="#57534E" stroke="#231F20" stroke-width="4.5"/>
                <path d="M 30 50 H 90 L 87 74 H 33 Z" fill="#92400E"/>
                <text x="60" y="67" font-size="12" font-weight="900" text-anchor="middle" fill="#FEF3C7" font-family="'Noto Sans TC','PingFang TC','Microsoft JhengHei',sans-serif">美式</text>
                <circle cx="48" cy="84" r="4" fill="#231F20"/><circle cx="72" cy="84" r="4" fill="#231F20"/>
                <path d="M 42 76 L 52 79 M 78 76 L 68 79" stroke="#231F20" stroke-width="3.5" stroke-linecap="round"/>
                <path d="M 53 93 Q 60 89 67 93" stroke="#231F20" stroke-width="3.5" fill="none" stroke-linecap="round"/>
                <ellipse cx="38" cy="90" rx="5" ry="3" fill="#F87171" opacity="0.7"/><ellipse cx="82" cy="90" rx="5" ry="3" fill="#F87171" opacity="0.7"/>`);
        }
        if (kind === 'clerk') {
            return wrap(`${shadow}
                <path d="M 30 100 Q 30 66 60 66 Q 90 66 90 100 Z" fill="#16A34A" stroke="#231F20" stroke-width="5" stroke-linejoin="round"/>
                <path d="M 46 68 L 60 84 L 74 68" fill="#FFFFFF" stroke="#231F20" stroke-width="4" stroke-linejoin="round"/>
                <rect x="44" y="84" width="32" height="12" rx="3" fill="#F97316" stroke="#231F20" stroke-width="3"/>
                <text x="60" y="93.5" font-size="8" font-weight="900" text-anchor="middle" fill="#FFFFFF" font-family="'Noto Sans TC','PingFang TC','Microsoft JhengHei',sans-serif">店員</text>
                <circle cx="60" cy="40" r="26" fill="#FCD9B6" stroke="#231F20" stroke-width="5"/>
                <path d="M 34 34 Q 36 12 60 12 Q 84 12 86 34 Q 72 26 60 28 Q 48 26 34 34 Z" fill="#3F2A1D" stroke="#231F20" stroke-width="4" stroke-linejoin="round"/>
                <path d="M 32 32 Q 60 18 88 32 L 88 36 Q 60 24 32 36 Z" fill="#16A34A" stroke="#231F20" stroke-width="3.5" stroke-linejoin="round"/>
                <circle cx="50" cy="42" r="4" fill="#231F20"/><circle cx="70" cy="42" r="4" fill="#231F20"/>
                <path d="M 50 52 Q 60 59 70 52" stroke="#231F20" stroke-width="3.5" fill="none" stroke-linecap="round"/>
                <ellipse cx="42" cy="50" rx="5" ry="3" fill="#F87171" opacity="0.7"/><ellipse cx="78" cy="50" rx="5" ry="3" fill="#F87171" opacity="0.7"/>`);
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
            <g transform="translate(${x + w / 2} ${y - 2}) scale(1.15) translate(${-(x + w / 2)} ${-(y - 2)})"><rect x="${x + 6}" y="${y - 16}" width="${w - 12}" height="14" rx="4" fill="#FDE047"/>
            <text x="${x + w / 2}" y="${y - 5.5}" font-size="10.5" font-weight="800" text-anchor="middle" fill="#7C2D12">${label}</text></g>
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
        const tag = (x, y, w, t) => `<g transform="translate(${x + w / 2} ${y + 7.5}) scale(1.15) translate(${-(x + w / 2)} ${-(y + 7.5)})"><rect x="${x}" y="${y}" width="${w}" height="15" rx="4" fill="#FDE047" stroke="#A16207" stroke-width="1"/><text x="${x + w / 2}" y="${y + 11}" font-size="10.5" font-weight="800" text-anchor="middle" fill="#7C2D12" ${FONT}>${t}</text></g>`;
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
        front += `<text x="262" y="660" font-size="11.5" font-weight="900" text-anchor="middle" fill="#FFFFFF" ${FONT}>便利商店　24H</text>`;
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
        if (faState) return;           // 插旗動畫播放中：不要重畫地圖（會把動畫蓋掉）
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
        let avail = (advViewportH() - (r.top + window.scrollY) - 14) / k;   // 用頁面頂端算（不受目前捲動位置影響）
        let full = w * ADV_MAP_H / ADV_MAP_W;
        let h = Math.max(w * 1.15, Math.min(full * 1.15, avail));     // 可以比原本比例再高 15%，把手機畫面下方空間用滿
        box.style.height = Math.round(h) + 'px';
        advMapK = (h / w) * ADV_MAP_W / ADV_MAP_H;
    }
    window.addEventListener('resize', () => { try { if (document.getElementById('adventureView').classList.contains('active')) advRenderMap(); } catch (e) {} });
    try { if (window.visualViewport) window.visualViewport.addEventListener('resize', () => { try { if (document.getElementById('adventureView').classList.contains('active')) advRenderMap(); } catch (e) {} }); } catch (e) {}

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
        let lists = wordLists.map((l, originalIdx) => ({ ...l, originalIdx })).filter(l => getListWordCount(l.content) > 0 && isListInCurrentLang(l) && !(isPackList(l) && (WORD_PACKS[l.pack] || {}).kind === 'adv'));
        lists.forEach((list, displayIdx) => {
            let sel = advSelected.includes(list.originalIdx) ? 'selected' : '';
            grid.insertAdjacentHTML('beforeend', pickRowHTML(list, getListWordCount(list.content), sel, 'toggleAdvCard'));
        });
    }
    function toggleAdvCard(idx, cardEl) {
        let i = advSelected.indexOf(idx);
        if (i >= 0) advSelected.splice(i, 1); else advSelected.push(idx);
        cardEl.classList.toggle('selected', advSelected.includes(idx));
        try { localStorage.setItem(ADV_SEL_KEY, JSON.stringify(advSelected)); } catch (e) {}
        advRenderLevelPage();
    }
    function advSyncCustomTab() {
        let grid = document.getElementById('advGrid');
        if (!advCustomTab) advCustomTab = (grid && grid.querySelector('.select-card[data-kind="custom"]')) ? 'mine' : 'pack';
        pickSeg['advGrid'] = advCustomTab === 'pack' ? 'pack' : 'custom';
    }
    // 關卡副標：夜市篇・第 44–50 字／複習第 1–9 關・共 50 字
    function advHeroSub(lv) {
        let p = advPlanOf(lv.id), k = advAutoParts().night.length;
        if (!Array.isArray(p)) return `複習第 ${p.review[0]}–${p.review[1]} 關・共 ${advAutoWords(lv).length} 字`;
        return p[0] < k ? `夜市篇・第 ${p[0] + 1}–${p[1]} 字` : `便利商店篇・第 ${p[0] - k + 1}–${p[1] - k} 字`;
    }
    const ADV_WARN_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9.5 17h-19z"/><path d="M12 10v4"/></svg>';
    const ADV_SWORD_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 17.5L3 6V3h3l11.5 11.5"/><path d="M13 19l6-6M16 16l4 4M19 21l2-2"/></svg>';
    function advRenderLevelPage() {
        let lv = ADV_LEVELS.find(l => l.id === adv.pickLevel) || ADV_LEVELS[0];
        let auto = advMode() === 'auto';
        advSyncCustomTab();
        let words = auto ? advAutoWords(lv) : advGetWords();
        let n = words.length;
        if (!auto) setPickSummary('advStatsText', 'advGrid', n, words.filter(w => w.starred).length);
        advRenderModeBox(lv, auto);
        advSyncDaily();
        let ok = auto || n >= lv.minWords;       // 冒險題庫：每關的字數照關卡設計
        let tired = advData.hp <= 0;
        let max = advMaxHp(), hp = Math.max(0, Math.min(advData.hp, max));
        let isCleared = !!advData.cleared[lv.id];
        let canGo = ok && !tired;                // 已通關的關卡可以一直重複挑戰（每天前 3 次有通關獎勵）
        let used = advReplaysUsed(), cap = advReplayCap(), rewardLeft = Math.max(0, cap - used);
        let tag = '', off = false;
        if (!isCleared) tag = '<span class="aq-tag first">首勝</span>';
        else {
            off = rewardLeft <= 0;
            tag = off ? '<span class="aq-tag gone">今日已領完</span>' : `<span class="aq-tag today">今日 ${used} / ${cap}</span>`;
        }
        let rewards = advRewardList(lv).map(r => `<span class="aq-item" title="${escapeHTML(r.label)}"><span class="ic">${r.icon}</span>${r.text}</span>`);
        let warns = [];
        if (lv.special) warns.push(`<div class="aq-warn">${ADV_WARN_SVG}注意：${ADV_SPECIAL_TEXT[lv.special]}</div>`);
        if (tired) warns.push(`<div class="aq-warn bad">${ADV_WARN_SVG}雞塊沒有體力了，明天 00:00 恢復</div>`);
        let box = document.getElementById('advLevelCard');
        if (box) box.innerHTML = `
            <div class="aq-hero">
                <div class="aq-sprite">${advEnemySVG(lv.sprite)}</div>
                <div class="aq-info">
                    <div class="aq-lv"><span>第 ${lv.id} 關</span>${isCleared ? '<span class="aq-badge done"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>已通關</span>' : '<span class="aq-badge new">新關卡</span>'}</div>
                    <span class="aq-name">${escapeHTML(lv.name)}</span>
                    <span class="aq-sub">${auto ? advHeroSub(lv) : `自選題庫・至少 ${lv.minWords} 字`}</span>
                </div>
            </div>
            <div class="aq-cards">
                <div class="aq-hp"><span class="aq-k">體力</span><div class="aq-bar${hp / max < 0.34 ? ' low' : ''}"><i style="width:${(hp / max * 100).toFixed(0)}%"></i></div><span class="aq-num">${hp} <small>/ ${max}</small></span></div>
                <div class="aq-rw${off ? ' off' : ''}"><div class="aq-rw-head"><span class="aq-k">通關獎勵</span>${tag}</div><div class="aq-items">${rewards.join('')}</div></div>
            </div>
            ${warns.join('')}`;
        advUpdateGearAlerts();
        let st = document.getElementById('advStatsText');
        if (st && !auto) {
            if (!ok) st.insertAdjacentHTML('beforeend', `<br><span class="bad">這關至少要 ${lv.minWords} 個字（目前 ${n} 個）</span>`);
        } else if (st) st.innerHTML = '';
        let note = isCleared && rewardLeft <= 0 ? '<span class="aq-go-note">今天的通關獎勵領完了，再挑戰可以繼續累積招式熟練度</span>' : '';
        let bar = document.getElementById('advGoBar');
        if (bar) bar.innerHTML = `<button type="button" class="aq-start" ${canGo ? '' : 'disabled'} data-on-click='[["advStartBattle",[${lv.id}]]]'>${ADV_SWORD_SVG}開始戰鬥</button>${note}`;
    }
    // ── 大冒險預設題庫：跟著關卡（每關自動用前 N 個字）──
    const ADV_MODE_KEY = 'chicky_adv_mode';
    let advAutoCache = null;
    function advAutoParts() {
        if (!advAutoCache) advAutoCache = { night: parseWordsRaw(FREE_PACK_CONTENT.adv_night), store: parseWordsRaw(FREE_PACK_CONTENT.adv_store) };
        return advAutoCache;
    }
    function advAutoAll() { let p = advAutoParts(); return p.night.concat(p.store); }
    // 冒險題庫：每關考自己的新字；第 5、10、15、20 關複習前面幾關（[開始, 結束) 是在「夜市篇＋便利商店篇」裡的位置）
    const ADV_AUTO_PLAN = {
        1: [0, 6], 2: [6, 12], 3: [12, 18], 4: [18, 25], 5: { review: [1, 4] },
        6: [25, 31], 7: [31, 37], 8: [37, 43], 9: [43, 50], 10: { review: [1, 9] },
        11: [50, 60], 12: [60, 70], 13: [70, 80], 14: [80, 90], 15: { review: [11, 14] },
        16: [90, 100], 17: [100, 110], 18: [110, 120], 19: [120, 130], 20: { review: [11, 19] }
    };
    function advPlanOf(id) { return ADV_AUTO_PLAN[id] || [0, 6]; }
    function advIsReview(id) { return !Array.isArray(advPlanOf(id)); }
    function advLevelNew(id) { let p = advPlanOf(id); return Array.isArray(p) ? advAutoAll().slice(p[0], p[1]) : []; }
    function advAutoWords(lv) {               // 這關會考的字（一般關卡：這關的新字；複習關：範圍內所有關卡的字）
        let p = advPlanOf(lv.id);
        if (Array.isArray(p)) return advLevelNew(lv.id);
        let out = [];
        for (let k = p.review[0]; k <= p.review[1]; k++) if (!advIsReview(k)) out = out.concat(advLevelNew(k));
        return out;
    }
    function advOldWords(lv) {                // 之前關卡學過的字（一般關卡中間穿插複習用）
        let out = [];
        for (let k = 1; k < lv.id; k++) if (!advIsReview(k)) out = out.concat(advLevelNew(k));
        return out;
    }
    function advRangeText(lv) {
        let p = advPlanOf(lv.id), k = advAutoParts().night.length;
        if (!Array.isArray(p)) return `複習第 ${p.review[0]}～${p.review[1]} 關的 ${advAutoWords(lv).length} 個字`;
        return p[0] < k ? `夜市篇第 ${p[0] + 1}～${p[1]} 個字` : `便利商店篇第 ${p[0] - k + 1}～${p[1] - k} 個字`;
    }
    function advAutoDesc(lv) { return advRangeText(lv); }
    function advCanAuto() { return getLearningLanguage() !== 'ko'; }      // 韓文版的冒險題庫之後再做
    let advCustomTab = '';      // 自選時看的是「精選單字庫」還是「自訂題庫」
    function advMode() {
        if (!advCanAuto()) return 'custom';
        let m = null, had = false;
        try { m = localStorage.getItem(ADV_MODE_KEY); had = localStorage.getItem(ADV_SEL_KEY) !== null; } catch (e) {}
        if (m === 'auto' || m === 'custom') return m;
        return had ? 'custom' : 'auto';         // 已經自己勾過範圍的舊玩家維持自選
    }
    function advSetMode(m) {
        if (m === 'pack' || m === 'mine') { advCustomTab = m; m = 'custom'; }
        try { localStorage.setItem(ADV_MODE_KEY, m === 'custom' ? 'custom' : 'auto'); } catch (e) {}
        pickSeg['advGrid'] = advCustomTab === 'pack' ? 'pack' : 'custom';
        advRenderLevelPage();
    }
    function advWrongOf(eng) { return (advData.wrongCnt || {})[String(eng || '').toLowerCase()] || 0; }
    // 出題題庫：冒險題庫（推薦）／精選單字庫／自訂題庫（單選；自選時下面會出現題庫清單）
    function advRenderModeBox(lv, auto) {
        let seg = document.getElementById('advModeSeg'), cus = document.getElementById('advCustomBox');
        if (!seg || !cus) return;
        let grid = document.getElementById('advGrid');
        let cnt = k => grid ? grid.querySelectorAll(`.select-card.selected[data-kind="${k}"]`).length : 0;
        let cur = auto ? 'auto' : (advCustomTab === 'pack' ? 'pack' : 'mine');
        let opt = (key, name, extra) => `<button type="button" class="aq-opt${cur === key ? ' on' : ''}" role="radio" aria-checked="${cur === key}" data-on-click='[["advSetMode",["${key}"]]]'><span class="aq-ring"><i></i></span><span class="aq-opt-name">${name}</span>${extra || ''}</button>`;
        let html = '';
        if (advCanAuto()) {
            let words = advAutoWords(lv), last = ((advData.lastWrong || {})[lv.id] || []).length;
            let key = (Array.isArray(advPlanOf(lv.id)) ? advPlanOf(lv.id)[0] : advPlanOf(advPlanOf(lv.id).review[0])[0]) < advAutoParts().night.length ? 'adv_night' : 'adv_store';
            html += opt('auto', `冒險・${(WORD_PACKS[key].title || '').replace(/^冒險・/, '')}`, `<span class="aq-rec">推薦</span>${auto ? `<span class="aq-link">${last ? `<span class="cnt">上次錯 <b>${last}</b> 個</span>` : ''}<span class="go" role="link" data-on-click='[["$stop",[]],["advOpenWords",[]]]'>看單字<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg></span></span>` : ''}`);
        }
        let sb = n => (n && !auto) ? `<span class="aq-badge-sel">已選 ${n}</span>` : '';
        html += opt('pack', '精選單字庫', sb(cnt('pack'))) + opt('mine', '自訂題庫', sb(cnt('custom')));
        seg.innerHTML = html;
        cus.hidden = auto;
    }
    // 這關會考的字：新增的在上面、之前學過的在下面
    function advOpenWords() {
        let lv = ADV_LEVELS.find(l => l.id === adv.pickLevel) || ADV_LEVELS[0];
        let all = advAutoWords(lv);
        let row = (w, i) => `<div class="aw-row"><span class="aw-no">${i + 1}</span><span class="aw-tx"><b>${escapeHTML(w.english)}</b><span class="cn">${escapeHTML(w.chinese || '')}</span>${advWrongOf(w.english) ? `<span class="aw-bad">錯 ${advWrongOf(w.english)} 次</span>` : ''}</span><button type="button" class="aw-say" aria-label="聽發音" data-on-click='[["advSayWord",[${JSON.stringify(w.english).replace(/'/g, '&#39;')}]]]'>🔊</button></div>`;
        let html = '';
        let p = advPlanOf(lv.id);
        if (Array.isArray(p)) html = `<div class="aw-sec new">這關的 ${all.length} 個新字</div><div class="aw-box">${all.map((w, i) => row(w, i)).join('')}</div>`;
        else {
            html = `<div class="aw-sec">複習關：考第 ${p.review[0]}～${p.review[1]} 關的 ${all.length} 個字，答錯過的字會先考</div>`;
            for (let k = p.review[0]; k <= p.review[1]; k++) {
                if (advIsReview(k)) continue;
                let ws = advLevelNew(k), lvk = ADV_LEVELS.find(l => l.id === k);
                html += `<div class="aw-sec">第 ${k} 關${lvk ? '・' + lvk.name : ''}</div><div class="aw-box">${ws.map((w, i) => row(w, i)).join('')}</div>`;
            }
        }
        document.getElementById('advWordsTitle').textContent = `📖 第 ${lv.id} 關會考的字（${all.length}）`;
        document.getElementById('advWordsBody').innerHTML = html;
        switchView('advWordsView');
        window.scrollTo(0, 0);
    }
    function advSayWord(t) { advSpeakWord(String(t || '')); }
    // 用一組字直接開始練習（字卡或聽力），練完回到原本的頁面
    var advPrac = null;
    function advStartPractice(words, kind, back) {
        if (!words || !words.length) return;
        advPrac = { back };
        if (kind === 'listen') {
            goToPracticePage();
            document.getElementById('wordList').value = words.map(w => w.rawLine || w.line).join('\n');
            startDictation();
        } else {
            requestWakeLock();
            flashcardActiveList = words.slice();
            currentFcIndex = 0;
            switchView('flashcardPlayView');
            updateFlashcardView();
        }
    }
    function advPracDone() {       // 從練習頁返回：有 advPrac 就回到大冒險
        if (!advPrac) return false;
        let back = advPrac.back;
        advPrac = null;
        try { loadPracticeSelectedContent(); } catch (e) {}
        releaseWakeLock();
        back();
        return true;
    }
    function advPracticeLevel(kind) {
        let lv = ADV_LEVELS.find(l => l.id === adv.pickLevel) || ADV_LEVELS[0];
        advStartPractice(advAutoWords(lv), kind, () => advOpenWords());
    }
    // 戰鬥中答錯的字
    function advNoteWrong(w) {
        if (!w || !w.english) return;
        if (!adv.wrongThis) adv.wrongThis = [];
        if (!adv.wrongThis.some(x => x.english === w.english)) adv.wrongThis.push(w);
        let k = String(w.english).toLowerCase();
        if (!advData.wrongCnt) advData.wrongCnt = {};
        advData.wrongCnt[k] = (advData.wrongCnt[k] || 0) + 1;
        let keys = Object.keys(advData.wrongCnt);
        if (keys.length > 400) delete advData.wrongCnt[keys[0]];      // 最多記 400 個字
    }
    function advSaveLastWrong() {
        if (!adv.level) return;
        if (!advData.lastWrong) advData.lastWrong = {};
        advData.lastWrong[adv.level.id] = (adv.wrongThis || []).map(w => w.english).slice(0, 50);
    }
    function advWrongHTML() {
        let ws = adv.wrongThis || [];
        if (!ws.length) return '';
        return `<div class="aw-wrong"><div class="aw-sec">這場答錯的字（${ws.length}）</div>
            <div class="aw-box">${ws.map(w => `<div class="aw-row"><span class="aw-tx"><b>${escapeHTML(w.english)}</b><span class="cn">${escapeHTML(w.chinese || '')}</span></span><button type="button" class="aw-say" aria-label="聽發音" data-on-click='[["advSayWord",[${JSON.stringify(w.english).replace(/'/g, '&#39;')}]]]'>🔊</button></div>`).join('')}</div></div>`;
    }
    function advWrongPick() {
        let el = document.getElementById('advWrongAct');
        if (el) el.innerHTML = `<div class="aw-pick"><button type="button" class="adv-plain-btn main" data-on-click='[["advWrongPractice",["card"]]]'>🃏 字卡練習</button><button type="button" class="adv-plain-btn main" data-on-click='[["advWrongPractice",["listen"]]]'>🎧 聽力練習</button></div>`;
    }
    function advWrongPractice(kind) {
        let ws = (adv.wrongThis || []).slice(), lvId = adv.level ? adv.level.id : (adv.pickLevel || 1);
        advStartPractice(ws, kind, () => goToAdvLevel(lvId));
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
        // 改版（經驗值系統）後第一次進大冒險：說明進度重新開始
        if (advData.resetNotice) {
            advData.resetNotice = false; advSave(true);
            setTimeout(() => alert('🐣 雞塊大冒險改版了！\n\n糖醋醬改成「升級加點」：打贏敵人得經驗值，每升 1 級得 1 點能力點；碎片改名為「冒險代幣」。\n\n因為系統大改，大冒險的進度、道具、裝備、能力都重新開始，傳說招式回到補給站。'), 300);
        }
        advAbort();
        advSyncDaily();
        advMapChapter = advChapterOf(fromLevel === true && adv.pickLevel ? adv.pickLevel : advHighestUnlocked());
        switchView('adventureView');
        advRenderMap();
        // 手機：從首頁進來時網址列可能正在展開／收起，等畫面穩定後再量一次地圖高度
        setTimeout(() => { try { if (document.getElementById('adventureView').classList.contains('active')) advRenderMap(); } catch (e) {} }, 350);
    }
    // 畫面可用的高度：取「網址列展開時」的最小高度，避免地圖下面被切掉
    function advViewportH() {
        let h = window.innerHeight;
        try { if (window.visualViewport) h = Math.min(h, window.visualViewport.height); } catch (e) {}
        try {
            if (window.CSS && CSS.supports && CSS.supports('height', '100svh')) {
                let p = document.createElement('div');
                p.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:100svh;visibility:hidden;pointer-events:none';
                document.body.appendChild(p);
                let sv = p.getBoundingClientRect().height;
                p.remove();
                if (sv > 0) h = Math.min(h, sv);
            }
        } catch (e) {}
        return h;
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
    const ADV_BAR_MAX = 10;
    function goToAdvStats(tab) {
        advAlloc = null;
        advStatsTab = ['moves', 'gear', 'bag'].indexOf(tab) !== -1 ? tab : 'stats';   // 每次進來預設「基本素質」
        advAbort();
        advSyncDaily();
        advRenderStatsPage();
        switchView('advStatsView');
        requestAnimationFrame(advFitMoveGrid);
    }
    // 糖醋醬碎片的圖示（顏色 = 糖醋醬的顏色）
    function advShardIcon(size) {
        size = size || 16;
        // 冒險代幣：金色拼圖（跟劍柄同一組金色）
        return `<svg class="adv-shard-ico" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" style="vertical-align:-3px;"><path d="M3.5 6.5 H8.6 A2.6 2.6 0 1 1 13.8 6.5 H19 V11.4 A2.6 2.6 0 1 1 19 16.6 V21.5 H13.8 A2.6 2.6 0 1 0 8.6 21.5 H3.5 V16.6 A2.6 2.6 0 1 0 3.5 11.4 Z" fill="#FBBF24" stroke="#92400E" stroke-width="1.5" stroke-linejoin="round"/><path d="M5.5 8.6 H8.8 M5.5 8.6 V11" stroke="#FEF3C7" stroke-width="1.4" stroke-linecap="round"/></svg>`;
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
    function advSetStatsTab(t) { advStatsTab = ['moves', 'gear', 'bag'].indexOf(t) !== -1 ? t : 'stats'; if (t === 'bag') { advBagGearOnly = false; advBagSlot = null; advBagFilter = 'all'; advBagSel = ''; } advRenderStatsPage(); }
    // ═════════ 雞塊能力值頁（chicky-stats：樣式 .st-*）═════════
    const ST_COIN = '<svg class="st-coin" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#fbbf24" stroke="#b45309" stroke-width="1.6"/><circle cx="12" cy="12" r="6.5" fill="none" stroke="#f59e0b" stroke-width="1.4"/><path d="M12 8.5v7" stroke="#b45309" stroke-width="1.8" stroke-linecap="round"/></svg>';
    const ST_INFO = '<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M12 11v6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="7.5" r="1.3" fill="currentColor"/></svg>';
    const ST_TAB_ICONS = {
        stats: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 20V12M12 20V5M19 20v-9"/></svg>',
        moves: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 17.5L3 6V3h3l11.5 11.5"/><path d="M13 19l6-6M16 16l4 4M19 21l2-2"/></svg>',
        bag: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6a3 3 0 016 0"/><rect x="4" y="6" width="16" height="15" rx="3.5"/><path d="M4 11h16"/><rect x="10" y="9" width="4" height="4" rx="1"/></svg>',
        gear: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/></svg>'
    };
    // 命中加成的狀態：ready＝三種都答滿 20 題；on＝而且總命中 ≥ 90%
    function stCritState() {
        let ready = advCritReady(), p = advHitPct(advHitAll());
        return { ready, p, on: ready && p !== null && p >= ADV_CRIT_AT, gap: ready && p !== null ? Math.max(0, ADV_CRIT_AT - p) : null };
    }
    function stCritLabel(c) {
        if (c.on) return `<span class="st-crit st-crit--on" aria-label="爆擊判定 +1">${ST_COIN}+1</span>`;
        if (c.ready) return `<span class="st-crit st-crit--off">${ST_COIN}差 ${c.gap}% 獲得能力加成</span>`;
        return `<span class="st-crit st-crit--off">${ST_COIN}攻擊時 +1 爆擊判定</span>`;
    }
    // ── 加點模式 ──
    let advAlloc = null;            // 預覽中的加點 { hp: 1, atk: 0, ... }；null = 平常
    function advAllocUsed() { return advAlloc ? Object.values(advAlloc).reduce((t, v) => t + v, 0) : 0; }
    function advLvTap() {
        if (advAlloc) return;
        if (advPtsLeft() < 1) {
            let a = document.getElementById('stLvArea');
            if (!a || a.querySelector('.st-lv__tip')) return;
            let t = document.createElement('span');
            t.className = 'st-lv__tip';
            t.textContent = '升級後就能加點喔！';
            a.appendChild(t);
            setTimeout(() => t.remove(), 1500);
            return;
        }
        advStatsTab = 'stats';
        advAlloc = { hp: 0, atk: 0, agi: 0, def: 0, int: 0, luck: 0 };
        advRenderStatsPage();
    }
    function advAllocAdd(key) {
        if (!advAlloc || advPtsLeft() - advAllocUsed() < 1) return;
        if (advData.up[key] + advAlloc[key] >= advUpMax(key)) return;
        advAlloc[key]++;
        advRenderStatsPage();
    }
    function advAllocCancel() { advAlloc = null; advRenderStatsPage(); }
    function advAllocOk() {
        if (!advAlloc || !advAllocUsed()) return;
        advSyncDaily();
        Object.keys(advAlloc).forEach(k => {
            let n = Math.min(advAlloc[k], advUpMax(k) - advData.up[k], advPtsLeft());
            if (n > 0) { advData.up[k] += n; if (k === 'hp') advData.hp = (advData.hp === null ? advMaxHp() - n : advData.hp) + n; }
        });
        advAlloc = null;
        advSave();
        advRenderStatsPage();
    }
    function advRenderStatsPage() {
        let s = advPlayerStats();
        let pct = v => Math.min(100, Math.max(0, v) / ADV_BAR_MAX * 100).toFixed(1) + '%';   // 所有能力條共用同一把尺；超過上限停在滿格，數字照實顯示
        let c = stCritState();
        let nav = document.getElementById('advNavCounts');
        if (nav) nav.innerHTML = `<span class="st-gem">${advShardIcon(20)}<span id="advShardCount2">${advData.shards}</span></span>`;
        let box = document.getElementById('advStatsBox');
        if (!box) return;
        box.dataset.crit = c.on ? 'on' : 'off';
        let oldGrid = document.getElementById('advMoveGrid'), keepScroll = oldGrid ? oldGrid.scrollTop : 0;
        // 命中區
        let hitTxt = c.p === null ? '—' : c.p + '%';
        let hit = `<div class="st-section-head"><span class="st-section-title">命中 ${stCritLabel(c)}</span>
                <button class="st-info" type="button" data-on-click='[["advOpenHit",[]]]'>${ST_INFO}說明</button></div>
            <button class="st-row st-row--hit" type="button" data-on-click='[["advOpenHit",[]]]'>
                <span class="st-box"><span class="st-box__label">命中</span><span class="st-box__value">${hitTxt}</span></span>
                <span class="st-hitbar"><span class="st-bar"><i style="width:${c.p === null ? 0 : c.p}%"></i></span><span class="st-threshold" title="90% 爆擊門檻"></span></span>
            </button>`;
        // 能力區
        let shield = advShieldMax(s.int + advGearBonus('int')) + ((advData.gear || []).includes('bag') ? ADV_BAG_SHIELD : 0);   // 裝備加的護盾（夜市塑膠袋 +1）也算進來
        let cur = Math.max(0, Math.min(advData.hp, s.hp));
        let al = advAlloc, alLeft = al ? advPtsLeft() - advAllocUsed() : 0;
        // 加點模式：每一行右邊有「＋」；按了只是預覽（紫色 +N、能力條多一段紫色）
        let plusBtn = key => {
            if (!al) return '';
            let can = alLeft > 0 && (advData.up[key] + (al[key] || 0)) < advUpMax(key);
            return `<button type="button" class="st-plus" ${can ? '' : 'disabled'} aria-label="加 1 點" data-on-click='[["advAllocAdd",["${key}"]]]'>＋</button>`;
        };
        let row = (key, label, value, bar, extra, above) => al
            ? `<div class="st-row st-row--alloc"><span class="st-box"><span class="st-box__label">${label}</span><span class="st-box__value">${value}</span>${extra || ''}</span><span class="st-barwrap">${above || ''}${bar}</span>${plusBtn(key)}</div>`
            : `<button class="st-row" type="button" data-on-click='[["advOpenStatInfo",["${key}"]]]'>
                <span class="st-box"><span class="st-box__label">${label}</span><span class="st-box__value">${value}</span>${extra || ''}</span><span class="st-barwrap">${above || ''}${bar}</span></button>`;
        let preview = k => { if (!al || !al[k]) return ''; let b = (k === 'hp' ? s.hp : s[k] + advGearBonus(k)); return `<i class="st-bar-add" style="left:${pct(b)};width:${(Math.min(100, (b + al[k]) / ADV_BAR_MAX * 100) - Math.min(100, b / ADV_BAR_MAX * 100)).toFixed(1)}%"></i>`; };
        let gearBar = (k) => {
            // 綠色＝自己的能力，紫色＝裝備加的（接在後面）
            let gb = advGearBonus(k), base = Math.max(0, s[k]), tot = base + gb;
            return `<span class="st-bar"><i style="width:${pct(base)}"></i>${gb ? `<i class="st-bar-gear" style="left:${pct(base)};width:${(Math.min(100, tot / ADV_BAR_MAX * 100) - Math.min(100, base / ADV_BAR_MAX * 100)).toFixed(1)}%"></i>` : ''}${preview(k)}</span>`;
        };
        let addTag = k => al && al[k] ? `<small class="st-add-plus">+${al[k]}</small>` : '';
        let val = k => { let gb = advGearBonus(k); return `${s[k]}${gb ? `<small class="st-gear-plus">+${gb}</small>` : ''}${addTag(k)}`; };
        // 攻擊的爆擊判定：命中加成 1 個＋幸運每 2 點 1 個（最多 3）→ 硬幣排在攻擊條上方
        let critN = (c.on ? 1 : 0) + Math.min(ADV_LUCK_CAP, BattleCore.luckDice(s.luck, 0));
        let coins = critN ? `<span class="st-coins" role="img" aria-label="爆擊判定 ${critN} 次">${ST_COIN.repeat(critN)}</span>` : '';
        let rows = [
            row('hp', 'HP', `${cur}/${s.hp}${addTag('hp')}`,
                `<span class="st-hpbars">${shield ? `<span class="st-shieldbar"><i style="width:${pct(shield)}"></i></span>` : ''}<span class="st-bar${cur / s.hp < 0.3 ? ' is-low' : ''}"><i style="width:${pct(cur)}"></i>${preview('hp')}</span></span>`,
                shield ? `<span class="st-badge-shield" title="護盾 ${shield}"><svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l9 3.5v6.5c0 5-3.8 9-9 10-5.2-1-9-5-9-10V5.5z" fill="#fff"/></svg>${shield}</span>` : ''),
            row('atk', '攻擊', val('atk'), gearBar('atk'), '', coins),
            row('agi', '敏捷', val('agi'), gearBar('agi')),
            row('def', '防禦', val('def'), gearBar('def')),
            row('int', '智慧', val('int'), gearBar('int')),
            row('luck', '幸運', val('luck'), gearBar('luck'))
        ].join('');
        let allocTag = al ? `<span class="st-alloc-tag">${advAllocUsed() ? `還剩 ${alLeft} 點` : `可分配 ${alLeft} 點`}</span>` : '';
        let statsBody = `${al ? '' : hit + '<hr class="st-divider">'}
            <div class="st-section-head"><span class="st-section-title">能力${allocTag}</span><span class="st-head-btns"><button class="st-info" type="button" data-on-click='[["advOpenStatInfo",[""]]]'>${ST_INFO}說明</button></span></div>
            ${rows}
            ${al ? `<div class="st-alloc-btns"><button type="button" class="st-alloc-cancel" data-on-click='[["advAllocCancel",[]]]'>取消</button><button type="button" class="st-alloc-ok" ${advAllocUsed() ? '' : 'disabled'} data-on-click='[["advAllocOk",[]]]'>確定</button></div>` : ''}`;
        let tab = (k, label, alert) => `<button type="button" role="tab" class="st-tab" aria-selected="${advStatsTab === k}" data-on-click='[["advSetStatsTab",["${k}"]]]'>${label}${alert || ''}</button>`;
        let body = advStatsTab === 'moves' ? advMovesTabHTML() : advStatsTab === 'gear' ? advGearTabHTML() : advStatsTab === 'bag' ? '<div id="advBagInline" class="st-bag"></div>' : statsBody;
        // 等級區：Lv 方塊＋經驗值條＋「目前 / 升級所需」；有點數時 Lv 方塊右上角紅點
        let li = advLevelInfo(), pts = advPtsLeft();
        let bounce = advData.lvUpAt && advData.lvUpAt > (advData.lvSeenAt || 0);
        let lvArea = `<button type="button" class="st-lv${pts ? ' has-pts' : ''}" id="stLvArea" aria-label="等級 ${li.lv}${pts ? `，可分配 ${pts} 點` : ''}" data-on-click='[["advLvTap",[]]]'>
                <span class="st-lv__box"><small>Lv</small>${li.lv}${pts ? `<span class="st-lv__dot${bounce ? ' bounce' : ''}">${pts}</span>` : ''}</span>
                <span class="st-lv__bar"><i style="width:${li.pct.toFixed(1)}%"></i></span>
                <span class="st-lv__num">${li.max ? 'MAX' : `${li.xp - li.prev} / ${li.next - li.prev}`}</span>
            </button>`;
        if (bounce) { advData.lvSeenAt = Date.now(); advSave(true); }
        box.classList.toggle('is-alloc', !!al);
        box.innerHTML = `
            <section class="st-hero">
                <div class="st-avatar">${advChickenSVG()}</div>
                ${lvArea}
                <div class="st-items">${[0, 1].map(i => advMiniGearHTML(i)).join('')}</div>
            </section>
            <div class="st-main">
                <nav class="st-tabs" role="tablist">${tab('stats', '基本素質')}${tab('moves', '招式', advAnyUnseenMove() ? ADV_NEW_ALERT : '')}${tab('bag', '背包', advAnyUnseenGear() ? ADV_NEW_ALERT : '')}${tab('gear', '裝備', advGearAlert() ? ADV_ALERT : '')}</nav>
                <section class="st-panel${advStatsTab === 'stats' ? '' : ' st-panel--other'}" role="tabpanel">${body}</section>
            </div>`;
        if (advStatsTab === 'bag') advBagBack();
        let g = document.getElementById('advMoveGrid');
        if (g) g.scrollTop = keepScroll;
        advFitMoveGrid();
        advBindMoveSwipe();
        advCarDir = 0;
        advUpdateGearAlerts();
    }
    // ── 招式分頁：上面用下拉選單篩選，中間左右輪播（一次看一招），下面是詳細資料 ──
    const ADV_MOVE_FILTERS = [['all', '全部'], ['eq', '已裝備'], ['card', '字卡'], ['listen', '聽力'], ['speed', '速答']];
    let advCarDir = 0;              // 剛剛往哪邊切換（做滑入動畫用）
    function advMoveShown() {
        let owned = ADV_MOVES.filter(m => advOwns(m.key));
        if (advMoveFilter === 'all') return owned;
        if (advMoveFilter === 'eq') { let eq = advEquipped().map(m => m.key); return owned.filter(m => eq.includes(m.key)); }
        return owned.filter(m => m.type === advMoveFilter);
    }
    function advCarTri(rot) { return `<svg viewBox="0 0 24 24" width="24" height="24" style="transform:rotate(${rot}deg)" aria-hidden="true"><path d="M7 3 L19 12 L7 21 Z" fill="currentColor" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"/></svg>`; }
    function advMovesTabHTML() {
        let eqKeys = advEquipped().map(m => m.key);
        let ownedMoves = ADV_MOVES.filter(m => advOwns(m.key));
        let shown = advMoveShown(), n = shown.length;
        if (!advMoveFocus || !shown.some(m => m.key === advMoveFocus)) advMoveFocus = n ? (shown.find(m => eqKeys.includes(m.key)) || shown[0]).key : (eqKeys[0] || (ownedMoves[0] ? ownedMoves[0].key : ''));
        let idx = shown.findIndex(m => m.key === advMoveFocus);
        if (advMoveFocus) advMarkSeen('m', advMoveFocus);     // 正在看的這招：算看過了
        let car;
        if (!n) {
            car = `<div class="adv-car adv-car-empty" id="advMoveGrid"><div class="adv-note" style="margin:0;">${advMoveFilter === 'eq' ? '還沒有裝備招式' : `還沒有${ADV_TYPE_LABEL[advMoveFilter]}類的招式`}</div></div>`;
        } else {
            let m = shown[idx], mi = advMasteryInfo(m.key), on = eqKeys.includes(m.key);
            let L = n >= 3 ? shown[(idx - 1 + n) % n] : null, R = n >= 2 ? shown[(idx + 1) % n] : null;
            let side = (x, d) => x ? `<button type="button" class="adv-car-side rar-${advRarityKey(x.key)}" title="${x.name}" aria-label="${x.name}" data-on-click='[["advMoveStep",[${d}]]]'>${x.icon}${advMoveUnseen(x.key) ? ADV_NEW_ALERT : ''}</button>` : '<span class="adv-car-side ghost"></span>';
            car = `<div class="adv-car" id="advMoveGrid">
                <button type="button" class="adv-car-arr${n < 2 ? ' off' : ''}" aria-label="上一招" data-on-click='[["advMoveStep",[-1]]]'>${advCarTri(180)}</button>
                ${side(L, -1)}
                <div class="adv-move-card adv-car-center focus rar-${advRarityKey(m.key)}${on ? ' selected' : ''}${advCarDir ? (advCarDir > 0 ? ' go-r' : ' go-l') : ''}" data-move="${m.key}">
                    <span class="adv-rar-tag rar-${advRarityKey(m.key)}">${ADV_RARITY_SKILL[advRarityKey(m.key)]}</span>
                    ${on ? '<span class="adv-eq-tag">已裝備</span>' : ''}
                    <span class="ic">${m.icon}</span>
                    <b>${m.name}${mi.lvl ? ` <span class="adv-lv-chip">Lv.${mi.lvl}</span>` : ''}</b>
                </div>
                ${side(R, 1)}
                <button type="button" class="adv-car-arr${n < 2 ? ' off' : ''}" aria-label="下一招" data-on-click='[["advMoveStep",[1]]]'>${advCarTri(0)}</button>
                <div class="adv-car-dots">${shown.map((x, i) => `<i class="${i === idx ? 'on' : ''}${i !== idx && advMoveUnseen(x.key) ? ' new' : ''}"></i>`).join('')}</div>
            </div>
            <div class="adv-car-hint">（${idx + 1} / ${n}）</div>`;
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
        let c = m.mode === 'speed' ? advSpeedCfg(m) : null;
        let statsHTML = c ? `
            <div class="adv-md-stats">
                <div>類型<b>速答</b></div>
                <div>秒數<b>${c.secs}${mi.lvl ? `<em>+${mi.lvl * m.speed.lvSecs}</em>` : ''}</b></div>
                <div>${c.stat === 'int' ? '智慧' : '攻擊'}上限<b>+${c.cap}</b></div>
                <div>配錯<b>−${c.pen} 秒</b></div>
            </div>` : '';
        if (c) return statsHTML + `
            <div class="adv-md-desc">${m.desc}</div>
            <div class="adv-md-mastery">
                <div class="adv-md-mrow"><span>熟練度 <b>${mi.lvl}</b>${mi.maxed ? '<small class="max">（Max）</small>' : ''}</span><small class="prog">${prog}</small></div>
                <div class="adv-bar adv-md-bar"><i style="width:${pct.toFixed(1)}%;background:${r.color}"></i></div>
            </div>
            <button type="button" class="adv-md-btn${on ? ' off' : ''}" data-on-click='[["advToggleMove",["${key}"]]]'>${on ? '卸下這招' : '裝備這招'}</button>`;
        return `
            <div class="adv-md-stats">
                <div>類型<b>${ADV_TYPE_LABEL[m.type]}</b></div>
                <div>威力<b>${m.power}${mi.lvl ? `<em>+${mi.lvl * advMasteryPerLv(key)}</em>` : ''}</b></div>
                <div>攻擊次數<b>${m.hits}</b></div>
                <div>題數<b>${m.q}</b></div>
            </div>
            <div class="adv-md-desc">${m.desc}</div>
            <div class="adv-md-mastery">
                <div class="adv-md-mrow"><span>熟練度 <b>${mi.lvl}</b>${mi.maxed ? '<small class="max">（Max）</small>' : ''}</span><small class="prog">${prog}</small></div>
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
    function advSeen() {
        if (!advData.seen) {
            advData.seen = { m: {}, g: {}, init: 1 };
            ADV_MOVES.forEach(m => { if (advOwns(m.key)) advData.seen.m[m.key] = 1; });
            Object.keys(ADV_ITEMS).forEach(k => { if (advData.items[k]) advData.seen.g[k] = 1; });
            advSave(true);
        }
        return advData.seen;
    }
    function advMoveUnseen(key) { return advOwns(key) && !advSeen().m[key]; }
    function advGearUnseen(key) { return !!(ADV_ITEMS[key] && advData.items[key]) && !advSeen().g[key]; }
    function advAnyUnseenMove() { return ADV_MOVES.some(m => advMoveUnseen(m.key)); }
    function advAnyUnseenGear() { return Object.keys(ADV_ITEMS).some(k => advGearUnseen(k)); }
    function advMarkSeen(kind, key) {
        let sn = advSeen();
        if (!key || sn[kind][key]) return false;
        sn[kind][key] = 1;
        advSave(true);
        setTimeout(advUpdateGearAlerts, 0);
        return true;
    }
    function advGearAlert() {
        let g = advData.gear;
        if (g.every(Boolean)) return false;
        return Object.keys(ADV_ITEMS).some(k => advData.items[k] && !g.includes(k));
    }
    const ADV_ALERT = '<span class="adv-alert" aria-label="還可以裝備">!</span>';
    const ADV_NEW_ALERT = '<span class="adv-alert" aria-label="有新的">!</span>';
    function advUpdateGearAlerts() {
        // 能力值按鈕的紅色驚嘆號：有空的裝備欄可以裝、有還沒分配的能力點、有新的招式或裝備還沒看過
        let on = false;
        try { on = advGearAlert() || advPtsLeft() > 0 || advAnyUnseenMove() || advAnyUnseenGear(); } catch (e) {}
        document.querySelectorAll('.adv-btn-sm[data-on-click*="goToAdvStats"], .aq-stat-btn').forEach(b => {
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
            if (e === -1) { advOpenReplace('gear', key); return; }      // 兩格都有裝備：選一個替換
            g[e] = key;
        }
        advSave();
        if (fromSlot) advCloseBag();
        advRenderStatsPage();
        if (!fromSlot) advBagBack();
    }
    // ── 命中：能力值頁最上面一條；點進去看字卡／聽力／朗讀 ──
    function advHitRowHTML() {
        let a = advHitAll(), t = advHitTotal();
        let tile = t === null ? `<div class="adv-stat-tile hit">命中<b class="wait">累積中</b></div>` : `<div class="adv-stat-tile hit">命中<b>${t}%</b></div>`;
        let bar = t === null
            ? `<div class="adv-bar"><i class="adv-hit-wait" style="width:${(Math.min(a.length, ADV_HIT_N) / ADV_HIT_N * 100).toFixed(1)}%"></i></div>`
            : `<div class="adv-bar"><i style="width:${t}%;background:#EAB308"></i></div>`;
        return `<div class="adv-stat-row adv-hit-row" data-stat="hit" role="button" title="點一下看字卡、聽力、速答的命中" data-on-click='[["advOpenHit",[]]]'>${tile}${bar}<span class="adv-hit-chev">›</span></div>`;
    }
    // ── 能力介紹（固定位置的彈出視窗；從某一行點進來 → 那一項高亮）──
    const ADV_STAT_INFO_LIST = [
        ['hp', 'HP', '#10b981', '每上升一點，HP 上限 +1。'],
        ['shield', '護盾', '#0ea5e9', '先扣護盾再扣 HP，戰鬥結束後回滿護盾。'],
        ['atk', '攻擊', '#f43f5e', '每上升一點，攻擊 +1。'],
        ['agi', '敏捷', '#3b82f6', '每比對手高 2 點，一回合多攻擊一次。'],
        ['def', '防禦', '#f59e0b', '每點減 1 傷害，至少受 1 點。'],
        ['int', '智慧', '#14b8a6', '每 2 點 +1 護盾（最多 5），比對手低時作答時間會變短。'],
        ['luck', '幸運', '#a855f7', '每比對手高 2 點多 1 次爆擊判定（最多 3 次）。']
    ];
    const ST_CLOSE = '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/></svg>';
    function stModalOpen(inner) {
        let m = document.getElementById('stModal');
        if (!m) { m = document.createElement('div'); m.id = 'stModal'; m.className = 'st-modal'; m.setAttribute('data-on-click', '[["stModalBg",["$event"]]]'); document.body.appendChild(m); }
        m.innerHTML = `<section class="st-dialog" role="dialog" aria-modal="true">${inner}</section>`;
        m.hidden = false;
    }
    function stModalClose() { let m = document.getElementById('stModal'); if (m) { m.hidden = true; m.innerHTML = ''; } }
    function stModalBg(e) { if (e && e.target && e.target.id === 'stModal') stModalClose(); }
    function stDialogHead(title, sub) {
        return `<header class="st-dialog__head"><h2 class="st-dialog__title"><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</h2><button class="st-close" type="button" aria-label="關閉" data-on-click='[["stModalClose",[]]]'>${ST_CLOSE}</button></header>`;
    }
    function advOpenStatInfo(key) {
        stModalOpen(stDialogHead('📖 能力介紹') + `<ul class="st-guide">${ADV_STAT_INFO_LIST.map(r => `<li class="${r[0] === key ? 'is-active' : ''}"><span class="st-tag" style="background:${r[2]}">${r[1]}</span><p>${r[3]}</p></li>`).join('')}</ul>`);
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
    const ADV_HIT_KINDS = ['card', 'listen', 'speed'];     // 命中分三類：字卡、聽力、速答（朗讀招式隱藏後改算速答）
    const ADV_HIT_TIPS = { card: '「字卡練習」或「字卡測驗」', listen: '「聽力練習」或「聽力測驗」', speed: '大冒險的速答招式' };
    function advOpenHit() {
        let a = advHitAll(), cur = advHitPct(a), c = stCritState();
        let numTxt = cur === null ? '—' : cur + '%';
        let diffTxt = '';
        if (cur !== null && advData.hitPrev !== null && advData.hitPrev !== undefined) {
            let d = cur - advData.hitPrev;
            if (d) diffTxt = `<span class="st-total__diff ${d < 0 ? 'is-down' : 'is-up'}">${d < 0 ? '↓' : '↑'} 比上次 ${d > 0 ? '+' : ''}${d}%</span>`;
        }
        let bonus = c.on ? `<div class="st-bonus st-bonus--on">${ST_COIN}獲得攻擊時額外 1 次爆擊判定</div>`
            : c.ready ? `<div class="st-bonus st-bonus--off">${ST_COIN}差 ${c.gap}% 獲得能力加成</div>`
            : `<div class="st-bonus st-bonus--off">${ST_COIN}<span>字卡、聽力、速答各答滿 20 題，命中 90% 以上：攻擊時 +1 爆擊判定</span></div>`;
        let modes = ADV_HIT_KINDS.map(k => {
            let arr = advData.hits[k] || [], okN = arr.reduce((x, y) => x + y, 0), full = arr.length >= ADV_HIT_N, p = advHitPct(arr);
            return `<div class="st-mode"><span class="st-mode__name">${ADV_TYPE_LABEL[k]}</span><span class="st-bar${full ? '' : ' is-wait'}"><i style="width:${full ? p : arr.length / ADV_HIT_N * 100}%"></i></span>
                <span class="st-mode__num">${full ? p + '%' : '累積中'}<small>${full ? okN : arr.length}/${ADV_HIT_N} 題</small></span></div>`;
        }).join('');
        let cheer = cur !== null ? advHitComment(cur) : '🗡️ 去大冒險打一場，就會開始累積命中！';
        stModalOpen(stDialogHead('🎯 命中', `字卡、聽力、速答各算最近 ${ADV_HIT_N} 題`) + `
            <div class="st-total"><span class="st-total__num">${numTxt}</span><span class="st-total__meta">總命中${diffTxt}</span></div>
            ${bonus}<div class="st-modes">${modes}</div><div class="st-cheer"><span>${escapeHTML(cheer)}</span></div>`);
    }
    function advCloseHit() { document.getElementById('advHitModal').style.display = 'none'; }

    // ── 背包：九宮格；右上角篩選（全部／道具／物品）；點格子看說明再使用 ──
    //   道具 = 可以放進裝備欄的東西（同時只能裝 1 個）；物品 = 用掉就沒了的消耗品
    let advBagFilter = 'all';
    function advPotionIcon(size) { return `<span style="font-size:${Math.round(size * 0.82)}px;line-height:1">🧪</span>`; }
    function advBagDefs() {
        let defs = [
            { key: 'potion', kind: 'item', name: '小型恢復藥水', icon: s => advPotionIcon(s), n: advData.potions, desc: `使用後 HP +${ADV_POTION_HEAL}（目前 ${advData.hp}/${advMaxHp()}）`, act: '使用', fn: 'advBagUsePotion' },
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
    function advBagCount() { return advData.potions + advData.wipes + Object.keys(advData.items).filter(k => advData.items[k]).length; }
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
    // ── 替換視窗（沿用「選裝備」的彈出視窗，只換裡面的內容）──
    //   招式已經帶滿 4 招／裝備兩格都滿時：列出身上的，點一個就換掉
    let advReplace = null;           // { kind: 'move'|'gear', key }
    function advOpenReplace(kind, key) {
        advReplace = { kind, key };
        let body = document.getElementById('advBagBody');
        if (!body) return;
        let newName, list;
        if (kind === 'move') {
            let m = advMoveByKey(key); newName = m ? m.name : '';
            list = advData.eq.map((k, i) => { let x = advMoveByKey(k); return x ? { i, ico: `<span class="adv-rep-mico">${x.icon}</span>`, name: x.name, sub: x.mode === 'speed' ? '速答' : ADV_TYPE_LABEL[x.type], rk: advRarityKey(k) } : null; }).filter(Boolean);
        } else {
            newName = ADV_ITEMS[key] ? ADV_ITEMS[key].name : '';
            list = advData.gear.map((k, i) => k && ADV_ITEMS[k] ? { i, ico: ADV_ITEMS[k].icon(34), name: ADV_ITEMS[k].name, sub: ADV_HANDS[i], rk: advItemRarityKey(k) } : null).filter(Boolean);
        }
        body.innerHTML = `<div class="adv-bag-head"><div class="adv-bag-title">🔁 要用「${escapeHTML(newName)}」替換哪一個？</div></div>
            <div class="adv-bag-hint" style="margin:0 0 10px;">${kind === 'move' ? `已經帶滿 ${ADV_MAX_EQUIP} 招了，點一招換下來` : '兩格裝備都滿了，點一個換下來'}</div>
            <div class="adv-bag-grid adv-rep-grid">${list.map(o => `<button type="button" class="adv-bag-cell rar-${o.rk}" data-on-click='[["advDoReplace",[${o.i}]]]'><span class="adv-bag-cico">${o.ico}</span><b>${escapeHTML(o.name)}</b><small>${o.sub}</small></button>`).join('')}</div>
            <button type="button" class="adv-plain-btn sub" style="margin-top:12px;" data-on-click='[["advCloseBag",[]]]'>取消</button>`;
        document.getElementById('advBagModal').style.display = 'block';
    }
    function advDoReplace(i) {
        let r = advReplace; advReplace = null;
        if (!r) return;
        if (r.kind === 'move') {
            if (!advOwns(r.key) || i < 0 || i >= advData.eq.length) return;
            advData.eq[i] = r.key;
        } else {
            if (!advData.items[r.key] || (i !== 0 && i !== 1)) return;
            let at = advData.gear.indexOf(r.key); if (at !== -1) advData.gear[at] = '';
            advData.gear[i] = r.key;
        }
        advSave();
        advCloseBag();
        advRenderStatsPage();
        if (r.kind === 'gear' && advStatsTab === 'bag') advBagBack();
    }
    function advCloseBag() {
        advReplace = null;
        document.getElementById('advBagModal').style.display = 'none';
        // 關掉「選裝備」視窗後回到一般背包狀態，背包分頁要重畫（不然會是空的）
        if (advBagGearOnly || advBagSlot !== null) { advBagGearOnly = false; advBagSlot = null; advBagFilter = 'all'; advBagSel = ''; }
        if (advStatsTab === 'bag' && document.getElementById('advBagInline')) advBagBack();
    }
    // 背包畫在哪裡：能力值頁的「背包」分頁（沒開彈出視窗時），否則畫在背包彈出視窗
    function advBagEl() {
        let modalOn = document.getElementById('advBagModal').style.display === 'block';
        let inline = !advBagGearOnly && !modalOn && advStatsTab === 'bag' && document.getElementById('advBagInline');
        return inline || document.getElementById('advBagBody');
    }
    function advBagBack() {
        // 能力值頁的「背包」分頁：直接畫在分頁裡；選裝備欄（advOpenBag('gear')）時才用彈出視窗
        let body = advBagEl();
        if (!body) return;
        if (advBagGearOnly) advBagFilter = 'gear';
        let defs = advBagDefs().filter(d => d.kind === 'gear' || d.n > 0).filter(d => advBagFilter === 'all' || d.kind === advBagFilter);
        if (advBagSel && !defs.some(d => d.key === advBagSel)) advBagSel = '';
        let cells = defs.map(d => `<button type="button" class="adv-bag-cell${d.on ? ' is-on' : ''}${d.kind === 'gear' ? ' rar-' + advItemRarityKey(d.key) : ''}${d.key === advBagSel ? ' sel' : ''}" data-on-click='[["advBagTap",["${d.key}"]]]'>
                <span class="adv-bag-cico">${d.icon(34)}</span><b>${d.name}</b><small>${d.kind === 'gear' ? (d.on ? d.hand : '裝備') : '×' + d.n}</small>${d.kind === 'gear' && advGearUnseen(d.key) ? ADV_NEW_ALERT : ''}</button>`);
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
        if (advBagGearOnly && !defs.length) return '<div class="adv-bag-hint">還沒有裝備（打贏第 1、4、12、15 關可以拿到，補給站也買得到）。</div>';
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
    function advBagTap(key) {
        advBagSel = key;
        if (ADV_ITEMS[key] && advMarkSeen('g', key) && !advAnyUnseenGear()) {     // 看過了：背包分頁的驚嘆號也拿掉
            document.querySelectorAll(`.st-tab[data-on-click*='"bag"'] .adv-alert`).forEach(a => a.remove());
        }
        advBagBack();
    }
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
        let body = advBagEl();
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
        let body = advBagEl();
        if (!body || advData.wipes < 1 || !(advData.up[from] > 0)) return;
        let s = advPlayerStats();
        let rows = ADV_STAT_DEFS.filter(d => d.key !== from).map(d => {
            let can = advData.up[d.key] < advUpMax(d.key);
            return `<button type="button" class="adv-bag-item" ${can ? '' : 'disabled'} data-on-click='[["advWipeApply",["${from}","${d.key}"]]]'>
                <span class="adv-bag-txt"><b>${d.label}</b><small>${s[d.key]} → ${s[d.key] + 1}</small></span><span class="adv-bag-count">${can ? '+1' : '已滿'}</span></button>`;
        }).join('');
        body.innerHTML = `<div class="adv-bag-title">${advWipeIcon(24)} 把 1 點「${advStatLabel(from)}」轉到哪一項？</div>
            <div class="adv-note" style="margin:0 0 8px;">${advStatLabel(from)}：${s[from]} → ${s[from] - 1}</div>${rows}
            <button type="button" class="adv-plain-btn sub" style="margin-top:8px;" data-on-click='[["advBagWipe",[]]]'>上一步</button>`;
    }
    function advWipeApply(from, to) {
        if (advData.wipes < 1 || from === to || !(advData.up[from] > 0) || !Object.prototype.hasOwnProperty.call(advData.up, to) || advData.up[to] >= advUpMax(to)) return;
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
        let body = advBagEl();
        if (!body || advData.sauce < 1) return;
        let s = advPlayerStats();
        let rows = ADV_STAT_DEFS.map(d => {
            let maxed = advData.up[d.key] >= advUpMax(d.key);
            return `<button type="button" class="adv-bag-item" ${maxed ? 'disabled' : ''} data-on-click='[["advBagUseSauce",["${d.key}"]]]'>
                <span class="adv-bag-txt"><b>${d.label}</b><small>${s[d.key]} → ${s[d.key] + 1}</small></span><span class="adv-bag-count">${maxed ? '已滿' : '+1'}</span></button>`;
        }).join('');
        body.innerHTML = `<div class="adv-bag-title">${advSauceIcon(24)} 要強化哪一項？</div>${rows}
            <button type="button" class="adv-plain-btn sub" style="margin-top:8px;" data-on-click='[["advBagBack",[]]]'>返回</button>`;
    }
    function advBagUseSauce(key) {
        if (advData.sauce < 1) return;
        let d = ADV_STAT_DEFS.find(x => x.key === key);
        advUpgrade(key);
        advCloseBag();
        try { farmToast(`💪 ${d ? d.label : ''} +1！`); } catch (e) {}
    }
    // 能力值頁：直接用糖醋醬強化（打開背包裡「要強化哪一項」）
    function advOpenSauce() {
        if (advData.sauce < 1) return;
        advStatsTab = 'bag'; advBagGearOnly = false; advBagSlot = null; advBagFilter = 'all'; advBagSel = '';
        advRenderStatsPage();
        advBagSauce();
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
            if (advData.eq.length >= ADV_MAX_EQUIP) { advOpenReplace('move', key); return; }    // 裝滿了：選一招替換
            advData.eq.push(key);
        }
        advSave();
        advRenderStatsPage();
    }
    function advUpgrade(key) {
        if (!Object.prototype.hasOwnProperty.call(advData.up, key)) return;
        if (advPtsLeft() < 1 || advData.up[key] >= advUpMax(key)) return;
        advSyncDaily();
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
        cells.push(advShopCell({ id: 'advCell_potion', icon: advPotionIcon(46), name: '小型恢復藥水', sub: `HP +${ADV_POTION_HEAL}`, price: advShardPrice(ADV_POTION_COST), poor: advData.shards < ADV_POTION_COST, action: '[["advBuyPotion",[]]]' }));
        cells.push(advShopCell({ id: 'advCell_wipe', icon: advWipeIcon(46), name: '濕紙巾', sub: '能力 1 點轉移', price: advShardPrice(ADV_WIPE_COST), poor: advData.shards < ADV_WIPE_COST, action: '[["advBuyWipe",[]]]' }));
        // 已經擁有的裝備、招式不顯示（只留還能買的）
        if (!advData.items.soda) cells.push(advShopCell({ id: 'advCell_soda', kind: 'gear', icon: advSodaIcon(46), name: '彈珠汽水', sub: `普通裝備｜${ADV_ITEMS.soda.desc}`, price: advShardPrice(ADV_SODA_PRICE), poor: advData.shards < ADV_SODA_PRICE, cls: 'rar-common', action: '[["advBuySoda",[]]]' }));
        if (!advData.items.boba) {
            let open = !!advData.cleared[BattleCore.SHOP_OPEN.boba];
            cells.push(advShopCell({ id: 'advCell_boba', kind: 'gear', icon: ADV_ITEMS.boba.icon(46), name: '快喝光的珍珠奶茶', sub: `普通裝備｜${ADV_ITEMS.boba.desc}`, price: open ? advShardPrice(ADV_BOBA_PRICE) : `第 ${BattleCore.SHOP_OPEN.boba + 1} 關解鎖`, off: !open, poor: open && advData.shards < ADV_BOBA_PRICE, cls: 'rar-common' + (open ? '' : ' is-locked'), action: '[["advBuyBoba",[]]]' }));
        }
        if (!advData.items.coaster) {
            let open = !!advData.cleared[BattleCore.SHOP_OPEN.coaster];
            cells.push(advShopCell({ id: 'advCell_coaster', kind: 'gear', icon: advCoasterIcon(46), name: '防燙杯套', sub: `普通裝備｜${ADV_ITEMS.coaster.desc}`, price: open ? advShardPrice(ADV_COASTER_PRICE) : `第 ${BattleCore.SHOP_OPEN.coaster + 1} 關解鎖`, off: !open, poor: open && advData.shards < ADV_COASTER_PRICE, cls: 'rar-common' + (open ? '' : ' is-locked'), action: '[["advBuyCoaster",[]]]' }));
        }
        ADV_MOVES.filter(m => m.buy.kind === 'shards' && !advOwns(m.key)).forEach(m => {
            let open = advMoveOpen(m);           // 傳說招式：打倒第 20 關後才能買，之前顯示「第 21 關解鎖」並變灰
            let price = open ? advShardPrice(m.buy.price) : `第 ${(m.buy.open || 20) + 1} 關解鎖`;
            let poor = open && advData.shards < m.buy.price;
            cells.push(advShopCell({ id: 'shopItem_' + (m.buy.item || 'mv_' + m.key), kind: 'move', icon: advMoveIcon(m, 46), name: m.name, sub: m.mode === 'speed' ? `${advRarity(m.key).label} ｜ ${m.speed.label} +1～${m.speed.cap} ｜ 速答` : `${advRarity(m.key).label} ｜ 威力 ${m.power}${m.hits > 1 ? '×' + m.hits : ''} ｜ ${m.q} 題 ｜ ${ADV_TYPE_LABEL[m.type]}`, price: price, off: !open, poor: poor, cls: 'rar-' + advRarityKey(m.key) + (open ? '' : ' is-locked'), action: `[["advBuyMove",["${m.key}"]]]` }));
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
        let c3 = [advShopCell({ id: 'advCell_weekly', icon: '<span class="chicken-mini" style="width:46px;height:46px;"></span>', name: '每週雞塊', sub: done ? '本週已兌換（下週一再來）' : `${ADV_WEEKLY_SHARDS} 代幣 → ${ADV_WEEKLY_CHICKENS} 雞塊（每週 1 次）`, price: done ? '已兌換' : advShardPrice(ADV_WEEKLY_SHARDS), off: done, poor: !done && advData.shards < ADV_WEEKLY_SHARDS, action: '[["advWeeklyExchange",[]]]' })];
        while (c3.length < 9) c3.push('<div class="shop-cell shop-empty"></div>');
        let p2 = document.getElementById('shopPane2');
        if (p2) p2.innerHTML = c3.join('');
    }
    // 補給站右上角的碎片數字旁，跳出「-15」之類的紅色數字（跟雞塊一樣）
    function advShardFloat(n) { if (n) showChickenFloat('advShopShardCount', (n > 0 ? '+' : '-') + Math.abs(n), n > 0 ? '#10B981' : '#EF4444'); }
    function advExchangeShards() {
        if (advData.shards < ADV_SHARDS_PER_SAUCE) return;        // 碎片不夠：格子已經是灰底，不另外跳訊息
        if (!confirm(`要用 ${ADV_SHARDS_PER_SAUCE} 個冒險代幣兌換 1 個糖醋醬嗎？`)) return;
        advData.shards -= ADV_SHARDS_PER_SAUCE;
        advData.sauce += 1;
        advSave();
        advRenderShopBox();
        advShardFloat(-ADV_SHARDS_PER_SAUCE);
    }
    function advBuyPotion() {
        if (advData.shards < ADV_POTION_COST) return;
        if (!confirm(`要用 ${ADV_POTION_COST} 個冒險代幣購買小型恢復藥水嗎？\n\nHP +${ADV_POTION_HEAL}`)) return;
        advData.shards -= ADV_POTION_COST;
        advData.potions += 1;
        advSave();
        advRenderShopBox();
        advShardFloat(-ADV_POTION_COST);
    }
    function advBuySoda() {
        if (advData.items.soda) { alert('已經擁有彈珠汽水了。'); return; }
        if (advData.shards < ADV_SODA_PRICE) return;
        if (!confirm(`要用 ${ADV_SODA_PRICE} 個冒險代幣購買彈珠汽水嗎？\n\n${ADV_ITEMS.soda.desc}`)) return;
        advData.shards -= ADV_SODA_PRICE;
        advData.items.soda = true;
        advSave();
        advRenderShopBox();
        advShardFloat(-ADV_SODA_PRICE);
        advUpdateGearAlerts();
        alert('🥤 買到彈珠汽水了！\n到「💪 能力值 → 裝備」把它裝備起來吧。');
    }
    function advBuyBoba() {
        if (advData.items.boba) { alert('已經擁有快喝光的珍珠奶茶了。'); return; }
        if (!advData.cleared[4]) return;                        // 還沒解鎖：格子上已經寫「第 5 關解鎖」
        if (advData.shards < ADV_BOBA_PRICE) return;
        if (!confirm(`要用 ${ADV_BOBA_PRICE} 個冒險代幣購買快喝光的珍珠奶茶嗎？\n\n${ADV_ITEMS.boba.desc}`)) return;
        advData.shards -= ADV_BOBA_PRICE;
        advData.items.boba = true;
        advSave();
        advRenderShopBox();
        advShardFloat(-ADV_BOBA_PRICE);
        advUpdateGearAlerts();
        alert('🧋 買到快喝光的珍珠奶茶了！\n到「💪 能力值 → 裝備」把它裝備起來吧。');
    }
    function advBuyCoaster() {
        if (advData.items.coaster) { alert('已經擁有防燙杯套了。'); return; }
        if (!advData.cleared[10]) return;                       // 還沒解鎖：格子上已經寫「第 11 關解鎖」
        if (advData.shards < ADV_COASTER_PRICE) return;
        if (!confirm(`要用 ${ADV_COASTER_PRICE} 個冒險代幣購買防燙杯套嗎？\n\n${ADV_ITEMS.coaster.desc}`)) return;
        advData.shards -= ADV_COASTER_PRICE;
        advData.items.coaster = true;
        advSave();
        advRenderShopBox();
        advShardFloat(-ADV_COASTER_PRICE);
        advUpdateGearAlerts();
        alert('☕ 買到防燙杯套了！\n到「💪 能力值 → 裝備」把它裝備起來吧。');
    }
    function advBuyWipe() {
        if (advData.shards < ADV_WIPE_COST) return;
        if (!confirm(`要用 ${ADV_WIPE_COST} 個冒險代幣購買濕紙巾嗎？\n\n可以把 1 點能力轉移到別的能力`)) return;
        advData.shards -= ADV_WIPE_COST;
        advData.wipes += 1;
        advSave();
        advRenderShopBox();
        advShardFloat(-ADV_WIPE_COST);
    }
    // 傳說招式要先打倒第 20 關
    function advMoveIcon(m) { return m.icon; }
    function advMoveOpen(m) { if (m.buy.open) return !!advData.cleared[m.buy.open]; return advRarityKey(m.key) !== 'legend' || !!advData.cleared[20]; }
    function advBuyMove(key) {
        let m = advMoveByKey(key);
        if (!m || m.buy.kind === 'free') return;
        if (advOwns(key)) { alert(`已經擁有「${m.name}」了。`); return; }
        if (!advMoveOpen(m)) return;                            // 還沒解鎖：格子上已經寫「第 21 關解鎖」
        if (m.buy.kind === 'chicken') { buyShopItem(m.buy.item); return; }
        if (advData.shards < m.buy.price) return;
        if (!confirm(`要用 ${m.buy.price} 個冒險代幣學會「${m.name}」嗎？\n\n${ADV_TYPE_LABEL[m.type]}｜威力 ${m.power}${m.hits > 1 ? '×' + m.hits : ''}｜${m.q} 題｜${m.desc}`)) return;
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
        if (advData.shards < ADV_WEEKLY_SHARDS) return;
        if (walletBusy) return;
        if (!ensureLoginBeforeSpend()) return;
        if (!confirm(`要用 ${ADV_WEEKLY_SHARDS} 個冒險代幣兌換 ${ADV_WEEKLY_CHICKENS} 個雞塊嗎？\n\n每週只能兌換 1 次。`)) return;
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
    // 冒險題庫的出題順序
    //   一般關卡：這關的新字考一輪 → 2 題舊字（有答錯過的先考，沒有就考答對過的）→ 再一輪新字…
    //   複習關：前 2 題先考答錯過的字，之後隨機
    function advPlanRefill() {
        let P = adv.plan;
        let wrongFirst = list => advShuffle(list.slice()).sort((x, y) => advWrongOf(y.english) - advWrongOf(x.english));
        if (P.review) {
            if (!P.started) { P.started = true; P.queue = wrongFirst(P.fresh.filter(w => advWrongOf(w.english) > 0)).slice(0, 2); }
            return;              // 之後交給一般的隨機出題
        }
        P.queue = advShuffle(P.fresh.slice());
        if (P.old.length) {
            let bad = P.old.filter(w => advWrongOf(w.english) > 0);
            let pick = wrongFirst(bad).slice(0, 2);
            if (pick.length < 2) pick = pick.concat(advShuffle(P.old.filter(w => !pick.includes(w))).slice(0, 2 - pick.length));   // 答錯過的不夠 2 個：用答對過的補
            P.queue = P.queue.concat(pick);
        }
    }
    function advNextWord(kind) {
        let filt = kind === 'cn' ? (w => !!w.chinese) : (() => true);
        if (adv.plan) {
            if (!adv.plan.queue.length) advPlanRefill();
            let k = adv.plan.queue.findIndex(filt);
            if (k !== -1) { let w = adv.plan.queue.splice(k, 1)[0]; if (!adv.seen) adv.seen = new Set(); adv.seen.add(advWordKey(w)); return w; }
            if (!adv.plan.review) { adv.plan.queue = []; advPlanRefill(); k = adv.plan.queue.findIndex(filt); if (k !== -1) return adv.plan.queue.splice(k, 1)[0]; }
        }
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
            let ss = window.speechSynthesis;
            // 正在唸的時候馬上 cancel 再 speak，有些手機（Chrome Android）會整句被吞掉：等一下再唸
            if (ss.speaking || ss.pending) { ss.cancel(); setTimeout(() => { try { ss.resume(); ss.speak(u); } catch (e) {} }, 120); }
            else { ss.resume(); ss.speak(u); }
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
    function advFloat(actorEl, text, color, dy) {
        let stage = document.getElementById('advStage');
        if (!stage || !actorEl) return;
        let c = advActorCenter(actorEl);
        let d = document.createElement('div');
        d.className = 'adv-float';
        d.textContent = text;
        if (color) d.style.color = color;
        d.style.left = c.x + 'px';
        d.style.top = (actorEl.offsetTop - 4 + (dy || 0)) + 'px';
        (actorEl.offsetParent && stage.contains(actorEl.offsetParent) ? actorEl.offsetParent : stage).appendChild(d);
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
        let btOn = advBtOn();
        if (pt) pt.textContent = `${Math.max(0, p.hp)}/${p.max}` + (!btOn && p.shieldMax ? ` 🛡️${p.shield}` : '');
        if (btOn) {
            let sh = Math.max(0, p.shield || 0), badge = document.getElementById('btShieldBadge'), bar = document.getElementById('btShieldBar');
            if (badge) { badge.hidden = sh <= 0; let n = document.getElementById('btShieldNum'); if (n) n.textContent = sh; }
            if (bar) { bar.hidden = sh <= 0; let f = document.getElementById('btShieldFill'); if (f) f.style.width = Math.min(100, sh / Math.max(1, p.max) * 100) + '%'; }
        }
        if (et) et.textContent = `${Math.max(0, e.hp)}/${e.max}` + (e.shield ? ` 🛡️${e.shield}` : '');
        let info = document.getElementById('advTopInfo');
        let act = `${Math.min(adv.actionsTotal - adv.actionsLeft + 1, adv.actionsTotal)}/${adv.actionsTotal}`;
        if (info) {
            if (adv.ringOpening) info.innerHTML = `第 ${adv.level.id} 關 <span>｜</span> 套圈圈技能發動！`;     // 開場「天女散花」：回合還沒開始
            else if (btOn) info.innerHTML = `第 ${adv.level.id} 關 <span>｜</span> 回合 ${adv.round} <span>｜</span> 行動 ${act}`;
            else info.textContent = `第 ${adv.level.id} 關 ｜ 回合 ${adv.round} ｜ 行動 ${act}`;
        }
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
    // 新版戰鬥畫面（前後透視：敵人在右上是主角、雞塊背面在左下）—— 先開放的關卡
    const ADV_BT_LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    function advBtOn() { return !!(adv.level && ADV_BT_LEVELS.includes(adv.level.id)); }
    function advBtFit() {
        let b = document.querySelector('#adventureBattleView .adv-battle');
        if (!b || !b.classList.contains('bt')) return;
        let vv = window.visualViewport;
        let h = vv ? vv.height : window.innerHeight, top = vv ? vv.offsetTop : 0;
        b.style.setProperty('--bt-h', Math.round(h) + 'px');
        b.style.setProperty('--bt-top', Math.round(top) + 'px');
        // 鍵盤跳出來（可見高度明顯變小）：只有這時候場景才跟著縮，讓輸入框不被蓋住
        let kb = !!(adv.btFullH && h < adv.btFullH * 0.8);
        b.classList.toggle('bt-kb', kb);
        if (!kb && adv.btMenuH && (Math.abs(h - adv.btFullH) > 40 || b.clientWidth !== adv.btW)) advBtLock(false);
    }
    // 一場戰鬥裡場景高度固定不變：用第一次「選擇招式」選單的高度決定，之後題目變長變短都只動下面的選單
    function advBtLock(measure) {
        let b = document.querySelector('#adventureBattleView .adv-battle'), pn = document.getElementById('advPanel');
        if (!b || !pn || !b.classList.contains('bt')) return;
        if (measure || !adv.btMenuH) {
            pn.style.flex = '0 0 auto';          // 量「內容本身」的高度（平常選單會往下撐滿，量的時候先不要撐）
            adv.btMenuH = pn.offsetHeight;
            // 有帶速答招式：配對畫面比招式選單高，用比較高的那個決定場景高度（整場戰鬥都不用再變）
            //   套圈圈的「天女散花」開場也是配對畫面，而且標題比較長 → 一起量
            let ringOpen = !!(adv.enemy && adv.enemy.special === 'ring');
            if ((adv.moves || []).some(m => m.mode === 'speed') || ringOpen) {
                let keep = pn.innerHTML, cell = '<button type="button" class="spd-cell">word</button>';
                let title = ringOpen ? `<b>🎯 天女散花！快配對躲開</b><small>已配對 0 / ${ADV_RING_NEED} 組・沒配完每少 1 組扣 1 點 HP</small>` : '<b>⚡ 速答配對</b><small>已配對 0 組</small>';
                pn.innerHTML = `<div class="spd-head"><div class="spd-title">${title}</div><div class="spd-timer"></div></div><div class="spd-grid">${cell.repeat(4)}</div><div class="spd-sep"></div><div class="spd-grid">${cell.repeat(4)}</div>`;
                adv.btMenuH = Math.max(adv.btMenuH, pn.offsetHeight + 24);   // +24：中文比較長會換行
                pn.innerHTML = keep;
            }
            pn.style.flex = '';
        }
        let H = b.clientHeight, W = b.clientWidth, overlap = Math.max(0, -parseFloat(getComputedStyle(pn).marginTop) || 0);
        let natural = W * 560 / 390;
        let st = Math.max(200, Math.min(natural, H - adv.btMenuH + overlap));
        b.style.setProperty('--bt-stage-h', Math.round(st) + 'px');
        adv.btFullH = H; adv.btW = W;
    }
    try {
        if (window.visualViewport) { window.visualViewport.addEventListener('resize', advBtFit); window.visualViewport.addEventListener('scroll', advBtFit); }
        window.addEventListener('resize', advBtFit);
    } catch (e) {}
    // 敵人攻擊台詞（白色對話框，出現在雞塊上方的空白處；只在新版戰鬥畫面）
    const ADV_ENEMY_LINES = {
        meatball: '彈死你！', corn: '玉米粒機關槍！', oyster: '黏住你囉～', tofu: '聞聞看我的味道！', boba: '珍珠發射！',
        claw: '抓到你了！', darts: '正中紅心！', mahjong: '自摸啦！', ring: '你被套牢了！', pinball: '彈過來彈過去！',
        egg: '滾燙蛋汁來囉！', bun: '麵包夾住你！', hotdog: '熱油噴射！', onigiri: '海苔捲起來！', tea: '冰鎮你一下！',
        ibon: '請到櫃檯繳費！', salad: '生菜甩甩甩！', microwave: '叮！加熱完成！', bento: '便當蓋飛過去！', bento2: '即期也很強！',
        coffee: '小心燙口！', clerk: '歡迎光臨！'
    };
    // 臭豆腐：雞塊的招式失敗時說的話（隨機一句）
    const ADV_TOFU_LINES = ['哈！打不到吧～聞聞我的臭味！', '臭臭反擊！', '太嫩了，再練練吧！', '這味道，夠你受的了吧？'];
    function advBtSay(text, ms) {
        let scene = document.querySelector('#advStage .bt-scene');
        if (!scene) return;
        let old = scene.querySelector('.bt-say'); if (old) old.remove();
        let b = document.createElement('div');
        b.className = 'bt-say';
        b.textContent = text;
        b.insertAdjacentHTML('beforeend', '<svg class="bt-say__tail" viewBox="0 0 28 28" aria-hidden="true"><path d="M0 24 Q15 21 27 5 Q12 7 0 9 Z" fill="#fff"/><path d="M3.6 23.6 Q15 21 27 5 Q12 7 3.6 9.4" fill="none" stroke="#231F20" stroke-width="3.6" stroke-linejoin="round" stroke-linecap="butt"/></svg>');
        scene.appendChild(b);
        setTimeout(() => { b.classList.add('out'); setTimeout(() => b.remove(), 300); }, ms || 1800);
    }
    function advBuildStage() {
        let st = document.getElementById('advStage');
        adv.btLocked = false; adv.btMenuH = 0; adv.btFullH = 0; adv.btW = 0;
        adv.nextAtk = 0; adv.intBuff = 0; adv.ringOpening = false; if (advSp && advSp.timer) clearInterval(advSp.timer); advSp = null;
        let battle = document.querySelector('#adventureBattleView .adv-battle'), btOn = advBtOn();
        if (battle) { battle.classList.toggle('bt', btOn); battle.classList.toggle('bt-store', !!(btOn && adv.level && adv.level.id >= 11)); }   // 便利商店：白色地磚
        let view = document.getElementById('adventureBattleView');
        if (view) view.classList.toggle('bt-view', btOn);
        document.body.classList.toggle('bt-on', btOn);
        if (btOn) {
            // 新版面：鍵盤跳出時整個畫面跟著可見高度縮（招式抽屜／輸入框不會被鍵盤蓋住）
            try { if (navigator.virtualKeyboard) navigator.virtualKeyboard.overlaysContent = false; } catch (e) {}
            advBtFit();
            const SHIELD = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5l8-3z"/></svg>';
            st.innerHTML = (adv.level && adv.level.id >= 11 ? advStoreStageBG() : advStageBG()) + `
            <div class="bt-scene">
                <svg class="bt-plat" viewBox="0 0 390 560" aria-hidden="true">
                    <ellipse cx="280" cy="350" rx="102" ry="20" fill="#fff" opacity="0.35" stroke="#8A5A34" stroke-opacity="0.35" stroke-width="2"/>
                    <ellipse cx="280" cy="350" rx="64" ry="9" fill="#5A3A1E" opacity="0.35"/>
                    <ellipse cx="116" cy="540" rx="124" ry="24" fill="#fff" opacity="0.3" stroke="#8A5A34" stroke-opacity="0.3" stroke-width="2"/>
                    <ellipse cx="116" cy="542" rx="66" ry="10" fill="#5A3A1E" opacity="0.35"/>
                </svg>
                <div class="adv-actor adv-enemy" id="advEnemy">${advEnemySVG(adv.enemy.sprite)}</div>
                <div class="adv-actor adv-player" id="advPlayer">${advChickenBackSVG()}</div>
                <div class="adv-hud adv-hud-enemy bt-hp bt-hp--enemy"><div class="adv-enemy-tag" id="advEnemyTag" style="display:none"></div><span class="bt-hp__name"><span id="advEnemyName">${escapeHTML(adv.enemy.name)}</span> <b id="advEnemyHpText"></b></span><span class="adv-hpbar bt-bar"><span class="adv-hpfill" id="advEnemyFill"></span></span></div>
                <div class="adv-hud adv-hud-player bt-hp bt-hp--player"><span class="bt-hp__name">雞塊 <b id="advPlayerHpText"></b><span class="bt-badge-shield" id="btShieldBadge" hidden>${SHIELD}<span id="btShieldNum"></span></span></span><span class="bt-shieldbar" id="btShieldBar" hidden><i id="btShieldFill"></i></span><span class="adv-hpbar bt-bar"><span class="adv-hpfill" id="advPlayerFill"></span></span></div>
                <div class="adv-fx" id="advFx"></div>
            </div>`;
            advUpdateHud();
            return;
        }
        try { if (navigator.virtualKeyboard) navigator.virtualKeyboard.overlaysContent = true; } catch (e) {}
        st.innerHTML = (adv.level && adv.level.id >= 11 ? advStoreStageBG() : advStageBG()) + `
            <div class="adv-hud adv-hud-enemy"><div class="adv-enemy-tag" id="advEnemyTag" style="display:none"></div><div><span id="advEnemyName">${escapeHTML(adv.enemy.name)}</span> <span id="advEnemyHpText"></span></div><div class="adv-hpbar"><div class="adv-hpfill" id="advEnemyFill"></div></div></div>
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
        let autoMode = advMode() === 'auto';
        let words = autoMode ? advAutoWords(lv) : advGetWords();
        if (autoMode && !advIsReview(lv.id)) {            // 一般關卡：選項和穿插複習也會用到之前學過的字
            let seen = new Set(words.map(advWordKey));
            words = words.concat(advOldWords(lv).filter(w => !seen.has(advWordKey(w))));
        }
        if (!autoMode && words.length < lv.minWords) { alert(`⚠️ 這一關需要範圍內至少 ${lv.minWords} 個單字，請多勾選一些題庫。`); return; }
        advAbort();
        advSyncDaily();
        if (advData.hp <= 0) { alert('雞塊沒有體力了，明天 00:00 會恢復。'); advRenderLevelPage(); return; }
        // 已通關的關卡可以一直重複挑戰：每天前 3 次打贏有通關獎勵，之後只累積招式熟練度（在 advWin 計算）
        adv.words = words;
        adv.cnWords = words.filter(w => w.chinese);
        adv.decks = { all: [], cn: [] };
        adv.seen = new Set();          // 這場戰鬥已經出現過的單字
        adv.wrongThis = [];            // 這場戰鬥答錯的字
        adv.stOk = 0; adv.stAll = 0;   // 這場戰鬥答對的題數／作答題數
        adv.plan = autoMode ? { review: advIsReview(lv.id), fresh: advAutoWords(lv), old: advIsReview(lv.id) ? [] : advOldWords(lv), queue: [], started: false } : null;
        // 戰鬥狀態由 battle-core.js 建立（雞塊能力、裝備效果、敵人資料都在那裡）
        let eqMoves = advEquipped(), mast = {};
        eqMoves.forEach(m => { mast[m.key] = advMastery(m.key); });
        BattleCore.initBattle(adv, { level: lv, stats: advPlayerStats(), hp: advData.hp, gear: advData.gear, moves: eqMoves, mastery: mast, critOn: advCritOn() });   // 命中加成：開戰時決定這場有沒有爆擊判定
        advData.hitPrev = advHitTotal();             // 命中的「比上次」用這個比較
        adv.micOk = false;
        adv.active = true;
        adv.busy = false;
        requestWakeLock();
        if (!document.getElementById('adventureBattleView').classList.contains('active')) advLockBattleHeight();
        switchView('adventureBattleView');
        advBuildStage();
        advOpening(adv.runId);
    }
    // 開戰效果（美式咖啡燙傷等）→ 套圈圈開場 → 第 1 回合
    async function advOpening(id) {
        adv.busy = true;
        if (await advPlay(BattleCore.opening(adv), id)) return;
        if (BattleCore.openingKind(adv) === 'ring') { advRingOpening(id); return; }
        advBeginRound();
    }
    // 店員：頭上的牌子（崗位／下班倒數）
    function advClerkTag() {
        let el = document.getElementById('advEnemyTag');
        if (!el) return;
        let t = '';
        if (adv.enemy && adv.enemy.special === 'clerk') t = adv.shifted ? (adv.cd > 0 ? `⏰ 下班倒數 ${adv.cd}` : '⏰ 下班了') : adv.post ? `🏷️ ${adv.post.name}・${advPostRule(adv.post)}` : '';
        el.textContent = t;
        el.style.display = t ? '' : 'none';
        el.classList.toggle('cd', !!adv.shifted);
    }
    // 店員：兌換集點卡（不用考英文、不消耗行動；一場一次）
    function advRedeemStamps() {
        if (!adv.active || adv.busy || adv.q) return;
        let r = BattleCore.redeemStamps(adv);
        if (!r) return;
        advData.hp = adv.player.hp; advSave();
        advShowMenu();
        advSetLog(`🎫 兌換集點卡！雞塊這場攻擊力 +${r.atk}${r.heal ? `，HP +${r.heal}` : ''}（不消耗行動）`);
        advFloat(document.getElementById('advPlayer'), `攻擊 +${r.atk}`, '#7C3AED');
    }
    function advMakeEnemy(d) { return BattleCore.makeEnemy(d); }
    function advQuit() {
        if (adv.active && !confirm('要離開戰鬥嗎？這場戰鬥不會有任何獎勵。')) return;
        advAbort();
        advBackToLevel();
    }
    function advBackToMenu() { advAbort(); advBackToLevel(); }
    function advRetry() { if (adv.level) advStartBattle(adv.level.id); }

    // ── 回合 ──
    function advBeginRound() {
        adv.ringOpening = false;
        adv.busy = true;
        advPlay(BattleCore.beginRound(adv, Math.random, advMoveBlock), adv.runId);
    }
    // 這招每一下的傷害（算法在 battle-core.js）
    function advHitDamage(m) { return BattleCore.hitDamage(adv, m); }
    // 這招因為題庫或瀏覽器的關係不能用：回傳原因（可以用就回傳空字串）
    function advMoveBlock(m) {
        if ((m.mode === 'choice' || m.mode === 'listenCn') && adv.cnWords.length < 4) return '缺中文';
        if (m.mode === 'speakCn' && adv.cnWords.length < 1) return '缺中文';
        if (m.mode === 'typeCn' && adv.cnWords.length < 1) return '缺中文';
        if (m.type === 'speak' && !getSpeechRecognitionCtor()) return '不支援';
        if (m.mode === 'speed' && adv.cnWords.length < 4) return '缺中文';
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
            let per = adv.player.atk + m.power + advMasteryAtk(m.key) + (adv.nextAtk || 0);      // 不扣敵人防禦：打下去才知道
            let stamp = adv.enemy.special === 'clerk' && adv.stamps && adv.stamps.has(m.type);
            if (!why && adv.enemy.special === 'clerk' && advImmuneType() === m.type) why = '這回合無效';
            if (m.mode === 'speed') {
                let sp = advSpeedCfg(m), g = advSpeedGuard();
                return `<button type="button" class="adv-move rar-${advRarityKey(m.key)}${sealed ? ' sealed' : ''}" ${off ? 'disabled' : ''} data-on-click='[["advChooseMove",["${m.key}"]]]'>
                ${stamp ? '<span class="adv-stamp">已集點</span>' : ''}<b class="nm">${m.icon} ${m.name}${lvl ? ` <span class="adv-lv-chip">Lv.${lvl}</span>` : ''}</b><span class="dmg">${sp.label} +1～${sp.cap}</span><small>速答${why ? '｜' + why : g ? `｜加成 −${g}` : ''}</small></button>`;
            }   // 店員：直接告訴玩家，不用自己試
            return `<button type="button" class="adv-move rar-${advRarityKey(m.key)}${sealed ? ' sealed' : ''}" ${off ? 'disabled' : ''} data-on-click='[["advChooseMove",["${m.key}"]]]'>
                ${stamp ? '<span class="adv-stamp">已集點</span>' : ''}<b class="nm">${m.icon} ${m.name}${lvl ? ` <span class="adv-lv-chip">Lv.${lvl}</span>` : ''}</b><span class="dmg">傷害 ${m.hits > 1 ? per + '×' + m.hits : per}</span><small>${ADV_TYPE_LABEL[m.type]}${why ? '｜' + why : ''}</small></button>`;
        }).join('');
        if (adv.enemy.special === 'clerk' && adv.stamps && adv.stamps.size >= ADV_STAMP_NEED && !adv.redeemed) {
            moves += `<button type="button" class="adv-move adv-redeem rar-legend" data-on-click='[["advRedeemStamps",[]]]'><b class="nm">🎫 兌換集點卡！</b><span class="dmg">攻擊 +${ADV_STAMP_ATK}・HP +${ADV_STAMP_HEAL}</span><small>不用作答・不消耗行動・一場一次</small></button>`;
        }
        let itemBtn = '';
        if (advHasGear('boba')) {
            let early = (adv.round || 1) < 2;                                       // 第 1 回合（敵人還沒攻擊過）不能喝
            let can = BattleCore.canBoba(adv);
            itemBtn += `<button type="button" class="adv-item-btn" ${can ? '' : 'disabled'} data-on-click='[["advUseBoba",[]]]'>🧋 喝快喝光的珍珠奶茶　HP +1 <small>${!adv.itemUsed && early ? '（第 2 回合起才能喝）' : adv.itemUsed ? '（這場已經喝過了）' : '（HP 3 以下可用，一場 1 次）'}</small></button>`;
        }
        ['nectar', 'crown'].forEach(k => {
            let n = (typeof farm !== 'undefined' && farm.items) ? (farm.items[k] || 0) : 0;
            if (!n || !FARM_ITEMS[k]) return;     // 下架的道具：戰鬥中先不顯示
            let it = FARM_ITEMS[k], used = adv.flowerUsed && adv.flowerUsed[k];
            let can = !used;
            itemBtn += `<button type="button" class="adv-item-btn" ${can ? '' : 'disabled'} data-on-click='[["advUseFlowerItem",["${k}"]]]'>${it.icon} ${it.name}　${it.desc.replace('戰鬥中 ', '').replace('這場戰鬥', '')} <small>${used ? '（這場已經用過了）' : `（持有 ${n}，一場 1 次，不消耗行動）`}</small></button>`;
        });
        if (advHasGear('tofu')) itemBtn += `<div class="adv-item-tip">${advTofuIcon(16)} 裝備烤焦臭豆腐：招式失敗時雙方各扣 1 點體力</div>`;
        if (advHasGear('skewer')) itemBtn += `<div class="adv-item-tip">${advSkewerIcon(16)} 裝備竹籤：攻擊無視對方護盾</div>`;
        if (adv.nextAtk) itemBtn = `<div class="adv-item-tip">⚡ 蓄力中：下一招攻擊 +${adv.nextAtk}</div>` + itemBtn;
        document.getElementById('advPanel').innerHTML = `<div class="adv-log" id="advLog">選擇招式！（本回合還可行動 ${adv.actionsLeft} 次）</div><div class="adv-moves">${moves}</div>${itemBtn}`;
        if (advBtOn() && !adv.btLocked) { adv.btLocked = true; requestAnimationFrame(() => advBtLock(true)); }
    }
    function advUseFlowerItem(k) {
        if (!adv.active || adv.busy || adv.q || !FARM_ITEMS[k]) return;
        if (adv.flowerUsed && adv.flowerUsed[k]) return;
        if (!farmUseItem(k)) return;
        BattleCore.useFlower(adv, k);
        if (k === 'nectar') {
            advFloat(document.getElementById('advPlayer'), `🛡️ +${BattleCore.NECTAR_SHIELD}`, '#6366F1');
            advUpdateHud(); advShowMenu(); advSetLog(`🍯 喝了花蜜，護盾 +${BattleCore.NECTAR_SHIELD}！`);
        } else {
            advFloat(document.getElementById('advPlayer'), `攻擊 +${BattleCore.CROWN_ATK}`, '#DB2777');
            advShowMenu(); advSetLog(`🌸 戴上花環，這場攻擊力 +${BattleCore.CROWN_ATK}！`);
        }
    }
    function advHasGear(k) { return BattleCore.hasGear(adv, k); }
    // 快喝光的珍珠奶茶：一場戰鬥限用 1 次，HP 3 以下才能喝，不消耗行動次數
    function advUseBoba() {
        if (!adv.active || adv.busy || adv.q) return;
        if (!BattleCore.useBoba(adv)) return;
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
        if (m.mode === 'speed') { advSpeedStart(); return; }
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
        if (adv.active) { adv.stAll = (adv.stAll || 0) + 1; if (ok) adv.stOk = (adv.stOk || 0) + 1; }   // 結算畫面的「答對 x / y」
        let t = adv.move && adv.move.type;
        if (!t || !advData.hits[t]) return;
        [t, 'all'].forEach(k => { advData.hits[k].push(ok ? 1 : 0); if (advData.hits[k].length > ADV_HIT_N) advData.hits[k].splice(0, advData.hits[k].length - ADV_HIT_N); });
    }
    function advHitPct(arr) { return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 100) : null; }
    // 總命中 = 字卡、聽力、朗讀各自最近 20 題合起來算（不會只看最近 20 題而忽略比較弱的類別）
    function advHitAll() { return ADV_HIT_KINDS.reduce((x, k) => x.concat(advData.hits[k] || []), []); }
    // 爆擊加成：字卡、聽力、朗讀「各」答滿 20 題，而且三種合計命中 ≥ 90%
    const ADV_CRIT_AT = BattleCore.CRIT_AT;
    function advCritReady() { return ADV_HIT_KINDS.every(k => (advData.hits[k] || []).length >= ADV_HIT_N); }
    function advCritOn() { return advCritReady() && BattleCore.critOn(advHitPct(advHitAll())); }
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

    // ═════════ 速答招式（冥想／蓄力）═════════
    //   一輪 4 個英文＋4 個中文；配對成功的那組只消失、不補；4 組都配完才整批換下一輪（位置重新打亂）
    //   時間內配對成功的總組數 = 答對題數；配錯扣秒數
    function advSpeedCfg(m) {
        // 秒數 = 20 + 熟練度加的秒數 +（雞塊智慧 − 敵人智慧），最少 10 秒（算法在 battle-core.js）
        let on = adv.active && adv.player && adv.enemy;
        return BattleCore.speedCfg(m, advMastery(m.key), on ? adv.player.int : 0, on ? adv.enemy.int : 0);
    }
    const ADV_SPEED_MIN_SECS = BattleCore.SPEED_MIN_SECS;
    let advSp = null;
    function advSpeedShort(w) { return (w.meanings && w.meanings[0]) || String(w.chinese || '').split(/[、,，;；\/]/)[0] || w.chinese; }
    function advSpeedRound() {
        let sp = advSp, pool = advShuffle(adv.cnWords.slice()), pick = [], usedEn = new Set(), usedCn = new Set();
        let last = new Set((sp.round || []).map(w => advWordKey(w)));
        let tryAdd = (w, avoidLast) => {
            let en = advWordKey(w), cn = advSpeedShort(w);
            if (pick.length >= 4 || usedEn.has(en) || usedCn.has(cn) || (avoidLast && last.has(en))) return;
            usedEn.add(en); usedCn.add(cn); pick.push(w);
        };
        pool.forEach(w => tryAdd(w, true));
        pool.forEach(w => tryAdd(w, false));
        sp.round = pick;
        sp.en = advShuffle(pick.map((w, i) => i));
        sp.cn = advShuffle(pick.map((w, i) => i));
        sp.done = new Set(); sp.selEn = null; sp.selCn = null; sp.bad = null;
    }
    // 冥想動畫：答題時雞塊頭上冒出白白的雲朵，答完出現燈泡
    const ADV_CLOUD_SVG = '<svg viewBox="0 0 64 44" aria-hidden="true"><path d="M14 36 Q4 36 4 27.5 Q4 19 13 19.5 Q14 8 26 9 Q32 1 42 6 Q52 4 54 15 Q62 17 61 26 Q61 36 50 36 Z" fill="#fff" stroke="#CBD5E1" stroke-width="2.2" stroke-linejoin="round"/><circle cx="24" cy="24" r="2.4" fill="#A78BFA"/><circle cx="33" cy="24" r="2.4" fill="#A78BFA"/><circle cx="42" cy="24" r="2.4" fill="#A78BFA"/></svg>';
    const ADV_BULB_SVG = '<svg viewBox="0 0 48 56" aria-hidden="true"><path d="M24 2 v5 M6 10 l4 4 M42 10 l-4 4 M1 26 h5 M42 26 h5" stroke="#F59E0B" stroke-width="3" stroke-linecap="round"/><path d="M24 11 Q37 11 37 24 Q37 31 31 36 V40 H17 V36 Q11 31 11 24 Q11 11 24 11 Z" fill="#FDE047" stroke="#231F20" stroke-width="2.6" stroke-linejoin="round"/><path d="M19 21 Q20 16 25 15" stroke="#FFFBEB" stroke-width="2.6" fill="none" stroke-linecap="round"/><rect x="17" y="40" width="14" height="8" rx="2.5" fill="#94A3B8" stroke="#231F20" stroke-width="2.4"/><path d="M20 52 H28" stroke="#231F20" stroke-width="2.6" stroke-linecap="round"/></svg>';
    function advChickOverhead(cls, svg) {
        let P = document.getElementById('advPlayer');
        if (!P || !P.offsetParent) return null;
        let host = P.offsetParent;
        host.querySelectorAll('.adv-overhead').forEach(e => e.remove());
        let d = document.createElement('div');
        d.className = 'adv-overhead ' + cls;
        d.innerHTML = svg;
        d.style.left = (P.offsetLeft + P.offsetWidth * 0.62) + 'px';
        d.style.top = (P.offsetTop - P.offsetHeight * 0.02) + 'px';
        host.appendChild(d);
        return d;
    }
    function advMeditateFx(on) {
        let P = document.getElementById('advPlayer');
        if (P) P.classList.toggle('is-meditating', !!on);
        if (on) advChickOverhead('cloud', ADV_CLOUD_SVG);
        else {
            let host = P && P.offsetParent;
            if (host) host.querySelectorAll('.adv-overhead.cloud').forEach(e => e.remove());
        }
    }
    function advSpeedStart() {
        let m = adv.move, c = advSpeedCfg(m);
        if (m.key === 'meditate') advMeditateFx(true);
        adv.q = { type: 'speed', done: false };
        advSp = { id: adv.runId, m, c, pairs: 0, wrong: 0, endAt: Date.now() + c.secs * 1000, total: c.secs, round: null, over: false };
        advSpeedRound();
        advSpeedRender();
        clearInterval(advSp.timer);
        advSp.timer = setInterval(advSpeedTick, 100);
    }
    function advSpeedBonus(sp) { return BattleCore.speedBonus(sp.pairs, sp.c); }
    function advSpeedTick() {
        let sp = advSp;
        if (!sp || sp.over) return;
        if (!adv.active || sp.id !== adv.runId) { clearInterval(sp.timer); advSp = null; return; }
        if (sp.ring && sp.pairs >= ADV_RING_NEED) { advSpeedEnd(); return; }
        let left = Math.max(0, sp.endAt - Date.now());
        let t = document.getElementById('spdTime'), ring = document.getElementById('spdRing');
        if (t) t.textContent = Math.ceil(left / 1000);
        if (ring) { ring.style.strokeDashoffset = (125.66 * (1 - left / (sp.total * 1000))).toFixed(2); ring.classList.toggle('low', left <= 5000); }
        if (left <= 0) advSpeedEnd();
    }
    function advSpeedRender() {
        let sp = advSp, m = sp.m;
        let cell = (side, slot) => {
            let i = (side === 'en' ? sp.en : sp.cn)[slot], w = sp.round[i];
            if (!w) return '<div class="spd-cell gone"></div>';
            if (sp.done.has(i)) return '<div class="spd-cell gone">✓</div>';
            let sel = side === 'en' ? sp.selEn === i : sp.selCn === i;
            let bad = sp.bad && sp.bad[side] === i;
            let txt = side === 'en' ? w.english : advSpeedShort(w);
            return `<button type="button" class="spd-cell${side === 'en' ? ' en' : ' cn'}${sel ? ' sel' : ''}${bad ? ' bad' : ''}" data-on-click='[["advSpeedTap",["${side}",${i}]]]'>${escapeHTML(txt)}${bad && side === 'cn' ? `<span class="spd-pen">配錯 −${sp.c.pen} 秒</span>` : ''}</button>`;
        };
        let left = Math.max(0, sp.endAt - Date.now());
        document.getElementById('advPanel').innerHTML = `
            <div class="spd-head">
                <div class="spd-title">${sp.ring
                    ? `<b>🎯 天女散花！快配對躲開</b><small>已配對 <b id="spdPairs">${sp.pairs}</b> / ${ADV_RING_NEED} 組・沒配完每少 1 組扣 1 點 HP</small>`
                    : `<b>${m.icon} ${m.name}・速答配對</b><small>已配對 <b id="spdPairs">${sp.pairs}</b> 組・${sp.c.label} <b class="hot">+${advSpeedBonus(sp)}</b></small>`}</div>
                <div class="spd-timer"><svg viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="20" fill="none" stroke="#E0E7FF" stroke-width="4"/><circle id="spdRing" cx="22" cy="22" r="20" fill="none" stroke="#4F46E5" stroke-width="4" stroke-linecap="round" stroke-dasharray="125.66" style="stroke-dashoffset:${(125.66 * (1 - left / (sp.total * 1000))).toFixed(2)}" transform="rotate(-90 22 22)"/></svg><b id="spdTime">${Math.ceil(left / 1000)}</b></div>
            </div>
            <div class="spd-grid">${[0, 1, 2, 3].map(k => cell('en', k)).join('')}</div>
            <div class="spd-sep"></div>
            <div class="spd-grid">${[0, 1, 2, 3].map(k => cell('cn', k)).join('')}</div>`;
    }
    function advSpeedTap(side, i) {
        let sp = advSp;
        if (!sp || sp.over || !adv.active || sp.id !== adv.runId || sp.done.has(i)) return;
        sp.bad = null;
        if (side === 'en') sp.selEn = sp.selEn === i ? null : i; else sp.selCn = sp.selCn === i ? null : i;
        if (sp.selEn !== null && sp.selCn !== null) {
            let a = sp.selEn, b = sp.selCn;
            if (a === b) {
                sp.done.add(a); sp.pairs++;
                advRecordHit(true);
            } else {
                sp.wrong++;
                sp.endAt -= sp.c.pen * 1000;
                sp.bad = { en: a, cn: b };
                advRecordHit(false);
                advNoteWrong(sp.round[a]);
            }
            sp.selEn = null; sp.selCn = null;
            if (sp.ring && sp.pairs >= ADV_RING_NEED) { advSpeedRender(); advSpeedEnd(); return; }
            if (sp.done.size >= sp.round.length) { advSpeedRound(); }
        }
        advSpeedRender();
        advSpeedTick();
    }
    async function advSpeedEnd() {
        let sp = advSp;
        if (!sp || sp.over) return;
        sp.over = true;
        clearInterval(sp.timer);
        if (sp.ring) { advRingEnd(sp); return; }
        const id = sp.id, m = sp.m;
        if (m.key === 'meditate') {
            advMeditateFx(false);
            let b = advChickOverhead('bulb', ADV_BULB_SVG);    // 答完：靈光一閃
            if (b) setTimeout(() => { b.classList.add('out'); setTimeout(() => b.remove(), 400); }, 2200);
        }
        if (!adv.active || id !== adv.runId) return;
        adv.busy = true;
        adv.q = null;
        adv.resolvedSeq = adv.moveSeq;
        let masteryUp = advAddMasteryUse(m.key);
        adv.mastery[m.key] = advMastery(m.key);
        advSave();
        // 加成怎麼算、敵人怎麼防禦：battle-core.js 的 speedEnd
        if (await advPlay(BattleCore.speedEnd(adv, m, sp.pairs, sp.c), id)) return;
        const P = document.getElementById('advPlayer');
        if (masteryUp) {
            advFloat(P, `⬆️ 熟練度 ${masteryUp}`, '#4F46E5');
            let c2 = advSpeedCfg(m);
            let msg = document.createElement('div');
            msg.className = 'spd-guard up';
            msg.textContent = `⬆️「${m.name}」熟練度提升到 ${masteryUp}！秒數 +${m.speed.lvSecs}、上限變成 +${c2.cap}`;
            let box = document.querySelector('#advPanel .spd-result');
            if (box) box.insertBefore(msg, document.getElementById('spdGo'));
        }
        await advWait(400);
        if (id !== adv.runId) return;
        let go = document.getElementById('spdGo'); if (go) go.disabled = false;
        advSp = { over: true, waiting: true, id };
    }
    async function advSpeedDone() {
        if (!advSp || !advSp.waiting || advSp.id !== adv.runId || !adv.active) return;
        const id = advSp.id;
        advSp = null;
        // 扣行動次數、判斷輪不輪到敵人：battle-core.js 的 endAction（跟一般招式同一套）
        if (BattleCore.endAction(adv)) await advEnemyPhase(id);
        else { adv.busy = false; advShowMenu(); }
    }

    // ═════════ 第 9 關套圈圈：開場「天女散花！」═════════
    //   戰鬥一開始先來一場連連看：15 秒內要配對 4 組（配錯扣 2 秒）
    //   沒配完：少幾組就扣幾點 HP（無視防禦），套圈圈丟 4 個小套圈圈過來
    const ADV_RING_NEED = BattleCore.RING_NEED, ADV_RING_SECS = BattleCore.RING_SECS, ADV_RING_PEN = BattleCore.RING_PEN;
    async function advRingOpening(id) {
        adv.busy = true;
        adv.ringOpening = true;
        advUpdateHud();
        document.getElementById('advPanel').innerHTML = `<div class="adv-log" id="advLog">🎯 套圈圈：「天女散花！」</div>`;
        advBtSay('天女散花！', 1600);
        await advWait(1500);
        if (id !== adv.runId || !adv.active) return;
        if (adv.cnWords.length < 4) { adv.busy = false; advBeginRound(); return; }
        adv.q = { type: 'speed', done: false };
        adv.move = null;                          // 開場連連看不算任何招式的命中
        let c = { label: '', stat: '', every: 1, pen: ADV_RING_PEN, secs: ADV_RING_SECS, cap: ADV_RING_NEED };
        if (advBtOn()) advBtLock(true);          // 開場就先把場景高度定好（配對畫面才放得下、不會被切掉）
        advSp = { id, m: { key: 'ring', icon: '🎯', name: '天女散花', speed: c }, c, ring: true, pairs: 0, wrong: 0, endAt: Date.now() + c.secs * 1000, total: c.secs, round: null, over: false };
        advSpeedRound();
        advSpeedRender();
        clearInterval(advSp.timer);
        advSp.timer = setInterval(advSpeedTick, 100);
    }
    async function advRingEnd(sp) {
        const id = sp.id;
        advSp = null;
        adv.q = null;
        if (!adv.active || id !== adv.runId) return;
        if (await advPlay(BattleCore.ringResult(adv, sp.pairs), id)) return;
        advBeginRound();
    }
    // 4 個小套圈圈從套圈圈飛到雞塊身上
    async function advRingThrow(n) {
        const P = document.getElementById('advPlayer'), E = document.getElementById('advEnemy');
        if (!P || !E || !P.offsetParent) return;
        let host = P.offsetParent;
        let ex = E.offsetLeft + E.offsetWidth / 2, ey = E.offsetTop + E.offsetHeight * 0.45;
        let px = P.offsetLeft + P.offsetWidth / 2, py = P.offsetTop + P.offsetHeight * 0.5;
        let size = Math.max(22, Math.round(E.offsetWidth * 0.26));
        let anims = [];
        for (let k = 0; k < n; k++) {
            let r = document.createElement('div');
            r.className = 'adv-mini-ring';
            r.style.width = r.style.height = size + 'px';
            r.style.left = (ex - size / 2) + 'px';
            r.style.top = (ey - size / 2) + 'px';
            host.appendChild(r);
            let tx = px - ex + (k - (n - 1) / 2) * size * 0.35, ty = py - ey - k * size * 0.18;
            let a = r.animate([
                { transform: 'translate(0,0) rotate(0deg) scale(.6)', opacity: 0 },
                { transform: `translate(${tx * 0.5}px, ${ty * 0.5 - size * 1.6}px) rotate(200deg) scale(1)`, opacity: 1, offset: 0.5 },
                { transform: `translate(${tx}px, ${ty}px) rotate(400deg) scale(.9)`, opacity: 1 }
            ], { duration: 650, delay: k * 140, easing: 'ease-in', fill: 'forwards' });
            anims.push(a.finished.catch(() => {}));
            setTimeout(() => r.remove(), 650 + k * 140 + 700);
        }
        await Promise.all(anims);
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
    function advCnNorm(s) { return cnDigits(String(s || '').normalize('NFC').replace(/[\s　，,、；;。.！!？?\/／]/g, '').toLowerCase()); }
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
                ${getSpeechRecognitionCtor() ? `<button type="button" class="adv-cn-mic" id="advCnMic" aria-label="用說的（中文）" data-on-click='[["advCnMicTap",[]]]'><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="22"/></svg></button>` : ''}
                <button type="button" data-on-click='[["advSubmitCn",[]]]'>送出</button>
            </div>
            <div class="adv-qsub" id="advCnSub"></div>`;
        let inp = document.getElementById('advCnInput');
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); advSubmitCn(); } });
        setTimeout(() => { try { inp.focus({ preventScroll: true }); } catch (e) {} }, 50);
    }
    // 衝鋒撞擊：按麥克風用中文說出意思（zh-TW 語音辨識），辨識到的字填進輸入框
    let advCnRec = null;
    function advCnMicStop() { if (advCnRec) { try { advCnRec.abort(); } catch (e) {} advCnRec = null; } let b = document.getElementById('advCnMic'); if (b) b.classList.remove('on'); }
    function advCnMicTap() {
        let q = adv.q;
        if (!adv.active || adv.busy || !q || q.type !== 'typeCn' || q.done) return;
        if (advCnRec) { advCnMicStop(); return; }
        const SR = getSpeechRecognitionCtor();
        if (!SR) return;
        let rec = new SR(), btn = document.getElementById('advCnMic'), sub = document.getElementById('advCnSub');
        rec.lang = 'zh-TW'; rec.interimResults = true; rec.maxAlternatives = 3; rec.continuous = false;
        advCnRec = rec;
        if (btn) btn.classList.add('on');
        if (sub) sub.textContent = '🎤 請說出中文意思…';
        rec.onresult = (e) => {
            let inp = document.getElementById('advCnInput');
            if (!inp || adv.q !== q || q.done) return;
            let r = e.results[e.results.length - 1], best = r[0].transcript;
            if (r.isFinal) for (let k = 0; k < r.length; k++) if (advCnMatch(r[k].transcript, q.word.chinese)) { best = r[k].transcript; break; }
            inp.value = best.replace(/[。．.！!？?]+$/, '');
            if (r.isFinal && sub) sub.textContent = '聽到了！確認沒問題就按「送出」';
        };
        rec.onerror = () => { if (sub && advCnRec === rec) sub.textContent = '沒有聽清楚，可以再按一次 🎤 或直接打字'; };
        rec.onend = () => { if (advCnRec === rec) advCnRec = null; let b = document.getElementById('advCnMic'); if (b) b.classList.remove('on'); };
        try { rec.start(); } catch (e) { advCnMicStop(); }
    }
    async function advSubmitCn() {
        advCnMicStop();
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
            <div class="adv-log" id="advLog">${m.icon} ${m.name}${advProgText()}${cn ? '' : '：聽發音，選出正確的單字'}</div>
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
            <div class="adv-spell-hint"><button type="button" class="adv-replay" aria-label="再聽一次" data-on-click='[["advReplayListen",[]]]'>🔊</button><span>提示：${advSpellHint(w.english)}</span></div>
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
    // 突刺的提示：第一個字母＋每個字母一條底線（片語的空格保留）＋總共幾個字母
    function advSpellHint(en) {
        let t = String(en || '').trim(), n = (t.match(/[A-Za-z]/g) || []).length, first = true;
        let marks = Array.from(t).map(ch => {
            if (/[A-Za-z]/.test(ch)) { if (first) { first = false; return `<b>${escapeHTML(ch)}</b>`; } return '<i>_</i>'; }
            return ch === ' ' ? '<i class="sp"></i>' : escapeHTML(ch);
        }).join('');
        return `<span class="adv-spell-marks">${marks}</span><small>（${n} 個字母）</small>`;
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
        rec.continuous = true;     // 按住期間持續收音，放開才結束（單音節短字比較不會沒結果）
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
    // 衝鋒撞擊變身的山豬（側面、朝右衝）
    const ADV_BOAR_SVG = `<svg viewBox="0 0 110 84" width="100%" height="100%" style="overflow:visible" aria-hidden="true">
        <ellipse cx="54" cy="78" rx="40" ry="5" fill="#000" opacity=".15"/>
        <path d="M14 46 Q4 42 8 34" stroke="#3F2A14" stroke-width="2.6" fill="none" stroke-linecap="round"/>
        <rect x="22" y="58" width="9" height="18" rx="3" fill="#5C3A1A" stroke="#231F20" stroke-width="2"/>
        <rect x="64" y="58" width="9" height="18" rx="3" fill="#5C3A1A" stroke="#231F20" stroke-width="2"/>
        <ellipse cx="48" cy="46" rx="36" ry="24" fill="#8B5A2B" stroke="#231F20" stroke-width="2.6"/>
        <path d="M18 34 L22 22 L28 31 L33 17 L40 28 L46 15 L52 27 L58 17 L63 29 L70 22 L72 34 Z" fill="#4A2F14" stroke="#231F20" stroke-width="2" stroke-linejoin="round"/>
        <rect x="34" y="60" width="9" height="17" rx="3" fill="#6B4423" stroke="#231F20" stroke-width="2"/>
        <rect x="52" y="60" width="9" height="17" rx="3" fill="#6B4423" stroke="#231F20" stroke-width="2"/>
        <ellipse cx="82" cy="44" rx="17" ry="16" fill="#8B5A2B" stroke="#231F20" stroke-width="2.6"/>
        <path d="M72 31 L74 17 L84 29 Z" fill="#6B4423" stroke="#231F20" stroke-width="2" stroke-linejoin="round"/>
        <ellipse cx="98" cy="50" rx="8.5" ry="7.5" fill="#F0A58A" stroke="#231F20" stroke-width="2.2"/>
        <circle cx="96" cy="49" r="1.6" fill="#231F20"/><circle cx="101" cy="50" r="1.6" fill="#231F20"/>
        <path d="M90 57 Q94 66 101 58" fill="#FFFFFF" stroke="#231F20" stroke-width="1.8" stroke-linejoin="round"/>
        <circle cx="86" cy="39" r="3" fill="#231F20"/><circle cx="87" cy="38" r="1" fill="#FFFFFF"/>
        <path d="M80 33 L91 35" stroke="#231F20" stroke-width="2.4" stroke-linecap="round"/>
        <path d="M-6 40 H8 M-10 50 H6 M-4 60 H10" stroke="#CBD5E1" stroke-width="3" stroke-linecap="round" opacity=".85"/>
    </svg>`;
    // 突刺刺穿的洞（黑色的洞＋裂痕）
    const ADV_HOLE_SVG = `<svg viewBox="0 0 40 40" width="100%" height="100%" style="overflow:visible" aria-hidden="true">
        <path d="M20 9 L23 3 M30 13 L37 9 M31 25 L38 28 M21 31 L19 38 M10 26 L3 30 M9 14 L3 10" stroke="#231F20" stroke-width="2" stroke-linecap="round"/>
        <path d="M20 8 L25 11 L31 12 L32 18 L33 24 L28 29 L21 32 L15 30 L9 27 L8 20 L9 13 L14 10 Z" fill="#1A1626" stroke="#231F20" stroke-width="2" stroke-linejoin="round"/>
        <ellipse cx="19" cy="18" rx="7" ry="6" fill="#05040A"/>
        <path d="M13 14 Q17 11 22 12" stroke="#ffffff" stroke-width="1.4" fill="none" opacity=".35" stroke-linecap="round"/>
    </svg>`;
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
            // 衝鋒撞擊：「砰」一聲變成山豬 → 往後蓄力、一口氣衝過去 → 敵人被撞退一步 → 變回雞塊
            let keep = P.innerHTML;
            const poof = (sz) => { let b = advFx('<div class="adv-poof"></div>', pc.x, pc.y, sz); if (b) advAnimate(b, [{ opacity: 0.95, transform: 'scale(.4)' }, { opacity: 0, transform: 'scale(1.5)' }], { duration: 420, easing: 'ease-out' }).then(() => b.remove()); };
            poof(Math.max(70, P.offsetWidth * 1.1));
            P.innerHTML = ADV_BOAR_SVG; P.classList.add('is-boar');
            await advAnimate(P, [{ transform: 'scale(.7)' }, { transform: 'scale(1.12)', offset: 0.6 }, { transform: 'scale(1)' }], { duration: 300, easing: 'ease-out' });
            await advAnimate(P, [{ transform: 'translate(0,0) scale(1)' }, { transform: `translate(${-d.dx * 0.12}px, ${-d.dy * 0.12}px) scale(0.9)` }], { duration: 220, fill: 'forwards', easing: 'ease-out' });
            let p = advAnimate(P, [
                { transform: `translate(${-d.dx * 0.12}px, ${-d.dy * 0.12}px) scale(0.9)` },
                { transform: `translate(${d.dx * 0.8}px, ${d.dy * 0.8}px) scale(1.2)`, offset: 0.55 },
                { transform: `translate(${d.dx * 0.8}px, ${d.dy * 0.8}px) scale(1.2)`, offset: 0.65 },
                { transform: 'translate(0,0) scale(1)' }], { duration: 620, easing: 'cubic-bezier(.5,0,.3,1)' });
            await advWait(330); burst('💥', 64);
            // 敵人被撞退一步（動裡面的圖，外框留給受傷的抖動）
            let es = E.firstElementChild;
            if (es) advAnimate(es, [{ transform: 'translate(0,0)' }, { transform: `translate(${d.dx * 0.2}px, ${d.dy * 0.2}px) rotate(6deg)`, offset: 0.25 }, { transform: `translate(${d.dx * 0.2}px, ${d.dy * 0.2}px)`, offset: 0.75 }, { transform: 'translate(0,0)' }], { duration: 1300, easing: 'ease-out' });
            advAnimate(document.getElementById('advStage'), [{ transform: 'translate(0,0)' }, { transform: 'translate(-3px,2px)' }, { transform: 'translate(3px,-2px)' }, { transform: 'translate(0,0)' }], { duration: 240 });
            await p;
            poof(Math.max(60, P.offsetWidth));
            P.innerHTML = keep; P.classList.remove('is-boar');
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
            await advWait(200); burst('✨', 40);
            // 刺穿：敵人身上留下一個洞，過一下再消失
            let hole = document.createElement('div');
            hole.className = 'adv-hole';
            hole.innerHTML = ADV_HOLE_SVG;
            E.appendChild(hole);
            advAnimate(hole, [{ opacity: 0, transform: 'translate(-50%,-50%) scale(.2)' }, { opacity: 1, transform: 'translate(-50%,-50%) scale(1.1)', offset: 0.5 }, { opacity: 1, transform: 'translate(-50%,-50%) scale(1)' }], { duration: 220, fill: 'forwards' });
            setTimeout(() => { advAnimate(hole, [{ opacity: 1 }, { opacity: 0 }], { duration: 400, fill: 'forwards' }).then(() => hole.remove()); }, 1300);
            await p;
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
    async function advShowCoins(actorEl, luck, who, title) {
        title = title || '幸運擲幣';
        advSetLog(`🪙 ${who || ''}${title}中…`);
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
        advSetLog(`🪙 ${who || ''}${title}：${advCoinText(luck.flips)}${luck.bonus ? `　正面 ${luck.bonus} 次！傷害 +${luck.bonus}` : '　沒有正面'}`);
        await advWait(550);
        if (row) await advAnimate(row, [{ opacity: 1 }, { opacity: 0 }], { duration: 220 }).then(() => row.remove());
        if (luck.bonus) { advFloat(actorEl, `+${luck.bonus}`, '#B45309'); await advWait(250); }
    }

    // ═════════ 播放戰鬥事件 ═════════
    //   戰鬥規則（傷害、特殊能力、裝備效果、誰先誰後）都在 battle-core.js，
    //   battle-core.js 每做完一步就丟出一個事件，這裡只負責「把事件演出來」。
    //   ⚠️ 不要在這裡算傷害或加規則：改 battle-core.js，模擬器才會一起更新。
    async function advPlay(gen, id) {
        for (let r = gen.next(); !r.done; r = gen.next()) {
            if (id !== adv.runId || !adv.active) return true;
            let stop = await advOnEvent(r.value, id);
            if (adv.player && advData.hp !== adv.player.hp && adv.active) { advData.hp = adv.player.hp; advSave(); }   // 體力會繼承到之後的戰鬥
            if (stop || id !== adv.runId) return true;
        }
        return id !== adv.runId;
    }
    function advPanelLog(html) { document.getElementById('advPanel').innerHTML = `<div class="adv-log" id="advLog">${html}</div>`; }
    async function advOnEvent(ev, id) {
        const P = document.getElementById('advPlayer'), E = document.getElementById('advEnemy');
        const e = adv.enemy, m = ev.move;
        switch (ev.t) {
            case 'win':
                await advWin(id); return true;
            case 'lose':
                if (ev.why === 'shift') { advClerkTag(); advLose(id, 'shift'); return true; }
                await advLose(id); return true;
            // ── 開場 ──
            case 'coffee':
                advPanelLog(`☕ ${escapeHTML(e.name)}冒著熱氣…`);
                await advWait(700);
                if (id !== adv.runId) return true;
                advFloat(E, '太燙了！', '#B45309');
                if (ev.dmg > 0) {
                    advSetLog(`☕ 好燙！雞塊被燙傷了，受到 ${ev.dmg} 點傷害`);
                    advUpdateHud();
                    await advHurt(P, ev.dmg, false, '-' + ev.dmg);
                } else {
                    advSetLog('☕ 好燙！還好雞塊夠聰明，沒有被燙傷');
                    await advWait(500);
                }
                await advWait(500);
                return false;
            case 'ringDodge':
                advPanelLog(`✨ 配對了 ${ev.pairs} 組，全部躲開了！`);
                advFloat(P, '躲開了！', '#10B981');
                await advWait(1100);
                return false;
            case 'ringThrow':
                advPanelLog(`🎯 只配對了 ${ev.pairs} 組…套圈圈丟出 4 個小套圈圈！`);
                await advRingThrow(4);
                return false;
            case 'ringHit':
                advSetLog(`🎯 被小套圈圈套中！無視防禦，${ev.r.absorbed ? `護盾擋下 ${ev.r.absorbed} 點，` : ''}雞塊受到 ${ev.r.loss} 點傷害`);
                advUpdateHud();
                await advHurt(P, ev.miss, false, advHurtLabel(ev.r));
                if (adv.player.hp > 0) await advWait(500);
                return false;
            // ── 回合開始 ──
            case 'menu':
                if (e.special === 'clerk') advClerkTag();
                adv.busy = false;
                advShowMenu();
                return false;
            case 'post':
                advSetLog(`🏪「歡迎光臨！今天我負責${ev.post.name}」（這回合${ev.post.immune === 'speed' ? `速答招式的加成 −${ADV_CLERK_SPEED_GUARD}` : ADV_TYPE_LABEL[ev.post.immune] + '招式無效'}）`);
                advFloat(E, ev.post.name, '#2563EB');
                return false;
            case 'billSlow':
                advSetLog('🧾 條碼刷不過..'); advFloat(E, '條碼刷不過..', '#64748B');
                return false;
            case 'seal':
                advSetLog(`🧾 取票失敗！這回合有 ${ev.keys.length} 招被封印（灰色的不能用）`);
                advFloat(E, '取票失敗！', '#F97316');
                return false;
            // ── 換下一個敵人、店員交班 ──
            case 'phaseOut':
                advPanelLog(`💥 ${escapeHTML(ev.old.name)}被打倒了…等等！裡面的${escapeHTML(ev.next.name)}跳出來了！`);
                await advAnimate(E, [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0.2) rotate(200deg)', opacity: 0 }], { duration: 520, easing: 'ease-in' });
                return false;
            case 'phaseIn': {
                if (E) E.innerHTML = advEnemySVG(ev.enemy.sprite);
                let nm = document.getElementById('advEnemyName');
                if (nm) nm.textContent = ev.enemy.name;
                advUpdateHud();
                await advAnimate(E, [{ transform: 'translateY(-40px) scale(0.6)', opacity: 0 }, { transform: 'translateY(6px) scale(1.08)', opacity: 1, offset: 0.7 }, { transform: 'translateY(0) scale(1)', opacity: 1 }], { duration: 560, easing: 'ease-out' });
                if (id !== adv.runId) return true;
                advFloat(E, '登場！', '#F97316');
                await advWait(500);
                return false;
            }
            case 'shift':
                advSetLog(`🔔 交班中！${e.name}換上新的同事：敏捷、攻擊力、護盾都提升了，還回復 10 點體力`);
                advFloat(E, '交班中！', '#F97316');
                advUpdateHud(); advClerkTag();
                await advWait(1100);
                return false;
            case 'bill':
                advSetLog('🧾 救命！是繳費單！（店員被繳費單纏住，動作變慢了）');
                advFloat(E, '救命！是繳費單！', '#DC2626');
                advUpdateHud();
                await advWait(1200);
                return false;
            // ── 雞塊出招 ──
            case 'moveOk':
                advPanelLog(`${m.icon} 「${m.name}」發動成功！`);
                return false;
            case 'stamp':
                advFloat(P, `🎫 ${ADV_TYPE_LABEL[ev.type]}集點！`, '#7C3AED');
                return false;
            case 'attack':
                await advPlayAttack(m, ev.h);
                return false;
            case 'coins':
                if (ev.who === 'player') await advShowCoins(P, ev.luck, ev.hits > 1 ? `第 ${ev.h + 1} 下` : '', ev.crit ? '爆擊判定' : undefined);
                else await advShowCoins(E, ev.luck, e.name + '的');
                return false;
            case 'enemyHurt': {
                let er = ev.r;
                if (ev.weak) advFloat(E, '💥 效果拔群！', '#DC2626', -30);   // 往上放，不跟傷害數字疊在一起
                advSetLog(ev.immune
                    ? `🛡️ ${e.name}防禦了${ADV_TYPE_LABEL[m.type]}招式！完全沒有受到傷害`
                    : ev.guarded
                    ? `🛡️ ${e.name}防禦了${ADV_TYPE_LABEL[m.type]}招式！${er.absorbed ? `護盾再擋下 ${er.absorbed} 點，` : ''}只受到 ${er.loss} 點傷害`
                    : `${ev.weak ? '💥 效果拔群！' : '✨'}「${m.name}」${m.hits > 1 ? `第 ${ev.h + 1} 下` : ''}命中！${e.name}${er.absorbed ? `護盾擋下 ${er.absorbed} 點，` : ''}${ev.pierce ? '竹籤刺穿護盾！' : ''}受到 ${er.loss} 點傷害`);
                advUpdateHud();
                await advHurt(E, ev.dmg, true, (ev.guarded ? '🛡️防禦 ' : '') + advHurtLabel(er));
                return false;
            }
            case 'stampsFull':
                advSetLog('🎫 集點卡集滿了！招式選單多了「兌換集點卡！」');
                await advWait(900);
                return false;
            case 'miss':
                advPanelLog(`💨 「${m.name}」發動失敗…`);
                advFloat(P, 'MISS', '#64748B');
                await advAnimate(P, [{ transform: 'translateX(0)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(5px)' }, { transform: 'translateX(0)' }], { duration: 320 });
                await advWait(300);
                return false;
            case 'tofu':
                advSetLog('🔥 烤焦臭豆腐爆發！雙方各扣 1 點體力');
                advUpdateHud();
                await Promise.all([advHurt(E, 1, true, advHurtLabel(ev.er)), advHurt(P, 1, false, advHurtLabel(ev.pr))]);
                return false;
            case 'stink':
                advBtSay(ADV_TOFU_LINES[Math.floor(Math.random() * ADV_TOFU_LINES.length)]);
                advSetLog(`🤢 ${e.name}散發臭味！無視防禦，${ev.r.absorbed ? '護盾擋下 1 點' : '雞塊受到 1 點傷害'}`);
                advUpdateHud();
                await advHurt(P, 1, false, advHurtLabel(ev.r));
                return false;
            case 'moveEnd': case 'speedEnd': case 'roundEnd':
                return false;
            // ── 速答 ──
            case 'speedResult': {
                let segs = Array.from({ length: ev.cap }, (_, k) => `<i class="${k < ev.got ? 'on' : ''}"></i>`).join('');
                let guardTxt = ev.guard ? `<div class="spd-guard">🛡️ ${escapeHTML(e.name)}防禦了速答招式！加成 −${ev.guard}${ev.raw ? `（+${ev.raw} → +${ev.got}）` : ''}</div>` : '';
                let gotTxt = m.speed.stat === 'int'
                    ? `智慧 +${ev.applied}${ev.applied < ev.got ? `（這場已加到上限 +${ev.cap}）` : ''}`
                    : `下一招攻擊 +${ev.got}（最多 +${ev.cap}）`;
                let isLast = adv.actionsLeft <= 1;
                document.getElementById('advPanel').innerHTML = `
            <div class="spd-result">
                <div class="spd-res-h">⏱ 時間到！配對成功</div>
                <div class="spd-res-n">${ev.pairs} 組</div>
                <div class="spd-segs">${segs}</div>
                <div class="spd-res-got">${gotTxt}</div>
                ${guardTxt}
                <button type="button" class="spd-go" id="spdGo" disabled data-on-click='[["advSpeedDone",[]]]'>${isLast ? '繼續' : '繼續選招式'}</button>
            </div>`;
                advUpdateHud();
                if (ev.guard) advFloat(E, `🛡️防禦 −${ev.guard}`, '#0EA5E9', -30);
                if (ev.applied && m.speed.stat === 'int') advFloat(P, `智慧 +${ev.applied}`, '#7C3AED');
                if (ev.got && m.speed.stat === 'atk') advFloat(P, `攻擊 +${ev.got}`, '#DB2777');
                return false;
            }
            case 'speedHurt':
                await advWait(500);
                if (id !== adv.runId) return true;
                advFloat(E, '💥 效果拔群！', '#DC2626', -30);
                advUpdateHud();
                await advHurt(E, ev.dmg, true, advHurtLabel(ev.r));
                return false;
            // ── 敵人的回合 ──
            case 'enemyTurn':
                advPanelLog(`${escapeHTML(e.name)}的「${escapeHTML(e.moveName)}」攻擊！`);
                await advWait(350);
                return false;
            case 'pinball':
                advFloat(E, '🎰技能骰 ' + ev.r, '#0284C7');
                if (ev.effect === 'heal') {
                    advSetLog(`🎰【打彈珠】技能骰 ${ev.r}（不是幸運骰）　彈珠台回復 2 點體力`);
                    await advWait(500);
                    advUpdateHud();
                    advFloat(E, '+2', '#10B981');
                    await advWait(700);
                } else if (ev.effect === 'none') {
                    advSetLog(`🎰【打彈珠】技能骰 ${ev.r}（不是幸運骰）　沒有效果`);
                    await advWait(1000);
                } else {
                    advSetLog(`🎰【打彈珠】技能骰 ${ev.r}（不是幸運骰）　彈珠直擊！無視防禦扣 1 點體力`);
                    await advWait(500);
                    advUpdateHud();
                    await advHurt(P, 1, false, advHurtLabel(ev.r2));
                    if (adv.player.hp <= 0) return false;
                }
                if (id !== adv.runId) return true;
                advPanelLog(`${escapeHTML(e.name)}的「${escapeHTML(e.moveName)}」攻擊！`);
                return false;
            case 'enemyAttack': {
                if (ev.hh === 0 && ADV_ENEMY_LINES[e.sprite]) advBtSay(ADV_ENEMY_LINES[e.sprite]);   // 新版戰鬥畫面：敵人攻擊時在雞塊上方說話
                const d = advDelta(E, P);
                await advAnimate(E, [{ transform: 'translate(0,0) scale(1)' }, { transform: `translate(${d.dx * 0.8}px, ${d.dy * 0.8}px) scale(1.12)`, offset: 0.5 }, { transform: 'translate(0,0) scale(1)' }], { duration: ev.eh > 1 ? 400 : 480, easing: 'ease-in-out' });
                return false;
            }
            case 'playerHurt':
                advSetLog(`${e.name}的攻擊${ev.eh > 1 ? `（第 ${ev.hh + 1} 下）` : ''}！${ev.r.absorbed ? `護盾擋下 ${ev.r.absorbed} 點，` : ''}雞塊受到 ${ev.r.loss} 點傷害`);
                advUpdateHud();
                await advHurt(P, ev.dmg, false, advHurtLabel(ev.r));
                if (adv.player.hp > 0 && ev.hh < ev.eh - 1) await advWait(250);
                return false;
            case 'microwave':
                advSetLog(`🔥 轉吧！美味雞塊！${e.name}越來越燙，攻擊力 +${ADV_MICRO_ATK_UP}（現在 ${ev.atk}）`);
                advFloat(E, `攻擊 +${ADV_MICRO_ATK_UP}`, '#F97316');
                advUpdateHud();
                await advWait(800);
                return false;
            case 'expireSelf':
                advSetLog(`🥀 我快過期了..（${e.name}自己扣了 ${ev.dmg} 點體力）`);
                advUpdateHud();
                await advHurt(E, ev.dmg, true, '-' + ev.dmg);
                if (id !== adv.runId) return true;
                advFloat(E, '我快過期了..', '#64748B');
                await advWait(500);
                return false;
            case 'heal':
                advSetLog(`💚 ${e.name}${ev.trait ? '' : '發動治癒，'}回復 ${ev.value} 點體力`);
                advUpdateHud();
                advFloat(E, '+' + ev.value, '#10B981');
                await advWait(900);
                return false;
            // ── 特殊能力積木（traits）的通用演出 ──
            case 'trait': {
                let el = ev.target === 'enemy' ? E : P;
                advSetLog(ev.text || '');
                advUpdateHud();
                if (ev.target === 'player' && (ev.dmg || (ev.r && ev.r.loss))) await advHurt(P, ev.dmg || ev.r.loss, false, ev.r ? advHurtLabel(ev.r) : '-' + ev.dmg);
                else { if (ev.float) advFloat(el, ev.float, '#F97316'); await advWait(800); }
                return false;
            }
        }
        return false;
    }

    async function advResolveMove(ok) {
        if (!adv.active) return;
        // 防呆：同一次出招只結算一次（避免多題招式在最後一題被重複結算，一次扣掉兩次行動）
        if (adv.resolvedSeq === adv.moveSeq) { console.warn('同一招重複結算，已忽略'); return; }
        adv.resolvedSeq = adv.moveSeq;
        // 熟練度：不論成功或失敗，用一次就 +1（先算好，打倒敵人直接勝利時也會算到）
        let masteryUp = adv.move ? advAddMasteryUse(adv.move.key) : 0;
        if (adv.move) adv.mastery[adv.move.key] = advMastery(adv.move.key);
        if (!ok && adv.q && adv.q.word) advNoteWrong(adv.q.word);
        advSave();
        if (!ok) advRecordHit(false);
        const id = adv.runId;
        adv.busy = true;
        const m = adv.move;
        const P = document.getElementById('advPlayer');
        advStopTimer();
        adv.q = null;
        // 傷害、特殊能力、裝備效果：battle-core.js 的 playerMove
        if (await advPlay(BattleCore.playerMove(adv, m, ok), id)) return;
        let up = masteryUp;
        if (up) {
            advFloat(P, `⬆️ 熟練度 ${up}`, '#4F46E5');
            advSetLog(`⬆️ 「${m.name}」熟練度提升到 ${up}！這招攻擊 +${advMasteryPerLv(m.key)}`);
            await advWait(900);
            if (id !== adv.runId) return;
        }
        if (BattleCore.endAction(adv)) await advEnemyPhase(id);
        else { adv.busy = false; advShowMenu(); }
    }

    async function advEnemyPhase(id) {
        // 敵人攻擊、特殊能力：battle-core.js 的 enemyPhase
        if (await advPlay(BattleCore.enemyPhase(adv), id)) return;
        advBeginRound();
    }

    async function advWin(id) {
        const P = document.getElementById('advPlayer'), E = document.getElementById('advEnemy');
        adv.active = false;
        releaseWakeLock();
        let lv = adv.level;
        let first = !advData.cleared[lv.id];
        let xpOld = !first;                       // 舊關卡：經驗值 70%
        // 重複通關：每天前 3 次有通關獎勵；之後打贏只增加招式熟練度（熟練度在出招時就累積了）
        let rewardOK = first || advReplaysUsed() < ADV_REPLAY_PER_DAY;
        if (!first && rewardOK) { advData.replays = advReplaysUsed() + 1; advData.replayDay = getLocalDateStr(); }
        advData.cleared[lv.id] = true;
        advSaveLastWrong();
        try {   // 每日任務：在大冒險中打贏一場敵人
            checkDailyReset();
            if (chickenData.tasks.advWin && !chickenData.tasks.advWin.done && !isTaskClaimed('advWin')) { chickenData.tasks.advWin.done = true; saveChickenData(); }
        } catch (e) {}
        let gainShards = first ? lv.firstShards : (rewardOK ? lv.repeatShards : 0);
        let gainSauce = first ? lv.firstSauce : 0;
        // 幸運的第二個用途：打贏後擲幣，每個正面碎片 +1（最多 +3）；今天的獎勵領完就不擲
        let loot = rewardOK ? advRollLuck(adv.player.luck, adv.enemy.luck) : { flips: [], bonus: 0 };
        let dropPotion = (!first && rewardOK && lv.potionChance && Math.random() < lv.potionChance) ? 1 : 0;    // IBON 機：重複通關 20% 掉恢復藥水
        if (dropPotion) advData.potions += dropPotion;
        let sodaHeal = 0;
        sodaHeal = BattleCore.winHeal(adv.gear, advData.hp, advMaxHp());   // 彈珠汽水：battle-core.js
        if (sodaHeal) { advData.hp += sodaHeal; adv.player.hp = advData.hp; }
        gainShards += loot.bonus;
        let clawBonus = (rewardOK && lv.special === 'claw') ? 1 : 0;   // 娃娃機：多掉 1 個冒險代幣
        gainShards += clawBonus;
        advData.shards += gainShards;
        let gotWipes = first ? (lv.firstWipes || 0) : 0;
        if (gotWipes) advData.wipes += gotWipes;
        // 經驗值：每關固定；每天第一場勝利 ×2
        let xpDouble = advData.xpDay !== getLocalDateStr();
        let gainXp = advWinXp(lv, xpOld, xpDouble);
        if (xpDouble) advData.xpDay = getLocalDateStr();
        let lvBefore = advLevel();
        advData.xp = (advData.xp || 0) + gainXp;
        let lvAfter = advLevel();
        if (lvAfter > lvBefore) advData.lvUpAt = Date.now();       // 能力值頁的紅點跳兩下
        let gotCombo = false, gotMaxHp = 0, gotPotions = 0;
        if (first && lv.firstMaxHp && advData.up.hp < advUpMax('hp')) { gotMaxHp = lv.firstMaxHp; advData.up.hp += gotMaxHp; advData.hp += gotMaxHp; }
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
        lines.push(`<div class="line" style="color:#7C3AED;font-weight:800;"><span class="xp-ico">XP</span> 經驗值 +${gainXp}${xpDouble ? '（今日首勝 ×2）' : ''}</div>`);
        if (lvAfter > lvBefore) lines.push(`<div class="line" style="color:#7C3AED;font-weight:900;">🎉 升到 Lv.${lvAfter}！到「能力值」加點</div>`);
        if (gainShards > 0) { lines.push(`<div class="line">${advShardIcon(16)} 冒險代幣 +${gainShards}</div>`); pop.push(`${advShardIcon(22)} 冒險代幣 ×${gainShards}`); }
        if (loot.flips.length) {
            lines.push(`<div class="line" style="color:#B45309;font-weight:700;">🪙 幸運擲幣 ${advCoinText(loot.flips)}　${loot.bonus ? `正面 ${loot.bonus} 次，代幣多 +${loot.bonus}` : '沒有正面，沒有額外代幣'}</div>`);
            if (loot.bonus) pop.push(`🪙 幸運加成：冒險代幣 +${loot.bonus}`);
        }
        if (!rewardOK) lines.push(`<div class="line" style="color:var(--text-muted);font-weight:700;">今天的通關獎勵已經領完了（每天前 ${ADV_REPLAY_PER_DAY} 次），這場累積了招式熟練度</div>`);
        else if (!first) lines.push(`<div class="line" style="color:var(--text-muted);font-size:12px;">今日通關獎勵 ${advReplaysUsed()} / ${ADV_REPLAY_PER_DAY}</div>`);
        if (dropPotion) { pop.push(`${advPotionIcon(22)} 小型恢復藥水 ×1`); lines.push(`<div class="line" style="font-weight:800;">${advPotionIcon(16)} 掉落小型恢復藥水 ×1</div>`); }
        if (sodaHeal) lines.push(`<div class="line" style="color:#0369A1;font-weight:800;">${advSodaIcon(16)} 喝了彈珠汽水，HP +1</div>`);
        if (clawBonus) pop.push(`🧸 送你娃娃！冒險代幣 +1`);
        if (gotItem) pop.push(`${ADV_ITEMS[gotItem].icon(22)} 獲得裝備：${ADV_ITEMS[gotItem].name}${hadGearBefore ? '' : '<br><small style="color:#EF4444;font-weight:800;">❗ 到「能力值 → 裝備」裝備它</small>'}`);
        if (first && lv.id === 2) pop.push(`🛒 補給站可以用冒險代幣買裝備囉！<br><small style="color:var(--text-muted);font-weight:700;">首頁「雞塊補給站」→ 雞塊大冒險（彈珠汽水 ${ADV_SODA_PRICE} 代幣）</small>`);
        if (gainSauce > 0) pop.push(`${advSauceIcon(22)} 糖醋醬 ×${gainSauce}`);
        if (gotMaxHp) pop.push(`❤️ 生命上限 +${gotMaxHp}`);
        if (gotPotions) pop.push(`${advPotionIcon(22)} 小型恢復藥水 ×${gotPotions}`);
        gotMoves.forEach(m => pop.push(`${m.icon} 學會${m.name}`));
        if (gainSauce > 0) lines.push(`<div class="line" style="color:${ADV_SAUCE_COLOR};font-weight:800;">${advSauceIcon(16)} ${first ? '首次通關獎勵：' : ''}糖醋醬 +${gainSauce}</div>`);
        if (gotMaxHp) lines.push(`<div class="line" style="font-weight:800;">❤️ 首次通關獎勵：生命上限 +${gotMaxHp}</div>`);
        if (gotPotions) lines.push(`<div class="line" style="font-weight:800;">${advPotionIcon(16)} 首次通關獎勵：小型恢復藥水 ×${gotPotions}</div>`);
        if (clawBonus) lines.push(`<div class="line" style="font-weight:800;">🧸 送你娃娃！冒險代幣多 +1</div>`);
        if (gotItem) lines.push(`<div class="line" style="font-weight:800;">🎁 首次通關獎勵：${ADV_ITEMS[gotItem].icon(16)} ${ADV_ITEMS[gotItem].name}</div>${hadGearBefore ? '' : '<div class="line" style="color:#EF4444;font-weight:800;">❗ 到「💪 能力值 → 裝備」把它裝備起來吧！</div>'}`);
        if (first && lv.id === 2) lines.push(`<div class="line" style="color:var(--primary);font-weight:800;">🛒 可以到「雞塊補給站」用冒險代幣購買裝備囉！</div>`);
        gotMoves.forEach(m => lines.push(`<div class="line" style="font-weight:800;">🎁 學會新招式：${m.icon} ${m.name}！</div>`));
        let nextLv = ADV_LEVELS.find(l => l.id === lv.id + 1);
        // 戰鬥畫面下方保留簡單的結果（關掉結算畫面時看得到）
        document.getElementById('advPanel').innerHTML = `
            <div class="adv-result"><div class="big">🎉 勝利！</div>${lines.join('')}${advWrongHTML()}</div>
            <button type="button" class="adv-plain-btn sub" data-on-click='[["advBackToMenu",[]]]'>回關卡</button>`;
        // 結算畫面的獎勵：只放 icon＋數量
        let items = [];
        if (gainSauce > 0) items.push({ icon: advSauceIcon(26), n: gainSauce, label: '糖醋醬' });
        items.unshift({ icon: '<span class="xp-ico big">XP</span>', n: gainXp, label: xpDouble ? '經驗值（今日首勝 ×2）' : '經驗值' });
        if (gainShards > 0) items.push({ icon: advShardIcon(26), n: gainShards, label: '冒險代幣' });
        if (gotWipes) items.push({ icon: advWipeIcon(26), n: gotWipes, label: '濕紙巾' });
        if (gotPotions + dropPotion > 0) items.push({ icon: advPotionIcon(26), n: gotPotions + dropPotion, label: '小型恢復藥水' });
        if (gotMaxHp) items.push({ icon: '<span class="cr-emo">❤️</span>', n: gotMaxHp, label: '生命上限' });
        if (gotItem) items.push({ icon: ADV_ITEMS[gotItem].icon(26), n: 1, label: ADV_ITEMS[gotItem].name });
        gotMoves.forEach(m => items.push({ icon: `<span class="cr-emo">${m.icon}</span>`, n: 1, label: '新招式：' + m.name }));
        let notes = [];
        if (gotMoves.length) notes.push(`學會新招式：${gotMoves.map(m => m.name).join('、')}`);
        if (gotItem && !hadGearBefore) notes.push(`到「能力值 → 裝備」把${ADV_ITEMS[gotItem].name}裝備起來`);
        if (first && lv.id === 2) notes.push('補給站可以用冒險代幣買裝備囉！');
        if (loot.bonus) notes.push(`幸運擲幣：冒險代幣多 +${loot.bonus}`);
        if (lvAfter > lvBefore) notes.unshift(`升到 Lv.${lvAfter}！到「能力值」把能力點加上去`);
        if (sodaHeal) notes.push('喝了彈珠汽水，體力 +1');
        advShowResult({ state: first ? 'first' : 'replay', lv, nextLv, items, notes, rewardOK });
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

    // ═════════ 戰鬥結算畫面（首勝／已通關再打／輸了）＋ 首勝插旗動畫 ═════════
    // 樣式：index.html 的 .cr-*（結算）和 .fa-*（插旗）
    const CR_BACK_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"></path><path d="M12 19l-7-7 7-7"></path></svg>';
    const CR_FX_FIRST = '<svg class="cr-hero__fx" viewBox="0 0 358 320" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><defs><radialGradient id="cr-glow"><stop offset="0%" stop-color="#ffe58a" stop-opacity="0.75"/><stop offset="60%" stop-color="#ffd34d" stop-opacity="0.18"/><stop offset="100%" stop-color="#ffd34d" stop-opacity="0"/></radialGradient></defs><g fill="#ffe9a8" opacity="0.14"><path d="M179 175L110 -20h36z"/><path d="M179 175L212 -20h36z"/><path d="M179 175L-30 50v36z"/><path d="M179 175L388 50v36z"/><path d="M179 175L-30 230v36z"/><path d="M179 175L388 230v36z"/><path d="M179 175L60 340h40z"/><path d="M179 175L258 340h40z"/></g><circle cx="179" cy="175" r="120" fill="url(#cr-glow)"/><g class="cr-confetti"><rect x="171" y="83" width="7" height="4" rx="1.5" fill="#ffd34d" transform="rotate(12 171 83)"/><rect x="280" y="54" width="7" height="4" rx="1.5" fill="#ffffff" transform="rotate(14 280 54)"/><rect x="115" y="25" width="6" height="12" rx="1.5" fill="#ffd34d" transform="rotate(107 115 25)"/><rect x="129" y="52" width="8" height="12" rx="1.5" fill="#ffffff" transform="rotate(15 129 52)"/><rect x="69" y="120" width="8" height="4" rx="1.5" fill="#ffd34d" transform="rotate(149 69 120)"/><rect x="301" y="209" width="6" height="10" rx="1.5" fill="#ffffff" transform="rotate(11 301 209)"/><rect x="74" y="154" width="7" height="10" rx="1.5" fill="#ffd34d" transform="rotate(138 74 154)"/><rect x="298" y="163" width="8" height="4" rx="1.5" fill="#ffd34d" transform="rotate(46 298 163)"/><rect x="303" y="298" width="8" height="10" rx="1.5" fill="#ffd34d" transform="rotate(95 303 298)"/><rect x="286" y="38" width="8" height="10" rx="1.5" fill="#fb7185" transform="rotate(158 286 38)"/><rect x="260" y="278" width="7" height="12" rx="1.5" fill="#ffffff" transform="rotate(119 260 278)"/><rect x="98" y="130" width="6" height="4" rx="1.5" fill="#ffffff" transform="rotate(76 98 130)"/><rect x="259" y="181" width="8" height="12" rx="1.5" fill="#ffffff" transform="rotate(73 259 181)"/><rect x="43" y="66" width="8" height="12" rx="1.5" fill="#34d399" transform="rotate(42 43 66)"/><rect x="83" y="256" width="7" height="10" rx="1.5" fill="#ffd34d" transform="rotate(171 83 256)"/><rect x="291" y="299" width="7" height="12" rx="1.5" fill="#34d399" transform="rotate(177 291 299)"/><rect x="310" y="260" width="8" height="12" rx="1.5" fill="#ffd34d" transform="rotate(17 310 260)"/><rect x="346" y="39" width="6" height="4" rx="1.5" fill="#34d399" transform="rotate(179 346 39)"/><rect x="337" y="234" width="7" height="4" rx="1.5" fill="#f97316" transform="rotate(98 337 234)"/><rect x="183" y="17" width="7" height="12" rx="1.5" fill="#ffffff" transform="rotate(43 183 17)"/><rect x="65" y="258" width="6" height="10" rx="1.5" fill="#fb7185" transform="rotate(73 65 258)"/><rect x="206" y="260" width="6" height="10" rx="1.5" fill="#93c5fd" transform="rotate(114 206 260)"/><rect x="287" y="148" width="6" height="12" rx="1.5" fill="#34d399" transform="rotate(140 287 148)"/><rect x="83" y="48" width="6" height="10" rx="1.5" fill="#f97316" transform="rotate(59 83 48)"/><rect x="125" y="12" width="7" height="4" rx="1.5" fill="#34d399" transform="rotate(46 125 12)"/><rect x="150" y="8" width="6" height="12" rx="1.5" fill="#34d399" transform="rotate(136 150 8)"/><rect x="318" y="295" width="7" height="10" rx="1.5" fill="#ffffff" transform="rotate(176 318 295)"/><rect x="322" y="33" width="7" height="4" rx="1.5" fill="#93c5fd" transform="rotate(143 322 33)"/></g><g fill="#ffd34d"><path d="M48 96l3.5 8 8 3.5-8 3.5-3.5 8-3.5-8-8-3.5 8-3.5z"/><path d="M312 118l3 7 7 3-7 3-3 7-3-7-7-3 7-3z"/><path d="M300 236l2.4 5.6 5.6 2.4-5.6 2.4-2.4 5.6-2.4-5.6-5.6-2.4 5.6-2.4z"/><path d="M60 230l2.4 5.6 5.6 2.4-5.6 2.4-2.4 5.6-2.4-5.6-5.6-2.4 5.6-2.4z"/></g></svg>';
    const CR_FX_WIN = '<svg class="cr-hero__fx" viewBox="0 0 358 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><g fill="#ffffff" opacity="0.08"><path d="M179 120L120 -20h30z"/><path d="M179 120L210 -20h30z"/><path d="M179 120L-20 40v30z"/><path d="M179 120L378 40v30z"/><path d="M179 120L30 300h35z"/><path d="M179 120L300 300h35z"/></g><g fill="#ffd34d"><path d="M52 52l3 7 7 3-7 3-3 7-3-7-7-3 7-3z"/><path d="M300 70l2.4 5.6 5.6 2.4-5.6 2.4-2.4 5.6-2.4-5.6-5.6-2.4 5.6-2.4z"/><path d="M290 190l2 4.6 4.6 2-4.6 2-2 4.6-2-4.6-4.6-2 4.6-2z"/><path d="M70 180l2 4.6 4.6 2-4.6 2-2 4.6-2-4.6-4.6-2 4.6-2z"/></g></svg>';
    const CR_FX_LOSE = '<svg class="cr-hero__fx" viewBox="0 0 358 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><circle cx="320" cy="20" r="80" fill="#ffffff" opacity="0.07"/><circle cx="30" cy="290" r="70" fill="#ffffff" opacity="0.06"/></svg>';
    let crData = null;
    function advResultEl() {
        let el = document.getElementById('advResultView');
        if (!el) { el = document.createElement('div'); el.id = 'advResultView'; el.className = 'cr-overlay'; el.hidden = true; document.body.appendChild(el); }
        return el;
    }
    function advShowResult(d) {
        crData = d;
        let lv = d.lv || adv.level, st = d.state;
        let el = advResultEl();
        let hpMax = advMaxHp(), hp = Math.max(0, Math.min(hpMax, advData.hp));
        let ok = adv.stOk || 0, all = Math.max(ok, adv.stAll || 0);
        let used = advReplaysUsed();
        let enemy = `<div class="cr-enemy"><span class="cr-enemy__art">${advEnemySVG(lv.sprite)}</span>${st === 'lose' ? '' : '<span class="cr-enemy__badge">已擊敗</span>'}</div>`;
        let hero = st === 'first'
            ? `<div class="cr-hero cr-hero--first">${CR_FX_FIRST}<h1 class="cr-hero__title">勝利！</h1><div class="cr-ribbon"><span>首次通關</span></div>${enemy}<p class="cr-hero__sub">第 ${lv.id} 關 ${escapeHTML(lv.name)}</p></div>`
            : st === 'replay'
            ? `<div class="cr-hero cr-hero--win">${CR_FX_WIN}<h1 class="cr-hero__title">勝利！</h1>${enemy}<p class="cr-hero__sub">第 ${lv.id} 關 ${escapeHTML(lv.name)}</p></div>`
            : `<div class="cr-hero cr-hero--lose">${CR_FX_LOSE}<h1 class="cr-hero__title">${escapeHTML(d.title || '差一點！')}</h1>${enemy}<p class="cr-hero__sub">第 ${lv.id} 關 ${escapeHTML(lv.name)}</p></div>`;
        let stats = `<div class="cr-stats">
            <div class="cr-stat cr-stat--score"><span class="cr-stat__label">答對</span><span class="cr-num">${ok} <small>/ ${all}</small></span></div>
            <div class="cr-stat cr-stat--hp"><span class="cr-stat__label">剩下體力</span><span class="cr-hpbar" style="--hp: ${hpMax ? (hp / hpMax * 100).toFixed(0) : 0}%"><i></i></span><span class="cr-num cr-num--hp${hp ? '' : ' is-empty'}">${hp} <small>/ ${hpMax}</small></span></div></div>`;
        let mid;
        if (st === 'lose') {
            let ws = adv.wrongThis || [];
            mid = `<div class="cr-miss"><span class="cr-miss__label">${ws.length ? `答錯 ${ws.length} 個字` : '這場沒有答錯的字'}</span>${ws.length ? `<div class="cr-miss__words">${ws.map(w => `<span class="cr-word"><b>${escapeHTML(w.english)}</b> ${escapeHTML(w.chinese || '')}</span>`).join('')}</div>` : ''}</div>`;
        } else {
            let tag = st === 'first' ? '<span class="cr-tag cr-tag--first">首勝</span>' : `<span class="cr-tag cr-tag--today">今日 ${Math.min(used, ADV_REPLAY_PER_DAY)} / ${ADV_REPLAY_PER_DAY}</span>`;
            let its = (d.items || []).map(it => `<span class="cr-item" role="img" aria-label="${escapeHTML(it.label)} ×${it.n}">${it.icon}<b>×${it.n}</b></span>`).join('');
            if (!its) its = `<span class="cr-none">${d.rewardOK === false ? '今日獎勵已領完' : '這次沒有獎勵'}</span>`;
            mid = `<div class="cr-reward"><div class="cr-reward__head"><span class="cr-reward__label">獲得獎勵</span>${tag}</div><div class="cr-reward__items">${its}</div></div>`;
        }
        let notes = (d.notes || []).length ? `<div class="cr-notes">${d.notes.map(t => `<span>${escapeHTML(t)}</span>`).join('')}</div>` : '';
        let doneToday = st === 'replay' && used >= ADV_REPLAY_PER_DAY;
        let btns;
        if (st === 'first') btns = `<button type="button" class="cr-btn cr-btn--primary" data-on-click='[["crContinue",[]]]'>${d.nextLv ? `繼續・解鎖第 ${d.nextLv.id} 關` : '回地圖'}</button>
            ${hp > 0 ? `<button type="button" class="cr-btn cr-btn--secondary" data-on-click='[["crRetry",[]]]'>再打一次</button>` : ''}`;
        else if (st === 'replay') btns = `<button type="button" class="cr-btn cr-btn--primary" data-on-click='[["crNext",[]]]'>${d.nextLv ? `下一關・${escapeHTML(d.nextLv.name)}` : '回地圖'}</button>
            ${hp > 0 ? `<button type="button" class="cr-btn cr-btn--secondary" data-on-click='[["crRetry",[]]]'>再打一次${doneToday ? '<small>今日獎勵已領完</small>' : ''}</button>` : ''}`;
        else btns = (hp > 0 ? `<button type="button" class="cr-btn cr-btn--primary" data-on-click='[["crRetry",[]]]'>再打一次</button>`
                            : `<button type="button" class="cr-btn cr-btn--primary" data-on-click='[["crBack",[]]]'>回關卡頁</button>`) + `
            ${(adv.wrongThis || []).length ? `<div class="cr-review" id="crReview"><button type="button" class="cr-btn cr-btn--secondary" data-on-click='[["crReviewPick",[]]]'>複習答錯的字</button></div>` : ''}`;
        el.innerHTML = `<section class="cr-screen" data-state="${st}" aria-label="戰鬥結算"><div class="cr-card">
            <header class="cr-top"><button type="button" class="cr-back" aria-label="返回" data-on-click='[["crBack",[]]]'>${CR_BACK_SVG}</button><span class="cr-pill">雞塊大冒險</span><span></span></header>
            ${hero}${st === 'lose' ? stats : ''}${mid}${notes}<div class="cr-actions">${btns}</div></div></section>`;
        el.hidden = false;
        el.scrollTop = 0;
        document.body.classList.add('cr-open');
    }
    function advHideResult() {
        let el = document.getElementById('advResultView');
        if (el) { el.hidden = true; el.innerHTML = ''; }
        document.body.classList.remove('cr-open');
    }
    function crBack() { advHideResult(); advBackToMenu(); }
    function crRetry() { advHideResult(); advRetry(); }
    function crNext() {
        let d = crData || {};
        advHideResult();
        if (d.nextLv) advNextLevel(); else goToAdventurePage(true);
    }
    function crReviewPick() {
        let el = document.getElementById('crReview');
        if (el) el.innerHTML = `<div class="cr-review__pick"><button type="button" class="cr-btn cr-btn--secondary" data-on-click='[["crReview",["card"]]]'>字卡練習</button><button type="button" class="cr-btn cr-btn--secondary" data-on-click='[["crReview",["listen"]]]'>聽力練習</button></div>`;
    }
    function crReview(kind) { advHideResult(); advWrongPractice(kind); }
    // 首勝 →「繼續」：回地圖播插旗動畫
    function crContinue() {
        let d = crData || {}, lv = d.lv || adv.level;
        advHideResult();
        if (!lv) { goToAdventurePage(); return; }
        adv.pickLevel = lv.id;
        goToAdventurePage(true);
        advFlagAnim(lv.id, d.nextLv || null);
    }

    // ── 首勝插旗動畫（沿用原本的夜市地圖，在地圖上疊動畫）──
    //   時間（毫秒）照設計稿 flag-animation.css：旗子 0.5s → 節點變綠 1.1s → 路線 1.6s → 鎖頭 2.4s → 下一關解鎖 2.9s → 卡片 4.0s
    const FA_T = { flag: 500, node: 1100, path: 1600, lock: 2400, open: 2900, sheet: 4000 };
    var faTimers = [], faState = null;     // var：地圖重畫時可能比這行更早被呼叫
    function advFlagAnim(id, nextLv) {
        faStop();
        let map = document.getElementById('advMap');
        if (!map) return;
        let ch = ADV_CHAPTERS.find(c => c.id === advMapChapter) || ADV_CHAPTERS[0];
        if (id < ch.from || id > ch.to) return;
        let pt = ADV_MAP_PTS[id - ch.from];
        let nextIn = nextLv && nextLv.id <= ch.to ? ADV_MAP_PTS[nextLv.id - ch.from] : null;
        let pct = (p) => ({ x: p[0] / ADV_MAP_W * 100, y: p[1] / ADV_MAP_H * 100 });
        let a = pct(pt), b = nextIn ? pct(nextIn) : null;
        let nodes = map.querySelectorAll('.adv-node');
        let nA = nodes[id - ch.from], nB = nextIn ? nodes[nextLv.id - ch.from] : null;
        // 動畫開始前：剛打贏的關卡還是黃色、下一關還鎖著
        if (nA) { nA.classList.remove('cleared'); nA.classList.add('open', 'fa-hold'); }
        if (nB) { nB.dataset.faLabel = nB.textContent; nB.classList.remove('open', 'cleared'); nB.classList.add('locked', 'fa-hold'); nB.textContent = ''; }
        let fx = document.createElement('div');
        fx.className = 'fa-layer';
        let w = map.offsetWidth, h = map.offsetHeight;
        let line = b ? `<svg class="fa-pathsvg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><line class="fa-path" x1="${(a.x * w / 100).toFixed(1)}" y1="${(a.y * h / 100).toFixed(1)}" x2="${(b.x * w / 100).toFixed(1)}" y2="${(b.y * h / 100).toFixed(1)}" stroke="#ffc83d" stroke-width="8" stroke-linecap="round" style="--fa-len:${Math.hypot((b.x - a.x) * w / 100, (b.y - a.y) * h / 100).toFixed(0)}"/></svg>` : '';
        let burst = [0, 45, 90, 135, 180, 225, 270, 315].map((deg, i) => { let r = 42, x = Math.cos(deg * Math.PI / 180) * r, y = Math.sin(deg * Math.PI / 180) * r; return `<i style="left:calc(50% + ${x.toFixed(0)}px - 5px);top:calc(50% + ${y.toFixed(0)}px - 5px);background:${['#ffd34d', '#fb7185', '#34d399', '#93c5fd'][i % 4]}"></i>`; }).join('');
        // 路線放在節點「下面」（插在第一個節點前），旗子、鎖頭放在上面
        if (line) {
            let pl = document.createElement('div'); pl.className = 'fa-pathlayer'; pl.innerHTML = line;
            map.insertBefore(pl, map.querySelector('.adv-node'));
        }
        fx.innerHTML = `
            <div class="fa-burst" style="left:${a.x}%;top:${a.y}%">${burst}</div>
            <div class="fa-flag" style="left:${a.x}%;top:${a.y}%"><svg width="40" height="56" viewBox="0 0 46 64" aria-hidden="true"><rect x="6" y="2" width="5" height="60" rx="2.5" fill="#fff3d6" stroke="#5b3a00" stroke-width="1.5"/><path d="M11 5h30l-7 10 7 10H11z" fill="#ef4444" stroke="#7f1d1d" stroke-width="2" stroke-linejoin="round"/><path d="M20 10l1.8 3.6 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4-2.9-2.8 4-.6z" fill="#ffd34d"/></svg></div>
            ${b ? `<div class="fa-lock" style="left:${b.x}%;top:${b.y}%"><svg width="26" height="30" viewBox="0 0 24 28" aria-hidden="true"><path d="M7 12V8a5 5 0 0110 0v4" fill="none" stroke="#e7e5f5" stroke-width="3" stroke-linecap="round"/><rect x="3" y="11" width="18" height="14" rx="3.5" fill="#e7e5f5" stroke="#45426b" stroke-width="1.5"/><circle cx="12" cy="18" r="2.2" fill="#45426b"/></svg></div>` : ''}
            <span class="fa-skip">點一下畫面可跳過</span>`;
        map.appendChild(fx);
        faState = { id, nextLv, nA, nB, fx };
        let reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reduce) { faFinish(); return; }
        fx.classList.add('is-run');
        let plr = document.querySelector('.fa-pathlayer'); if (plr) plr.classList.add('is-run');
        faTimers.push(setTimeout(() => { if (nA) { nA.classList.remove('open'); nA.classList.add('cleared', 'fa-pop'); } }, FA_T.node));
        faTimers.push(setTimeout(() => { if (nB) { nB.classList.remove('locked'); nB.classList.add('open', 'fa-pop'); nB.textContent = nB.dataset.faLabel || String(nextLv.id); } }, FA_T.open + 450));
        faTimers.push(setTimeout(faFinish, FA_T.sheet));
        setTimeout(() => document.addEventListener('pointerdown', faSkip, true), 50);
    }
    function faSkip(e) {
        if (!faState) return;
        if (e && e.target && e.target.closest && e.target.closest('.fa-sheet')) return;
        faFinish();
    }
    function faStop() {
        faTimers.forEach(clearTimeout); faTimers = [];
        document.removeEventListener('pointerdown', faSkip, true);
        let old = document.querySelector('.fa-layer'); if (old) old.remove();
        let oldp = document.querySelector('.fa-pathlayer'); if (oldp) oldp.remove();
        let sh = document.getElementById('faSheet'); if (sh) sh.remove();
        faState = null;
    }
    // 跳到結束畫面：節點變好、旗子插好、下一關卡片滑上來
    function faFinish() {
        let f = faState;
        if (!f) return;
        faTimers.forEach(clearTimeout); faTimers = [];
        document.removeEventListener('pointerdown', faSkip, true);
        if (f.nA) { f.nA.classList.remove('open', 'fa-hold'); f.nA.classList.add('cleared'); }
        if (f.nB) { f.nB.classList.remove('locked', 'fa-hold'); f.nB.classList.add('open'); f.nB.textContent = f.nB.dataset.faLabel || String(f.nextLv.id); }
        if (f.fx) { f.fx.classList.remove('is-run'); f.fx.classList.add('is-done'); }
        let pl = document.querySelector('.fa-pathlayer'); if (pl) pl.classList.add('is-done');
        faState = null;
        if (f.nextLv) faShowSheet(f.nextLv);
    }
    function faShowSheet(lv) {
        let old = document.getElementById('faSheet'); if (old) old.remove();
        let r = advRewardItemsOf(lv);
        let el = document.createElement('div');
        el.id = 'faSheet';
        el.className = 'fa-sheet-wrap';
        el.innerHTML = `<div class="fa-sheet-bg" data-on-click='[["faCloseSheet",[]]]'></div><div class="fa-sheet">
            <span class="fa-sheet__handle"></span>
            <div class="fa-sheet__head">
                <div class="fa-sheet__avatar">${advEnemySVG(lv.sprite)}</div>
                <div class="fa-sheet__info">
                    <div class="fa-sheet__meta"><span>第 ${lv.id} 關</span><span class="fa-sheet__new">新關卡</span></div>
                    <strong class="fa-sheet__name">${escapeHTML(lv.name)}</strong>
                    <span class="fa-sheet__desc">${escapeHTML(advHeroSub(lv))}</span>
                </div>
            </div>
            ${r ? `<div class="fa-sheet__reward"><span class="fa-sheet__rlabel">通關獎勵<span class="cr-tag cr-tag--first">首勝</span></span><span class="fa-sheet__items">${r}</span></div>` : ''}
            <button type="button" class="cr-btn cr-btn--primary" data-on-click='[["faGoLevel",[${lv.id}]]]'>開始挑戰</button>
        </div>`;
        document.body.appendChild(el);
    }
    function faCloseSheet() { let el = document.getElementById('faSheet'); if (el) el.remove(); }
    function faGoLevel(id) { faStop(); goToAdvLevel(id); }
    // 首勝獎勵的 icon＋數量（卡片用）
    // 這關打贏「現在」真的拿得到的獎勵（關卡頁、地圖的小視窗共用）
    //   新關卡：經驗值＋首勝獎勵；舊關卡：經驗值 70%＋（今天還有次數才有）代幣、掉落；拿不到的不顯示
    function advRewardList(lv) {
        let out = [], first = !advData.cleared[lv.id];
        let add = (icon, n, label, text) => out.push({ icon, n, label, text: text || '×' + n });
        if (lv.xp) {
            let xd = advData.xpDay !== getLocalDateStr(), x = advWinXp(lv, !first, xd);
            add('<span class="xp-ico">XP</span>', x, `經驗值${first ? '' : '（舊關卡 70%）'}${xd ? '（今日首勝 ×2）' : ''}`, '+' + x);
        }
        let claw = lv.special === 'claw' ? 1 : 0;                  // 娃娃機：多掉 1 個冒險代幣
        if (first) {
            if ((lv.firstShards || 0) + claw) add(advShardIcon(22), (lv.firstShards || 0) + claw, '冒險代幣');
            if (lv.firstPotions) add(advPotionIcon(22), lv.firstPotions, '小型恢復藥水');
            if (lv.firstWipes) add(advWipeIcon(22), lv.firstWipes, '濕紙巾');
            if (lv.firstItem && ADV_ITEMS[lv.firstItem] && !advData.items[lv.firstItem]) add(ADV_ITEMS[lv.firstItem].icon(22), 1, ADV_ITEMS[lv.firstItem].name);
            ADV_MOVES.filter(m => m.buy.kind === 'reward' && m.buy.level === lv.id && !advData.own[m.key] && !advOwns(m.key)).forEach(m => add(m.icon, 1, `學會「${m.name}」`));
        } else if (advReplaysUsed() < advReplayCap()) {
            if ((lv.repeatShards || 0) + claw) add(advShardIcon(22), (lv.repeatShards || 0) + claw, '冒險代幣');
            if (lv.potionChance) add(advPotionIcon(22), 1, `小型恢復藥水（${Math.round(lv.potionChance * 100)}% 機會）`, Math.round(lv.potionChance * 100) + '%');
        }
        return out;
    }
    function advRewardItemsOf(lv) {
        return advRewardList(lv).map(r => `<span class="cr-item" role="img" aria-label="${escapeHTML(r.label)} ${r.text}"><span class="cr-ic">${r.icon}</span><b>${r.text}</b></span>`).join('');
    }
    async function advLose(id, why) {
        const P = document.getElementById('advPlayer'), E = document.getElementById('advEnemy');
        adv.active = false;
        releaseWakeLock();
        advSaveLastWrong(); advSave();
        let tip = '';
        if (!advData.loseTipShown) { advData.loseTipShown = true; advSave(); tip = '<br>🧪 背包裡的小型恢復藥水可以恢復體力喔！'; }   // 第一次失敗才提醒
        if (why === 'shift') {
            advData.hp = adv.player.hp; advSave();      // 店員下班：雞塊的體力保留
            document.getElementById('advPanel').innerHTML = `<div class="adv-log" id="advLog">⏰ 打卡下班！</div>`;
            await advAnimate(E, [{ transform: 'translateX(0)', opacity: 1 }, { transform: 'translateX(60px)', opacity: 0 }], { duration: 700, fill: 'forwards' });
            if (id !== adv.runId) return;
            setTimeout(() => { if (id === adv.runId) advShowResult({ state: 'lose', lv: adv.level, title: '下班了！', notes: ['雞塊的體力保留下來了，下次要在倒數結束前打倒店員！'] }); }, 0);
            document.getElementById('advPanel').innerHTML = `
            <div class="adv-result"><div class="big">🕘 店員下班了，明天請早</div><div class="line">雞塊的體力保留下來了（${adv.player.hp}/${adv.player.max}）。<br>下次要在倒數結束前打倒店員！${tip}</div>${advWrongHTML()}</div>
            <button type="button" class="adv-plain-btn sub" data-on-click='[["advBackToMenu",[]]]'>回關卡</button>`;
            return;
        }
        // 戰敗：拿勝利經驗值的 20%（至少 1）
        let loseXp = Math.max(1, Math.round(advWinXp(adv.level, !!advData.cleared[adv.level.id], false) * ADV_LOSE_XP_RATE));
        let lvB = advLevel();
        advData.xp = (advData.xp || 0) + loseXp;
        if (advLevel() > lvB) advData.lvUpAt = Date.now();
        advSave();
        document.getElementById('advPanel').innerHTML = `<div class="adv-log" id="advLog">雞塊倒下了…</div>`;
        await advAnimate(P, [{ transform: 'rotate(0deg)', opacity: 1 }, { transform: 'rotate(80deg) translateY(10px)', opacity: 0.55 }], { duration: 600, fill: 'forwards' });
        if (id !== adv.runId) return;
        document.getElementById('advPanel').innerHTML = `
            <div class="adv-result"><div class="big">😵 挑戰失敗</div><div class="line">雞塊沒有體力了，明天 00:00 恢復。<br>先去練習單字，或升級後到「能力值」加點吧！${tip}</div>${advWrongHTML()}</div>
            <button type="button" class="adv-plain-btn sub" data-on-click='[["advBackToMenu",[]]]'>回關卡</button>`;
        let loseNotes = [`經驗值 +${loseXp}${advLevel() > lvB ? `，升到 Lv.${advLevel()}！` : ''}`];
        const LOSE_HINT = { 19: '我可能需要一個杯套讓咖啡不這麼燙手', 20: '如何讓店員更忙一點呢..?' };
        if (LOSE_HINT[adv.level.id]) loseNotes.unshift(LOSE_HINT[adv.level.id]);
        if (tip) loseNotes.push('背包裡的小型恢復藥水可以恢復體力喔！');
        advShowResult({ state: 'lose', lv: adv.level, notes: loseNotes });
    }

    // ═════════════════════════════════════════════════════════════
    // 🌱 雞塊農場（測試版）：種字 → 澆水（答題）→ 開花收成
    //   測試版：種下或澆水後「1 分鐘」就能再澆（正式版是隔天）
    //   資料只存在這台裝置（還沒有雲端同步）
    // ═════════════════════════════════════════════════════════════
    const FARM_KEY = 'chicky_farm_v1';
    const FARM_STEP_MS = 60 * 1000;          // 測試版：每一階段等 1 分鐘（正式版改成天數）
    const FARM_PLANT_PER_DAY = 500;          // 測試版：每天最多種 500 顆（正式版 3 顆；後台 farm_act 的 per_day 也要一起改）
    const FARM_FAST_N = 3;                   // 前 3 顆用新手速成（長葉後直接開花）
    const FARM_START_PLOTS = 3, FARM_MAX_PLOTS = 9;   // 固定 3 塊田可以種（取消收成解鎖新田）
    const FARM_STAGE_NAMES = ['種子', '發芽', '長葉', '含苞', '開花'];
    // 農場等級：總經驗 3／15／40／80 升到 LV2～LV5；LV2 起田變 4 格、開放蜜蜂採蜜
    //   經驗：種種子 +1、澆水答對 +1、收成 +1、採蜜成功 +3（後台 supabase_011 也照這個算）
    const FARM_LV_XP = [0, 3, 15, 40, 80];
    const FARM_HONEY_FULL = 5, FARM_HONEY_STEP_MS = 60 * 1000;   // 測試版：每 1 分鐘隨機累積 1～3 份蜂蜜（正式版改成每天）
    function farmLevel(xp) { xp = xp === undefined ? farm.xp : xp; let lv = 1; FARM_LV_XP.forEach((t, i) => { if (xp >= t) lv = i + 1; }); return lv; }
    function farmLvInfo(xp) {
        let lv = farmLevel(xp), cur = FARM_LV_XP[lv - 1], next = FARM_LV_XP[lv];
        return { lv, cur, next, max: next === undefined, pct: next === undefined ? 100 : Math.max(0, Math.min(100, (xp - cur) / (next - cur) * 100)) };
    }
    // 裝飾：一個物件一筆，新增裝飾只要加一筆（slot：house／scarecrow／fence／guard／mailbox）
    const FARM_DECOR = [
        { id: 'house_chicken', slot: 'house', name: '雞頭小屋', price: 0 },
        { id: 'house_stall', slot: 'house', name: '夜市攤位', price: 40 },
        { id: 'house_nugget', slot: 'house', name: '雞塊屋', price: 80 },
        { id: 'scarecrow_nugget', slot: 'scarecrow', name: '雞塊稻草人', price: 0 },
        { id: 'scarecrow_meatball', slot: 'scarecrow', name: '貢丸稻草人', price: 40 },
        { id: 'fence_wood', slot: 'fence', name: '木圍籬', price: 0 },
        { id: 'fence_lantern', slot: 'fence', name: '燈籠圍籬', price: 50 },
        { id: 'guard_none', slot: 'guard', name: '空位', price: 0 },
        { id: 'guard_dog', slot: 'guard', name: '看門狗', price: 0 },        // 2026/11：改成免費
        { id: 'mailbox_nugget', slot: 'mailbox', name: '雞塊信箱', price: 0 },
        { id: 'mailbox_red', slot: 'mailbox', name: '紅色郵筒', price: 40 },
        // 2026/11 新增：夜市 A／夜市 B／粉粉貓／懶懶海豹 四套（價格要和後台 farm_act 的 decor 一致，見 supabase_007_farm_decor.sql）
        { id: 'house_cutlet_cart', slot: 'house', name: '香雞排攤車', price: 60 },
        { id: 'house_balloon_stall', slot: 'house', name: '射氣球攤位', price: 60 },
        { id: 'house_peach_cat', slot: 'house', name: '粉粉貓小屋', price: 80 },
        { id: 'house_seal_dome', slot: 'house', name: '海豹午睡屋', price: 80 },
        { id: 'scarecrow_market_umbrella', slot: 'scarecrow', name: '夜市陽傘', price: 40 },
        { id: 'scarecrow_candied_fruit', slot: 'scarecrow', name: '糖葫蘆串', price: 40 },
        { id: 'scarecrow_peach_cat', slot: 'scarecrow', name: '粉粉貓稻草人', price: 50 },
        { id: 'scarecrow_seal', slot: 'scarecrow', name: '懶懶海豹稻草人', price: 50 },
        { id: 'fence_plastic_stools', slot: 'fence', name: '塑膠椅圍籬', price: 50 },
        { id: 'fence_cones', slot: 'fence', name: '三角錐圍籬', price: 50 },
        { id: 'fence_cat_posts', slot: 'fence', name: '貓頭圍籬', price: 60 },
        { id: 'fence_seal_posts', slot: 'fence', name: '睡覺海豹圍籬', price: 60 },
        { id: 'fence_peach_heart', slot: 'fence', name: '桃桃貓花式圍籬', price: 50 },   // 2026/11 新增（後台價格見 supabase_010）
        { id: 'mailbox_capsule_toy', slot: 'mailbox', name: '扭蛋機信箱', price: 40 },
        { id: 'mailbox_pull_tab', slot: 'mailbox', name: '抽抽樂信箱', price: 40 },
        { id: 'mailbox_peach_cat', slot: 'mailbox', name: '粉粉貓信箱', price: 50 },
        { id: 'mailbox_seal', slot: 'mailbox', name: '海豹抱抱信箱', price: 50 }
    ];
    const FARM_SLOT_NAMES = { house: '小屋', scarecrow: '稻草人', fence: '圍籬', guard: '守衛', mailbox: '信箱' };
    const FARM_DEFAULT_DECOR = { house: 'house_chicken', scarecrow: 'scarecrow_nugget', fence: 'fence_wood', guard: 'guard_none', mailbox: 'mailbox_nugget' };

    let farm = farmLoad();
    // 底部滑出的選單、學字卡片放在最外層（不受畫面縮放影響）
    function farmOverlay(html) {
        let el = document.getElementById('farmOverlay');
        if (!el) { el = document.createElement('div'); el.id = 'farmOverlay'; document.body.appendChild(el); }
        el.innerHTML = html || '';
        farmSheetFit();
    }
    // 電腦版：底部選單（換裝飾、花店）最寬只到農場那張卡片的寬度，左右對齊卡片
    function farmSheetFit() {
        let sh = document.querySelector('#farmOverlay .fm-sheet'), card = document.querySelector('.paper-card-container');
        if (!sh || !card) return;
        if (window.innerWidth < 769) { sh.style.maxWidth = ''; sh.style.left = ''; sh.style.right = ''; return; }
        let r = card.getBoundingClientRect();
        sh.style.maxWidth = Math.round(r.width) + 'px';
        sh.style.left = Math.round(r.left) + 'px'; sh.style.right = 'auto'; sh.style.margin = '0';
        sh.style.width = Math.round(r.width) + 'px';
    }
    window.addEventListener('resize', () => { try { farmSheetFit(); } catch (e) {} });
    function farmLoad() {
        let d = {};
        try { d = JSON.parse(localStorage.getItem(FARM_KEY)) || {}; } catch (e) { d = {}; }
        return farmParse(d);
    }
    function farmParse(d) {
        d = d && typeof d === 'object' ? d : {};
        let n0 = v => Math.max(0, parseInt(v) || 0);
        let plots = [];
        for (let i = 0; i < FARM_MAX_PLOTS; i++) {
            let p = Array.isArray(d.plots) ? d.plots[i] : null;
            plots.push(p && typeof p === 'object' && typeof p.word === 'string' && p.word ? {
                word: lowerLeadingI(p.word.slice(0, 80)), cn: String(p.cn || '').slice(0, 80), pos: String(p.pos || '').slice(0, 40), line: String(p.line || '').slice(0, 200),
                lang: p.lang === 'ko' ? 'ko' : 'en', stage: Math.max(0, Math.min(4, parseInt(p.stage) || 0)), readyAt: Number(p.readyAt) || 0,
                wrong: n0(p.wrong), fast: p.fast === true
            } : null);
        }
        let owned = Array.isArray(d.ownedDecor) ? d.ownedDecor.filter(id => FARM_DECOR.some(x => x.id === id)) : [];
        FARM_DECOR.filter(x => x.price === 0).forEach(x => { if (!owned.includes(x.id)) owned.push(x.id); });
        let eq = Object.assign({}, FARM_DEFAULT_DECOR);
        if (d.equippedDecor && typeof d.equippedDecor === 'object') Object.keys(eq).forEach(s => {
            let id = d.equippedDecor[s], it = FARM_DECOR.find(x => x.id === id);
            if (it && it.slot === s && owned.includes(id)) eq[s] = id;
        });
        let pt = d.plantedToday && typeof d.plantedToday === 'object' ? d.plantedToday : {};
        return {
            plots, ownedDecor: owned, equippedDecor: eq,
            plantedToday: { date: typeof pt.date === 'string' ? pt.date : '', count: n0(pt.count) },
            fastTrackUsed: n0(d.fastTrackUsed), harvestTotal: n0(d.harvestTotal), flowers: n0(d.flowers),
            items: { nectar: n0(d.items && d.items.nectar), crown: n0(d.items && d.items.crown) },     // 用花買的戰鬥道具
            loginFlowerDay: typeof d.loginFlowerDay === 'string' ? d.loginFlowerDay : '',              // 每日登入送花：最後領取日
            plantedWords: Array.isArray(d.plantedWords) ? d.plantedWords.filter(x => typeof x === 'string').map(x => x.toLowerCase().slice(0, 80)).slice(-3000) : [],   // 種過的字（不能再種）
            xp: n0(d.xp),                                   // 農場經驗值（等級由這個算）
            honey: Math.min(FARM_HONEY_FULL, n0(d.honey)),  // 蜂蜜（滿 5 可以採）
            honeyAt: Number(d.honeyAt) || 0,               // 上次累積蜂蜜的時間
            beeStep: n0(d.beeStep) % 3                      // 採蜜題型輪流：0 連連看／1 找出不是的意思／2 聽寫
        };
    }
    function farmSave() { try { localStorage.setItem(FARM_KEY, JSON.stringify(farm)); } catch (e) {} }
    // ── 後台（Supabase farm_act）：進度存在雲端、時間和花由後台把關；連不到後台時先存在這台裝置 ──
    let farmSrv = null, farmSrvMsg = '', farmOffset = 0, farmSyncing = null;
    function farmNow() { return Date.now() + farmOffset; }              // 用伺服器時間校正過的「現在」
    function farmToday() { let d = new Date(farmNow()); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
    function farmApply(res) {
        if (!res || !res.state) return;
        farm = farmParse(res.state);
        if (Number.isFinite(Number(res.now))) farmOffset = Number(res.now) - Date.now();
        farmSave();
    }
    function farmSync() {
        if (farmSyncing) return farmSyncing;
        let local = farmParse(JSON.parse(JSON.stringify(farm)));
        farmSyncing = (async () => {
            try {
                let res = await walletRpc('farm_act', { p_action: 'get', p_args: {} });
                let st = res && res.state || {};
                let empty = !(st.harvestTotal > 0) && !(st.fastTrackUsed > 0) && !(Array.isArray(st.plots) && st.plots.some(Boolean));
                if (empty && local.plots.some(Boolean)) res = await walletRpc('farm_act', { p_action: 'import', p_args: { plots: local.plots, fastTrackUsed: local.fastTrackUsed } });   // 第一次：把這台裝置的作物搬上去
                farmApply(res);
                farmSrv = true; farmSrvMsg = '';
            } catch (e) {
                let m = String((e && e.message) || e || '');
                farmSrv = false;
                farmSrvMsg = /farm_act|function|schema/i.test(m) ? '後台還沒更新：請在 Supabase 執行 supabase_006_farm.sql' : '目前連不到雲端，進度先存在這台裝置';
                if (!farmSync._told) { farmSync._told = true; try { if (document.getElementById('farmView').classList.contains('active')) farmToast('☁️ ' + farmSrvMsg); } catch (e2) {} }   // 只提示一次，不佔農場版面
            }
            farmSyncing = null;
            farmRefresh();
        })();
        return farmSyncing;
    }
    // 呼叫後台；成功就用後台的結果（後台說了算），失敗回傳 null
    async function farmCall(action, args) {
        if (farmSrv !== true) return null;
        try { let res = await walletRpc('farm_act', { p_action: action, p_args: args || {} }); farmApply(res); return res; }
        catch (e) {
            let m = String((e && e.message) || '');
            if (m.includes('insufficient')) farmToast('花不夠喔！');
            else if (m.includes('plant_limit')) farmToast('今天種的數量到上限了');
            else if (m.includes('word_used')) farmToast('這個字已經種過了，換一個字吧');
            else if (m.includes('honey_not_full') || m.includes('locked_honey')) farmToast('🐝 蜂蜜還沒滿喔');
            else if (m.includes('invalid_action')) farmToast('後台還沒更新：請在 Supabase 執行 supabase_011');
            else if (!m.includes('not_ripe')) farmToast('雲端沒有存到，重新整理農場…');
            farmSync();
            return null;
        }
    }
    function farmRefresh() {           // 重畫目前看得到的農場畫面（澆水中不打斷）
        try {
            if (document.getElementById('farmView').classList.contains('active') && !farmEditing) farmRender();
            else if (document.getElementById('farmPlantView').classList.contains('active')) farmRenderPlant();
        } catch (e) {}
    }
    function farmUnlocked() { return farmLevel() >= 2 ? 4 : FARM_START_PLOTS; }      // LV1：3 格；LV2 起：4 格
    function farmPlantedToday() { return farm.plantedToday.date === farmToday() ? farm.plantedToday.count : 0; }
    function farmPlantLeft() { return Math.max(0, FARM_PLANT_PER_DAY - farmPlantedToday()); }
    function farmEmptyIndex() { for (let i = 0; i < farmUnlocked(); i++) if (!farm.plots[i]) return i; return -1; }
    function farmIsDue(p) { return !!p && p.stage < 4 && farmNow() >= p.readyAt; }
    function farmDueList() { return farm.plots.map((p, i) => ({ p, i })).filter(x => farmIsDue(x.p)); }
    // 下一個階段：新手速成的作物長葉後直接開花（跳過含苞）
    function farmNextStage(p) { return (p.fast && p.stage === 2) ? 4 : p.stage + 1; }
    function farmPlantedWords() {          // 田裡現在的字＋以前種過的字（種過的字不能再種）
        let out = farm.plots.filter(Boolean).map(p => p.word.toLowerCase());
        (farm.plantedWords || []).forEach(w => { if (!out.includes(w)) out.push(w); });
        return out;
    }

    // ── 圖：全部是簡單的扁平插畫 ──
    function farmNuggetIcon(s) { return `<svg width="${s}" height="${s}" viewBox="0 0 40 40" aria-hidden="true"><ellipse cx="20" cy="20" rx="18" ry="16" fill="#F2A43A"/><ellipse cx="20" cy="20" rx="11" ry="8.5" fill="#F7C46B"/></svg>`; }
    function farmFlowerIcon(s) { return `<svg width="${s}" height="${s}" viewBox="0 0 40 40" aria-hidden="true">${[0, 72, 144, 216, 288].map(r => `<circle cx="20" cy="10.5" r="8" fill="#F28BB2" transform="rotate(${r} 20 20)"/>`).join('')}<circle cx="20" cy="20" r="6.5" fill="#F7D14A"/></svg>`; }
    function farmPencilIcon(s) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="#6355E8" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20 L5 15.5 L15.5 5 L19 8.5 L8.5 19 Z"/><path d="M13.5 7 L17 10.5"/></svg>`; }
    function farmLockIcon(s, c) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c || '#6F6253'}" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11 V8 a4 4 0 0 1 8 0 V11"/></svg>`; }
    function farmDropIcon(s) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 C12 3 5.5 11 5.5 15 a6.5 6.5 0 0 0 13 0 C18.5 11 12 3 12 3 Z" fill="#FFFFFF"/></svg>`; }
    function farmCanSVG(s) {
        return `<svg width="${s}" height="${Math.round(s * 0.75)}" viewBox="0 0 80 60" aria-hidden="true"><path d="M22 18 Q36 6 48 18" stroke="#3B82C4" stroke-width="4" fill="none"/><path d="M14 20 H52 L48 54 H18 Z" fill="#5BA7D9"/><path d="M50 30 L70 16" stroke="#5BA7D9" stroke-width="7" stroke-linecap="round"/><circle cx="74" cy="22" r="2.6" fill="#7CC3EC"/><circle cx="77" cy="30" r="2.2" fill="#7CC3EC"/><circle cx="72" cy="33" r="2" fill="#7CC3EC"/></svg>`;
    }
    function farmSeedIcon(s) { return `<svg width="${s}" height="${s}" viewBox="0 0 40 40" aria-hidden="true"><path d="M21 14 Q22 6 28 4" stroke="#7BC67E" stroke-width="2.6" fill="none" stroke-linecap="round"/><ellipse cx="20" cy="25" rx="10" ry="12" fill="#F7DCA8"/></svg>`; }
    // 作物：0 種子、1 發芽、2 長葉、3 含苞、4 開花
    function farmPlantSVG(stage, s) {
        let g = '';
        let stem = (y) => `<path d="M40 74 V${y}" stroke="#3F9B45" stroke-width="5" stroke-linecap="round"/>`;
        let leaves = (y, k) => `<path d="M40 ${y} Q${40 - 22 * k} ${y - 16 * k} ${40 - 30 * k} ${y - 8 * k} Q${40 - 18 * k} ${y + 6 * k} 40 ${y} Z" fill="#69BE58"/><path d="M40 ${y - 4} Q${40 + 22 * k} ${y - 22 * k} ${40 + 32 * k} ${y - 16 * k} Q${40 + 20 * k} ${y + 2 * k} 40 ${y - 4} Z" fill="#69BE58"/>`;
        if (stage <= 0) g = `<ellipse cx="40" cy="72" rx="20" ry="7" fill="#5E3A20"/><ellipse cx="40" cy="66" rx="7" ry="8.5" fill="#F7DCA8"/><path d="M40 58 Q41 54 44 52" stroke="#7BC67E" stroke-width="2.4" fill="none" stroke-linecap="round"/>`;
        else if (stage === 1) g = `${stem(60)}${leaves(62, 0.55)}`;
        else if (stage === 2) g = `${stem(36)}${leaves(52, 1)}`;
        else if (stage === 3) g = `${stem(30)}${leaves(56, 0.9)}<ellipse cx="40" cy="22" rx="10" ry="14" fill="#F5A9C6"/><path d="M30 28 Q40 38 50 28 Q46 34 40 34 Q34 34 30 28 Z" fill="#69BE58"/>`;
        else g = `${stem(30)}${leaves(58, 0.9)}${[0, 72, 144, 216, 288].map(r => `<circle cx="40" cy="12" r="10" fill="#F28BB2" transform="rotate(${r} 40 26)"/>`).join('')}<circle cx="40" cy="26" r="8" fill="#F7D14A"/>`;
        return `<svg width="${s}" height="${s}" viewBox="0 0 80 80" aria-hidden="true">${g}</svg>`;
    }
    function farmPotSVG(stage, s) {
        return `<svg width="${s}" height="${s}" viewBox="0 0 120 110" aria-hidden="true"><g transform="translate(20 -8) scale(1)">${farmPlantSVG(stage, 80).replace(/^<svg[^>]*>|<\/svg>$/g, '')}</g><rect x="14" y="70" width="92" height="12" rx="5" fill="#9C6438"/><path d="M20 82 H100 L92 108 H28 Z" fill="#BE8556"/></svg>`;
    }
    // 裝飾的圖（每一種寫一個函式；之後新增只要加一筆）
    const FARM_ART = {
        house_chicken: () => `<svg viewBox="0 0 180 210" aria-hidden="true">
            <rect x="34" y="120" width="112" height="90" fill="#F4D9A6"/>
            <path d="M14 124 L90 58 L166 124" fill="#D9573F" stroke="#B9452F" stroke-width="6" stroke-linejoin="round"/>
            <ellipse cx="90" cy="98" rx="16" ry="10" fill="#F2A43A" stroke="#B9452F" stroke-width="2.5"/>
            <rect x="48" y="140" width="24" height="24" rx="3" fill="#FFFFFF" stroke="#9B5A35" stroke-width="4"/><rect x="108" y="140" width="24" height="24" rx="3" fill="#FFFFFF" stroke="#9B5A35" stroke-width="4"/>
            <path d="M76 210 V170 a14 14 0 0 1 28 0 V210 Z" fill="#9B5A35"/>
            <path d="M68 22 q4 -12 10 -4 q4 -10 10 -2 q6 -8 10 4" fill="#E8483B"/>
            <circle cx="84" cy="40" r="22" fill="#FFFFFF" stroke="#E6E6E6" stroke-width="2"/>
            <circle cx="91" cy="36" r="4" fill="#2E2650"/><path d="M104 38 L118 44 L104 48 Z" fill="#F5A623"/><circle cx="76" cy="46" r="4" fill="#F8B4C0"/>
            <path d="M98 54 q6 6 2 12" stroke="#E8483B" stroke-width="5" fill="none" stroke-linecap="round"/></svg>`,
        house_stall: () => `<svg viewBox="0 0 180 210" aria-hidden="true">
            <rect x="30" y="112" width="120" height="98" fill="#F8E7C6"/>
            <path d="M16 112 L40 70 H140 L164 112 Z" fill="#6355E8"/>
            <path d="M16 112 H164 V122 H16 Z" fill="#E8483B"/>
            ${[48, 78, 108, 138].map(x => `<circle cx="${x}" cy="62" r="9" fill="#E8483B"/><rect x="${x - 4}" y="51" width="8" height="4" fill="#B9452F"/>`).join('')}
            <path d="M40 60 Q90 74 140 60" stroke="#2E2650" stroke-width="2" fill="none"/>
            <rect x="74" y="150" width="32" height="60" fill="#9B5A35"/><rect x="40" y="136" width="26" height="20" rx="3" fill="#FFFFFF" stroke="#9B5A35" stroke-width="3"/><rect x="114" y="136" width="26" height="20" rx="3" fill="#FFFFFF" stroke="#9B5A35" stroke-width="3"/></svg>`,
        house_nugget: () => `<svg viewBox="0 0 180 210" aria-hidden="true">
            <path d="M24 150 Q14 92 52 72 Q90 44 132 70 Q170 94 158 152 Q154 208 90 208 Q30 208 24 150 Z" fill="#F2A43A" stroke="#C9782B" stroke-width="5"/>
            <circle cx="56" cy="104" r="5" fill="#C9782B"/><circle cx="128" cy="96" r="4" fill="#C9782B"/><circle cx="140" cy="150" r="5" fill="#C9782B"/><circle cx="40" cy="160" r="4" fill="#C9782B"/>
            <circle cx="72" cy="124" r="7" fill="#2E2650"/><circle cx="108" cy="124" r="7" fill="#2E2650"/><path d="M82 140 Q90 148 98 140" stroke="#2E2650" stroke-width="4" fill="none" stroke-linecap="round"/>
            <path d="M74 208 V178 a16 16 0 0 1 32 0 V208 Z" fill="#9B5A35"/></svg>`,
        scarecrow_nugget: () => `<svg viewBox="0 0 150 210" aria-hidden="true">
            <circle cx="72" cy="58" r="44" fill="#FFF6D6"/>
            <rect x="69" y="110" width="8" height="98" fill="#9B5A35"/>
            <path d="M14 122 L44 118 M106 118 L136 122" stroke="#9B5A35" stroke-width="5" stroke-linecap="round"/>
            <path d="M8 116 l8 6 l-8 6 M142 116 l-8 6 l8 6" stroke="#E7C56A" stroke-width="3" fill="none" stroke-linecap="round"/>
            <path d="M40 80 Q38 140 73 146 Q110 140 106 80 Q100 62 73 62 Q46 62 40 80 Z" fill="#E9A94A" stroke="#C9782B" stroke-width="3"/>
            ${[[52, 92], [96, 88], [58, 130], [94, 126], [76, 140]].map(p => `<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="#C9782B"/>`).join('')}
            <circle cx="62" cy="100" r="5" fill="#2E2650"/><circle cx="86" cy="100" r="5" fill="#2E2650"/><path d="M64 112 Q74 122 84 112" stroke="#2E2650" stroke-width="4" fill="none" stroke-linecap="round"/>
            <ellipse cx="52" cy="110" rx="6" ry="4" fill="#F28BB2" opacity=".55"/><ellipse cx="96" cy="110" rx="6" ry="4" fill="#F28BB2" opacity=".55"/>
            <path d="M50 66 L58 40 H90 L98 66 Z" fill="#E7C56A"/><rect x="34" y="62" width="80" height="10" rx="5" fill="#E7C56A"/><rect x="54" y="52" width="40" height="8" fill="#6355E8"/></svg>`,
        scarecrow_meatball: () => `<svg viewBox="0 0 150 210" aria-hidden="true">
            <circle cx="72" cy="58" r="44" fill="#FFF6D6"/>
            <rect x="69" y="30" width="8" height="178" fill="#C9A06A"/>
            <path d="M14 140 L136 140" stroke="#9B5A35" stroke-width="5" stroke-linecap="round"/>
            <circle cx="73" cy="104" r="36" fill="#D9D2C6" stroke="#8A8378" stroke-width="3"/>
            <circle cx="60" cy="98" r="5" fill="#2E2650"/><circle cx="86" cy="98" r="5" fill="#2E2650"/><path d="M63 112 Q73 120 83 112" stroke="#2E2650" stroke-width="4" fill="none" stroke-linecap="round"/>
            <ellipse cx="52" cy="110" rx="6" ry="4" fill="#F28BB2" opacity=".6"/><ellipse cx="94" cy="110" rx="6" ry="4" fill="#F28BB2" opacity=".6"/>
            <path d="M48 70 L56 46 H90 L98 70 Z" fill="#E7C56A"/><rect x="34" y="66" width="80" height="10" rx="5" fill="#E7C56A"/><rect x="54" y="56" width="40" height="8" fill="#E8483B"/></svg>`,
        guard_none: () => '',
        guard_dog: () => `<svg viewBox="0 0 90 110" aria-hidden="true">
            <ellipse cx="45" cy="104" rx="30" ry="5" fill="rgba(0,0,0,.12)"/>
            <path d="M18 100 Q14 64 45 62 Q76 64 72 100 Z" fill="#E9A94A"/>
            <circle cx="45" cy="44" r="26" fill="#E9A94A"/>
            <path d="M22 30 L18 8 L36 22 Z M68 30 L72 8 L54 22 Z" fill="#C9782B"/>
            <ellipse cx="45" cy="54" rx="15" ry="11" fill="#FFF3DD"/>
            <circle cx="35" cy="40" r="4" fill="#2E2650"/><circle cx="55" cy="40" r="4" fill="#2E2650"/><ellipse cx="45" cy="50" rx="5" ry="3.5" fill="#2E2650"/>
            <path d="M40 58 Q45 62 50 58" stroke="#2E2650" stroke-width="2.4" fill="none" stroke-linecap="round"/>
            <rect x="26" y="66" width="38" height="7" rx="3" fill="#6355E8"/></svg>`,
        mailbox_nugget: () => `<svg viewBox="0 0 90 140" aria-hidden="true">
            <rect x="40" y="60" width="11" height="80" fill="#9B5A35"/>
            <path d="M10 66 V40 a22 22 0 0 1 22 -22 H52 a22 22 0 0 1 22 22 V66 Z" fill="#6355E8"/>
            <rect x="10" y="58" width="64" height="10" fill="#5246CF"/>
            <ellipse cx="42" cy="42" rx="14" ry="10" fill="#F2A43A" stroke="#C9782B" stroke-width="2"/>
            <rect x="72" y="20" width="6" height="34" fill="#9B5A35"/><rect x="72" y="18" width="18" height="12" fill="#E8483B"/></svg>`,
        mailbox_red: () => `<svg viewBox="0 0 90 140" aria-hidden="true">
            <rect x="14" y="30" width="60" height="104" rx="10" fill="#E8483B"/>
            <path d="M14 46 a30 22 0 0 1 60 0" fill="#C93A2E"/><rect x="10" y="26" width="68" height="12" rx="6" fill="#C93A2E"/>
            <rect x="26" y="58" width="36" height="7" rx="3.5" fill="#2E2650"/>
            <rect x="30" y="80" width="28" height="22" rx="3" fill="#FFFFFF"/><path d="M33 84 L44 93 L55 84" stroke="#E8483B" stroke-width="2.4" fill="none"/></svg>`
    };
    // 新的四套裝飾圖（夜市 A／夜市 B／粉粉貓／懶懶海豹）
    Object.assign(FARM_ART, {
        house_cutlet_cart: () => `<svg viewBox="0 0 110 108" preserveAspectRatio="xMidYMax meet" aria-hidden="true"><rect x="12" y="10" width="4" height="30" fill="#8a8f99"/><rect x="94" y="10" width="4" height="30" fill="#8a8f99"/><rect x="6" y="2" width="98" height="22" rx="4" fill="#f7d14a"/><text x="55" y="19" text-anchor="middle" font-family="Noto Sans TC,PingFang TC,Microsoft JhengHei,sans-serif" font-size="14" font-weight="900" fill="#d9301e">香雞排</text><path d="M8 30 Q55 40 102 30" fill="none" stroke="#2e2650" stroke-width="1.2"/><circle cx="14" cy="31" r="5.5" fill="#fff4b8" opacity="0.55"/><circle cx="14" cy="31" r="2.6" fill="#ffe066"/><circle cx="26" cy="35" r="5.5" fill="#fff4b8" opacity="0.55"/><circle cx="26" cy="35" r="2.6" fill="#ffe066"/><circle cx="38" cy="35" r="5.5" fill="#fff4b8" opacity="0.55"/><circle cx="38" cy="35" r="2.6" fill="#ffe066"/><circle cx="50" cy="35" r="5.5" fill="#fff4b8" opacity="0.55"/><circle cx="50" cy="35" r="2.6" fill="#ffe066"/><circle cx="62" cy="35" r="5.5" fill="#fff4b8" opacity="0.55"/><circle cx="62" cy="35" r="2.6" fill="#ffe066"/><circle cx="74" cy="35" r="5.5" fill="#fff4b8" opacity="0.55"/><circle cx="74" cy="35" r="2.6" fill="#ffe066"/><circle cx="86" cy="33" r="5.5" fill="#fff4b8" opacity="0.55"/><circle cx="86" cy="33" r="2.6" fill="#ffe066"/><circle cx="98" cy="31" r="5.5" fill="#fff4b8" opacity="0.55"/><circle cx="98" cy="31" r="2.6" fill="#ffe066"/><rect x="6" y="36" width="14" height="13" fill="#e2463c"/><rect x="20" y="36" width="14" height="13" fill="#ffffff"/><rect x="34" y="36" width="14" height="13" fill="#e2463c"/><rect x="48" y="36" width="14" height="13" fill="#ffffff"/><rect x="62" y="36" width="14" height="13" fill="#e2463c"/><rect x="76" y="36" width="14" height="13" fill="#ffffff"/><rect x="90" y="36" width="14" height="13" fill="#e2463c"/><circle cx="13" cy="49" r="7" fill="#e2463c"/><circle cx="27" cy="49" r="7" fill="#ffffff"/><circle cx="41" cy="49" r="7" fill="#e2463c"/><circle cx="55" cy="49" r="7" fill="#ffffff"/><circle cx="69" cy="49" r="7" fill="#e2463c"/><circle cx="83" cy="49" r="7" fill="#ffffff"/><circle cx="97" cy="49" r="7" fill="#e2463c"/><rect x="12" y="56" width="86" height="16" rx="2" fill="#e8f6ff" stroke="#b9c6d3" stroke-width="2"/><ellipse cx="32" cy="66" rx="10" ry="5" fill="#e9a94a"/><ellipse cx="55" cy="65" rx="10" ry="5" fill="#d9952f"/><ellipse cx="78" cy="66" rx="10" ry="5" fill="#e9a94a"/><rect x="8" y="72" width="94" height="24" rx="4" fill="#c7d0d9"/><rect x="8" y="82" width="94" height="5" fill="#6355e8"/><circle cx="26" cy="99" r="7" fill="#2e2650"/><circle cx="26" cy="99" r="2.5" fill="#c7d0d9"/><circle cx="84" cy="99" r="7" fill="#2e2650"/><circle cx="84" cy="99" r="2.5" fill="#c7d0d9"/></svg>`,
        house_balloon_stall: () => `<svg viewBox="0 0 110 108" preserveAspectRatio="xMidYMax meet" aria-hidden="true"><path d="M2 14 L55 2 L108 14Z" fill="#2f6f9c"/><rect x="4" y="14" width="17" height="14" fill="#3d86b8"/><rect x="21" y="14" width="17" height="14" fill="#ffffff"/><rect x="38" y="14" width="17" height="14" fill="#3d86b8"/><rect x="55" y="14" width="17" height="14" fill="#ffffff"/><rect x="72" y="14" width="17" height="14" fill="#3d86b8"/><rect x="89" y="14" width="17" height="14" fill="#ffffff"/><rect x="8" y="28" width="5" height="62" fill="#8a8f99"/><rect x="97" y="28" width="5" height="62" fill="#8a8f99"/><rect x="15" y="34" width="80" height="44" rx="3" fill="#fbe7c4" stroke="#d9a441" stroke-width="2"/><ellipse cx="24.0" cy="44" rx="5" ry="6" fill="#e2463c"/><circle cx="22.4" cy="42" r="1.3" fill="#ffffff" opacity="0.7"/><ellipse cx="36.5" cy="44" rx="5" ry="6" fill="#f7d14a"/><circle cx="34.9" cy="42" r="1.3" fill="#ffffff" opacity="0.7"/><ellipse cx="49.0" cy="44" rx="5" ry="6" fill="#5aa6d6"/><circle cx="47.4" cy="42" r="1.3" fill="#ffffff" opacity="0.7"/><ellipse cx="61.5" cy="44" rx="5" ry="6" fill="#6cc468"/><circle cx="59.9" cy="42" r="1.3" fill="#ffffff" opacity="0.7"/><ellipse cx="74.0" cy="44" rx="5" ry="6" fill="#f28bb2"/><circle cx="72.4" cy="42" r="1.3" fill="#ffffff" opacity="0.7"/><ellipse cx="86.5" cy="44" rx="5" ry="6" fill="#6355e8"/><circle cx="84.9" cy="42" r="1.3" fill="#ffffff" opacity="0.7"/><ellipse cx="24.0" cy="57" rx="5" ry="6" fill="#e2463c"/><circle cx="22.4" cy="55" r="1.3" fill="#ffffff" opacity="0.7"/><ellipse cx="36.5" cy="57" rx="5" ry="6" fill="#f7d14a"/><circle cx="34.9" cy="55" r="1.3" fill="#ffffff" opacity="0.7"/><ellipse cx="49.0" cy="57" rx="5" ry="6" fill="#5aa6d6"/><circle cx="47.4" cy="55" r="1.3" fill="#ffffff" opacity="0.7"/><ellipse cx="61.5" cy="57" rx="5" ry="6" fill="#6cc468"/><circle cx="59.9" cy="55" r="1.3" fill="#ffffff" opacity="0.7"/><ellipse cx="74.0" cy="57" rx="5" ry="6" fill="#f28bb2"/><circle cx="72.4" cy="55" r="1.3" fill="#ffffff" opacity="0.7"/><ellipse cx="86.5" cy="57" rx="5" ry="6" fill="#6355e8"/><circle cx="84.9" cy="55" r="1.3" fill="#ffffff" opacity="0.7"/><ellipse cx="24.0" cy="70" rx="5" ry="6" fill="#e2463c"/><circle cx="22.4" cy="68" r="1.3" fill="#ffffff" opacity="0.7"/><ellipse cx="36.5" cy="70" rx="5" ry="6" fill="#f7d14a"/><circle cx="34.9" cy="68" r="1.3" fill="#ffffff" opacity="0.7"/><ellipse cx="49.0" cy="70" rx="5" ry="6" fill="#5aa6d6"/><circle cx="47.4" cy="68" r="1.3" fill="#ffffff" opacity="0.7"/><ellipse cx="61.5" cy="70" rx="5" ry="6" fill="#6cc468"/><circle cx="59.9" cy="68" r="1.3" fill="#ffffff" opacity="0.7"/><ellipse cx="74.0" cy="70" rx="5" ry="6" fill="#f28bb2"/><circle cx="72.4" cy="68" r="1.3" fill="#ffffff" opacity="0.7"/><ellipse cx="86.5" cy="70" rx="5" ry="6" fill="#6355e8"/><circle cx="84.9" cy="68" r="1.3" fill="#ffffff" opacity="0.7"/><rect x="4" y="80" width="102" height="22" rx="3" fill="#6355e8"/><rect x="4" y="80" width="102" height="5" fill="#4b3fc9"/><text x="55" y="97" text-anchor="middle" font-family="Noto Sans TC,PingFang TC,Microsoft JhengHei,sans-serif" font-size="11" font-weight="900" fill="#ffffff">射氣球</text><path d="M88 76 l12 -8" stroke="#2e2650" stroke-width="2" stroke-linecap="round"/><path d="M100 68 l-4 0 l2 3z" fill="#e2463c"/></svg>`,
        house_peach_cat: () => `<svg viewBox="0 0 110 108" preserveAspectRatio="xMidYMax meet" aria-hidden="true"><path d="M14 40 L22 8 L40 26 H70 L88 8 L96 40Z" fill="#e2789d"/><path d="M22 16 L27 30 L34 27Z" fill="#fde3ec"/><path d="M88 16 L83 30 L76 27Z" fill="#fde3ec"/><rect x="8" y="38" width="94" height="8" rx="4" fill="#c95580"/><rect x="14" y="44" width="82" height="58" rx="6" fill="#fde3ec"/><circle cx="34" cy="66" r="13" fill="#bfe3f2" stroke="#c95580" stroke-width="3"/><clipPath id="fmCatWin"><circle cx="34" cy="66" r="11.5"/></clipPath><g clip-path="url(#fmCatWin)"><path d="M24.2 69.0 L25.0 58.5 L31.8 63.8Z" fill="#f6a5c0"/><path d="M25.8 66.8 L26.1 61.5 L30.2 64.5Z" fill="#fde3ec"/><path d="M43.8 69.0 L43.0 58.5 L36.2 63.8Z" fill="#f6a5c0"/><path d="M42.2 66.8 L41.9 61.5 L37.8 64.5Z" fill="#fde3ec"/><ellipse cx="34" cy="72" rx="11.2" ry="9.8" fill="#f6a5c0"/><path d="M31.4 62.6 L31.4 66.0" stroke="#e2789d" stroke-width="1.4" stroke-linecap="round"/><path d="M34.0 62.6 L34.0 66.0" stroke="#e2789d" stroke-width="1.4" stroke-linecap="round"/><path d="M36.6 62.6 L36.6 66.0" stroke="#e2789d" stroke-width="1.4" stroke-linecap="round"/><circle cx="30.2" cy="72.0" r="2.2" fill="#2e2650"/><circle cx="31.0" cy="71.2" r="0.8" fill="#fff"/><circle cx="37.8" cy="72.0" r="2.2" fill="#2e2650"/><circle cx="38.5" cy="71.2" r="0.8" fill="#fff"/><path d="M32.8 74.7 L35.2 74.7 L34.0 76.0Z" fill="#e2789d"/><path d="M31.4 76.7 q1.3 1.5 2.5 0 q1.3 1.5 2.5 0" fill="none" stroke="#2e2650" stroke-width="0.9" stroke-linecap="round"/><circle cx="27.2" cy="75.0" r="2.0" fill="#e2789d" opacity="0.45"/><circle cx="40.8" cy="75.0" r="2.0" fill="#e2789d" opacity="0.45"/></g><path d="M62 102 V70 a12 12 0 0 1 24 0 V102Z" fill="#9b5a35"/><circle cx="81" cy="87" r="1.8" fill="#f7d14a"/><path d="M74 60 c-3 -4 -8 0 0 6 c8 -6 3 -10 0 -6z" fill="#6355e8"/></svg>`,
        house_seal_dome: () => `<svg viewBox="0 0 110 108" preserveAspectRatio="xMidYMax meet" aria-hidden="true"><circle cx="86" cy="6" r="4" fill="#ffffff" opacity="0.9"/><circle cx="93" cy="3" r="3" fill="#ffffff" opacity="0.7"/><rect x="14" y="44" width="82" height="58" rx="4" fill="#fbefd9"/><path d="M14 58 H96" stroke="#ead7b4" stroke-width="1.5"/><path d="M14 70 H96" stroke="#ead7b4" stroke-width="1.5"/><path d="M14 82 H96" stroke="#ead7b4" stroke-width="1.5"/><path d="M6 44 L28 14 H82 L104 44Z" fill="#a9c7e6"/><circle cx="14.0" cy="44" r="6" fill="#a9c7e6"/><circle cx="25.5" cy="44" r="6" fill="#a9c7e6"/><circle cx="37.0" cy="44" r="6" fill="#a9c7e6"/><circle cx="48.5" cy="44" r="6" fill="#a9c7e6"/><circle cx="60.0" cy="44" r="6" fill="#a9c7e6"/><circle cx="71.5" cy="44" r="6" fill="#a9c7e6"/><circle cx="83.0" cy="44" r="6" fill="#a9c7e6"/><circle cx="94.5" cy="44" r="6" fill="#a9c7e6"/><path d="M28 14 H82" stroke="#7c9fc4" stroke-width="4" stroke-linecap="round"/><rect x="74" y="6" width="11" height="12" rx="2" fill="#c9b08a"/><rect x="68" y="54" width="20" height="18" rx="3" fill="#2e3b6b"/><circle cx="75" cy="61" r="3.2" fill="#f7d14a"/><circle cx="76.6" cy="60" r="2.6" fill="#2e3b6b"/><circle cx="83" cy="58" r="0.9" fill="#ffffff"/><circle cx="81" cy="66" r="0.8" fill="#ffffff"/><path d="M68 54 h20 v4 q-10 6 -20 0z" fill="#c9b8f5"/><path d="M22 102 V70 a14 14 0 0 1 28 0 V102Z" fill="#9b5a35"/><rect x="16" y="90" width="42" height="12" rx="6" fill="#6355e8"/><rect x="16" y="90" width="42" height="4" rx="2" fill="#7f74ef"/><ellipse cx="36" cy="86" rx="15.2" ry="13.3" fill="#d5dde7"/><ellipse cx="31.2" cy="79.3" rx="4.8" ry="2.4" fill="#eef2f6" opacity="0.8"/><ellipse cx="36" cy="90.8" rx="7.6" ry="5.2" fill="#ffffff"/><path d="M27.5 85.0 q2.8 2.5 5.7 0" fill="none" stroke="#2e2650" stroke-width="1.4" stroke-linecap="round"/><path d="M38.9 85.0 q2.8 2.5 5.7 0" fill="none" stroke="#2e2650" stroke-width="1.4" stroke-linecap="round"/><ellipse cx="36" cy="88.5" rx="2.1" ry="1.4" fill="#2e2650"/><path d="M33.1 91.7 q1.4 1.5 2.8 0 q1.4 1.5 2.8 0" fill="none" stroke="#2e2650" stroke-width="0.9" stroke-linecap="round"/><circle cx="32.2" cy="90.8" r="0.7" fill="#b8c4d3"/><circle cx="30.8" cy="92.7" r="0.7" fill="#b8c4d3"/><circle cx="39.8" cy="90.8" r="0.7" fill="#b8c4d3"/><circle cx="41.2" cy="92.7" r="0.7" fill="#b8c4d3"/><ellipse cx="25.6" cy="89.8" rx="2.7" ry="1.7" fill="#f4a6b8" opacity="0.7"/><ellipse cx="46.5" cy="89.8" rx="2.7" ry="1.7" fill="#f4a6b8" opacity="0.7"/><ellipse cx="23" cy="95" rx="4.5" ry="2.6" fill="#d5dde7"/><ellipse cx="49" cy="95" rx="4.5" ry="2.6" fill="#d5dde7"/><text x="52" y="76" font-family="Baloo 2,Arial Rounded MT Bold,sans-serif" font-weight="800" font-size="9" fill="#6355e8">z</text><text x="58" y="70" font-family="Baloo 2,Arial Rounded MT Bold,sans-serif" font-weight="800" font-size="7" fill="#6355e8" opacity="0.7">z</text><rect x="4" y="100" width="102" height="7" rx="3.5" fill="#e8d3ad"/></svg>`,
        scarecrow_market_umbrella: () => `<svg viewBox="0 0 70 92" preserveAspectRatio="xMidYMax meet" aria-hidden="true"><rect x="33" y="10" width="4" height="70" fill="#8a8f99"/><path d="M35 34 L2.0 34.0 L4.5 26.3Z" fill="#e2463c"/><path d="M35 34 L4.5 26.3 L11.7 19.9Z" fill="#ffffff"/><path d="M35 34 L11.7 19.9 L22.4 15.5Z" fill="#e2463c"/><path d="M35 34 L22.4 15.5 L35.0 14.0Z" fill="#ffffff"/><path d="M35 34 L35.0 14.0 L47.6 15.5Z" fill="#e2463c"/><path d="M35 34 L47.6 15.5 L58.3 19.9Z" fill="#ffffff"/><path d="M35 34 L58.3 19.9 L65.5 26.3Z" fill="#e2463c"/><path d="M35 34 L65.5 26.3 L68.0 34.0Z" fill="#ffffff"/><path d="M2 34 Q35 30 68 34" fill="none" stroke="#c23a30" stroke-width="2"/><circle cx="35" cy="12" r="3" fill="#c23a30"/><path d="M22 92 L26 76 H44 L48 92Z" fill="#3d86b8"/><rect x="24" y="74" width="22" height="4" rx="2" fill="#2f6f9c"/></svg>`,
        scarecrow_candied_fruit: () => `<svg viewBox="0 0 70 92" preserveAspectRatio="xMidYMax meet" aria-hidden="true"><path d="M30 12 L8 6" stroke="#d9b77a" stroke-width="1.6" stroke-linecap="round"/><circle cx="20.8" cy="9.5" r="3.3" fill="#d9301e"/><circle cx="19.8" cy="8.4" r="0.9" fill="#ffffff" opacity="0.85"/><circle cx="15.0" cy="7.9" r="3.3" fill="#d9301e"/><circle cx="14.0" cy="6.8" r="0.9" fill="#ffffff" opacity="0.85"/><circle cx="9.3" cy="6.4" r="3.3" fill="#d9301e"/><circle cx="8.3" cy="5.3" r="0.9" fill="#ffffff" opacity="0.85"/><path d="M40 22 L62 16" stroke="#d9b77a" stroke-width="1.6" stroke-linecap="round"/><circle cx="49.2" cy="19.5" r="3.3" fill="#d9301e"/><circle cx="48.2" cy="18.4" r="0.9" fill="#ffffff" opacity="0.85"/><circle cx="55.0" cy="17.9" r="3.3" fill="#d9301e"/><circle cx="54.0" cy="16.8" r="0.9" fill="#ffffff" opacity="0.85"/><circle cx="60.7" cy="16.4" r="3.3" fill="#d9301e"/><circle cx="59.7" cy="15.3" r="0.9" fill="#ffffff" opacity="0.85"/><path d="M30 32 L8 26" stroke="#d9b77a" stroke-width="1.6" stroke-linecap="round"/><circle cx="20.8" cy="29.5" r="3.3" fill="#d9301e"/><circle cx="19.8" cy="28.4" r="0.9" fill="#ffffff" opacity="0.85"/><circle cx="15.0" cy="27.9" r="3.3" fill="#d9301e"/><circle cx="14.0" cy="26.8" r="0.9" fill="#ffffff" opacity="0.85"/><circle cx="9.3" cy="26.4" r="3.3" fill="#d9301e"/><circle cx="8.3" cy="25.3" r="0.9" fill="#ffffff" opacity="0.85"/><path d="M40 42 L62 36" stroke="#d9b77a" stroke-width="1.6" stroke-linecap="round"/><circle cx="49.2" cy="39.5" r="3.3" fill="#d9301e"/><circle cx="48.2" cy="38.4" r="0.9" fill="#ffffff" opacity="0.85"/><circle cx="55.0" cy="37.9" r="3.3" fill="#d9301e"/><circle cx="54.0" cy="36.8" r="0.9" fill="#ffffff" opacity="0.85"/><circle cx="60.7" cy="36.4" r="3.3" fill="#d9301e"/><circle cx="59.7" cy="35.3" r="0.9" fill="#ffffff" opacity="0.85"/><path d="M40 17 L62 11" stroke="#d9b77a" stroke-width="1.6" stroke-linecap="round"/><circle cx="49.2" cy="14.5" r="3.3" fill="#d9301e"/><circle cx="48.2" cy="13.4" r="0.9" fill="#ffffff" opacity="0.85"/><circle cx="55.0" cy="12.9" r="3.3" fill="#d9301e"/><circle cx="54.0" cy="11.8" r="0.9" fill="#ffffff" opacity="0.85"/><circle cx="60.7" cy="11.4" r="3.3" fill="#d9301e"/><circle cx="59.7" cy="10.3" r="0.9" fill="#ffffff" opacity="0.85"/><path d="M30 27 L8 21" stroke="#d9b77a" stroke-width="1.6" stroke-linecap="round"/><circle cx="20.8" cy="24.5" r="3.3" fill="#d9301e"/><circle cx="19.8" cy="23.4" r="0.9" fill="#ffffff" opacity="0.85"/><circle cx="15.0" cy="22.9" r="3.3" fill="#d9301e"/><circle cx="14.0" cy="21.8" r="0.9" fill="#ffffff" opacity="0.85"/><circle cx="9.3" cy="21.4" r="3.3" fill="#d9301e"/><circle cx="8.3" cy="20.3" r="0.9" fill="#ffffff" opacity="0.85"/><path d="M40 37 L62 31" stroke="#d9b77a" stroke-width="1.6" stroke-linecap="round"/><circle cx="49.2" cy="34.5" r="3.3" fill="#d9301e"/><circle cx="48.2" cy="33.4" r="0.9" fill="#ffffff" opacity="0.85"/><circle cx="55.0" cy="32.9" r="3.3" fill="#d9301e"/><circle cx="54.0" cy="31.8" r="0.9" fill="#ffffff" opacity="0.85"/><circle cx="60.7" cy="31.4" r="3.3" fill="#d9301e"/><circle cx="59.7" cy="30.3" r="0.9" fill="#ffffff" opacity="0.85"/><path d="M30 47 L8 41" stroke="#d9b77a" stroke-width="1.6" stroke-linecap="round"/><circle cx="20.8" cy="44.5" r="3.3" fill="#d9301e"/><circle cx="19.8" cy="43.4" r="0.9" fill="#ffffff" opacity="0.85"/><circle cx="15.0" cy="42.9" r="3.3" fill="#d9301e"/><circle cx="14.0" cy="41.8" r="0.9" fill="#ffffff" opacity="0.85"/><circle cx="9.3" cy="41.4" r="3.3" fill="#d9301e"/><circle cx="8.3" cy="40.3" r="0.9" fill="#ffffff" opacity="0.85"/><rect x="30" y="6" width="10" height="58" rx="5" fill="#f4e3c1" stroke="#d9b77a" stroke-width="1.5"/><rect x="33" y="62" width="4" height="20" fill="#9b5a35"/><path d="M20 92 L26 80 H44 L50 92Z" fill="#9b5a35"/><rect x="18" y="66" width="34" height="11" rx="3" fill="#f7d14a"/><text x="35" y="75" text-anchor="middle" font-family="Noto Sans TC,PingFang TC,Microsoft JhengHei,sans-serif" font-size="8" font-weight="900" fill="#d9301e">糖葫蘆</text></svg>`,
        scarecrow_peach_cat: () => `<svg viewBox="0 0 70 92" preserveAspectRatio="xMidYMax meet" aria-hidden="true"><rect x="32" y="52" width="6" height="40" rx="2" fill="#9b5a35"/><path d="M10.3 32.4 L12.2 5.8 L29.3 19.1Z" fill="#f6a5c0"/><path d="M14.1 26.7 L15.1 13.4 L25.5 21.0Z" fill="#fde3ec"/><path d="M59.7 32.4 L57.8 5.8 L40.7 19.1Z" fill="#f6a5c0"/><path d="M55.9 26.7 L55.0 13.4 L44.5 21.0Z" fill="#fde3ec"/><ellipse cx="35" cy="40" rx="28.5" ry="24.7" fill="#f6a5c0"/><path d="M28.4 16.2 L28.4 24.8" stroke="#e2789d" stroke-width="3.4" stroke-linecap="round"/><path d="M35.0 16.2 L35.0 24.8" stroke="#e2789d" stroke-width="3.4" stroke-linecap="round"/><path d="M41.6 16.2 L41.6 24.8" stroke="#e2789d" stroke-width="3.4" stroke-linecap="round"/><circle cx="25.5" cy="40.0" r="5.7" fill="#2e2650"/><circle cx="27.4" cy="37.9" r="1.9" fill="#fff"/><circle cx="44.5" cy="40.0" r="5.7" fill="#2e2650"/><circle cx="46.4" cy="37.9" r="1.9" fill="#fff"/><path d="M32.0 46.8 L38.0 46.8 L35.0 50.3Z" fill="#e2789d"/><path d="M28.5 51.8 q3.2 3.8 6.5 0 q3.2 3.8 6.5 0" fill="none" stroke="#2e2650" stroke-width="2.3" stroke-linecap="round"/><circle cx="17.9" cy="47.6" r="4.9" fill="#e2789d" opacity="0.45"/><circle cx="52.1" cy="47.6" r="4.9" fill="#e2789d" opacity="0.45"/></svg>`,
        scarecrow_seal: () => `<svg viewBox="0 0 70 92" preserveAspectRatio="xMidYMax meet" aria-hidden="true"><rect x="32" y="52" width="6" height="40" rx="2" fill="#9b5a35"/><ellipse cx="35" cy="38" rx="30.4" ry="26.6" fill="#d5dde7"/><ellipse cx="25.5" cy="24.7" rx="9.5" ry="4.8" fill="#eef2f6" opacity="0.8"/><ellipse cx="35" cy="47.5" rx="15.2" ry="10.4" fill="#ffffff"/><path d="M17.9 36.1 q5.7 4.9 11.4 0" fill="none" stroke="#2e2650" stroke-width="2.8" stroke-linecap="round"/><path d="M40.7 36.1 q5.7 4.9 11.4 0" fill="none" stroke="#2e2650" stroke-width="2.8" stroke-linecap="round"/><ellipse cx="35" cy="42.9" rx="4.2" ry="2.8" fill="#2e2650"/><path d="M29.3 49.4 q2.8 3.0 5.7 0 q2.8 3.0 5.7 0" fill="none" stroke="#2e2650" stroke-width="1.9" stroke-linecap="round"/><circle cx="27.4" cy="47.5" r="1.3" fill="#b8c4d3"/><circle cx="24.6" cy="51.3" r="1.3" fill="#b8c4d3"/><circle cx="42.6" cy="47.5" r="1.3" fill="#b8c4d3"/><circle cx="45.5" cy="51.3" r="1.3" fill="#b8c4d3"/><ellipse cx="14.1" cy="45.6" rx="5.3" ry="3.4" fill="#f4a6b8" opacity="0.7"/><ellipse cx="55.9" cy="45.6" rx="5.3" ry="3.4" fill="#f4a6b8" opacity="0.7"/><text x="54" y="16" font-family="Baloo 2,Arial Rounded MT Bold,sans-serif" font-weight="800" font-size="9.9" fill="#6355e8">z</text><text x="60.6" y="9.399999999999999" font-family="Baloo 2,Arial Rounded MT Bold,sans-serif" font-weight="800" font-size="7.700000000000001" fill="#6355e8" opacity="0.7">z</text></svg>`,
        mailbox_capsule_toy: () => `<svg viewBox="0 0 48 66" preserveAspectRatio="xMidYMax meet" aria-hidden="true"><circle cx="24" cy="20" r="17" fill="#e8f6ff" stroke="#b9c6d3" stroke-width="2"/><circle cx="14" cy="16" r="4.2" fill="#e2463c"/><circle cx="12.8" cy="14.8" r="1.2" fill="#ffffff" opacity="0.7"/><circle cx="23" cy="12" r="4.2" fill="#f7d14a"/><circle cx="21.8" cy="10.8" r="1.2" fill="#ffffff" opacity="0.7"/><circle cx="31" cy="17" r="4.2" fill="#5aa6d6"/><circle cx="29.8" cy="15.8" r="1.2" fill="#ffffff" opacity="0.7"/><circle cx="19" cy="24" r="4.2" fill="#6cc468"/><circle cx="17.8" cy="22.8" r="1.2" fill="#ffffff" opacity="0.7"/><circle cx="28" cy="25" r="4.2" fill="#f28bb2"/><circle cx="26.8" cy="23.8" r="1.2" fill="#ffffff" opacity="0.7"/><circle cx="36" cy="22" r="4.2" fill="#f7d14a"/><circle cx="34.8" cy="20.8" r="1.2" fill="#ffffff" opacity="0.7"/><circle cx="11" cy="24" r="4.2" fill="#6355e8"/><circle cx="9.8" cy="22.8" r="1.2" fill="#ffffff" opacity="0.7"/><rect x="10" y="34" width="28" height="24" rx="3" fill="#e2463c"/><circle cx="24" cy="42" r="5" fill="#ffffff"/><rect x="21" y="41" width="6" height="2" rx="1" fill="#c23a30"/><rect x="17" y="50" width="14" height="6" rx="2" fill="#2e2650"/><rect x="8" y="58" width="32" height="8" rx="2" fill="#c23a30"/></svg>`,
        mailbox_pull_tab: () => `<svg viewBox="0 0 48 66" preserveAspectRatio="xMidYMax meet" aria-hidden="true"><rect x="21" y="44" width="6" height="22" fill="#9b5a35"/><rect x="4" y="2" width="40" height="46" rx="4" fill="#6355e8"/><rect x="8" y="4" width="32" height="8" rx="2" fill="#f7d14a"/><text x="24" y="10.5" text-anchor="middle" font-family="Noto Sans TC,PingFang TC,Microsoft JhengHei,sans-serif" font-size="6.5" font-weight="900" fill="#d9301e">抽抽樂</text><rect x="9" y="14" width="5.5" height="5.5" rx="1" fill="#f28bb2"/><rect x="16" y="14" width="5.5" height="5.5" rx="1" fill="#f7d14a"/><rect x="23" y="14" width="5.5" height="5.5" rx="1" fill="#5aa6d6"/><rect x="30" y="14" width="5.5" height="5.5" rx="1" fill="#6cc468"/><rect x="37" y="14" width="5.5" height="5.5" rx="1" fill="#ffffff"/><rect x="9" y="21" width="5.5" height="5.5" rx="1" fill="#f7d14a"/><rect x="16" y="21" width="5.5" height="5.5" rx="1" fill="#5aa6d6"/><rect x="23" y="21" width="5.5" height="5.5" rx="1" fill="#6cc468"/><rect x="30" y="21" width="5.5" height="5.5" rx="1" fill="#ffffff"/><rect x="37" y="21" width="5.5" height="5.5" rx="1" fill="#f28bb2"/><rect x="9" y="28" width="5.5" height="5.5" rx="1" fill="#5aa6d6"/><rect x="16" y="28" width="5.5" height="5.5" rx="1" fill="#6cc468"/><rect x="23" y="28" width="5.5" height="5.5" rx="1" fill="#ffffff"/><rect x="30" y="28" width="5.5" height="5.5" rx="1" fill="#f28bb2"/><rect x="37" y="28" width="5.5" height="5.5" rx="1" fill="#f7d14a"/><rect x="9" y="35" width="5.5" height="5.5" rx="1" fill="#6cc468"/><rect x="16" y="35" width="5.5" height="5.5" rx="1" fill="#ffffff"/><rect x="23" y="35" width="5.5" height="5.5" rx="1" fill="#f28bb2"/><rect x="30" y="35" width="5.5" height="5.5" rx="1" fill="#f7d14a"/><rect x="37" y="35" width="5.5" height="5.5" rx="1" fill="#5aa6d6"/><rect x="10" y="44" width="28" height="3" rx="1.5" fill="#4b3fc9"/></svg>`,
        mailbox_peach_cat: () => `<svg viewBox="0 0 48 66" preserveAspectRatio="xMidYMax meet" aria-hidden="true"><rect x="21" y="42" width="6" height="24" fill="#9b5a35"/><path d="M38 30 q10 -2 6 -14" fill="none" stroke="#e2789d" stroke-width="3.5" stroke-linecap="round"/><rect x="8" y="22" width="32" height="24" rx="5" fill="#f6a5c0"/><rect x="15" y="34" width="18" height="4" rx="2" fill="#c95580"/><path d="M18 44 h12 v-3 h-12z" fill="#6355e8"/><path d="M11.0 12.0 L12.0 -2.0 L21.0 5.0Z" fill="#f6a5c0"/><path d="M13.0 9.0 L13.5 2.0 L19.0 6.0Z" fill="#fde3ec"/><path d="M37.0 12.0 L36.0 -2.0 L27.0 5.0Z" fill="#f6a5c0"/><path d="M35.0 9.0 L34.5 2.0 L29.0 6.0Z" fill="#fde3ec"/><ellipse cx="24" cy="16" rx="15.0" ry="13.0" fill="#f6a5c0"/><path d="M20.5 3.5 L20.5 8.0" stroke="#e2789d" stroke-width="1.8" stroke-linecap="round"/><path d="M24.0 3.5 L24.0 8.0" stroke="#e2789d" stroke-width="1.8" stroke-linecap="round"/><path d="M27.5 3.5 L27.5 8.0" stroke="#e2789d" stroke-width="1.8" stroke-linecap="round"/><path d="M16.0 16.0 q3.0 -3.0 6.0 0" fill="none" stroke="#2e2650" stroke-width="1.6" stroke-linecap="round"/><path d="M26.0 16.0 q3.0 -3.0 6.0 0" fill="none" stroke="#2e2650" stroke-width="1.6" stroke-linecap="round"/><path d="M22.4 19.6 L25.6 19.6 L24.0 21.4Z" fill="#e2789d"/><path d="M20.6 22.2 q1.7 2.0 3.4 0 q1.7 2.0 3.4 0" fill="none" stroke="#2e2650" stroke-width="1.2" stroke-linecap="round"/><circle cx="15.0" cy="20.0" r="2.6" fill="#e2789d" opacity="0.45"/><circle cx="33.0" cy="20.0" r="2.6" fill="#e2789d" opacity="0.45"/></svg>`,
        mailbox_seal: () => `<svg viewBox="0 0 48 66" preserveAspectRatio="xMidYMax meet" aria-hidden="true"><rect x="21" y="44" width="6" height="22" fill="#9b5a35"/><rect x="6" y="24" width="36" height="22" rx="5" fill="#a9c7e6"/><rect x="15" y="34" width="18" height="4" rx="2" fill="#7c9fc4"/><ellipse cx="24" cy="22" rx="20" ry="9" fill="#d5dde7"/><path d="M42 20 q5 -2 4 -7 q-4 1 -5 4" fill="#d5dde7"/><ellipse cx="16" cy="14" rx="15.2" ry="13.3" fill="#d5dde7"/><ellipse cx="11.2" cy="7.4" rx="4.8" ry="2.4" fill="#eef2f6" opacity="0.8"/><ellipse cx="16" cy="18.8" rx="7.6" ry="5.2" fill="#ffffff"/><path d="M7.5 13.1 q2.8 2.5 5.7 0" fill="none" stroke="#2e2650" stroke-width="1.4" stroke-linecap="round"/><path d="M18.9 13.1 q2.8 2.5 5.7 0" fill="none" stroke="#2e2650" stroke-width="1.4" stroke-linecap="round"/><ellipse cx="16" cy="16.5" rx="2.1" ry="1.4" fill="#2e2650"/><path d="M13.2 19.7 q1.4 1.5 2.8 0 q1.4 1.5 2.8 0" fill="none" stroke="#2e2650" stroke-width="0.9" stroke-linecap="round"/><circle cx="12.2" cy="18.8" r="0.7" fill="#b8c4d3"/><circle cx="10.8" cy="20.6" r="0.7" fill="#b8c4d3"/><circle cx="19.8" cy="18.8" r="0.7" fill="#b8c4d3"/><circle cx="21.2" cy="20.6" r="0.7" fill="#b8c4d3"/><ellipse cx="5.6" cy="17.8" rx="2.7" ry="1.7" fill="#f4a6b8" opacity="0.7"/><ellipse cx="26.4" cy="17.8" rx="2.7" ry="1.7" fill="#f4a6b8" opacity="0.7"/><ellipse cx="9" cy="27" rx="5" ry="2.6" fill="#d5dde7"/><text x="30" y="8" font-family="Baloo 2,Arial Rounded MT Bold,sans-serif" font-weight="800" font-size="7.2" fill="#6355e8">z</text><text x="34.8" y="3.1999999999999993" font-family="Baloo 2,Arial Rounded MT Bold,sans-serif" font-weight="800" font-size="5.6000000000000005" fill="#6355e8" opacity="0.7">z</text></svg>`
    });
    // 新圍籬：一段 150×40 的圖，左右各放一段（中間留給守衛）
    const FARM_FENCE_ART = {
        fence_plastic_stools: `<rect x="0" y="22" width="150" height="4" fill="#e6cf9f"/><g transform="translate(4 6)"><rect x="2" y="0" width="30" height="7" rx="3.5" fill="#f2665c"/><path d="M5 7 L2 32 H8 L11 12 H23 L26 32 H32 L29 7Z" fill="#e2463c"/><rect x="9" y="18" width="16" height="3" rx="1.5" fill="#c23a30"/></g><g transform="translate(58 6)"><rect x="2" y="0" width="30" height="7" rx="3.5" fill="#f2665c"/><path d="M5 7 L2 32 H8 L11 12 H23 L26 32 H32 L29 7Z" fill="#e2463c"/><rect x="9" y="18" width="16" height="3" rx="1.5" fill="#c23a30"/></g><g transform="translate(112 6)"><rect x="2" y="0" width="30" height="7" rx="3.5" fill="#f2665c"/><path d="M5 7 L2 32 H8 L11 12 H23 L26 32 H32 L29 7Z" fill="#e2463c"/><rect x="9" y="18" width="16" height="3" rx="1.5" fill="#c23a30"/></g>`,
        fence_cones: `<rect x="16" y="14" width="54" height="7" rx="2" fill="#f7d14a"/><path d="M20 14 h5 l-4 7 h-5z" fill="#2e2650"/><path d="M30 14 h5 l-4 7 h-5z" fill="#2e2650"/><path d="M40 14 h5 l-4 7 h-5z" fill="#2e2650"/><path d="M50 14 h5 l-4 7 h-5z" fill="#2e2650"/><path d="M60 14 h5 l-4 7 h-5z" fill="#2e2650"/><rect x="80" y="14" width="54" height="7" rx="2" fill="#f7d14a"/><path d="M84 14 h5 l-4 7 h-5z" fill="#2e2650"/><path d="M94 14 h5 l-4 7 h-5z" fill="#2e2650"/><path d="M104 14 h5 l-4 7 h-5z" fill="#2e2650"/><path d="M114 14 h5 l-4 7 h-5z" fill="#2e2650"/><path d="M124 14 h5 l-4 7 h-5z" fill="#2e2650"/><g transform="translate(0 0)"><path d="M10 4 L18 34 H2Z" fill="#f28a2e"/><rect x="5" y="14" width="10" height="4" fill="#ffffff"/><rect x="3.5" y="24" width="13" height="4" fill="#ffffff"/><rect x="0" y="34" width="20" height="4" rx="1" fill="#c96a1e"/></g><g transform="translate(65 0)"><path d="M10 4 L18 34 H2Z" fill="#f28a2e"/><rect x="5" y="14" width="10" height="4" fill="#ffffff"/><rect x="3.5" y="24" width="13" height="4" fill="#ffffff"/><rect x="0" y="34" width="20" height="4" rx="1" fill="#c96a1e"/></g><g transform="translate(130 0)"><path d="M10 4 L18 34 H2Z" fill="#f28a2e"/><rect x="5" y="14" width="10" height="4" fill="#ffffff"/><rect x="3.5" y="24" width="13" height="4" fill="#ffffff"/><rect x="0" y="34" width="20" height="4" rx="1" fill="#c96a1e"/></g>`,
        fence_peach_heart: `<path d="M13.2 33 L16.8 33 L15.5 39.6 L14.5 39.6Z" fill="#fffaf7" stroke="#e58aab" stroke-width=".8" stroke-linejoin="round"/>
<path d="M133.2 33 L136.8 33 L135.5 39.6 L134.5 39.6Z" fill="#fffaf7" stroke="#e58aab" stroke-width=".8" stroke-linejoin="round"/>
<rect x="1.5" y="10.6" width="147" height="3" rx="1.5" fill="#fffaf7" stroke="#e58aab" stroke-width="0.9"/>
<rect x="1.5" y="30.4" width="147" height="3" rx="1.5" fill="#fffaf7" stroke="#e58aab" stroke-width="0.9"/>
<path d="M15 12 V31" fill="none" stroke="#e58aab" stroke-width="2.9" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M15 12 V31" fill="none" stroke="#fffaf7" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M15 15.6 C13 12.6 5.5 13.4 5.5 19.2 C5.5 23.6 11.6 25.8 15 29.2" fill="none" stroke="#e58aab" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M15 15.6 C13 12.6 5.5 13.4 5.5 19.2 C5.5 23.6 11.6 25.8 15 29.2" fill="none" stroke="#fffaf7" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M14.4 17.6 C12 15.6 9 16.8 9.8 19 C10.4 20.4 12 20 11.8 18.9" fill="none" stroke="#e58aab" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M14.4 17.6 C12 15.6 9 16.8 9.8 19 C10.4 20.4 12 20 11.8 18.9" fill="none" stroke="#fffaf7" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M14.4 30.6 C11.6 30.6 8.8 29.6 8.8 27.8 C8.8 26.6 10.4 26.6 10.4 27.6" fill="none" stroke="#e58aab" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M14.4 30.6 C11.6 30.6 8.8 29.6 8.8 27.8 C8.8 26.6 10.4 26.6 10.4 27.6" fill="none" stroke="#fffaf7" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M15 15.6 C17 12.6 24.5 13.4 24.5 19.2 C24.5 23.6 18.4 25.8 15 29.2" fill="none" stroke="#e58aab" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M15 15.6 C17 12.6 24.5 13.4 24.5 19.2 C24.5 23.6 18.4 25.8 15 29.2" fill="none" stroke="#fffaf7" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M15.6 17.6 C18 15.6 21 16.8 20.2 19 C19.6 20.4 18 20 18.2 18.9" fill="none" stroke="#e58aab" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M15.6 17.6 C18 15.6 21 16.8 20.2 19 C19.6 20.4 18 20 18.2 18.9" fill="none" stroke="#fffaf7" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M15.6 30.6 C18.4 30.6 21.2 29.6 21.2 27.8 C21.2 26.6 19.6 26.6 19.6 27.6" fill="none" stroke="#e58aab" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M15.6 30.6 C18.4 30.6 21.2 29.6 21.2 27.8 C21.2 26.6 19.6 26.6 19.6 27.6" fill="none" stroke="#fffaf7" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
<rect x="13.1" y="17" width="3.8" height="2" rx=".8" fill="#fffaf7" stroke="#e58aab" stroke-width=".7"/>
<rect x="13.1" y="27.6" width="3.8" height="2" rx=".8" fill="#fffaf7" stroke="#e58aab" stroke-width=".7"/>
<rect x="13.2" y="9.6" width="3.6" height="2.6" rx=".8" fill="#fffaf7" stroke="#e58aab" stroke-width=".7"/>
<path d="M9.80 5.80 L10.20 0.20 L13.80 3.00Z" fill="#f6a5c0"/>
<path d="M10.60 4.60 L10.80 1.80 L13.00 3.40Z" fill="#fde3ec"/>
<path d="M20.20 5.80 L19.80 0.20 L16.20 3.00Z" fill="#f6a5c0"/>
<path d="M19.40 4.60 L19.20 1.80 L17.00 3.40Z" fill="#fde3ec"/>
<ellipse cx="15" cy="7.4" rx="6.00" ry="5.20" fill="#f6a5c0"/>
<circle cx="13.00" cy="7.40" r="1.20" fill="#2e2650"/>
<circle cx="13.40" cy="6.96" r="0.40" fill="#fff"/>
<circle cx="17.00" cy="7.40" r="1.20" fill="#2e2650"/>
<circle cx="17.40" cy="6.96" r="0.40" fill="#fff"/>
<path d="M14.36 8.84 L15.64 8.84 L15.00 9.56Z" fill="#e2789d"/>
<path d="M13.64 9.88 q0.68 0.80 1.36 0 q0.68 0.80 1.36 0" fill="none" stroke="#2e2650" stroke-width="0.48" stroke-linecap="round"/>
<circle cx="11.40" cy="9.00" r="1.04" fill="#e2789d" opacity="0.45"/>
<circle cx="18.60" cy="9.00" r="1.04" fill="#e2789d" opacity="0.45"/>
<path d="M45 12 V31" fill="none" stroke="#e58aab" stroke-width="2.9" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M45 12 V31" fill="none" stroke="#fffaf7" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M45 15.6 C43 12.6 35.5 13.4 35.5 19.2 C35.5 23.6 41.6 25.8 45 29.2" fill="none" stroke="#e58aab" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M45 15.6 C43 12.6 35.5 13.4 35.5 19.2 C35.5 23.6 41.6 25.8 45 29.2" fill="none" stroke="#fffaf7" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M44.4 17.6 C42 15.6 39 16.8 39.8 19 C40.4 20.4 42 20 41.8 18.9" fill="none" stroke="#e58aab" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M44.4 17.6 C42 15.6 39 16.8 39.8 19 C40.4 20.4 42 20 41.8 18.9" fill="none" stroke="#fffaf7" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M44.4 30.6 C41.6 30.6 38.8 29.6 38.8 27.8 C38.8 26.6 40.4 26.6 40.4 27.6" fill="none" stroke="#e58aab" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M44.4 30.6 C41.6 30.6 38.8 29.6 38.8 27.8 C38.8 26.6 40.4 26.6 40.4 27.6" fill="none" stroke="#fffaf7" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M45 15.6 C47 12.6 54.5 13.4 54.5 19.2 C54.5 23.6 48.4 25.8 45 29.2" fill="none" stroke="#e58aab" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M45 15.6 C47 12.6 54.5 13.4 54.5 19.2 C54.5 23.6 48.4 25.8 45 29.2" fill="none" stroke="#fffaf7" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M45.6 17.6 C48 15.6 51 16.8 50.2 19 C49.6 20.4 48 20 48.2 18.9" fill="none" stroke="#e58aab" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M45.6 17.6 C48 15.6 51 16.8 50.2 19 C49.6 20.4 48 20 48.2 18.9" fill="none" stroke="#fffaf7" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M45.6 30.6 C48.4 30.6 51.2 29.6 51.2 27.8 C51.2 26.6 49.6 26.6 49.6 27.6" fill="none" stroke="#e58aab" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M45.6 30.6 C48.4 30.6 51.2 29.6 51.2 27.8 C51.2 26.6 49.6 26.6 49.6 27.6" fill="none" stroke="#fffaf7" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
<rect x="43.1" y="17" width="3.8" height="2" rx=".8" fill="#fffaf7" stroke="#e58aab" stroke-width=".7"/>
<rect x="43.1" y="27.6" width="3.8" height="2" rx=".8" fill="#fffaf7" stroke="#e58aab" stroke-width=".7"/>
<rect x="43.2" y="9.6" width="3.6" height="2.6" rx=".8" fill="#fffaf7" stroke="#e58aab" stroke-width=".7"/>
<path d="M39.80 5.80 L40.20 0.20 L43.80 3.00Z" fill="#f6a5c0"/>
<path d="M40.60 4.60 L40.80 1.80 L43.00 3.40Z" fill="#fde3ec"/>
<path d="M50.20 5.80 L49.80 0.20 L46.20 3.00Z" fill="#f6a5c0"/>
<path d="M49.40 4.60 L49.20 1.80 L47.00 3.40Z" fill="#fde3ec"/>
<ellipse cx="45" cy="7.4" rx="6.00" ry="5.20" fill="#f6a5c0"/>
<circle cx="43.00" cy="7.40" r="1.20" fill="#2e2650"/>
<circle cx="43.40" cy="6.96" r="0.40" fill="#fff"/>
<circle cx="47.00" cy="7.40" r="1.20" fill="#2e2650"/>
<circle cx="47.40" cy="6.96" r="0.40" fill="#fff"/>
<path d="M44.36 8.84 L45.64 8.84 L45.00 9.56Z" fill="#e2789d"/>
<path d="M43.64 9.88 q0.68 0.80 1.36 0 q0.68 0.80 1.36 0" fill="none" stroke="#2e2650" stroke-width="0.48" stroke-linecap="round"/>
<circle cx="41.40" cy="9.00" r="1.04" fill="#e2789d" opacity="0.45"/>
<circle cx="48.60" cy="9.00" r="1.04" fill="#e2789d" opacity="0.45"/>
<path d="M75 12 V31" fill="none" stroke="#e58aab" stroke-width="2.9" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M75 12 V31" fill="none" stroke="#fffaf7" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M75 15.6 C73 12.6 65.5 13.4 65.5 19.2 C65.5 23.6 71.6 25.8 75 29.2" fill="none" stroke="#e58aab" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M75 15.6 C73 12.6 65.5 13.4 65.5 19.2 C65.5 23.6 71.6 25.8 75 29.2" fill="none" stroke="#fffaf7" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M74.4 17.6 C72 15.6 69 16.8 69.8 19 C70.4 20.4 72 20 71.8 18.9" fill="none" stroke="#e58aab" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M74.4 17.6 C72 15.6 69 16.8 69.8 19 C70.4 20.4 72 20 71.8 18.9" fill="none" stroke="#fffaf7" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M74.4 30.6 C71.6 30.6 68.8 29.6 68.8 27.8 C68.8 26.6 70.4 26.6 70.4 27.6" fill="none" stroke="#e58aab" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M74.4 30.6 C71.6 30.6 68.8 29.6 68.8 27.8 C68.8 26.6 70.4 26.6 70.4 27.6" fill="none" stroke="#fffaf7" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M75 15.6 C77 12.6 84.5 13.4 84.5 19.2 C84.5 23.6 78.4 25.8 75 29.2" fill="none" stroke="#e58aab" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M75 15.6 C77 12.6 84.5 13.4 84.5 19.2 C84.5 23.6 78.4 25.8 75 29.2" fill="none" stroke="#fffaf7" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M75.6 17.6 C78 15.6 81 16.8 80.2 19 C79.6 20.4 78 20 78.2 18.9" fill="none" stroke="#e58aab" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M75.6 17.6 C78 15.6 81 16.8 80.2 19 C79.6 20.4 78 20 78.2 18.9" fill="none" stroke="#fffaf7" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M75.6 30.6 C78.4 30.6 81.2 29.6 81.2 27.8 C81.2 26.6 79.6 26.6 79.6 27.6" fill="none" stroke="#e58aab" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M75.6 30.6 C78.4 30.6 81.2 29.6 81.2 27.8 C81.2 26.6 79.6 26.6 79.6 27.6" fill="none" stroke="#fffaf7" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
<rect x="73.1" y="17" width="3.8" height="2" rx=".8" fill="#fffaf7" stroke="#e58aab" stroke-width=".7"/>
<rect x="73.1" y="27.6" width="3.8" height="2" rx=".8" fill="#fffaf7" stroke="#e58aab" stroke-width=".7"/>
<rect x="73.2" y="9.6" width="3.6" height="2.6" rx=".8" fill="#fffaf7" stroke="#e58aab" stroke-width=".7"/>
<path d="M69.80 5.80 L70.20 0.20 L73.80 3.00Z" fill="#f6a5c0"/>
<path d="M70.60 4.60 L70.80 1.80 L73.00 3.40Z" fill="#fde3ec"/>
<path d="M80.20 5.80 L79.80 0.20 L76.20 3.00Z" fill="#f6a5c0"/>
<path d="M79.40 4.60 L79.20 1.80 L77.00 3.40Z" fill="#fde3ec"/>
<ellipse cx="75" cy="7.4" rx="6.00" ry="5.20" fill="#f6a5c0"/>
<circle cx="73.00" cy="7.40" r="1.20" fill="#2e2650"/>
<circle cx="73.40" cy="6.96" r="0.40" fill="#fff"/>
<circle cx="77.00" cy="7.40" r="1.20" fill="#2e2650"/>
<circle cx="77.40" cy="6.96" r="0.40" fill="#fff"/>
<path d="M74.36 8.84 L75.64 8.84 L75.00 9.56Z" fill="#e2789d"/>
<path d="M73.64 9.88 q0.68 0.80 1.36 0 q0.68 0.80 1.36 0" fill="none" stroke="#2e2650" stroke-width="0.48" stroke-linecap="round"/>
<circle cx="71.40" cy="9.00" r="1.04" fill="#e2789d" opacity="0.45"/>
<circle cx="78.60" cy="9.00" r="1.04" fill="#e2789d" opacity="0.45"/>
<path d="M105 12 V31" fill="none" stroke="#e58aab" stroke-width="2.9" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M105 12 V31" fill="none" stroke="#fffaf7" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M105 15.6 C103 12.6 95.5 13.4 95.5 19.2 C95.5 23.6 101.6 25.8 105 29.2" fill="none" stroke="#e58aab" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M105 15.6 C103 12.6 95.5 13.4 95.5 19.2 C95.5 23.6 101.6 25.8 105 29.2" fill="none" stroke="#fffaf7" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M104.4 17.6 C102 15.6 99 16.8 99.8 19 C100.4 20.4 102 20 101.8 18.9" fill="none" stroke="#e58aab" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M104.4 17.6 C102 15.6 99 16.8 99.8 19 C100.4 20.4 102 20 101.8 18.9" fill="none" stroke="#fffaf7" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M104.4 30.6 C101.6 30.6 98.8 29.6 98.8 27.8 C98.8 26.6 100.4 26.6 100.4 27.6" fill="none" stroke="#e58aab" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M104.4 30.6 C101.6 30.6 98.8 29.6 98.8 27.8 C98.8 26.6 100.4 26.6 100.4 27.6" fill="none" stroke="#fffaf7" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M105 15.6 C107 12.6 114.5 13.4 114.5 19.2 C114.5 23.6 108.4 25.8 105 29.2" fill="none" stroke="#e58aab" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M105 15.6 C107 12.6 114.5 13.4 114.5 19.2 C114.5 23.6 108.4 25.8 105 29.2" fill="none" stroke="#fffaf7" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M105.6 17.6 C108 15.6 111 16.8 110.2 19 C109.6 20.4 108 20 108.2 18.9" fill="none" stroke="#e58aab" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M105.6 17.6 C108 15.6 111 16.8 110.2 19 C109.6 20.4 108 20 108.2 18.9" fill="none" stroke="#fffaf7" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M105.6 30.6 C108.4 30.6 111.2 29.6 111.2 27.8 C111.2 26.6 109.6 26.6 109.6 27.6" fill="none" stroke="#e58aab" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M105.6 30.6 C108.4 30.6 111.2 29.6 111.2 27.8 C111.2 26.6 109.6 26.6 109.6 27.6" fill="none" stroke="#fffaf7" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
<rect x="103.1" y="17" width="3.8" height="2" rx=".8" fill="#fffaf7" stroke="#e58aab" stroke-width=".7"/>
<rect x="103.1" y="27.6" width="3.8" height="2" rx=".8" fill="#fffaf7" stroke="#e58aab" stroke-width=".7"/>
<rect x="103.2" y="9.6" width="3.6" height="2.6" rx=".8" fill="#fffaf7" stroke="#e58aab" stroke-width=".7"/>
<path d="M99.80 5.80 L100.20 0.20 L103.80 3.00Z" fill="#f6a5c0"/>
<path d="M100.60 4.60 L100.80 1.80 L103.00 3.40Z" fill="#fde3ec"/>
<path d="M110.20 5.80 L109.80 0.20 L106.20 3.00Z" fill="#f6a5c0"/>
<path d="M109.40 4.60 L109.20 1.80 L107.00 3.40Z" fill="#fde3ec"/>
<ellipse cx="105" cy="7.4" rx="6.00" ry="5.20" fill="#f6a5c0"/>
<circle cx="103.00" cy="7.40" r="1.20" fill="#2e2650"/>
<circle cx="103.40" cy="6.96" r="0.40" fill="#fff"/>
<circle cx="107.00" cy="7.40" r="1.20" fill="#2e2650"/>
<circle cx="107.40" cy="6.96" r="0.40" fill="#fff"/>
<path d="M104.36 8.84 L105.64 8.84 L105.00 9.56Z" fill="#e2789d"/>
<path d="M103.64 9.88 q0.68 0.80 1.36 0 q0.68 0.80 1.36 0" fill="none" stroke="#2e2650" stroke-width="0.48" stroke-linecap="round"/>
<circle cx="101.40" cy="9.00" r="1.04" fill="#e2789d" opacity="0.45"/>
<circle cx="108.60" cy="9.00" r="1.04" fill="#e2789d" opacity="0.45"/>
<path d="M135 12 V31" fill="none" stroke="#e58aab" stroke-width="2.9" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M135 12 V31" fill="none" stroke="#fffaf7" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M135 15.6 C133 12.6 125.5 13.4 125.5 19.2 C125.5 23.6 131.6 25.8 135 29.2" fill="none" stroke="#e58aab" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M135 15.6 C133 12.6 125.5 13.4 125.5 19.2 C125.5 23.6 131.6 25.8 135 29.2" fill="none" stroke="#fffaf7" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M134.4 17.6 C132 15.6 129 16.8 129.8 19 C130.4 20.4 132 20 131.8 18.9" fill="none" stroke="#e58aab" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M134.4 17.6 C132 15.6 129 16.8 129.8 19 C130.4 20.4 132 20 131.8 18.9" fill="none" stroke="#fffaf7" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M134.4 30.6 C131.6 30.6 128.8 29.6 128.8 27.8 C128.8 26.6 130.4 26.6 130.4 27.6" fill="none" stroke="#e58aab" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M134.4 30.6 C131.6 30.6 128.8 29.6 128.8 27.8 C128.8 26.6 130.4 26.6 130.4 27.6" fill="none" stroke="#fffaf7" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M135 15.6 C137 12.6 144.5 13.4 144.5 19.2 C144.5 23.6 138.4 25.8 135 29.2" fill="none" stroke="#e58aab" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M135 15.6 C137 12.6 144.5 13.4 144.5 19.2 C144.5 23.6 138.4 25.8 135 29.2" fill="none" stroke="#fffaf7" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M135.6 17.6 C138 15.6 141 16.8 140.2 19 C139.6 20.4 138 20 138.2 18.9" fill="none" stroke="#e58aab" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M135.6 17.6 C138 15.6 141 16.8 140.2 19 C139.6 20.4 138 20 138.2 18.9" fill="none" stroke="#fffaf7" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M135.6 30.6 C138.4 30.6 141.2 29.6 141.2 27.8 C141.2 26.6 139.6 26.6 139.6 27.6" fill="none" stroke="#e58aab" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M135.6 30.6 C138.4 30.6 141.2 29.6 141.2 27.8 C141.2 26.6 139.6 26.6 139.6 27.6" fill="none" stroke="#fffaf7" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
<rect x="133.1" y="17" width="3.8" height="2" rx=".8" fill="#fffaf7" stroke="#e58aab" stroke-width=".7"/>
<rect x="133.1" y="27.6" width="3.8" height="2" rx=".8" fill="#fffaf7" stroke="#e58aab" stroke-width=".7"/>
<rect x="133.2" y="9.6" width="3.6" height="2.6" rx=".8" fill="#fffaf7" stroke="#e58aab" stroke-width=".7"/>
<path d="M129.80 5.80 L130.20 0.20 L133.80 3.00Z" fill="#f6a5c0"/>
<path d="M130.60 4.60 L130.80 1.80 L133.00 3.40Z" fill="#fde3ec"/>
<path d="M140.20 5.80 L139.80 0.20 L136.20 3.00Z" fill="#f6a5c0"/>
<path d="M139.40 4.60 L139.20 1.80 L137.00 3.40Z" fill="#fde3ec"/>
<ellipse cx="135" cy="7.4" rx="6.00" ry="5.20" fill="#f6a5c0"/>
<circle cx="133.00" cy="7.40" r="1.20" fill="#2e2650"/>
<circle cx="133.40" cy="6.96" r="0.40" fill="#fff"/>
<circle cx="137.00" cy="7.40" r="1.20" fill="#2e2650"/>
<circle cx="137.40" cy="6.96" r="0.40" fill="#fff"/>
<path d="M134.36 8.84 L135.64 8.84 L135.00 9.56Z" fill="#e2789d"/>
<path d="M133.64 9.88 q0.68 0.80 1.36 0 q0.68 0.80 1.36 0" fill="none" stroke="#2e2650" stroke-width="0.48" stroke-linecap="round"/>
<circle cx="131.40" cy="9.00" r="1.04" fill="#e2789d" opacity="0.45"/>
<circle cx="138.60" cy="9.00" r="1.04" fill="#e2789d" opacity="0.45"/>`,
        fence_cat_posts: `<rect x="0" y="24" width="150" height="6" rx="3" fill="#f3c6d6"/><g fill="#e2789d" opacity="0.8"><ellipse cx="37" cy="25" rx="3" ry="2.4"/><circle cx="34" cy="21.4" r="1.2"/><circle cx="37" cy="20.5" r="1.2"/><circle cx="40" cy="21.4" r="1.2"/></g><g fill="#e2789d" opacity="0.8"><ellipse cx="112" cy="25" rx="3" ry="2.4"/><circle cx="109" cy="21.4" r="1.2"/><circle cx="112" cy="20.5" r="1.2"/><circle cx="115" cy="21.4" r="1.2"/></g><g><rect x="6" y="16" width="12" height="24" rx="3" fill="#fde3ec" stroke="#e8b6c8" stroke-width="2"/><path d="M4.8 9.8 L5.4 2.1 L10.3 5.9Z" fill="#f6a5c0"/><path d="M5.9 8.1 L6.2 4.3 L9.2 6.5Z" fill="#fde3ec"/><path d="M19.1 9.8 L18.6 2.1 L13.7 5.9Z" fill="#f6a5c0"/><path d="M18.1 8.1 L17.8 4.3 L14.8 6.5Z" fill="#fde3ec"/><ellipse cx="12" cy="12" rx="8.2" ry="7.2" fill="#f6a5c0"/><path d="M10.1 5.1 L10.1 7.6" stroke="#e2789d" stroke-width="1.0" stroke-linecap="round"/><path d="M12.0 5.1 L12.0 7.6" stroke="#e2789d" stroke-width="1.0" stroke-linecap="round"/><path d="M13.9 5.1 L13.9 7.6" stroke="#e2789d" stroke-width="1.0" stroke-linecap="round"/><circle cx="9.2" cy="12.0" r="1.7" fill="#2e2650"/><circle cx="9.8" cy="11.4" r="0.6" fill="#fff"/><circle cx="14.8" cy="12.0" r="1.7" fill="#2e2650"/><circle cx="15.3" cy="11.4" r="0.6" fill="#fff"/><path d="M11.1 14.0 L12.9 14.0 L12.0 15.0Z" fill="#e2789d"/><path d="M10.1 15.4 q0.9 1.1 1.9 0 q0.9 1.1 1.9 0" fill="none" stroke="#2e2650" stroke-width="0.7" stroke-linecap="round"/><circle cx="7.0" cy="14.2" r="1.4" fill="#e2789d" opacity="0.45"/><circle cx="16.9" cy="14.2" r="1.4" fill="#e2789d" opacity="0.45"/></g><g><rect x="69" y="16" width="12" height="24" rx="3" fill="#fde3ec" stroke="#e8b6c8" stroke-width="2"/><path d="M67.8 9.8 L68.4 2.1 L73.3 5.9Z" fill="#f6a5c0"/><path d="M69.0 8.1 L69.2 4.3 L72.2 6.5Z" fill="#fde3ec"/><path d="M82.2 9.8 L81.6 2.1 L76.7 5.9Z" fill="#f6a5c0"/><path d="M81.0 8.1 L80.8 4.3 L77.8 6.5Z" fill="#fde3ec"/><ellipse cx="75" cy="12" rx="8.2" ry="7.2" fill="#f6a5c0"/><path d="M73.1 5.1 L73.1 7.6" stroke="#e2789d" stroke-width="1.0" stroke-linecap="round"/><path d="M75.0 5.1 L75.0 7.6" stroke="#e2789d" stroke-width="1.0" stroke-linecap="round"/><path d="M76.9 5.1 L76.9 7.6" stroke="#e2789d" stroke-width="1.0" stroke-linecap="round"/><circle cx="72.2" cy="12.0" r="1.7" fill="#2e2650"/><circle cx="72.8" cy="11.4" r="0.6" fill="#fff"/><circle cx="77.8" cy="12.0" r="1.7" fill="#2e2650"/><circle cx="78.3" cy="11.4" r="0.6" fill="#fff"/><path d="M74.1 14.0 L75.9 14.0 L75.0 15.0Z" fill="#e2789d"/><path d="M73.1 15.4 q0.9 1.1 1.9 0 q0.9 1.1 1.9 0" fill="none" stroke="#2e2650" stroke-width="0.7" stroke-linecap="round"/><circle cx="70.0" cy="14.2" r="1.4" fill="#e2789d" opacity="0.45"/><circle cx="80.0" cy="14.2" r="1.4" fill="#e2789d" opacity="0.45"/></g><g><rect x="132" y="16" width="12" height="24" rx="3" fill="#fde3ec" stroke="#e8b6c8" stroke-width="2"/><path d="M130.8 9.8 L131.4 2.1 L136.3 5.9Z" fill="#f6a5c0"/><path d="M131.9 8.1 L132.2 4.3 L135.2 6.5Z" fill="#fde3ec"/><path d="M145.2 9.8 L144.6 2.1 L139.7 5.9Z" fill="#f6a5c0"/><path d="M144.1 8.1 L143.8 4.3 L140.8 6.5Z" fill="#fde3ec"/><ellipse cx="138" cy="12" rx="8.2" ry="7.2" fill="#f6a5c0"/><path d="M136.1 5.1 L136.1 7.6" stroke="#e2789d" stroke-width="1.0" stroke-linecap="round"/><path d="M138.0 5.1 L138.0 7.6" stroke="#e2789d" stroke-width="1.0" stroke-linecap="round"/><path d="M139.9 5.1 L139.9 7.6" stroke="#e2789d" stroke-width="1.0" stroke-linecap="round"/><circle cx="135.2" cy="12.0" r="1.7" fill="#2e2650"/><circle cx="135.8" cy="11.4" r="0.6" fill="#fff"/><circle cx="140.8" cy="12.0" r="1.7" fill="#2e2650"/><circle cx="141.3" cy="11.4" r="0.6" fill="#fff"/><path d="M137.1 14.0 L138.9 14.0 L138.0 15.0Z" fill="#e2789d"/><path d="M136.1 15.4 q0.9 1.1 1.9 0 q0.9 1.1 1.9 0" fill="none" stroke="#2e2650" stroke-width="0.7" stroke-linecap="round"/><circle cx="133.1" cy="14.2" r="1.4" fill="#e2789d" opacity="0.45"/><circle cx="142.9" cy="14.2" r="1.4" fill="#e2789d" opacity="0.45"/></g>`,
        fence_seal_posts: `<rect x="0" y="24" width="150" height="6" rx="3" fill="#e8d3ad"/><g><rect x="32" y="20" width="22" height="12" rx="6" fill="#a9c7e6"/><path d="M37 26 h12" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round" opacity="0.8"/></g><g><rect x="95" y="20" width="22" height="12" rx="6" fill="#a9c7e6"/><path d="M100 26 h12" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round" opacity="0.8"/></g><g><rect x="6" y="18" width="12" height="22" rx="6" fill="#fbefd9" stroke="#e8d3ad" stroke-width="2"/><ellipse cx="12" cy="13" rx="8.8" ry="7.7" fill="#d5dde7"/><ellipse cx="9.2" cy="9.1" rx="2.8" ry="1.4" fill="#eef2f6" opacity="0.8"/><ellipse cx="12" cy="15.8" rx="4.4" ry="3.0" fill="#ffffff"/><path d="M7.0 12.4 q1.7 1.4 3.3 0" fill="none" stroke="#2e2650" stroke-width="0.8" stroke-linecap="round"/><path d="M13.7 12.4 q1.7 1.4 3.3 0" fill="none" stroke="#2e2650" stroke-width="0.8" stroke-linecap="round"/><ellipse cx="12" cy="14.4" rx="1.2" ry="0.8" fill="#2e2650"/><path d="M10.3 16.3 q0.8 0.9 1.7 0 q0.8 0.9 1.7 0" fill="none" stroke="#2e2650" stroke-width="0.6" stroke-linecap="round"/><circle cx="9.8" cy="15.8" r="0.4" fill="#b8c4d3"/><circle cx="9.0" cy="16.9" r="0.4" fill="#b8c4d3"/><circle cx="14.2" cy="15.8" r="0.4" fill="#b8c4d3"/><circle cx="15.0" cy="16.9" r="0.4" fill="#b8c4d3"/><ellipse cx="5.9" cy="15.2" rx="1.5" ry="1.0" fill="#f4a6b8" opacity="0.7"/><ellipse cx="18.1" cy="15.2" rx="1.5" ry="1.0" fill="#f4a6b8" opacity="0.7"/></g><g><rect x="69" y="18" width="12" height="22" rx="6" fill="#fbefd9" stroke="#e8d3ad" stroke-width="2"/><ellipse cx="75" cy="13" rx="8.8" ry="7.7" fill="#d5dde7"/><ellipse cx="72.2" cy="9.1" rx="2.8" ry="1.4" fill="#eef2f6" opacity="0.8"/><ellipse cx="75" cy="15.8" rx="4.4" ry="3.0" fill="#ffffff"/><circle cx="71.7" cy="12.4" r="1.4" fill="#2e2650"/><circle cx="72.2" cy="11.9" r="0.5" fill="#fff"/><circle cx="78.3" cy="12.4" r="1.4" fill="#2e2650"/><circle cx="78.8" cy="11.9" r="0.5" fill="#fff"/><ellipse cx="75" cy="14.4" rx="1.2" ry="0.8" fill="#2e2650"/><path d="M73.3 16.3 q0.8 0.9 1.7 0 q0.8 0.9 1.7 0" fill="none" stroke="#2e2650" stroke-width="0.6" stroke-linecap="round"/><circle cx="72.8" cy="15.8" r="0.4" fill="#b8c4d3"/><circle cx="72.0" cy="16.9" r="0.4" fill="#b8c4d3"/><circle cx="77.2" cy="15.8" r="0.4" fill="#b8c4d3"/><circle cx="78.0" cy="16.9" r="0.4" fill="#b8c4d3"/><ellipse cx="69.0" cy="15.2" rx="1.5" ry="1.0" fill="#f4a6b8" opacity="0.7"/><ellipse cx="81.0" cy="15.2" rx="1.5" ry="1.0" fill="#f4a6b8" opacity="0.7"/></g><g><rect x="132" y="18" width="12" height="22" rx="6" fill="#fbefd9" stroke="#e8d3ad" stroke-width="2"/><ellipse cx="138" cy="13" rx="8.8" ry="7.7" fill="#d5dde7"/><ellipse cx="135.2" cy="9.1" rx="2.8" ry="1.4" fill="#eef2f6" opacity="0.8"/><ellipse cx="138" cy="15.8" rx="4.4" ry="3.0" fill="#ffffff"/><path d="M133.1 12.4 q1.7 1.4 3.3 0" fill="none" stroke="#2e2650" stroke-width="0.8" stroke-linecap="round"/><path d="M139.7 12.4 q1.7 1.4 3.3 0" fill="none" stroke="#2e2650" stroke-width="0.8" stroke-linecap="round"/><ellipse cx="138" cy="14.4" rx="1.2" ry="0.8" fill="#2e2650"/><path d="M136.3 16.3 q0.8 0.9 1.7 0 q0.8 0.9 1.7 0" fill="none" stroke="#2e2650" stroke-width="0.6" stroke-linecap="round"/><circle cx="135.8" cy="15.8" r="0.4" fill="#b8c4d3"/><circle cx="135.0" cy="16.9" r="0.4" fill="#b8c4d3"/><circle cx="140.2" cy="15.8" r="0.4" fill="#b8c4d3"/><circle cx="141.0" cy="16.9" r="0.4" fill="#b8c4d3"/><ellipse cx="131.9" cy="15.2" rx="1.5" ry="1.0" fill="#f4a6b8" opacity="0.7"/><ellipse cx="144.1" cy="15.2" rx="1.5" ry="1.0" fill="#f4a6b8" opacity="0.7"/></g>`
    };
    function farmFenceHTML(id) {
        // 版面 v11：左右兩段各 156×41.6，左段 x=18、右段 x=216（圍籬框從 x=18 開始，寬 354）
        if (FARM_FENCE_ART[id]) return `<svg class="fm-fence-svg" viewBox="0 0 354 41.6" preserveAspectRatio="none" aria-hidden="true" style="overflow:visible"><g transform="scale(1.04)">${FARM_FENCE_ART[id]}</g><g transform="translate(198 0) scale(1.04)">${FARM_FENCE_ART[id]}</g></svg>`;
        let post = id === 'fence_lantern'
            ? (x) => `<g><rect x="${x}" y="8" width="13" height="34" rx="4" fill="#F4E3C1" stroke="#D8B98E" stroke-width="2"/><ellipse cx="${x + 6.5}" cy="6" rx="7" ry="8" fill="#E8483B"/><rect x="${x + 3}" y="-3" width="7" height="3" fill="#B9452F"/></g>`
            : (x) => `<rect x="${x}" y="6" width="13" height="36" rx="4" fill="#F4E3C1" stroke="#D8B98E" stroke-width="2"/>`;
        let side = (xs) => `<rect x="${xs[0] - 6}" y="18" width="${xs[xs.length - 1] - xs[0] + 26}" height="7" rx="2" fill="#E6CF9F"/>${xs.map(post).join('')}`;
        return `<svg class="fm-fence-svg" viewBox="0 0 354 46" preserveAspectRatio="none" aria-hidden="true" style="overflow:visible">${side([6, 46, 86, 126])}${side([204, 244, 284, 324])}</svg>`;
    }
    function farmDecorArt(slot) {
        let id = farm.equippedDecor[slot];
        if (slot === 'fence') return farmFenceHTML(id);
        return (FARM_ART[id] || (() => ''))();
    }

    // ── 畫面：農場首頁（整個畫面以 390 寬設計，再依實際寬度縮放，看起來跟設計稿一樣）──
    let farmEditing = false, farmEditSlot = '', farmTick = null;
    function goToFarmPage() {
        farmEditing = false; farmEditSlot = '';
        switchView('farmView');
        farmHoneyCheck();
        farmRender();
        window.scrollTo(0, 0);
        farmSync();
        clearInterval(farmTick);
        farmTick = setInterval(() => {      // 每 5 秒更新一次（倒數、可以澆水的水滴）
            if (!document.getElementById('farmView').classList.contains('active')) { clearInterval(farmTick); farmTick = null; return; }
            farmHoneyCheck();
            if (!farmEditing) farmRender();
        }, 5000);
    }
    function farmFit() {
        let wrap = document.getElementById('farmStageWrap'), st = document.getElementById('farmStage');
        if (!wrap || !st) return;
        // 寬度放得下就照寬度縮放；手機畫面太矮時再縮小一點，讓整個農場不用捲動就看得完
        let kw = wrap.clientWidth / 390 || 1, k = kw;
        let r = wrap.getBoundingClientRect(), sc = r.width / (wrap.clientWidth || 1) || 1;     // 電腦版整個畫面有放大
        let avail = (advViewportH() - (r.top + window.scrollY) - 10) / sc;
        // 手機：畫面比農場高時，把多出來的高度分給各排之間的間距（房子↔田、田↔圍籬、圍籬↔信箱那排、最下面），整頁填滿但不超出畫面
        let extra = 0;
        if (window.innerWidth < 769) extra = Math.max(0, Math.min(360, Math.floor(avail / kw - 660 - 8)));
        let g = [0.14, 0.26, 0.24, 0.22], acc = 0, fy = g.map(x => (acc += x * extra));   // 剩下 14% 留在最下面
        ['--fy1', '--fy2', '--fy3', '--fy4'].forEach((v, i) => st.style.setProperty(v, fy[i].toFixed(1) + 'px'));
        st.style.setProperty('--fh', extra + 'px');
        if (avail > 200 && st.offsetHeight * kw > avail) k = Math.max(kw * 0.78, avail / st.offsetHeight);
        let left = (wrap.clientWidth - 390 * k) / 2;
        st.style.transform = `translate(${left.toFixed(1)}px, 0) scale(${k})`;
        wrap.style.height = Math.ceil(st.offsetHeight * k) + 'px';
        let py = (268 + fy[0]) * k;
        wrap.style.background = `linear-gradient(#FFE6C4 0, #FFE6C4 ${py.toFixed(0)}px, #B9CF7C ${py.toFixed(0)}px)`;   // 兩邊空白跟背景同色
    }
    window.addEventListener('resize', () => { try { if (document.getElementById('farmView').classList.contains('active')) farmFit(); } catch (e) {} });
    function farmSecLeft(p) { return Math.max(0, Math.ceil((p.readyAt - farmNow()) / 1000)); }
    function farmPlotHTML(p, i) {
        let unlocked = i < farmUnlocked();
        if (!unlocked && !p) return `<div class="fm-plot locked">${farmLockIcon(30)}</div>`;   // 舊版解鎖的田上還有作物：照常顯示，收成後就鎖起來
        if (!p) return `<button type="button" class="fm-plot empty" data-on-click='[["farmTapPlot",[${i}]]]'><span class="fm-empty">＋</span></button>`;
        let due = farmIsDue(p), ripe = p.stage >= 4;
        let badge = ripe ? '<span class="fm-ripe">收成</span>' : due ? `<span class="fm-drop">${farmDropIcon(18)}</span>` : `<span class="fm-wait">${farmSecLeft(p)} 秒</span>`;
        return `<button type="button" class="fm-plot" data-on-click='[["farmTapPlot",[${i}]]]'>${badge}<span class="fm-crop">${farmPlantSVG(p.stage, 70)}</span><b class="fm-word">${escapeHTML(p.word)}</b></button>`;
    }
    function farmRender() {
        let box = document.getElementById('farmBody');
        if (!box) return;
        let due = farmDueList().length, left = farmPlantLeft(), empty = farmEmptyIndex();
        let ed = farmEditing;
        let slot = (s, cls, inner) => `<div class="fm-slot fm-${s}${ed ? ' edit' + (farmEditSlot === s ? ' sel' : '') : ''} ${cls || ''}"${ed ? ` data-on-click='[["farmPickSlot",["${s}"]]]'` : ''}>${ed ? `<span class="fm-slot-tag">${FARM_SLOT_NAMES[s]}</span>` : ''}${inner}</div>`;
        let guardNone = farm.equippedDecor.guard === 'guard_none';
        let guardInner = guardNone ? (ed ? '<div class="fm-guard-empty"><b>＋</b>守衛</div>' : '') : farmDecorArt('guard');      // 空的守衛位置只在布置模式出現
        let helper = advData.cleared && advData.cleared[1]
            ? `<div class="fm-helper"><span class="fm-helper-ic">${advEnemySVG('meatball')}</span><span><b>幫手・貢丸</b><em>忘記澆水時幫你顧一天</em></span></div>`
            : `<div class="fm-helper"><span class="fm-helper-ic dim">${advEnemySVG('meatball')}</span><span><b>還沒有幫手</b><em>打倒第 1 關的貢丸就能邀請</em></span></div>`;
        let plantOff = left <= 0 || empty < 0;
        box.innerHTML = `<div class="fm-wrap" id="farmStageWrap"><div class="fm-stage" id="farmStage"><div class="fm-top">
            <div class="fm-head${ed ? ' ed' : ''}">
                ${ed ? `<b class="fm-title">布置模式</b><button type="button" class="fm-done" data-on-click='[["farmEditDone",[]]]'>完成</button>`
                     : `<button type="button" class="fm-sq" aria-label="返回" data-on-click='[["farmBack",[]]]'><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2E2650" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5 L8 12 L15 19"/></svg></button>${farmLvHTML()}<button type="button" class="fm-sq" aria-label="布置農場" data-on-click='[["farmEditStart",[]]]'>${farmPencilIcon(22)}</button>`}
                <span class="fm-pills"><button type="button" class="fm-pill" aria-label="花店" data-on-click='[["farmOpenShop",[]]]'>${farmFlowerIcon(22)}<b id="farmFlowerN">${farm.flowers}</b></button></span>
            </div>
            ${ed ? `<div class="fm-tip">點虛線框選擇要換的裝飾</div>`
                 : (due ? `<div class="fm-remind">${farmCanSVG(36)}<span class="fm-remind-tx"><b>今天有 ${due} 株等你澆水</b><small>點有水滴的田，一株一株澆</small></span></div>`
                        : `<div class="fm-remind mini">${farmCanSVG(30)}<span class="fm-remind-tx"><b>${farm.plots.some(Boolean) ? '目前沒有要澆水的作物' : '先種一個字吧！'}</b><small>${empty < 0 ? '沒有空田了' : left > 0 ? `今天還能種 ${left} 顆` : '明天可再種'}</small></span><button type="button" class="fm-go" ${plantOff ? 'disabled' : ''} data-on-click='[["farmOpenPlant",[]]]'>種新的字</button></div>`)}
            </div>
            <div class="fm-scene">
                <svg class="fm-hill" viewBox="0 0 3590 86" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="fmHillG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#C9D98A"/><stop offset=".72" stop-color="#C3D584"/><stop offset="1" stop-color="#B9CF7C"/></linearGradient></defs><path d="M0 36 Q200 16 400 36 Q600 56 800 36 Q1000 16 1200 36 Q1350 50 1450 46 Q1530 43 1600 40 Q1700 18 1800 42 Q1900 4 1990 22 Q2080 40 2190 36 Q2390 26 2590 40 Q2790 54 2990 36 Q3190 18 3390 34 Q3490 42 3590 36 V86 H0 Z" fill="url(#fmHillG)"/></svg>
                ${slot('house', '', farmDecorArt('house'))}
                ${slot('scarecrow', '', farmDecorArt('scarecrow'))}
                <div class="fm-field${ed ? ' faded' : ''}">${farm.plots.map((p, i) => farmPlotHTML(p, i)).join('')}</div>
                ${ed ? '' : farmHiveHTML()}
                ${slot('fence', '', farmDecorArt('fence'))}
                ${slot('guard', '', guardInner)}
                ${slot('mailbox', '', farmDecorArt('mailbox'))}
            </div>
            <div class="fm-bottom${ed ? ' faded' : ''}">
                ${helper}
            </div>
        </div></div>`;
        if (farmShopOpen && !ed) farmOverlay(farmShopHTML());
        else if (farmBeeOpen && !ed) farmOverlay(farmBeeHTML());
        else farmOverlay(ed && farmEditSlot ? farmSheetHTML(farmEditSlot) : '');
        farmFit();
        farmXpAnimate();
    }
    function farmBack() { clearInterval(farmTick); farmTick = null; farmEditing = false; setHomeTab('fun'); }
    function farmTapPlot(i) {
        if (farmEditing) return;
        let p = farm.plots[i];
        if (!p) { farmOpenPlant(); return; }
        if (p.stage >= 4) { farmStartHarvest(i); return; }
        if (farmIsDue(p)) { farmStartWater(i); return; }     // 點哪一株就澆哪一株（一題一題來）
        farmToast(`「${p.word}」${FARM_STAGE_NAMES[p.stage]}中，${farmSecLeft(p)} 秒後可以澆水`);
    }
    function farmToast(t) {
        let el = document.getElementById('farmToast');
        if (!el) { el = document.createElement('div'); el.id = 'farmToast'; el.className = 'fm-toast'; document.body.appendChild(el); }
        el.textContent = t;
        el.classList.add('on');
        clearTimeout(el._t);
        el._t = setTimeout(() => el.classList.remove('on'), 2200);
    }
    async function farmHarvest(i) {
        let p = farm.plots[i];
        if (!p || p.stage < 4) return;
        if (farmSrv === true) {               // 後台確認真的開花了才給花
            let res = await farmCall('harvest', { index: i });
            if (!res) return;
        } else {
            farm.plots[i] = null;
            farm.flowers += 1;                // 一株開花 = 一朵花
            farm.harvestTotal += 1;
            farm.xp += 1;                     // 收成：經驗 +1
            farmSave();
        }
        try { triggerTaskCheck('farm_care'); } catch (e) {}        // 每日任務：在農場收成
        farmToast(`🌸 收成「${p.word}」，得到 1 朵花！經驗 +1`);
    }

    // ── 花店：用花買大冒險戰鬥中可以用的道具（一場戰鬥每種限用 1 次）──
    // 花蜜、花環先下架（之後要再上架，把下面兩行的註解拿掉即可）
    const FARM_ITEMS = {
        // nectar: { name: '花蜜', icon: '🍯', price: 5, desc: '戰鬥中護盾 +2' },
        // crown: { name: '花環', icon: '🌸', price: 8, desc: '這場戰鬥攻擊力 +1' }
    };
    let farmShopOpen = false;
    function farmOpenShop() { if (farmEditing) return; farmShopOpen = true; farmOverlay(farmShopHTML()); }
    function farmCloseShop() { farmShopOpen = false; farmOverlay(''); }
    function farmShopHTML() {
        return `<div class="fm-sheet-bg" data-on-click='[["farmCloseShop",[]]]'></div><div class="fm-sheet">
            <div class="fm-grab"></div>
            <div class="fm-sheet-head"><button type="button" class="fm-x" aria-label="關閉" data-on-click='[["farmCloseShop",[]]]'><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"><path d="M6 6 L18 18 M18 6 L6 18"/></svg></button><b>花店</b><span>花 ${farm.flowers} 朵</span></div>
            ${Object.keys(FARM_ITEMS).map(k => { let it = FARM_ITEMS[k]; return `<div class="fm-shop-row"><span class="fm-shop-ic">${it.icon}</span><span class="fm-shop-tx"><b>${it.name}</b><small>${it.desc}・持有 ${farm.items[k] || 0}</small></span><button type="button" class="fm-shop-buy" ${farm.flowers < it.price ? 'disabled' : ''} data-on-click='[["farmBuyItem",["${k}"]]]'>${farmFlowerIcon(16)} ${it.price}</button></div>`; }).join('')}
            ${Object.keys(FARM_ITEMS).length ? '<div class="fm-shop-note">在大冒險戰鬥中使用，一場戰鬥每種限用 1 次。農場裝飾請按鉛筆進入布置模式。</div>' : '<div class="fm-shop-note">花店的道具暫時下架囉。花可以用來買農場裝飾：按右下角的鉛筆進入布置模式。</div>'}</div>`;
    }
    async function farmBuyItem(k) {
        let it = FARM_ITEMS[k];
        if (!it) return;
        if (farm.flowers < it.price) { farmToast('花不夠喔！'); return; }
        if (farmSrv === true) { let r = await farmCall('buy', { id: k }); if (!r) return; }
        else { farm.flowers -= it.price; farm.items[k] = (farm.items[k] || 0) + 1; farmSave(); }
        farmToast(`買到 ${it.icon} ${it.name}！`);
        if (farmShopOpen) farmOverlay(farmShopHTML());
        farmRefresh();
    }
    // 戰鬥中使用（先在畫面上扣掉，再告訴後台）
    function farmUseItem(k) {
        if (!farm.items[k]) return false;
        farm.items[k] -= 1;
        farmSave();
        if (farmSrv === true) farmCall('use_item', { id: k });
        return true;
    }

    // ── 布置模式 ──
    function farmEditStart() { farmEditing = true; farmEditSlot = ''; farmRender(); }
    function farmEditDone() { farmEditing = false; farmEditSlot = ''; farmRender(); }
    function farmPickSlot(s) { if (!farmEditing || !FARM_SLOT_NAMES[s]) return; farmEditSlot = s; farmRender(); }
    function farmCloseSheet() { farmEditSlot = ''; farmRender(); }
    function farmDecorThumb(it) {
        if (it.slot === 'fence') return `<div class="fm-thumb-fence">${farmFenceHTML(it.id)}</div>`;
        if (it.id === 'guard_none') return '<div class="fm-guard-empty sm"><b>＋</b>空位</div>';
        return FARM_ART[it.id] ? FARM_ART[it.id]() : '';
    }
    function farmSheetHTML(s) {
        let items = FARM_DECOR.filter(x => x.slot === s);
        return `<div class="fm-sheet-bg" data-on-click='[["farmCloseSheet",[]]]'></div><div class="fm-sheet">
            <div class="fm-grab"></div>
            <div class="fm-sheet-head"><button type="button" class="fm-x" aria-label="關閉" data-on-click='[["farmCloseSheet",[]]]'><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"><path d="M6 6 L18 18 M18 6 L6 18"/></svg></button><b>換${FARM_SLOT_NAMES[s]}</b><span>花 ${farm.flowers} 朵</span></div>
            <div class="fm-opts">${items.map(it => {
                let own = farm.ownedDecor.includes(it.id), on = farm.equippedDecor[s] === it.id;
                return `<button type="button" class="fm-opt${on ? ' on' : ''}" data-on-click='[["farmChooseDecor",["${it.id}"]]]'><span class="fm-opt-art">${farmDecorThumb(it)}</span><b>${it.name}</b>${on ? '<small>使用中</small>' : own ? '' : `<small>${farmLockIcon(12, '#8A8378')} ${it.price} 朵花</small>`}</button>`;
            }).join('')}</div></div>`;
    }
    function farmChooseDecor(id) {
        let it = FARM_DECOR.find(x => x.id === id);
        if (!it) return;
        if (!farm.ownedDecor.includes(id)) {
            if (farm.flowers < it.price) { alert(`花不夠！「${it.name}」要 ${it.price} 朵花，目前有 ${farm.flowers} 朵。\n\n收成作物就能得到花。`); return; }
            if (!confirm(`要用 ${it.price} 朵花買「${it.name}」嗎？`)) return;
            if (farmSrv === true) { farmCall('buy', { id }).then(r => { if (r) { farmEditSlot = ''; farmRender(); } }); return; }
            farm.flowers -= it.price;
            farm.ownedDecor.push(id);
        }
        farm.equippedDecor[it.slot] = id;
        farmSave();
        farmEditSlot = '';             // 換好就關掉選單，直接回到農場
        farmRender();
        if (farmSrv === true) farmCall('equip', { id });
    }

    // ── 種新的字 ──
    let farmPlantList = 'rec', farmLearnWord = null;
    function farmWordPool() {          // 目前語言的所有題庫的字（同一個字只留一次）
        let seen = {}, out = [];
        wordLists.forEach((l, idx) => {
            if (!l || !l.content || !isListInCurrentLang(l)) return;
            parseWordsRaw(l.content).forEach(w => {
                let k = String(w.english || '').toLowerCase();
                if (!k || seen[k]) return;
                seen[k] = true;
                out.push(Object.assign({}, w, { listIdx: idx }));
            });
        });
        return out;
    }
    function farmOpenPlant() {
        if (farmEditing) return;
        if (farmEmptyIndex() < 0) { farmToast('沒有空田了，先收成開花的作物吧！'); return; }
        if (farmPlantLeft() <= 0) { farmToast(`今天已經種了 ${FARM_PLANT_PER_DAY} 顆，明天可以再種`); return; }
        farmLearnWord = null;
        switchView('farmPlantView');
        farmRenderPlant();
        window.scrollTo(0, 0);
    }
    function farmSetPlantList(v) { farmPlantList = String(v); farmRenderPlant(); }
    function farmRenderPlant() {
        let box = document.getElementById('farmPlantBody');
        if (!box) return;
        let planted = farmPlantedWords();
        let pool = farmWordPool().filter(w => !planted.includes(String(w.english).toLowerCase()));
        let wrong = Object.assign({}, (advData && advData.wrongCnt) || {});
        let fmiss = farmMissedMap();
        Object.keys(fmiss).forEach(k => { wrong[k] = (wrong[k] || 0) + fmiss[k]; });
        // 推薦：先放農場題庫的字，再放錯過的字（農場答錯、大冒險答錯、星號字）
        let farmWords = farmBeePool().filter(w => !planted.includes(String(w.english).toLowerCase())).map(w => Object.assign({}, w, { farmPack: true }));
        let farmKeys = new Set(farmWords.map(w => String(w.english).toLowerCase()));
        let missedPool = farmWordPool().concat(farmBeePool()).filter((w, i, a) => a.findIndex(x => String(x.english).toLowerCase() === String(w.english).toLowerCase()) === i);
        let missed = missedPool.filter(w => { let k = String(w.english).toLowerCase(); return !planted.includes(k) && !farmKeys.has(k) && (wrong[k] || w.starred); })
            .sort((a, b) => (wrong[String(b.english).toLowerCase()] || 0) - (wrong[String(a.english).toLowerCase()] || 0));
        let rec = farmWords.concat(missed);
        let lists = wordLists.map((l, i) => ({ l, i })).filter(x => x.l && x.l.content && isListInCurrentLang(x.l) && getListWordCount(x.l.content) > 0);
        if (farmPlantList === 'rec' && !rec.length) farmPlantList = lists.length ? String(lists[0].i) : 'rec';
        let shown = farmPlantList === 'rec' ? rec : pool.filter(w => String(w.listIdx) === farmPlantList);
        let opts = `<option value="rec"${farmPlantList === 'rec' ? ' selected' : ''}>⭐ 推薦（農場單字、錯過的字）</option>` + lists.map(x => `<option value="${x.i}"${String(x.i) === farmPlantList ? ' selected' : ''}>${escapeHTML(x.l.title)}</option>`).join('');
        let rows = shown.slice(0, 300).map((w, i) => {
            let k = String(w.english).toLowerCase(), wc = wrong[k] || 0;
            let head = farmPlantList !== 'rec' ? '' : (i === 0 && w.farmPack ? '<div class="fm-wgrp">農場單字</div>' : (!w.farmPack && (i === 0 || shown[i - 1].farmPack) ? '<div class="fm-wgrp">錯過的字</div>' : ''));
            return `${head}<button type="button" class="fm-wrow" data-on-click='[["farmLearn",[${JSON.stringify(w.english).replace(/'/g, '&#39;')}]]]'><span class="aw-tx"><b>${escapeHTML(w.english)}</b><span class="cn">${escapeHTML(w.chinese || '')}</span>${wc ? `<span class="aw-bad">錯 ${wc} 次</span>` : ''}${w.starred ? ' ⭐' : ''}</span><span class="fm-wplus">種</span></button>`;
        }).join('');
        box.innerHTML = `<div class="fm-pl-top"><span>今天還能種 <b>${farmPlantLeft()}</b> 顆・空田 <b>${farm.plots.slice(0, farmUnlocked()).filter(p => !p).length}</b> 格</span></div>
            <select class="fm-select" aria-label="從哪個題庫選字" data-on-change='[["farmSetPlantList",["$value"]]]'>${opts}</select>
            <div class="fm-wlist">${rows || '<div class="lst-empty">這裡沒有可以種的字了</div>'}</div>`;
        farmOverlay(farmLearnWord ? farmLearnHTML(farmLearnWord) : '');
    }
    function farmFindWord(eng) { return farmWordPool().find(w => w.english === eng) || farmBeePool().find(w => w.english === eng); }
    // 農場裡答錯的字（澆水、收成、採蜜），種新的字時會推薦
    const FARM_MISS_KEY = 'chicky_farm_missed';
    function farmMissedMap() { try { let m = JSON.parse(localStorage.getItem(FARM_MISS_KEY)); return m && typeof m === 'object' ? m : {}; } catch (e) { return {}; } }
    function farmNoteMiss(word) {
        let k = String(word || '').toLowerCase(); if (!k) return;
        let m = farmMissedMap(); m[k] = (m[k] || 0) + 1;
        try { localStorage.setItem(FARM_MISS_KEY, JSON.stringify(m)); } catch (e) {}
    }
    function farmLearn(eng) {
        let w = farmFindWord(eng);
        if (!w) return;
        farmLearnWord = w;
        farmRenderPlant();
        advSpeakWord(w.english);            // 種下前先學一次：自動播放發音
    }
    function farmLearnHTML(w) {
        return `<div class="fm-sheet-bg" data-on-click='[["farmLearnClose",[]]]'></div><div class="fm-learn">
            <div class="fm-learn-ic">${farmSeedIcon(44)}</div>
            <div class="fm-learn-en">${escapeHTML(w.english)}</div>
            <div class="fm-learn-pos">${escapeHTML(w.pos || '')}</div>
            <div class="fm-learn-cn">${escapeHTML(w.senseText || w.chinese || '')}</div>
            <button type="button" class="fm-say" data-on-click='[["farmSay",[${JSON.stringify(w.english).replace(/'/g, '&#39;')}]]]'>🔊 再聽一次</button>
            <button type="button" class="fm-big" data-on-click='[["farmPlantNow",[]]]'>記住了，種下去！</button>
            <button type="button" class="fm-link" data-on-click='[["farmLearnClose",[]]]'>換一個字</button></div>`;
    }
    function farmLearnClose() { farmLearnWord = null; farmRenderPlant(); }
    function farmSay(t) { advSpeakWord(String(t || '')); }
    function farmPlantNow() {
        let w = farmLearnWord, i = farmEmptyIndex();
        if (!w || i < 0 || farmPlantLeft() <= 0) { farmLearnWord = null; goToFarmPage(); return; }
        if (farmPlantedWords().includes(String(w.english).toLowerCase())) { farmToast('這個字已經種過了，換一個字吧'); farmLearnWord = null; farmRenderPlant(); return; }
        let fast = farm.fastTrackUsed < FARM_FAST_N;
        let plot = { word: w.english, cn: w.chinese || '', pos: w.pos || '', line: w.rawLine || w.line || '', lang: getLearningLanguage() === 'ko' ? 'ko' : 'en', stage: 0, readyAt: farmNow() + FARM_STEP_MS, wrong: 0, fast };
        farm.plots[i] = plot;
        if (fast) farm.fastTrackUsed += 1;
        let today = farmToday();
        farm.plantedToday = { date: today, count: farmPlantedToday() + 1 };
        if (!farm.plantedWords) farm.plantedWords = [];
        farm.plantedWords.push(String(w.english).toLowerCase());
        farm.xp += 1;                         // 種種子：經驗 +1（後台也會加）
        farmSave();
        if (farmSrv === true) farmCall('plant', Object.assign({ index: i, day: today }, plot)).then(() => farmRefresh());
        farmLearnWord = null;
        goToFarmPage();
        farmToast(`🌱 種下「${w.english}」！經驗 +1，1 分鐘後就能第一次澆水`);
    }

    // ── 澆水：一題 = 一株（找出不在上面的：一題 = 三株）──
    let fw = null;          // 這次澆水的狀態
    function farmCnOf(p) { return String(p.cn || '').split(/[、,，；;\/／]/)[0] || p.cn || ''; }
    function farmDistractors(exclude, n) {     // 從題庫裡隨機拿其他字的中文當干擾選項
        let ex = exclude.map(s => String(s).toLowerCase());
        let pool = farmWordPool().filter(w => w.chinese && !ex.includes(String(w.english).toLowerCase()));
        let cnEx = [];
        let out = [];
        advShuffle(pool).forEach(w => { let c = String(w.chinese).split(/[、,，；;\/／]/)[0]; if (out.length < n && c && !cnEx.includes(c)) { cnEx.push(c); out.push(c); } });
        return out;
    }
    // 是非題的「錯的意思」：從題庫找中文最像的（例如題目是「電容器」，題庫有「電容量」，就問「是不是電容量？」）
    //   有共同的字就算像；共同的字越多、開頭或結尾一樣、字數接近的越優先；最像的幾個裡隨機挑一個，同一個字不會每次都問一樣的
    function farmSimilarCn(p) {
        let ans = farmCnOf(p).trim();
        if (!ans) return '';
        let all = String(p.cn || '').split(/[、,，；;\/／]/).map(x => x.trim()).filter(Boolean);
        let ansChars = [...new Set(ans.replace(/[\s（）()〔〕\[\]·・.]/g, ''))];
        let seen = {}, cands = [];
        farmWordPool().forEach(w => {
            if (!w.chinese || String(w.english).toLowerCase() === p.word.toLowerCase()) return;
            String(w.chinese).split(/[、,，；;\/／]/).forEach(c => {
                c = c.trim();
                if (!c || seen[c] || all.includes(c)) return;
                seen[c] = true;
                let common = [...new Set(c)].filter(ch => ansChars.includes(ch)).length;
                if (!common) return;
                let sc = common * 10 + (c[0] === ans[0] ? 4 : 0) + (c[c.length - 1] === ans[ans.length - 1] ? 4 : 0) - Math.abs(c.length - ans.length) * 2;
                cands.push({ c, sc });
            });
        });
        if (!cands.length) return '';
        cands.sort((a, b) => b.sc - a.sc);
        let top = cands.filter(x => x.sc >= cands[0].sc - 3).slice(0, 3);
        return top[Math.floor(Math.random() * top.length)].c;
    }
    function farmBuildTasks() {
        let due = farmDueList();
        let tasks = [];
        // 長葉、含苞：同階段 3 株一起考「找出不在上面的」；不到 3 株改用字母重組
        [2, 3].forEach(st => {
            let g = due.filter(x => x.p.stage === st);
            while (g.length >= 3) { tasks.push({ type: 'odd', idx: g.splice(0, 3).map(x => x.i) }); }
            g.forEach(x => tasks.push({ type: 'scramble', idx: [x.i] }));
        });
        due.filter(x => x.p.stage === 0).forEach(x => tasks.push({ type: 'tf', idx: [x.i] }));
        due.filter(x => x.p.stage === 1).forEach(x => tasks.push({ type: 'scramble', idx: [x.i] }));
        let order = { tf: 0, scramble: 1, odd: 2 };
        return tasks.sort((a, b) => order[a.type] - order[b.type]);
    }
    // 只澆點到的那一株：種子 → 聽英文判斷中文（是非）；發芽以後 → 看中文排字母
    function farmStartWater(i) {
        if (farmEditing) return;
        i = parseInt(i);
        let p = farm.plots[i];
        if (!p || p.stage >= 4 || !farmIsDue(p)) return;
        let tasks = [{ type: p.stage === 0 ? 'tf' : 'scramble', idx: [i] }];
        fw = { tasks, k: 0 };
        switchView('farmWaterView');
        farmNewQuestion();
        window.scrollTo(0, 0);
    }
    function farmNewQuestion() {
        let t = fw.tasks[fw.k];
        let ps = t.idx.map(i => farm.plots[i]).filter(Boolean);
        if (!ps.length) { farmNextTask(); return; }
        fw.done = false; fw.ok = null; fw.sel = null;
        let p = ps[0];
        if (t.type === 'tf') {
            let right = Math.random() < 0.5;
            let shownCn = right ? farmCnOf(p) : (farmSimilarCn(p) || farmDistractors([p.word], 1)[0] || farmCnOf(p));
            if (shownCn === farmCnOf(p)) right = true;
            fw.q = { type: 'tf', p, shownCn, answer: right };
            setTimeout(() => { if (fw && fw.q && fw.q.p === p) farmSay(p.word); }, 350);    // 澆水 1：聽英文 → 判斷中文對不對
        } else if (t.type === 'scramble') {
            let isPhrase = /\s/.test(p.word.trim());
            let parts = isPhrase ? p.word.trim().split(/\s+/) : Array.from(p.word.trim());
            let tiles = parts.map((c, i) => ({ c, i }));
            let sh = advShuffle(tiles.slice());
            if (sh.length > 1 && sh.every((x, i) => x.i === i)) sh.reverse();     // 不要剛好是正確順序
            fw.q = { type: 'scramble', p, parts, isPhrase, pool: sh, picked: [] };
        } else if (t.type === 'dict') {
            fw.q = { type: 'dict', p, typed: '' };
            setTimeout(() => { if (fw && fw.q && fw.q.p === p) farmSay(p.word); }, 350);    // 收成：聽英文 → 拼出單字（沒有中文提示）
        } else {
            let cns = ps.map(farmCnOf);
            let odd = farmDistractors(ps.map(x => x.word), 1)[0] || '（沒有干擾選項）';
            fw.q = { type: 'odd', ps, opts: advShuffle(cns.concat([odd])), odd };
        }
        farmRenderWater();
        if (fw.q.type === 'dict') setTimeout(() => { let el = document.getElementById('fwDictIn'); if (el) try { el.focus({ preventScroll: true }); } catch (e) {} }, 60);
    }
    function farmStageLabel(p) {
        let nx = farmNextStage(p);
        return `${FARM_STAGE_NAMES[p.stage]} → ${nx >= 4 ? '開花' : FARM_STAGE_NAMES[nx]}`;
    }
    function farmRenderWater() {
        let box = document.getElementById('farmWaterBody');
        if (!box || !fw) return;
        let q = fw.q, p = q.p || q.ps[0];
        let body = '', canSubmit = false;
        if (q.type === 'tf') {
            body = `<div class="fw-ask">聽到的單字，是這個意思嗎？</div>
                <button type="button" class="fw-listen" aria-label="再聽一次" data-on-click='[["farmSay",[${JSON.stringify(p.word).replace(/'/g, '&#39;')}]]]'>${FW_SPEAKER}<span>再聽一次</span></button>
                <div class="fw-big">${fw.done ? `<span class="en">${escapeHTML(p.word)}</span> = ` : ''}${escapeHTML(q.shownCn)}？</div>
                <div class="fw-tf">${[[true, '○'], [false, '×']].map(o => `<button type="button" class="fw-tfb${fw.sel === o[0] ? ' sel' : ''}${fw.done && q.answer === o[0] ? ' right' : ''}" ${fw.done ? 'disabled' : ''} data-on-click='[["farmTF",[${o[0]}]]]'>${o[1]}</button>`).join('')}</div>`;
            canSubmit = fw.sel !== null;
        } else if (q.type === 'scramble') {
            let slots = q.parts.map((c, i) => {
                let t = q.picked[i];
                return t ? `<button type="button" class="fw-slot fill${q.isPhrase ? ' w' : ''}" ${fw.done ? 'disabled' : ''} data-on-click='[["farmUnpick",[${i}]]]'>${escapeHTML(t.c)}</button>` : `<span class="fw-slot${q.isPhrase ? ' w' : ''}"></span>`;
            }).join('');
            let used = q.picked.map(t => t.i);
            let tiles = q.pool.map((t, k) => used.includes(t.i) ? '' : `<button type="button" class="fw-tile${q.isPhrase ? ' w' : ''}" ${fw.done ? 'disabled' : ''} data-on-click='[["farmPick",[${k}]]]'>${escapeHTML(t.c)}</button>`).join('');
            body = `<div class="fw-ask">${q.isPhrase ? '把單字排回正確的片語' : '把字母排回正確的單字'}</div><div class="fw-big">${escapeHTML(farmCnOf(p))}</div>
                <div class="fw-slots${q.parts.length > 8 ? ' many' : ''}">${slots}</div><div class="fw-tiles">${tiles}</div>`;
            canSubmit = q.picked.length === q.parts.length;
        } else if (q.type === 'dict') {
            body = `<div class="fw-ask">聽發音，拼出這個單字</div>
                <button type="button" class="fw-listen big" aria-label="再聽一次" data-on-click='[["farmSay",[${JSON.stringify(p.word).replace(/'/g, '&#39;')}]]]'>${FW_SPEAKER}<span>再聽一次</span></button>
                <label class="fw-dict"><span class="fw-boxes" id="fwDictBoxes" style="--bx:${farmBoxSize(p.word)}px">${farmDictBoxes(p.word, q.typed, fw.done)}</span>
                <input class="fw-dict-in" id="fwDictIn" type="text" inputmode="latin" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done" maxlength="${farmLetters(p.word).length}" value="${escapeHTML(q.typed)}" ${fw.done ? 'disabled' : ''} aria-label="輸入聽到的單字" data-on-input='[["farmDictInput",["$value"]]]' data-on-keydown='[["farmDictKey",["$event"]]]'></label>
                <div class="fw-dict-hint">共 ${farmLetters(p.word).length} 個字母${/\s/.test(p.word.trim()) ? '（空格不用打）' : ''}</div>`;
            canSubmit = q.typed.length === farmLetters(p.word).length;
        } else {
            body = `<div class="fw-ask">下面哪一個意思，不在上面的單字裡？</div>
                <div class="fw-words">${q.ps.map(x => `<span>${escapeHTML(x.word)}</span>`).join('')}</div>
                <div class="fw-opts">${q.opts.map((o, k) => `<button type="button" class="fw-opt${fw.sel === k ? ' sel' : ''}${fw.done && o === q.odd ? ' right' : ''}" ${fw.done ? 'disabled' : ''} data-on-click='[["farmOdd",[${k}]]]'>${escapeHTML(o)}</button>`).join('')}</div>`;
            canSubmit = fw.sel !== null;
        }
        let fb = '';
        if (fw.done) {
            let ans = q.type === 'odd' ? q.ps.map(x => `${escapeHTML(x.word)} ${escapeHTML(farmCnOf(x))}`).join('、') : `${escapeHTML(p.word)} ${escapeHTML(p.cn)}`;
            if (q.type === 'dict') fb = fw.ok ? `<div class="fw-fb ok">🌸 拼對了！收成「${escapeHTML(p.word)}」，花 +1、經驗 +1</div>`
                                             : `<div class="fw-fb bad">差一點！正確答案：${escapeHTML(p.word)} ${escapeHTML(p.cn)}<br><small>作物還在田裡，回農場再點一次就能重新收成</small></div>`;
            else fb = fw.ok ? `<div class="fw-fb ok">🌱 答對了！${q.type === 'odd' ? '三株一起長大一階' : `長大一階：${fw.label}`}　經驗 +1</div>`
                       : `<div class="fw-fb bad">差一點！正確答案：${ans}<br><small>沒關係，作物不會退階，1 分鐘後再澆一次（正式版是隔天）</small></div>`;
        }
        let last = fw.k >= fw.tasks.length - 1;
        let isH = q.type === 'dict';
        box.classList.remove('bee-mode');
        box.innerHTML = `<div class="fw-head"><button type="button" class="fm-sq" aria-label="回農場" data-on-click='[["farmWaterQuit",[]]]'><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2E2650" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5 L8 12 L15 19"/></svg></button><b>${isH ? '收成' : `澆水中　${fw.k + 1} / ${fw.tasks.length}`}</b><span class="fm-sq ghost"></span></div>
            <div class="fw-card"><div class="fw-art">${isH ? farmPotSVG(4, 120) : farmPotSVG(fw.done && fw.ok ? Math.min(4, farmNextStage(p)) : p.stage, 120)}${isH ? '' : farmCanSVG(110)}</div><span class="fw-pill">${isH ? '開花了・拼對就收成' : `${q.type === 'odd' ? `${FARM_STAGE_NAMES[p.stage]}・3 株一起澆` : (fw.done && fw.ok ? fw.label : farmStageLabel(p))}　答對就長大`}</span></div>
            ${body}${fb}
            <div class="fw-foot">
                ${fw.done ? `<button type="button" class="fm-big" data-on-click='[["farmNextTask",[]]]'>${last || isH ? '回農場' : '下一株'}</button>`
                          : `<button type="button" class="fm-big" id="fwSubmit" ${canSubmit ? '' : 'disabled'} data-on-click='[["farmSubmit",[]]]'>${isH ? '收成！' : '澆水！'}</button>`}
                ${q.type === 'scramble' ? `<button type="button" class="fm-link" data-on-click='[["farmSay",[${JSON.stringify(p.word).replace(/'/g, '&#39;')}]]]'>聽發音提示</button>` : ''}
            </div>`;
    }
    const FW_SPEAKER = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M16 9a4 4 0 010 6"/><path d="M18.5 6.5a7.5 7.5 0 010 11"/></svg>';
    function farmTF(v) { if (!fw || fw.done) return; fw.sel = !!v; farmRenderWater(); }
    function farmOdd(k) { if (!fw || fw.done) return; fw.sel = parseInt(k); farmRenderWater(); }
    function farmPick(k) {
        if (!fw || fw.done || fw.q.type !== 'scramble') return;
        let t = fw.q.pool[k];
        if (!t || fw.q.picked.some(x => x && x.i === t.i) || fw.q.picked.length >= fw.q.parts.length) return;
        fw.q.picked.push(t);
        farmRenderWater();
    }
    function farmUnpick(i) {
        if (!fw || fw.done || fw.q.type !== 'scramble') return;
        fw.q.picked.splice(i, 1);           // 拿掉這格（後面的往前補）
        farmRenderWater();
    }
    async function farmSubmit() {
        if (!fw || fw.done) return;
        let q = fw.q, ok = false;
        if (q.type === 'dict') {
            if (q.typed.length !== farmLetters(q.p.word).length) return;
            ok = q.typed.toLowerCase() === farmLetters(q.p.word).join('').toLowerCase();
            fw.done = true; fw.ok = ok;
            if (ok) await farmHarvest(fw.harvest);
            else { advSpeakWord(q.p.word); farmNoteMiss(q.p.word); }
            farmRenderWater();
            return;
        }
        if (q.type === 'tf') { if (fw.sel === null) return; ok = fw.sel === q.answer; }
        else if (q.type === 'scramble') { if (q.picked.length !== q.parts.length) return; ok = q.picked.map(t => t.c).join(q.isPhrase ? ' ' : '').toLowerCase() === q.parts.join(q.isPhrase ? ' ' : '').toLowerCase(); }
        else { if (fw.sel === null) return; ok = q.opts[fw.sel] === q.odd; }
        let ps = q.type === 'odd' ? q.ps : [q.p];
        let p0 = ps[0];
        fw.label = farmStageLabel(p0);
        ps.forEach(p => {
            if (ok) p.stage = farmNextStage(p);
            else { p.wrong += 1; farmNoteMiss(p.word); }   // 第一版：答錯不退階（記下來，種新字時推薦）
            p.readyAt = farmNow() + FARM_STEP_MS;
        });
        if (ok) farm.xp += 1;                   // 澆水答對：經驗 +1
        farmSave();
        if (farmSrv === true) farmCall('water', { indices: (q.type === 'odd' ? fw.tasks[fw.k].idx : fw.tasks[fw.k].idx.slice(0, 1)), ok });
        try { triggerTaskCheck('farm_care'); } catch (e) {}        // 每日任務：在農場澆花
        fw.done = true; fw.ok = ok;
        if (!ok && q.type !== 'tf') advSpeakWord(p0.word);      // 是非題答錯不唸發音
        farmRenderWater();
    }
    function farmNextTask() {
        if (!fw) { goToFarmPage(); return; }
        if (fw.harvest !== undefined) { fw = null; goToFarmPage(); return; }
        fw.k += 1;
        if (fw.k >= fw.tasks.length) { fw = null; goToFarmPage(); farmToast('💧 今天的澆水完成了！'); return; }
        farmNewQuestion();
    }
    function farmWaterQuit() { fw = null; fb = null; goToFarmPage(); }

    // ── 收成：聽英文 → 拼出單字（格子告訴你有幾個字母；可以重複聽）──
    function farmLetters(word) { return Array.from(String(word || '')).filter(ch => /[A-Za-z]/.test(ch)); }
    // 格子大小跟著字母數縮放：長的字也排成一行（手機約 330px 寬）
    function farmBoxSize(word) {
        let n = Array.from(String(word || '').trim()).length;
        return Math.max(22, Math.min(42, Math.floor((326 - 5 * (n - 1)) / Math.max(1, n))));
    }
    // 蜂蜜聽寫的「中文」格子：還沒選時照答案字數給空格；選了就把選的字填進去（一個字一格）
    function farmCnBoxes(ans, picked, done) {
        let chars = Array.from(picked || ans || '');
        return chars.map(ch => `<span class="fw-box cn${picked ? ' fill' : ''}${done ? (picked === ans ? ' ok' : ' bad') : ''}">${picked ? escapeHTML(ch) : ''}</span>`).join('');
    }
    function farmDictBoxes(word, typed, done) {
        let k = 0;
        return Array.from(String(word || '').trim()).map(ch => {
            if (/[A-Za-z]/.test(ch)) { let c = typed[k] || ''; let cls = done ? (c.toLowerCase() === ch.toLowerCase() ? ' ok' : ' bad') : (k === typed.length ? ' cur' : ''); k++; return `<span class="fw-box${c ? ' fill' : ''}${cls}">${escapeHTML(c)}</span>`; }
            if (/\s/.test(ch)) return '<span class="fw-gap"></span>';
            return `<span class="fw-fix">${escapeHTML(ch)}</span>`;
        }).join('');
    }
    function farmStartHarvest(i) {
        let p = farm.plots[i];
        if (!p || p.stage < 4 || farmEditing) return;
        fw = { tasks: [{ type: 'dict', idx: [i] }], k: 0, harvest: i };
        switchView('farmWaterView');
        farmNewQuestion();
        window.scrollTo(0, 0);
    }
    function farmDictInput(v) {
        if (!fw || fw.done || !fw.q || fw.q.type !== 'dict') return;
        let max = farmLetters(fw.q.p.word).length;
        let clean = String(v || '').replace(/[^A-Za-z]/g, '').slice(0, max);
        fw.q.typed = clean;
        let el = document.getElementById('fwDictIn'); if (el && el.value !== clean) el.value = clean;
        let bx = document.getElementById('fwDictBoxes'); if (bx) bx.innerHTML = farmDictBoxes(fw.q.p.word, clean, false);
        let b = document.getElementById('fwSubmit'); if (b) b.disabled = clean.length !== max;
    }
    function farmDictKey(e) { if (e && e.key === 'Enter') { e.preventDefault(); farmSubmit(); } }

    // ── 農場等級（左上角）：LV＋經驗條；拿到經驗時經驗條會動態長上去 ──
    let farmXpShown = null;
    function farmLvHTML() {
        let x = farmXpShown === null ? farm.xp : Math.min(farmXpShown, farm.xp);
        let info = farmLvInfo(x);
        return `<div class="fm-lv" aria-label="農場等級 LV${farmLevel()}，經驗 ${farm.xp}">
            <b class="fm-lv-chip" id="farmLvChip">LV${info.lv}</b>
            <span class="fm-lv-bar"><i id="farmXpFill" style="width:${info.pct.toFixed(1)}%"></i></span>
            <small class="fm-lv-num" id="farmXpNum">${info.max ? 'MAX' : `${x}/${info.next}`}</small>
        </div>`;
    }
    function farmXpAnimate() {
        if (farmXpShown === null) { farmXpShown = farm.xp; return; }
        if (farm.xp === farmXpShown) return;
        let from = farmXpShown, to = farm.xp, gain = to - from;
        farmXpShown = to;
        if (gain <= 0) return;
        let fill = document.getElementById('farmXpFill'), num = document.getElementById('farmXpNum'), chip = document.getElementById('farmLvChip');
        if (!fill) return;
        let a = farmLvInfo(from), b = farmLvInfo(to);
        // 浮字放在 body 上（農場畫面重畫時不會被一起清掉），停留約 1.5 秒再淡出
        let fx = document.createElement('span'); fx.className = 'fm-xp-float'; fx.textContent = `+${gain} EXP`;
        let lvBox = fill.closest('.fm-lv'), r = lvBox ? lvBox.getBoundingClientRect() : null;
        if (r) { fx.style.left = (r.left + r.width / 2) + 'px'; fx.style.top = (r.top - 2) + 'px'; document.body.appendChild(fx); }
        setTimeout(() => fx.remove(), 2400);
        requestAnimationFrame(() => {
            if (b.lv > a.lv) {           // 升級：先長滿，再從新的等級開始
                fill.style.width = '100%';
                setTimeout(() => {
                    fill.style.transition = 'none'; fill.style.width = '0%'; void fill.offsetWidth; fill.style.transition = '';
                    fill.style.width = b.pct.toFixed(1) + '%';
                    if (chip) { chip.textContent = 'LV' + b.lv; chip.classList.add('up'); }
                    if (num) num.textContent = b.max ? 'MAX' : `${to}/${b.next}`;
                    farmToast(`🎉 農場升到 LV${b.lv}！${b.lv === 2 ? '多了第 4 塊田，還開放蜜蜂採蜜！' : ''}`);
                    if (b.lv === 2) setTimeout(() => farmRender(), 900);
                }, 650);
            } else {
                fill.style.width = b.pct.toFixed(1) + '%';
                if (num) num.textContent = b.max ? 'MAX' : `${to}/${b.next}`;
            }
        });
    }

    // ── 蜜蜂採蜜（LV2 開放）：每 1 分鐘（測試版）隨機累積 1～3 份蜂蜜，滿 5 份可以採 ──
    const FARM_HIVE_SVG = '<svg viewBox="30 30 112 110" aria-hidden="true"><ellipse cx="75" cy="136" rx="46" ry="8" fill="#9DB35F"/><rect x="52" y="118" width="46" height="14" rx="5" fill="#9A6538"/><path d="M34 112 C34 70 48 36 75 36 C102 36 116 70 116 112 Z" fill="#F5B83D"/><path d="M40 92 H110" stroke="#D9951F" stroke-width="4" stroke-linecap="round"/><path d="M37 106 H113" stroke="#D9951F" stroke-width="4" stroke-linecap="round"/><path d="M45 76 H105" stroke="#D9951F" stroke-width="4" stroke-linecap="round"/><path d="M55 58 H95" stroke="#D9951F" stroke-width="4" stroke-linecap="round"/><path d="M66 112 C66 98 70 92 75 92 C80 92 84 98 84 112 Z" fill="#6B3F1D"/><ellipse cx="62" cy="72" rx="3.2" ry="4" fill="#2A2150"/><ellipse cx="88" cy="72" rx="3.2" ry="4" fill="#2A2150"/><ellipse cx="54" cy="80" rx="6" ry="4" fill="#F4A3BC" opacity="0.85"/><ellipse cx="96" cy="80" rx="6" ry="4" fill="#F4A3BC" opacity="0.85"/><path d="M70 79 Q75 84 80 79" stroke="#2A2150" stroke-width="2" fill="none" stroke-linecap="round"/><g class="fm-bee"><ellipse cx="124" cy="52" rx="6" ry="9" fill="#fff" opacity="0.9" transform="rotate(-25 124 52)"/><ellipse cx="134" cy="54" rx="6" ry="9" fill="#fff" opacity="0.9" transform="rotate(25 134 54)"/><ellipse cx="129" cy="62" rx="11" ry="8.5" fill="#FFD84D"/><path d="M125 54.5 V69.5 M131 54.5 V69.5" stroke="#2A2150" stroke-width="3"/><circle cx="136" cy="60" r="1.6" fill="#2A2150"/></g></svg>';
    function farmHexSVG(full) {
        return `<svg viewBox="4 4 32 36" aria-hidden="true"><polygon points="33.9,13.8 33.9,30.2 19.6,38.5 5.3,30.2 5.3,13.7 19.6,5.5" fill="${full ? '#F5B83D' : '#EFE3C8'}" stroke="${full ? '#D9951F' : '#DCCBA3'}" stroke-width="2" stroke-linejoin="round"/>${full ? '<ellipse cx="15.6" cy="17" rx="4" ry="2.6" fill="#FFE29A"/>' : ''}</svg>`;
    }
    let farmBeeOpen = false;
    // 沒連到後台時，在這台裝置自己累積蜂蜜（連到後台時以後台為準）
    function farmHoneyTick() {
        if (farmLevel() < 2 || farm.honey >= FARM_HONEY_FULL) return false;
        let now = farmNow(), changed = false;
        if (!farm.honeyAt) { farm.honeyAt = now; return true; }
        while (farm.honey < FARM_HONEY_FULL && now >= farm.honeyAt + FARM_HONEY_STEP_MS) {
            farm.honey += 1 + Math.floor(Math.random() * 3);
            farm.honeyAt += FARM_HONEY_STEP_MS;
            changed = true;
        }
        if (farm.honey >= FARM_HONEY_FULL) { farm.honey = FARM_HONEY_FULL; farm.honeyAt = now; }
        return changed;
    }
    let farmHoneySyncAt = 0;
    function farmHoneyCheck() {
        if (farmLevel() < 2 || farm.honey >= FARM_HONEY_FULL) return;
        if (farmSrv === true) {           // 後台算蜂蜜：到時間了就跟後台同步一次
            if (farm.honeyAt && farmNow() >= farm.honeyAt + FARM_HONEY_STEP_MS && Date.now() - farmHoneySyncAt > 20000) { farmHoneySyncAt = Date.now(); farmSync(); }
        } else if (farmSrv === false && farmHoneyTick()) farmSave();     // 確定連不到後台時才在這台裝置自己累積
    }
    function farmHiveHTML() {
        let lv2 = farmLevel() >= 2, full = farm.honey >= FARM_HONEY_FULL;
        return `<button type="button" class="fm-hive${lv2 ? '' : ' locked'}${full ? ' full' : ''}" aria-label="${lv2 ? `蜂巢，蜂蜜 ${farm.honey}/${FARM_HONEY_FULL}` : '蜂巢（農場 LV2 開放）'}" data-on-click='[["farmOpenBee",[]]]'>
            ${full ? '<span class="fm-hive-ready">可採蜜</span>' : ''}
            <span class="fm-hive-art">${FARM_HIVE_SVG}</span>
            <span class="fm-hive-n">${lv2 ? `${farm.honey} / ${FARM_HONEY_FULL}` : 'LV2'}</span></button>`;
    }
    function farmOpenBee() {
        if (farmEditing) return;
        if (farmLevel() < 2) { farmToast('🐝 農場升到 LV2 就能請蜜蜂來採蜜（總經驗 3）'); return; }
        farmBeeOpen = true; farmOverlay(farmBeeHTML());
    }
    function farmCloseBee() { farmBeeOpen = false; farmOverlay(''); }
    function farmBeeHTML() {
        let n = farm.honey, full = n >= FARM_HONEY_FULL;
        let cells = Array.from({ length: FARM_HONEY_FULL }, (_, i) => `<span class="bee-hex">${farmHexSVG(i < n)}</span>`).join('');
        return `<div class="fm-sheet-bg" data-on-click='[["farmCloseBee",[]]]'></div><div class="fm-sheet bee-panel" role="dialog" aria-label="蜜蜂採蜜">
            <div class="fm-grab"></div>
            <div class="bee-head"><b>${full ? '蜂蜜滿了！' : '蜜蜂打工中'}</b><button type="button" class="fm-x" aria-label="關閉" data-on-click='[["farmCloseBee",[]]]'><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"><path d="M6 6 L18 18 M18 6 L6 18"/></svg></button></div>
            <div class="bee-cells">${cells}</div>
            <div class="bee-txt">${full ? `已存 ${FARM_HONEY_FULL} / ${FARM_HONEY_FULL}，答對題目就能採蜜（經驗 +3、花 +1）` : `已存 ${n} / ${FARM_HONEY_FULL}，還差 ${FARM_HONEY_FULL - n} 份`}</div>
            <button type="button" class="bee-btn" ${full ? '' : 'disabled'} data-on-click='[["farmStartBee",[]]]'>${full ? '採蜜！' : '還沒滿'}</button>
            <div class="bee-note">${full ? `這次的題目：${['連連看', '找出不是的意思', '聽寫'][farm.beeStep % 3]}・有 2 次機會` : '蜜蜂每 1 分鐘會帶回 1～3 份蜂蜜（測試版）'}</div>
        </div>`;
    }

    // ── 採蜜題目：三種題型輪流（連連看 → 找出不是的意思 → 聽寫），每次有 2 次機會；失敗這次採蜜就沒了（蜂蜜歸 0、不扣東西）──
    let fb = null;
    function farmBeePool() {
        let seen = {}, out = [];
        parseWordsRaw(FREE_PACK_CONTENT.farm_1_5 || '').forEach(w => { let k = String(w.english || '').toLowerCase(); if (k && w.chinese && !seen[k]) { seen[k] = true; out.push(w); } });
        return out;
    }
    function farmBeeCn(w) { return String(w.chinese || '').split(/[、,，；;\/／\s]/).filter(Boolean)[0] || w.chinese; }
    function farmStartBee() {
        if (farm.honey < FARM_HONEY_FULL) return;
        let pool = advShuffle(farmBeePool().slice());
        let type = farm.beeStep % 3;
        // 中文意思不能重複（避免兩個字都是「明天」之類的選項）
        let pick = (n, avoid) => { let out = [], cns = (avoid || []).slice(); for (let w of pool) { let c = farmBeeCn(w); if (out.length >= n) break; if (!cns.includes(c) && !out.includes(w)) { out.push(w); cns.push(c); } } return out; };
        if (type === 0) {
            let ws = pick(5);
            fb = { type: 'match', ws, en: advShuffle(ws.slice()), cn: advShuffle(ws.slice()), done: [], selEn: null, selCn: null, tries: 2 };
        } else if (type === 1) {
            let ws = pick(3), odd = pick(1, ws.map(farmBeeCn))[0];
            fb = { type: 'odd', ws, odd, opts: advShuffle(ws.map(farmBeeCn).concat([farmBeeCn(odd)])), sel: null, tries: 2 };
        } else {
            let w = pick(1)[0], others = pick(3, [farmBeeCn(w)]);
            fb = { type: 'dict', w, typed: '', opts: advShuffle([farmBeeCn(w)].concat(others.map(farmBeeCn))), sel: null, tries: 2 };
            setTimeout(() => { if (fb && fb.w === w) farmSay(w.english); }, 400);
        }
        fb.state = 'play'; fb.msg = '';
        farmBeeOpen = false;
        farmOverlay('');
        switchView('farmWaterView');
        farmRenderBee();
        window.scrollTo(0, 0);
    }
    function farmRenderBee() {
        let box = document.getElementById('farmWaterBody');
        if (!box || !fb) return;
        let hearts = `<span class="bee-tries" aria-label="還有 ${fb.tries} 次機會">${[0, 1].map(i => `<i class="${i < fb.tries ? 'on' : ''}">♥</i>`).join('')}</span>`;
        let body = '', canSubmit = false, play = fb.state === 'play';
        if (fb.type === 'match') {
            let enB = fb.en.map((w, k) => { let d = fb.done.includes(w); return `<button type="button" class="bm-cell en${d ? ' ok' : ''}${fb.selEn === k ? ' sel' : ''}" data-en="${k}" ${d || !play ? 'disabled' : ''} data-on-click='[["farmBeeMatch",["en",${k}]]]'>${escapeHTML(w.english)}<i class="bm-dot"></i></button>`; }).join('');
            let cnB = fb.cn.map((w, k) => { let d = fb.done.includes(w); return `<button type="button" class="bm-cell cn${d ? ' ok' : ''}${fb.selCn === k ? ' sel' : ''}" data-cn="${k}" ${d || !play ? 'disabled' : ''} data-on-click='[["farmBeeMatch",["cn",${k}]]]'><i class="bm-dot"></i>${escapeHTML(farmBeeCn(w))}</button>`; }).join('');
            body = `<div class="fw-ask">把英文和中文連起來（先點左邊，再點右邊）</div><div class="bm-grid" id="bmGrid"><svg class="bm-lines" id="bmLines" aria-hidden="true"></svg><div class="bm-col">${enB}</div><div class="bm-col">${cnB}</div></div>`;
        } else if (fb.type === 'odd') {
            body = `<div class="fw-ask">下面哪一個，<b>不是</b>這三個單字的意思？</div>
                <div class="fw-words">${fb.ws.map(w => `<span>${escapeHTML(w.english)}</span>`).join('')}</div>
                <div class="fw-opts">${fb.opts.map((o, k) => `<button type="button" class="fw-opt${fb.sel === k ? ' sel' : ''}${!play && o === farmBeeCn(fb.odd) ? ' right' : ''}" ${play ? '' : 'disabled'} data-on-click='[["farmBeeSel",[${k}]]]'>${escapeHTML(o)}</button>`).join('')}</div>`;
            canSubmit = fb.sel !== null;
        } else {
            let wd = fb.w.english;
            body = `<div class="fw-ask">聽發音，拼出單字，再選出中文意思</div>
                <button type="button" class="fw-listen big" aria-label="再聽一次" data-on-click='[["farmSay",[${JSON.stringify(wd).replace(/'/g, '&#39;')}]]]'>${FW_SPEAKER}<span>再聽一次</span></button>
                <div class="fw-guide">
                    <div class="fw-guide-row"><span class="fw-guide-k">英文</span><label class="fw-dict"><span class="fw-boxes" id="fwDictBoxes" style="--bx:${farmBoxSize(wd)}px">${farmDictBoxes(wd, fb.typed, !play)}</span>
                    <input class="fw-dict-in" id="fwDictIn" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done" maxlength="${farmLetters(wd).length}" value="${escapeHTML(fb.typed)}" ${play ? '' : 'disabled'} aria-label="輸入聽到的單字" data-on-input='[["farmBeeDictInput",["$value"]]]'></label></div>
                    <div class="fw-guide-row"><span class="fw-guide-k">中文</span><span class="fw-boxes cn" style="--bx:${farmBoxSize(wd)}px">${farmCnBoxes(farmBeeCn(fb.w), fb.sel !== null ? fb.opts[fb.sel] : '', !play)}</span></div>
                </div>
                <div class="fw-dict-hint">英文 ${farmLetters(wd).length} 個字母・中文從下面選</div>
                <div class="fw-opts">${fb.opts.map((o, k) => `<button type="button" class="fw-opt${fb.sel === k ? ' sel' : ''}${!play && o === farmBeeCn(fb.w) ? ' right' : ''}" ${play ? '' : 'disabled'} data-on-click='[["farmBeeSel",[${k}]]]'>${escapeHTML(o)}</button>`).join('')}</div>`;
            canSubmit = fb.sel !== null && fb.typed.length === farmLetters(wd).length;
        }
        let msg = fb.msg ? `<div class="fw-fb ${fb.state === 'win' ? 'ok' : fb.state === 'lose' ? 'bad' : 'warn'}">${fb.msg}</div>` : '';
        let foot = !play ? `<button type="button" class="fm-big" data-on-click='[["farmBeeExit",[]]]'>回農場</button>`
            : fb.type === 'match' ? '' : `<button type="button" class="fm-big" id="fwSubmit" ${canSubmit ? '' : 'disabled'} data-on-click='[["farmBeeSubmit",[]]]'>送出</button>`;
        box.innerHTML = `<div class="fw-head"><button type="button" class="fm-sq" aria-label="回農場" data-on-click='[["farmBeeQuit",[]]]'><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2E2650" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5 L8 12 L15 19"/></svg></button><b>蜜蜂採蜜</b>${hearts}</div>
            <div class="fw-card bee"><div class="fw-art"><span class="bee-art">${FARM_HIVE_SVG}</span></div><span class="fw-pill">${['連連看', '找出不是的意思', '聽寫'][['match', 'odd', 'dict'].indexOf(fb.type)]}・答對就能採蜜</span></div>
            ${body}${msg}<div class="fw-foot">${foot}</div>`;
        box.classList.add('bee-mode');
        if (fb.type === 'match') requestAnimationFrame(farmBeeLines);
    }
    // 連連看：配對成功的英文、中文之間畫一條線
    function farmBeeLines() {
        let g = document.getElementById('bmGrid'), svg = document.getElementById('bmLines');
        if (!g || !svg || !fb || fb.type !== 'match') return;
        let gr = g.getBoundingClientRect();
        svg.setAttribute('viewBox', `0 0 ${gr.width.toFixed(2)} ${gr.height.toFixed(2)}`);
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.innerHTML = fb.done.map(w => {
            let a = g.querySelector(`[data-en="${fb.en.indexOf(w)}"]`), b = g.querySelector(`[data-cn="${fb.cn.indexOf(w)}"]`);
            if (!a || !b) return '';
            // 線的兩端對齊卡片上的圓點中心
            let da = a.querySelector('.bm-dot') || a, db = b.querySelector('.bm-dot') || b;
            let ra = da.getBoundingClientRect(), rb = db.getBoundingClientRect();
            let x1 = ra.left + ra.width / 2 - gr.left, y1 = ra.top + ra.height / 2 - gr.top, x2 = rb.left + rb.width / 2 - gr.left, y2 = rb.top + rb.height / 2 - gr.top;
            return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#22C55E" stroke-width="4" stroke-linecap="round"/>`;
        }).join('');
    }
    function farmBeeMatch(side, k) {
        if (!fb || fb.state !== 'play' || fb.type !== 'match') return;
        if (side === 'en') fb.selEn = fb.selEn === k ? null : k; else fb.selCn = fb.selCn === k ? null : k;
        if (fb.selEn !== null && fb.selCn !== null) {
            let a = fb.en[fb.selEn], b = fb.cn[fb.selCn];
            if (a === b) { fb.done.push(a); fb.msg = ''; }
            else { fb.tries -= 1; fb.msg = fb.tries > 0 ? `連錯了：${escapeHTML(a.english)} 不是「${escapeHTML(farmBeeCn(b))}」，還有 ${fb.tries} 次機會` : ''; }
            fb.selEn = null; fb.selCn = null;
            if (fb.done.length === fb.ws.length) return farmBeeEnd(true);
            if (fb.tries <= 0) return farmBeeEnd(false);
        }
        farmRenderBee();
    }
    function farmBeeSel(k) { if (!fb || fb.state !== 'play') return; fb.sel = parseInt(k); farmRenderBee(); }
    function farmBeeDictInput(v) {
        if (!fb || fb.state !== 'play' || fb.type !== 'dict') return;
        let max = farmLetters(fb.w.english).length, clean = String(v || '').replace(/[^A-Za-z]/g, '').slice(0, max);
        fb.typed = clean;
        let el = document.getElementById('fwDictIn'); if (el && el.value !== clean) el.value = clean;
        let bx = document.getElementById('fwDictBoxes'); if (bx) bx.innerHTML = farmDictBoxes(fb.w.english, clean, false);
        let b = document.getElementById('fwSubmit'); if (b) b.disabled = !(fb.sel !== null && clean.length === max);
    }
    function farmBeeSubmit() {
        if (!fb || fb.state !== 'play') return;
        let ok;
        if (fb.type === 'odd') { if (fb.sel === null) return; ok = fb.opts[fb.sel] === farmBeeCn(fb.odd); }
        else { if (fb.sel === null) return; ok = fb.typed.toLowerCase() === farmLetters(fb.w.english).join('').toLowerCase() && fb.opts[fb.sel] === farmBeeCn(fb.w); }
        if (ok) return farmBeeEnd(true);
        fb.tries -= 1;
        if (fb.tries <= 0) return farmBeeEnd(false);
        fb.sel = null; fb.msg = `答錯了，還有 ${fb.tries} 次機會`;
        if (fb.type === 'dict') { fb.typed = ''; farmSay(fb.w.english); }
        farmRenderBee();
    }
    async function farmBeeEnd(win) {
        fb.state = win ? 'win' : 'lose';
        let ans = fb.type === 'match' ? '' : fb.type === 'odd' ? `正確答案：「${escapeHTML(farmBeeCn(fb.odd))}」不是 ${fb.ws.map(w => escapeHTML(w.english)).join('、')} 的意思`
            : `正確答案：${escapeHTML(fb.w.english)} ${escapeHTML(farmBeeCn(fb.w))}`;
        fb.msg = win ? '🍯 採蜜成功！經驗 +3、花 +1' : `採蜜失敗，這次的蜂蜜飛走了（蜂蜜歸 0，不會扣東西）${ans ? '<br><small>' + ans + '</small>' : ''}`;
        // 結果寫進農場（連得到後台就由後台記錄）
        let saved = false;
        if (farmSrv === true) saved = !!(await farmCall('honey', { ok: !!win }));
        if (!saved) {
            // 沒連到後台、或後台回錯誤：這台裝置也要把這次採蜜用掉（不能再挑戰同一罐蜂蜜）
            if (win && farmSrv !== true) { farm.xp += 3; farm.flowers += 1; }
            farm.honey = 0; farm.honeyAt = farmNow(); farm.beeStep = (farm.beeStep + 1) % 3;
            farmSave();
        }
        if (!win) {
            let ws = fb.type === 'match' ? fb.ws.filter(w => !fb.done.includes(w)) : fb.type === 'odd' ? fb.ws.concat([fb.odd]) : [fb.w];
            ws.forEach(w => farmNoteMiss(w.english));
        }
        if (win) try { triggerTaskCheck('farm_care'); } catch (e) {}
        farmRenderBee();
    }
    function farmBeeExit() { fb = null; goToFarmPage(); }
    function farmBeeQuit() {
        if (fb && fb.state === 'play' && !confirm('現在離開，這次採蜜就算失敗（蜂蜜歸 0）。要離開嗎？')) return;
        if (fb && fb.state === 'play') { farmBeeEnd(false).then(() => { fb = null; goToFarmPage(); }); return; }
        fb = null; goToFarmPage();
    }

    // 只有登記在 INLINE_ACTIONS 的函式能被呼叫（白名單）
    // ═════════════════════════════════════════════════════════════
    // ═════════════════════════════════════════════════════════════
    // 🐣 新手教學：只在第一次打開 App 出現（開發者密碼 newplayer：下次打開再跑一次）
    //   ① 歡迎頁 → ② 題庫 ③ 練習 ④ 測驗 ⑤ 樂園（遮罩介紹底部分頁）→ ⑥ 打開「我的單字」放第一個字
    //   chicky_onboard_done：'1' 看完或略過、'old' 更新前就在用的玩家、'pending' 開始了但還沒看完（下次再跑）
    // ═════════════════════════════════════════════════════════════
    const OB_DONE_KEY = 'chicky_onboard_done', OB_FORCE_KEY = 'chicky_onboard_force';
    const OB_ICONS = {
        lists: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#6366F1" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M8 7h7"/></svg>',
        practice: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#6366F1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 12h8"/><rect x="5" y="6.5" width="3" height="11" rx="1"/><rect x="16" y="6.5" width="3" height="11" rx="1"/><rect x="2" y="9" width="3" height="6" rx="1"/><rect x="19" y="9" width="3" height="6" rx="1"/></svg>',
        exam: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#6366F1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16.5 3.5a2.1 2.1 0 013 3L8 18l-4 1 1-4z"/><path d="M14.5 5.5l4 4"/></svg>',
        fun: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#6366F1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="10" r="6.5"/><path d="M12 10L7.4 5.4M12 10l4.6-4.6M12 10l-4.6 4.6M12 10l4.6 4.6"/><path d="M8.5 21L12 10l3.5 11"/><path d="M5.5 21h13"/><circle cx="12" cy="3.5" r="1.2" fill="#6366F1"/><circle cx="18.5" cy="10" r="1.2" fill="#6366F1"/><circle cx="5.5" cy="10" r="1.2" fill="#6366F1"/></svg>'
    };
    const OB_STEPS = [
        { tab: 'lists', title: '題庫', text: '第一步：把想背的單字放進來，一行一個字。沒有的話，也可以直接用精選單字庫。' },
        { tab: 'practice', title: '練習', text: '用聽力、字卡、朗讀練你的單字，每天幾分鐘就好。' },
        { tab: 'exam', title: '測驗', text: '練得差不多了就考考看，常錯的字會幫你記下來。' },
        { tab: 'fun', title: '樂園', text: '玩大冒險和農場，一邊玩一邊複習，每天都想回來。' }
    ];
    let obStepNow = -1;
    function obShouldRun() {
        try {
            if (localStorage.getItem(OB_FORCE_KEY) === '1') return true;
            let v = localStorage.getItem(OB_DONE_KEY);
            if (v === 'pending') return true;
            if (v) return false;
            if (OB_FIRST_RUN) { localStorage.setItem(OB_DONE_KEY, 'pending'); return true; }
            localStorage.setItem(OB_DONE_KEY, 'old');        // 更新前就在用的玩家：不跳教學
            return false;
        } catch (e) { return false; }
    }
    function obDots(k) { return `<span class="ob-dots" aria-hidden="true">${[0, 1, 2, 3, 4].map(i => `<i class="${i === k ? 'on' : ''}"></i>`).join('')}</span>`; }
    function obNugget() {
        return `<svg role="img" aria-label="雞塊揮手打招呼" style="position:absolute;left:228px;top:38px" width="120" height="94" viewBox="0 14 128 100">
            <path d="M 22 70 Q 10 72 6 84" stroke="#231F20" stroke-width="5.5" stroke-linecap="round" fill="none"/>
            <path d="M 97 50 Q 112 44 114 26" stroke="#231F20" stroke-width="5.5" stroke-linecap="round" fill="none"/>
            <path d="M 121 18 Q 126 23 124 31" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" fill="none" opacity="0.7"/>
            <path d="M 48 99 L 44 110 L 36 110 M 72 99 L 76 110 L 84 110" stroke="#231F20" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
            <ellipse cx="60" cy="62" rx="38" ry="40" fill="#F4A236" stroke="#231F20" stroke-width="5"/>
            <circle cx="30" cy="76" r="3.5" fill="#E2861E"/><circle cx="58" cy="90" r="3" fill="#E2861E"/><circle cx="86" cy="80" r="3" fill="#E2861E"/>
            <ellipse cx="38" cy="66" rx="7" ry="5" fill="#F87171"/><ellipse cx="82" cy="66" rx="7" ry="5" fill="#F87171"/>
            <circle cx="48" cy="56" r="4.2" fill="#231F20"/><circle cx="72" cy="56" r="4.2" fill="#231F20"/>
            <path d="M 54 65 Q 60 72 66 65" stroke="#231F20" stroke-width="4" stroke-linecap="round" fill="none"/></svg>`;
    }
    function obClear() {
        ['obWelcome', 'obMask'].forEach(id => { let el = document.getElementById(id); if (el) el.remove(); });
        document.documentElement.style.overflow = '';
        window.removeEventListener('resize', obPlace);
    }
    // ① 歡迎頁
    function obStart() {
        obClear();
        obStepNow = 0;
        if (document.getElementById('homeDashboardView') && !document.getElementById('homeDashboardView').classList.contains('active')) setHomeTab('practice');
        let star = (x, y, s, c, o) => `<svg aria-hidden="true" style="position:absolute;${x};${y}" width="${s}" height="${s}" viewBox="0 0 24 24"><path d="M12 2l2.2 6.8L21 11l-6.8 2.2L12 20l-2.2-6.8L3 11l6.8-2.2z" fill="${c}"${o ? ` opacity="${o}"` : ''}/></svg>`;
        document.body.insertAdjacentHTML('beforeend', `<div id="obWelcome" role="dialog" aria-modal="true" aria-label="歡迎來到 Chicky Vocab"><div class="ob-w">
            <div class="ob-top">
                <button type="button" class="ob-skip" data-ob="skip">略過</button>
                <div class="ob-art">
                    <div class="ob-circle" aria-hidden="true" style="width:260px;height:260px;left:-80px;bottom:-120px"></div>
                    <div class="ob-circle" aria-hidden="true" style="width:140px;height:140px;right:-40px;top:24px"></div>
                    ${star('left:44px', 'top:78px', 16, '#FFD27A')}${star('right:50px', 'bottom:66px', 12, '#FFFFFF', .8)}
                    <div class="ob-card" aria-hidden="true" style="left:82px;top:112px;background:#A5B4FC;transform:rotate(8deg)"></div>
                    <div class="ob-card" aria-hidden="true" style="left:76px;top:106px;background:#E0E7FF;transform:rotate(3deg)"></div>
                    <div class="ob-card main">
                        <div style="display:flex;justify-content:space-between;align-items:center"><span class="chip">我的單字</span><span class="spk"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6366F1" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg></span></div>
                        <div class="en">meeting</div><div class="cn">會議</div>
                    </div>
                    ${obNugget()}
                </div>
            </div>
            <div class="ob-body">
                <h1>歡迎來到 Chicky Vocab！</h1>
                <div class="ob-feat"><span class="ic" style="background:#EEF0FF"><svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6366F1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 21V5"/><path d="M9 8h6M9 12h4"/></svg></span><div><b>背你自己的單字</b><span>用聽力、字卡、朗讀來練</span></div></div>
                <div class="ob-feat"><span class="ic" style="background:#FFE9C7"><svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#B45309" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="11" rx="5"/><path d="M7 11v3M5.5 12.5h3"/><circle cx="16" cy="11.5" r="0.8" fill="#B45309"/><circle cx="18" cy="13.5" r="0.8" fill="#B45309"/></svg></span><div><b>玩遊戲，天天複習</b><span>大冒險打怪、農場種花</span></div></div>
                <div class="ob-foot">${obDots(0)}<button type="button" class="ob-go" data-ob="next">看看怎麼用</button></div>
            </div>
        </div></div>`);
        document.documentElement.style.overflow = 'hidden';
        let w = document.getElementById('obWelcome');
        w.addEventListener('click', ev => {
            let b = ev.target.closest('[data-ob]');
            if (!b) return;
            if (b.getAttribute('data-ob') === 'skip') obFinish(false);
            else obGo(0);
        });
        setTimeout(() => { try { w.querySelector('.ob-go').focus({ preventScroll: true }); } catch (e) {} }, 50);
    }
    // ②～⑤ 遮罩：把整個畫面蓋暗，只留下要介紹的底部分頁，旁邊放一個固定大小的白框
    function obGo(k) {
        obClear();
        obStepNow = k + 1;
        let st = OB_STEPS[k];
        setHomeTab(st.tab);
        window.scrollTo(0, 0);
        document.documentElement.style.overflow = 'hidden';
        let last = k === OB_STEPS.length - 1;
        document.body.insertAdjacentHTML('beforeend', `<div id="obMask" role="dialog" aria-modal="true" aria-label="新手教學：${st.title}">
            <div class="ob-catch"></div><div class="ob-hole"></div>
            <div class="ob-tip"><div class="ob-tip-h">${OB_ICONS[st.tab]}${st.title}</div><p>${st.text}</p>
                <div class="ob-tip-f">${obDots(k + 1)}<button type="button" class="ob-next">${last ? '開始使用' : '下一步'}</button></div></div>
        </div>`);
        let m = document.getElementById('obMask');
        m.querySelector('.ob-next').addEventListener('click', () => { if (last) obFinish(true); else obGo(k + 1); });
        window.addEventListener('resize', obPlace);
        requestAnimationFrame(() => requestAnimationFrame(obPlace));
        setTimeout(obPlace, 250);
        setTimeout(() => { try { m.querySelector('.ob-next').focus({ preventScroll: true }); } catch (e) {} }, 60);
    }
    function obPlace() {
        let m = document.getElementById('obMask');
        if (!m || obStepNow < 1) return;
        let st = OB_STEPS[obStepNow - 1];
        let tab = document.querySelector(`#acTabs .ac-tab[data-tab="${st.tab}"]`);
        let hole = m.querySelector('.ob-hole'), tip = m.querySelector('.ob-tip');
        let vw = window.innerWidth, vh = window.innerHeight;
        let r = tab && tab.offsetParent !== null ? tab.getBoundingClientRect() : null;
        if (!r || !r.width) {               // 找不到分頁列：白框放在畫面中間
            hole.style.cssText = 'left:50%;top:50%;width:0;height:0';
            tip.className = 'ob-tip';
            tip.style.left = Math.max(16, (vw - tip.offsetWidth) / 2) + 'px';
            tip.style.top = Math.max(16, (vh - tip.offsetHeight) / 2) + 'px';
            return;
        }
        let pad = 4;
        hole.style.left = (r.left - pad) + 'px'; hole.style.top = (r.top - pad) + 'px';
        hole.style.width = (r.width + pad * 2) + 'px'; hole.style.height = (r.height + pad * 2) + 'px';
        let tw = tip.offsetWidth, th = tip.offsetHeight, cx = r.left + r.width / 2;
        let left = Math.min(Math.max(16, cx - tw / 2), vw - tw - 16);
        let below = r.top + r.height / 2 < vh / 2;          // 分頁列在上面（電腦）→ 白框放下面
        tip.className = 'ob-tip ' + (below ? 'down' : 'up');
        tip.style.left = left + 'px';
        tip.style.top = (below ? r.bottom + pad + 14 : r.top - pad - 14 - th) + 'px';
        tip.style.setProperty('--ax', Math.min(Math.max(24, cx - left), tw - 24) + 'px');
    }
    // ⑥ 看完（或略過）：記下來，下次不再出現；按「開始使用」會直接打開題庫放第一個字
    function obFinish(openEditor) {
        obClear();
        obStepNow = -1;
        try { localStorage.setItem(OB_DONE_KEY, '1'); localStorage.removeItem(OB_FORCE_KEY); } catch (e) {}
        if (!openEditor) { setHomeTab('practice'); return; }
        let cur = getLearningLanguage();
        let mine = wordLists.map((l, idx) => ({ l, idx })).filter(x => !isPackList(x.l) && getListLang(x.l) === cur);
        let pick = mine.find(x => x.l.title === '我的單字') || mine[0];
        listSeg = 'custom';
        if (!pick) { goToEditorPage(); return; }
        initEditorListCards();
        openEditorDetail(pick.idx);
        window.scrollTo(0, 0);
        setTimeout(obShowCoach, 120);
    }
    function obShowCoach() {
        let box = document.getElementById('weToAdd');          // 新版建立單字頁：指向「新增一列」
        if (!box || !box.offsetParent) return;
        let old = document.getElementById('obCoach'); if (old) old.remove();
        let r = box.getBoundingClientRect();
        document.body.insertAdjacentHTML('beforeend', `<div id="obCoach" role="note">
            <button type="button" class="ob-x" aria-label="關閉提示">✕</button>
            <b>✍️ 先放一個你想背的字吧</b>
            <p>按「新增一列」填上英文和中文，例如「meeting 會議」；一次很多個就用「批次貼上」。存好之後到「練習」就能開始練。</p>
            <button type="button" class="ob-pk">不想打字？先用精選單字庫 ›</button></div>`);
        let c = document.getElementById('obCoach');
        c.style.left = Math.max(16, r.left + window.scrollX - 8) + 'px';
        c.style.top = (r.bottom + window.scrollY + 12) + 'px';
        let ta = null;
        let close = () => { c.remove(); if (ta) ta.removeEventListener('input', close); document.removeEventListener('click', away, true); };
        let away = ev => {
            if (!document.getElementById('obCoach')) return;
            if (ev.target.closest('#obCoach')) return;
            close();
        };
        c.querySelector('.ob-x').addEventListener('click', close);
        c.querySelector('.ob-pk').addEventListener('click', () => { close(); listSeg = 'pack'; goToEditorPage(); });
        if (ta) ta.addEventListener('input', close);
        setTimeout(() => document.addEventListener('click', away, true), 0);
        let watch = setInterval(() => {            // 離開題庫編輯頁就收起來
            if (!document.getElementById('obCoach')) { clearInterval(watch); return; }
            if (!document.getElementById('editorDetailView').classList.contains('active')) { clearInterval(watch); close(); }
        }, 500);
    }
    setTimeout(() => { try { if (obShouldRun()) obStart(); } catch (e) { console.warn('新手教學啟動失敗', e); } }, 400);

    const INLINE_ACTIONS = {
        copyAppUrl,
        lpBack, lpTogglePause, advDoReplace, advLvTap, advAllocAdd, advAllocCancel, advAllocOk, cpResume, cpStartNew, cpStartNewFlash, cpStartNewSpeak, leaveSpeakPractice, playSpeakMyRecording, cpConfirmClose, cpConfirmBg, cpConfirmOk, fcFlip,
        playSpeakPracticeSample,
        toggleAdvCard, advToggleMove, advMapStep, advOpenGearSlot, advOpenHit, advCloseHit, advBagUnselect, advSetStatsTab, advFocusMove, advSetBagFilter, advBagTap, advBagUseTicket, advBagWipe, advWipeFrom, advWipeApply, advBuyWipe, advSetMoveFilter, advToggleEquip, advUseBoba, advToggleMoreMoves, advNextLevel, advCloseReward, advOpenBag, advCloseBag, advBagSauce, advBagBack, advBagUseSauce, advBagUsePotion, advBuyPotion, advBuyMove, advWeeklyExchange, setShopTab, advStartBattle, advChooseMove, advAnswerCard, advSpeedTap, advSpeedDone, advSubmitListen, advSubmitCn, advAnswerListen, advReplayListen, advCnMicTap, advConflictUse, advGiveUpSpeak,
        advSetMode, advOpenWords, advSayWord, advPracticeLevel, advWrongPick, advWrongPractice,
        advOpenSauce, advQuit, advRetry, advRedeemStamps, advBackToMenu, advBackToLevel, goToAdvLevel, goToAdvStats, advOpenStatInfo, advMoveStep, advUpgrade, advExchangeShards,
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
        claimChickenReward, claimAllChickenRewards, dtBackdrop,
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
        setHomeTab, goDoTask, histSetType, histOpenDetail, histToggleWrong, histOpenSave, histToggleSel, histSelectAll, histSaveWords, historyBack, setListSeg, setPickSeg, pickSelectAll, handleEditorSearch, clearEditorSearch, jumpToEditorLine, toggleEditorSort, togglePackStar,
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
        advSetShopFilter, advBuySoda, advBuyBoba, advBuyCoaster, advRunTestCodeInput,
        goToFarmPage, farmBack, farmTapPlot, farmEditStart, farmEditDone, farmPickSlot, farmCloseSheet, farmChooseDecor,
        farmOpenPlant, farmSetPlantList, farmLearn, farmLearnClose, farmSay, farmPlantNow,
        farmStartWater, farmTF, farmOdd, farmPick, farmUnpick, farmSubmit, farmNextTask, farmWaterQuit,
        farmDictInput, farmDictKey, farmOpenBee, farmCloseBee, farmStartBee, farmBeeMatch, farmBeeSel, farmBeeDictInput, farmBeeSubmit, farmBeeExit, farmBeeQuit,
        farmOpenShop, farmCloseShop, farmBuyItem, advUseFlowerItem,
        stModalClose, stModalBg,
        crBack, crRetry, crNext, crContinue, crReviewPick, crReview, faCloseSheet, faGoLevel, quitCardExam
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
