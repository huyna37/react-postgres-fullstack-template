# Security and Secrets Skill

## Objective
Prevent leaking credentials and introducing security regressions during automated fixes.

## Secret Handling Rules
1. Never hardcode API keys, passwords, tokens, or connection strings.
2. Never print secrets in logs, commit messages, or Telegram notifications.
3. Keep credentials in environment variables or approved secret storage.
4. Do not modify `.env` templates unless ticket explicitly requests it.

## Git Safety Rules
1. Avoid committing files that likely contain secrets (`.env`, key files, credential dumps).
2. If a secret is detected in generated output, stop and redact before continuing.

## Web/API Security Checks
1. Validate and sanitize user input in controllers/services.
2. Enforce authorization for sensitive endpoints.
3. Do not disable security middleware as a workaround.
4. Preserve existing rate-limit, auth, and permission checks.

## Logging Rules
1. Log high-level context only, not raw sensitive payloads.
2. Mask secret-like strings (token, password, cookie, authorization headers).
