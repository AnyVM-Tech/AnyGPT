#!/usr/bin/env node

import { Command } from 'commander';
import { generateAdminApiKey } from '../modules/userData.js';

const program = new Command();

program
  .command('generate')
  .description('Generate an admin key')
  .argument('<userId>', 'User ID to generate a key for')
  .action((userId: string) => {
    try {
      const apiKey = generateAdminApiKey(userId);
      console.log('Generated API key:', apiKey);
    } catch (error: any) {
      console.error('Error generating API key:', error.message);
    }
  });

  program.parse(process.argv);