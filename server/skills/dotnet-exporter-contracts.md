# .NET Exporter Contract Skill

## Objective
Prevent compile-time and mapping regressions when fixing Excel/CSV export features in ASP.NET Core.

## Mandatory Checks (Before Editing)
1. Locate exporter interface and implementation pair (`I*ExcelExporter` and `*ExcelExporter`).
2. Locate DTO used by exporter (`*Dto` in `.Application.Shared`) and confirm exact property names.
3. Locate AppService query/projection that fills DTO fields.

## Mapping Rules
1. Never map exporter columns to guessed properties.
2. Use only DTO properties that actually exist in code.
3. If a property is missing (e.g. `Source`), either:
   - map to existing equivalent property (e.g. `SourceName`, `TransactionSourceName`), or
   - add the property to DTO + projection + interface-aware call chain in same patch.
4. Keep header label and mapped property semantically aligned.

## Compile Guardrails
1. Prevent `CS1061`: verify every mapped property exists on DTO/class.
2. Prevent `CS0246`: verify base exporter type/usings exist in the project before changing inheritance.
3. Prevent `CS0535/CS0738`: keep interface and implementation signatures identical.

## Export-Specific Notes
1. `STT` (serial/index) should be generated from row index, not expected from DB entity.
2. Station/source display columns must be mapped from DTO display fields, not raw foreign keys.
3. Do not update frontend table columns unless ticket explicitly requests UI scope.

## Pre-Verify Checklist
1. Re-open DTO file and exporter file to cross-check every mapped field.
2. Build stack-specific project (`dotnet build`) before finalizing.
3. If build fails, patch only exporter/DTO projection path first (minimal change strategy).
