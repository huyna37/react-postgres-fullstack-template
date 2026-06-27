const axios = require('axios');

/**
 * Unified LLM entry for the server.
 *
 * Env:
 * - AI_PROVIDER: gemini | openai | custom | auto (default auto)
 * - Gemini: GEMINI_API_KEY, GEMINI_MODEL (or AI_MODEL)
 * - OpenAI-compatible / custom HTTP (LM Studio, vLLM, gateway riêng…):
 *   AI_OPENAI_BASE_URL hoặc AI_BASE_URL hoặc AI_CUSTOM_LLM_URL
 *   (có thể chỉ ghi host:port, ví dụ localhost:20128 → tự thêm http://)
 *   AI_HTTP_COMPLETIONS_PATH (mặc định /v1/chat/completions)
 *   AI_OPENAI_API_KEY / OPENAI_API_KEY / AI_API_KEY — tùy chọn nếu server local không cần
 *   AI_OPENAI_MODEL hoặc AI_MODEL
 *
 * Chế độ auto: nếu có GEMINI_API_KEY thì dùng Gemini trước (tránh nhầm với gateway HTTP).
 * Muốn ưu tiên HTTP trong khi file .env vẫn có GEMINI_API_KEY: đặt AI_PREFER_HTTP_LLM=1
 * hoặc AI_PROVIDER=openai|custom và bỏ / comment GEMINI_API_KEY.
 */

const normalizeHttpBase = (raw) => {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) {
    s = `http://${s}`;
  }
  return s.replace(/\/$/, '');
};

const getProviderStatusUrl = () => {
  return process.env.AI_PROVIDER_STATUS_URL || 'http://10.0.229.55:30100/api/providers/client';
};

const getUsageUrl = (providerId) => {
  const base = getOpenAiBaseUrl();
  const cleanBase = base.replace(/\/v1\/?$/, '');
  return `${cleanBase}/api/usage/${providerId}`;
};

const getGatewayHeaders = () => {
  const headers = { 'Accept': 'application/json' };
  const apiKey = getOpenAiApiKey();
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
};

let cachedUsageStats = null;
let lastUsageFetch = 0;

const fetchModelUsageStats = async () => {
  const now = Date.now();
  // Cache usage stats for 60 seconds to avoid overloading the gateway
  if (cachedUsageStats && (now - lastUsageFetch < 60000)) {
    return cachedUsageStats;
  }

  try {
    const headers = getGatewayHeaders();
    const statusUrl = getProviderStatusUrl();
    const res = await axios.get(statusUrl, { headers, timeout: 5000 });
    const connections = res.data?.connections || [];
    
    const modelHealth = new Map(); // modelName -> maxRemainingPercentage

    for (const conn of connections) {
      if (conn.isActive === false && conn.errorCode === 429) continue;
      
      try {
        const usageRes = await axios.get(getUsageUrl(conn.id), { headers, timeout: 3000 });
        const quotas = usageRes.data?.quotas || {};
        
        for (const [modelKey, quota] of Object.entries(quotas)) {
          const remaining = quota.remainingPercentage ?? 100;
          const currentMax = modelHealth.get(modelKey) ?? -1;
          if (remaining > currentMax) {
            modelHealth.set(modelKey, remaining);
          }
        }
      } catch (e) {
        // Skip usage fetch for this provider if it fails
      }
    }
    
    cachedUsageStats = modelHealth;
    lastUsageFetch = now;
    return modelHealth;
  } catch (e) {
    const status = e.response?.status;
    if (status !== 401 && status !== 403) {
      console.warn('[LLM] Could not fetch detailed usage stats:', e.message);
    }
    return null;
  }
};

const fetchHealthyModels = async () => {
  try {
    const headers = getGatewayHeaders();
    const url = getProviderStatusUrl();
    const res = await axios.get(url, { headers, timeout: 5000 });
    const connections = res.data?.connections || [];
    
    const now = new Date();
    return {
      connections: connections.map(c => ({
        id: c.id,
        isActive: c.isActive,
        lockedModels: Object.keys(c)
          .filter(k => k.startsWith('modelLock_') && new Date(c[k]) > now)
          .map(k => k.replace('modelLock_', ''))
      }))
    };
  } catch (e) {
    console.warn('[LLM] Could not fetch provider status:', e.message);
    return null;
  }
};





const getOpenAiModelName = () =>
  process.env.AI_OPENAI_MODEL || process.env.AI_MODEL || 'cx/gpt-5.5';

const getSmartModel = () => 
  process.env.AI_SMART_MODEL || 'cx/gpt-5.5';

const getFastModel = () =>
  process.env.AI_FAST_MODEL || process.env.AI_SMART_MODEL || 'cx/gpt-5.5';

async function listModels() {
  const baseUrl = getOpenAiBaseUrl();
  // Ensure we use /v1/models if the baseUrl doesn't already end with /v1
  const url = baseUrl.endsWith('/v1') ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
  const headers = getGatewayHeaders();
  
  try {
    const res = await axios.get(url, { headers, timeout: 10000 });
    return res.data;
  } catch (e) {
    console.error('Error listing models from gateway:', e.message);
    return { data: [] };
  }
}

let cachedAutoModel = null;
let cachedEmbeddingModel = null;
let embeddingUnavailable = false;
let embeddingWarned = false;

const isEmbeddingModelId = (id) => /embed/i.test(String(id || ''));

const pickEmbeddingModel = (modelIds) => {
  const ids = modelIds.filter(isEmbeddingModelId);
  if (!ids.length) return null;
  const nonOpenAi = ids.filter((id) => !/^openai\//i.test(id));
  const openAi = ids.filter((id) => /^openai\//i.test(id));
  return nonOpenAi[0] || openAi[0] || null;
};

/**
 * Chọn model embedding khả dụng trên gateway (tránh openai/* khi không có credential OpenAI).
 */
async function resolveAutoEmbeddingModel() {
  if (embeddingUnavailable) return null;
  if (cachedEmbeddingModel) return cachedEmbeddingModel;

  const configured = String(process.env.AI_EMBEDDING_MODEL || 'auto').trim();
  if (configured && configured !== 'auto' && !/^openai\//i.test(configured)) {
    cachedEmbeddingModel = configured;
    console.log(`[LLM] Using configured embedding model: ${cachedEmbeddingModel}`);
    return cachedEmbeddingModel;
  }

  try {
    const modelsRes = await listModels();
    const modelIds = (modelsRes.data || []).map((m) => m.id).filter(Boolean);
    const picked = pickEmbeddingModel(modelIds);
    if (picked) {
      cachedEmbeddingModel = picked;
      console.log(`[LLM] Auto-detected embedding model: ${cachedEmbeddingModel}`);
      return cachedEmbeddingModel;
    }
  } catch (e) {
    console.warn('[LLM] Embedding model auto-detect failed:', e.message);
  }

  embeddingUnavailable = true;
  if (!embeddingWarned) {
    console.warn(
      '[LLM] No embedding model on gateway — semantic search will use lexical (BM25) only. Set AI_EMBEDDING_MODEL to a model id from GET /v1/models.'
    );
    embeddingWarned = true;
  }
  return null;
}

const isChatModelId = (id) => {
  const s = String(id || '');
  if (isEmbeddingModelId(s)) return false;
  if (/^(search|fetch|tts|whisper|dall-e|image)/i.test(s)) return false;
  return true;
};

const modelAvailable = (modelId, lockedNorms, usage) => {
  const normalize = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const normId = normalize(modelId.includes('/') ? modelId.split('/')[1] : modelId);
  if (lockedNorms.includes(normId)) return false;
  if (!usage) return true;
  let remain = 100;
  let found = false;
  for (const [mKey, r] of usage.entries()) {
    if (normalize(mKey).includes(normId) || normId.includes(normalize(mKey))) {
      remain = r;
      found = true;
      break;
    }
  }
  return !(found && remain <= 0);
};

async function resolveAutoModel() {
  if (cachedAutoModel) return cachedAutoModel;
  try {
    const [modelsRes, usage] = await Promise.all([listModels(), fetchModelUsageStats()]);
    const modelIds = (modelsRes.data || []).map((m) => m.id).filter(isChatModelId);
    if (modelIds.length > 0) {
      const status = await fetchHealthyModels();
      const lockedInGateway = status ? new Set(status.connections.flatMap((c) => c.lockedModels)) : new Set();
      const lockedNorms = Array.from(lockedInGateway).map((l) =>
        l.toLowerCase().replace(/[^a-z0-9]/g, '')
      );

      const preferred = [
        process.env.AI_SMART_MODEL,
        process.env.AI_OPENAI_MODEL,
        process.env.AI_MODEL !== 'auto' ? process.env.AI_MODEL : null,
        getFastModel(),
        'cx/gpt-5.5',
      ].filter((m) => m && m !== 'auto');

      for (const pref of preferred) {
        const match = modelIds.find(
          (id) => id === pref || id.endsWith(`/${pref}`) || id.includes(pref)
        );
        if (match && modelAvailable(match, lockedNorms, usage)) {
          cachedAutoModel = match;
          console.log(`[LLM] Auto-detected available model: ${cachedAutoModel}`);
          return cachedAutoModel;
        }
      }

      const ranked = [
        ...modelIds.filter((id) => id.startsWith('cx/')),
        ...modelIds.filter((id) => id.startsWith('gemini/')),
        ...modelIds.filter((id) => !/^openai\//i.test(id)),
        ...modelIds.filter((id) => /^openai\//i.test(id)),
      ];

      for (const modelId of ranked) {
        if (modelAvailable(modelId, lockedNorms, usage)) {
          cachedAutoModel = modelId;
          console.log(`[LLM] Auto-detected available model: ${cachedAutoModel}`);
          return cachedAutoModel;
        }
      }
    }
  } catch (e) {
    console.warn('[LLM] Auto-detection failed, falling back to default.', e.message);
  }
  cachedAutoModel = getSmartModel();
  return cachedAutoModel;
}

const getOpenAiBaseUrl = () => {
  const raw = process.env.NINEROUTER_URL || process.env.AI_OPENAI_BASE_URL || 'http://10.0.229.55:30100';
  return normalizeHttpBase(raw);
}

const getCompletionsPath = () => {
  const pathRaw = (process.env.AI_HTTP_COMPLETIONS_PATH || '/v1/chat/completions').trim();
  if (!pathRaw.startsWith('/')) return `/${pathRaw}`;
  return pathRaw;
};

const getOpenAiApiKey = () =>
  process.env.NINEROUTER_KEY || process.env.AI_OPENAI_API_KEY || process.env.OPENAI_API_KEY || process.env.AI_API_KEY;

const getNinerouterUrl = () => getOpenAiBaseUrl();
const getNinerouterKey = () => getOpenAiApiKey();

/**
 * 9Router Web Search
 * @param {string} query 
 * @param {object} options 
 * @returns {Promise<object>}
 */
async function ninerouterWebSearch(query, options = {}) {
  const baseUrl = getNinerouterUrl();
  const apiKey = getNinerouterKey();
  const url = `${baseUrl}/v1/search`;
  
  const payload = {
    model: options.model || 'search-combo',
    query,
    max_results: options.maxResults || 5,
    search_type: options.searchType || 'web',
  };

  const headers = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  try {
    const res = await axios.post(url, payload, { headers, timeout: 30000 });
    return res.data;
  } catch (e) {
    console.error('[9Router Search] Error:', e.response?.data || e.message);
    throw e;
  }
}

/**
 * 9Router Web Fetch (URL to Markdown/Text)
 * @param {string} targetUrl 
 * @param {object} options 
 * @returns {Promise<object>}
 */
async function ninerouterWebFetch(targetUrl, options = {}) {
  const baseUrl = getNinerouterUrl();
  const apiKey = getNinerouterKey();
  const url = `${baseUrl}/v1/web/fetch`;
  
  const payload = {
    model: options.model || 'fetch-combo',
    url: targetUrl,
    format: options.format || 'markdown',
    max_characters: options.maxCharacters || 15000,
  };

  const headers = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  try {
    const res = await axios.post(url, payload, { headers, timeout: 30000 });
    return res.data;
  } catch (e) {
    console.error('[9Router Fetch] Error:', e.response?.data || e.message);
    throw e;
  }
}

/**
 * 9Router Image Generation
 * @param {string} prompt 
 * @param {object} options 
 * @returns {Promise<object>}
 */
async function ninerouterImageGenerate(prompt, options = {}) {
  const baseUrl = getNinerouterUrl();
  const apiKey = getNinerouterKey();
  const url = `${baseUrl}/v1/images/generations`;
  
  const payload = {
    model: options.model || 'gemini/gemini-3-pro-image-preview',
    prompt,
    size: options.size || '1024x1024',
    response_format: options.responseFormat || 'url',
  };

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  try {
    const res = await axios.post(url, payload, { headers, timeout: 60000 });
    return res.data;
  } catch (e) {
    console.error('[9Router Image] Error:', e.response?.data || e.message);
    throw e;
  }
}

/**
 * 9Router Text-to-Speech
 * @param {string} input 
 * @param {object} options 
 * @returns {Promise<Buffer|object>}
 */
async function ninerouterTextToSpeech(input, options = {}) {
  const baseUrl = getNinerouterUrl();
  const apiKey = getNinerouterKey();
  const url = `${baseUrl}/v1/audio/speech`;
  
  const payload = {
    model: options.model || 'openai/tts-1',
    input,
  };

  const responseFormat = options.responseFormat || 'mp3';
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  try {
    const res = await axios.post(`${url}?response_format=${responseFormat}`, payload, {
      headers,
      responseType: responseFormat === 'mp3' ? 'arraybuffer' : 'json',
      timeout: 30000 
    });
    return res.data;
  } catch (e) {
    console.error('[9Router TTS] Error:', e.response?.data || e.message);
    throw e;
  }
}

/**
 * 9Router Speech-to-Text
 * @param {Buffer|ReadableStream} file 
 * @param {object} options 
 * @returns {Promise<object>}
 */
async function ninerouterSpeechToText(file, options = {}) {
  const baseUrl = getNinerouterUrl();
  const apiKey = getNinerouterKey();
  const url = `${baseUrl}/v1/audio/transcriptions`;
  
  const formData = new (require('form-data'))();
  formData.append('model', options.model || 'openai/whisper-1');
  formData.append('file', file, options.filename || 'audio.mp3');
  if (options.language) formData.append('language', options.language);

  const headers = { ...formData.getHeaders() };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  try {
    const res = await axios.post(url, formData, { headers, timeout: 60000 });
    return res.data;
  } catch (e) {
    console.error('[9Router STT] Error:', e.response?.data || e.message);
    throw e;
  }
}

const emptyEmbeddingResponse = (input) => {
  const arr = Array.isArray(input) ? input : [input];
  return { data: arr.map(() => ({ embedding: null })) };
};

/**
 * 9Router Embeddings — model auto (ưu tiên non-openai trên gateway).
 * Không throw: trả embedding null để caller dùng lexical fallback.
 */
async function ninerouterEmbeddings(input, options = {}) {
  if (embeddingUnavailable && !options.model) {
    return emptyEmbeddingResponse(input);
  }

  let model = options.model || process.env.AI_EMBEDDING_MODEL || 'auto';
  if (!model || model === 'auto' || /^openai\//i.test(model)) {
    const auto = await resolveAutoEmbeddingModel();
    if (auto) model = auto;
    else return emptyEmbeddingResponse(input);
  }

  const baseUrl = getNinerouterUrl();
  const apiKey = getNinerouterKey();
  const url = `${baseUrl}/v1/embeddings`;

  const payload = { model, input };

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  try {
    const res = await axios.post(url, payload, { headers, timeout: 15000 });
    if (res.status >= 400) {
      throw new Error(typeof res.data === 'object' ? JSON.stringify(res.data) : String(res.data));
    }
    return res.data;
  } catch (e) {
    const detail = e.response?.data || e.message;
    const noCreds =
      String(detail).includes('No credentials for provider: openai') ||
      String(detail).includes('invalid_request_error');

    if (noCreds && !options.model) {
      cachedEmbeddingModel = null;
      embeddingUnavailable = true;
      if (!embeddingWarned) {
        console.warn(
          `[LLM] Embedding model "${model}" unavailable on gateway — using lexical search only. Set AI_EMBEDDING_MODEL=auto or a model from /v1/models.`
        );
        embeddingWarned = true;
      }
      return emptyEmbeddingResponse(input);
    }

    if (!embeddingWarned) {
      console.warn('[9Router Embeddings] Error:', detail);
      embeddingWarned = true;
    }
    return emptyEmbeddingResponse(input);
  }
}

async function openaiCompatibleGenerate(prompt, meta = {}) {
  const apiKey = getOpenAiApiKey();
  const baseUrl = getOpenAiBaseUrl();
  let model = meta.model || getOpenAiModelName();

  if (model === 'auto' && !meta.model) {
    model = await resolveAutoModel();
  }

  const isLocalHost = /localhost|127\.0\.0\.1/i.test(baseUrl);
  const allowNoKey = String(process.env.AI_HTTP_ALLOW_NO_AUTH) === '1' || (isLocalHost && String(process.env.AI_HTTP_ALLOW_NO_AUTH) !== '0');
  if (!apiKey && !allowNoKey) {
    throw new Error(
      'Thiếu API key cho LLM HTTP. Đặt AI_OPENAI_API_KEY (hoặc AI_API_KEY), hoặc bật AI_HTTP_ALLOW_NO_AUTH=1 cho server local.'
    );
  }

  const messages = [];
  if (meta.systemInstruction) {
    messages.push({ role: 'system', content: meta.systemInstruction });
  }
  messages.push({ role: 'user', content: prompt });

  const url = `${baseUrl}${getCompletionsPath()}`;
  const timeout = Math.max(30000, Number(process.env.AI_HTTP_TIMEOUT_MS) || 120000);

  const headers = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  if (process.env.OPENAI_ORGANIZATION) {
    headers['OpenAI-Organization'] = process.env.OPENAI_ORGANIZATION;
  }
  if (process.env.AI_EXTRA_HEADERS_JSON) {
    try {
      Object.assign(headers, JSON.parse(process.env.AI_EXTRA_HEADERS_JSON));
    } catch (e) {
      throw new Error('AI_EXTRA_HEADERS_JSON không phải JSON hợp lệ.');
    }
  }

  const res = await axios.post(
    url,
    {
      model,
      messages,
      temperature: Number(process.env.AI_TEMPERATURE) || 0.2,
    },
    {
      headers,
      timeout,
      validateStatus: () => true,
    }
  );

  if (res.status >= 400) {
    const detail = typeof res.data === 'object' ? JSON.stringify(res.data) : String(res.data);
    throw new Error(`OpenAI-compatible API ${res.status}: ${detail}`);
  }

  const text = res.data?.choices?.[0]?.message?.content;
  if (text == null || text === '') {
    throw new Error('OpenAI-compatible API trả về nội dung rỗng.');
  }
  return typeof text === 'string' ? text : String(text);
}

/**
 * @param {string} prompt
 * @param {{ systemInstruction?: string, model?: string, retryCount?: number }} [meta]
 * @returns {Promise<string>}
 */
async function llmGenerate(prompt, meta = {}) {
  const maxRetries = 3;
  const currentRetry = meta.retryCount || 0;

  try {
    return await openaiCompatibleGenerate(prompt, meta);
  } catch (error) {
    const isTokenLimit = error.message.includes('400') && (error.message.includes('token') || error.message.includes('limit') || error.message.includes('context'));
    const isRateLimit =
      error.message.includes('429') ||
      error.message.includes('quota') ||
      (error.message.includes('reset after') && !error.message.includes('not supported'));
    const isOverloaded = error.message.includes('503') || error.message.includes('overloaded') || error.message.includes('busy');
    const isModelUnsupported =
      /not supported/i.test(error.message) ||
      /model.*(invalid|unknown|unavailable)/i.test(error.message);
    const isLimited = isTokenLimit || isRateLimit || isOverloaded;

    if (currentRetry < maxRetries) {
      if (isModelUnsupported) {
        const fallback =
          meta.model === getFastModel() && getSmartModel() !== getFastModel()
            ? getSmartModel()
            : null;
        if (fallback) {
          console.warn(
            `[LLM] Model "${meta.model || getFastModel()}" không khả dụng trên gateway — chuyển sang ${fallback}`
          );
          return await llmGenerate(prompt, { ...meta, model: fallback, retryCount: currentRetry + 1 });
        }
      }

      console.warn(`[LLM] Error encountered: ${error.message}. Retrying... (${currentRetry + 1}/${maxRetries})`);

      if (isLimited) {
        const [modelsRes, usage] = await Promise.all([listModels(), fetchModelUsageStats()]);
        const models = modelsRes.data || [];
        if (models.length > 0) {
          const modelList = models.map(m => m.id);
          const status = await fetchHealthyModels();
          const lockedInGateway = status ? new Set(status.connections.flatMap(c => c.lockedModels)) : new Set();
          const normalize = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
          const lockedNorms = Array.from(lockedInGateway).map(l => normalize(l));

          let nextModel = null;
          for (const modelId of modelList) {
            const normModelId = normalize(modelId.includes('/') ? modelId.split('/')[1] : modelId);
            if (modelId === meta.model || 
                modelId === getOpenAiModelName() ||
                lockedNorms.includes(normModelId)) {
              continue;
            }

            if (usage) {
              const normId = normalize(modelId.includes('/') ? modelId.split('/')[1] : modelId);
              let remain = 100;
              let found = false;
              for (const [mKey, r] of usage.entries()) {
                if (normalize(mKey).includes(normId) || normId.includes(normalize(mKey))) {
                  remain = r;
                  found = true;
                  break;
                }
              }
              if (found && remain <= 0) continue;
            }

            nextModel = modelId;
            break;
          }

          if (nextModel) {
            console.info(`[LLM] Switching to fallback model: ${nextModel}`);
            return await llmGenerate(prompt, { ...meta, model: nextModel, retryCount: currentRetry + 1 });
          }
        }
      }

      // Generic retry with exponential backoff if not a specific "limited" error that already handled switching
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, currentRetry) * 1000));
      return await llmGenerate(prompt, { ...meta, retryCount: currentRetry + 1 });
    }
    throw error;
  }
}

async function getActiveLlmInfo() {
  try {
    let model = getOpenAiModelName();
    if (model === 'auto') {
      model = await resolveAutoModel();
    }

    const baseUrl = getOpenAiBaseUrl();
    // In this project, AI_OPENAI_BASE_URL is effectively 9Router
    const isNinerouter = true; 

    return {
      provider: '9router',
      model,
      baseUrl,
      completionsPath: getCompletionsPath(),
      isNinerouter,
    };
  } catch (e) {
    return { provider: 'unknown', error: e.message };
  }
}


module.exports = {
  llmGenerate,
  getActiveLlmInfo,
  listModels,
  fetchModelUsageStats,
  getOpenAiBaseUrl,
  ninerouterWebSearch,
  ninerouterWebFetch,
  ninerouterImageGenerate,
  ninerouterTextToSpeech,
  ninerouterSpeechToText,
  ninerouterEmbeddings,
  resolveAutoEmbeddingModel,
  getSmartModel,
  getFastModel,
};
