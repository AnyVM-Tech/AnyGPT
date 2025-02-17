import * as fs from 'fs';
// add a list of models if no alr in models.json, doesnt include throughput
const modelsToCheck = [
  "chatgpt-4o-latest",
  "claude-3-haiku",
  "claude-3-opus",
  "claude-3-sonnet",
  "claude-3.5-sonnet",
  "claude-3.5-sonnet-20240620",
  "command-r-plus",
  "gemini-1.0-pro",
  "gemini-1.0-pro-001",
  "gemini-1.0-pro-002",
  "gemini-1.5-flash",
  "gemini-1.5-flash-001",
  "gemini-1.5-flash-002",
  "gemini-1.5-pro",
  "gemini-1.5-pro-001",
  "gemini-1.5-pro-002",
  "gemma-2-27b-it",
  "gemma-2-9b-it",
  "gemma-7b-it",
  "gpt-3.5-turbo",
  "gpt-4",
  "gpt-4-turbo",
  "gpt-4o",
  "gpt-4o-2024-05-13",
  "gpt-4o-2024-08-06",
  "gpt-4o-mini",
  "llama-3-70b-chat",
  "llama-3-8b-chat",
  "llama-3.1-405b-chat",
  "llama-3.1-70b-chat",
  "llama-3.1-8b-chat",
  "llama-3.1-nemotron-70b-chat",
  "llama-3.2-11b-chat",
  "llama-3.2-1b-chat",
  "llama-3.2-3b-chat",
  "llama-3.2-90b-chat",
  "ministral-3b",
  "ministral-8b",
  "mistral-7b-instruct-v0.2",
  "mistral-7b-instruct-v0.3",
  "mistral-large",
  "mistral-nemo",
  "mistral-small",
  "mixtral-8x22b-instruct-v0.1",
  "mixtral-8x7b-instruct-v0.1",
  "o1-mini",
  "o1-preview",
  "qwen-2-72b-instruct",
  "qwen-2.5-14b-instruct",
  "qwen-2.5-72b-instruct",
  "qwen-2.5-7b-instruct"
];

function guessOwnedBy(modelId: string): string {
  if (modelId.startsWith('gpt')) {
    return 'openai';
  } else if (modelId.includes('claude')) {
    return 'anthropic';
  } else if (modelId.includes('gemini') || modelId.includes('gemma')) {
    return 'google';
  } else if (modelId.includes('llama')) {
    return 'meta';
  } else if (modelId.includes('mistral') || modelId.includes('ministral') || modelId.includes('mixtral')) {
    return 'mistral.ai';
  } else if (modelId.includes('qwen')) {
    return 'alibaba';
  } else if (modelId.includes('o1')) {
    return 'openai';
  } else if (modelId.includes('command')) {
    return 'cohere';
  } else if (modelId.includes('chatgpt')) {
    return 'openai';
  } else {
    return 'unknown';
  }
}

function addMissingModels() {
  const filePath = './models.json';

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    return;
  }

  try {
    const jsonData = fs.readFileSync(filePath, 'utf-8');
    const modelsData = JSON.parse(jsonData);

    if (!modelsData || !Array.isArray(modelsData.data)) {
      console.error('Invalid models.json format.');
      return;
    }

    const existingModelIds = modelsData.data.map((model: { id: string }) => model.id);

    const missingModels = modelsToCheck.filter((modelId) => !existingModelIds.includes(modelId));

    if (missingModels.length === 0) {
      console.log('All models are already present in models.json.');
    } else {
      console.log('Adding missing models to models.json:');
      missingModels.forEach((modelId) => {
        const ownedBy = guessOwnedBy(modelId);
        const newModel = {
          id: modelId,
          object: "model",
          created: Date.now(),
          owned_by: ownedBy,
          providers: 0
        };
        modelsData.data.push(newModel);
        console.log(`Added model: ${modelId}, owned by: ${ownedBy}`);
      });

      fs.writeFileSync(filePath, JSON.stringify(modelsData, null, 2), 'utf-8');
      console.log('models.json has been updated with missing models.');
    }
  } catch (error) {
    console.error('Error reading or parsing models.json:', error);
  }
}

addMissingModels();