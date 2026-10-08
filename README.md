# MinhbaoGDVN Bot

Discord bot và dashboard quản lý ticket viết bằng Node.js.

## Deploy lên Render

1. Đưa repository lên GitHub.
2. Trong Render, chọn **New > Blueprint** và kết nối repository này. Render sẽ đọc cấu hình từ `render.yaml`.
3. Nhập `DISCORD_TOKEN` (token bot Discord) và `DASHBOARD_PASSWORD` (mật khẩu đăng nhập dashboard) khi Render yêu cầu. Nếu Blueprint không hỏi, thêm cả hai tại **Environment** của service.
4. Deploy service. Mở URL Render để vào dashboard; endpoint `/health` được dùng cho health check.

Ứng dụng giới hạn runtime trong Node.js 24 LTS để Render không tự chọn Node.js 26. Máy local đã kiểm tra bằng Node.js 24.15.0, nên phiên bản này khớp cùng major với Render. Ứng dụng kiểm tra hai biến môi trường bắt buộc ngay khi khởi động; thiếu cấu hình, service sẽ báo lỗi cụ thể thay vì chạy trong trạng thái hỏng. Không đưa token hoặc mật khẩu vào repository.

Cấu hình này dùng gói Free: Render có thể sleep service sau thời gian không có truy cập HTTP. Trong lúc service ngủ, bot sẽ offline và dashboard sẽ khởi động lại khi có truy cập HTTP; gói Free không đảm bảo bot online liên tục. Muốn bot online liên tục cần dùng instance luôn hoạt động trên Render.

Filesystem của service Free không bền vững qua lần deploy/restart. Cấu hình ticket lưu bằng `ticket-settings.json` có thể bị mất và trở về mặc định sau đó. Để giữ cấu hình, cần chuyển sang dịch vụ có persistent disk trên Render, mount disk (ví dụ tại `/var/data`) và đặt biến `TICKET_SETTINGS_FILE=/var/data/ticket-settings.json`.

Dashboard hiển thị trạng thái kết nối Discord, lỗi/kết nối lại shard và tối đa 1.000 dòng log mới nhất trong phiên chạy hiện tại. Nhật ký trên dashboard nằm trong bộ nhớ và sẽ mất khi service restart hoặc thức dậy; để xem log qua nhiều lần khởi động, dùng tab **Logs** của service trên Render. Endpoint `/health` chỉ kiểm tra web service; trạng thái Discord được hiển thị riêng trong dashboard.

## Chạy cục bộ

```sh
npm ci
npm start
```

Tạo file `.env` cục bộ với `DISCORD_TOKEN` và `DASHBOARD_PASSWORD` trước khi chạy.
