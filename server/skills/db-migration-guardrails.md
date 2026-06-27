# Database Migration Guardrails Skill

## Objective
Keep schema and data changes safe, reversible, and compatible with production rollout.

## Rules
1. Avoid destructive operations unless ticket explicitly requires them.
2. Prefer additive migrations (new columns/tables/indexes) over breaking modifications.
3. Provide defaults or nullable transition strategy for new non-null fields.
4. Keep migration names descriptive and traceable to ticket intent.

## Compatibility Strategy
1. Ensure old application version can tolerate transitional schema when possible.
2. Use phased migration for high-risk data shape changes.
3. For large tables, avoid long-lock operations during peak usage windows.

## Validation
1. Verify ORM mapping/DTO alignment after schema changes.
2. Add or update integration checks that cover new query path.
3. Document rollback approach for each high-risk migration.
