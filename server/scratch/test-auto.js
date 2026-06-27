const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { llmGenerate, getActiveLlmInfo } = require('../llm');

async function test() {
  console.log('--- Testing Auto Model Selection ---');
  
  // Force AI_MODEL=auto for this test if not already set
  process.env.AI_MODEL = 'auto';
  
  const info = getActiveLlmInfo();
  console.log('Initial Info:', JSON.stringify(info, null, 2));

  try {
    console.log('\nTesting llmGenerate() with auto-selection...');
    const prompt = 'Say "Auto-selection working"';
    const response = await llmGenerate(prompt);
    console.log('AI Response:', response);
    
    // Check if info updated or if we can see the resolved model
    // Note: getActiveLlmInfo() might still return 'auto' if it just reads env
  } catch (e) {
    console.error('llmGenerate() failed:', e.message);
  }
}

test();
