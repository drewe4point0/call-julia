import { useConversation } from '@elevenlabs/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import './App.css';

type TranscriptMessage = {
  role: 'you' | 'julia';
  text: string;
};

const AGENT_ID = import.meta.env.VITE_ELEVENLABS_AGENT_ID || '';
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

function apiUrl(endpoint: string): string {
  const normalized = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return API_BASE_URL ? `${API_BASE_URL}${normalized}` : normalized;
}

function newCallId(): string {
  if ('randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `call_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function App() {
  const [status, setStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [callId, setCallId] = useState<string | null>(null);
  const [uiError, setUiError] = useState<string>('');

  const callIdRef = useRef<string | null>(null);
  const messagesRef = useRef<TranscriptMessage[]>([]);
  const finalizedRef = useRef<Set<string>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    callIdRef.current = callId;
  }, [callId]);

  useEffect(() => {
    messagesRef.current = messages;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const finalizeConversation = useCallback(async (id: string | null, transcript: TranscriptMessage[]) => {
    if (!id || finalizedRef.current.has(id)) {
      return;
    }
    finalizedRef.current.add(id);

    if (transcript.length < 2) {
      return;
    }

    try {
      const response = await fetch(apiUrl('/conversation/finalize'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callId: id,
          transcript,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Finalize failed with ${response.status}`);
      }
    } catch (error) {
      console.error('[Julia] Failed to finalize conversation:', error);
      setUiError(error instanceof Error ? error.message : 'Could not finalize conversation');
    }
  }, []);

  const conversation = useConversation({
    onConnect: () => {
      setStatus('connected');
      setUiError('');
    },
    onDisconnect: () => {
      setStatus('idle');
      void finalizeConversation(callIdRef.current, messagesRef.current);
      setCallId(null);
    },
    onError: (error: unknown) => {
      console.error('[Julia] Conversation error:', error);
      setStatus('error');
      setUiError(error instanceof Error ? error.message : 'Conversation error');
    },
    onMessage: (message: { source: string; message: string }) => {
      if (!message.message) {
        return;
      }
      const role: 'you' | 'julia' = message.source === 'user' ? 'you' : 'julia';
      setMessages((prev) => [...prev, { role, text: message.message }]);
    },
  });

  const startConversation = useCallback(async () => {
    if (!AGENT_ID) {
      setStatus('error');
      setUiError('VITE_ELEVENLABS_AGENT_ID is not configured.');
      return;
    }

    try {
      const id = newCallId();
      setStatus('connecting');
      setMessages([]);
      setCallId(id);
      setUiError('');

      const signedRes = await fetch(
        `${apiUrl('/signed-url')}?agent_id=${encodeURIComponent(AGENT_ID)}&call_id=${encodeURIComponent(id)}`,
      );
      if (!signedRes.ok) {
        const payload = await signedRes.json().catch(() => ({}));
        throw new Error(payload.error || `Failed to get signed URL (${signedRes.status})`);
      }

      const payload = await signedRes.json();
      const signedUrl = payload.signed_url as string | undefined;
      if (!signedUrl) {
        throw new Error('Signed URL is missing from backend response.');
      }

      await conversation.startSession({ signedUrl });
    } catch (error) {
      console.error('[Julia] Failed to start conversation:', error);
      setStatus('error');
      setUiError(error instanceof Error ? error.message : 'Unable to start call');
    }
  }, [conversation]);

  const endConversation = useCallback(async () => {
    const activeCallId = callIdRef.current;
    try {
      await conversation.endSession();
    } catch (error) {
      console.error('[Julia] Failed to end session cleanly:', error);
    } finally {
      await finalizeConversation(activeCallId, messagesRef.current);
      setStatus('idle');
      setCallId(null);
    }
  }, [conversation, finalizeConversation]);

  const isActive = status === 'connected';
  const statusText =
    status === 'idle'
      ? 'Ready to talk'
      : status === 'connecting'
        ? 'Connecting...'
        : status === 'connected'
          ? conversation.isSpeaking
            ? 'Julia is speaking...'
            : 'Listening...'
          : 'Connection error';

  return (
    <div className="app">
      <div className="bg-orb orb-1" />
      <div className="bg-orb orb-2" />
      <div className="bg-orb orb-3" />
      <div className="bg-grid" />

      <div className="container">
        <div className="header">
          <div className="avatar-ring">
            <div className={`avatar ${isActive ? 'active' : ''}`}>
              <span>J</span>
            </div>
          </div>
          <h1>Julia</h1>
          <p className="subtitle">Voice memory + action assistant</p>
        </div>

        <div className="status-indicator">
          <div className={`dot ${isActive ? 'active' : status === 'connecting' ? 'connecting' : ''}`} />
          <span>{statusText}</span>
        </div>

        <button
          className={`call-button ${isActive ? 'end' : 'start'}`}
          onClick={isActive ? endConversation : startConversation}
          disabled={status === 'connecting' || !AGENT_ID}
        >
          {isActive ? 'End Call' : 'Call Julia'}
        </button>

        {uiError && <p className="error-text">{uiError}</p>}
        {!AGENT_ID && <p className="error-text">Set `VITE_ELEVENLABS_AGENT_ID` to enable calling.</p>}

        <div className="transcript">
          <h3>Transcript</h3>
          <div className="messages">
            {messages.length === 0 ? (
              <div className="empty-transcript">Transcript will appear here during the call...</div>
            ) : (
              messages.map((msg, index) => (
                <div key={`${msg.role}-${index}`} className={`message ${msg.role}`}>
                  <span className="role">{msg.role === 'julia' ? 'Julia' : 'You'}</span>
                  <span className="text">{msg.text}</span>
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
