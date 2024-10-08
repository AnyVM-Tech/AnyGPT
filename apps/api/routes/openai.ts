import { Server } from 'hyper-express';
import dotenv from 'dotenv';
import { MessageHandler } from 'providers/handler';
import { resourceLimits } from 'worker_threads';
dotenv.config();
async function extractMessageFromRequest(request: any): Promise<{ messages: { role: string; content: string }[]; model: string }> {
  const requestBody = await request.json();
  return { messages: requestBody.messages, model: requestBody.model || 'defaultModel' };
}

const server = new Server();

server.post('/openai', async (request, response) => {
  try {
    const { messages, model } = await extractMessageFromRequest(request);

console.log(messages, model)
    const result = await MessageHandler.handleMessages(messages, model);
    console.log('Received messages:', messages);
    console.log("response",(JSON.parse(JSON.stringify(result))));
    response.json(JSON.parse(JSON.stringify(result)));
  } catch (error) {
    console.error('Error receiving messages:', error);
    response.status(500).json({ error: "Internal Server Error" });
  }
  
});

server.get('/models', (request, response) => {
  const modelsFilePath = './models.json';
  response.sendFile(modelsFilePath);
});


const port = parseInt(process.env.PORT || '3000', 10);
server.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});