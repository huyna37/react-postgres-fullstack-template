/** SQL fragment — loại ticket đã hủy / cancelled. */
const EXCLUDE_CANCELLED_SQL = `
  AND LOWER(COALESCE(i.status, '')) NOT LIKE '%cancel%'
  AND LOWER(COALESCE(i.status, '')) NOT LIKE '%hủy%'
  AND LOWER(COALESCE(i.status, '')) NOT LIKE '%huy%'
`;

/** SQL fragment — loại ticket bị reject / từ chối. */
const EXCLUDE_REJECTED_SQL = `
  AND LOWER(COALESCE(i.status, '')) NOT LIKE '%reject%'
  AND LOWER(COALESCE(i.status, '')) NOT LIKE '%từ chối%'
  AND LOWER(COALESCE(i.status, '')) NOT LIKE '%tu choi%'
`;

const EXCLUDE_CANCELLED_REJECTED_SQL = `${EXCLUDE_CANCELLED_SQL}\n${EXCLUDE_REJECTED_SQL}`;

function isCancelledIssueStatus(status) {
  const st = String(status || '').toLowerCase();
  return st.includes('cancel') || st.includes('hủy') || st.includes('huy');
}

function isRejectedIssueStatus(status) {
  const st = String(status || '').toLowerCase();
  return st.includes('reject') || st.includes('từ chối') || st.includes('tu choi');
}

function isSkippedAgentIssueStatus(status) {
  return isCancelledIssueStatus(status) || isRejectedIssueStatus(status);
}

module.exports = {
  EXCLUDE_CANCELLED_SQL,
  EXCLUDE_REJECTED_SQL,
  EXCLUDE_CANCELLED_REJECTED_SQL,
  isCancelledIssueStatus,
  isRejectedIssueStatus,
  isSkippedAgentIssueStatus,
};
