import dotenv from 'dotenv';
import path from 'path';
import { setupMockProviderConfig, restoreProviderConfig } from './testSetup.js';

const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
dotenv.config({ path: path.resolve(process.cwd(), envFile) });

const action = process.argv[2] || 'setup';

if (action === 'setup') {
  setupMockProviderConfig();
} else if (action === 'restore') {
  restoreProviderConfig();
} else {
  console.error(`Unknown action: ${action}. Use 'setup' or 'restore'.`);
  process.exit(1);
}
