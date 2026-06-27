import React from 'react';
import JiraTicketKeyLink from './JiraTicketKeyLink';
import {
  getIssueTypeStyle,
  getStatusColor,
  isDevSubtask,
  isDevTaskDone,
  isTestTask,
  isBugSubtask,
} from '../utils/testerTaskHelpers';

export type TesterTaskCardTask = {
  id: string;
  key: string;
  summary: string;
  status: string;
  statusCategory?: string;
  issueType?: string;
  isSynthesized?: boolean;
  originalEstimate?: number;
  assignee?: { displayName: string } | null;
  creator?: string | null;
  subTasks?: any[];
  updated?: string | null;
};

type TesterTaskCardProps = {
  task: TesterTaskCardTask;
  isActive: boolean;
  isLight: boolean;
  onSelect: (key: string) => void;
  onOpenJira: (key: string) => void;
};

function formatUpdateDate(dateStr?: string | null) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  const day = d.getDate().toString().padStart(2, '0');
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const hours = d.getHours().toString().padStart(2, '0');
  const minutes = d.getMinutes().toString().padStart(2, '0');
  return `CN: ${day}/${month} ${hours}:${minutes}`;
}

function shortAssigneeName(displayName?: string | null) {
  const trimmed = String(displayName || '').trim();
  if (!trimmed) return '—';
  const parts = trimmed.split(/\s+/);
  return parts[parts.length - 1] || trimmed;
}

type AssigneeStat = {
  key: string;
  shortName: string;
  fullName: string;
  done: number;
  total: number;
};

function buildAssigneeStats(
  subs: any[],
  isDone: (sub: any) => boolean
): AssigneeStat[] {
  const map = new Map<string, AssigneeStat>();
  for (const sub of subs) {
    const fullName = sub.assignee?.displayName?.trim() || 'Chưa gán';
    const key = sub.assignee?.accountId || sub.assignee?.emailAddress || fullName;
    const entry =
      map.get(key) ||
      ({
        key,
        shortName: shortAssigneeName(fullName),
        fullName,
        done: 0,
        total: 0,
      } satisfies AssigneeStat);
    entry.total += 1;
    if (isDone(sub)) entry.done += 1;
    map.set(key, entry);
  }
  return [...map.values()].sort((a, b) => a.shortName.localeCompare(b.shortName, 'vi'));
}

function SubtaskGroupBlock({
  kind,
  subs,
  isDone,
}: {
  kind: 'dev' | 'test' | 'bug';
  subs: any[];
  isDone: (sub: any) => boolean;
}) {
  if (subs.length === 0) return null;

  const doneCount = subs.filter(isDone).length;
  const people = buildAssigneeStats(subs, isDone);
  const label = kind === 'dev' ? 'DEV' : kind === 'test' ? 'TEST' : 'BUG';
  const maxVisible = 3;
  const visiblePeople = people.slice(0, maxVisible);
  const hiddenCount = people.length - visiblePeople.length;

  return (
    <div className={`tester-sub-group tester-sub-group--${kind}`}>
      <div className="tester-sub-group__head">
        <span className="tester-sub-group__label">{label}</span>
        <span className="tester-sub-group__count">
          {doneCount}/{subs.length}
        </span>
      </div>
      <div className="tester-sub-group__people">
        {visiblePeople.map(person => {
          const allDone = person.done === person.total && person.total > 0;
          const progress =
            person.total > 1 ? `${person.done}/${person.total}` : allDone ? '✓' : null;
          return (
            <span
              key={person.key}
              className={`tester-sub-person${allDone ? ' tester-sub-person--done' : ''}`}
              title={`${person.fullName}: ${person.done}/${person.total} xong`}
            >
              <span className="tester-sub-person__name">{person.shortName}</span>
              {progress ? (
                <span className="tester-sub-person__progress" aria-hidden>
                  {progress}
                </span>
              ) : null}
            </span>
          );
        })}
        {hiddenCount > 0 ? (
          <span
            className="tester-sub-person tester-sub-person--more"
            title={people
              .slice(maxVisible)
              .map(p => `${p.fullName} (${p.done}/${p.total})`)
              .join('\n')}
          >
            +{hiddenCount}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function TesterTaskCardInner({
  task,
  isActive,
  isLight,
  onSelect,
  onOpenJira,
}: TesterTaskCardProps) {
  const testSubs = task.subTasks?.filter(s => isTestTask(s)) || [];
  const devSubs = task.subTasks?.filter(s => isDevSubtask(s)) || [];
  const bugSubs = task.subTasks?.filter(s => isBugSubtask(s)) || [];
  const statusColors = getStatusColor(task.statusCategory || '', isLight);
  const typeStyle = getIssueTypeStyle(task.issueType, isLight);

  return (
    <div
      onClick={() => onSelect(task.key)}
      className={`tester-task-card hover-glow${isActive ? ' is-active' : ''}${task.isSynthesized ? ' is-orphan' : ''}`}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          marginBottom: '0.5rem',
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            fontSize: '0.65rem',
            padding: '1px 6px',
            borderRadius: '3px',
            background: typeStyle.bg,
            color: typeStyle.color,
            border: typeStyle.border,
            fontWeight: 700,
          }}
        >
          {task.issueType}
        </span>
        <JiraTicketKeyLink
          issueKey={task.key}
          onOpen={onOpenJira}
          className="tester-task-card__key jira-ticket-key-link"
          style={{ color: typeStyle.color } as React.CSSProperties}
          stopPropagation
        />
        {task.isSynthesized && <span className="tester-badge tester-badge--warn">Mồ côi</span>}
        <span
          style={{
            fontSize: '0.62rem',
            fontWeight: 700,
            padding: '1px 6px',
            borderRadius: '8px',
            background: statusColors.bg,
            color: statusColors.text,
            border: `1px solid ${statusColors.border}`,
            marginLeft: 'auto',
          }}
        >
          {task.status}
        </span>
      </div>

      <h4 className="tester-task-card__summary">{task.summary}</h4>

      <div className="tester-task-card__footer">
        <div className="tester-task-card__footer-meta">
          <span className="tester-task-card__meta-muted">{formatUpdateDate(task.updated)}</span>
        </div>

        {devSubs.length > 0 || testSubs.length > 0 || bugSubs.length > 0 ? (
          <div className="tester-task-card__subs">
            <SubtaskGroupBlock kind="dev" subs={devSubs} isDone={isDevTaskDone} />
            <SubtaskGroupBlock
              kind="test"
              subs={testSubs}
              isDone={sub => sub.statusCategory?.toLowerCase() === 'done'}
            />
            <SubtaskGroupBlock kind="bug" subs={bugSubs} isDone={isDevTaskDone} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

const TesterTaskCard = React.memo(TesterTaskCardInner, (prev, next) => {
  return (
    prev.isActive === next.isActive &&
    prev.isLight === next.isLight &&
    prev.onSelect === next.onSelect &&
    prev.onOpenJira === next.onOpenJira &&
    prev.task === next.task
  );
});

export default TesterTaskCard;
