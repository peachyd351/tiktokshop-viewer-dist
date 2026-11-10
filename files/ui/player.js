import { send, mediaUrl, fmtDate, esc, statsHtml, productsHtml, copyHirInfo } from "./common.js";

const $ = (id) => document.getElementById(id);
const id = new URLSearchParams(location.search).get("id");

async function main() {
  let res = await send({ type: "get", id });
  if (!res.clip) res = await send({ type: "resolve", input: id });
  if (!res.ok || !res.clip) {
    $("status").textContent = res.error || "Không tìm thấy clip";
    return;
  }
  const c = res.clip;
  document.title = `▶ ${c.author.uniqueId || "TikTok"} – ${c.title.slice(0, 40)}`;
  $("title").textContent = c.title || "(không có tiêu đề)";
  $("author").innerHTML = `@${esc(c.author.uniqueId)} · ${esc(c.author.nickname)} · ${fmtDate(c.created)}`;
  $("stats").innerHTML = statsHtml(c);
  $("products").innerHTML = productsHtml(c);
  let clip = c;
  $("hirBtn").hidden = !c.isShop;
  $("hirBtn").onclick = async () => ($("status").textContent = await copyHirInfo(clip));
  if (c.isShop && !c.productsAt) {
    send({ type: "products", input: c.id }).then((r) => {
      if (!r.ok) return;
      clip = r.clip;
      $("products").innerHTML = productsHtml(r.clip);
    });
  }

  if (c.images.length) {
    $("video").hidden = true;
    $("gallery").hidden = false;
    $("gallery").innerHTML = c.images.map((src) => `<img src="${esc(src)}" referrerpolicy="no-referrer" alt="" />`).join("");
  } else {
    const video = $("video");
    video.src = mediaUrl(c.id, "hd");
    video.onerror = () => {
      if (video.src.includes("/hdplay/")) video.src = mediaUrl(c.id, "sd");
      else $("status").textContent = "Không phát được clip này";
    };
  }

  const dl = async (quality) => {
    const r = await send({ type: "download", ids: [c.id], quality });
    $("status").textContent = r.ok ? "Đã bắt đầu tải vào Downloads/TikTokShop." : r.error;
  };
  $("dlBtn").onclick = () => dl("hd");
  $("dlWmBtn").onclick = () => dl("wm");
  $("openBtn").onclick = () => chrome.tabs.create({ url: c.url });
  $("copyBtn").onclick = async () => {
    await navigator.clipboard.writeText(c.url);
    $("status").textContent = "Đã sao chép link.";
  };
}

main();
