# TikTok Shop Clip Viewer (Chrome extension)

Xem, tải và thống kê các clip TikTok Shop mà web TikTok (kể cả trình phát thu nhỏ) báo không phát được.

## Cách hoạt động

Web TikTok trả dữ liệu clip Shop (`isECVideo = 1`) nhưng để trống `video.playAddr`, nên khung video đen.
`src/page.js` (MAIN world) đọc React props `item` của khung video để nhận ra các clip đó, rồi content script
lấy link CDN `*.tiktokcdn*.com` qua TikWM (CSP của TikTok cho phép domain này) và phát ngay tại chỗ.

- `src/background.js`: gọi TikWM (giãn cách 1 request/giây, nhận ra trang chặn Cloudflare), cache trong
  `chrome.storage.local`, tải file, mở trình phát. Khi TikWM lỗi, link phát lấy dự phòng qua douyin.wtf → tiklydown.
- `src/page.js`: đánh dấu khung video bị chặn bằng `data-tts-blocked`, `data-tts-id` (feed, trang video,
  và cửa sổ xem clip mở từ lưới kênh / tìm kiếm — khung này không có `<video>`, nhận qua nút `browse-video-play`).
- `src/content.js`: tự phát clip bị chặn trong feed / trang video (tự dừng khi cuộn qua), nút ▶ đỏ trên từng ô clip của TikTok, nút "▶ Xem clip này" ở trang video, gom link cho side panel.
- Thông tin sản phẩm: mã sản phẩm đọc từ `anchors` của clip (loại 33/35) khi lướt, hoặc từ trang video bản mobile
  (`rules/mobile_ua.json` đổi User-Agent cho request có `__tts_mobile=1`, không gửi cookie). Số đã bán, giá, đánh giá,
  tồn kho, shop lấy từ trang `/shop/<vùng>/pdp/<id>` (JSON `__MODERN_ROUTER_DATA__`). Số đã bán là tổng của sản phẩm,
  không riêng một clip.
- `ui/panel.*`: side panel: dán link, gom clip trên trang, lọc/sắp xếp, tải hàng loạt, xuất Excel.
- `ui/player.*`: trình phát thu nhỏ (cửa sổ popup riêng).
- `ui/xlsx.js`: tạo file .xlsx không cần thư viện.

## Cài đặt

1. Mở `chrome://extensions`, bật **Developer mode**.
2. Bấm **Load unpacked**, chọn thư mục `tools/tiktokshop-viewer`.
3. Ghim icon extension; bấm icon để mở side panel. Tải lại các tab TikTok đang mở.

## Cập nhật

Chỉ cần "Load unpacked" 1 lần. Khi có bản mới, biểu tượng extension hiện chữ **MỚI** và side panel hiện thanh
"Có bản mới": bấm **Cập nhật ngay** → lần đầu chọn đúng thư mục đã Load unpacked và bấm "Cho phép chỉnh sửa" →
extension tự tải gói, ghi đè file, khởi động lại và tải lại các tab TikTok. Các lần sau chỉ cần bấm nút.
Bấm số phiên bản cạnh tiêu đề side panel để mở trang cập nhật bất cứ lúc nào.

Phát hành (chỉ khi đã được đồng ý): tăng `version` trong `manifest.json` (1.0.x → 1.0.x+1) rồi chạy
`python build/release.py "ghi chú"` — đóng gói zip + `ban-moi.json` và đẩy lên repo công khai
`peachyd351/tiktokshop-viewer-dist` (clone ở `tools/tiktokshop-viewer-dist`).

## Sử dụng

- Lướt TikTok như bình thường: clip Shop tự phát tại chỗ (cả trong cửa sổ xem clip), có nhãn "🛒 Clip Shop",
  nút ⬇ tải và ⧉ mở cửa sổ riêng. Nếu trình duyệt chưa cho phát có tiếng, bấm "🔇 Bấm để bật tiếng" (hoặc chạm bất kỳ đâu).
- Trên TikTok: bấm nút ▶ đỏ ở góc clip, hoặc chuột phải vào link clip → **Xem clip bằng TTS Viewer**.
- Side panel: dán link (mỗi dòng 1 link, nhận cả `vt.tiktok.com`), hoặc mở trang kênh/hashtag rồi bấm
  **Gom clip trên trang** / **Cuộn & gom hết**.
- Clip Shop có nút "🛒 … · Đã bán …" trên lớp phát, bấm để xem giá, đánh giá, tồn kho, shop. Side panel tự tra
  sản phẩm khi thêm clip Shop (nút ↻ để tra lại); file Excel có thêm cột giá, đã bán, đánh giá, tồn kho, shop.
- Nút "📋 Copy thông tin" (trên thẻ sản phẩm, "📦 HIR-F" ở side panel, "📦 Copy thông tin" ở trình phát) copy khối
  4 dòng `Tên sản phẩm / ID sản phẩm / Link / Hashtag` đúng định dạng ô Thông tin sản phẩm khi tạo job HIR-F
  (HIR-F bắt buộc tên, ID, hashtag). Hashtag lấy từ các clip đã lưu có gắn cùng sản phẩm, tag dùng nhiều nhất trước (tối đa 8).
- Tích chọn clip rồi bấm tải/xuất; không chọn gì thì áp dụng cho toàn bộ danh sách đang lọc.
  File tải về nằm trong `Downloads/TikTokShop/`.

## Giới hạn

- Phụ thuộc dịch vụ TikWM miễn phí (1 request/giây); gom hàng trăm clip sẽ mất vài phút.
- Số bán theo từng clip không công khai (chỉ có ở dịch vụ như Kalodata, cần tài khoản); extension hiện số đã bán tổng của sản phẩm.
- Chỉ dùng cho clip công khai và đúng quyền sử dụng nội dung.

Một số ý tưởng (nguồn dự phòng, nhận cửa sổ xem clip, ẩn player gốc, bật tiếng) tham khảo từ Shoptik+ 1.4.6
của diepvantien (giấy phép MIT phi thương mại).
