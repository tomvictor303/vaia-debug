require('dotenv').config();
const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');

const apiKey = process.env.VAPI_API_KEY;
const filter_prefix = 'quore_';
const params_to_add = {
  orgId: {
    description: '',
    type: 'number',
    default: '',
  },
  apiKey: {
    description: '',
    type: 'string',
    default: '',
  },
};
const required_params = ['orgId', 'apiKey'];

/**
 * Validates destructive-action guardrails before any Vapi tools are fetched or
 * changed.
 */
function validateGuardrails() {
  if (!filter_prefix.endsWith('_')) {
    throw new Error('Guardrail failed: filter_prefix must end with "_"');
  }

  if (filter_prefix.length < 5) {
    throw new Error('Guardrail failed: filter_prefix must be at least 5 characters');
  }

  const paramsToAddKeys = new Set(Object.keys(params_to_add));
  const missingRequiredParams = required_params.filter(param => !paramsToAddKeys.has(param));

  if (missingRequiredParams.length > 0) {
    throw new Error(
      `Guardrail failed: required_params includes params missing from params_to_add: ${missingRequiredParams.join(', ')}`
    );
  }
}

/**
 * Asks the user to confirm an operation.
 *
 * @param {string} message Confirmation message to show.
 * @returns {Promise<boolean>} Whether the user confirmed the operation.
 */
async function confirmAction(message) {
  const rl = readline.createInterface({ input, output });

  try {
    const answer = await rl.question(`${message} Type y/n: `);

    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}

/**
 * Adds configured params to a tool body schema.
 *
 * @param {object} body Tool body schema.
 * @returns {{ body: object, addedParams2Log: string[], addedRequired2Log: string[] }} Updated body and added params to log.
 */
function addParamsToBody(body) {
  const updatedBody = structuredClone(body || {});
  const addedParams2Log = [];
  const addedRequired2Log = [];

  if (!updatedBody.properties || typeof updatedBody.properties !== 'object' || Array.isArray(updatedBody.properties)) {
    updatedBody.properties = {};
  }

  Object.entries(params_to_add).forEach(([param, schema]) => {
    // Keep existing parameter schemas unchanged; only add missing params.
    if (!Object.hasOwn(updatedBody.properties, param)) {
      updatedBody.properties[param] = structuredClone(schema);
      addedParams2Log.push(param);
    }
  });

  if (!Array.isArray(updatedBody.required)) {
    updatedBody.required = [];
  }

  const requiredParams = new Set(updatedBody.required);
  required_params.forEach(param => {
    if (!requiredParams.has(param)) {
      updatedBody.required.push(param);
      requiredParams.add(param);
      addedRequired2Log.push(param);
    }
  });

  return { body: updatedBody, addedParams2Log, addedRequired2Log };
}

/**
 * Patches a Vapi tool with an updated body schema.
 *
 * @param {object} tool Target Vapi tool.
 * @param {object} body Updated tool body schema.
 * @returns {Promise<object>} Updated Vapi tool response.
 */
async function patchTool(tool, body) {
  const toolUrl = `https://api.vapi.ai/tool/${tool.id}`;

  const response = await fetch(toolUrl, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      body
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to patch ${tool.name} (${tool.id}). HTTP status: ${response.status}`);
  }

  return response.json();
}

/**
 * Fetches all Vapi tools and collects tools whose names start with the
 * configured prefix.
 */
async function collectTargetTools() {
  try {
    validateGuardrails();

    if (!apiKey) {
      throw new Error('VAPI_API_KEY environment variable is required');
    }

    const confirmed = await confirmAction(
      `Are you sure to add ${Object.keys(params_to_add).join(', ')} parameters to Vapi tools starting with "${filter_prefix}"?`
    );
    if (!confirmed) {
      console.log('Cancelled. No Vapi tools were fetched or changed.');
      return [];
    }

    const toolsUrl = 'https://api.vapi.ai/tool?limit=1000';
    console.log(`Fetching all tools from: ${toolsUrl}`);

    const response = await fetch(toolsUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const allTools = await response.json();
    const targetTools = allTools.filter(tool =>
      tool.type === 'apiRequest' &&
      typeof tool.name === 'string' &&
      tool.name.startsWith(filter_prefix)
    );

    if (targetTools.length === 0) {
      throw new Error(`No apiRequest tools found starting with "${filter_prefix}"`);
    }

    console.log(`\nTarget tools found: ${targetTools.length}`);
    targetTools.forEach(tool => {
      console.log(`- ${tool.name}`);
    });

    const modifyConfirmed = await confirmAction('Are you sure you want to modify these tools?');
    if (!modifyConfirmed) {
      console.log('Cancelled. No Vapi tools were changed.');
      return targetTools;
    }

    for (const tool of targetTools) {
      const { body, addedParams2Log, addedRequired2Log } = addParamsToBody(tool.body);

      if (addedParams2Log.length === 0 && addedRequired2Log.length === 0) {
        console.log(`Skipped ${tool.name}: params and required entries already exist.`);
        continue;
      }

      await patchTool(tool, body);

      const changes = [];
      if (addedParams2Log.length > 0) {
        changes.push(`added properties ${addedParams2Log.join(', ')}`);
      }
      if (addedRequired2Log.length > 0) {
        changes.push(`added required ${addedRequired2Log.join(', ')}`);
      }

      console.log(`Patched ${tool.name}: ${changes.join('; ')}.`);
    }

    return targetTools;
  } catch (error) {
    console.error('Error:', error.message);
    return [];
  }
}

collectTargetTools();
