#!/usr/bin/env node

import { Command } from 'commander';
import { generateAdminApiKey } from '../modules/userData.js';

const program = new Command();

program
  .command('generate')
  .description('Generate an admin key')
  .argument('<userId>', 'User ID to generate a key for')
  .action(async (userId: string) => {
    try {
      const apiKey = await generateAdminApiKey(userId);
      const maskedApiKey = typeof apiKey === 'string'
        ? apiKey.replace(/.(?=.{4})/g, '*')
        : '[non-string key]';
      console.log('Generated API key for user:', userId, 'Key (masked):', maskedApiKey);
    } catch (error: any) {
      console.error('Error generating API key:', error.message);
    }
  });

  program.parse(process.argv);