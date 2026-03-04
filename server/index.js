const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  if (!req.path.includes('swagger') && !req.path.includes('php') && !req.path.includes('.json') && req.path !== '/') {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const WORKSPACE = '/Users/macminihome/.openclaw/workspace';
const TELEGRAM_BOT_TOKEN = '8385013965:AAEPCGE-45bbTWwomL67JQwllKlkWh-HcHs';
const TELEGRAM_CHAT_ID = '7125055530';

// Claude Max proxy on localhost:3456 — routes through Claude CLI subscription
const CLAUDE_PROXY = 'http://localhost:3456';

// ElevenLabs API key for signed URL generation
const ELEVENLABS_API_KEY = (() => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.openclaw/openclaw.json'), 'utf8'));
    return cfg.skills?.entries?.sag?.apiKey || '';
  } catch { return ''; }
})();

app.get('/signed-url', async (req, res) => {
  try {
    const agentId = req.query.agent_id || 'agent_5201khky212aetd8vjfd7rq473hb';
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`,
      { headers: { 'xi-api-key': ELEVENLABS_API_KEY } }
    );
    if (!response.ok) throw new Error(`ElevenLabs returned ${response.status}`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('[Julia] Signed URL error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Helper: call Claude via the Max proxy (OpenAI-compatible API)
async function callClaude(systemPrompt, messages, { stream = false, maxTokens = 400 } = {}) {
  const body = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages
    ],
    stream
  };

  const response = await fetch(`${CLAUDE_PROXY}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`${response.status} ${errText}`);
  }

  if (stream) {
    return response; // Return the raw response for streaming
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

function loadContext() {
  const files = ['SOUL.md', 'USER.md', 'MEMORY.md', 'TOOLS.md'];
  let context = '';
  for (const f of files) {
    try { context += `\n\n=== ${f} ===\n` + fs.readFileSync(path.join(WORKSPACE, f), 'utf8'); } catch (e) {}
  }
  const now = new Date();
  for (const offset of [0, 1]) {
    const d = new Date(now - offset * 86400000).toISOString().split('T')[0];
    try { context += `\n\n=== memory/${d}.md ===\n` + fs.readFileSync(path.join(WORKSPACE, `memory/${d}.md`), 'utf8'); } catch (e) {}
  }
  return context;
}

function sendTelegram(text) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { console.log(`  Telegram sent (${res.statusCode})`); resolve(body); });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function sendIMessage(to, message) {
  const { spawn } = require('child_process');
  const child = spawn('/opt/homebrew/bin/imsg', ['send', '--to', to, '--text', message], {
    env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/bin:/bin' },
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  setTimeout(() => { try { child.kill(); } catch(e) {} }, 10000);
  console.log(`  iMessage spawned to ${to}`);
}

let currentConversation = [];
let executedActions = [];

async function processActions(fullText) {
  const structuredMatch = fullText.match(/\[ACTION\s+([^\]]+)\]/i);
  if (!structuredMatch) {
    const oldMatch = fullText.match(/\[ACTION:\s*([\s\S]*?)\]/i);
    if (oldMatch) return processOldAction(oldMatch[1].trim());
    return;
  }
  
  const attrs = structuredMatch[1];
  const type = (attrs.match(/type="([^"]+)"/i) || [])[1] || '';
  const message = (attrs.match(/message="([^"]+)"/i) || [])[1] || '';
  const channel = (attrs.match(/channel="([^"]+)"/i) || [])[1] || 'telegram';
  
  console.log(`  Action: type=${type}, channel=${channel}, message="${message.substring(0, 50)}"`);
  executedActions.push({ type, channel, message: message.substring(0, 200), time: new Date().toISOString() });
  
  try {
    if (type === 'joke') {
      const joke = await callClaude(
        'Generate ONE clever, raunchy/witty joke. Short, punchy. Surprise on the LAST word. No preamble, just the joke.',
        [{ role: 'user', content: 'Give me a joke' }],
        { maxTokens: 150 }
      );
      if (channel === 'imessage') sendIMessage('+17789957801', joke);
      else await sendTelegram(joke);
      console.log(`  Joke sent via ${channel}`);
    }
    else if (type === 'telegram') {
      await sendTelegram(message || 'Hey Drewe! 👋');
    }
    else if (type === 'imessage') {
      sendIMessage('+17789957801', message || 'Hey Drewe! 👋');
    }
    else if (type === 'julia') {
      const forwardMsg = `🎙️ Voice Julia → Main Julia:\n\n${message}\n\n⚡ This is an ACTION REQUEST from a voice call. Do this NOW — don't just acknowledge it. Take the action, then confirm to Drewe on Telegram when done.`;
      await sendTelegram(forwardMsg);
      console.log(`  Forwarded to main Julia: "${message.substring(0, 60)}"`);
    }
    else {
      const forwardMsg = `🎙️ **Voice Julia → Main Julia:**\n${message || 'Voice request with no message'}`;
      await sendTelegram(forwardMsg);
    }
  } catch (err) {
    console.error(`  Action failed: ${err.message}`);
  }
}

async function processOldAction(desc) {
  const lower = desc.toLowerCase();
  if (lower.includes('joke')) {
    const joke = await callClaude(
      'Generate ONE clever, raunchy/witty joke. Short, punchy. Surprise on the LAST word. No preamble, just the joke.',
      [{ role: 'user', content: 'Give me a joke' }],
      { maxTokens: 150 }
    );
    if (lower.includes('imessage')) sendIMessage('+17789957801', joke);
    else await sendTelegram(joke);
  } else {
    if (lower.includes('imessage') || lower.includes('text') || lower.includes('sms')) {
      sendIMessage('+17789957801', 'Hey Drewe! 👋');
    } else {
      await sendTelegram('Hey Drewe! 👋');
    }
  }
}

function buildSystemPrompt() {
  return `You are Julia — Drewe's AI co-pilot, project manager, accountability partner, and friend. You are having a LIVE VOICE CONVERSATION.

CRITICAL VOICE RULES:
- NEVER output XML tags, thinking tags, or any markup
- Keep responses SHORT (2-4 sentences unless more detail is asked for)
- No markdown, no bullet points, no formatting — just natural speech
- Be direct, warm, funny, occasionally weird
- Push Drewe toward his goals

ACTIONS — HOW TO GET THINGS DONE:
You have action tags that trigger the backend. Drewe will NEVER hear them — they are stripped from speech.
Put ONE action tag per response, on its own line at the very end.

Available action types:
1. type="telegram" — send a Telegram message
2. type="imessage" — send an iMessage/text
3. type="joke" — generate and send ONE joke (channel="telegram" or "imessage")
4. type="julia" — FORWARD REQUEST TO MAIN JULIA. Use this for ANYTHING you can't do yourself: research, file changes, reminders, calendar, web search, behavior changes, memory updates, project work, habit tracking, etc.

Format: [ACTION type="TYPE" channel="CHANNEL" message="CONTENT"]

Examples:
- "send hello on Telegram" → [ACTION type="telegram" message="Hey Drewe! 👋"]
- "text me via iMessage" → [ACTION type="imessage" message="Hey! 👋"]  
- "send me a joke" → [ACTION type="joke" channel="telegram"]
- "set a reminder for 3pm" → [ACTION type="julia" message="Set a reminder for Drewe at 3pm today"]
- "remember that I prefer morning workouts" → [ACTION type="julia" message="Update memory: Drewe prefers morning workouts"]

CRITICAL RULES:
- Only ONE action tag per response. Never two.
- For jokes: generate ONE joke only. Never send multiple.
- When Drewe asks you to do something you can't handle directly, ALWAYS use type="julia" to forward it.
- Be honest about your limitations — say "I'll have main Julia handle that" rather than pretending.

Current date/time: ${new Date().toLocaleString('en-US', { timeZone: 'America/Vancouver' })}

${loadContext()}`;
}

async function saveConversationToMemory() {
  if (currentConversation.length < 2) return;
  
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
  const timeStr = now.toLocaleTimeString('en-US', { timeZone: 'America/Vancouver', hour: '2-digit', minute: '2-digit' });
  const memFile = path.join(WORKSPACE, `memory/${dateStr}.md`);
  
  const lines = currentConversation.map(m => `- **${m.role === 'user' ? 'Drewe' : 'Julia'}**: ${m.content.substring(0, 200)}`).join('\n');
  const actionLines = executedActions.length > 0
    ? '\n**Actions already completed during call:**\n' + executedActions.map(a => `- ✅ ${a.type}: ${a.message || a.channel}`).join('\n')
    : '';
  const entry = `\n\n### Voice Call (${timeStr})\n${lines}${actionLines}\n`;
  
  try {
    let existing = '';
    try { existing = fs.readFileSync(memFile, 'utf8'); } catch(e) {}
    fs.writeFileSync(memFile, existing + entry);
    console.log(`  Voice conversation saved to ${memFile}`);
  } catch(e) {
    console.error(`  Failed to save voice conversation: ${e.message}`);
  }
  
  // Generate summary via Claude Max proxy
  try {
    const transcript = currentConversation.map(m => `${m.role === 'user' ? 'Drewe' : 'Julia'}: ${m.content}`).join('\n');
    const actionsAlreadyDone = executedActions.length > 0
      ? '\n\nACTIONS ALREADY EXECUTED DURING THIS CALL (DO NOT repeat these):\n' + executedActions.map(a => `- ${a.type}: ${a.message || a.channel}`).join('\n')
      : '\n\nNo actions were executed during this call.';
    
    const summary = await callClaude(
      `You are summarizing a voice call between Drewe and Julia. Produce a brief that Main Julia can act on.

FORMAT:
📞 **Voice Call Summary** (TIME)

**Key topics:** (1-3 bullet points)
**Drewe's mood/state:** (one line)
**New info/preferences:** (if any were mentioned)
**Action items for Main Julia:** (ONLY items NOT already handled — see list below)

If all action items were already handled during the call, say "None — all handled during call."
Be concise. This goes straight to Main Julia's Telegram.`,
      [{ role: 'user', content: `Transcript:\n${transcript}${actionsAlreadyDone}\n\nTime: ${timeStr}` }],
      { maxTokens: 400 }
    );
    
    await sendTelegram(summary);
    console.log(`  Smart summary sent to Main Julia`);
  } catch(e) {
    console.error(`  Failed to generate/send summary: ${e.message}`);
    try {
      await sendTelegram(`📞 Voice call ended (${timeStr}). ${currentConversation.length} exchanges. ${executedActions.length} actions taken.`);
    } catch(e2) {}
  }
  
  currentConversation = [];
  executedActions = [];
}

let lastMessageTime = 0;
setInterval(() => {
  if (currentConversation.length >= 2 && lastMessageTime > 0 && (Date.now() - lastMessageTime) > 120000) {
    console.log(`  Auto-save: ${Math.round((Date.now() - lastMessageTime)/1000)}s since last message`);
    lastMessageTime = 0;
    saveConversationToMemory();
  }
}, 15000);

function resetConversationTimer() {
  lastMessageTime = Date.now();
}

app.post('/v1/chat/completions', async (req, res) => {
  const startTime = Date.now();
  try {
    const { messages, stream = true } = req.body;
    
    console.log(`[${new Date().toISOString()}] Chat: ${messages?.length || 0} msgs, stream=${stream}`);
    
    const lastUserMsg = messages?.filter(m => m.role === 'user').pop();
    if (lastUserMsg) {
      currentConversation.push({
        role: 'user',
        content: typeof lastUserMsg.content === 'string' ? lastUserMsg.content : JSON.stringify(lastUserMsg.content),
        time: new Date().toISOString()
      });
    }
    resetConversationTimer();
    
    const systemMsg = buildSystemPrompt();
    const convMessages = [];
    
    for (const msg of (messages || [])) {
      if (msg.role === 'system') continue;
      convMessages.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      });
    }
    
    if (convMessages.length === 0 || convMessages[0].role !== 'user') {
      convMessages.unshift({ role: 'user', content: 'Hey Julia' });
    }
    
    // Ensure alternating roles
    const cleanMessages = [];
    for (const msg of convMessages) {
      if (cleanMessages.length > 0 && cleanMessages[cleanMessages.length - 1].role === msg.role) {
        cleanMessages[cleanMessages.length - 1].content += '\n' + msg.content;
      } else {
        cleanMessages.push(msg);
      }
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      
      const streamId = `chatcmpl-${Date.now()}`;
      let fullText = '';
      let actionBuffer = '';
      let inAction = false;

      // Stream from Claude Max proxy
      const proxyBody = {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 400,
        messages: [{ role: 'system', content: systemMsg }, ...cleanMessages],
        stream: true
      };

      const proxyRes = await fetch(`${CLAUDE_PROXY}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(proxyBody)
      });

      if (!proxyRes.ok) {
        const errText = await proxyRes.text();
        throw new Error(`Proxy error: ${proxyRes.status} ${errText}`);
      }
      
      function sendChunk(text) {
        if (!text) return;
        res.write(`data: ${JSON.stringify({
          id: streamId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'claude-sonnet-4-20250514',
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
        })}\n\n`);
      }

      // Parse SSE from proxy
      const reader = proxyRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          
          try {
            const parsed = JSON.parse(data);
            const text = parsed.choices?.[0]?.delta?.content;
            if (!text) continue;
            
            fullText += text;
            
            // Strip thinking tags
            if (text.includes('<thinking>') || text.includes('</thinking>')) continue;
            
            // Handle ACTION tags — buffer so they're never spoken
            for (const char of text) {
              if (char === '[' && !inAction) {
                inAction = true;
                actionBuffer = '[';
              } else if (inAction) {
                actionBuffer += char;
                if (char === ']') {
                  if (actionBuffer.match(/\[ACTION[: ]/i)) {
                    inAction = false;
                    actionBuffer = '';
                  } else {
                    sendChunk(actionBuffer);
                    inAction = false;
                    actionBuffer = '';
                  }
                }
                if (actionBuffer.length > 500) {
                  sendChunk(actionBuffer);
                  inAction = false;
                  actionBuffer = '';
                }
              } else {
                sendChunk(char);
              }
            }
          } catch (e) {}
        }
      }
      
      if (actionBuffer && !actionBuffer.match(/\[ACTION[: ]/i)) {
        sendChunk(actionBuffer);
      }
      
      res.write(`data: ${JSON.stringify({
        id: streamId, object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000), model: 'claude-sonnet-4-20250514',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      
      console.log(`  Done (${Date.now() - startTime}ms)`);
      
      const spokenStream = fullText.replace(/\[ACTION[:\s][^\]]*\]/gi, '').trim();
      if (spokenStream) currentConversation.push({ role: 'assistant', content: spokenStream, time: new Date().toISOString() });
      
      await processActions(fullText);
      
    } else {
      const text = await callClaude(systemMsg, cleanMessages, { maxTokens: 400 });
      await processActions(text);
      const spokenText = text.replace(/\[ACTION[:\s][^\]]*\]/gi, '').trim();
      
      if (spokenText) currentConversation.push({ role: 'assistant', content: spokenText, time: new Date().toISOString() });
      
      res.json({
        id: `chatcmpl-${Date.now()}`, object: 'chat.completion',
        created: Math.floor(Date.now() / 1000), model: 'claude-sonnet-4-20250514',
        choices: [{ index: 0, message: { role: 'assistant', content: spokenText }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      });
    }
  } catch (error) {
    console.error(`ERROR:`, error.message);
    if (!res.headersSent) res.status(500).json({ error: { message: error.message } });
    else { res.write('data: [DONE]\n\n'); res.end(); }
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString(), conversationLength: currentConversation.length, actionsCount: executedActions.length }));
app.post('/save-memory', async (req, res) => {
  console.log(`  Manual save triggered. Conversation: ${currentConversation.length} msgs, Actions: ${executedActions.length}`);
  await saveConversationToMemory();
  res.json({ status: 'saved' });
});
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(3789, () => {
  console.log('[Julia] Voice LLM Server on port 3789');
  console.log('[Julia] Routing through Claude Max proxy at localhost:3456');
  console.log('[Julia] Tailscale: https://drewes-mac-mini.tail2e734a.ts.net');
});
