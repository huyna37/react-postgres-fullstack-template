const { analyzeFlow } = require('../code-intel/flow-analyzer');
const { buildChainFromRoute } = require('../code-intel/dependency-tracer');
const { pickBestComponent, resolveUrl } = require('./direct-answer.service');

const traceFromQuestion = (graph, retrievalResult) => {
  const { ranked, routes, expandedNodes, searchQuery } = retrievalResult;
  const flow = retrievalResult.flow || analyzeFlow(graph, ranked || [], routes || []);

  const bestComponent = pickBestComponent(ranked || [], searchQuery || '') || flow.component;
  const url = resolveUrl(flow, ranked || [], routes || [], graph, searchQuery || '');

  const chain = flow.route ? buildChainFromRoute(graph, flow.route) : flow.chain || [];

  return {
    url,
    route: flow.route,
    component: bestComponent || flow.component,
    endpoint: flow.endpoint,
    permissions: flow.permissions,
    displayFields: flow.displayFields,
    filterFields: flow.filterFields,
    sortFields: flow.sortFields,
    uiFlow: flow.uiFlow,
    apiFlow: flow.apiFlow,
    dbFlow: flow.dbFlow,
    flowChain: flow.flowChain,
    summaryText: flow.summaryText,
    chain,
    expandedNodes: expandedNodes || [],
  };
};

const formatTraceForPrompt = (trace) => {
  const lines = [];
  if (trace.url) lines.push(`URL: ${trace.url}`);
  if (trace.component) lines.push(`Component: ${trace.component.name}`);
  if (trace.permissions?.length) lines.push(`Permission: ${trace.permissions.join(', ')}`);
  if (trace.endpoint) lines.push(`API: ${trace.endpoint.abpRoute || trace.endpoint.route}`);
  return lines.join('\n');
};

module.exports = {
  traceFromQuestion,
  formatTraceForPrompt,
};
