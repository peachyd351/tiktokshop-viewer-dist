// Trang cập nhật: báo bản mới và hướng dẫn chạy "Cập nhật.bat" trong thư mục extension (script
// PowerShell tải + kiểm tra + chép file). Trang không tự ghi file: Windows Defender báo nhầm là trojan
// khi Chrome tự ghi đè code của extension. Script chép xong thì trang (và background) thấy
// manifest.json trên ổ đĩa đổi phiên bản → chrome.runtime.reload().

import { send } from "./common.js";

const $ = (id) => document.getElementById(id);
const current = chrome.runtime.getManifest().version;

function setStatus(text, cls = "") {
  $("status").textContent = text;
  $("status").className = cls || "muted";
}

$("cur").textContent = `Bản đang dùng: ${current}`;

send({ type: "checkUpdate", force: true }).then((res) => {
  if (!res.ok) return setStatus(`Không kiểm tra được bản mới: ${res.error}`, "error");
  if (!res.update) return setStatus("Đang dùng bản mới nhất. Khi có bản mới, biểu tượng extension hiện chữ MỚI.");
  $("next").textContent = `→ ${res.update.version}`;
  if (res.update.notes) {
    $("notes").hidden = false;
    $("notes").textContent = res.update.notes;
  }
  $("steps").hidden = false;
  setStatus("Đang chờ chạy Cập nhật.bat…");
});

// Chờ script chép xong: manifest.json trên ổ đĩa mang phiên bản mới thì khởi động lại extension.
setInterval(async () => {
  const res = await send({ type: "diskVersion" });
  if (res.ok && res.version && res.version !== current) {
    setStatus(`✓ Đã cập nhật lên ${res.version}. Đang khởi động lại extension…`, "ok");
    setTimeout(() => chrome.runtime.reload(), 800);
  }
}, 2000);
