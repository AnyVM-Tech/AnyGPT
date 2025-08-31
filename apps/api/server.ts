import HyperExpress, { Request, Response } from 'hyper-express';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
// import { Model, Provider, UserData, KeysFile } from './providers/interfaces.js'; // Keep if needed for init
import { modelsRouter } from './routes/models.js';
import { adminRouter } from './routes/admin.js'; // Import the admin router
// Import other routers (assuming they export a HyperExpress.Router instance)
// import { openRouter } from './routes/openrouter.js';
// import { anthropicRouter } from './routes/anthropic.js';
// import { geminiRouter } from './routes/gemini.js';
// import { groqRouter } from './routes/groq.js';
// import { ollamaRouter } from './routes/ollama.js';
import { logError } from './modules/errorLogger.js'; // Import the logger
import { initializeHandlerData } from './providers/handler.js';
import { refreshProviderCountsInModelsFile } from './modules/modelUpdater.js';
import { validateApiKeyAndUsage, TierData, generateUserApiKey, UserData } from './modules/userData.js'; // For generalAuthMiddleware
import { dataManager, LoadedProviders, LoadedProviderData } from './modules/dataManager.js'; // Added LoadedProviders and LoadedProviderData
import { redisReadyPromise } from './modules/db.js'; // Import the redisReadyPromise

// Import Routers
import openaiRouter from './routes/openai.js';
import anthropicRouter from './routes/anthropic.js';
import geminiRouter from './routes/gemini.js';
import groqRouter from './routes/groq.js';
import ollamaRouter from './routes/ollama.js';
import openrouterRouter from './routes/openrouter.js';

dotenv.config();

const defaultModels = {
  object: 'list',
  data: [] as any[], // Using any[] for broader compatibility during init
};

const defaultKeys: Record<string, any> = {}; // Using Record<string, any>

const modelsJsonPath = path.resolve('models.json'); // Adjusted path
const keysJsonPath = path.resolve('keys.json'); // Adjusted path

function initializeJsonFile<T>(filePath: string, defaultContent: T): void {
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true }); // Ensure directory exists
    fs.writeFileSync(filePath, JSON.stringify(defaultContent, null, 2), 'utf8');
    console.log(`Created ${filePath} with default content.`);
  } else {
    try {
      const data = fs.readFileSync(filePath, 'utf8');
      JSON.parse(data);
    } catch (error) {
      console.error(`Invalid JSON format in ${filePath}. Re-initializing... Error: ${(error as Error).message}`);
      fs.writeFileSync(filePath, JSON.stringify(defaultContent, null, 2), 'utf8');
    }
  }
}

// Initialize JSON files first
initializeJsonFile(modelsJsonPath, defaultModels);
initializeJsonFile(keysJsonPath, defaultKeys);

// Function to ensure an initial admin key exists
async function ensureInitialAdminKey() {
    console.log('Checking for initial admin API key...');
    try {
        const keysData = await dataManager.load<Record<string, UserData>>('keys');
        const hasAdminKey = (Object.values(keysData) as UserData[]).some((user: UserData) => user.role === 'admin');

        if (!hasAdminKey) {
            const defaultAdminUserId = 'initial_admin_user';
            const adminTier = 'enterprise'; 
            console.warn(`\n\n[ACTION REQUIRED] No admin API key found. Generating an initial admin key...\n`);
            
            if (keysData[defaultAdminUserId]) {
                console.warn(`User '${defaultAdminUserId}' already exists but without admin role. Please review keys.json or use admin tools to assign role.`);
                console.log('To create a new admin user with a new key, ensure user ID is unique or manage via API once an admin is set up.\n');
                return;
            }

            const newAdminApiKey = await generateUserApiKey(defaultAdminUserId, 'admin', adminTier);
            
            console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
            console.log('!!! INITIAL ADMIN API KEY GENERATED - SAVE THIS SECURELY AND STORE IT SAFELY !!!');
            console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
            console.log(`  User ID: ${defaultAdminUserId}`);
            console.log(`  API Key: ${newAdminApiKey}`);
            console.log(`  Role: admin`);
            console.log(`  Tier: ${adminTier}`);
            console.log("  Use this key with 'Authorization: Bearer <API_KEY>' header to access admin endpoints");
            console.log('  (e.g., POST /api/admin/providers) to configure the API.');
            console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n\n');
        } else {
            console.log('Admin API key already configured.\n');
        }
    } catch (error: any) {
        await logError({
            message: 'Error ensuring initial admin key',
            errorMessage: error.message,
            errorStack: error.stack
        });
        console.warn('Could not verify or generate initial admin key. Manual check of keys.json might be needed.');
    }
}

// Helper to check if a router should be enabled via environment variables
function isRouterEnabled(routerName: string, defaultValue = true): boolean {
    const envVar = process.env[`ENABLE_${routerName.toUpperCase()}_ROUTES`];
    if (envVar === 'false' || envVar === '0') return false;
    if (envVar === 'true' || envVar === '1') return true;
    return defaultValue;
}

// Extend HyperExpress Request interface if not already globally available
// The declaration in openai.ts should make this global, but re-declaring parts
// needed by generalAuthMiddleware here for clarity if this file were isolated.
declare module 'hyper-express' {
    interface Request {
        apiKey?: string;
        userId?: string;
        userRole?: string;
        userTokenUsage?: number;
        userTier?: string;
        tierLimits?: TierData;
    }
}

async function generalAuthMiddleware(request: Request, response: Response, next: () => void) {
    const authHeader = request.headers['authorization'] || request.headers['Authorization'] as string;
    let apiKey = '';

    if (authHeader && authHeader.startsWith('Bearer ')) {
        apiKey = authHeader.slice(7);
    } else if (request.headers['x-api-key'] && typeof request.headers['x-api-key'] === 'string') {
        apiKey = request.headers['x-api-key'];
    } else if (request.headers['api-key'] && typeof request.headers['api-key'] === 'string') {
        apiKey = request.headers['api-key'];
    }

    if (apiKey) {
        try {
            const validationResult = await validateApiKeyAndUsage(apiKey);
            if (validationResult.valid && validationResult.userData && validationResult.tierLimits) {
                request.apiKey = apiKey;
                request.userId = validationResult.userData.userId;
                request.userRole = validationResult.userData.role;
                request.userTokenUsage = validationResult.userData.tokenUsage;
                request.userTier = validationResult.userData.tier;
                request.tierLimits = validationResult.tierLimits;
            } else {
                console.warn(`GeneralAuth: Invalid or unrecognized API key provided. URI: ${request.path}, Key Prefix: ${apiKey.substring(0, Math.min(5, apiKey.length))}...`);
            }
        } catch (error: any) {
            await logError({ message: 'Error during general API key validation', errorMessage: error.message, errorStack: error.stack, apiKeyProvided: !!apiKey }, request);
        }
    }
    next();
}

async function checkProviderConfiguration() {
    try {
        const providersData = await dataManager.load<LoadedProviders>('providers');
        if (!providersData || providersData.length === 0) {
            console.warn('\n[CONFIG ACTION REQUIRED] No providers found in providers.json.');
            guideUserForProviderSetup();
            return;
        }

        const hasConfiguredProvider = providersData.some((provider: LoadedProviderData) => provider.apiKey && provider.apiKey.trim() !== '');
        if (!hasConfiguredProvider) {
            console.warn('\n[CONFIG ACTION REQUIRED] No providers in providers.json appear to have an API key configured.');
            guideUserForProviderSetup();
        }
    } catch (error: any) {
        await logError({ message: 'Error checking provider configuration during startup', errorMessage: error.message, errorStack: error.stack });
    }
}

function guideUserForProviderSetup() {
    console.log('--------------------------------------------------------------------------------------');
    console.log('To use this API, you need to configure your AI model providers:');
    console.log("1. Ensure providers.json contains entries for each provider you want to use.");
    console.log("2. Each provider entry MUST include its API key in the 'apiKey' field.");
    console.log('3. You can add or update providers using the admin endpoint: POST /api/admin/providers');
    console.log("   (Ensure you have an admin API key configured in keys.json - see above if one was just generated).");
    console.log("4. When adding a provider, its 'providerId' helps the system choose the correct handler:");
    console.log("   - For OpenAI compatible: Use an ID like 'openai-yourdescriptivename'.");
    console.log("   - For Gemini/Google: Use an ID like 'gemini-pro-api' or 'google-main'.");
    console.log("   - For Anthropic: Use an ID like 'anthropic-claude-3'.");
    console.log("   - Other IDs will default to an OpenAI-compatible handler if not specifically matched.");
    console.log('--------------------------------------------------------------------------------------\n');
}

async function startServer() {
    console.log('Starting API server...');

    // Wait for Redis to be ready if it's configured
    if (redisReadyPromise) {
        try {
            console.log('[Server] Waiting for Redis connection to be ready...');
            await redisReadyPromise;
            console.log('[Server] Redis connection is ready. Proceeding with server startup.');
        } catch (error: any) {
            // Log the error prominently. dataManager will fallback to filesystem if Redis is preferred but failed.
            console.error(`[Server] CRITICAL: Failed to connect to Redis during startup: ${error.message}.`);
            console.warn('[Server] Proceeding with server startup, but Redis-dependent features might be impacted or fall back to filesystem.');
            // Optionally, you could choose to exit here if Redis is absolutely critical:
            // process.exit(1);
        }
    } else {
        console.log('[Server] Redis client is not configured (redisReadyPromise is null/not available). Proceeding without Redis.');
    }

    const app = new HyperExpress.Server({
        max_body_length: 1024 * 1024 * 50 // 50MB limit
    });

    // Ensure JSON files and initial admin key are set up AFTER Redis check
    try {
        await ensureInitialAdminKey(); // Call before other initializations
        console.log('Initializing handler data...');
        await initializeHandlerData();
        console.log('Refreshing provider counts in models file...');
        await refreshProviderCountsInModelsFile();
        console.log('Data initialization and model provider counts refreshed.');
        await checkProviderConfiguration(); // Check configuration after initialization
    } catch (error: any) {
        await logError({ message: 'Fatal: Server startup failed during data initialization.', errorMessage: error.message, errorStack: error.stack });
        console.error('Fatal: Server startup failed during data initialization.', error);
        process.exit(1);
    }

    // --- Global Middleware ---
    // Consider adding CORS middleware if needed:
    // import cors from 'hyper-express-cors';
    // app.use(cors());
    // HyperExpress has built-in body parsing, accessible via await request.json(), request.text(), etc.

    console.log('\nRegistering API routers:');

    if (isRouterEnabled('MODELS')) {
        app.use('/api', modelsRouter);
        console.log('  ✓ Models routes enabled: /api');
    } else {
        console.log('  𐄂 Models routes disabled.');
    }

    // Admin routes require general authentication first to populate user context
    if (isRouterEnabled('ADMIN')) {
        // The adminRouter itself contains adminOnlyMiddleware that checks request.userRole
        app.use('/api/admin', generalAuthMiddleware, adminRouter);
        console.log('  ✓ Admin routes enabled: /api/admin (general auth applied)');
    } else {
        console.log('  𐄂 Admin routes disabled.');
    }

    if (isRouterEnabled('OPENAI')) {
        app.use('/v1', openaiRouter);
        console.log('  ✓ OpenAI compatible routes enabled: /v1');
    } else {
        console.log('  𐄂 OpenAI compatible routes disabled.');
    }

    if (isRouterEnabled('ANTHROPIC')) {
        app.use('/anthropic', anthropicRouter);
        console.log('  ✓ Anthropic compatible routes enabled: /anthropic');
    } else {
        console.log('  𐄂 Anthropic compatible routes disabled.');
    }

    if (isRouterEnabled('GEMINI')) {
        app.use('/gemini', geminiRouter);
        console.log('  ✓ Gemini compatible routes enabled: /gemini');
    } else {
        console.log('  𐄂 Gemini compatible routes disabled.');
    }

    if (isRouterEnabled('GROQ')) {
        app.use('/groq', groqRouter);
        console.log('  ✓ Groq compatible routes enabled: /groq');
    } else {
        console.log('  𐄂 Groq compatible routes disabled.');
    }

    if (isRouterEnabled('OLLAMA')) {
        app.use('/ollama', ollamaRouter);
        console.log('  ✓ Ollama compatible routes enabled: /ollama');
    } else {
        console.log('  𐄂 Ollama compatible routes disabled.');
    }

    if (isRouterEnabled('OPENROUTER')) {
        app.use('/openrouter', openrouterRouter);
        console.log('  ✓ OpenRouter compatible routes enabled: /openrouter');
    } else {
        console.log('  𐄂 OpenRouter compatible routes disabled.');
    }
    console.log(''); // Newline for cleaner log output

    // --- Global Error Handler ---
    // This handler will catch errors from route handlers or middleware that call next(error)
    app.set_error_handler(async (request: Request, response: Response, error: any) => {
        const timestamp = new Date().toISOString();
        await logError(error, request);
        
        // Send a generic error message to the client for 5xx errors
        if (!response.completed) {
            response.status(500).json({
                error: 'Internal Server Error',
                message: 'An unexpected error occurred. Please try again later.',
                reference: 'Refer to server logs for details.',
                timestamp
            });
        } else {
             console.warn('[ErrorHandler] Response already completed, could not send 500 JSON error.');
        }
    });

    // --- 404 Not Found Handler ---
    app.set_not_found_handler(async (request: Request, response: Response) => {
        const timestamp = new Date().toISOString();
        const message = `Not Found: The requested resource '${request.path}' was not found on this server.`;
        await logError({ message, statusCode: 404, requestPath: request.path, requestMethod: request.method }, request);
        if (!response.completed) {
            response.status(404).json({
                error: 'Not Found',
                message,
                timestamp
            });
        } else {
            console.warn('[NotFoundHandler] Response already completed, could not send 404 JSON error.');
        }
    });

    const port = parseInt(process.env.PORT || '3000', 10);
    if (isNaN(port) || port <= 0) {
        const warningMsg = `Invalid PORT environment variable: ${process.env.PORT}. Defaulting to 3000.`;
        console.warn(warningMsg);
        await logError({ message: warningMsg, level: 'warn' });
        process.env.PORT = '3000';
    }

    app.listen(port)
        .then(async () => {
            console.log(`\n🚀 API Server successfully started.`);
            console.log(`Listening on port: ${port}`);
            console.log(`Access local API at: http://localhost:${port}`);
            console.log('To enable/disable routers, use environment variables like:');
            console.log('  ENABLE_OPENAI_ROUTES=true/false');
            console.log('etc. Default is typically true if not set for most provider routes.');
            
            // Check if an admin key exists to tailor the final message slightly.
            // This is a simplified check; the detailed generation log is in ensureInitialAdminKey.
            let adminKeyExists = false;
            try {
                const keys = await dataManager.load<Record<string, UserData>>('keys');
                adminKeyExists = Object.values(keys).some((user: UserData) => user.role === 'admin');
            } catch (e) {
                // Ignore error here, just for a slightly more tailored log message.
            }

            if (adminKeyExists) {
                console.log('\nAn admin API key is configured. Check earlier logs if a new one was just generated.');
            } else {
                // This case implies ensureInitialAdminKey might have had an issue or is being bypassed.
                console.warn('\nNo admin key seems to be configured. Check startup logs carefully for an auto-generated key or errors.');
            }
            console.log('Review console output above for important setup information and any generated credentials.');
            console.log('\nPress CTRL+C to stop the server.');
        })
        .catch(async (error: any) => {
            await logError({message: 'Fatal: Server failed to start listening.', errorMessage: error.message, errorStack: error.stack});
            console.error('Fatal: Server failed to start listening.', error);
            process.exit(1);
        });
}

// --- Start the server ---
startServer();