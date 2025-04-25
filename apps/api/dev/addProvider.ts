import axios from 'axios';
import * as readline from 'readline';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Import the JSON data directly. TypeScript infers the type.
// Note: This imports the state of the file at the start of the script run.
import providersData from '../providers.json' assert { type: 'json' };

// Define the structure for a model entry (match providers.json structure)
interface ModelInfo {
  response_time: number | null;
  response_times: number[];
  // Add other potential stats if needed
}

// Define the structure for a provider entry (match providers.json structure)
interface ProviderEntry {
  id: string;
  apiKey: string;
  provider_url: string;
  models: { [modelId: string]: ModelInfo };
  avg_response_time?: number;
  avg_provider_latency?: number;
  errors?: number;
  provider_score?: number;
}

// Define the expected type for the imported JSON data
type ProvidersFile = ProviderEntry[];

// Correct way to get the directory path in an ES module:
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The actual path is still needed for writing the file back
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
  // Use a deep copy of the imported data to avoid modifying the original import cache
  // and to ensure we have a mutable array based on the file's initial state.
  let providers: ProvidersFile = JSON.parse(JSON.stringify(providersData));

  // Validate the structure after import (optional but good practice)
  if (!Array.isArray(providers)) {
      console.error(`Error: Imported ${providersFilePath} is not a valid JSON array.`);
      rl.close();
      return; // Stop execution
  }
   console.log(`Imported ${providers.length} existing providers from ${providersFilePath}`);

  let providerBaseUrl = '';
  let apiKey = '';
  let providerId = '';

  try {
    console.log('\n--- Add New Provider ---'); // Corrected console.log

    // 1. Get User Input
    providerBaseUrl = await promptUser(
      'Enter the provider base URL (e.g., http://localhost:1234/v1): '
    );
    if (!providerBaseUrl) throw new Error('Provider base URL cannot be empty.');

    apiKey = await promptUser('Enter the API Key for this provider: ');

    providerId = await promptUser(
      'Enter a unique ID for this provider (e.g., openai-custom-provider): '
    );
    if (!providerId) throw new Error('Provider ID cannot be empty.');

    // Construct the URL for fetching models (remove trailing slash if exists, then add /models)
    const modelsUrl = providerBaseUrl.replace(/\/$/, '') + '/models';
    console.log(`\nAttempting to fetch models from: ${modelsUrl}`);

    // 2. Fetch Models from Provider
    let fetchedModels: { id: string }[] = [];
    try {
        const response = await axios.get(modelsUrl, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            timeout: 10000, // Increased timeout to 10 seconds
        });

        if (response.data && Array.isArray(response.data.data)) {
            fetchedModels = response.data.data.map((m: any) => ({ id: m.id }));
            console.log(`Successfully fetched ${fetchedModels.length} models.`);
        } else {
            console.warn(
                `Warning: Could not parse models from response data. Expected format: { data: [{ id: 'model1' }, ...] }. Response received:`,
                response.data
            );
            const continueAnyway = await promptUser('Continue without specific models? (y/N): ');
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
            console.error('Response data:', error.response.data);
        }
        // Check if it's a timeout error specifically
        if (axios.isCancel(error) || error.code === 'ECONNABORTED') {
            console.error('The request to fetch models timed out.');
        }
        const continueAnyway = await promptUser('Continue without specific models? (y/N): ');
        if (!continueAnyway.toLowerCase().startsWith('y')) {
            throw new Error('Aborted due to model fetching failure.');
        }
        fetchedModels = [];
    }

    // 3. Construct New Provider Entry
    const newModelsObject: { [modelId: string]: ModelInfo } = {};
    for (const model of fetchedModels) {
      if (model.id) {
        newModelsObject[model.id] = {
          response_time: null,
          response_times: [],
        };
      }
    }

    // Construct the final provider URL for API calls
    const finalProviderUrl = providerBaseUrl.replace(/\/$/, '') + '/chat/completions';
    console.log(`Provider endpoint URL set to: ${finalProviderUrl}`); // Log the final URL

    const newProviderEntry: ProviderEntry = {
      id: providerId,
      apiKey: apiKey,
      provider_url: finalProviderUrl, // Use the modified URL here
      models: newModelsObject,
      avg_response_time: 0,
      avg_provider_latency: 0,
      errors: 0,
      provider_score: 0,
    };

    // 4. Add or Update Provider in the list (using the in-memory 'providers' array)
    const existingIdx = providers.findIndex((p) => p.id === providerId);
    if (existingIdx >= 0) {
      providers[existingIdx] = newProviderEntry; // Overwrite
       console.log(`\nUpdated existing provider with ID: ${providerId}`);
    } else {
      providers.push(newProviderEntry);
      console.log(`\nAdded new provider with ID: ${providerId}`);
    }

    // 5. Write Updated Data Back to providers.json using fs
    try {
      const updatedJsonContent = JSON.stringify(providers, null, 2); // Pretty print JSON
      await fs.writeFile(providersFilePath, updatedJsonContent, 'utf-8');
      console.log(`\nSuccessfully updated ${providersFilePath}`);
    } catch (error) {
      console.error(`Error writing updated data to ${providersFilePath}:`, error);
      throw new Error('Failed to write providers.json.');
    }

    console.log('\n--- Provider Addition Complete ---');

  } catch (error: any) {
    console.error('\n--- Operation Failed ---');
    console.error('Error:', error.message);
  } finally {
    rl.close();
  }
}

// Run the main function
addProvider();
