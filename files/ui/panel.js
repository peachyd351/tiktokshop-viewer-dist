import { send, mediaUrl, fmtDate, fmtDuration, esc, statsHtml, productsHtml, copyHirInfo } from "./common.js";
import { buildXlsx } from "./xlsx.js";

const $ = (id) => document.getElementById(id);
const ID_RE = /\/(?:video|photo|v)\/(\d{15,21})/;

let clips = [];
const selected = new Set();
let playingId = "";
let running = false;
let cancelRequested = false;

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}

function idOf(input) {
  const s = String(input).trim();
  if (/^\d{15,21}$/.test(s)) return s;
  return s.match(ID_RE)?.[1] || null;
}

async function reload() {
  const res = await send({ type: "list" });
  clips = res.ok ? res.clips : [];
  for (const id of [...selected]) if (!clips.some((c) => c.id === id)) selected.delete(id);
  render();
}

function visibleClips() {
  const q = $("search").value.trim().toLowerCase();
  const filter = $("filter").value;
  const sort = $("sort").value;
  return clips
    .filter((c) => filter !== "shop" || c.isShop)
    .filter((c) => {
      if (!q) return true;
      const hay = [c.title, c.author.uniqueId, c.author.nickname, ...c.products.map((p) => p.title)].join(" ").toLowerCase();
      return hay.includes(q);
    })
    .sort((a, b) => (b[sort] || 0) - (a[sort] || 0));
}

function render() {
  const list = visibleClips();
  const shopCount = clips.filter((c) => c.isShop).length;
  $("summary").textContent = clips.length
    ? `${clips.length} clip · ${shopCount} có gắn sản phẩm · đang chọn ${selected.size}`
    : "";
  $("checkAll").checked = list.length > 0 && list.every((c) => selected.has(c.id));
  if (!list.length) {
    $("list").innerHTML = clips.length
      ? `<div class="empty">Không có clip khớp bộ lọc.</div>`
      : `<div class="empty">Chưa có clip nào.<br />Dán link ở trên, hoặc mở trang kênh / hashtag TikTok rồi bấm “Gom clip trên trang”.<br />Trên TikTok, bấm nút ▶ đỏ ở góc mỗi clip để xem ngay.</div>`;
    return;
  }
  $("list").innerHTML = list
    .map(
      (c) => `
    <div class="card${c.id === playingId ? " playing" : ""}" data-id="${c.id}">
      <input type="checkbox" data-act="check" ${selected.has(c.id) ? "checked" : ""} />
      <div class="thumb" data-act="play" title="Phát">
        ${c.cover ? `<img src="${esc(c.cover)}" loading="lazy" referrerpolicy="no-referrer" alt="" />` : ""}
        <span class="dur">${c.images.length ? `${c.images.length} ảnh` : fmtDuration(c.duration)}</span>
      </div>
      <div class="info">
        <div class="title">${esc(c.title) || '<span class="muted">(không có tiêu đề)</span>'}</div>
        <div class="author">@${esc(c.author.uniqueId)} · ${fmtDate(c.created)} ${c.isShop ? '<span class="badge">Shop</span>' : ""} ${c.isAd ? '<span class="badge">QC</span>' : ""}</div>
        <div class="stats">${statsHtml(c)}</div>
        <div class="chips">${productsHtml(c)}</div>
        <div class="row actions">
          <button data-act="play">▶ Xem</button>
          <button data-act="popup" title="Mở trình phát thu nhỏ">⧉</button>
          <button data-act="dl" title="Tải không logo">⬇</button>
          <button data-act="open" title="Mở trên TikTok">↗</button>
          <button data-act="copy" title="Sao chép link">📋</button>
          ${c.isShop ? '<button data-act="hir" title="Copy Tên sản phẩm · ID · Link · Hashtag để dán vào HIR-F">📦 HIR-F</button>' : ""}
        </div>
      </div>
    </div>`,
    )
    .join("");
}

function playInline(clip) {
  playingId = clip.id;
  if (clip.images.length) {
    send({ type: "openPlayer", input: clip.id }); // bài ảnh: xem trong cửa sổ trình phát
  } else {
    const video = $("video");
    video.src = mediaUrl(clip.id, "hd");
    video.onerror = () => {
      // Một số clip không có bản HD; lùi về bản thường.
      if (video.src.includes("/hdplay/")) video.src = mediaUrl(clip.id, "sd");
      else setStatus("Không phát được clip này", true);
    };
    $("inlinePlayer").classList.add("show");
    video.play().catch(() => {});
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  render();
}

function stopInline() {
  const video = $("video");
  video.pause();
  video.removeAttribute("src");
  video.load();
  $("inlinePlayer").classList.remove("show");
  playingId = "";
  render();
}

async function addInputs(inputs, { force = false } = {}) {
  if (running) return;
  const known = new Set(clips.map((c) => c.id));
  const todo = [];
  const seen = new Set();
  for (const raw of inputs) {
    const s = raw.trim();
    if (!s) continue;
    const id = idOf(s);
    const key = id || s;
    if (seen.has(key) || (!force && id && known.has(id))) continue;
    seen.add(key);
    todo.push(s);
  }
  if (!todo.length) return setStatus(inputs.length ? "Các clip này đã có trong danh sách." : "Không tìm thấy link clip nào.");

  running = true;
  cancelRequested = false;
  $("addBtn").textContent = "Dừng";
  let ok = 0;
  const errors = [];
  for (let i = 0; i < todo.length; i++) {
    if (cancelRequested) break;
    setStatus(`Đang lấy ${i + 1}/${todo.length}…`);
    const res = await send({ type: "resolve", input: todo[i], force });
    if (res.ok) {
      ok += 1;
      // Clip Shop: tra luôn số đã bán / giá / đánh giá của sản phẩm.
      if (res.clip.isShop && (force || !res.clip.productsAt)) {
        setStatus(`Đang lấy ${i + 1}/${todo.length}… (tra sản phẩm)`);
        const pr = await send({ type: "products", input: res.clip.id, force });
        if (!pr.ok) errors.push(`sản phẩm: ${pr.error}`);
      }
      if (i % 3 === 0 || i === todo.length - 1) await reload();
    } else errors.push(res.error);
  }
  running = false;
  $("addBtn").textContent = "Thêm link";
  await reload();
  const tail = errors.length ? ` · ${errors.length} lỗi (${errors[0]})` : "";
  setStatus(`${cancelRequested ? "Đã dừng. " : ""}Xong ${ok}/${todo.length} clip${tail}`, errors.length > 0 && ok === 0);
}

async function collect(scroll) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith("https://www.tiktok.com/")) return setStatus("Hãy mở một trang TikTok (kênh, hashtag, tìm kiếm…) ở tab hiện tại.", true);
  setStatus(scroll ? "Đang cuộn trang để gom clip… (có thể mất vài phút)" : "Đang gom clip…");
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "collect", scroll, max: 1000 });
    const links = res?.links || [];
    setStatus(`Tìm thấy ${links.length} clip trên trang.`);
    await addInputs(links);
  } catch {
    setStatus("Chưa kết nối được với trang TikTok — hãy tải lại tab đó (F5) rồi thử lại.", true);
  }
}

function selectedOrAll() {
  const list = visibleClips();
  const picked = list.filter((c) => selected.has(c.id));
  return picked.length ? picked : list;
}

async function download(quality) {
  const target = selectedOrAll();
  if (!target.length) return setStatus("Chưa có clip để tải.", true);
  setStatus(`Đang gửi ${target.length} clip vào trình tải của Chrome…`);
  const res = await send({ type: "download", ids: target.map((c) => c.id), quality });
  setStatus(res.ok ? `Đã bắt đầu tải ${res.count} file vào thư mục Downloads/TikTokShop.` : res.error, !res.ok);
}

function exportXlsx() {
  const target = selectedOrAll();
  if (!target.length) return setStatus("Chưa có clip để xuất.", true);
  const header = ["ID", "Link", "Tiêu đề", "Kênh", "Tên kênh", "Ngày đăng", "Thời lượng (giây)", "Lượt xem", "Thích", "Bình luận", "Chia sẻ", "Lưu", "Lượt tải", "Gắn sản phẩm", "Sản phẩm", "Giá", "Giá gốc", "Đã bán (tổng SP)", "Đánh giá", "Lượt đánh giá", "Tồn kho", "Shop", "Link sản phẩm"];
  // 1 sản phẩm: để số cho Excel tính được; nhiều sản phẩm: nối bằng " | ".
  const col = (c, key) => {
    const vals = c.products.map((p) => p[key] ?? "");
    if (vals.length === 1) return vals[0];
    return vals.some((v) => v !== "") ? vals.join(" | ") : "";
  };
  const rows = target.map((c) => [
    c.id,
    c.url,
    c.title,
    `@${c.author.uniqueId}`,
    c.author.nickname,
    fmtDate(c.created),
    c.duration,
    c.views,
    c.likes,
    c.comments,
    c.shares,
    c.saves,
    c.downloads,
    c.isShop ? "Có" : "",
    col(c, "title"),
    col(c, "price"),
    col(c, "originalPrice"),
    col(c, "sold"),
    col(c, "rating"),
    col(c, "reviews"),
    col(c, "stock"),
    col(c, "shop"),
    col(c, "url"),
  ]);
  const blob = buildXlsx([header, ...rows], { widths: [21, 50, 50, 20, 20, 12, 10, 12, 10, 10, 10, 10, 10, 8, 50, 15, 15, 14, 10, 12, 10, 24, 50] });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const d = new Date();
  a.download = `tiktokshop-clips_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  setStatus(`Đã xuất ${target.length} clip ra Excel.`);
}

// ---------- Sự kiện ----------

$("addBtn").addEventListener("click", async () => {
  if (running) {
    cancelRequested = true;
    return;
  }
  const lines = $("input").value.split(/[\s,]+/);
  await addInputs(lines);
  if (!running) $("input").value = "";
});
$("collectBtn").addEventListener("click", () => collect(false));
$("scrollBtn").addEventListener("click", () => collect(true));
$("closePlayer").addEventListener("click", stopInline);
$("dlBtn").addEventListener("click", () => download("hd"));
$("dlWmBtn").addEventListener("click", () => download("wm"));
$("csvBtn").addEventListener("click", exportXlsx);
$("refreshBtn").addEventListener("click", () => addInputs(selectedOrAll().map((c) => c.id), { force: true }));
$("removeBtn").addEventListener("click", async () => {
  const ids = selected.size ? [...selected] : null;
  if (!ids && !confirm("Xoá toàn bộ danh sách clip?")) return;
  await send(ids ? { type: "remove", ids } : { type: "clear" });
  selected.clear();
  await reload();
});
for (const id of ["sort", "filter", "search"]) $(id).addEventListener("input", render);
$("checkAll").addEventListener("change", (e) => {
  for (const c of visibleClips()) e.target.checked ? selected.add(c.id) : selected.delete(c.id);
  render();
});

$("list").addEventListener("click", async (e) => {
  const actEl = e.target.closest("[data-act]");
  const card = e.target.closest(".card");
  if (!actEl || !card) return;
  const clip = clips.find((c) => c.id === card.dataset.id);
  if (!clip) return;
  switch (actEl.dataset.act) {
    case "check":
      actEl.checked ? selected.add(clip.id) : selected.delete(clip.id);
      return render();
    case "play":
      return playInline(clip);
    case "popup":
      return send({ type: "openPlayer", input: clip.id });
    case "dl": {
      const res = await send({ type: "download", ids: [clip.id], quality: "hd" });
      return setStatus(res.ok ? "Đã bắt đầu tải." : res.error, !res.ok);
    }
    case "open":
      return chrome.tabs.create({ url: clip.url });
    case "copy":
      await navigator.clipboard.writeText(clip.url);
      return setStatus("Đã sao chép link.");
    case "hir":
      return setStatus(await copyHirInfo(clip));
  }
});

// Ảnh bìa hết hạn → lấy lại dữ liệu clip đó.
$("list").addEventListener(
  "error",
  async (e) => {
    if (e.target.tagName !== "IMG" || e.target.dataset.retried) return;
    e.target.dataset.retried = "1";
    const id = e.target.closest(".card")?.dataset.id;
    if (id && !running) {
      const res = await send({ type: "resolve", input: id, force: true });
      if (res.ok) e.target.src = res.clip.cover;
    }
  },
  true,
);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.clips && !running) reload();
});

// ---------- Cập nhật ----------

async function showUpdate() {
  $("version").textContent = chrome.runtime.getManifest().version;
  const res = await send({ type: "checkUpdate", force: true }); // mỗi lần mở side panel
  const update = res.ok ? res.update : null;
  $("updateBar").hidden = !update;
  if (update) $("updateText").textContent = `Có bản mới ${update.version}${update.notes ? ` — ${update.notes.split("\n")[0]}` : ""}`;
}
$("updateBtn").addEventListener("click", () => send({ type: "openUpdate" }));
$("version").addEventListener("click", () => send({ type: "openUpdate" }));
$("checkUpdateBtn").addEventListener("click", () => send({ type: "openUpdate" }));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.update) showUpdate();
});

showUpdate();
reload();
