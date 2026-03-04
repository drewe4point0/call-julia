const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      const equalsAt = trimmed.indexOf('=');
      if (equalsAt <= 0) {
        continue;
      }
      const key = trimmed.slice(0, equalsAt).trim();
      if (!key || process.env[key] !== undefined) {
        continue;
      }
      let value = trimmed.slice(equalsAt + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch (_err) {}
}

loadEnvFile();

const app = express();
app.use(express.json({ limit: '3mb' }));

const isVercelRuntime = process.env.VERCEL === '1';

function resolvePathFromServerDir(input, fallbackAbsolute) {
  if (!input) {
    return fallbackAbsolute;
  }
  if (path.isAbsolute(input)) {
    return input;
  }
  return path.resolve(__dirname, input);
}

const defaultBrainDir = path.resolve(__dirname, '../brain');
const brainDir = resolvePathFromServerDir(process.env.BRAIN_DIR, defaultBrainDir);
const defaultMemoryDir = isVercelRuntime ? '/tmp/call-julia-memory' : path.join(brainDir, 'memory');
const memoryDir = resolvePathFromServerDir(process.env.MEMORY_DIR, defaultMemoryDir);

const config = {
  port: Number(process.env.PORT || 3789),
  corsOrigins: (process.env.CORS_ORIGINS || '*').split(',').map((item) => item.trim()).filter(Boolean),
  defaultAgentId: process.env.ELEVENLABS_AGENT_ID || '',
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || '',
  llmProvider: (process.env.LLM_PROVIDER || 'openai-compatible').toLowerCase(),
  llmBaseUrl: process.env.LLM_BASE_URL || 'http://localhost:3456',
  llmApiKey: process.env.LLM_API_KEY || '',
  llmModel: process.env.LLM_MODEL || 'claude-sonnet-4-20250514',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicVersion: process.env.ANTHROPIC_VERSION || '2023-06-01',
  llmMaxTokens: Number(process.env.LLM_MAX_TOKENS || 450),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  imessageTo: process.env.IMESSAGE_TO || '',
  enableIMessage: process.env.ENABLE_IMESSAGE === 'true',
  brainDir,
  memoryDir,
  contextFiles: (process.env.CONTEXT_FILES || 'soul.md,claude.md,user.md,memories.md,memory.md,tools.md')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean),
  recentMemoryFiles: Number(process.env.RECENT_MEMORY_FILES || 2),
  timezone: process.env.TIMEZONE || 'America/Vancouver',
  assistantName: process.env.ASSISTANT_NAME || 'Julia',
};

if (config.llmProvider === 'anthropic' && !config.anthropicApiKey) {
  console.warn('[WARN] LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is missing.');
}
if (config.llmProvider === 'openai-compatible' && !config.llmBaseUrl) {
  console.warn('[WARN] LLM_PROVIDER=openai-compatible but LLM_BASE_URL is missing.');
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowAll = config.corsOrigins.includes('*');
  if (allowAll) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && config.corsOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-call-id');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  return next();
});

app.use((req, _res, next) => {
  if (req.path === '/health') {
    return next();
  }
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  return next();
});

function toSingleString(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (item && typeof item === 'object') {
          if (typeof item.text === 'string') {
            return item.text;
          }
          if (typeof item.content === 'string') {
            return item.content;
          }
        }
        return '';
      })
      .join('\n')
      .trim();
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') {
      return content.text;
    }
    return JSON.stringify(content);
  }
  return '';
}

function normalizeMessages(messages) {
  const normalized = [];
  for (const message of messages || []) {
    if (!message || !message.role) {
      continue;
    }
    if (message.role === 'system') {
      continue;
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content = toSingleString(message.content).trim();
    if (!content) {
      continue;
    }
    const previous = normalized[normalized.length - 1];
    if (previous && previous.role === role) {
      previous.content = `${previous.content}\n${content}`.trim();
    } else {
      normalized.push({ role, content });
    }
  }
  if (normalized.length === 0 || normalized[0].role !== 'user') {
    normalized.unshift({ role: 'user', content: `Hey ${config.assistantName}` });
  }
  return normalized;
}

function tryRead(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_err) {
    return null;
  }
}

function collectExistingContextFiles() {
  const entries = [];
  for (const fileName of config.contextFiles) {
    const normalized = fileName.toLowerCase();
    const variants = Array.from(
      new Set([
        fileName,
        normalized,
        fileName.toUpperCase(),
        normalized.replace(/\.md$/, '.MD'),
      ]),
    );
    for (const variant of variants) {
      const fullPath = path.join(config.brainDir, variant);
      const content = tryRead(fullPath);
      if (content) {
        entries.push({ label: variant, content });
        break;
      }
    }
  }
  return entries;
}

function collectRecentMemoryFiles() {
  try {
    const files = fs
      .readdirSync(config.memoryDir)
      .filter((file) => file.toLowerCase().endsWith('.md'))
      .sort()
      .reverse()
      .slice(0, Math.max(config.recentMemoryFiles, 0));
    return files
      .map((file) => {
        const fullPath = path.join(config.memoryDir, file);
        const content = tryRead(fullPath);
        if (!content) {
          return null;
        }
        return { label: path.join('memory', file), content };
      })
      .filter(Boolean);
  } catch (_err) {
    return [];
  }
}

function clip(input, maxChars) {
  if (!input) {
    return '';
  }
  if (input.length <= maxChars) {
    return input;
  }
  return `${input.slice(0, maxChars)}\n...[truncated]`;
}

function loadAssistantContext() {
  const sections = [];
  for (const item of collectExistingContextFiles()) {
    sections.push(`=== ${item.label} ===\n${item.content}`);
  }
  for (const item of collectRecentMemoryFiles()) {
    sections.push(`=== ${item.label} ===\n${item.content}`);
  }
  return clip(sections.join('\n\n'), 30000);
}

function buildSystemPrompt() {
  return `You are ${config.assistantName}, in a live voice conversation.

Voice style rules:
- Speak naturally; short answers by default (2-5 sentences).
- No markdown, no XML, no code blocks.
- Be direct, warm, and practical.

Action protocol:
- If the user asks for a concrete task, include exactly ONE action tag at the very end:
[ACTION type="telegram" message="..."]
- Use concise actionable phrasing in message.
- Only include an action tag when an action is actually requested.

Current local time (${config.timezone}): ${new Date().toLocaleString('en-US', { timeZone: config.timezone })}

Long-term assistant context:
${loadAssistantContext()}`;
}

async function* streamFromOpenAiCompatible(systemPrompt, messages) {
  const payload = {
    model: config.llmModel,
    max_tokens: config.llmMaxTokens,
    stream: true,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
  };

  const headers = { 'Content-Type': 'application/json' };
  if (config.llmApiKey) {
    headers.Authorization = `Bearer ${config.llmApiKey}`;
  }

  const response = await fetch(`${config.llmBaseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`LLM stream failed: ${response.status} ${await response.text()}`);
  }
  if (!response.body) {
    throw new Error('LLM stream failed: empty response body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() || '';
    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) {
          continue;
        }
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') {
          continue;
        }
        try {
          const parsed = JSON.parse(data);
          const chunk = parsed.choices?.[0]?.delta?.content;
          if (typeof chunk === 'string' && chunk.length > 0) {
            yield chunk;
          }
        } catch (_err) {}
      }
    }
  }

  if (buffer.trim().length > 0) {
    for (const line of buffer.split('\n')) {
      if (!line.startsWith('data:')) {
        continue;
      }
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') {
        continue;
      }
      try {
        const parsed = JSON.parse(data);
        const chunk = parsed.choices?.[0]?.delta?.content;
        if (typeof chunk === 'string' && chunk.length > 0) {
          yield chunk;
        }
      } catch (_err) {}
    }
  }
}

async function completeFromOpenAiCompatible(systemPrompt, messages) {
  const payload = {
    model: config.llmModel,
    max_tokens: config.llmMaxTokens,
    stream: false,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
  };

  const headers = { 'Content-Type': 'application/json' };
  if (config.llmApiKey) {
    headers.Authorization = `Bearer ${config.llmApiKey}`;
  }

  const response = await fetch(`${config.llmBaseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`LLM call failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return toSingleString(data.choices?.[0]?.message?.content || '');
}

function toAnthropicMessages(messages) {
  return messages.map((message) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: [{ type: 'text', text: message.content }],
  }));
}

async function* streamFromAnthropic(systemPrompt, messages) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.anthropicApiKey,
      'anthropic-version': config.anthropicVersion,
    },
    body: JSON.stringify({
      model: config.llmModel,
      max_tokens: config.llmMaxTokens,
      system: systemPrompt,
      messages: toAnthropicMessages(messages),
      stream: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic stream failed: ${response.status} ${await response.text()}`);
  }
  if (!response.body) {
    throw new Error('Anthropic stream failed: empty response body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() || '';

    for (const frame of frames) {
      let eventType = '';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) {
          eventType = line.slice(6).trim();
        }
        if (line.startsWith('data:')) {
          data = line.slice(5).trim();
        }
      }
      if (!data || !eventType) {
        continue;
      }
      if (eventType === 'content_block_delta') {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.delta?.text;
          if (typeof text === 'string' && text.length > 0) {
            yield text;
          }
        } catch (_err) {}
      }
    }
  }
}

async function completeFromAnthropic(systemPrompt, messages) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.anthropicApiKey,
      'anthropic-version': config.anthropicVersion,
    },
    body: JSON.stringify({
      model: config.llmModel,
      max_tokens: config.llmMaxTokens,
      system: systemPrompt,
      messages: toAnthropicMessages(messages),
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic call failed: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  return (data.content || [])
    .filter((item) => item && item.type === 'text')
    .map((item) => item.text || '')
    .join('')
    .trim();
}

async function* streamModel(systemPrompt, messages) {
  if (config.llmProvider === 'anthropic') {
    yield* streamFromAnthropic(systemPrompt, messages);
    return;
  }
  yield* streamFromOpenAiCompatible(systemPrompt, messages);
}

async function completeModel(systemPrompt, messages) {
  if (config.llmProvider === 'anthropic') {
    return completeFromAnthropic(systemPrompt, messages);
  }
  return completeFromOpenAiCompatible(systemPrompt, messages);
}

function stripInternalTags(text) {
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, ' ')
    .replace(/\[ACTION\s+[^\]]+\]/gi, ' ')
    .replace(/\[ACTION:[^\]]+\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseActionTag(tagText) {
  const attrs = {};
  const regex = /(\w+)="([^"]*)"/g;
  let match = regex.exec(tagText);
  while (match) {
    attrs[match[1].toLowerCase()] = match[2];
    match = regex.exec(tagText);
  }
  return {
    type: (attrs.type || 'telegram').toLowerCase(),
    message: (attrs.message || '').trim(),
    channel: (attrs.channel || 'telegram').toLowerCase(),
  };
}

function extractActions(text) {
  const actions = [];
  const regex = /\[ACTION\s+([^\]]+)\]/gi;
  let match = regex.exec(text);
  while (match) {
    actions.push(parseActionTag(match[1]));
    match = regex.exec(text);
  }
  const legacyRegex = /\[ACTION:\s*([^\]]+)\]/gi;
  let legacyMatch = legacyRegex.exec(text);
  while (legacyMatch) {
    actions.push({
      type: 'telegram',
      channel: 'telegram',
      message: legacyMatch[1].trim(),
    });
    legacyMatch = legacyRegex.exec(text);
  }
  return actions;
}

function sendTelegram(text) {
  if (!config.telegramBotToken || !config.telegramChatId) {
    return Promise.resolve(false);
  }
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: config.telegramChatId, text: text.slice(0, 4000) });
    const request = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${config.telegramBotToken}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (response) => {
        let raw = '';
        response.on('data', (chunk) => {
          raw += chunk;
        });
        response.on('end', () => {
          if (response.statusCode && response.statusCode >= 400) {
            return reject(new Error(`Telegram error ${response.statusCode}: ${raw}`));
          }
          return resolve(true);
        });
      },
    );
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

function sendIMessage(text) {
  if (!config.enableIMessage || !config.imessageTo) {
    return;
  }
  const child = spawn('/opt/homebrew/bin/imsg', ['send', '--to', config.imessageTo, '--text', text], {
    env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/bin:/bin' },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

async function runActions(actions) {
  for (const action of actions) {
    try {
      if (action.type === 'telegram' || action.type === 'julia') {
        const defaultMessage = action.type === 'julia' ? 'Forwarded action from voice call.' : 'Action requested in voice call.';
        await sendTelegram(action.message || defaultMessage);
        continue;
      }
      if (action.type === 'imessage') {
        sendIMessage(action.message || 'Action requested in voice call.');
        continue;
      }
      if (action.type === 'joke') {
        const jokePrompt = 'Tell exactly one short witty joke. No preamble.';
        const joke = await completeModel('You are a sharp comedian.', [{ role: 'user', content: jokePrompt }]);
        if (action.channel === 'imessage') {
          sendIMessage(joke);
        } else {
          await sendTelegram(joke);
        }
        continue;
      }
      if (action.message) {
        await sendTelegram(action.message);
      }
    } catch (error) {
      console.error(`[Action] Failed type=${action.type}: ${error.message}`);
    }
  }
}

function buildOpenAIChunk(streamId, content) {
  return {
    id: streamId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: config.llmModel,
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: null }],
  };
}

function getDateStamp() {
  return new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
}

function appendConversationMemory(summary, transcript, callId) {
  const fileName = `${getDateStamp()}.md`;
  const memoryFile = path.join(config.memoryDir, fileName);
  const lines = transcript
    .map((entry) => `- **${entry.role === 'julia' ? config.assistantName : 'User'}**: ${entry.text}`)
    .join('\n');
  const callLabel = callId ? ` (${callId})` : '';
  const section = `\n\n### Voice Call${callLabel} — ${new Date().toLocaleString('en-US', {
    timeZone: config.timezone,
  })}\n${lines}\n\n### Summary\n${summary}\n`;
  try {
    fs.mkdirSync(config.memoryDir, { recursive: true });
    fs.appendFileSync(memoryFile, section, 'utf8');
    return { ok: true, file: memoryFile };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function normalizeTranscript(transcript) {
  if (!Array.isArray(transcript)) {
    return [];
  }
  return transcript
    .map((entry) => {
      const role = entry.role === 'julia' || entry.role === 'assistant' ? 'julia' : 'you';
      const text = toSingleString(entry.text || entry.content || entry.message || '').trim();
      if (!text) {
        return null;
      }
      return { role, text: stripInternalTags(text).slice(0, 1200) };
    })
    .filter(Boolean);
}

async function summarizeTranscript(transcript) {
  const transcriptText = transcript.map((entry) => `${entry.role === 'julia' ? config.assistantName : 'You'}: ${entry.text}`).join('\n');
  const summaryPrompt = `Create a concise but complete call summary for memory capture and follow-up.

Required format:
1) One short paragraph on the core discussion.
2) Bullet list of commitments or action items.
3) Bullet list of any new preferences or personal context.

If there are no commitments, write "- None." under action items.

Transcript:
${transcriptText}`;

  const fallback = `Voice call finished with ${transcript.length} transcript lines.`;

  try {
    const summary = await completeModel(
      'You produce concise, practical call summaries. No markdown headings.',
      [{ role: 'user', content: summaryPrompt }],
    );
    return summary || fallback;
  } catch (error) {
    console.error(`[Summary] LLM summary failed: ${error.message}`);
    return fallback;
  }
}

async function finalizeConversation(req, res) {
  const callId = (req.body?.callId || req.headers['x-call-id'] || '').toString().trim();
  const transcript = normalizeTranscript(req.body?.transcript || []);

  if (transcript.length < 2) {
    return res.status(400).json({ error: 'Transcript must contain at least 2 messages.' });
  }

  const summary = await summarizeTranscript(transcript);

  let telegramSent = false;
  let telegramError = null;
  try {
    telegramSent = await sendTelegram(`📞 Voice call summary${callId ? ` (${callId})` : ''}\n\n${summary}`);
  } catch (error) {
    telegramError = error.message;
  }

  const memoryWrite = appendConversationMemory(summary, transcript, callId);

  return res.json({
    status: 'ok',
    callId: callId || null,
    summary,
    telegram: { sent: telegramSent, error: telegramError },
    memory: memoryWrite,
  });
}

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    provider: config.llmProvider,
    model: config.llmModel,
    brainDir: config.brainDir,
    memoryDir: config.memoryDir,
    timestamp: new Date().toISOString(),
  });
});

app.get('/signed-url', async (req, res) => {
  try {
    if (!config.elevenLabsApiKey) {
      return res.status(500).json({ error: 'ELEVENLABS_API_KEY is not configured.' });
    }
    const agentId = (req.query.agent_id || config.defaultAgentId || '').toString().trim();
    if (!agentId) {
      return res.status(400).json({ error: 'Missing agent_id.' });
    }

    const endpoint = `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${encodeURIComponent(agentId)}`;
    const response = await fetch(endpoint, {
      headers: { 'xi-api-key': config.elevenLabsApiKey },
    });
    if (!response.ok) {
      throw new Error(`ElevenLabs returned ${response.status} ${await response.text()}`);
    }
    const body = await response.json();
    return res.json(body);
  } catch (error) {
    console.error(`[signed-url] ${error.message}`);
    return res.status(500).json({ error: error.message });
  }
});

app.post('/v1/chat/completions', async (req, res) => {
  const start = Date.now();
  const stream = req.body?.stream !== false;
  try {
    const messages = normalizeMessages(req.body?.messages || []);
    const systemPrompt = buildSystemPrompt();

    if (!stream) {
      const fullText = await completeModel(systemPrompt, messages);
      const actions = extractActions(fullText);
      const spoken = stripInternalTags(fullText);
      await runActions(actions);
      return res.json({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: config.llmModel,
        choices: [{ index: 0, message: { role: 'assistant', content: spoken }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const streamId = `chatcmpl-${Date.now()}`;
    let fullText = '';
    let actionBuffer = '';
    let inAction = false;

    for await (const chunk of streamModel(systemPrompt, messages)) {
      fullText += chunk;
      for (const char of chunk) {
        if (char === '[' && !inAction) {
          inAction = true;
          actionBuffer = '[';
          continue;
        }
        if (inAction) {
          actionBuffer += char;
          if (char === ']') {
            if (!/^\[ACTION(\s+|:)/i.test(actionBuffer)) {
              res.write(`data: ${JSON.stringify(buildOpenAIChunk(streamId, actionBuffer))}\n\n`);
            }
            actionBuffer = '';
            inAction = false;
          } else if (actionBuffer.length > 600) {
            res.write(`data: ${JSON.stringify(buildOpenAIChunk(streamId, actionBuffer))}\n\n`);
            actionBuffer = '';
            inAction = false;
          }
          continue;
        }
        res.write(`data: ${JSON.stringify(buildOpenAIChunk(streamId, char))}\n\n`);
      }
    }

    if (actionBuffer && !/^\[ACTION(\s+|:)/i.test(actionBuffer)) {
      res.write(`data: ${JSON.stringify(buildOpenAIChunk(streamId, actionBuffer))}\n\n`);
    }

    res.write(
      `data: ${JSON.stringify({
        ...buildOpenAIChunk(streamId, ''),
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`,
    );
    res.write('data: [DONE]\n\n');
    res.end();

    await runActions(extractActions(fullText));
    console.log(`[chat] completed in ${Date.now() - start}ms`);
  } catch (error) {
    console.error(`[chat] ${error.message}`);
    if (!res.headersSent) {
      return res.status(500).json({ error: { message: error.message } });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

app.post('/conversation/finalize', finalizeConversation);
app.post('/save-memory', finalizeConversation);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

if (!isVercelRuntime) {
  app.listen(config.port, () => {
    console.log(`[server] listening on ${config.port}`);
    console.log(`[server] llmProvider=${config.llmProvider} model=${config.llmModel}`);
    console.log(`[server] brainDir=${config.brainDir}`);
  });
}

module.exports = app;
