// Not all vapi.ai tools: only apiRequest tools whose URL is
// https://vsrvaiaapi.com/api or a path under it.
require('dotenv').config();
const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');

const apiKey = process.env.VAPI_API_KEY?.trim();
const VAIA_API_URL = 'https://vsrvaiaapi.com/api';
const VAPI_TOOL_LIMIT = 1000;
const params_to_add = {
  "vaiaPlatform": {
    "description": "",
    "type": "string",
    "default": "vapi"
  },
  "vaiaCallerPhoneNumber": {
    "description": "",
    "type": "string",
    "default": "{{customer.number}}"
  }
};
const required_params = [];

/**
 * Validates destructive-action guardrails before any Vapi tools are fetched or
 * changed.
 */
function validateGuardrails() {
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
  const updatedBody = structuredClone(body ?? {});
  if (typeof updatedBody !== 'object' || Array.isArray(updatedBody) ||
      (updatedBody.type != null && updatedBody.type !== 'object')) {
    throw new Error('Tool body must have an object schema to add properties');
  }
  updatedBody.type ??= 'object';
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
  const toolUrl = `https://api.vapi.ai/tool/${encodeURIComponent(tool.id)}`;

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
    throw new Error(`HTTP status: ${response.status}`);
  }
  await response.text();
}

function isVaiaApiRequestTool(tool) {
  if (tool?.type !== 'apiRequest' || typeof tool.url !== 'string' || !tool.url.startsWith(VAIA_API_URL)) {
    return false;
  }

  try {
    const { pathname } = new URL(tool.url);
    return pathname === '/api' || pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

async function fetchAllTools(start = -Infinity, end = Infinity) {
  const toolsUrl = new URL('https://api.vapi.ai/tool');
  toolsUrl.searchParams.set('limit', String(VAPI_TOOL_LIMIT));
  if (Number.isFinite(start)) toolsUrl.searchParams.set('createdAtGe', new Date(start).toISOString());
  if (Number.isFinite(end)) toolsUrl.searchParams.set('createdAtLt', new Date(end).toISOString());

  console.log(`Fetching Vapi tools from ${toolsUrl}`);
  const response = await fetch(toolsUrl, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`Vapi tool list request failed (HTTP ${response.status})`);
  }

  const tools = await response.json();
  if (!Array.isArray(tools)) throw new Error('Unexpected Vapi response: expected an array of tools');
  if (tools.length < VAPI_TOOL_LIMIT) return tools;

  // Split a capped response into disjoint creation-time ranges without relying on list order.
  const timestamps = tools.map(tool => Date.parse(tool?.createdAt));
  const oldest = Math.min(...timestamps);
  const newest = Math.max(...timestamps);
  if (!Number.isFinite(oldest) || oldest < start || newest >= end) {
    throw new Error('Cannot split a capped Vapi tool response with missing or out-of-range creation times');
  }

  const split = Math.max(start + 1, oldest + Math.ceil((newest - oldest) / 2));
  if (split >= end) throw new Error('Vapi tool list limit reached within a single millisecond');

  const earlierTools = await fetchAllTools(start, split);
  const laterTools = await fetchAllTools(split, end);
  return earlierTools.concat(laterTools);
}

async function collectTargetTools() {
  try {
    validateGuardrails();

    if (!apiKey) {
      throw new Error('VAPI_API_KEY environment variable is required');
    }

    const confirmed = await confirmAction(
      `Find Vapi apiRequest tools for ${VAIA_API_URL} to add ${Object.keys(params_to_add).join(', ')}?`
    );
    if (!confirmed) {
      console.log('Cancelled. No Vapi tools were fetched or changed.');
      return;
    }

    const allTools = await fetchAllTools();
    const targetTools = allTools.filter(isVaiaApiRequestTool);

    if (targetTools.length === 0) {
      console.log(`No Vapi apiRequest tools found for ${VAIA_API_URL}.`);
      return;
    }

    console.log(`\nTarget tools found: ${targetTools.length}`);
    targetTools.forEach(tool => {
      console.log(`- ${tool.name || tool.id} (${tool.url})`);
    });

    const modifyConfirmed = await confirmAction('Are you sure you want to modify these tools?');
    if (!modifyConfirmed) {
      console.log('Cancelled. No Vapi tools were changed.');
      return;
    }

    for (const tool of targetTools) {
      try {
        const { body, addedParams2Log, addedRequired2Log } = addParamsToBody(tool.body);

        if (addedParams2Log.length === 0 && addedRequired2Log.length === 0) {
          console.log(`Skipped ${tool.name || tool.id}: params and required entries already exist.`);
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
        console.log(`Patched ${tool.name || tool.id}: ${changes.join('; ')}.`);
      } catch (error) {
        console.error(`Failed to patch ${tool.name || tool.id} (${tool.id}): ${error.message}`);
        process.exitCode = 1;
      }
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exitCode = 1;
  }
}

collectTargetTools();
