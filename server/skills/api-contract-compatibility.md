# API Contract Compatibility Skill

## Objective
Preserve client-server compatibility while implementing ticket fixes.

## Contract Rules
1. Do not silently change response shape for existing endpoints.
2. Keep required request fields stable unless ticket explicitly demands changes.
3. Maintain error response conventions used by current clients.
4. If contract must change, apply versioning or backward-compatible fallback.

## DTO and Mapping Checks
1. Ensure backend DTO updates are mirrored in frontend service models/proxies.
2. Validate enum/string constants stay aligned across stacks.
3. Keep serialization naming consistent (camelCase/PascalCase per project convention).

## Verification
1. Re-check impacted frontend calls after backend changes.
2. Validate list/detail/create/update endpoints touching modified entities.
3. Include one contract-level smoke test scenario in reasoning output.
