require('dotenv').config();
const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');

const apiKey = process.env.VAPI_API_KEY;

async function promptForPrefix() {
  const rl = readline.createInterface({ input, output });

  try {
    const answer = await rl.question('Tool name prefix to search: ');
    return answer.trim();
  } finally {
    rl.close();
  }
}

function validatePrefix(prefix) {
  if (prefix.length <= 2) {
    throw new Error('Guardrail failed: prefix must be more than 2 letters');
  }
}

async function fetchJson(url, resourceName) {
  console.log(`Fetching all ${resourceName} from: ${url}`);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${resourceName}. HTTP status: ${response.status}`);
  }

  const data = await response.json();

  if (!Array.isArray(data)) {
    throw new Error(`Unexpected API response: expected an array of ${resourceName}`);
  }

  return data;
}

async function getToolUsageByPrefix() {
  try {
    if (!apiKey) {
      throw new Error('VAPI_API_KEY environment variable is required');
    }

    const prefix = await promptForPrefix();
    validatePrefix(prefix);

    const [tools, assistants] = await Promise.all([
      fetchJson('https://api.vapi.ai/tool?limit=1000', 'tools'),
      fetchJson('https://api.vapi.ai/assistant?limit=1000', 'assistants'),
    ]);

    const matchingTools = tools
      .filter(
        tool =>
          typeof tool.name === 'string' &&
          tool.name.startsWith(prefix)
      )
      .sort((firstTool, secondTool) =>
        firstTool.name.localeCompare(secondTool.name)
      );

    console.log(`\nTools found for "${prefix}": ${matchingTools.length}`);

    matchingTools.forEach(tool => {
      const matchingAssistants = assistants
        .filter(
          assistant =>
            Array.isArray(assistant.model?.toolIds) &&
            assistant.model.toolIds.includes(tool.id)
        )
        .sort((firstAssistant, secondAssistant) =>
          (firstAssistant.name || '').localeCompare(secondAssistant.name || '')
        );

      console.log(`\n${tool.name} (${tool.id})`);
      console.log(`Assistants using this tool: ${matchingAssistants.length}`);
      matchingAssistants.forEach(assistant => {
        console.log(`- ${assistant.name || '(unnamed assistant)'}`);
      });
    });

    console.log(`\nTotal assistants checked: ${assistants.length}`);
    return matchingTools;
  } catch (error) {
    console.error('Error:', error.message);
    process.exitCode = 1;
    return [];
  }
}

getToolUsageByPrefix();
