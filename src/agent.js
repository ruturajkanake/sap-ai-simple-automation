import OpenAI from 'openai';
import { buildDomTree } from './dom-tree.js';

const ACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  // Azure Structured Outputs requires every property to be required. Terminal
  // actions use null for target_id and text_value.
  required: ['action', 'target_id', 'text_value', 'reasoning'],
  properties: {
    action: { type: 'string', enum: ['click', 'type', 'done', 'fail'] },
    target_id: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'The id from the current interactive-elements list. Required for click/type; null otherwise.' },
    text_value: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Text to enter. Required for type; null otherwise.' },
    reasoning: { type: 'string', description: 'Short explanation of why this is the next test action.' }
  }
};

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const MAX_FAIL_RECHECKS = 2;

async function extractInteractiveElements(page) {
  const targetFrames = new Map();
  const elements = [];
  const frames = page.frames();

  // A number of SAP login/content dialogs are embedded in iframes. Puppeteer
  // can evaluate in same- and cross-origin frames through CDP, while ordinary
  // page.evaluate() sees only the top document.
  for (const [frameIndex, frame] of frames.entries()) {
    try {
      const frameElements = await frame.evaluate(buildDomTree, `f${frameIndex}-`);
      for (const element of frameElements) {
        elements.push({ ...element, frame: frameIndex });
        targetFrames.set(element.id, frame);
      }
    } catch (error) {
      // Frames can be added/removed during UI5 rendering. The next snapshot
      // will include a stable replacement, so do not fail the entire run.
      console.warn(`Could not extract frame ${frameIndex}; it may be navigating or detached.`);
    }
  }
  return { elements, targetFrames };
}

/**
 * Resolve a secret reference only at the browser boundary. Azure OpenAI receives the
 * literal token (for example, "$PASSWORD"), never this returned value.
 * A full-value reference prevents accidental substitution inside normal text.
 */
function resolveTextValue(textValue) {
  const match = /^\$([A-Z_][A-Z0-9_]*)$/.exec(textValue);
  if (!match) return textValue;

  const variableName = match[1];
  const value = process.env[variableName];
  if (value === undefined) {
    throw new Error(`Missing environment variable referenced by action: $${variableName}`);
  }
  if (value.length === 0) {
    throw new Error(`Environment variable referenced by action is empty: $${variableName}`);
  }
  return value;
}

function describeTextSource(textValue) {
  const match = /^\$([A-Z_][A-Z0-9_]*)$/.exec(textValue);
  if (!match) return `literal value (${textValue.length} characters)`;
  const value = process.env[match[1]];
  if (value === undefined) return `$${match[1]} (missing)`;
  if (value.length === 0) return `$${match[1]} (empty)`;
  return `$${match[1]} (resolved, ${value.length} characters)`;
}

function describeTarget(element) {
  if (!element) return 'unknown target';
  const identity = [element.tag, element.type, element.role, element.name]
    .filter(Boolean)
    .join(' · ');
  return identity || `target #${element.id}`;
}

function isRateLimit(error) {
  const message = `${error?.status ?? ''} ${error?.message ?? error}`.toLowerCase();
  return error?.status === 429 || message.includes('resource_exhausted') || message.includes('rate limit') || message.includes('too many requests') || message.includes('429');
}

function getAzureOpenAIClient() {
  const apiKey = process.env.AZURE_OPENAI_API_KEY || process.env.Azure_openai_api_key;
  const endpoint = process.env.AZURE_OPENAI_BASE_URL || process.env.AZURE_OPENAI_ENDPOINT;
  if (!apiKey) throw new Error('AZURE_OPENAI_API_KEY is required. Azure_openai_api_key is also supported for compatibility.');
  if (!endpoint) throw new Error('AZURE_OPENAI_ENDPOINT is required.');

  const normalizedEndpoint = endpoint.replace(/\/+$/, '');
  const isAzureResourceRoot = /^https:\/\/[^/]+\.(openai\.azure\.com|services\.ai\.azure\.com)$/i.test(normalizedEndpoint);
  // Standard Azure resource roots need the v1 suffix. Corporate API gateways
  // (for example, https://orgname.com/openai-chat/) already include their
  // routing path and must be used exactly as supplied.
  const baseURL = isAzureResourceRoot && !normalizedEndpoint.endsWith('/openai/v1')
    ? `${normalizedEndpoint}/openai/v1/`
    : `${normalizedEndpoint}/`;
  return new OpenAI({
    baseURL,
    apiKey,
    // Direct Azure resources use `api-key`. Corporate Azure API Management
    // gateways commonly require `Ocp-Apim-Subscription-Key`. Keep it explicit
    // because the generic SDK otherwise formats a static apiKey as Bearer.
    defaultHeaders: { 'Ocp-Apim-Subscription-Key': apiKey, 'api-key': apiKey }
  });
}

async function getAzureOpenAIAction(client, model, prompt, screenshotBase64) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await client.chat.completions.create({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${screenshotBase64}`, detail: 'low' } }
          ]
        }],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'sap_browser_action',
            strict: true,
            schema: ACTION_SCHEMA
          }
        },
        temperature: 0
      });
      const content = response.choices[0]?.message?.content;
      if (!content) {
        const refusal = response.choices[0]?.message?.refusal;
        throw new Error(refusal ? `Azure OpenAI refused the action request: ${refusal}` : 'Azure OpenAI returned no action content.');
      }
      return JSON.parse(content);
    } catch (error) {
      if (!isRateLimit(error) || attempt === 4) throw error;
      const waitMs = 2_000 * (2 ** attempt);
      console.warn(`Azure OpenAI rate-limited; retrying in ${waitMs}ms (${attempt + 1}/5)`);
      await sleep(waitMs);
    }
  }
}

function validateAction(action, elements) {
  if (!['click', 'type', 'done', 'fail'].includes(action?.action)) throw new Error('Azure OpenAI returned an unsupported action.');
  if (['click', 'type'].includes(action.action)) {
    if (!action.target_id || !elements.some((element) => element.id === action.target_id)) {
      throw new Error(`Azure OpenAI selected unknown target_id: ${action.target_id}`);
    }
    if (action.action === 'type' && typeof action.text_value !== 'string') {
      throw new Error('Azure OpenAI chose type without text_value.');
    }
    if (action.action === 'type' && !elements.find((element) => element.id === action.target_id)?.editable) {
      throw new Error(`Azure OpenAI selected non-editable target_id for type: ${action.target_id}`);
    }
  }
}

async function requestValidatedAction({ client, model, prompt, screenshot, elements }) {
  let correction = '';
  let lastError;

  // An LLM can occasionally hallucinate an id despite structured output. Retry
  // against the same observation before discarding it and rebuilding the tree.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const action = await getAzureOpenAIAction(client, model, `${prompt}${correction}`, screenshot);
    try {
      validateAction(action, elements);
      return { action };
    } catch (error) {
      lastError = error;
      const validIds = elements.map((element) => element.id).join(', ');
      console.warn(`Invalid Azure OpenAI action (attempt ${attempt + 1}/3): ${error.message}`);
      correction = `\n\nYour previous response was invalid: ${error.message} ` +
        `Return a corrected action now. Valid target_id values are only: ${validIds || '(none)'}.`;
    }
  }
  return { action: null, error: lastError };
}

async function performAction(page, action, element, frame) {
  // target_id comes from buildDomTree (including its controlled frame prefix)
  // and is revalidated before this call.
  const selector = `[data-sap-ai-id="${action.target_id}"]`;

  try {
    // Navigation can replace an iframe while Azure OpenAI is deciding. Frame access
    // itself then throws before an ElementHandle can be queried.
    if (!frame) return { executed: false, result: 'target_frame_unavailable' };
    const target = await frame.$(selector);
    if (!target) return { executed: false, result: 'target_disappeared_before_execution' };
    if (action.action === 'click') {
      console.log(`[Puppeteer] clicking #${action.target_id} (${describeTarget(element)})`);
    } else if (action.action === 'type') {
      console.log(`[Puppeteer] typing into #${action.target_id} (${describeTarget(element)}), source: ${describeTextSource(action.text_value)}`);
    }
    // UI5 virtualized content and sticky containers can make an otherwise valid
    // DOM node temporarily outside Puppeteer's clickable viewport.
    await target.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'center' }));
    await sleep(100);
    if (action.action === 'click') {
      await target.click();
    } else if (action.action === 'type') {
      const value = resolveTextValue(action.text_value);
      await target.click({ clickCount: 1, delay: 100 });
      // Puppeteer's key parser does not reliably accept combined strings such
      // as "Meta+A". Send the shortcut as explicit key events instead.
      const selectAllModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
      await page.keyboard.down(selectAllModifier);
      try {
        await page.keyboard.press('a');
      } finally {
        await page.keyboard.up(selectAllModifier);
      }
      
      await page.keyboard.type(value);
      // UI5 listens to input/change; blur ensures the change handler is committed.
      await target.evaluate((element) => element.dispatchEvent(new Event('change', { bubbles: true })));
      await page.keyboard.press('Tab');
    }
    return { executed: true, result: 'executed' };
  } catch (error) {
    // A UI5 rerender can detach the node after page.$ succeeds and before
    // Puppeteer dispatches input. Treat this as a new observation, not a test
    // failure. Other browser errors still surface to preserve debuggability.
    const message = `${error?.message ?? error}`.toLowerCase();
    if (message.includes('detached frame')) {
      return { executed: false, result: 'target_frame_detached' };
    }
    if (message.includes('detached') || message.includes('not attached') || message.includes('execution context was destroyed')) {
      return { executed: false, result: 'target_disappeared_during_execution' };
    }
    if (message.includes('not clickable') || message.includes('not an element') || message.includes('not visible')) {
      return { executed: false, result: 'target_not_clickable' };
    }
    throw error;
  }
}

export async function runSapTestAgent({ page, url, goal, maxSteps, model, artifactDir }) {
  const client = getAzureOpenAIClient();
  if (!model) throw new Error('AZURE_OPENAI_DEPLOYMENT is required. AZURE_OPENAI_MODEL is accepted as an alias.');
  const history = [];
  let failRecheckCount = 0;

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await sleep(2_000); // initial SAP UI5 control rendering

  for (let step = 1; step <= maxSteps; step += 1) {
    const { elements, targetFrames } = await extractInteractiveElements(page);
    const screenshotPath = `${artifactDir}/step-${String(step).padStart(2, '0')}.png`;
    const screenshot = await page.screenshot({ path: screenshotPath, fullPage: false, encoding: 'base64' });
    const recentHistory = history.slice(-6).map(({ action, result }) => ({ action, result }));
    const prompt = `You are an SAP UI5 test agent. Complete this testing goal:\n${goal}\n\n` +
      `Current URL: ${page.url()}\nStep ${step} of ${maxSteps}.\n` +
      `Interactive elements from browser-use-style buildDomTree:\n${JSON.stringify(elements)}\n\n` +
      `Previous actions: ${JSON.stringify(recentHistory)}\n\n` +
      'Choose exactly one safe next action. Use only a target_id from the current list. ' +
      'For a type action, select only an element with editable: true; never type into a link, button, or UI5 wrapper. ' +
      'If the testing goal contains a secret reference such as $USERNAME or $PASSWORD, ' +
      'copy that reference verbatim into text_value; it will be resolved privately at execution time. ' +
      'Never ask for, infer, or reveal the value of a secret reference. ' +
      'Use done only when the goal has been verified, fail when it cannot be completed. Do not submit destructive business actions unless the goal explicitly requires it.';
    const decision = await requestValidatedAction({ client, model, prompt, screenshot, elements });
    if (!decision.action) {
      history.push({ action: { action: 'invalid_model_response' }, result: 'no_valid_target_id' });
      console.warn(`Step ${step}: Azure OpenAI did not select a valid current target; rebuilding the DOM tree.`);
      await sleep(500);
      continue;
    }
    const action = decision.action;
    console.log(`Step ${step}: ${action.action}${action.target_id ? ` #${action.target_id}` : ''} — ${action.reasoning}`);

    if (action.action === 'done') return { status: 'done', history };
    if (action.action === 'fail') {
      // A modal/page can finish rendering between screenshot/DOM extraction and
      // the model response. Always make fresh UI5 observations before ending,
      // but bound them so a genuinely unavailable application terminates.
      if (failRecheckCount < MAX_FAIL_RECHECKS) {
        failRecheckCount += 1;
        history.push({ action, result: 'fail_recheck_requested' });
      console.warn(`Step ${step}: Azure OpenAI returned fail; waiting for UI5 and taking fresh DOM/screenshot observation ${failRecheckCount}/${MAX_FAIL_RECHECKS}.`);
        await sleep(2_000);
        continue;
      }
      return { status: 'fail', history };
    }
    failRecheckCount = 0;
    const selectedElement = elements.find((element) => element.id === action.target_id);
    const execution = await performAction(page, action, selectedElement, targetFrames.get(action.target_id));
    history.push({ action, result: execution.result });
    if (!execution.executed) {
      console.warn(`Step ${step}: ${execution.result}; rebuilding the DOM tree.`);
      await sleep(500);
      continue;
    }
    await sleep(2_000); // mandatory SAP UI5 async loading interval
  }
  return { status: 'fail', history, reason: `Reached MAX_STEPS (${maxSteps})` };
}
