import fs from 'fs';
import path from 'path';
import { Model, Provider, UserData, KeysFile } from './providers/interfaces';

const defaultModels = {
  object: 'list',
  data: [] as Model[],
};

const defaultDevModels: Provider[] = [];

const defaultKeys: KeysFile = {};


const modelsJsonPath = path.resolve(__dirname, 'models.json');
const devModelsJsonPath = path.resolve(__dirname, 'devmodels.json');
const keysJsonPath = path.resolve(__dirname, 'keys.json');

function initializeJsonFile<T>(filePath: string, defaultContent: T): void {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultContent, null, 2), 'utf8');
    console.log(`Created ${filePath} with default content.`);
  } else {
    try {
      const data = fs.readFileSync(filePath, 'utf8');
      JSON.parse(data);
    } catch {
      console.error(`Invalid JSON format in ${filePath}. Re-initializing...`);
      fs.writeFileSync(filePath, JSON.stringify(defaultContent, null, 2), 'utf8');
    }
  }
}

initializeJsonFile(modelsJsonPath, defaultModels);
initializeJsonFile(devModelsJsonPath, defaultDevModels);
initializeJsonFile(keysJsonPath, defaultKeys);