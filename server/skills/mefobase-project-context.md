# MEFOBASE Core — Project context (ASP.NET Zero + Angular)

This document describes the project structure, conventions, and playbooks for the MEFOBASE project.

## Quick reference

| Aspect | Value |
|--------|-------|
| Backend | ASP.NET Core, target .NET 9.0 |
| Pattern | ASP.NET Zero / ABP-style, Clean Architecture |
| Frontend | Angular 15 |
| API clients | NSwag-generated proxies (do not edit manually) |
| UI language | Vietnamese-first (+ fallback English) |
| DB | EF Core 9.0, PostgreSQL |

## Repository layers

| Path | Role |
|------|------|
| `angular/` | SPA: feature modules, layout, NSwag clients |
| `aspnet-core/` | Backend solution |
| `aspnet-core/src/MEFOBASE.Core` | Entities, domain services, permissions, localization |
| `aspnet-core/src/MEFOBASE.Core.Shared` | Constants, enums (netstandard2.1) |
| `aspnet-core/src/MEFOBASE.Application` | Use cases, `*AppService.cs`, AutoMapper registrations |
| `aspnet-core/src/MEFOBASE.Application.Shared` | DTOs, `I*AppService` |
| `aspnet-core/src/MEFOBASE.EntityFrameworkCore` | DbContext, configs, migrations |
| `aspnet-core/src/MEFOBASE.Web.Core` | Controllers, filters, middleware |
| `aspnet-core/src/MEFOBASE.Web.Host` | Startup, Swagger, static assets |
| `aspnet-core/src/MEFOBASE.Migrator` | Migration CLI |

**Typical feature flow:** Entity (Core) → DbContext → DTO + `IAppService` → AppService → AutoMapper (`CustomDtoMapper.cs`) → Controller → NSwag → Angular proxy → Component.

## Angular layout

```
angular/src/app/
├── app.module.ts, app-routing.module.ts     # root shell
├── main/              # MainModule — most business logic (lazy)
├── revenue-costs/   # RevenueCostsModule
├── admin/           # tenant/user/role
├── supervision-post-inspection/
├── shared/          # service-proxies, layout, dynamic-form-sidebar, …
└── account/
```

**Route suggestions:**

- `/app/main/...` → `angular/src/app/main/` (see `main-routing.module.ts`)
- `/app/revenue-costs/...` → `angular/src/app/revenue-costs/`
- `/app/admin/...` → `angular/src/app/admin/`
- `/app/supervision-post-inspection/...` → supervision module

**Proxy:** `angular/src/shared/service-proxies/` — regenerate: `npm run nswag` (Windows) / `npm run nswag-linux`. Do not edit generated files; backend `Controller` + `I*AppService` + DTO is the source of truth.

**Run config:** `angular/src/assets/appconfig.json` (`remoteServiceBaseUrl`, etc.).

## Dev Commands

**Backend:** `cd aspnet-core` → `dotnet restore` → `dotnet build` → run `MEFOBASE.Web.Host`. EF: `dotnet ef migrations add …` / `database update` with project `MEFOBASE.EntityFrameworkCore`.

**Frontend:** `cd angular` → `npm install` → `npm start` (4200) → sau đổi API: `npm run nswag`.

## Localization (Đa ngôn ngữ)

- **Source of truth:**
    - Backend: `aspnet-core/src/MEFOBASE.Core/Localization/MEFOBASE/`
        - `MEFOBASE.xml` (Tiếng Anh/Gốc)
        - `MEFOBASE-vi.xml` (Tiếng Việt - quan trọng nhất)
- **Cách dùng:**
    - **Backend:** `L("KeyName")` (trong AppService hoặc Controller).
    - **Angular TS:** `this.l('KeyName')`.
    - **Angular HTML:** `{{ 'KeyName' | translate }}`.
- **Lưu ý:** Khi thêm label mới, phải thêm vào cả 2 file XML để tránh lỗi thiếu key khi chuyển ngôn ngữ.

## Menu & Navigation

- **Định nghĩa menu:** `angular/src/app/shared/layout/nav/app-navigation.service.ts`.
- **Cấu trúc:** Hàm `getMenu()` trả về một `AppMenu` chứa mảng các `AppMenuItem`.
- **Tham số AppMenuItem (BẮT BUỘC ĐÚNG THỨ TỰ):**
    1. `name`: Key localization (vd: `'TransactionETC'`).
    2. `permissionName`: Quyền truy cập (vd: `'Pages.Administration.TransportTransactions.List'`).
    3. `icon`: Tên icon (vd: `'toll'`, `'layers'`, `'flaticon-more'`).
    4. `route`: Đường dẫn Angular (vd: `'/app/admin/transport-transactions'`).
    5. `items`: Mảng menu con (đệ quy).
    6. `children`: Danh sách menu con (thường dùng chung với `items`).
    7. `target`: Target cửa sổ (vd: `'_blank'`).
- **Lưu ý cực kỳ quan trọng:** Khi sửa icon hoặc tên, **KHÔNG** được thay đổi số lượng tham số của `new AppMenuItem`. Nếu file gốc có 4 tham số, hãy giữ đúng 4. Nếu có 7, hãy giữ đúng 7. Tuyệt đối không tự ý "gộp" các tham số của menu con vào tham số của menu cha.

### Phạm vi sửa tối thiểu (tránh sửa quá đà)

- Chỉ chỉnh các dòng **trực tiếp** liên quan tới yêu cầu trong ticket / APPROVED PLAN; không “cải tiến” thêm permission, route, key localization hay đổi tên mục nếu không được nêu rõ.
- Không tự **đồng bộ** chuỗi trong code với tên báo cáo / tên feature / diễn đạt tiếng Việt trong Jira chỉ vì nghe hợp lý — trừ khi plan hoặc ticket yêu cầu đổi cụ thể.

### Ánh xạ yêu cầu → tham số `AppMenuItem` (chỉ sửa đúng cột)

| Yêu cầu trong ticket/plan | Được phép đổi (giữ nguyên phần còn lại) |
|---------------------------|----------------------------------------|
| Đổi icon sidebar/menu | Chỉ tham số thứ **3** (`icon`). |
| Đổi nhãn menu (localization) | Tham số **1** + file XML `MEFOBASE*.xml` nếu thêm/sửa key (theo mục Localization). |
| Đổi quyền truy cập mục | Tham số **2** (+ backend permission/provider nếu ticket yêu cầu). |
| Đổi URL màn | Tham số **route** (và routing module nếu cần). |

Nếu ticket chỉ nói một việc (vd. chỉ icon), **không** kết hợp đổi các ô khác trong bảng trên.

- **Quy tắc:** Thêm menu mới phải đi kèm với Permission tương ứng.

## Icons

- **Thư viện:** 
    - Sidebar: Chủ yếu dùng **flaticon-*** (Metronic) hoặc **Material Icons**.
    - Action buttons: Material Icons hoặc FontAwesome (`fa fa-*`).
- **Cách tìm:** Tra cứu tại [fonts.google.com/icons](https://fonts.google.com/icons) hoặc trong chính file `app-navigation.service.ts` để lấy các icon đã dùng.
- **Cách dùng:**
    - Trong menu: Truyền chuỗi tên icon (vd: `'flaticon-more'`, `'layers'`) vào tham số thứ 3 của `AppMenuItem`.
    - Trong HTML: `<i class="material-icons">icon_name</i>` hoặc `<i class="flaticon-more"></i>`.

## Project Conventions

- **Dropdown:** sort A-Z (Unicode), server-side paging, do not load full dataset when opening form.

## Quản lý Permissions (Quyền hạn)

- **Định nghĩa hằng số:** `aspnet-core/src/MEFOBASE.Core/Authorization/AppPermissions.cs`.
    - Phân cấp theo dạng `Pages.Administration.TransportTransactions.ExportReceipt`.
- **Đăng ký vào hệ thống:** `aspnet-core/src/MEFOBASE.Core/Authorization/AppAuthorizationProvider.cs`.
    - Phải đăng ký ở đây thì quyền mới xuất hiện trong UI quản lý Role/User.
- **Sử dụng:**
    - **Backend:** `[AbpAuthorize(AppPermissions.Pages_...)]` trên class hoặc method.
    - **Angular (Route):** `data: { permission: 'Pages. ...' }` trong module routing.
    - **Angular (HTML):** `*ngIf="permission.isGranted('Pages. ...')"` hoặc `v-if` (nếu dùng directive).

## AutoMapper & DTO Mapping

- **File cấu hình:** `aspnet-core/src/MEFOBASE.Application/CustomDtoMapper.cs`.
- **Quy tắc:**
    - Mapping 2 chiều: `configuration.CreateMap<Entity, EntityDto>().ReverseMap();`.
    - Luôn kiểm tra mapping khi thêm field mới vào Entity hoặc DTO.
    - Nếu field name khác nhau hoặc cần logic phức tạp, sử dụng `.ForMember(...)`.

## Database & Migrations

- **DbContext:** `aspnet-core/src/MEFOBASE.EntityFrameworkCore/EntityFrameworkCore/MEFOBASEDbContext.cs`.
- **Thêm Migration mới:**
    1. Chỉnh sửa Entity hoặc DbContext.
    2. Mở terminal tại `aspnet-core/src/MEFOBASE.EntityFrameworkCore`.
    3. Chạy lệnh: `dotnet ef migrations add Name_Of_Migration`.
    4. Cập nhật DB: `dotnet ef database update` (hoặc chạy project Migrator).
- **Lưu ý:** Tuyệt đối không sửa cấu trúc DB bằng tay (SQL scripts) mà không qua Migration.

## Xử lý Lỗi & Validation

- **Validation:** Sử dụng DataAnnotations trên DTO (vd: `[Required]`, `[MaxLength(255)]`).
- **UserFriendlyException:** Khi cần báo lỗi cho người dùng cuối (ví dụ: "Không có dữ liệu"), sử dụng `throw new UserFriendlyException(L("KeyName"));`.
- **Logging:** Sử dụng `Logger.Info()`, `Logger.Error()` để ghi log. Log mặc định lưu tại `aspnet-core/src/MEFOBASE.Web.Host/App_Data/Logs/`.
- **Status (domain example):** 1 = Pending, 2 = Active, 3 = Inactive (confirm in actual code/const).

## UI/UX (Vietnamese)

- Responsive: 1366×768, 1920×1080.
- Form Placeholder: "Nhập/Chọn + Title" (e.g., "Nhập Tên xe").
- List: Title format "Function Name > List"; include update time + user when required.
- Buttons: Thêm mới / Chỉnh sửa / Xóa bỏ / Kết xuất Excel — colors follow existing pattern; delete with confirmation.

## Ticket Playbooks

1. **UI Only:** `*.component.ts/html/scss`, `*-routing.module.ts` — template → style → logic → permission route.
2. **UI + API:** DTO → `IAppService` → AppService → `CustomDtoMapper` → Controller → **nswag** → component.
3. **Business / entity:** Core entity/const → AppService → EF config + migration → mapper → related screens.
4. **Permission / localization:** permission const + provider + route + XML / `this.l`.

## Fast Feature Locating

- By route → module directory.
- Endpoint `api/services/app/<X>/…` → `I<X>AppService` / `<X>AppService`.
- Search name: `*<Feature>*AppService*`, `*<Feature>*Controller*`, `*<Feature>*Dto*`, Angular folder.

## Files to open early

- `angular/src/app/app-routing.module.ts`
- `angular/src/app/main/main-routing.module.ts`
- `aspnet-core/src/MEFOBASE.Web.Core/Controllers/`
- `aspnet-core/src/MEFOBASE.Application.Shared/`
- `aspnet-core/src/MEFOBASE.Application/`
- `aspnet-core/src/MEFOBASE.EntityFrameworkCore/EntityFrameworkCore/MEFOBASEDbContext.cs`

## Agent Guardrails

- Confirm versions in `.csproj` / `package.json`.
- Do not read full `service-proxies.ts`; do not edit manually.
- Do not use `HttpClient` if a proxy exists.
- Do not hard-code user-facing strings; use localization.
- Menu/sidebar/icon: use navigation service in `shared/layout/nav/`.
- **Edit Reliability:** File lớn như `app-navigation.service.ts`: khối `search`/`replace` phải khớp từng ký tự với file; tuân thức **Phạm vi sửa tối thiểu** và bảng **Ánh xạ yêu cầu → tham số** ở mục Menu & Navigation (không đổi tham số không thuộc phạm vi ticket).
