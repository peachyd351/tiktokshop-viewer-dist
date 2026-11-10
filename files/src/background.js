// Service worker: lấy dữ liệu clip qua TikWM (API mobile nên đọc được cả clip
// TikTok Shop mà web TikTok chặn), lưu cache, tải file và mở trình phát.

const TIKWM_API = "https://www.tikwm.com/api/";
const TIKWM_MEDIA = "https://www.tikwm.com/video/media";
const MIN_GAP_MS = 1150; // TikWM miễn phí: 1 request / giây
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const PLAY_URL_TTL_MS = 45 * 60 * 1000;

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener((details) => {
  checkUpdate().catch(() => {});
  // Sau khi tự cập nhật (runtime.reload), content script cũ trong các tab không còn nối được: tải lại tab TikTok.
  if (details.reason === "update") {
    chrome.tabs.query({ url: "https://www.tiktok.com/*" }, (tabs) => tabs.forEach((t) => chrome.tabs.reload(t.id).catch(() => {})));
  }
  chrome.contextMenus.create({
    id: "tts-play",
    title: "Xem clip bằng TTS Viewer",
    contexts: ["link", "page"],
    documentUrlPatterns: ["https://www.tiktok.com/*"],
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  const target = info.linkUrl || info.pageUrl;
  if (target) openPlayer(target).catch(() => {});
});

// ---------- Kiểm tra bản mới (repo phát hành công khai, xem build/release.py) ----------

const UPDATE_BASE = "https://raw.githubusercontent.com/peachyd351/tiktokshop-viewer-dist/main";
const UPDATE_EVERY_MIN = 180;

const newer = (a, b) => {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

async function checkUpdate() {
  const res = await fetch(`${UPDATE_BASE}/ban-moi.json?t=${Date.now()}`, { cache: "no-store", credentials: "omit" });
  if (!res.ok) throw new Error(`Không đọc được thông tin bản mới (HTTP ${res.status})`);
  const info = await res.json();
  const update = info.version && newer(info.version, chrome.runtime.getManifest().version)
    ? { version: info.version, base: `${UPDATE_BASE}/files`, files: info.files || [], notes: info.notes || "", date: info.date || "" }
    : null;
  await chrome.storage.local.set({ update });
  chrome.action.setBadgeText({ text: update ? "MỚI" : "" });
  if (update) chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
  return update;
}

// "Cập nhật.bat" chép file mới vào thư mục cài: Chrome đọc file từ ổ đĩa, nên manifest.json đọc lại
// được mang phiên bản mới → khởi động lại extension để nạp code mới.
async function diskVersion() {
  const res = await fetch(`${chrome.runtime.getURL("manifest.json")}?t=${Date.now()}`, { cache: "no-store" });
  return (await res.json()).version;
}

async function reloadIfUpdatedOnDisk() {
  if ((await diskVersion()) !== chrome.runtime.getManifest().version) chrome.runtime.reload();
}

chrome.runtime.onStartup.addListener(() => checkUpdate().catch(() => {}));
chrome.alarms.create("check-update", { delayInMinutes: 1, periodInMinutes: UPDATE_EVERY_MIN });
chrome.alarms.create("disk-version", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "check-update") checkUpdate().catch(() => {});
  if (alarm.name === "disk-version") reloadIfUpdatedOnDisk().catch(() => {});
});

// ---------- Nhận dạng link ----------

export function extractId(input) {
  const s = String(input || "").trim();
  if (/^\d{15,21}$/.test(s)) return s;
  const m = s.match(/\/(?:video|photo|v)\/(\d{15,21})/) || s.match(/[?&](?:item_id|share_item_id)=(\d{15,21})/);
  return m ? m[1] : null;
}

function toQueryUrl(input) {
  const s = String(input || "").trim();
  if (/^\d{15,21}$/.test(s)) return `https://www.tiktok.com/@i/video/${s}`;
  return s;
}

// ---------- Gọi TikWM có giãn cách ----------

// Hàng đợi 1 request/giây; urgent (clip đang hiện trên màn hình) chen lên đầu hàng.
const jobs = [];
let pumping = false;
let lastCall = 0;

function throttled(fn, urgent = false) {
  return new Promise((resolve, reject) => {
    jobs[urgent ? "unshift" : "push"]({ fn, resolve, reject });
    pump();
  });
}

async function pump() {
  if (pumping) return;
  pumping = true;
  while (jobs.length) {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    const job = jobs.shift();
    lastCall = Date.now();
    try {
      job.resolve(await job.fn());
    } catch (err) {
      job.reject(err);
    }
  }
  pumping = false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: ctrl.signal });
    return { status: res.status, text: await res.text() };
  } catch (err) {
    throw new Error(err?.name === "AbortError" ? "Hết thời gian chờ" : String(err?.message || err));
  } finally {
    clearTimeout(timer);
  }
}

// Trang "Just a moment…" của Cloudflare thay cho JSON.
const looksLikeChallenge = (text) => /<!doctype html|<html|just a moment|cf-browser-verification/i.test(String(text).slice(0, 400));

async function tikwmDetail(input, urgent = false) {
  const url = `${TIKWM_API}?url=${encodeURIComponent(toQueryUrl(input))}&hd=1`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const json = await throttled(async () => {
      const { status, text } = await fetchText(url, 10000);
      if (looksLikeChallenge(text)) throw new Error("TikWM đang bị Cloudflare chặn");
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`TikWM trả về không phải JSON (HTTP ${status})`);
      }
    }, urgent);
    if (json.code === 0 && json.data) return json.data;
    const msg = String(json.msg || "");
    if (/limit|second/i.test(msg)) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    throw new Error(msg || "Không lấy được clip");
  }
  throw new Error("TikWM đang giới hạn lượt gọi, thử lại sau ít phút");
}

// ---------- Nguồn dự phòng khi TikWM lỗi (chỉ lấy link phát) ----------

const firstUrl = (addr) => (Array.isArray(addr?.url_list) ? addr.url_list.find((u) => /^https?:\/\//.test(u)) : null) || null;
const pickUrl = (...vals) => {
  for (const v of vals) {
    const u = typeof v === "string" ? v : v?.url || v?.play_url || v?.playAddr;
    if (typeof u === "string" && /^https?:\/\//.test(u)) return u;
  }
  return null;
};

async function douyinWtfPlay(url) {
  const { status, text } = await fetchText(`https://api.douyin.wtf/api/hybrid/video_data?minimal=false&url=${encodeURIComponent(url)}`, 12000);
  if (status !== 200 || looksLikeChallenge(text)) throw new Error(`douyin.wtf HTTP ${status}`);
  const d = JSON.parse(text)?.data;
  if (!d) throw new Error("douyin.wtf không có dữ liệu");
  if (d.play || d.hdplay) return { src: d.hdplay || d.play, fallback: d.play || "" };
  const v = (d.aweme_detail || d).video || {};
  // bit_rate: chọn bản bitrate cao nhất làm HD.
  const best = (v.bit_rate || []).slice().sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0))[0];
  const sd = firstUrl(v.play_addr) || firstUrl(v.play_addr_h264);
  const hd = firstUrl(best?.play_addr) || sd;
  if (!hd) throw new Error("douyin.wtf không có link phát");
  return { src: hd, fallback: sd || "" };
}

async function tiklydownPlay(url) {
  const { status, text } = await fetchText(`https://api.tiklydown.eu.org/api/download?url=${encodeURIComponent(url)}`, 10000);
  if (status !== 200 || looksLikeChallenge(text)) throw new Error(`tiklydown HTTP ${status}`);
  const j = JSON.parse(text);
  const v = j.video || {};
  const sd = pickUrl(v.noWatermark, v.no_watermark, v.play, j.play);
  const hd = pickUrl(v.noWatermark_hd, v.hd, sd);
  if (!hd) throw new Error("tiklydown không có link phát");
  return { src: hd, fallback: sd || "" };
}

async function fallbackPlayable(input, firstError) {
  const url = toQueryUrl(input);
  const errors = [firstError];
  for (const provider of [douyinWtfPlay, tiklydownPlay]) {
    try {
      return await provider(url);
    } catch (err) {
      errors.push(String(err?.message || err));
    }
  }
  throw new Error(`Không lấy được clip (${errors.join(" | ")})`);
}

// ---------- Chuẩn hoá dữ liệu ----------

function parseJsonMaybe(v) {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

// anchors của clip TikTok Shop chứa thông tin sản phẩm dạng JSON lồng nhau;
// cấu trúc thay đổi theo vùng nên duyệt mềm, gom mọi object có tên sản phẩm.
export function parseProducts(anchors, extras) {
  const found = new Map();
  const visit = (node, depth) => {
    if (!node || depth > 8) return;
    if (typeof node === "string") {
      const parsed = parseJsonMaybe(node);
      if (parsed && typeof parsed === "object") visit(parsed, depth + 1);
      return;
    }
    if (Array.isArray(node)) return node.forEach((n) => visit(n, depth + 1));
    if (typeof node !== "object") return;
    const title = node.title || node.product_name || node.name || node.keyword;
    const pid = node.product_id || node.productId || node.item_id || node.id;
    const looksLikeProduct =
      title && (node.product_id || node.productId || node.price || node.format_price || node.seo_url || node.elastic_title);
    if (looksLikeProduct) {
      const key = String(pid || title);
      if (!found.has(key)) {
        found.set(key, {
          id: pid ? String(pid) : "",
          title: String(node.elastic_title || title).trim(),
          price: node.format_price || node.price_str || (node.price != null ? String(node.price) : ""),
          sold: node.sold_count ?? node.sales ?? "",
        });
      }
    }
    for (const v of Object.values(node)) {
      if (v && (typeof v === "object" || (typeof v === "string" && /^[[{]/.test(v)))) visit(v, depth + 1);
    }
  };
  visit(anchors, 0);
  visit(extras, 0);
  return [...found.values()];
}

// Clip TikTok Shop: anchors_extras có is_ec_video = 1 (anchors thường chỉ là hiệu ứng / CapCut).
function isEcVideo(extras) {
  const parsed = parseJsonMaybe(extras);
  return !!(parsed && typeof parsed === "object" && Number(parsed.is_ec_video) === 1);
}

function normalize(d) {
  const author = d.author || {};
  const id = String(d.id || d.video_id);
  const products = parseProducts(d.anchors, d.anchors_extras);
  return {
    id,
    url: `https://www.tiktok.com/@${author.unique_id || "i"}/video/${id}`,
    title: d.title || "",
    cover: d.origin_cover || d.cover || "",
    duration: d.duration || 0,
    region: d.region || "",
    author: { id: author.id || "", uniqueId: author.unique_id || "", nickname: author.nickname || "", avatar: author.avatar || "" },
    views: d.play_count || 0,
    likes: d.digg_count || 0,
    comments: d.comment_count || 0,
    shares: d.share_count || 0,
    saves: d.collect_count || 0,
    downloads: d.download_count || 0,
    created: (d.create_time || 0) * 1000,
    isAd: !!d.is_ad,
    isShop: isEcVideo(d.anchors_extras) || products.length > 0,
    products,
    images: Array.isArray(d.images) ? d.images : [],
    music: d.music_info ? { title: d.music_info.title || "", author: d.music_info.author || "" } : null,
    size: d.size || 0,
    hdSize: d.hd_size || 0,
    // Link CDN tiktokcdn (TikTok cho phép phát trong trang); hết hạn sau vài giờ.
    playUrl: d.hdplay || d.play || "",
    sdUrl: d.play || "",
    fetchedAt: Date.now(),
  };
}

export function mediaUrl(id, quality = "hd") {
  const kind = quality === "wm" ? "wmplay" : quality === "sd" ? "play" : "hdplay";
  return `${TIKWM_MEDIA}/${kind}/${id}.mp4`;
}

// ---------- Cache ----------

async function loadClips() {
  const { clips = {} } = await chrome.storage.local.get("clips");
  return clips;
}

async function saveClip(clip) {
  const clips = await loadClips();
  const prev = clips[clip.id];
  clip.addedAt = prev?.addedAt || Date.now();
  // Lấy lại dữ liệu clip từ TikWM không có số bán sản phẩm: giữ bản đã tra trước đó.
  if (prev?.productsAt && !clip.productsAt) {
    clip.products = prev.products;
    clip.productsAt = prev.productsAt;
    clip.isShop = clip.isShop || prev.products.length > 0;
  }
  clips[clip.id] = clip;
  await chrome.storage.local.set({ clips });
  return clip;
}

const inflight = new Map(); // id -> Promise: lấy trước (rê chuột / mở clip) và phát cùng lúc chỉ gọi TikWM 1 lần

async function resolveClip(input, { force = false, urgent = false } = {}) {
  const id = extractId(input);
  if (id && !force) {
    const cached = (await loadClips())[id];
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;
  }
  if (id && inflight.has(id)) return inflight.get(id);
  const job = tikwmDetail(id || input, urgent).then((data) => saveClip(normalize(data)));
  if (!id) return job;
  inflight.set(id, job);
  return job.finally(() => inflight.delete(id));
}

// ---------- Thông tin sản phẩm (số đã bán, giá, đánh giá...) ----------
// TikWM không trả mã sản phẩm. Mã lấy từ dữ liệu TikTok trên trang (page.js) hoặc từ trang
// video bản mobile; số liệu lấy từ trang sản phẩm /shop/<vùng>/pdp/<id> (TikTok render sẵn JSON).

const PRODUCTS_TTL_MS = 60 * 60 * 1000;
const PDP_GAP_MS = 900; // dồn dập quá TikTok trả trang captcha
const MAX_PRODUCTS = 6;
let pdpQueue = Promise.resolve();
let pdpLast = 0;

function pdpThrottled(fn) {
  const run = pdpQueue.then(async () => {
    const wait = pdpLast + PDP_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    pdpLast = Date.now();
    return fn();
  });
  pdpQueue = run.catch(() => {});
  return run;
}

// Tham số __tts_mobile=1 để luật trong rules/mobile_ua.json đổi User-Agent sang iPhone:
// chỉ bản mobile của trang video mới có link sản phẩm. Không gửi cookie (tránh bị đăng xuất).
async function productRefsFromVideoPage(clip) {
  const url = `${clip.url.split("?")[0]}?__tts_mobile=1`;
  const res = await fetch(url, { credentials: "omit", redirect: "follow" });
  const html = await res.text();
  const refs = new Map();
  for (const m of html.matchAll(/(?:shop\.tiktok\.com|tiktok\.com\/shop)\/([a-z]{2})\/pdp\/(?:[^/?"'\\]+\/)?(\d{15,25})/gi)) {
    if (!refs.has(m[2])) refs.set(m[2], { id: m[2], region: m[1].toLowerCase() });
  }
  if (!refs.size) for (const m of html.matchAll(/product_id\\*"\s*:\s*\\*"?(\d{15,25})/g)) refs.set(m[1], { id: m[1], region: "" });
  return [...refs.values()];
}

function parsePdp(html, ref) {
  const m = html.match(/<script[^>]*id="__MODERN_ROUTER_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error(/<title>Security Check/i.test(html) ? "TikTok đòi xác minh captcha, thử lại sau" : "Không đọc được trang sản phẩm");
  const loader = JSON.parse(m[1]).loaderData || {};
  const page = loader[Object.keys(loader).find((k) => /pdp/.test(k))] || {};
  const comps = page.page_config?.components_map || [];
  const pi = comps.find((c) => c?.component_data?.product_info)?.component_data.product_info;
  if (!pi) throw new Error("Sản phẩm không còn bán");
  const price = pi.price || {};
  const review = pi.review || {};
  const seller = pi.seller || {};
  const id = String(pi.product_id || ref.id);
  return {
    id,
    region: ref.region,
    url: `https://www.tiktok.com/shop/${ref.region}/pdp/${id}`,
    title: pi.title || ref.title || "",
    price: price.real_price || "",
    originalPrice: price.original_price && price.original_price !== price.real_price ? price.original_price : "",
    discount: price.discount || "",
    sold: Number(pi.sold_count) || 0,
    rating: Number(review.product_rating) || 0,
    reviews: Number(review.review_count) || 0,
    stock: (pi.skus || []).reduce((sum, k) => sum + (Number(k.stock) || 0), 0),
    shop: seller.name || "",
    shopRating: Number(seller.rating_value) || 0,
    cover: pi.images?.[0]?.url_list?.[0] || "",
  };
}

async function fetchProduct(ref) {
  const url = `https://www.tiktok.com/shop/${ref.region}/pdp/${ref.id}`;
  return pdpThrottled(async () => {
    let html = "";
    // Ẩn danh trước; gặp captcha thì chờ rồi thử lại bằng cookie TikTok của trình duyệt.
    for (const [credentials, wait] of [["omit", 0], ["include", 2500]]) {
      if (wait) await sleep(wait);
      const res = await fetch(url, { credentials, redirect: "follow" });
      if (!res.ok) throw new Error(`Trang sản phẩm lỗi HTTP ${res.status}`);
      html = await res.text();
      if (!/<title>Security Check/i.test(html)) break;
    }
    return parsePdp(html, ref);
  });
}

async function clipProducts(input, refs, force) {
  let clip = await resolveClip(input);
  if (!force && clip.productsAt && Date.now() - clip.productsAt < PRODUCTS_TTL_MS) return clip;
  let list = (refs || []).filter((r) => /^\d{15,25}$/.test(r.id));
  if (!list.length) list = clip.products.filter((p) => /^\d{15,25}$/.test(p.id)).map((p) => ({ id: p.id, title: p.title }));
  if (!list.length) list = await productRefsFromVideoPage(clip);
  const products = [];
  for (const ref of list.slice(0, MAX_PRODUCTS)) {
    const full = { ...ref, region: ref.region || "vn" };
    try {
      products.push(await fetchProduct(full));
    } catch (err) {
      products.push({ id: full.id, region: full.region, url: `https://www.tiktok.com/shop/${full.region}/pdp/${full.id}`, title: ref.title || "", error: String(err?.message || err) });
    }
  }
  clip = { ...((await loadClips())[clip.id] || clip), products, productsAt: Date.now() };
  clip.isShop = clip.isShop || products.length > 0;
  return saveClip(clip);
}

// ---------- Khối "Copy thông tin" cho HIR-F ----------
// HIR-F (ô Thông tin sản phẩm khi tạo job) bắt buộc Tên sản phẩm, ID sản phẩm, Hashtag; Link không bắt buộc.
// Đúng 4 dòng có nhãn như nút "Copy thông tin" của Shoptik để HIR-F tự tách.

const tagsOf = (text) => [...new Set((String(text || "").match(/#[\p{L}\p{N}_]+/gu) || []).map((t) => t.slice(1)))];

// Hashtag của các clip đã lưu có gắn sản phẩm này, tag dùng nhiều nhất trước (tối đa 8).
async function hirInfo(productId, clipId) {
  const clips = Object.values(await loadClips());
  const product = clips.flatMap((c) => c.products || []).find((p) => p.id === productId && p.title) || { id: productId, title: "" };
  const count = new Map();
  for (const c of clips) {
    if (!(c.products || []).some((p) => p.id === productId) && c.id !== clipId) continue;
    for (const t of tagsOf(c.title)) count.set(t, (count.get(t) || 0) + 1);
  }
  const tags = [...count].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => `#${t}`);
  const region = (product.region || "vn").toUpperCase();
  const link = `https://shop.tiktok.com/view/product/${productId}?region=${region}&local=${region === "VN" ? "vi" : "en"}`;
  const missing = [!product.title && "Tên sản phẩm", !tags.length && "Hashtag"].filter(Boolean);
  const text = [`Tên sản phẩm: ${product.title}`, `ID sản phẩm: ${productId}`, `Link: ${link}`, `Hashtag: ${tags.join(" ")}`].join("\n");
  return { text, missing };
}

// ---------- Trình phát thu nhỏ (cửa sổ popup riêng, không bị CSP của TikTok chặn) ----------

async function openPlayer(input) {
  const clip = await resolveClip(input);
  const url = chrome.runtime.getURL(`ui/player.html?id=${clip.id}`);
  const { playerWindowId } = await chrome.storage.session.get("playerWindowId");
  if (playerWindowId) {
    try {
      const [tab] = await chrome.tabs.query({ windowId: playerWindowId });
      if (tab) {
        await chrome.tabs.update(tab.id, { url });
        await chrome.windows.update(playerWindowId, { focused: true });
        return clip;
      }
    } catch {
      // Cửa sổ đã bị đóng, tạo cửa sổ mới bên dưới.
    }
  }
  const win = await chrome.windows.create({ url, type: "popup", width: 440, height: 860 });
  await chrome.storage.session.set({ playerWindowId: win.id });
  return clip;
}

chrome.windows.onRemoved.addListener(async (windowId) => {
  const { playerWindowId } = await chrome.storage.session.get("playerWindowId");
  if (playerWindowId === windowId) await chrome.storage.session.remove("playerWindowId");
});

// ---------- Tải file ----------

function safeName(s) {
  return String(s || "").replace(/[\\/:*?"<>|\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

async function downloadClip(id, quality) {
  const clip = (await loadClips())[id] || (await resolveClip(id));
  const base = `TikTokShop/${safeName(clip.author.uniqueId) || "tiktok"}_${clip.id}`;
  if (clip.images.length) {
    let i = 0;
    for (const img of clip.images) {
      i += 1;
      await chrome.downloads.download({ url: img, filename: `${base}_${i}.jpg`, conflictAction: "uniquify" });
    }
    return clip.images.length;
  }
  const suffix = quality === "wm" ? "_logo" : quality === "sd" ? "_sd" : "";
  await chrome.downloads.download({ url: mediaUrl(id, quality), filename: `${base}${suffix}.mp4`, conflictAction: "uniquify" });
  return 1;
}

// ---------- Tin nhắn ----------

const handlers = {
  async resolve({ input, force }) {
    return { clip: await resolveClip(input, { force }) };
  },
  async get({ id }) {
    return { clip: (await loadClips())[id] || null };
  },
  async list() {
    const clips = Object.values(await loadClips()).sort((a, b) => b.addedAt - a.addedAt);
    return { clips };
  },
  async remove({ ids }) {
    const clips = await loadClips();
    for (const id of ids) delete clips[id];
    await chrome.storage.local.set({ clips });
    return {};
  },
  async clear() {
    await chrome.storage.local.set({ clips: {} });
    return {};
  },
  async download({ ids, quality = "hd" }) {
    let count = 0;
    for (const id of ids) count += await downloadClip(id, quality);
    return { count };
  },
  async playable({ input, urgent }) {
    let clip;
    try {
      clip = await resolveClip(input, { urgent });
      if (!clip.playUrl || Date.now() - clip.fetchedAt > PLAY_URL_TTL_MS) clip = await resolveClip(input, { force: true, urgent });
    } catch (err) {
      return fallbackPlayable(input, String(err?.message || err));
    }
    if (clip.images.length) throw new Error("Bài đăng ảnh — mở bằng nút ⧉");
    return { src: clip.playUrl, fallback: clip.sdUrl, clip };
  },
  // Lấy sẵn link phát trước khi clip hiện ra (rê chuột vào ô clip, vừa mở trang clip).
  async prefetch({ input, urgent }) {
    const clip = await resolveClip(input, { urgent });
    if (!clip.playUrl || Date.now() - clip.fetchedAt > PLAY_URL_TTL_MS) await resolveClip(input, { force: true, urgent });
    return {};
  },
  async products({ input, refs, force }) {
    const clip = await clipProducts(input, refs, force);
    return { products: clip.products, clip };
  },
  async hirInfo({ productId, clipId }) {
    return hirInfo(String(productId), clipId ? String(clipId) : "");
  },
  async checkUpdate({ force }) {
    if (!force) {
      const { update } = await chrome.storage.local.get("update");
      if (update !== undefined) return { update };
    }
    return { update: await checkUpdate() };
  },
  async diskVersion() {
    return { version: await diskVersion() };
  },
  async openUpdate() {
    await chrome.tabs.create({ url: chrome.runtime.getURL("ui/update.html") });
    return {};
  },
  async openPlayer({ input }) {
    return { clip: await openPlayer(input) };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg)
    .then((res) => sendResponse({ ok: true, ...res }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});
