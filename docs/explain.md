# Giải thích kiến trúc hiện tại

## Một câu ngắn gọn

Hệ thống tìm trong video bằng cách nối mọi thông tin về đúng video và đúng
frame. Frame là đơn vị để người dùng xem, chọn và submit; evidence là lý do
vì sao frame đó được tìm thấy.

```text
query
  ↓
planner → các branch visual/OCR/ASR/caption/object
  ↓
evidence hits
  ↓
gom theo video + original_frame_id
  ↓
weighted RRF
  ↓
frame result + preview + evidence
```

## Vì sao không cần temporal grouping trung gian?

Nguồn đã có keyframe map và timeline chính xác. Thêm một lớp ID trung gian sẽ
tạo thêm bước mapping, foreign key và điểm lệch giữa caption/OCR/object/
embedding. Với kiến trúc frame-first, các modality ảnh dùng trực tiếp
`(video_id, original_frame_id)`, còn ASR dùng interval millisecond.

## Fusion dễ hiểu

Một frame có thể được caption, OCR và object branch tìm thấy cùng lúc. Backend
gộp các hit cùng frame, cộng score theo weighted RRF và giữ trace:

- branch nào đóng góp;
- rank trong branch;
- weight và contribution;
- evidence IDs và matched terms;
- số lần frame được xác nhận.

Nhờ vậy một frame không chiếm nhiều vị trí chỉ vì có nhiều evidence.

## URI và secret R2

Database chỉ lưu object key/URI nội bộ. Backend đọc secret từ `.env`, ký URL
ngắn hạn và trả URL dùng được cho browser. Secret không đi vào database, JSON
response hay frontend bundle.

## Giới hạn hiện tại

Refined data vẫn còn vài blocker về mapping exact frame, embedding revision,
R2 URI và object source bị thiếu. Vì vậy database có thể chạy schema và test,
nhưng chưa nên import toàn bộ dữ liệu production.
