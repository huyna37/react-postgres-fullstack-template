# Jira Ticket Triage Skill

## Objective
Convert Jira ticket text into a precise implementation target before writing code.

## Triage Checklist
1. **Restate Goal**: Rewrite ticket summary in one sentence with expected outcome.
2. **Acceptance Criteria**: Extract explicit pass/fail criteria from description and comments.
3. **Scope Boundaries**: Mark what is in-scope and out-of-scope.
4. **Affected Areas**: List likely backend, frontend, database, and integration surfaces.
5. **Risk Flags**: Note any data loss, auth, permission, or performance concerns.
6. **Missing Info**: Identify unclear points and state safe assumptions if blocking.

## Implementation Guardrails
1. Do not start broad refactors when ticket asks for a focused fix.
2. Prefer existing project conventions over new patterns.
3. If ticket is ambiguous, choose the smallest reversible change.

## Output Structure
Before coding, produce:
- Problem statement
- Proposed fix strategy
- Files likely impacted
- Verification steps mapped to acceptance criteria
