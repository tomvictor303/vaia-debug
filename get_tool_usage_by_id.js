require('dotenv').config();
const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');

const apiKey = process.env.VAPI_API_KEY;

async function promptForToolId() {
  const rl = readline.createInterface({ input, output });

  try {
    const answer = await rl.question('Tool ID to check: ');
    const toolId = answer.trim();

    if (!toolId) {
      throw new Error('Tool ID is required');
    }

    return toolId;
  } finally {
    rl.close();
  }
}

async function fetchAssistants() {
  const assistantsUrl = 'https://api.vapi.ai/assistant?limit=1000';
  console.log(`Fetching all assistants from: ${assistantsUrl}`);

  const response = await fetch(assistantsUrl, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const assistants = await response.json();

  if (!Array.isArray(assistants)) {
    throw new Error('Unexpected API response: expected an array of assistants');
  }

  return assistants;
}

async function getToolUsage() {
  try {
    if (!apiKey) {
      throw new Error('VAPI_API_KEY environment variable is required');
    }

    const toolId = await promptForToolId();
    const assistants = await fetchAssistants();
    const matchingAssistants = assistants
      .filter(
        assistant =>
          Array.isArray(assistant.model?.toolIds) &&
          assistant.model.toolIds.includes(toolId)
      )
      .sort((firstAssistant, secondAssistant) =>
        (firstAssistant.name || '').localeCompare(secondAssistant.name || '')
      );

    console.log(`\nTotal assistants: ${assistants.length}`);
    console.log(`Assistants using tool ${toolId}: ${matchingAssistants.length}`);
    matchingAssistants.forEach(assistant => {
      console.log(`- ${assistant.name || '(unnamed assistant)'}`);
    });

    return matchingAssistants;
  } catch (error) {
    console.error('Error:', error.message);
    process.exitCode = 1;
    return [];
  }
}

getToolUsage();
