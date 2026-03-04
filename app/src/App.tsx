import { useConversation } from '@elevenlabs/react';
import { useCallback, useState, useEffect, useRef } from 'react';
import './App.css';

const AGENT_ID = 'agent_5201khky212aetd8vjfd7rq473hb';

function App() {
  const [status, setStatus] = useState<string>('idle');
  const [messages, setMessages] = useState<Array<{ role: string; text: string }>>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const conversation = useConversation({
    onConnect: () => {
      console.log('[Julia] Connected');
      setStatus('connected');
    },
    onDisconnect: () => {
      console.log('[Julia] Disconnected');
      setStatus('idle');
    },
    onError: (error: unknown) => {
      console.error('[Julia] Conversation error:', error);
      setStatus('error');
    },
    onMessage: (message: { source: string; message: string }) => {
      console.log('[Julia] Message:', message.source, message.message);
      setMessages((prev) => [
        ...prev,
        { role: message.source === 'user' ? 'you' : 'julia', text: message.message },
      ]);
    },
  });

  const startConversation = useCallback(async () => {
    try {
      setStatus('connecting');
      setMessages([]);

      // Get signed URL from our server (proxies to ElevenLabs with API key)
      // This enables proper WebRTC mode with a conversationToken
      const SERVER_URL = 'https://drewes-mac-mini.tail2e734a.ts.net';
      console.log('[Julia] Getting signed URL from server...');
      const signedRes = await fetch(`${SERVER_URL}/signed-url?agent_id=${AGENT_ID}`);
      if (!signedRes.ok) throw new Error('Failed to get signed URL: ' + signedRes.status);
      const { signed_url } = await signedRes.json();
      console.log('[Julia] Got signed URL, starting WebRTC session...');
      await conversation.startSession({ signedUrl: signed_url });
    } catch (error) {
      console.error('[Julia] Failed to start:', error);
      setMessages([{ role: 'julia', text: `⚠️ Could not connect: ${error instanceof Error ? error.message : 'Unknown error'}` }]);
      setStatus('error');
    }
  }, [conversation]);

  const endConversation = useCallback(async () => {
    await conversation.endSession();
    setStatus('idle');
  }, [conversation]);

  const isActive = status === 'connected';

  return (
    <div className="app">
      {/* Decorative background elements */}
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
          <p className="subtitle">Your AI co-pilot</p>
        </div>

        <div className="status-indicator">
          <div className={`dot ${isActive ? 'active' : status === 'connecting' ? 'connecting' : ''}`} />
          <span>
            {status === 'idle' && 'Ready to talk'}
            {status === 'connecting' && 'Connecting...'}
            {status === 'connected' && (conversation.isSpeaking ? 'Julia is speaking...' : 'Listening...')}
            {status === 'error' && 'Connection error — check mic permissions & try again'}
          </span>
        </div>

        <button
          className={`call-button ${isActive ? 'end' : 'start'}`}
          onClick={isActive ? endConversation : startConversation}
          disabled={status === 'connecting'}
        >
          {isActive ? '✕  End Call' : '📞  Call Julia'}
        </button>

        <div className="transcript">
          <h3>Transcript</h3>
          <div className="messages">
            {messages.length === 0 ? (
              <div className="empty-transcript">Transcript will appear here...</div>
            ) : (
              messages.map((msg, i) => (
                <div key={i} className={`message ${msg.role}`}>
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
