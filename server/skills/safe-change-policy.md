# Safe Change Policy Skill

## Goal
Minimize regression risk while delivering ticket-required behavior.

## Core Principles
1. **Smallest Effective Change**: Touch only files and lines necessary for the ticket.
2. **Preserve Behavior**: Do not alter unrelated flows, APIs, or UI behavior.
3. **No Full-File Rewrite**: Avoid replacing entire files unless required by framework constraints.
4. **Backward Compatibility**: Keep interfaces stable unless ticket explicitly allows breaking change.
5. **Deterministic Edits**: Avoid random naming and inconsistent code style.

## Editing Rules
1. Reuse nearby patterns (error handling, logging, DTO mapping, naming).
2. Keep comments concise and only for non-obvious logic.
3. Remove temporary debug artifacts (`console.log`, commented-out code).
4. Avoid introducing new dependencies unless strictly necessary.

## Failure Recovery
1. If verification fails, diagnose root cause from logs and patch incrementally.
2. Prefer 1-2 targeted follow-up edits over speculative broad changes.
