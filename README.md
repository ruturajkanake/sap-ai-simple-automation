# SAP AI Automation Testing Agent

A small Node.js browser agent for SAP UI5 testing. It uses Puppeteer for browser control, an in-page **browser-use-style `buildDomTree`** snapshot to identify interactive elements, and Azure OpenAI structured JSON output to choose each next action.

## Setup

Requires Node.js 22+ and an Azure OpenAI API key, endpoint, and vision-capable model deployment that supports Structured Outputs.

```bash
npm install
cp .env.example .env
# Set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, and AZURE_OPENAI_DEPLOYMENT in .env
```

## Run

```bash
npm start -- "https://your-sap-host.example/app" "Log in and verify the Sales Orders list is visible"
```

The run writes a screenshot for each decision and a `result.json` under `artifacts/`.

## Agent loop

1. Navigates to the SAP URL and allows UI5 to render.
2. Executes `buildDomTree` in the page and every browser frame, assigning ephemeral `data-sap-ai-id` attributes to visible interactive nodes.
3. Takes a screenshot and sends it, the goal, and compact DOM data to Azure OpenAI.
4. Requires strict Azure OpenAI JSON conforming to `action`, `target_id`, `text_value`, and `reasoning`.
5. Clicks/types the selected target, and repeats until `done`, `fail`, or `MAX_STEPS`.

If a UI5 rerender removes the chosen element after Azure OpenAI has selected it, the agent records the stale target, refreshes the DOM and screenshot, and requests a new action instead of terminating the run.

Before each browser action, the target is scrolled into view. Nodes Puppeteer still reports as not clickable are treated as a recoverable UI state: the agent records the result, re-observes the page, and selects again.

`type` actions are allowed only on DOM nodes explicitly marked `editable: true` (a writable native input/textarea or contenteditable node). This prevents an AI-selected focusable link or UI5 wrapper from receiving a typing action.

If Azure OpenAI returns an ID not present in the current snapshot, it receives up to two corrective retries with the valid IDs before the agent discards that snapshot and observes the UI again.

Azure OpenAI `fail` decisions receive up to two UI5 rechecks: each waits two seconds, takes fresh DOM/frame and screenshot observations, and asks again. Only a third consecutive `fail` ends the run.

Azure OpenAI 429/rate-limit errors use exponential retries (2/4/8/16/32 seconds). Set `AZURE_OPENAI_DEPLOYMENT` to the Azure deployment name; `AZURE_OPENAI_MODEL` is accepted as an alias.

## Secret references in testing goals

Put credentials or other sensitive values in `.env`, then refer to them by their environment-variable name with a dollar sign. Azure OpenAI receives the reference, not its value.

```dotenv
USERNAME=my-test-user
PASSWORD=my-test-password
```

```bash
npm start -- "https://your-sap-host.example/app" 'Sign in with $USERNAME and $PASSWORD, then verify the home page loads'
```

`$NAME` references are recognized only when they are the complete `text_value` chosen by the model. The agent resolves them from `process.env` immediately before typing into the browser; resolved values are not added to the Azure OpenAI prompt, action history, console output, or artifacts. Quote the goal with single quotes in a shell so the shell does not expand `$USERNAME` before Node receives it.

Puppeteer execution logs identify the selected target and action. For typed values, they log only a literal-value length or an environment-variable name and length, never the value itself. A missing or empty referenced environment variable stops the action with a clear error instead of silently submitting an empty field.

The extractor includes iframe documents, so authentication and content modals rendered inside a frame appear in the action list and execute in the correct frame.

If navigation replaces a selected iframe after the snapshot, the agent treats the detached frame as a stale target and re-observes all frames instead of terminating.

## Safety notes

This is intentionally goal-driven and can act in a real SAP system. Point it at a non-production tenant and write testing goals that avoid irreversible actions. DOM IDs are only valid for the snapshot that generated them; the agent extracts the tree again after every UI change.
