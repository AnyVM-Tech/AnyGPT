import { Command } from 'commander';
import * as fs from 'fs';
import axios from 'axios';
import { Provider, Model } from '../providers/interfaces.js';

async function fetchModels(apiKey: string, modelsEndpoint: string): Promise<string[]> {
  try {
    const response = await axios.get(modelsEndpoint, {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });
    
    if (response.data && Array.isArray(response.data.data)) {
      return response.data.data.map((model: any) => model.id);
    }
    return [];
  } catch (error) {
    console.error('Failed to fetch models:', error);
    process.exit(1);
  }
}

async function updateProviders(
  apiKey: string, 
  chatEndpoint: string, 
  modelsEndpoint: string,
  providerId: string
): Promise<void> {
  try {
    const models = await fetchModels(apiKey, modelsEndpoint);
    
    if (!models.length) {
      throw new Error('No models found');
    }

    const provider: Provider = {
      id: providerId,
      apiKey: apiKey,
      provider_url: chatEndpoint,
      models: models.reduce((acc, id) => ({
        ...acc,
        [id]: {
          id: id,
          token_generation_speed: 50,
          response_times: [],
          errors: 0,
          consecutive_errors: 0,
          avg_response_time: null,
          avg_provider_latency: null,
          avg_token_speed: null
        }
      }), {}),
      // Set additional fields to null or 0
      avg_response_time: null,
      avg_provider_latency: null,
      errors: 0,
      provider_score: null,
      disabled: false // Add required disabled field
    };

    const filePath = './providers.json';
    let providers: Provider[] = [];
    
    if (!fs.existsSync(filePath)) {
      providers = [provider];
      console.warn(`File not found: ${filePath}. Creating a new one.`);
    } else {
      try {
        const jsonData = fs.readFileSync(filePath, 'utf-8');
        const modelsData = JSON.parse(jsonData);

        if (!modelsData || !Array.isArray(modelsData)) {
          console.error('Invalid providers.json format. Expected an array of providers.');
          process.exit(1);
        }

        providers = modelsData;
      } catch (error) {
        console.error('Error reading or parsing providers.json:', error);
        process.exit(1);
      }

      // Update or add provider
      const existingIdx = providers.findIndex(p => p.id === provider.id);
      if (existingIdx >= 0) {
        providers[existingIdx] = {
          ...providers[existingIdx],
          apiKey: provider.apiKey,
          provider_url: provider.provider_url,
          models: provider.models,
          avg_response_time: 0, // Reset or set to default
          avg_provider_latency: 0, // Reset or set to default
          errors: 0, // Reset errors
          provider_score: 0 // Initialize or reset score
        };
        console.log(`Updated existing provider with ID: ${provider.id}`);
      } else {
        providers.push(provider);
        console.log(`Added new provider with ID: ${provider.id}`);
      }
    }

    // Write back to providers.json
    try {
      fs.writeFileSync(filePath, JSON.stringify(providers, null, 2), 'utf8');
      console.log(`Successfully updated providers.json with provider ID: ${provider.id}`);
    } catch (writeError) {
      console.error('Error writing to providers.json:', writeError);
      process.exit(1);
    }

  } catch (error) {
    console.error('Failed to update providers.json:', error);
    process.exit(1);
  }
}

// CLI 
const program = new Command();

program
  .name('updateproviders')
  .description('Add or update provider configuration in providers.json')
  .requiredOption('-k, --api-key <key>', 'API key')
  .requiredOption('-c, --chat-endpoint <url>', 'Chat completions endpoint')
  .requiredOption('-m, --models-endpoint <url>', 'Models endpoint')
  .requiredOption('-i, --id <provider-id>', 'Provider ID (name)')
  .action(async (options) => {
    await updateProviders(
      options.apiKey,
      options.chatEndpoint,
      options.modelsEndpoint,
      options.id
    );
  });

program.parse();