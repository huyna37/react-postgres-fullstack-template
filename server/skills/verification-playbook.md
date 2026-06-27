# Verification Playbook Skill

## Objective
Validate changes with the fastest meaningful checks first, then deeper checks if needed.

## General Order
1. Run targeted checks for changed stack/module.
2. Run lint/type checks when available.
3. Run build as final compile confidence.
4. Prefer failing fast and reporting exact command output snippet.

## Node.js
1. If available, run `npm run lint`.
2. If available, run `npm run test -- --runInBand` or project equivalent.
3. Run `npm run build` when build script exists.

## Angular
1. Run `npm run lint` when configured.
2. Run `npm run test -- --watch=false --browsers=ChromeHeadless` when configured.
3. Run `npm run build` or `ng build --configuration development`.
4. Watch for TS template errors and dependency injection errors.

## .NET
1. Run `dotnet restore` only if necessary.
2. Run `dotnet build` on `.sln` or target `.csproj`.
3. Run `dotnet test` for affected test project if present.
4. Watch for nullable warnings promoted to errors and DI registration failures.

## Reporting Format
1. Commands executed
2. Result per command (pass/fail)
3. First actionable error (if fail)
4. Suggested next patch
