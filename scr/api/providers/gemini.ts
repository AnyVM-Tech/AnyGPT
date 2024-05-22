import dotenv from 'dotenv';
import express from 'express';

import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";

dotenv.config();
const apiKey = process.env.GEMINI_API_KEY || "";

const app = express();
const port = 3001;

app.use(express.json());

const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({
    model: "gemini-1.0-pro",
});

const generationConfig = {
  temperature: 1,
  topP: 0.95,
  topK: 64,
  maxOutputTokens: 8192,
  responseMimeType: "text/plain",
};

const safetySettings = [
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
];

app.post('/gemini', async (req, res) => {
  try {
      const chatSession = model.startChat({
          generationConfig,
          safetySettings,
          history: [],
      });
      const result = await chatSession.sendMessage(req.body.message);
      console.log('Result:', result);
      res.send(result.response.text());
  } catch (error) {
      console.error('Error in Gemini API call:', error);
      res.status(500).send('Error in Gemini API call');
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});