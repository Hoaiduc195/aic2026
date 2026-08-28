# Hướng dẫn vibe-coding: thêm đáp án và chỉnh thứ tự

Tài liệu này mô tả đúng hành vi hiện có của giao diện AIC Search để có thể giao cho người khác tiếp tục code mà không nhầm giữa **thứ tự kết quả tìm kiếm** và **thứ tự đáp án nộp**.

## 1. Ba khái niệm cần phân biệt

1. **Danh sách kết quả (ranked frames):** các frame do retrieval trả về. Có thể kéo thả, đưa một frame lên đầu hoặc xuống cuối để đánh giá kết quả.
2. **Answer queue (hàng đợi đáp án):** các frame/event người dùng đã chọn để nộp. Đây mới là thứ được export và lưu.
3. **Selection revision:** bản ghi đáp án đã bấm “Lưu đáp án” ở backend. Mỗi lần lưu tạo revision mới, không sửa ngược revision cũ.

Đổi thứ tự ranked frames không tự động đổi answer queue. Muốn thay đổi thứ tự nộp, phải thao tác trong panel **Đáp án**.

## 2. Format đáp án theo từng bài

### Textual KIS

Mỗi dòng là một frame:

```json
{"video_id":"L26_V076","frame_id":385}
```

CSV không có header: `video_id,frame_id`. `frame_id` phải là `original_frame_id` (số nguyên không âm), không dùng số thứ tự keyframe hiển thị.

### VQA / Q&A

Mỗi dòng là một frame kèm câu trả lời:

```json
{"video_id":"L26_V076","frame_id":385,"answer":"A person is standing near a car."}
```

CSV: `video_id,frame_id,answer`. Câu trả lời bị trim khoảng trắng và tối đa 2.000 ký tự.

### TRAKE

Một đáp án chứa nhiều frame của cùng một sự kiện:

```json
{"video_id":"L26_V076","frame_ids":[120,145,173]}
```

CSV: `video_id,frame_id_1,frame_id_2,...`. Các `frame_ids` bắt buộc tăng dần theo thời gian. Một event chưa đủ/không hợp lệ sẽ không được export.

## 3. Luồng thêm đáp án trên UI

### Textual KIS

1. Chạy tìm kiếm.
2. Chọn frame trong kết quả hoặc studio.
3. Bấm **Thêm đáp án** (hoặc nút tương đương trong khu vực frame đang chọn).
4. Frame được thêm vào answer queue; frame trùng `video_id + original_frame_id` không được thêm lần hai.
5. Mở **Đáp án** để kiểm tra, đổi thứ tự, xóa hoặc xuất CSV.

### VQA

1. Chọn một hoặc nhiều frame rồi bấm thêm vào VQA queue.
2. Mỗi item ban đầu có trạng thái `pending`.
3. Nhập câu trả lời cho từng item, hoặc dùng chức năng batch/assistant nếu cần; item hợp lệ chuyển thành `answered`.
4. Chỉ item `answered` có câu trả lời khác rỗng mới trở thành đáp án export.
5. Có thể xóa item, đổi thứ tự và sửa câu trả lời trực tiếp trong panel Đáp án.

Các trạng thái khác cần giữ nguyên để debug: `abstained`, `needs_more_evidence`, `error`. Không tự coi chúng là đáp án hợp lệ.

### TRAKE

1. Thêm anchor/event vào TRAKE queue.
2. Chọn các frame thuộc cùng event trong studio/temporal evidence.
3. Hoàn tất event; hệ thống sort theo thời gian và validate sequence.
4. Chỉ event hợp lệ mới xuất thành `{video_id, frame_ids}`.
5. Thứ tự các event trong queue cũng có thể kéo thả; thứ tự frame bên trong event vẫn phải tăng dần.

## 4. Chỉnh thứ tự

### Thứ tự đáp án nộp

Trong panel **Đáp án**:

- Kéo biểu tượng tay nắm để kéo thả một dòng.
- Dùng nút lên/xuống để đổi từng bước.
- Dùng nút đưa lên đầu/cuối nếu giao diện đang hiển thị.
- Thứ tự sau thao tác phải được giữ nguyên khi bấm Lưu, Preview hoặc Export.

Các hàm model liên quan: `moveVqaQueueItem`, `moveTrakeQueueItem`, và callback `onMove` của `AnswerDrawer`.

### Thứ tự kết quả retrieval

Kéo thả hoặc đưa frame lên/xuống trong danh sách kết quả chỉ thay đổi ranking hiển thị. Đây là thao tác đánh giá retrieval, không phải thêm đáp án. Không được dùng ranking index làm `frame_id`.

### TRAKE: hai lớp thứ tự

- **Trong một event:** luôn theo `original_frame_id` tăng dần.
- **Giữa các event:** theo thứ tự dòng trong TRAKE queue; người dùng được phép sắp xếp lại.

## 5. Quy tắc deduplicate và validate

- Textual KIS/VQA định danh frame bằng `video_id + original_frame_id`.
- Không tạo frame ID giả khi khôi phục từ CSV hoặc answer cũ.
- Giới hạn answer/queue hiện tại là 100 dòng.
- Frame ID phải là số nguyên không âm.
- TRAKE phải có ít nhất một frame và dãy frame tăng dần.
- VQA phải có answer không rỗng; trim trước khi lưu.
- CSV được kiểm tra lại trước export/preview; lỗi phải hiển thị rõ để người dùng sửa.

## 6. Lưu, preview và export

- **Lưu đáp án:** gọi `POST /v1/queries/{query_id}/selection` với `{task, answers}`; tạo selection revision.
- **Preview nộp:** gọi `POST /v1/submissions/preview`; trả về `answer_count`, `warnings`, `submittable` và CSV dự kiến. Preview không thay thế thao tác lưu.
- **Export CSV:** thực hiện ở frontend qua `buildSubmissionCsv`; file UTF-8, mỗi task có format riêng ở mục 2.
- Khi import CSV, phải khôi phục đúng thứ tự dòng và chỉ nhận các cột phù hợp task hiện tại.

## 7. Các file chính để tiếp tục phát triển

- `apps/frontend/src/components/Workbench.tsx`: state, thêm/xóa đáp án, queue, callback reorder, lưu/preview.
- `apps/frontend/src/components/workbench/AnswerDrawer.tsx`: panel hiển thị, drag/drop, nút lên/xuống, nhập answer.
- `apps/frontend/src/lib/vqa-queue-model.ts`: dedupe, trạng thái VQA, reorder, hoàn tất answer.
- `apps/frontend/src/lib/trake-queue-model.ts`: event queue, validate/sort frame TRAKE.
- `apps/frontend/src/lib/submission-csv.ts`: validate và sinh CSV.
- `apps/frontend/src/lib/api.ts`: parse answer và gọi API selection/preview.
- `apps/frontend/src/lib/contracts.ts`: các type `TextualKisAnswer`, `QaAnswer`, `TrakeAnswer`, `SelectionRevision`, `SubmissionPreview`.

## 8. Checklist acceptance khi sửa UI

- [ ] Thêm cùng một frame hai lần không tạo dòng trùng.
- [ ] Kéo dòng 3 lên dòng 1 thì thứ tự export cũng là 3,1,2 theo vị trí mới.
- [ ] Refresh/khôi phục answer cũ vẫn giữ thứ tự.
- [ ] VQA pending không xuất CSV; VQA answered có answer đã trim.
- [ ] TRAKE từ chối dãy frame giảm hoặc trùng; không tự bịa frame còn thiếu.
- [ ] Lưu thành công tạo revision; preview hiển thị warning nếu chưa đủ điều kiện.
- [ ] Textual KIS, VQA và TRAKE không dùng chung logic CSV sai format.
- [ ] Không đổi `original_frame_id` thành index của mảng kết quả.

## 9. Cách test nhanh cho người nhận việc

1. Chạy frontend/backend theo README của repo.
2. Tìm một query có ít nhất 3 frame.
3. Thêm 3 frame, đổi thứ tự bằng kéo thả, xóa một frame, rồi mở Preview.
4. Kiểm tra CSV và payload Network có cùng thứ tự.
5. Lặp lại với VQA (một pending, một answered) và TRAKE (một event có 3 frame).
6. Chạy test hiện có liên quan: `workbench-model.test.ts`, `Workbench.test.tsx`, `vqa-queue.test.ts`; bổ sung test nếu thay đổi hành vi.

## 10. Yêu cầu khi vibe-code

Giữ nguyên các invariant ở mục 5, không sửa migration/backend contract chỉ để làm UI tiện hơn. Nếu cần đổi format đáp án, phải cập nhật đồng thời `contracts.ts`, parser API, CSV builder, queue model, UI và test. Mọi thay đổi làm ảnh hưởng thứ tự nộp phải được kiểm tra bằng payload thực tế và file CSV, không chỉ nhìn thứ hạng trên màn hình.
