const { llmGenerate } = require('../llm');
const axios = require('axios');

// Mock axios to simulate 429 error for the first call
const originalPost = axios.post;
let callCount = 0;

axios.post = async (url, data, config) => {
  callCount++;
  console.log(`[MOCK] Call ${callCount} to ${url} for model ${data.model}`);
  
  if (callCount === 1) {
    throw new Error('OpenAI-compatible API 429: Too Many Requests');
  }
  
  // Return success for subsequent calls
  return {
    status: 200,
    data: {
      choices: [{ message: { content: 'Success after fallback' } }]
    }
  };
};

async function runTest() {
  console.log('--- Testing Fallback Mechanism ---');
  process.env.AI_PROVIDER = 'openai';
  process.env.AI_BASE_URL = 'http://localhost:1234';
  process.env.AI_OPENAI_API_KEY = 'test-key';
  process.env.AI_MODEL = 'initial-model';

  try {
    const result = await llmGenerate('Hello');
    console.log('Result:', result);
    if (callCount > 1) {
      console.log('✅ Fallback mechanism worked!');
    } else {
      console.log('❌ Fallback mechanism failed to retry with a different model.');
    }
  } catch (e) {
    console.error('Test failed with error:', e.message);
  } finally {
    axios.post = originalPost;
  }
}

runTest();
