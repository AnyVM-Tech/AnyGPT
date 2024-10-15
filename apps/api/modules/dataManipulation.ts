import * as fs from 'fs';
import * as path from 'path';
import { Provider } from '../providers/interfaces';

type ProvidersData = Provider[];

/**
 * updateLatency function to update the latency (response_time) for a specific model within a specific provider.
 * updateProviderCount function to dynamically update the providers count in models.json.
 */

/**
 * Function to update the latency (response_time) for a specific model within a specific provider.
 * 
 * @param providerId - The ID of the provider.
 * @param modelId - The model ID to update.
 * @param latency - The new response time (latency). If null or undefined, write null.
 */
export function updateLatency(providerId: string, modelId: string, latency: number | null) {
  const filePath = path.join(__dirname, 'models.json'); 
  
  try {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const data: ProvidersData = JSON.parse(fileContent); 

    let providerFound = false;
    let modelFound = false;

    for (let provider of data) {
      if (provider.id === providerId) {
        providerFound = true;  
        const model = provider.models.find(m => m.model_id === modelId);

        if (model) {
          model.response_time = latency !== undefined ? latency : null;  
          modelFound = true;  
          break; 
        }
      }
    }

    if (providerFound && modelFound) {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      console.log(`Model '${modelId}' in provider '${providerId}' updated successfully.`);
    } else if (!providerFound) {
      console.log(`Provider '${providerId}' not found.`);
    } else {
      console.log(`Model '${modelId}' not found in provider '${providerId}'.`);
    }

  } catch (error) {
    if (error instanceof Error) {
      console.error('Error updating the file:', error.message);
    } else {
      console.error('An unknown error occurred.');
    }
  }
}

// Example usage:
// updateLatency('gemini', 'gemini-pro', 200);
// updateLatency('id', 'model_id', null);


const devModelsPath = path.join(__dirname, 'devmodels.json');
const modelsPath = path.join(__dirname, 'models.json');


export function updateProvidersCount() {
  try {
    const devModelsContent = fs.readFileSync(devModelsPath, 'utf8');
    const modelsContent = fs.readFileSync(modelsPath, 'utf8');

    const devModels = JSON.parse(devModelsContent);       
    const modelsData = JSON.parse(modelsContent);         

    const modelToProvidersCount: { [model_id: string]: number } = {};

    for (const provider of modelsData) {
      for (const model of provider.models) {
        const modelId = model.model_id;
        if (!modelToProvidersCount[modelId]) {
          modelToProvidersCount[modelId] = 0;
        }
        modelToProvidersCount[modelId] += 1;  
      }
    }

    devModels.data.forEach((devModel: { id: string; providers: number; }) => {
      const modelId = devModel.id;
      devModel.providers = modelToProvidersCount[modelId] || 0;  
    });

    fs.writeFileSync(devModelsPath, JSON.stringify(devModels, null, 2), 'utf8');
    console.log('devmodels.json has been successfully updated with provider counts.');

  } catch (error) {
    if (error instanceof Error) {
      console.error('Error updating devmodels.json:', error.message);
    } else {
      console.error('An unknown error occurred while updating devmodels.json.');
    }
  }
}
