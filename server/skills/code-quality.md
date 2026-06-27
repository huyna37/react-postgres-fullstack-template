---
name: code-quality
description: Ensure precise file editing, high-quality code, and comprehensive comments for Jira tickets. Use this skill to enforce best practices in code modifications and documentation.
---

# Precise Code Implementation & Documentation

This skill ensures that all code modifications are precise, follow project standards, and are well-documented both in-code and in ticket responses.

## Precise Editing
- **Surgical Changes**: Prefer using the "edits" (search-replace blocks) instead of providing full file "content" whenever possible. This ensures only the necessary lines are touched and avoids accidental formatting changes.
- **Unique Search Blocks**: When using search-replace, ensure your "search" block is unique and contains enough context (at least 3-5 lines if possible) to accurately target the desired location.
- **Maintain Style**: Adhere to the existing coding style (indentation, naming conventions, etc.).
- **Verify Imports**: Ensure all necessary imports are added and unused ones are removed.

## Comprehensive Commenting
- **In-Code Comments**: Add clear, concise comments for complex logic.
- **Jira Documentation**: When summarizing changes, explain *why* something was changed, not just *what*.
- **Task Linkage**: If a change relates to a specific part of a ticket requirement, mention it.

## Best Practices
- **DRY Principle**: Don't repeat yourself. Use existing helpers if available.
- **Error Handling**: Include proper error handling and logging for new logic.
- **Performance**: Be mindful of performance implications, especially in loops or DB queries.

**CRITICAL**: Every modification should leave the codebase cleaner and better documented than before.
