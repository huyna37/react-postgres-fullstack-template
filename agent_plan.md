ARCHITECTURE & IMPLEMENTATION PLAN: MULTI-STACK AI AGENT INTEGRATION
1. Objective
Xây dựng tính năng "AI Coding Assistant" có khả năng xử lý đa ngôn ngữ (Polyglot) tích hợp vào Dashboard Ticket. Agent phải tự động thích nghi với từng loại project (Backend .NET, Node.js, Frontend Angular) để phân tích, sửa code và chạy môi trường Runtime Dev tương ứng.

2. Core Components
Trigger: Button "AI Agent Fix" trên giao diện List Ticket.

Orchestrator: Antigravity (Quản lý luồng: Detect Stack -> Plan -> Search -> Code -> Run).

Inference Engine: Gemini 3 Flash (Tối ưu cho việc đọc hiểu nhiều loại cú pháp ngôn ngữ nhanh chóng).

Workspace: Container Linux "All-in-one" tích hợp sẵn các SDK: .NET 8, Node.js (LTS), Angular CLI, và các công cụ bổ trợ như jq, grep, ripgrep.

3. Step-by-Step Execution Plan
Giai đoạn 1: Multi-Language Detection & Context Acquisition
Input: Ticket ID, Title, Description và Metadata.

Action:

Agent quét root directory để nhận diện loại dự án:

Nếu thấy .csproj/.sln: Xác định là ASP.NET Core.

Nếu thấy package.json và angular.json: Xác định là Angular.

Nếu thấy package.json mà không có Angular: Xác định là Node.js/Express.

Đọc các file cấu hình tiêu chuẩn (.rules, .cursorrules) để áp dụng đúng quy chuẩn của từng ngôn ngữ.

Giai đoạn 2: Reasoning & Planning (Language-Specific)
Action: Agent lập kế hoạch sửa đổi dựa trên đặc thù ngôn ngữ:

Backend: Chú ý Dependency Injection, Entity Mapping và Database Transaction.

Frontend: Chú ý Component Lifecycle, Service Injection và RxJS.

Giai đoạn 3: Universal Code Implementation & Runtime Dev
Action: Generate code diff bằng Gemini 3 Flash.

Adaptive Run Command: Sau khi sửa, Agent tự động kích hoạt chế độ chạy thử dựa trên kết quả nhận diện ở Giai đoạn 1:

Dự án .NET: Thực thi dotnet watch run.

Dự án Node.js: Thực thi npm run dev hoặc nodemon.

Dự án Angular: Thực thi ng serve --host 0.0.0.0 --disable-host-check.

Persistence: Lưu trạng thái code dạng Runtime Save (Git commit tạm) để người dùng có thể truy cập vào container và kiểm tra kết quả ngay lập tức.

Giai đoạn 4: Cross-Stack Verification & Feedback Loop
Action:

Compile Check: Phân tích log lỗi đặc thù (ví dụ: lỗi TypeScript của Angular khác với lỗi MSBuild của .NET).

Health Check: Gọi thử API hoặc check trạng thái render của UI để đảm bảo runtime đã sẵn sàng.

Log Extraction: Đẩy log từ tiến trình đang chạy về Dashboard để người dùng theo dõi.

Giai đoạn 5: Finalization
Action:

Tạo Git Branch theo format: ai-fix/ticket-[id].

Tự động tạo Pull Request (PR) mô tả các thay đổi trên cả Backend và Frontend nếu ticket yêu cầu sửa đổi cả hai.

4. Technical Constraints & Conventions
ABP Framework (.NET): Tuân thủ Domain-Driven Design (DDD).

Modern Frontend (Angular): Đảm bảo không làm hỏng cấu trúc Module/Standalone components.

Database (PostgreSQL): Giữ nguyên logic Partitioning cho các bảng dữ liệu lớn như TransportTransactions.

Batch Processing: Ưu tiên dùng Dapper cho các logic xử lý dữ liệu nặng trong dự án .NET.