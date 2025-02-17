import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
interface ModelSummary {
  id: string;
  owned_by?: string;
}

interface Model {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  providers?: number; 
}

interface ProviderModels {
  [provider: string]: Model[];
}

interface OutputData {
  object: string;
  data: Model[];
}

async function fetchAndGroupModelData(): Promise<{ [ownedBy: string]: ModelSummary[] }> {
    const modelsEndpoint = 'https://api.shard-ai.xyz/v1/models/';
    try {
      const response = await axios.get(modelsEndpoint);
      const rawData = response.data;
      const groupedModels: { [ownedBy: string]: ModelSummary[] } = {};
  
      rawData.data.forEach((model: any) => {
        const groupKey = model.owned_by || "other"; 
        const summary: ModelSummary = {
          id: model.id,
          owned_by: model.owned_by,
        };
  
        if (!groupedModels[groupKey]) {
          groupedModels[groupKey] = [];
        }
        groupedModels[groupKey].push(summary);
      });
  
      return groupedModels;
    } catch (error) {
      console.error('Error fetching and grouping model data:', error);
      throw error;
    }
  }

  type GroupedModelData = Record<string, ModelSummary[]>;

  async function readAndMergeModelData() {
    const filePath = path.join('/workspaces/anyGPT/apps/api', 'models.json');
  
    try {
      let existingData: GroupedModelData = {}; 
      try {
        const existingDataRaw = fs.readFileSync(filePath, 'utf8');
        existingData = JSON.parse(existingDataRaw) as GroupedModelData;
      } catch (readOrParseError) {
        console.warn('Warning: Failed to read or parse existing models.json. Assuming empty object.', readOrParseError);
      }
  
      const newData = await fetchAndGroupModelData();
  
      Object.keys(newData).forEach((groupKey) => {
        if (!existingData[groupKey]) {
          existingData[groupKey] = newData[groupKey].map(({ id }) => ({ id }));
        } else {
          const existingIds = existingData[groupKey].map((model) => model.id);
          newData[groupKey].forEach((newModel) => {
            if (!existingIds.includes(newModel.id)) {
              existingData[groupKey].push({ id: newModel.id });
            }
          });
        }
      });
  
      fs.writeFileSync(filePath, JSON.stringify(existingData, null, 2), 'utf8');
      console.log('Model data merged successfully.');
    } catch (error) {
      console.error('Error reading, merging, or writing model data:', error);
    }
  }
  
  async function modifyModel(groupKey: string, modelId: string, newModelData: Partial<ModelSummary>) {
    const filePath = path.join('/workspaces/anyGPT/apps/api', 'models.json');
  
    try {
      const existingDataRaw = fs.readFileSync(filePath, 'utf8');
      const existingData = JSON.parse(existingDataRaw) as GroupedModelData; 
      if (!existingData[groupKey]) {
        existingData[groupKey] = [];
        // uncomment the next line to return an error instead of creating a new group
        // throw new Error(`Group ${groupKey} does not exist.`);
      }
      const modelIndex = existingData[groupKey].findIndex((model: ModelSummary) => model.id === modelId);
      if (modelIndex > -1) {
        existingData[groupKey][modelIndex] = { ...existingData[groupKey][modelIndex], ...newModelData };
      } else {
        existingData[groupKey].push({ id: modelId, ...newModelData });
      }
      fs.writeFileSync(filePath, JSON.stringify(existingData, null, 2), 'utf8');
      console.log(`Model ${modelId} in group ${groupKey} modified successfully.`);
    } catch (error) {
      console.error('Error modifying model data:', error);
    }
  }

  interface Model {
    id: string;
  }
  
  interface ProviderReport {
    name: string;
    models: Model[];
  }
  
  class ModelProvider {
    supportedProviders: string[];
  
    constructor(supportedProviders: string[]) {
      this.supportedProviders = supportedProviders;
    }
  
    async generateProviderModelLatencyReport(providerName: string, modelName: string) {
      const modelsFilePath = '/root/github/anyGPT/apps/api/models.json';
      const reportFilePath = '/root/github/anyGPT/apps/api/devmodels.json';
      try {
        const modelsData = await fs.promises.readFile(modelsFilePath, 'utf8');
        const models = JSON.parse(modelsData);
  
       
        const report: { provider: ProviderReport[] } = { provider: [] };
        
        if (models[providerName]) {
          const filteredModels = models[providerName]
            .filter((model: { id: string; }) => model.id.includes(modelName))
            .map((model: { id: string; }) => ({ id: model.id }));
        
          
          const providerReport: ProviderReport = {
            name: providerName,
            models: filteredModels
          };
        
          
          if (!report.provider) {
            report.provider = [];
          }
        
          
          report.provider.push(providerReport);
        }
  
        await promisify(fs.writeFile)(reportFilePath, JSON.stringify(report, null, 2), 'utf8');
        console.log('Provider model latency report generated successfully.');
      } catch (error) {
        console.error('Error generating provider model latency report:', error);
      }
    }
  }
  
  (async () => {
    const modelProvider = new ModelProvider(['google', 'gemini']); 
    await modelProvider.generateProviderModelLatencyReport('google', 'gemini'); 
    console.log('Report generation completed.');
  })();