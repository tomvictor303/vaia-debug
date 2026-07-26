require('dotenv').config();

const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');

const VAPI_TOOLS_URL = 'https://api.vapi.ai/tool?limit=1000';
const TELNYX_TOOLS_URL = 'https://api.telnyx.com/v2/ai/tools';

const vapiApiKey = process.env.VAPI_API_KEY?.trim();
const telnyxApiKey = (
  process.env.TELNYX_API_KEY ||
  ''
).trim();

async function ask(question) {
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function promptForToolNamePrefix() {
  const prefix = await ask('Vapi API request tool name prefix to import: ');
  if (prefix.length <= 3) {
    throw new Error('Guardrail failed: prefix must be more than 3 characters');
  }
  return prefix;
}

async function confirmImport(createCount, updateCount) {
  const answer = await ask(
    `Create ${createCount} and update ${updateCount} webhook tool(s) in Telnyx? Type y/n: `
  );
  return answer.toLowerCase() === 'y';
}

async function readErrorResponse(response) {
  try {
    const text = await response.text();
    return text ? `: ${text}` : '';
  } catch {
    return '';
  }
}

async function fetchVapiTools() {
  console.log(`Fetching Vapi tools from: ${VAPI_TOOLS_URL}`);
  const response = await fetch(VAPI_TOOLS_URL, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${vapiApiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Vapi tools request failed (${response.status} ${response.statusText})` +
      await readErrorResponse(response)
    );
  }

  const tools = await response.json();
  if (!Array.isArray(tools)) {
    throw new Error('Unexpected Vapi response: expected an array of tools');
  }
  return tools;
}

async function fetchTelnyxTools() {
  console.log(`Fetching Telnyx tools from: ${TELNYX_TOOLS_URL}`);
  const response = await fetch(TELNYX_TOOLS_URL, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${telnyxApiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Telnyx tools request failed (${response.status} ${response.statusText})` +
      await readErrorResponse(response)
    );
  }

  const responseBody = await response.json();
  if (!Array.isArray(responseBody?.data)) {
    throw new Error('Unexpected Telnyx response: expected response.data to be an array');
  }
  return responseBody.data;
}

function normalizeSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return {
      type: 'object',
      properties: {},
      additionalProperties: false,
    };
  }

  const normalized = {};

  if (typeof schema.type === 'string') normalized.type = schema.type;
  if (typeof schema.description === 'string' && schema.description.trim()) {
    normalized.description = schema.description;
  }
  if (Array.isArray(schema.enum)) normalized.enum = structuredClone(schema.enum);

  if (schema.items && typeof schema.items === 'object') {
    normalized.items = normalizeSchema(schema.items);
  }

  if (schema.properties && typeof schema.properties === 'object') {
    normalized.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, propertySchema]) => [
        name,
        normalizeSchema(propertySchema),
      ])
    );
  } else if (schema.type === 'object') {
    normalized.properties = {};
  }

  if (Array.isArray(schema.required) && schema.required.length > 0) {
    normalized.required = [...schema.required];
  }

  if (schema.type === 'object' || normalized.properties) {
    normalized.additionalProperties = false;
  }

  return normalized;
}

function canonicalize(value, parentKey = '') {
  if (Array.isArray(value)) {
    const items = value.map(item => canonicalize(item));
    return parentKey === 'required' || parentKey === 'enum'
      ? items.sort((first, second) =>
          JSON.stringify(first).localeCompare(JSON.stringify(second))
        )
      : items;
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonicalize(value[key], key)])
    );
  }

  return value;
}

function getVapiPatchValues(vapiTool) {
  return {
    description:
      typeof vapiTool?.function?.description === 'string' &&
      vapiTool.function.description.trim()
        ? vapiTool.function.description.trim()
        : '-',
    url: typeof vapiTool?.url === 'string' ? vapiTool.url.trim() : '',
    body_parameters: normalizeSchema(vapiTool?.body),
  };
}

function isSemanticallyDifferent(vapiTool, telnyxTool) {
  const toolDefinition = telnyxTool?.tool_definition;
  if (!toolDefinition || typeof toolDefinition !== 'object') return true;

  const desired = getVapiPatchValues(vapiTool);
  const currentDescription =
    typeof toolDefinition.description === 'string'
      ? toolDefinition.description.trim()
      : '';
  const currentUrl =
    typeof toolDefinition.url === 'string' ? toolDefinition.url.trim() : '';
  const currentBodyParameters = normalizeSchema(toolDefinition.body_parameters);

  return (
    currentDescription !== desired.description ||
    currentUrl !== desired.url ||
    JSON.stringify(canonicalize(currentBodyParameters)) !==
      JSON.stringify(canonicalize(desired.body_parameters))
  );
}

function vapiToolToTelnyxPayload(tool) {
  const name = tool?.name;
  if (typeof name !== 'string' || !name) {
    throw new Error('Vapi tool name is missing');
  }
  if (typeof tool.url !== 'string' || !tool.url) {
    throw new Error(`Vapi tool "${name}" URL is missing`);
  }

  const patchValues = getVapiPatchValues(tool);

  return {
    type: 'webhook',
    display_name: name,
    webhook: {
      name,
      description: patchValues.description,
      url: tool.url,
      method: (tool.method || 'POST').toUpperCase(),
      body_parameters: patchValues.body_parameters,
      headers: [],
      async: tool.async === true,
    },
  };
}

function vapiToolToTelnyxPatchPayload(vapiTool, telnyxTool) {
  const toolDefinition = telnyxTool?.tool_definition;
  if (!telnyxTool?.id) {
    throw new Error(`Existing Telnyx tool for "${vapiTool?.name}" has no ID`);
  }
  if (!toolDefinition || typeof toolDefinition !== 'object') {
    throw new Error(`Telnyx tool "${telnyxTool.id}" has no tool_definition`);
  }

  const essentialFields = [
    'name',
    'description',
    'url',
    'method',
    'body_parameters',
  ];
  const missingFields = essentialFields.filter(
    field => toolDefinition[field] === undefined || toolDefinition[field] === null
  );
  if (missingFields.length > 0) {
    throw new Error(
      `Telnyx tool "${telnyxTool.id}" is missing essential tool_definition field(s): ` +
      missingFields.join(', ')
    );
  }
  if (typeof vapiTool?.url !== 'string' || !vapiTool.url) {
    throw new Error(`Vapi tool "${vapiTool?.name || '(unnamed tool)'}" URL is missing`);
  }

  const webhook = {
    name: toolDefinition.name,
    description: toolDefinition.description,
    url: toolDefinition.url,
    method: toolDefinition.method,
    body_parameters: structuredClone(toolDefinition.body_parameters),
  };

  const patchValues = getVapiPatchValues(vapiTool);
  webhook.description = patchValues.description;
  webhook.url = patchValues.url;
  webhook.body_parameters = patchValues.body_parameters;

  return { webhook };
}

async function createTelnyxTool(payload) {
  const response = await fetch(TELNYX_TOOLS_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${telnyxApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(
      `Telnyx create request failed (${response.status} ${response.statusText})` +
      await readErrorResponse(response)
    );
  }

  return response.json();
}

async function updateTelnyxTool(toolId, payload) {
  const response = await fetch(`${TELNYX_TOOLS_URL}/${encodeURIComponent(toolId)}`, {
    method: 'PATCH',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${telnyxApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(
      `Telnyx update request failed (${response.status} ${response.statusText})` +
      await readErrorResponse(response)
    );
  }

  return response.json();
}

async function importTools() {
  if (!vapiApiKey) {
    throw new Error('VAPI_API_KEY environment variable is required');
  }
  if (!telnyxApiKey) {
    throw new Error('TELNYX_API_KEY environment variable is required');
  }

  const toolNamePrefix = await promptForToolNamePrefix();
  const [vapiTools, telnyxTools] = await Promise.all([
    fetchVapiTools(),
    fetchTelnyxTools(),
  ]);

  const targetVapiTools = vapiTools
    .filter(
      tool =>
        tool?.type === 'apiRequest' &&
        typeof tool.name === 'string' &&
        tool.name.startsWith(toolNamePrefix)
    )
    .sort((first, second) => first.name.localeCompare(second.name));
  const targetVapiToolNames = new Set(targetVapiTools.map(tool => tool.name));

  const telnyxToolsByDefinitionName = new Map();
  telnyxTools.forEach(tool => {
    const name = tool?.tool_definition?.name;
    const currentTool = telnyxToolsByDefinitionName.get(name);
    if (
      typeof name === 'string' &&
      name &&
      (!currentTool || (currentTool.type !== 'webhook' && tool.type === 'webhook'))
    ) {
      telnyxToolsByDefinitionName.set(name, tool);
    }
  });
  const telnyxOnlyWebhookTools = telnyxTools
    .filter(tool => {
      const name = tool?.tool_definition?.name;
      return (
        tool?.type === 'webhook' &&
        typeof name === 'string' &&
        name.startsWith(toolNamePrefix) &&
        !targetVapiToolNames.has(name)
      );
    })
    .sort((first, second) =>
      first.tool_definition.name.localeCompare(second.tool_definition.name)
    );

  const existingWebhookTools = targetVapiTools
    .map(vapiTool => ({
      vapiTool,
      telnyxTool: telnyxToolsByDefinitionName.get(vapiTool.name),
    }))
    .filter(pair => pair.telnyxTool?.type === 'webhook');
  const toolsToUpdate = existingWebhookTools.filter(({ vapiTool, telnyxTool }) =>
    isSemanticallyDifferent(vapiTool, telnyxTool)
  );
  const unchangedTools = existingWebhookTools.filter(
    ({ vapiTool, telnyxTool }) => !isSemanticallyDifferent(vapiTool, telnyxTool)
  );
  const conflictingTools = targetVapiTools
    .map(vapiTool => ({
      vapiTool,
      telnyxTool: telnyxToolsByDefinitionName.get(vapiTool.name),
    }))
    .filter(pair => pair.telnyxTool && pair.telnyxTool.type !== 'webhook');
  const toolsToCreate = targetVapiTools.filter(
    tool => !telnyxToolsByDefinitionName.has(tool.name)
  );

  console.log(`\nVapi tools fetched: ${vapiTools.length}`);
  console.log(
    `Vapi apiRequest tools starting with "${toolNamePrefix}": ${targetVapiTools.length}`
  );
  console.log(`Existing Telnyx webhook tools to update: ${toolsToUpdate.length}`);
  toolsToUpdate.forEach(({ vapiTool, telnyxTool }) =>
    console.log(`- UPDATE ${vapiTool.name} (${telnyxTool.id})`)
  );
  console.log(
    `Semantically same (no need to update) Telnyx webhook tools: ${unchangedTools.length}`
  );
  unchangedTools.forEach(({ vapiTool, telnyxTool }) =>
    console.log(`- SAME ${vapiTool.name} (${telnyxTool.id})`)
  );
  console.log(`Missing Telnyx webhook tools to create: ${toolsToCreate.length}`);
  toolsToCreate.forEach(tool => console.log(`- CREATE ${tool.name}`));
  console.log(`Same-name non-webhook Telnyx conflicts: ${conflictingTools.length}`);
  conflictingTools.forEach(({ vapiTool, telnyxTool }) =>
    console.log(
      `- CONFLICT ${vapiTool.name} (${telnyxTool.type || 'unknown type'}, ${telnyxTool.id})`
    )
  );
  console.log(
    `Telnyx-only webhook tools matching "${toolNamePrefix}": ${telnyxOnlyWebhookTools.length}`
  );
  telnyxOnlyWebhookTools.forEach(tool =>
    console.log(`- TELNYX ONLY ${tool.tool_definition.name} (${tool.id})`)
  );

  if (toolsToCreate.length === 0 && toolsToUpdate.length === 0) {
    console.log('\nNo webhook tools to create or update.');
    return {
      toolNamePrefix,
      targetVapiTools,
      toolsToUpdate,
      unchangedTools,
      toolsToCreate,
      conflictingTools,
      telnyxOnlyWebhookTools,
      createdTools: [],
      updatedTools: [],
      failedTools: [],
    };
  }

  const confirmed = await confirmImport(toolsToCreate.length, toolsToUpdate.length);
  if (!confirmed) {
    console.log('Cancelled. No Telnyx tools were created or updated.');
    return {
      toolNamePrefix,
      targetVapiTools,
      toolsToUpdate,
      unchangedTools,
      toolsToCreate,
      conflictingTools,
      telnyxOnlyWebhookTools,
      createdTools: [],
      updatedTools: [],
      failedTools: [],
    };
  }

  const createdTools = [];
  const updatedTools = [];
  const failedTools = [];

  for (const { vapiTool, telnyxTool } of toolsToUpdate) {
    try {
      const payload = vapiToolToTelnyxPatchPayload(vapiTool, telnyxTool);
      const updatedTool = await updateTelnyxTool(telnyxTool.id, payload);
      updatedTools.push({ sourceTool: vapiTool, updatedTool });
      console.log(`Updated ${vapiTool.name} (${telnyxTool.id})`);
    } catch (error) {
      failedTools.push({
        action: 'update',
        tool: vapiTool,
        error: error.message,
      });
      console.error(`Failed to update ${vapiTool.name}: ${error.message}`);
    }
  }

  for (const tool of toolsToCreate) {
    try {
      const payload = vapiToolToTelnyxPayload(tool);
      const createdTool = await createTelnyxTool(payload);
      createdTools.push({ sourceTool: tool, createdTool });
      console.log(`Created ${tool.name}`);
    } catch (error) {
      failedTools.push({ action: 'create', tool, error: error.message });
      console.error(`Failed to create ${tool.name}: ${error.message}`);
    }
  }

  console.log('\nImport summary');
  console.log(`Target Vapi tools: ${targetVapiTools.length}`);
  console.log(`Telnyx webhook tools updated: ${updatedTools.length}`);
  console.log(
    `Semantically same (no need to update) webhook tools: ${unchangedTools.length}`
  );
  console.log(`Telnyx webhook tools created: ${createdTools.length}`);
  console.log(`Same-name non-webhook conflicts skipped: ${conflictingTools.length}`);
  console.log(`Telnyx-only webhook tools: ${telnyxOnlyWebhookTools.length}`);
  console.log(`Failed operations: ${failedTools.length}`);

  return {
    toolNamePrefix,
    targetVapiTools,
    toolsToUpdate,
    unchangedTools,
    toolsToCreate,
    conflictingTools,
    telnyxOnlyWebhookTools,
    createdTools,
    updatedTools,
    failedTools,
  };
}

if (require.main === module) {
  importTools().catch(error => {
    console.error('Error:', error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  createTelnyxTool,
  fetchTelnyxTools,
  fetchVapiTools,
  importTools,
  isSemanticallyDifferent,
  normalizeSchema,
  updateTelnyxTool,
  vapiToolToTelnyxPatchPayload,
  vapiToolToTelnyxPayload,
};
