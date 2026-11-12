// Chạy trong MAIN world từ document_start: đọc (không sửa) phản hồi danh sách clip mà TikTok tải
// sẵn phía trước (feed, kênh, tìm kiếm...). Clip nào TikTok không cấp link phát (clip Shop) thì báo
// cho content script lấy link + nạp video trước khi clip hiện ra trên trang.

(() => {
  const LIST_RE = /\/api\/[a-z_/]*(item_list|search)/;

  function report(text) {
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    const list = json.itemList || json.item_list || json.items || (Array.isArray(json.data) ? json.data.map((d) => d?.item).filter(Boolean) : []);
    if (!Array.isArray(list)) return;
    const items = [];
    for (const it of list) {
      const v = it?.video;
      if (!v || it.imagePost || it.liveRoomInfo || v.playAddr || v.bitrateInfo?.length) continue;
      items.push({ id: String(it.id), author: it.author?.uniqueId || (typeof it.author === "string" ? it.author : "") });
    }
    if (!items.length) return;
    // Content script (document_idle) chưa chạy thì lưu tạm lên <html> để nó đọc lúc khởi động.
    const root = document.documentElement;
    if (!root.dataset.ttsReady) {
      const pending = JSON.parse(root.dataset.ttsPending || "[]");
      root.dataset.ttsPending = JSON.stringify(pending.concat(items).slice(-30));
    }
    window.postMessage({ __tts: "blocked-items", items }, location.origin);
  }

  const realFetch = window.fetch;
  window.fetch = function (input) {
    const promise = realFetch.apply(this, arguments);
    const url = input instanceof Request ? input.url : String(input || "");
    if (LIST_RE.test(url)) promise.then((res) => res.ok && res.clone().text().then(report)).catch(() => {});
    return promise;
  };

  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ttsUrl = String(url || "");
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (LIST_RE.test(this.__ttsUrl || "")) {
      this.addEventListener("load", () => {
        if (this.status === 200 && (this.responseType === "" || this.responseType === "text")) report(this.responseText);
      });
    }
    return send.apply(this, arguments);
  };
})();
