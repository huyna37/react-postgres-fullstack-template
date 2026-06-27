const express = require('express');
const db = require('../db');
const { ymdInWorkTz } = require('../lib/jiraMonthFilter');
const {
  postIssueWorklog,
  resolveUserWorklogIdForReplace,
  deleteIssueWorklog,
  syncIssueWorklogsToDb,
} = require('../jiraWorklog');
const { requireUserJiraToken } = require('../lib/jiraToken');
const {
  fetchUserWorklogsFromDb,
  fetchLatestUserWorklogForIssue,
} = require('../lib/worklogFromDb');
const {
  fetchAutoLogworkCandidates,
  fetchIssueForAutoLogwork,
  searchIssuesForAutoLogwork,
  fetchUnderLoggedDays,
  fetchPersonalOtMonthDays,
} = require('../lib/autoLogworkFromDb');
const { savePersonalOtForDate } = require('../lib/personalOtFromDb');
const { mapWithConcurrency } = require('../lib/asyncPool');
const { closeIssuesOnJira } = require('../lib/jiraIssueClose');

const AUTO_LOGWORK_CONCURRENCY = 5;

module.exports = (context) => {
  const router = express.Router();
  const { authenticateToken, httpsAgent } = context;

  // ==========================================
  // Worklog Reporting & Replacement
  // ==========================================

  router.get('/api/worklogs', authenticateToken, async (req, res) => {
    const { year, month } = req.query;
    if (!year || !month) return res.status(400).json({ error: 'Missing year or month' });

    try {
      const result = await fetchUserWorklogsFromDb(db, {
        userId: req.user.id,
        year,
        month,
      });
      res.json(result);
    } catch (error) {
      console.error('DB Worklog Error:', error.message);
      res.status(500).json({ error: error.message || 'Failed to fetch worklogs from database' });
    }
  });

  router.get('/api/worklogs/for-issue/:issueKey', authenticateToken, async (req, res) => {
    const { issueKey } = req.params;
    const { year, month } = req.query;
    try {
      const worklog = await fetchLatestUserWorklogForIssue(db, req.user.id, issueKey, {
        year,
        month,
      });
      res.json({ worklog });
    } catch (error) {
      console.error('Worklog for-issue Error:', error.message);
      res.status(500).json({ error: error.message || 'Failed to fetch worklog for issue' });
    }
  });

  router.post('/api/worklogs', authenticateToken, async (req, res) => {
    const { issueKey, timeSpent, comment, started } = req.body;
    if (!issueKey || !timeSpent) {
      return res.status(400).json({ error: 'Thiếu issueKey hoặc timeSpent' });
    }
    const token = await requireUserJiraToken(db, req, res);
    if (!token) return;

    const issueTrim = String(issueKey).trim();
    const jiraBaseUrl = process.env.JIRA_URL;

    try {
      const createRes = await postIssueWorklog(jiraBaseUrl, issueTrim, {
        timeSpent: String(timeSpent).trim(),
        comment: comment != null ? String(comment) : '',
        started,
      }, token);
      try {
        await syncIssueWorklogsToDb(db, issueTrim, jiraBaseUrl, token);
      } catch (syncErr) {
        console.error('[Worklog] DB sync after POST:', syncErr.message);
      }
      res.json({ success: true, worklog: createRes.data });
    } catch (error) {
      const errData = error.response?.data;
      const msg = errData?.errorMessages?.join?.('; ')
        || (errData?.errors && JSON.stringify(errData.errors))
        || error.message
        || 'Lỗi Jira';
      const status = error.response?.status >= 400 && error.response?.status < 600 ? error.response.status : 500;
      console.error('Jira worklog POST:', errData || error.message);
      res.status(status).json({ error: msg });
    }
  });

  router.get('/api/worklogs/personal-ot', authenticateToken, async (req, res) => {
    const todayYmd = ymdInWorkTz(new Date());
    const defaultYear = Math.floor(todayYmd / 10000);
    const defaultMonth = Math.floor((todayYmd % 10000) / 100);
    const year = req.query.year ?? defaultYear;
    const month = req.query.month ?? defaultMonth;
    try {
      const result = await fetchPersonalOtMonthDays(db, req.user.id, year, month);
      res.json(result);
    } catch (error) {
      console.error('Personal OT month:', error.message);
      res.status(400).json({ error: error.message || 'Không tải được OT cá nhân' });
    }
  });

  router.put('/api/worklogs/personal-ot', authenticateToken, async (req, res) => {
    const { date, otHours } = req.body || {};
    try {
      const saved = await savePersonalOtForDate(db, req.user.id, date, otHours);
      res.json(saved);
    } catch (error) {
      console.error('Save personal OT:', error.message);
      res.status(400).json({ error: error.message || 'Không lưu được OT' });
    }
  });

  router.get('/api/worklogs/auto-distribute/under-logged-days', authenticateToken, async (req, res) => {
    const todayYmd = ymdInWorkTz(new Date());
    const defaultYear = Math.floor(todayYmd / 10000);
    const defaultMonth = Math.floor((todayYmd % 10000) / 100);
    const year = req.query.year ?? defaultYear;
    const month = req.query.month ?? defaultMonth;
    const minHours = req.query.minHours ?? 7;
    try {
      const result = await fetchUnderLoggedDays(db, req.user.id, year, month, minHours);
      res.json(result);
    } catch (error) {
      console.error('Auto logwork under-logged days:', error.message);
      res.status(400).json({ error: error.message || 'Không tải được ngày thiếu log' });
    }
  });

  router.get('/api/worklogs/auto-distribute/candidates', authenticateToken, async (req, res) => {
    const { date, logDate } = req.query;
    try {
      const result = await fetchAutoLogworkCandidates(db, req.user.id, date, logDate);
      res.json(result);
    } catch (error) {
      console.error('Auto logwork candidates:', error.message);
      res.status(400).json({ error: error.message || 'Không tải được danh sách ticket' });
    }
  });

  router.get('/api/worklogs/auto-distribute/search', authenticateToken, async (req, res) => {
    const { q, limit, logDate, planDate, date } = req.query;
    try {
      const result = await searchIssuesForAutoLogwork(
        db,
        req.user.id,
        q,
        limit,
        logDate,
        planDate || date
      );
      res.json(result);
    } catch (error) {
      console.error('Auto logwork search:', error.message);
      res.status(400).json({ error: error.message || 'Không tìm được ticket' });
    }
  });

  router.get('/api/worklogs/auto-distribute/issue/:issueKey', authenticateToken, async (req, res) => {
    try {
      const issue = await fetchIssueForAutoLogwork(
        db,
        req.user.id,
        req.params.issueKey,
        req.query.logDate,
        req.query.planDate || req.query.date
      );
      if (!issue) {
        return res
          .status(404)
          .json({
            error:
              'Không tìm thấy ticket, không thuộc bạn, là Story/Epic, đã có logwork ngày ghi log, hoặc hết est còn lại',
          });
      }
      res.json({ issue });
    } catch (error) {
      res.status(400).json({ error: error.message || 'Lỗi tra cứu ticket' });
    }
  });

  router.post('/api/worklogs/auto-distribute/apply', authenticateToken, async (req, res) => {
    const { entries, started } = req.body || {};

    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: 'Thiếu danh sách entries' });
    }

    const token = await requireUserJiraToken(db, req, res);
    if (!token) return;

    const jiraBaseUrl = process.env.JIRA_URL;
    const startedIso = started ? new Date(started).toISOString() : new Date().toISOString();

    const results = await mapWithConcurrency(entries, AUTO_LOGWORK_CONCURRENCY, async entry => {
      const issueKey = String(entry?.issueKey || '').trim();
      const timeSpent = String(entry?.timeSpent || '').trim();
      if (!issueKey || !timeSpent) {
        return { issueKey: issueKey || '?', ok: false, error: 'Thiếu issueKey hoặc timeSpent' };
      }

      try {
        await postIssueWorklog(
          jiraBaseUrl,
          issueKey,
          {
            timeSpent,
            comment: entry.comment != null ? String(entry.comment) : '',
            started: entry.started || startedIso,
          },
          token
        );
        return { issueKey, ok: true, timeSpent };
      } catch (error) {
        const errData = error.response?.data;
        const msg =
          errData?.errorMessages?.join?.('; ') ||
          (errData?.errors && JSON.stringify(errData.errors)) ||
          error.message ||
          'Lỗi Jira';
        console.error(`[AutoLogwork Apply] Worklog failed for ${issueKey}:`, msg);
        return { issueKey, ok: false, error: msg };
      }
    });

    const okKeys = results.filter(r => r.ok).map(r => r.issueKey);
    if (okKeys.length > 0) {
      await mapWithConcurrency(okKeys, AUTO_LOGWORK_CONCURRENCY, issueKey =>
        syncIssueWorklogsToDb(db, issueKey, jiraBaseUrl, token).catch(syncErr => {
          console.error(`[AutoLogwork] DB sync error for ${issueKey}:`, syncErr.message);
        })
      );
    }

    const okCount = results.filter(r => r.ok).length;
    res.json({ results, okCount, failCount: results.length - okCount });
  });

  router.post('/api/worklogs/replace', authenticateToken, async (req, res) => {
    const { issueKey, timeSpent, comment, started, year, month } = req.body;
    if (!issueKey || !timeSpent) {
      return res.status(400).json({ error: 'Thiếu issueKey hoặc timeSpent' });
    }
    const token = await requireUserJiraToken(db, req, res);
    if (!token) return;
    const issueTrim = String(issueKey).trim();
    const jiraBaseUrl = process.env.JIRA_URL;

    const jiraErr = (error) => {
      const errData = error.response?.data;
      const msg = errData?.errorMessages?.join?.('; ')
        || (errData?.errors && JSON.stringify(errData.errors))
        || error.message
        || 'Lỗi Jira';
      const status = error.response?.status >= 400 && error.response?.status < 600 ? error.response.status : 500;
      return { msg, status, errData };
    };

    const worklogId = await resolveUserWorklogIdForReplace(
      db,
      req.user.id,
      issueTrim,
      { year, month },
      jiraBaseUrl,
      token
    );

    if (worklogId) {
      try {
        await deleteIssueWorklog(jiraBaseUrl, issueTrim, worklogId, token);
      } catch (error) {
        const status = error.response?.status;
        if (status === 404) {
          console.warn(`[Worklog] replace: worklog ${worklogId} không còn trên Jira — tạo mới.`);
        } else {
          const { msg, status: httpStatus, errData } = jiraErr(error);
          console.error('Jira worklog DELETE (replace bước 1):', errData || error.message);
          return res.status(httpStatus).json({ error: `Xóa worklog cũ thất bại: ${msg}` });
        }
      }
    }

    const c = comment != null ? String(comment) : '';

    try {
      const createRes = await postIssueWorklog(jiraBaseUrl, issueTrim, {
        timeSpent,
        comment: c,
        started,
      }, token);
      try {
        await syncIssueWorklogsToDb(db, issueTrim, jiraBaseUrl, token);
      } catch (syncErr) {
        console.error('[Worklog] DB sync after replace:', syncErr.message);
      }
      res.json({ success: true, worklog: createRes.data });
    } catch (error) {
      const { msg, status, errData } = jiraErr(error);
      console.error('Jira worklog POST (replace bước 2):', errData || error.message);
      return res.status(status).json({
        error: `Đã xóa worklog cũ nhưng tạo mới thất bại: ${msg}. Hãy log lại thủ công trên Jira.`,
        deletedOldOnly: true
      });
    }
  });

  router.post('/api/worklogs/close-issues', authenticateToken, async (req, res) => {
    const issueKeys = Array.isArray(req.body?.issueKeys) ? req.body.issueKeys : [];
    const outputText = req.body?.output ?? req.body?.closeTaskOutput;

    if (issueKeys.length === 0) {
      return res.status(400).json({ error: 'Thiếu danh sách issueKeys' });
    }

    const token = await requireUserJiraToken(db, req, res);
    if (!token) return;

    const jiraBaseUrl = process.env.JIRA_URL;
    if (!jiraBaseUrl) {
      return res.status(503).json({ error: 'JIRA_URL chưa cấu hình trên server' });
    }

    try {
      const data = await closeIssuesOnJira({
        db,
        jiraBaseUrl,
        issueKeys,
        token,
        httpsAgent,
        outputText,
      });
      const status = data.failed > 0 && data.ok === 0 ? 500 : data.failed > 0 ? 207 : 200;
      res.status(status).json({ success: data.failed === 0, ...data });
    } catch (error) {
      res.status(500).json({ error: error.message || 'Không đóng được ticket' });
    }
  });

  return router;
};

