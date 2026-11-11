// Chạy trong MAIN world của tiktok.com: đọc React props của khung video để biết
// clip nào TikTok không cấp link phát (clip TikTok Shop), rồi đánh dấu bằng
// data-attribute cho content script (isolated world) xử lý.

(() => {
  const SELECTOR = 'section[data-e2e="feed-video"], section[class*="MediaCardContainer"]';
  // Cửa sổ xem clip mở từ lưới kênh / tìm kiếm: clip bị chặn không có <video> lẫn section,
  // chỉ có khung chứa nút phát; dữ liệu item nằm ở cột thông tin bên cạnh.
  const BROWSE_CONTROL = '[data-e2e="browse-video-play"], [data-e2e="browse-sound"]';

  function itemOf(el, depth = 20) {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    let fiber = key ? el[key] : null;
    for (let i = 0; fiber && i < depth; i++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (!props || typeof props !== "object") continue;
      const item = props.item;
      if (item && typeof item === "object" && item.id && item.video) return item;
    }
    return null;
  }

  function isBlocked(item) {
    if (item.imagePost || item.liveRoomInfo) return false;
    const v = item.video || {};
    return !v.playAddr && !(v.bitrateInfo && v.bitrateInfo.length);
  }

  // Mã sản phẩm nằm trong anchors loại 33 (1 sản phẩm) / 35 (bộ sản phẩm), trường extra là chuỗi JSON lồng nhau.
  // Đọc bằng regex trên chuỗi gốc: JSON.parse làm tròn số product_id 19 chữ số.
  function productIds(item) {
    const ids = new Set();
    for (const a of item.anchors || []) {
      if (![33, 35].includes(Number(a.type)) || typeof a.extra !== "string") continue;
      for (const m of a.extra.matchAll(/product_id\\*"\s*:\s*\\*"?(\d{15,25})/g)) ids.add(m[1]);
      if (!ids.size) for (const m of a.extra.matchAll(/"id"\s*:\s*"(\d{15,25})"/g)) ids.add(m[1]);
    }
    return [...ids].slice(0, 6);
  }

  function mark(el, item) {
    const id = String(item.id);
    if (el.dataset.ttsId === id) return; // TikTok tái sử dụng node khi cuộn, nên so theo id
    el.dataset.ttsId = id;
    el.dataset.ttsAuthor = (typeof item.author === "string" ? item.author : item.author?.uniqueId) || "";
    el.dataset.ttsShop = item.isECVideo ? "1" : "";
    el.dataset.ttsProducts = productIds(item).join(",");
    el.dataset.ttsCover = item.video?.cover || item.video?.originCover || "";
    if (isBlocked(item)) el.dataset.ttsBlocked = "1";
    else delete el.dataset.ttsBlocked;
  }

  function browseShell() {
    let el = document.querySelector(BROWSE_CONTROL);
    for (let i = 0; el && i < 4; i++, el = el.parentElement) {
      const r = el.getBoundingClientRect();
      if (r.width >= 200 && r.height >= 200) return el;
    }
    return null;
  }

  function scanBrowse() {
    const m = location.pathname.match(/\/(?:video|photo)\/(\d{15,21})/);
    const shell = m && browseShell();
    if (!shell || shell.dataset.ttsId === m[1] || shell.closest(SELECTOR) || shell.querySelector(SELECTOR)) return;
    for (const el of document.querySelectorAll("[data-e2e]")) {
      const item = itemOf(el, 30);
      if (item && String(item.id) === m[1]) {
        shell.dataset.ttsUnder = "1"; // lớp phát nằm dưới các nút đóng / chuyển clip của TikTok
        return mark(shell, item);
      }
    }
  }

  function scan() {
    for (const el of document.querySelectorAll(SELECTOR)) {
      const item = itemOf(el);
      if (item) mark(el, item);
    }
    scanBrowse();
  }

  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      scan();
    }, 150);
  }).observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
