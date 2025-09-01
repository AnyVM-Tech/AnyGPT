import dotenv from 'dotenv';
import path from 'path';

// Load test environment variables
const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
dotenv.config({ path: path.resolve(process.cwd(), envFile) });

import WebSocket from 'ws';

const API_KEY = process.env.TEST_API_KEY || 'test-key-for-mock-provider';
const url = process.env.WS_URL || 'ws://localhost:3000/ws';

const ws = new WebSocket(url);

ws.on('open', () => {
  console.log('WS connected');
  ws.send(JSON.stringify({ type: 'auth', apiKey: API_KEY }));
});

ws.on('message', (raw: Buffer | string) => {
  let msg: any;
  try { msg = JSON.parse(raw.toString()); } catch { console.log('Non-JSON message', raw.toString()); return; }
  console.log('<<', msg);
  if (msg.type === 'auth.ok') {
    // Non-streaming request
    ws.send(JSON.stringify({
      type: 'chat.completions',
      requestId: 'req1-nonstream',
      model: 'gpt-3.5-turbo',
      messages: [ { role: 'user', content: 'Hello over WebSocket!' } ]
    }));

    // Streaming request
    ws.send(JSON.stringify({
      type: 'chat.completions',
      requestId: 'req2-stream',
      model: 'gpt-3.5-turbo',
      stream: true,
      messages: [ { role: 'user', content: 'Tell me a very short story over WebSocket stream.' } ]
    }));
  }
});

ws.on('close', () => console.log('WS closed'));
ws.on('error', (e: Error) => console.error('WS error', e));
