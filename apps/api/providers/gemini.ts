import dotenv from 'dotenv';
import {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
  GenerativeModel
} from '@google/generative-ai';
import { IAIProvider, IMessage, ContentPart } from './interfaces.js'; // Only import necessary interfaces
// Removed imports related to compute and Provider state

dotenv.config();

// Static configuration remains
const generationConfig = {
  temperature: 1,
  topP: 0.95,
  topK: 64,
  maxOutputTokens: 8192,
  responseMimeType: 'text/plain'
};

const safetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE }
];

export class GeminiAI implements IAIProvider {
  private modelInstance: GenerativeModel;
  private apiKey: string;
  private modelId: string;
  // Removed state properties: busy, lastLatency, providerData, alpha, providerId

  constructor(apiKey: string, modelId: string = 'gemini-pro') { // Accept modelId in constructor
    if (!apiKey) {
      throw new Error('Gemini API key is required');
    }
    this.apiKey = apiKey;
    this.modelId = modelId; // Store the model ID this instance will handle

    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      this.modelInstance = genAI.getGenerativeModel({
        model: modelId, // Use the specific model ID
        // Note: Apply generationConfig and safetySettings during the chat session
      });
    } catch (error: any) {
        console.error(`Failed to initialize GoogleGenerativeAI for model ${modelId}:`, error);
        throw new Error(`Failed to initialize GoogleGenerativeAI: ${error.message}`);
    }
    // Removed providerData initialization and initializeModelData call
  }

  private toGeminiContent(content: string | ContentPart[]) {
    if (typeof content === 'string') return content;
    return content.map((part) => {
      if (part.type === 'text') return { text: part.text };
      if (part.type === 'image_url') {
        // If the client sent a data URL, send inlineData; otherwise use fileData URI.
        const url = part.image_url.url;
        if (url.startsWith('data:')) {
          const match = url.match(/^data:([^;]+);base64,(.+)$/);
          const mimeType = match?.[1] || 'image/jpeg';
          const data = match?.[2] || '';
          return { inlineData: { data, mimeType } };
        }
        return { fileData: { fileUri: url, mimeType: 'image/jpeg' } };
      }
      if (part.type === 'input_audio') {
        const mimeType = part.input_audio.format.startsWith('audio/')
          ? part.input_audio.format
          : `audio/${part.input_audio.format}`;
        return { inlineData: { data: part.input_audio.data, mimeType } };
      }
      return { text: '' };
    });
  }

  // Removed isBusy, getLatency, getProviderData, initializeModelData methods

  /**
   * Sends a message to the Google Generative AI API.
   * This method is now stateless and only focuses on the API interaction.
   * @param message - The message to send, including the model details.
   * @returns A promise containing the API response content and latency.
   */
  async sendMessage(message: IMessage): Promise<{ response: string; latency: number }> {
    // Model ID check: Ensure the message is intended for the model this instance handles.
    // This relies on the MessageHandler routing correctly.
    if (message.model.id !== this.modelId) {
       console.warn(`GeminiAI instance for ${this.modelId} received message intended for ${message.model.id}. Processing anyway.`);
       // Or optionally throw: throw new Error(`Mismatched model ID: Expected ${this.modelId}, got ${message.model.id}`);
    }

    // Removed busy flag management
    const startTime = Date.now();

    try {
      // Start a new chat session for each request to apply config
      const chatSession = this.modelInstance.startChat({
        generationConfig,
        safetySettings,
        history: [], // Assuming simple, stateless requests
      });

        // Send the message content
        const result = await chatSession.sendMessage(this.toGeminiContent(message.content));

        // Try to extract inlineData image first, otherwise fall back to text
        let responseText = '';
        const parts = result?.response?.candidates?.[0]?.content?.parts || [];
        const inlineImage = Array.isArray(parts) ? parts.find((p: any) => p?.inlineData?.data) : null;
        if (inlineImage?.inlineData?.data) {
          const mime = inlineImage.inlineData.mimeType || 'image/png';
          responseText = `data:${mime};base64,${inlineImage.inlineData.data}`;
        } else if (typeof result?.response?.text === 'function') {
          responseText = await result.response.text();
        } else {
          throw new Error('Invalid response structure received from Gemini API');
        }

      const endTime = Date.now();
      const latency = endTime - startTime;
      // Removed lastLatency update

      // Removed all internal state updates (token calculation, updateProviderData, compute calls)

      // Return only the response and latency
      return {
        response: responseText,
        latency: latency,
      };

    } catch (error: any) {
      // Removed busy flag management
      // Removed internal state updates on error

      const endTime = Date.now();
      const latency = endTime - startTime;
      console.error(`Error during sendMessage with Gemini model ${this.modelId} (Latency: ${latency}ms):`, error);

      // Extract a more specific error message if possible
      const errorMessage = error.message || 'Unknown Gemini API error';
      // Rethrow the error to be handled by the MessageHandler
      throw new Error(`Gemini API call failed: ${errorMessage}`);
    }
  }

  async *sendMessageStream(message: IMessage): AsyncGenerator<{ chunk: string; latency: number; response: string; anystream: any; }, void, unknown> {
    if (message.model.id !== this.modelId) {
      console.warn(`GeminiAI instance for ${this.modelId} received message intended for ${message.model.id}. Processing anyway.`);
    }

    const startTime = Date.now();

    try {
      const chatSession = this.modelInstance.startChat({
        generationConfig,
        safetySettings,
        history: [],
      });

      const result = await chatSession.sendMessageStream(this.toGeminiContent(message.content));
      let fullResponse = '';
      for await (const chunk of result.stream) {
        const chunkText = chunk.text();
        fullResponse += chunkText;
        const latency = Date.now() - startTime;
        yield { chunk: chunkText, latency, response: fullResponse, anystream: result.stream };
      }
    } catch (error: any) {
      const latency = Date.now() - startTime;
      console.error(`Error during sendMessageStream with Gemini model ${this.modelId} (Latency: ${latency}ms):`, error);
      const errorMessage = error.message || 'Unknown Gemini API error';
      throw new Error(`Gemini API stream call failed: ${errorMessage}`);
    }
  }
}
