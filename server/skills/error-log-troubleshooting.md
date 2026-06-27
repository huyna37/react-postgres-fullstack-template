# Error Log Troubleshooting Skill

## Objective
Turn failing verification output into the smallest corrective patch quickly.

## Debug Loop
1. Capture exact failing command and first actionable error.
2. Classify error type: syntax, type, dependency, runtime config, test assertion.
3. Locate nearest relevant file/function and patch only local cause first.
4. Re-run the same verification command before broader checks.

## Stack-Specific Hints
### Node.js / TypeScript
1. Start with module resolution, import path, and type mismatches.
2. Verify script names in `package.json` before invoking commands.

### Angular
1. Check template bindings, missing module imports, and DI providers.
2. Watch for strict template/type errors caused by nullable values.

### .NET
1. Check namespace/type rename mismatches and missing references.
2. Verify dependency injection registrations and constructor signatures.
3. Check nullable reference warnings treated as errors.

## Output Discipline
1. Report the error in concise plain text.
2. Explain root cause hypothesis in one paragraph.
3. Apply focused fix and re-verify.
