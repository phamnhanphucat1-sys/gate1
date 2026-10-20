# Web lưu sự kiện camera cổng trường — GitHub + Cloudflare Workers

Web có đăng nhập, ảnh, thời gian Việt Nam, lọc theo ngày, xuất CSV, thêm thủ công,
đánh dấu chờ kiểm tra/đã xác nhận/nhận nhầm và xóa bản ghi. Tự tải lại dữ liệu mỗi
2 giây, không phải truyền video trực tiếp. Chưa có dữ liệu mẫu. Tối đa 2.000 bản ghi
trong một lần xem/xuất; lọc từng ngày khi dữ liệu lớn.

## 1. Đưa lên GitHub
Giải nén. Upload TẤT CẢ nội dung bên trong gate-cloud vào gốc repository mới,
bao gồm public, migrations, worker.mjs, package.json và wrangler.jsonc.
Không upload token, mật khẩu, .env, .dev.vars hoặc thư mục outbox.

## 2. Cấu hình Cloudflare (lần đầu)
Cài Node.js LTS. Mở CMD trong thư mục mã nguồn, chạy lần lượt:

```
npm install
npx wrangler login
npx wrangler d1 create school-gate-db
npx wrangler r2 bucket create school-gate-photos
```
R2 cần được kích hoạt trên tài khoản Cloudflare trước khi tạo bucket; xem điều kiện
và chi phí hiển thị trên tài khoản. Không cần bật public access cho bucket.
Copy database_id được trả về vào wrangler.jsonc, thay REPLACE_WITH_YOUR_D1_DATABASE_ID.
Commit file cấu hình đã sửa lên GitHub (database_id không phải mật khẩu).

```
npx wrangler d1 migrations apply school-gate-db --remote
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_KEY
npx wrangler secret put CAMERA_TOKEN
npm run deploy
```
Mỗi lệnh secret sẽ hỏi giá trị, nhập trực tiếp tại máy. ADMIN_PASSWORD là mật khẩu
đăng nhập web. SESSION_KEY và CAMERA_TOKEN là hai chuỗi ngẫu nhiên KHÁC NHAU,
mỗi chuỗi ít nhất 32 ký tự; không dùng khoảng trắng, dấu chấm phẩy hay dấu ngoặc kép.
Có thể tạo mỗi chuỗi bằng: python -c "import secrets; print(secrets.token_hex(32))"
Giữ CAMERA_TOKEN để cấu hình camera. Không gửi token vào chat hoặc đưa lên GitHub.
Mở URL workers.dev do deploy trả về, đăng nhập bằng ADMIN_PASSWORD.

## 3. Tự triển khai từ GitHub
Trong Cloudflare: Workers & Pages -> Create -> Import a repository (Workers),
chọn repository. Dùng build command: npm run check; deploy command: npx wrangler deploy.
Đây là WORKERS, không phải Pages static. Đã cần tạo D1, R2 và secrets ở bước 2.
Các lần push sau cập nhật web; migration schema mới phải áp dụng riêng.

## 4. Nối camera Python
Copy camera_cloud.py vào D:\helmet-ai, cạnh camera.py.
Thêm ở đầu camera.py:

```python
from camera_cloud import record_suspected
```
Trong vòng while, trước vòng for cuối cùng vẽ khung người:

```python
        suspected = False
```
Trong nhánh else đang đặt nhãn PERSON - NGHI KHONG MU, thêm:

```python
                suspected = True
```
Sau vòng vẽ người, trước cv2.imshow, thêm (cùng mức thụt lề với cv2.imshow):

```python
        if suspected:
            record_suspected(frame)
```
Mở CMD, cấu hình (thay giá trị ví dụ bằng thông tin thật):

```
cd /d D:\helmet-ai
.venv312\Scripts\activate
set GATE_URL=https://TEN-WORKER.TEN-TAI-KHOAN.workers.dev
set GATE_TOKEN=TOKEN_CAMERA_CUA_BAN
python camera.py
```
Biến set chỉ có hiệu lực trong CMD hiện tại; nhập lại khi mở cửa sổ mới.
Thử một bản ghi thủ công trên web trước, sau đó thử camera.
Camera lưu tối đa 1 ảnh mỗi 30 giây chung cho cả khung hình, không phải đếm từng
người. Sự kiện có UUID để retry không tạo bản ghi trùng. Mất mạng được giữ trong
outbox trên máy; tự gửi lại mỗi 5 giây khi chương trình chạy. Không xóa outbox khi
còn bản ghi. Hàng đợi không có giới hạn dung lượng, cần theo dõi ổ đĩa khi mất mạng lâu.
Không bắt buộc mở web trên trình duyệt để camera gửi/lưu sự kiện.

## Giới hạn
Nhãn nghi không đội mũ là kết quả suy đoán khi phát hiện người nhưng chưa tìm được
mũ, có thể sai và vẫn bao gồm người đi bộ. Chưa ghép người với xe để xác nhận người
đang ngồi trên xe. Người quản lý xem ảnh rồi xác nhận, không tự xử phạt.
Web không tự bật camera điện thoại: tiếp tục kết nối DroidCam như trước.
Cơ chế đăng nhập dùng mật khẩu chung và cookie 12 giờ; chưa có phân quyền tài khoản
hoặc giới hạn thử mật khẩu. Nên bật Cloudflare rate limiting cho /api/login trước
khi sử dụng lâu dài. Đổi SESSION_KEY để hủy toàn bộ phiên đăng nhập hiện có.
Ảnh được bảo vệ bằng phiên đăng nhập; token camera chỉ có quyền thêm sự kiện.

## Kiểm tra
npm run check kiểm tra cú pháp Worker. Có thể thử local với wrangler dev và secrets
trong .dev.vars (không commit). Chưa triển khai trên tài khoản của bạn, cần kiểm tra
luồng D1/R2/đăng nhập/camera sau khi cấu hình thật.
