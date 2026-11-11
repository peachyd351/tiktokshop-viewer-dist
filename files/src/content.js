// Content script trên tiktok.com: gắn nút ▶ vào từng clip trong lưới, nút nổi
// ở trang video, và gom link clip cho side panel.

(() => {
  const VIDEO_RE = /\/(?:video|photo)\/(\d{15,21})/;
  const MARK = "data-tts-viewer";

  function play(url) {
    chrome.runtime.sendMessage({ type: "openPlayer", input: url }, (res) => {
      if (chrome.runtime.lastError) return toast("Extension vừa cập nhật, hãy tải lại trang");
      if (!res?.ok) toast(res?.error || "Không mở được clip");
    });
  }

  function toast(text) {
    const el = document.createElement("div");
    el.className = "tts-toast";
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  function makeButton(url, extraClass) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `tts-btn ${extraClass}`;
    btn.title = "Xem clip bằng TTS Viewer";
    btn.textContent = "▶";
    btn.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        play(url);
      },
      true,
    );
    return btn;
  }

  // Nút nhỏ trên từng ô clip của lưới (trang kênh, hashtag, tìm kiếm...).
  function decorateLinks() {
    for (const a of document.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]')) {
      if (a.hasAttribute(MARK) || !VIDEO_RE.test(a.href)) continue;
      a.setAttribute(MARK, "1");
      if (!a.querySelector("img, picture, video")) continue; // bỏ link chữ
      if (getComputedStyle(a).position === "static") a.style.position = "relative";
      a.appendChild(makeButton(a.href, "tts-btn-grid"));
      // Rê chuột vào ô clip ~0,25 giây: lấy link và nạp trước video, bấm mở là clip Shop phát ngay.
      let timer = 0;
      a.addEventListener("mouseenter", () => (timer = setTimeout(() => warmUp(a.href, true), 250)));
      a.addEventListener("mouseleave", () => clearTimeout(timer));
      gridSeen.observe(a);
    }
  }

  const prefetched = new Set();
  function prefetch(url, urgent) {
    const id = url.match(VIDEO_RE)?.[1];
    if (!id || prefetched.has(id)) return;
    prefetched.add(id);
    chrome.runtime.sendMessage({ type: "prefetch", input: url.split("?")[0], urgent }, () => void chrome.runtime.lastError);
  }

  // Ô clip hiện trên màn hình ~0,6 giây: lấy sẵn link (ưu tiên thấp, TikWM 1 lần/giây).
  const gridTimers = new WeakMap();
  const gridSeen = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        clearTimeout(gridTimers.get(e.target));
        if (e.isIntersecting) gridTimers.set(e.target, setTimeout(() => prefetch(e.target.href, false), 600));
      }
    },
    { threshold: 0.5 },
  );

  // Video nạp trước (chưa gắn vào trang): trình duyệt tải sẵn dữ liệu đầu clip, lúc mở chỉ việc gắn vào.
  const warm = new Map(); // id -> { video, res }
  const WARM_MAX = 4;
  async function warmUp(url, urgent) {
    const id = url.match(VIDEO_RE)?.[1];
    if (!id || warm.has(id) || !/\/video\//.test(url)) return;
    warm.set(id, null);
    const res = await ask({ type: "playable", input: url.split("?")[0], urgent });
    if (!res.ok || !res.src) return warm.delete(id);
    const video = document.createElement("video");
    Object.assign(video, { preload: "auto", playsInline: true, loop: true, controls: true, src: res.src });
    warm.set(id, { video, res });
    while (warm.size > WARM_MAX) {
      const [oldId, old] = warm.entries().next().value;
      old?.video.removeAttribute("src");
      warm.delete(oldId);
    }
  }

  function takeWarm(id) {
    const entry = warm.get(id);
    if (!entry) return null;
    warm.delete(id);
    return entry;
  }

  // Nút nổi khi đang mở một trang video.
  let floatingFor = "";
  function updateFloating() {
    const m = location.pathname.match(VIDEO_RE);
    const existing = document.querySelector(".tts-btn-float");
    if (!m) {
      existing?.remove();
      floatingFor = "";
      return;
    }
    if (floatingFor === m[1] && existing) return;
    existing?.remove();
    floatingFor = m[1];
    warmUp(location.href, true); // vừa mở clip: lấy link + nạp video ngay, không chờ nhận diện khung phát
    const btn = makeButton(location.href, "tts-btn-float");
    btn.textContent = "▶ Xem clip này";
    document.body.appendChild(btn);
  }

  function collectLinks() {
    const seen = new Map();
    const add = (href) => {
      const m = href && href.match(VIDEO_RE);
      if (m && !seen.has(m[1])) seen.set(m[1], href.split("?")[0]);
    };
    document.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]').forEach((a) => add(a.href));
    add(location.href);
    return [...seen.values()];
  }

  async function collectWithScroll(max) {
    let last = 0;
    let idle = 0;
    while (idle < 4) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await new Promise((r) => setTimeout(r, 1500));
      const n = collectLinks().length;
      if (n >= max) break;
      idle = n === last ? idle + 1 : 0;
      last = n;
    }
    return collectLinks().slice(0, max);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "collect") return false;
    if (!msg.scroll) {
      sendResponse({ ok: true, links: collectLinks() });
      return false;
    }
    collectWithScroll(msg.max || 500).then((links) => sendResponse({ ok: true, links }));
    return true;
  });

  // ---------- Tự phát clip bị chặn ngay trong feed / trang video ----------
  // page.js (MAIN world) gắn data-tts-blocked lên khung video TikTok không cấp link phát
  // (section của feed / trang video, hoặc khung chứa nút phát ở cửa sổ xem clip).

  const visible = new Set();
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const video = e.target.querySelector(".tts-inline video");
        if (e.isIntersecting && e.intersectionRatio >= 0.6) {
          visible.add(e.target);
          if (video) startPlayback(video);
        } else {
          visible.delete(e.target);
          video?.pause();
        }
      }
    },
    { threshold: [0, 0.6] },
  );

  function startPlayback(video) {
    if (!video.src) return;
    video.play().catch((err) => {
      if (err?.name !== "NotAllowedError") return;
      // Chưa có tương tác người dùng thì trình duyệt chỉ cho phát khi tắt tiếng.
      video.muted = true;
      video.play().catch(() => {});
      askForSound(video);
    });
  }

  // Lần chạm / gõ phím đầu tiên trên trang sẽ bật tiếng (sau đó trình duyệt cho phát có tiếng).
  function askForSound(video) {
    const box = video.closest(".tts-inline");
    if (!box || box.querySelector(".tts-inline-sound")) return;
    const badge = document.createElement("button");
    badge.type = "button";
    badge.className = "tts-inline-sound";
    badge.textContent = "🔇 Bấm để bật tiếng";
    box.appendChild(badge);
    const unmute = () => {
      document.removeEventListener("pointerdown", unmute, true);
      document.removeEventListener("keydown", unmute, true);
      badge.remove();
      if (!video.isConnected) return;
      video.muted = false;
      video.play().catch(() => (video.muted = true));
    };
    document.addEventListener("pointerdown", unmute, true);
    document.addEventListener("keydown", unmute, true);
  }

  // Ẩn player gốc của TikTok (không xoá vì React quản lý node này) và giữ nó im lặng.
  function hideNative(section) {
    for (const v of section.querySelectorAll("video")) {
      if (v.closest(".tts-inline")) continue;
      v.pause();
      v.muted = true;
      v.style.visibility = "hidden";
      v.dataset.ttsHidden = "1";
    }
  }

  function unmount(box) {
    const section = box.parentElement;
    const video = box.querySelector("video");
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load(); // dừng tải tiếp
    }
    box.remove();
    section?.classList.remove("tts-host-under");
    section?.querySelectorAll("video[data-tts-hidden]").forEach((v) => {
      v.style.visibility = "";
      delete v.dataset.ttsHidden;
    });
  }

  function ask(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: "Extension vừa cập nhật, hãy tải lại trang" });
        else resolve(res || { ok: false, error: "Không có phản hồi" });
      });
    });
  }

  const clipUrl = (section) => `https://www.tiktok.com/@${section.dataset.ttsAuthor || "i"}/video/${section.dataset.ttsId}`;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const num = (n) => Number(n || 0).toLocaleString("vi-VN");
  const short = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(".", ",")}Tr` : n >= 1e3 ? `${(n / 1e3).toFixed(1).replace(".", ",")}N` : String(n)).replace(",0", "");

  // Khối 4 dòng (Tên sản phẩm / ID / Link / Hashtag) để dán vào ô Thông tin sản phẩm của HIR-F.
  async function copyHirInfo(productId, clipId) {
    const res = await ask({ type: "hirInfo", productId, clipId });
    if (!res.ok) return toast(res.error || "Không tạo được thông tin");
    try {
      await navigator.clipboard.writeText(res.text);
      toast(res.missing.length ? `Đã copy, còn thiếu ${res.missing.join(", ")} — điền tay trong HIR-F` : "Đã copy thông tin sản phẩm cho HIR-F");
    } catch {
      toast("Trình duyệt chặn copy, hãy bấm lại");
    }
  }

  // Thẻ sản phẩm: số đã bán (tổng của sản phẩm, không riêng clip này), giá, đánh giá, tồn kho, shop.
  async function showProducts(box, section) {
    const refs = (section.dataset.ttsProducts || "").split(",").filter(Boolean).map((id) => ({ id }));
    const res = await ask({ type: "products", input: clipUrl(section), refs });
    if (box.dataset.id !== section.dataset.ttsId || !box.isConnected || !res.ok) return;
    const list = res.products.filter((p) => !p.error);
    if (!list.length) return;
    const sold = list.reduce((sum, p) => sum + p.sold, 0);
    const el = document.createElement("div");
    el.className = "tts-inline-product";
    el.innerHTML = `
      <button type="button" class="tts-inline-pill" title="Xem thông tin sản phẩm">🛒 <span>${esc(list[0].title)}</span> · Đã bán ${short(sold)}</button>
      <div class="tts-inline-card" hidden>
        ${list
          .map(
            (p) => `
          <div class="tts-inline-item">
            ${p.cover ? `<img src="${esc(p.cover)}" alt="" referrerpolicy="no-referrer" />` : ""}
            <div>
              <div class="tts-inline-ptitle">${esc(p.title)}</div>
              <div class="tts-inline-price">${esc(p.price)}${p.originalPrice ? ` <s>${esc(p.originalPrice)}</s>` : ""}</div>
              <div>Đã bán <b>${num(p.sold)}</b> · ★ ${String(p.rating).replace(".", ",")} (${num(p.reviews)} đánh giá) · Còn ${num(p.stock)}</div>
              <div>Shop: ${esc(p.shop)}${p.shopRating ? ` ★ ${String(p.shopRating).replace(".", ",")}` : ""}</div>
              <a href="${esc(p.url)}" target="_blank" rel="noopener">Mở trang sản phẩm ↗</a>
              <button type="button" class="tts-inline-hir" data-hir="${esc(p.id)}" title="Tên sản phẩm · ID · Link · Hashtag — dán vào ô Thông tin sản phẩm khi tạo job HIR-F">📋 Copy thông tin</button>
            </div>
          </div>`,
          )
          .join("")}
        <div class="tts-inline-note">Số đã bán là tổng của sản phẩm trên TikTok Shop, không riêng clip này.</div>
      </div>`;
    el.querySelector(".tts-inline-pill").addEventListener("click", () => {
      const card = el.querySelector(".tts-inline-card");
      card.hidden = !card.hidden;
    });
    for (const btn of el.querySelectorAll("[data-hir]")) btn.addEventListener("click", () => copyHirInfo(btn.dataset.hir, section.dataset.ttsId));
    box.appendChild(el);
  }

  async function mountInline(section) {
    const id = section.dataset.ttsId;
    let box = section.querySelector(":scope > .tts-inline");
    if (box?.dataset.id === id) return hideNative(section);
    if (box) unmount(box);

    box = document.createElement("div");
    box.className = "tts-inline";
    box.dataset.id = id;
    box.innerHTML = `
      <video playsinline loop controls preload="auto"></video>
      <div class="tts-inline-bar">
        <span class="tts-inline-tag">${section.dataset.ttsShop ? "🛒 Clip Shop" : "Clip bị chặn"} · TTS Viewer</span>
        <button type="button" data-act="dl" title="Tải không logo">⬇</button>
        <button type="button" data-act="pop" title="Mở trình phát riêng">⧉</button>
      </div>
      <div class="tts-inline-msg">Đang tải clip…</div>`;
    let video = box.querySelector("video");
    const warmed = takeWarm(id);
    if (warmed) {
      video.replaceWith(warmed.video);
      video = warmed.video;
    }
    if (section.dataset.ttsCover) video.poster = section.dataset.ttsCover;
    // Chặn click lan xuống TikTok (mở toàn màn hình / chuyển trang).
    for (const evt of ["click", "dblclick", "mousedown", "pointerdown"]) box.addEventListener(evt, (e) => e.stopPropagation());
    box.querySelector('[data-act="dl"]').addEventListener("click", () =>
      chrome.runtime.sendMessage({ type: "download", ids: [id], quality: "hd" }, (res) => toast(res?.ok ? "Đã bắt đầu tải" : res?.error || "Lỗi tải")),
    );
    box.querySelector('[data-act="pop"]').addEventListener("click", () => {
      video.pause();
      play(id);
    });
    if (getComputedStyle(section).position === "static") section.style.position = "relative";
    if (section.dataset.ttsUnder) {
      box.classList.add("tts-inline-under");
      section.classList.add("tts-host-under");
      section.prepend(box);
    } else {
      section.appendChild(box);
    }
    hideNative(section);
    io.observe(section);

    const res = warmed?.res || (await ask({ type: "playable", input: clipUrl(section), urgent: visible.has(section) || !!section.dataset.ttsUnder }));
    if (box.dataset.id !== section.dataset.ttsId || !box.isConnected) return; // đã cuộn sang clip khác
    const msg = box.querySelector(".tts-inline-msg");
    if (!res.ok || !res.src) {
      msg.textContent = res.error || "Không lấy được clip";
      return;
    }
    msg.remove();
    if (!warmed) video.src = res.src;
    video.onerror = () => {
      if (res.fallback && video.src !== res.fallback) video.src = res.fallback;
    };
    if (visible.has(section)) startPlayback(video);
    if (section.dataset.ttsShop || section.dataset.ttsProducts) showProducts(box, section);
  }

  function mountBlocked() {
    for (const section of document.querySelectorAll("[data-tts-blocked][data-tts-id]")) mountInline(section);
    // Khung đã được TikTok tái sử dụng cho clip phát được → gỡ lớp phủ.
    for (const box of document.querySelectorAll(".tts-inline")) {
      const section = box.parentElement;
      if (!section?.hasAttribute("data-tts-blocked") || section.dataset.ttsId !== box.dataset.id) unmount(box);
    }
  }

  new MutationObserver(mountBlocked).observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ["data-tts-blocked", "data-tts-id"],
  });

  const refresh = () => {
    decorateLinks();
    updateFloating();
    mountBlocked();
  };
  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      refresh();
    }, 400);
  }).observe(document.documentElement, { childList: true, subtree: true });
  refresh();
})();
