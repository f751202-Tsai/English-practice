/* r15：第一次打開 App 要跑新手教學 → 先用白色蓋住首頁，等教學畫面出來（避免先看到首頁一下子才跳教學）
   放在 <head> 最前面載入（不能寫成 inline script：網頁的 CSP 只允許同網域的 js 檔）；app.js 的 obBoot 會把 ob-wait 拿掉 */
try {
    var obD = localStorage.getItem('chicky_onboard_done');
    if (localStorage.getItem('chicky_onboard_force') === '1' || obD === 'pending' || (!obD && localStorage.getItem('dictation_word_lists') === null)) {
        document.documentElement.classList.add('ob-wait');
        setTimeout(function () { document.documentElement.classList.remove('ob-wait'); }, 6000);   // 保險：6 秒後一定拿掉
    }
} catch (e) {}
