import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { setupMockProviderConfig, restoreProviderConfig } from './testSetup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
dotenv.config({ path: path.join(projectRoot, envFile), override: true });

const action = process.argv[2] || 'setup';

if (action === 'setup') {
  setupMockProviderConfig();
} else if (action === 'restore') {
  restoreProviderConfig();
} else {
  console.error(`Unknown action: ${action}. Use 'setup' or 'restore'.`);
  process.exit(1);
}
