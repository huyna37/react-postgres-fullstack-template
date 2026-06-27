export interface JiraTicket {
  summary: string;
  description: string;
  issueType: string;
  priority: string;
  labels: string[];
  components: string[];
  acceptanceCriteria: string[];
  technicalNotes: string[];
  risks: string[];
  suggestedTeam: string;
  estimatedComplexity: string;
  assignee?: string;
  subTickets?: JiraTicket[];
  status?: string;
  id?: string;
  jiraKey?: string;
}

export interface User {
  id?: number;
  username: string;
  role: 'admin' | 'user';
  jira_token?: string;
  jira_project?: string;
  theme_preference?: 'light' | 'dark';
  permissions?: string[];
}
