const { 
  ninerouterWebSearch, 
  ninerouterWebFetch, 
  ninerouterImageGenerate,
  ninerouterTextToSpeech,
  ninerouterSpeechToText,
  ninerouterEmbeddings,
  llmGenerate,
  getSmartModel
} = require('./llm');
const fs = require('fs');
const path = require('path');

/**
 * Performs web research based on the ticket details and current context.
 * Returns a markdown summary of findings.
 */
async function performWebResearch(ticketDetails, pipelineContext) {
  try {
    const query = `research: ${ticketDetails.summary} ${ticketDetails.description}`.substring(0, 300);
    console.log(`[9Router Research] Searching for: ${query}`);
    
    const searchResults = await ninerouterWebSearch(query, { maxResults: 5 });
    
    if (!searchResults || !searchResults.results || searchResults.results.length === 0) {
      return "No web research results found.";
    }

    const findings = [];
    for (const result of searchResults.results.slice(0, 3)) {
      findings.push(`### [${result.title}](${result.url})\n${result.snippet}`);
      
      if (result.score > 0.8) {
        try {
          console.log(`[9Router Research] Fetching highly relevant URL: ${result.url}`);
          const fetchResult = await ninerouterWebFetch(result.url, { maxCharacters: 5000 });
          if (fetchResult && fetchResult.content) {
            findings.push(`\n**Deep Content from ${result.title}:**\n${fetchResult.content.text.substring(0, 2000)}...\n`);
          }
        } catch (fetchErr) {
          console.warn(`[9Router Research] Fetch failed for ${result.url}:`, fetchErr.message);
        }
      }
    }

    const summaryPrompt = `Based on the following web research findings for the ticket "${ticketDetails.summary}", provide a concise technical summary and any relevant code patterns or documentation links that could help solve the issue.
    
    FINDINGS:
    ${findings.join('\n\n')}
    
    Provide your response in Markdown.`;

    const summary = await llmGenerate(summaryPrompt, { model: getSmartModel() });
    return `## Web Research Findings\n\n${summary}`;
  } catch (err) {
    console.error('[9Router Research] Error:', err.message);
    return `Error performing web research: ${err.message}`;
  }
}

/**
 * Generates an image representing the ticket (e.g. for a UI/UX task)
 */
async function generateTicketVisualization(ticketDetails) {
  try {
    const prompt = `A professional UI/UX design mockup for: ${ticketDetails.summary}. ${ticketDetails.description}`.substring(0, 1000);
    console.log(`[9Router Image] Generating visualization for: ${ticketDetails.summary}`);
    
    const result = await ninerouterImageGenerate(prompt);
    return result.data?.[0]?.url || null;
  } catch (err) {
    console.error('[9Router Image] Error:', err.message);
    return null;
  }
}

/**
 * Converts a ticket or comment to speech (MP3)
 */
async function textToVoice(text, outputPath) {
  try {
    console.log(`[9Router TTS] Converting text to speech...`);
    const audioBuffer = await ninerouterTextToSpeech(text);
    if (outputPath) {
      fs.writeFileSync(outputPath, audioBuffer);
    }
    return audioBuffer;
  } catch (err) {
    console.error('[9Router TTS] Error:', err.message);
    return null;
  }
}

/**
 * Transcribes an audio file to text
 */
async function transcribeAudio(audioFilePath) {
  try {
    console.log(`[9Router STT] Transcribing audio file: ${audioFilePath}`);
    const fileBuffer = fs.readFileSync(audioFilePath);
    const result = await ninerouterSpeechToText(fileBuffer, { filename: path.basename(audioFilePath) });
    return result.text || null;
  } catch (err) {
    console.error('[9Router STT] Error:', err.message);
    return null;
  }
}

/**
 * Generates embeddings for a piece of text
 */
async function getEmbeddings(text) {
  try {
    const result = await ninerouterEmbeddings(text);
    return result.data?.[0]?.embedding || null;
  } catch (err) {
    console.error('[9Router Embeddings] Error:', err.message);
    return null;
  }
}

module.exports = {
  performWebResearch,
  generateTicketVisualization,
  textToVoice,
  transcribeAudio,
  getEmbeddings
};
