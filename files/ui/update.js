// Cập nhật bản cài "Load unpacked": Chrome không tự cập nhật được, extension cũng không tự ghi
// được thư mục của mình. File System Access API thì được: người dùng chọn thư mục 1 lần (lưu
// handle trong IndexedDB). Mỗi lần cập nhật: tải từng file của bản mới (danh sách + SHA-256 trong
// ban-moi.json của repo phát hành), kiểm tra mã, ghi vào thư mục (manifest.json ghi cuối), rồi
// chrome.runtime.reload().

import { send } from "./common.js";

const $ = (id) => document.getElementById(id);
const manifest = chrome.runtime.getManifest();
let update = null;
let busy = false;

// ---------- Lưu thư mục đã chọn ----------

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("tts-updater", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kv(key, value) {
  const store = (await db()).transaction("kv", value === undefined ? "readonly" : "readwrite").objectStore("kv");
  return new Promise((resolve) => {
    const req = value === undefined ? store.get(key) : store.put(value, key);
    req.onsuccess = () => resolve(value === undefined ? req.result : undefined);
    req.onerror = () => resolve(null);
  });
}

function setStatus(text, cls = "") {
  $("status").textContent = text;
  $("status").className = cls || "muted";
}

function progress(p) {
  const bar = document.querySelector(".bar");
  bar.hidden = false;
  bar.firstElementChild.style.width = `${Math.round(p * 100)}%`;
}

async function sha256(buf) {
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- Thư mục extension ----------

async function readManifest(dir) {
  try {
    return JSON.parse(await (await (await dir.getFileHandle("manifest.json")).getFile()).text());
  } catch {
    return null;
  }
}

const isOurs = (m) => m?.name === manifest.name;

async function allowed(dir) {
  if ((await dir.queryPermission({ mode: "readwrite" })) === "granted") return true;
  return (await dir.requestPermission({ mode: "readwrite" })) === "granted";
}

async function pickDir() {
  const dir = await window.showDirectoryPicker({ id: "tts-viewer", mode: "readwrite" });
  if (!isOurs(await readManifest(dir))) throw new Error("Thư mục này không phải thư mục TTS Viewer đang cài (không thấy manifest.json của extension). Hãy chọn lại.");
  await kv("dir", dir);
  return dir;
}

async function saveFile(root, path, data) {
  const parts = path.split("/").filter(Boolean);
  let dir = root;
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
  const writable = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
  await writable.write(data);
  await writable.close();
}

// Tải đủ mọi file và kiểm mã trước, chỉ ghi khi tất cả đều đúng.
async function downloadAll(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const { path, sha256: expected } = list[i];
    if (path.split("/").includes("..")) throw new Error(`Đường dẫn lạ trong bản cập nhật: ${path}`);
    setStatus(`Đang tải ${i + 1}/${list.length}: ${path}`);
    const res = await fetch(`${update.base}/${path.split("/").map(encodeURIComponent).join("/")}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Không tải được ${path} (HTTP ${res.status})`);
    const data = await res.arrayBuffer();
    if ((await sha256(data)) !== expected) throw new Error(`File ${path} tải về bị lỗi (sai mã kiểm tra), thử lại sau`);
    out.push({ path, data });
    progress(0.05 + (0.6 * (i + 1)) / list.length);
  }
  return out;
}

async function run(forcePick) {
  if (busy || !update) return;
  busy = true;
  $("go").disabled = true;
  try {
    let dir = forcePick ? null : await kv("dir");
    if (dir && (!(await allowed(dir)) || !isOurs(await readManifest(dir)))) dir = null;
    if (!dir) {
      setStatus("Chọn thư mục extension đang cài…");
      dir = await pickDir();
      if (!(await allowed(dir))) throw new Error("Bạn chưa cho phép ghi vào thư mục.");
    }
    $("dir").textContent = `Thư mục: ${dir.name}`;

    const files = await downloadAll(update.files);
    const mf = files.find((f) => f.path === "manifest.json");
    if (!mf || !isOurs(JSON.parse(new TextDecoder().decode(mf.data)))) throw new Error("Bản cập nhật không phải TTS Viewer");
    // manifest.json ghi cuối: dừng giữa chừng thì Chrome vẫn nạp như bản cũ.
    const ordered = [...files.filter((f) => f !== mf), mf];
    for (let i = 0; i < ordered.length; i++) {
      setStatus(`Đang ghi ${i + 1}/${ordered.length}: ${ordered[i].path}`);
      await saveFile(dir, ordered[i].path, ordered[i].data);
      progress(0.65 + (0.35 * (i + 1)) / ordered.length);
    }
    setStatus(`✓ Đã cập nhật lên ${update.version}. Đang khởi động lại extension…`, "ok");
    $("go").textContent = "Xong";
    setTimeout(() => chrome.runtime.reload(), 1200);
  } catch (err) {
    setStatus(err?.name === "AbortError" ? "Đã huỷ chọn thư mục." : String(err?.message || err), err?.name === "AbortError" ? "" : "error");
    $("go").disabled = false;
    $("go").textContent = "Thử lại";
  } finally {
    busy = false;
  }
}

$("cur").textContent = `Bản đang dùng: ${manifest.version}`;
$("go").addEventListener("click", () => run(false));
$("pick").addEventListener("click", () => run(true));
kv("dir")
  .then((dir) => dir && ($("dir").textContent = `Thư mục đã chọn: ${dir.name}`))
  .catch(() => {});

send({ type: "checkUpdate", force: true }).then((res) => {
  update = res.ok ? res.update : null;
  if (!res.ok) return setStatus(`Không kiểm tra được bản mới: ${res.error}`, "error");
  if (!update) {
    $("go").textContent = "Đang dùng bản mới nhất";
    return setStatus("Chưa có bản mới. Khi có, biểu tượng extension hiện chữ MỚI.");
  }
  $("next").textContent = `→ ${update.version}`;
  if (update.notes) {
    $("notes").hidden = false;
    $("notes").textContent = update.notes;
  }
  if (!update.files?.length) return setStatus("Bản mới chưa hỗ trợ cập nhật bằng nút, hãy cài lại từ file zip.", "error");
  $("go").disabled = false;
  $("go").textContent = "Cập nhật ngay";
});
