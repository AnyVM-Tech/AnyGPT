import axios from 'axios';
import { IAIProvider, IMessage } from './interfaces.js'; // Only import necessary interfaces
// Removed imports related to compute and Provider state

export class OpenAI implements IAIProvider {
  private apiKey: string;
  private endpointUrl: string;
  // Removed state properties: busy, lastLatency, providerData, alpha

  /**
   * Constructor for the OpenAI provider.
   * @param apiKey - The API key to use. If it starts with 'sk-', it's considered an OpenAI key.
   * @param endpointUrl - Optional custom endpoint URL. If provided, it replaces the default endpoint.
   */
  constructor(apiKey: string, endpointUrl?: string) {
    // Validate inputs
    if (!apiKey && !endpointUrl) {
      throw new Error('Either an OpenAI API key or an endpoint URL must be provided');
    }

    if (apiKey && apiKey.startsWith('sk-')) {
      this.apiKey = apiKey;
      this.endpointUrl = endpointUrl || 'https://api.openai.com/v1/chat/completions';
    } else {
      this.apiKey = apiKey || '';
      if (endpointUrl) {
        this.endpointUrl = endpointUrl;
      } else {
        throw new Error('Endpoint URL must be provided if API key is not an OpenAI API key');
      }
    }
    // Removed providerData initialization
  }

  // Removed getLatency and getProviderData methods

  /**
   * Sends a message to the OpenAI API.
   * This method is now stateless and only focuses on the API interaction.
   * @param message - The message to send, including the model details.
   * @returns A promise containing the API response content and latency.
   */
  async sendMessage(message: IMessage): Promise<{ response: string; latency: number }> {
    // Removed busy flag management
    const startTime = Date.now();
    const url = this.endpointUrl;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const data = {
      model: message.model.id,
      // Assuming the handler formats messages correctly if needed by the specific API
      messages: [{ role: 'user', content: message.content }],
    };

    try {
      const response = await axios.post(url, data, { headers });
      const endTime = Date.now();
      const latency = endTime - startTime;
      // Removed lastLatency update

      if (response.data?.choices?.[0]?.message?.content) {
        const responseText = response.data.choices[0].message.content;

        // Removed all internal state updates (token calculation, updateProviderData, compute calls)

        // Return only the response and latency
        return {
          response: responseText,
          latency: latency,
        };
      } else {
        // Handle cases where the response structure is unexpected
        console.error('Unexpected response structure from API:', response.data);
        throw new Error('Unexpected response structure from the API');
      }
    } catch (error: any) {
      // Removed busy flag management
      // Removed internal state updates on error

      const endTime = Date.now(); // Still useful to know when the error occurred
      const latency = endTime - startTime;
      console.error(`Error during sendMessage to ${url} (Latency: ${latency}ms):`, error);

      // Extract a more specific error message if possible
      const errorMessage = error.response?.data?.error?.message || error.message || 'Unknown API error';
      // Rethrow the error to be handled by the MessageHandler
      throw new Error(`API call failed: ${errorMessage}`);
    }
  }

  async *sendMessageStream(message: IMessage): AsyncGenerator<{ chunk: string; latency: number; response: string; anystream: any; }, void, unknown> {
    const startTime = Date.now();
    const url = this.endpointUrl;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const data = {
      model: message.model.id,
      messages: [{ role: 'user', content: message.content }],
      stream: true,
    };

    try {
      const response = await axios.post(url, data, { headers, responseType: 'stream' });
      let fullResponse = '';
      for await (const value of response.data) {
        const lines = value.toString('utf8').split('\n').filter((line: string) => line.trim().startsWith('data: '));
        for (const line of lines) {
          const message = line.replace(/^data: /, '');
          if (message === '[DONE]') {
            const latency = Date.now() - startTime;
            yield { chunk: '', latency, response: fullResponse, anystream: response.data };
            return;
          }
          try {
            const parsed = JSON.parse(message);
            const chunk = parsed.choices[0]?.delta?.content || '';
            fullResponse += chunk;
            const latency = Date.now() - startTime;
            yield { chunk, latency, response: fullResponse, anystream: response.data };
          } catch (error) {
            console.error('Error parsing stream chunk:', error);
          }
        }
      }
    } catch (error: any) {
      const latency = Date.now() - startTime;
      console.error(`Error during sendMessageStream to ${url} (Latency: ${latency}ms):`, error);
      const errorMessage = error.response?.data?.error?.message || error.message || 'Unknown API error';
      throw new Error(`API stream call failed: ${errorMessage}`);
    }
  }
}
