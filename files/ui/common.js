// Tiện ích dùng chung cho side panel và trình phát.

export function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res || { ok: false, error: "Không có phản hồi" });
    });
  });
}

export function mediaUrl(id, quality = "hd") {
  const kind = quality === "wm" ? "wmplay" : quality === "sd" ? "play" : "hdplay";
  return `https://www.tikwm.com/video/media/${kind}/${id}.mp4`;
}

export function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return `${trim(n / 1e9)}T`;
  if (n >= 1e6) return `${trim(n / 1e6)}Tr`;
  if (n >= 1e3) return `${trim(n / 1e3)}N`;
  return String(n);
}

const trim = (v) => (v >= 100 ? v.toFixed(0) : v.toFixed(1)).replace(/\.0$/, "").replace(".", ",");

export function fmtDate(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export function fmtDuration(sec) {
  sec = Math.round(Number(sec) || 0);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function statsHtml(c) {
  return [
    ["👁", c.views, "Lượt xem"],
    ["♥", c.likes, "Lượt thích"],
    ["💬", c.comments, "Bình luận"],
    ["↗", c.shares, "Chia sẻ"],
    ["🔖", c.saves, "Lượt lưu"],
  ]
    .map(([icon, v, label]) => `<span title="${label}: ${Number(v).toLocaleString("vi-VN")}">${icon} ${fmtNum(v)}</span>`)
    .join("");
}

// sold / rating chỉ có sau khi tra trang sản phẩm (tin nhắn "products").
export function productsHtml(c) {
  if (!c.products?.length) return "";
  return c.products
    .map((p) => {
      const tip = [p.title, typeof p.sold === "number" && `Đã bán ${Number(p.sold).toLocaleString("vi-VN")} (tổng của sản phẩm)`, p.rating && `★ ${p.rating} · ${p.reviews} đánh giá`, typeof p.stock === "number" && `Còn ${p.stock}`, p.shop && `Shop: ${p.shop}`, p.error]
        .filter(Boolean)
        .join("\n");
      const extra = [p.price && esc(p.price), typeof p.sold === "number" && `đã bán ${fmtNum(p.sold)}`, p.rating && `★ ${String(p.rating).replace(".", ",")}`].filter(Boolean).join(" · ");
      const label = `🛒 ${esc(p.title || p.id)}${extra ? ` · ${extra}` : ""}`;
      return p.url ? `<a class="chip" href="${esc(p.url)}" target="_blank" title="${esc(tip)}">${label}</a>` : `<span class="chip" title="${esc(tip)}">${label}</span>`;
    })
    .join("");
}

// Copy khối Tên sản phẩm / ID / Link / Hashtag (sản phẩm đầu tiên của clip) để dán vào HIR-F.
export async function copyHirInfo(c) {
  const p = c.products?.find((x) => /^\d{6,}$/.test(x.id));
  if (!p) return "Clip này chưa có mã sản phẩm — bấm ↻ để tra lại.";
  const res = await send({ type: "hirInfo", productId: p.id, clipId: c.id });
  if (!res.ok) return res.error;
  await navigator.clipboard.writeText(res.text);
  return res.missing.length ? `Đã copy, còn thiếu ${res.missing.join(", ")} — điền tay trong HIR-F.` : "Đã copy thông tin sản phẩm cho HIR-F.";
}
