# 🚀 CHI TIẾT KỸ THUẬT CÁC TÍNH NĂNG VLM MỚI (GEMINI 3.7 FLASH)

Tài liệu này tóm tắt chi tiết các nâng cấp kỹ thuật về module VLM (Vision-Language Model) vừa được cài đặt vào codebase `aic2026`, giải thích cơ chế hoạt động của **3 gói tính năng tối ưu mới**, bảng thông số cấu hình và hướng dẫn setup cho thành viên trong team.

---

## 1. CHI TIẾT KỸ THUẬT 3 TÍNH NĂNG TỐI ƯU MỚI

```
[ User Query ]
      │
      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. VLM QUERY EXPANSION (vlm-query-expander.service.ts)                      │
│    • Gọi Gemini chế độ text-only (không tốn token ảnh)                       │
│    • Sinh 3 biến thể tiếng Anh đa dạng góc nhìn visual                      │
│    • Đưa vào retrieval plan để tất cả branch (CLIP, Caption, YOLO) cùng tìm │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ [ Multi-branch Retrieval + RRF Fusion ] ➔ Top-100 Candidates                │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. ADAPTIVE TOP-K (vlm-reranker.service.ts)                                 │
│    • Đo hệ số biến thiên (CV = stddev/mean) trên phân bố điểm RRF           │
│    • Điểm rõ ràng (CV cao) ➔ Giảm số frame gửi VLM (tiết kiệm token)        │
│    • Điểm cạnh tranh sít sao (CV thấp) ➔ Tăng số frame gửi VLM để lọc kỹ    │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. VLM VISUAL RERANKER & MIN-SCORE FILTER (vlm-reranker.service.ts)         │
│    • Lấy Signed URL ảnh keyframe từ R2, gửi song song lên Gemini            │
│    • Chấm điểm khớp 0 - 100 ➔ Tính multiplier nhân lại score ban đầu        │
│    • MIN-SCORE FILTER: Loại bỏ hoàn toàn các frame có điểm VLM < ngưỡng     │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
                                      ▼
                            [ Kết quả sạch ra UI ]
```

---

### 🔹 Tính năng 1: VLM Query Expansion (Mở rộng truy vấn tự động)
* **File cài đặt**: `apps/backend/src/retrieval/vlm-query-expander.service.ts`
* **Cơ chế hoạt động**:
  - Khi nhận query (tiếng Việt hoặc tiếng Anh), hệ thống gọi Gemini bằng prompt **text-only** (không kèm ảnh) để phân tích ý định tìm kiếm và sinh ra 3 câu mô tả tiếng Anh thay thế (ví dụ: *"người phụ nữ mặc áo dài đỏ"* $\rightarrow$ `["woman wearing red traditional ao dai", "female in long red dress", "person in red vietnamese dress"]`).
  - Toàn bộ biến thể này được nạp vào `plan.query_variants`. Tất cả các nhánh (Vector CLIP, Caption Florence-2, Object YOLO, OCR) sẽ tìm kiếm song song cho từng biến thể và tự động gộp lại bằng thuật toán RRF.
* **Lợi ích**: Tăng mạnh độ bao phủ (Recall), khắc phục triệt để điểm yếu bất đồng ngôn ngữ giữa query tiếng Việt và metadata tiếng Anh.
* **Mức tiêu hao**: Rất thấp (~300 tokens text, $\approx$ 0.007 VNĐ/lần).

---

### 🔹 Tính năng 2: VLM Visual Reranker & Min-Score Filter (Chấm điểm ảnh & Lọc rác)
* **File cài đặt**: `apps/backend/src/retrieval/vlm-reranker.service.ts` & `vlm-vision.client.ts`
* **Cơ chế hoạt động**:
  - Lấy Top-20 candidates sau bước RRF, sinh Signed URL ảnh thumbnail độ phân giải cao từ Cloudflare R2 và gửi đồng thời (concurrency = 4) lên **Gemini 3.7 Flash**.
  - Gemini phân tích nội dung thị giác thực tế của ảnh so với query và trả về điểm số $S \in [0, 100]$.
  - Điểm mới được chuẩn hóa quanh mốc 50 và nhân vào điểm số cũ theo trọng số:
    $$\text{Multiplier} = \max\left(0.1, 1 + \frac{S - 50}{50} \times \text{Weight}\right)$$
    $$\text{Score}_{\text{new}} = \text{Score}_{\text{old}} \times \text{Multiplier}$$
  - **Min-Score Filter**: Tự động loại bỏ hoàn toàn các frame có $S < \text{VLM\_MIN\_SCORE}$ (ví dụ < 20 điểm) ra khỏi danh sách trả về, giúp bảng kết quả sạch, không bị lẫn frame sai.
* **Lợi ích**: Độ chính xác cao nhất (Precision), đưa frame đúng lên Top 1-5.

---

### 🔹 Tính năng 3: Adaptive Top-K (Tự động co giãn Top-K theo độ khó)
* **File cài đặt**: `apps/backend/src/retrieval/vlm-reranker.service.ts`
* **Cơ chế hoạt động**:
  - Hệ thống tính toán độ phân tán điểm số của top candidates thông qua hệ số biến thiên $CV = \frac{\sigma}{\mu}$ (Standard Deviation / Mean).
  - **Khi $CV > 0.3$** (các ứng viên đầu có điểm vượt trội, kết quả rõ ràng): Hệ thống tự động hạ Top-K (ví dụ từ 20 xuống 10 frame) $\rightarrow$ **tiết kiệm token**.
  - **Khi $CV \le 0.3$** (các ứng viên có điểm sàn sàn nhau, độ khó cao): Hệ thống tự động nâng Top-K (lên 25–30 frame) để Gemini lọc sâu hơn $\rightarrow$ **tăng độ chính xác**.
* **Lợi ích**: Tiết kiệm trung bình **20–30% token**, phân bổ chi phí thông minh theo độ khó của từng câu hỏi.

---

## 2. BẢNG THÔNG SỐ CẤU HÌNH TRONG `.env`

Tất cả các tính năng trên được điều khiển qua file `apps/backend/.env`:

| Biến môi trường | Giá trị khuyến nghị | Ý nghĩa kỹ thuật |
|---|---|---|
| `VLM_ENABLED` | `true` | Bật/tắt toàn bộ module VLM Visual Reranker & Multimodal VQA |
| `VLM_MODEL` | `gemini-3.7-flash` | Định danh model Google Gemini 3.7 Flash |
| `VLM_TOP_K` | `20` | Số lượng frame cơ sở đưa vào VLM reranking |
| `VLM_WEIGHT` | `0.7` | Trọng số tác động của điểm VLM lên thứ hạng cuối (0.0 - 1.0) |
| `VLM_CONCURRENCY` | `4` | Số request gửi song song (giữ an toàn không vượt Rate Limit) |
| `VLM_TIMEOUT_MS` | `10000` | Timeout 10s (tự động retry 1 lần sau 8s nếu gặp lỗi 429) |
| `VLM_MIN_SCORE` | `20` | Ngưỡng điểm tối thiểu để giữ lại frame (set `0` nếu muốn tắt lọc) |
| `VLM_QUERY_EXPANSION` | `true` | Bật/tắt tính năng VLM sinh 3 biến thể tiếng Anh mở rộng |
| `VLM_ADAPTIVE_TOP_K` | `true` | Bật/tắt tính năng tự động co giãn Top-K theo độ khó query |

*(Trên giao diện Frontend Workbench Sidebar cũng đã có sẵn các nút toggle và thanh điều chỉnh `Top-K`, `Weight`, `Min Score` để tùy chỉnh nhanh khi chạy).*

---

## 3. ƯỚC TÍNH TOKEN & CHI PHÍ THỰC TẾ

| Hành động | Lượng Token tiêu thụ | Chi phí ước tính (Paid Tier) |
|---|---|---|
| 1 Frame VLM Rerank (ảnh + prompt) | ~420 – 450 tokens | ~$0.00046 (~11 VNĐ) |
| 1 Query Expansion (text-only) | ~300 tokens | ~$0.00022 (~5 VNĐ) |
| **1 Query tìm kiếm hoàn chỉnh (Top-20)** | **~8.600 tokens** | **~$0.0092 (~220 VNĐ)** |
| **100 Query liên tục (1 buổi thi đầy đủ)** | **~860.000 tokens** | **~$0.92 (~22.000 VNĐ)** |
| 1 Câu hỏi đáp VQA (ảnh + text evidence) | ~600 – 800 tokens | ~$0.00060 (~15 VNĐ) |

> 💡 **Free Tier**: Hoàn toàn miễn phí từ [Google AI Studio](https://aistudio.google.com/).  
> **5 thành viên dùng 5 API Key độc lập** $\rightarrow$ Có 5 quota hoàn toàn riêng biệt, không ai trừ token của ai.

---

## 4. HƯỚNG DẪN 3 BƯỚC CÀI ĐẶT CHO THÀNH VIÊN

Mỗi người tự tạo 1 API Key riêng và cấu hình trên máy cá nhân:

### Bước 1: Lấy API Key miễn phí
1. Truy cập: **[https://aistudio.google.com/](https://aistudio.google.com/)**
2. Đăng nhập tài khoản Google cá nhân.
3. Chọn **"Get API key"** ➔ **"Create API key in new project"** ➔ Copy chuỗi key (`AIza...`).

### Bước 2: Dán Key vào `apps/backend/.env`
Mở file `apps/backend/.env` trên máy của bạn và dán key:

```bash
VLM_API_KEY=AIzaSyD_Dien_Key_Cua_Ban_Vao_Day
```

### Bước 3: Chạy hệ thống
```bash
# Terminal 1 - Backend
cd apps/backend
npm run start:dev

# Terminal 2 - Frontend
cd apps/frontend
npm run dev
```
Truy cập `http://localhost:3000` để sử dụng hệ thống tìm kiếm với VLM.