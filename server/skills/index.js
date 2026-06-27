const BASE_SKILLS = new Set(['general-engineering.md', 'safe-change-policy.md', 'jira-ticket-triage.md', 'code-quality.md']);

const STACK_SKILL_MAP = {
  dotnet: ['abp-framework.md', 'dotnet-exporter-contracts.md', 'api-contract-compatibility.md', 'db-migration-guardrails.md', 'verification-playbook.md'],
  // ASP.NET Zero / ABP Angular shell: menus, i18n, Metronic icons live in Angular; always pair with abp-framework when stack is angular.
  angular: ['abp-framework.md', 'api-contract-compatibility.md', 'verification-playbook.md'],
  nodejs: ['api-contract-compatibility.md', 'verification-playbook.md'],
};

const KEYWORD_SKILL_MAP = [
  { pattern: /\b(auth|authorize|permission|role|token|secret|password|security|xss|csrf)\b/i, skills: ['security-and-secrets.md'] },
  { pattern: /\b(db|database|sql|migration|schema|table|index|query|postgres)\b/i, skills: ['db-migration-guardrails.md'] },
  { pattern: /\b(api|endpoint|dto|contract|payload|response|request|proxy)\b/i, skills: ['api-contract-compatibility.md'] },
  { pattern: /\b(excel|export|exporter|report|csv|station|source)\b/i, skills: ['dotnet-exporter-contracts.md'] },
  { pattern: /\b(menu|sidebar|navigation|flaticon|metronic|app-menu|app-navigation|navigation\.service|permission\s*name|route\s*menu)\b/i, skills: ['abp-framework.md'] },
  { pattern: /\b(localization|localisation|i18n|translate|language\s*key)\b/i, skills: ['abp-framework.md'] },
  { pattern: /\b(build|test|verify|compile|lint|ci|pipeline)\b/i, skills: ['verification-playbook.md', 'error-log-troubleshooting.md'] },
  { pattern: /\b(commit|branch|push|pr|pull request|merge)\b/i, skills: ['git-safety-and-pr.md'] },
  { pattern: /\b(error|bug|exception|fail|failing|stack trace|crash|fix)\b/i, skills: ['error-log-troubleshooting.md'] },
];

const selectRelevantSkillFiles = (allSkillFiles, stacks, ticketDetails, additionalContext) => {
  const selected = new Set();
  const available = new Set(allSkillFiles);

  for (const file of BASE_SKILLS) {
    if (available.has(file)) selected.add(file);
  }

  for (const stack of stacks || []) {
    const mapped = STACK_SKILL_MAP[stack] || [];
    for (const file of mapped) {
      if (available.has(file)) selected.add(file);
    }
  }

  const contextText = `${ticketDetails?.summary || ''}\n${ticketDetails?.description || ''}\n${additionalContext || ''}`;
  for (const rule of KEYWORD_SKILL_MAP) {
    if (rule.pattern.test(contextText)) {
      for (const file of rule.skills) {
        if (available.has(file)) selected.add(file);
      }
    }
  }

  if (selected.size < Math.min(4, allSkillFiles.length)) {
    for (const file of allSkillFiles) selected.add(file);
  }

  return Array.from(selected);
};

module.exports = {
  BASE_SKILLS,
  STACK_SKILL_MAP,
  KEYWORD_SKILL_MAP,
  selectRelevantSkillFiles,
};
