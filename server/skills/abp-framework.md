# ABP Framework Expert Skill

**Jira Agent:** add `abp-framework.md` to the project’s **selected_skills** (cấu hình dự án) for ASP.NET Zero + Angular repos so this file is always injected into prompts.

## Overview
The project uses ABP Framework (ASP.NET Core + Angular). Follow these rules when modifying code.

**Planning trong Jira Agent:** trước đó một bước **LLM path-suggest** đọc ticket + skill + pool path repo để đưa thêm path ưu tiên vào **FILE CANDIDATES**. Prompt lập kế hoạch gồm **EXPERT SKILLS** + **REPO FILE INDEX** + **FILE CANDIDATES**. Đọc skill + index, chọn path khớp ticket (menu Angular: `app-navigation.service.ts` / provider / `NavigationProvider` tùy repo); `target_files` **chỉ** chứa path có trong CANDIDATES — không hallucinate.

## Backend (ASP.NET Core)
1. **DTOs**: Always check for DTOs in `.Application.Shared`. Do not modify Entity classes unless absolutely necessary.
2. **App Services**: Logic should be in `*AppService.cs`.
3. **Permissions**: Check if new methods need `[AbpAuthorize]` or custom permissions.
4. **Validation**: Use `DataAnnotations` or `IValidatableObject` in DTOs.
5. **Localization**: Use `L("KeyName")` for strings.
6. **Interface Contract First (Critical)**:
   - Before changing any class method signature, find and verify related interfaces (`I*`).
   - Ensure class method signatures exactly match interface signatures (parameter types/order, return type, async/sync).
   - If interface uses `IReadOnlyList<T>`, class must not silently switch to `List<T>` (or vice versa) unless interface is updated too.
   - When updating exporter/app-service contracts, update both interface and implementation in the same patch.
7. **Cross-layer Contract Sync**:
   - If `.Application` class changes DTO/method signatures, verify `.Application.Shared` interfaces/DTOs remain consistent.
   - Re-check all implementations of the same interface to avoid partial updates.
8. **Compilation Guardrails**:
   - Anticipate and prevent `CS0535`, `CS0738`, `CS0246` by checking:
     - missing interface member implementation,
     - mismatched return type/signature,
     - missing namespace/usings after DTO refactor.
   - For nullable annotations (`?`), ensure project nullable context is compatible before introducing new nullable syntax.

## Frontend (Angular)
1. **Service Proxies**: 
   - Use generated `*ServiceProxy` to call backend APIs. 
   - **CRITICAL**: Before using a service (e.g., `this._stationServiceProxy`), verify it is declared as a private member AND injected in the `constructor`.
   - Ensure the service name matches the one generated in `service-proxies.ts`.
   - Sau khi đổi DTO/AppService phía .NET: chạy **`npm run nswag`** (hoặc `nswag-linux`) trong `angular/` — không sửa tay file proxy lớn.
2. **Components**: 
   - Use `AppComponentBase` for common features (localization, loading, notify).
   - **CRITICAL**: Every component class must have a `@Component({...})` decorator. Do not delete it during edits.
3. **Common Table & Filters**:
   - The project often uses `CommonTableComponent` with `FilterAndControlConfig`.
   - **Filter Types**: Valid types for `FilterConfig` are usually `text`, `select`, `date`, `datetime`. **DO NOT use `dropdown`**; use `select` instead.
   - For `select` filters, ensure `dropdownConfig` is provided with `options` (usually an `Observable` using `of([...])`).
4. **Imports**:
   - Services and DTOs are typically imported from `@shared/service-proxies/service-proxies`.
   - Always check if a new import is needed when adding a service or a model.
5. **Styles**: Use existing theme variables and PrimeNG/Metronic classes if available.
6. **Moments**: When handling dates, use `moment` as per project convention, but be careful with timezones (UTC vs Local).

## Angular UI — Menu, sidebar, icons (ASP.NET Zero / Metronic)

Use when the ticket mentions **menu**, **sidebar**, **navigation**, **icon** (`flaticon-*`), **duplicate icon**, **đổi icon**, **mục menu**, v.v.

### Single source of truth — menu list + icons (bắt buộc)

**Toàn bộ cây menu (items, `icon`, `route`, `permission`, `children`) nằm trong service navigation — không đoán file khác.**

1. **File chính (ưu tiên tuyệt đối cho `target_files` và patch):**
   - `angular/src/app/shared/layout/nav/app-navigation.service.ts`
   - Nếu repo đặt tên lệch chữ: `app-navigation.services.ts` (có thêm `s`) — vẫn là **cùng vai trò**: chứa **dữ liệu** menu, **không** phải file interface.
2. **Trước khi chọn bất kỳ path nào khác:** mở đúng file trên (hoặc `**/shared/layout/nav/app-navigation.service.ts` / `app-navigation.services.ts` từ `git ls-files`). Đây là nơi sửa **icon**, **thứ tự menu**, **route/permission** của từng mục.
3. **`app-menu.ts` (cùng thư mục `layout/nav`):** gần như **chỉ** định nghĩa **interface / type** (`AppMenuItem`, …). **Không** đưa `app-menu.ts` vào `target_files` cho ticket chỉ đổi icon / sửa mục menu / trùng icon — trừ khi ticket **explicitly** yêu cầu đổi **kiểu** menu (thêm field trên interface).

**Cấm:** liệt kê hoặc ưu tiên patch các file “lân cận” mơ hồ (sidebar random, component `main/...`, `*-menu.config.ts`…) khi chưa xác nhận ticket **không** liên quan tới `app-navigation.service.ts`. Nếu không chắc, **grep `flaticon-` trong `shared/layout/nav/`** — file có **nhiều** `flaticon-` cùng `route`/`permission` chính là `app-navigation.service.ts` (hoặc tên tương đương ở trên).

### Icons (`flaticon-*`)

- Chỉnh **`icon`** trong object menu **bên trong `app-navigation.service.ts`** (hoặc `app-navigation.services.ts`).
- Dùng class `flaticon-*` đã có sẵn trong cùng file / cùng project để đồng bộ Metronic.
- Một ticket “đổi icon một mục” → **một** object menu: `search`-replace đủ context (`name` / `route` / `permission` của mục đó) để không trúng mục cha hoặc mục khác.

### Localization (tiêu đề menu)

**Chữ hiển thị** theo key `name` trong **cùng** file navigation service; bản dịch nằm XML (backend, xem mục **Backend → Localization**) hoặc JSON `i18n` (Angular):

| Layer | Typical location |
|--------|------------------|
| Backend (.NET), XML source | `*.Core/Localization/SourceFiles/**/*.xml` … |
| Angular ngx-translate JSON | `angular/src/assets/i18n/*.json` |

**Wrong label:** lấy `name` từ **`app-navigation.service.ts`** → grep key trong XML / JSON → sửa mọi ngôn ngữ cần ship.

**Icon only:** **chỉ** `app-navigation.service.ts` (hoặc `app-navigation.services.ts`). **Không** sửa XML trừ khi đổi tên feature / key.

### Search-replace reliability

- Context đủ dài: khối object có `name` + `route` hoặc `permission` + dòng `icon` hiện tại.
- Khớp đúng casing (`icon` vs lỗi gõ `Icon` theo file thật).

### Verification (Angular / Zero)

- Theo script chính thức của repo (`ng build`, `npm run publish`, …). Không bỏ qua bước template đã document.
