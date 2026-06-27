# General Engineering Excellence

## Debugging Workflow
1. **Locate**: Use provided file lists to find the most relevant files.
2. **Context**: Read surrounding code to understand the existing pattern.
3. **Reasoning**: Explain WHY a change is needed before providing the code.
4. **Minimalism**: Make the smallest change necessary to solve the problem.

## Git Guidelines
1. **Branching**: Use `ai-fix/[ticket-key]` (automatic).
2. **Commits**: Messages should be concise, e.g., "fix: adjust date range boundary in RevenueReport".
3. **Cleanup**: Do not leave commented-out code or console.logs.

## Language Specifics
- **C#**: Use PascalCase for methods/properties. Use async/await properly.
- **TypeScript**: Use camelCase for variables/methods. Use strong typing (avoid `any` if possible).
