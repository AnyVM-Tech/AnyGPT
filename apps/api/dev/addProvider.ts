import axios from 'axios';
import * as readline from 'readline';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Import the interfaces matching the RUNTIME state/schema
// Make sure interfaces.ts reflects the removal of model-level score/response_time
import type { Provider, Model, ResponseEntry } from '../providers/interfaces';

// Type Alias for the structure read from/written to providers.json
type ProvidersFile = Provider[];

// Correct way to get the directory path in an ES module:
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the providers.json file
const providersFilePath = path.resolve(__dirname, '../providers.json');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Helper function to prompt user for input
function promptUser(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function addProvider() {
  let providers: ProvidersFile = [];

  // 1. Load existing providers from the file
  try {
      const fileContent = await fs.readFile(providersFilePath, 'utf-8');
      providers = JSON.parse(fileContent);
      if (!Array.isArray(providers)) {
          throw new Error('providers.json does not contain a valid JSON array.');
      }
      console.log(`Loaded ${providers.length} existing providers from ${providersFilePath}`);
  } catch (error: any) {
      if (error.code === 'ENOENT') {
          console.log(`${providersFilePath} not found. Starting with an empty list.`);
          providers = [];
      } else {
          console.error(`Error reading or parsing ${providersFilePath}:`, error.message);
          rl.close();
          return;
      }
  }

  let providerBaseUrl = '';
  let apiKey = '';
  let providerId = '';

  try {
    console.log('--- Add New Provider ---');

    // 2. Get User Input
    providerBaseUrl = await promptUser(
      'Enter the provider base URL (e.g., http://localhost:1234/v1): '
    );
    if (!providerBaseUrl) throw new Error('Provider base URL cannot be empty.');

    apiKey = await promptUser('Enter the API Key for this provider (leave empty if none): ');

    providerId = await promptUser(
      'Enter a unique ID for this provider (e.g., openai-custom-provider): '
    );
    if (!providerId) throw new Error('Provider ID cannot be empty.');

    const modelsUrl = providerBaseUrl.replace(/\/$/, '') + '/models';
    console.log(`\nAttempting to fetch models from: ${modelsUrl}`);

    // 3. Fetch Models from Provider
    let fetchedModels: { id: string }[] = [];
    try {
        const response = await axios.get(modelsUrl, {
            headers: {
                ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
                'Content-Type': 'application/json',
            },
            timeout: 10000,
        });

        if (response.data && Array.isArray(response.data.data)) {
            fetchedModels = response.data.data.filter((m: any) => m && typeof m.id === 'string').map((m: any) => ({ id: m.id }));
            console.log(`Successfully fetched ${fetchedModels.length} models.`);
        } else {
            console.warn(
                `Warning: Could not parse models from response data. Expected format: { data: [{ id: 'model1' }, ...] }. Response received:`,
                JSON.stringify(response.data, null, 2)
            );
            const continueAnyway = await promptUser('Continue without adding specific models? (y/N): ');
            if (!continueAnyway.toLowerCase().startsWith('y')) {
                throw new Error('Aborted due to model fetching issue.');
            }
            fetchedModels = [];
        }
    } catch (error: any) {
        console.error(
            `\nError fetching models from ${modelsUrl}. Status: ${error.response?.status}`
        );
        console.error('Error details:', error.message);
        if (error.response?.data) {
            console.error('Response data:', JSON.stringify(error.response.data, null, 2));
        }
        if (axios.isCancel(error) || error.code === 'ECONNABORTED') {
            console.error('The request to fetch models timed out.');
        }
        const continueAnyway = await promptUser('Continue without adding specific models? (y/N): ');
        if (!continueAnyway.toLowerCase().startsWith('y')) {
            throw new Error('Aborted due to model fetching failure.');
        }
        fetchedModels = [];
    }

    // 4. Construct New Provider Entry according to the schema/interface
    const newModelsObject: { [modelId: string]: Model } = {};
    const DEFAULT_TOKEN_SPEED = 50;

    for (const model of fetchedModels) {
      if (model.id) {
        // Create Model object conforming to the updated Model interface
        newModelsObject[model.id] = {
          id: model.id,
          token_generation_speed: DEFAULT_TOKEN_SPEED,
          response_times: [],      // Required
          errors: 0,               // Required
          consecutive_errors: 0,   // Required by new schema
          // Initialize optional fields to null (or omit if schema doesn't require them)
          avg_response_time: null,
          avg_provider_latency: null,
          avg_token_speed: null
          // provider_score removed from model level
          // response_time removed from model level
        };
      }
    }

    // Construct the final provider URL
    const finalProviderUrl = providerBaseUrl.replace(/\/$/, '') + '/chat/completions';
    console.log(`Provider API endpoint URL set to: ${finalProviderUrl}`);

    const newProviderEntry: Provider = {
      id: providerId,
      apiKey: apiKey || null,
      provider_url: finalProviderUrl,
      models: newModelsObject,
      // Initialize provider-level runtime stats
      disabled: false, // Required by new schema
      avg_response_time: null,
      avg_provider_latency: null,
      errors: 0,
      provider_score: null, // Keep provider_score at provider level
    };

    // 5. Add or Update Provider in the list
    const existingIdx = providers.findIndex((p) => p.id === providerId);
    if (existingIdx >= 0) {
      providers[existingIdx] = newProviderEntry;
      console.log(`\nUpdated existing provider entry with ID: ${providerId}`);
    } else {
      providers.push(newProviderEntry);
      console.log(`\nAdded new provider entry with ID: ${providerId}`);
    }

    // 6. Write Updated Data Back to providers.json
    try {
      const updatedJsonContent = JSON.stringify(providers, null, 2);
      await fs.writeFile(providersFilePath, updatedJsonContent, 'utf-8');
      console.log(`\nSuccessfully saved updated provider list to ${providersFilePath}`);
    } catch (error) {
      console.error(`Error writing updated data to ${providersFilePath}:`, error);
      throw new Error('Failed to write providers.json.');
    }

    console.log('--- Provider Addition Complete ---');

  } catch (error: any) {
    console.error('--- Operation Failed ---');
    console.error('Error:', error.message);
  } finally {
    rl.close();
  }
}

// Run the main function
addProvider();
