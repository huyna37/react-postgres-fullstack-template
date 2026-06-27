# Git Safety and PR Skill

## Objective
Create clean, reviewable branches and commits aligned with ticket intent.

## Branch and Commit
1. Use branch naming format `ai-fix/[ticket-key]`.
2. Keep commits focused on one logical change set.
3. Commit message should include ticket key and intent.

## Pre-Push Checklist
1. Review changed files for unrelated edits.
2. Ensure no secrets or local-only config files are staged.
3. Confirm verification commands passed for impacted stack.
4. Ensure generated artifacts are committed only when repository convention requires.

## PR Guidance
1. Title format: `[TICKET-KEY] short purpose`.
2. Include summary, risks, test evidence, and rollback notes.
3. Mention cross-stack impact (backend/frontend/db) explicitly.
