#!/usr/bin/env node
import { readFileSync } from 'fs';
import { createClient } from '../lib/runtime.js';
import { ensureAgentDaemon, isAgentDaemonRunning } from '../lib/agent-manager.js';

const args = process.argv.slice(2);
const client = createClient();

function printHelp() {
  console.log(`nerovaagent commands:
  (no command)                      Activate the local agent daemon
  playwright-launch                 Warm the local Playwright runtime
  start <prompt|string>             Kick off a run with the given prompt
    --prompt-file <path>            Read prompt from a file
    --context <string>              Supply additional context notes for the run
    --context-file <path>           Load context notes from a file
    --critic-key <key>              Override critic OpenAI key
    --assistant-key <key>           Override Step 4 assistant key
    --assistant-id <id>             Override Step 4 assistant id
  status                            Fetch runtime status
  help                              Show this message
`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    const consume = () => {
      i += 1;
      return next;
    };
    if (token === '--prompt-file' && next) {
      out.promptFile = consume();
      continue;
    }
    if (token === '--prompt' && next) {
      out.prompt = consume();
      continue;
    }
    if (token === '--context' && next) {
      out.context = consume();
      continue;
    }
    if (token === '--context-file' && next) {
      out.contextFile = consume();
      continue;
    }
    if (token === '--critic-key' && next) {
      out.criticKey = consume();
      continue;
    }
    if (token === '--assistant-key' && next) {
      out.assistantKey = consume();
      continue;
    }
    if (token === '--assistant-id' && next) {
      out.assistantId = consume();
      continue;
    }
    out._.push(token);
  }
  return out;
}

async function callRuntime(pathname, { method = 'GET', body } = {}) {
  return client.request(pathname, { method, body });
}

function loadFileSafe(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(`Failed to read ${filePath}:`, err?.message || err);
    process.exit(1);
  }
  return '';
}

async function handleActivate() {
  try {
    const pid = await ensureAgentDaemon({ origin: client.config.origin });
    console.log(`[nerovaagent] agent daemon running (pid ${pid})`);
    console.log('[nerovaagent] You can now run `nerovaagent playwright-launch` or `nerovaagent start "<prompt>"`.');
  } catch (err) {
    console.error('Failed to activate agent daemon:', err?.message || err);
    process.exit(1);
  }
}

async function requireAgentDaemon() {
  if (await isAgentDaemonRunning()) return true;
  console.error('No active nerova agent daemon detected. Run `nerovaagent` first to activate it.');
  process.exit(1);
}

async function handleStart(options) {
  let prompt = options.prompt;
  if (!prompt && options.promptFile) {
    prompt = loadFileSafe(options.promptFile);
  }
  if (!prompt && options._.length > 0) {
    prompt = options._.join(' ');
  }
  if (!prompt || !prompt.trim()) {
    console.error('A prompt is required. Pass as argument or use --prompt/--prompt-file.');
    process.exit(1);
  }

  let contextNotes = options.context || '';
  if (!contextNotes && options.contextFile) {
    contextNotes = loadFileSafe(options.contextFile);
  }

  const payload = {
    prompt: prompt.trim(),
    contextNotes: contextNotes ? contextNotes.trim() : '',
    criticKey: options.criticKey || process.env.NEROVA_AGENT_CRITIC_KEY || null,
    assistantKey: options.assistantKey || process.env.NEROVA_AGENT_ASSISTANT_KEY || null,
    assistantId: options.assistantId || process.env.NEROVA_AGENT_ASSISTANT_ID || null
  };

  await requireAgentDaemon();

  try {
    const result = await callRuntime('/run/start', { method: 'POST', body: payload });
    renderRunResult(result);
  } catch (err) {
    console.error('Failed to start agent:', err?.message || err);
    if (err?.data) {
      console.error('Runtime response:', err.data);
    }
    process.exit(1);
  }
}

async function handlePlaywrightLaunch() {
  await requireAgentDaemon();
  try {
    const result = await callRuntime('/runtime/playwright/launch', { method: 'POST' });
    console.log('Playwright ready:', JSON.stringify(result));
  } catch (err) {
    console.error('Failed to warm Playwright runtime:', err?.message || err);
    if (err?.data) {
      console.error('Runtime response:', err.data);
    }
    process.exit(1);
  }
}

async function handleStatus() {
  try {
    const result = await callRuntime('/healthz', { method: 'GET' });
    console.log('Runtime status:', JSON.stringify(result));
  } catch (err) {
    console.error('Runtime not reachable:', err?.message || err);
    process.exit(1);
  }
}

function renderRunResult(run) {
  if (!run || typeof run !== 'object') {
    console.log('Agent response:', JSON.stringify(run));
    return;
  }
  const status = run.status || (run.ok ? 'completed' : 'unknown');
  console.log(`[nerovaagent] status=${status} iterations=${run.iterations ?? 'n/a'} agent=${run.agent?.id ?? 'unknown'}`);

  const timeline = Array.isArray(run.timeline) ? run.timeline : [];
  if (!timeline.length) {
    console.log('[nerovaagent] timeline: <empty>');
  }
  for (const entry of timeline) {
    const iter = entry.iteration ?? '?';
    const decision = entry.decision || {};
    const action = decision.action || 'none';
    const reason = decision.reason || decision.summary || decision?.target?.reason || '';
    console.log(` step ${iter}: action=${action}${reason ? ` :: ${reason}` : ''}`);
    if (decision.target && typeof decision.target === 'object') {
      const hints = decision.target.hints || {};
      const exact = Array.isArray(hints.text_exact) ? hints.text_exact.join(' | ') : '';
      const partial = hints.text_partial || (Array.isArray(hints.text_contains) && hints.text_contains[0]) || '';
      const label = exact || partial;
      if (label) {
        console.log(`   target: ${label}`);
      }
    }
    const result = entry.result || {};
    if (result.next && result.next !== 'continue') {
      console.log(`   result: next=${result.next}${result.reason ? ` reason=${result.reason}` : ''}`);
    } else if (result.clicked) {
      console.log(`   clicked: ${result.clicked.name || result.clicked.id || 'candidate'} (state=${result.clicked.hit_state || 'n/a'})`);
    }
    if (entry.assistant) {
      const parsed = entry.assistant.parsed || entry.assistant.raw;
      console.log(`   assistant: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
    }
  }

  if (Array.isArray(run.completeHistory) && run.completeHistory.length) {
    console.log(` complete history: ${run.completeHistory.join(' | ')}`);
  }

  const successStatuses = new Set(['completed']);
  if (!successStatuses.has(status)) {
    process.exitCode = 1;
    console.error(`[nerovaagent] run finished with status ${status}. Inspect timeline for details.`);
  }
}

async function main() {
  const options = parseArgs(args.slice(1));
  switch (args[0]) {
    case 'agent-daemon':
      await import('../lib/agent-daemon.js');
      break;
    case 'activate':
      await handleActivate();
      break;
    case 'playwright-launch':
      await handlePlaywrightLaunch();
      break;
    case 'start':
      await handleStart(options);
      break;
    case 'status':
      await handleStatus();
      break;
    case 'help':
      printHelp();
      break;
    case undefined:
      await handleActivate();
      break;
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${args[0]}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
