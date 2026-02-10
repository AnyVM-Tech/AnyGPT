#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { createInterface } from 'readline'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import chalk from 'chalk'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
})

const question = (query) => new Promise((resolve) => rl.question(query, resolve))

function parseRedisCloudConnection(connectionString) {
  let redisUrl = connectionString
  const cliMatch = connectionString.match(/redis-cli\s+-u\s+(.+)/)
  if (cliMatch) {
    redisUrl = cliMatch[1]
  }

  const urlMatch = redisUrl.match(/redis:\/\/([^:]+):([^@]+)@([^:]+):(\d+)/)
  if (!urlMatch) {
    throw new Error('Invalid Redis URL format')
  }

  const [, username, password, host, port] = urlMatch

  return {
    url: `${host}:${port}`,
    username,
    password,
    tls: false,
    db: 0,
  }
}

function generateEnvContent(config) {
  const envTemplate = `# API Server Configuration
PORT=${config.port}

# Data Source Configuration
DATA_SOURCE_PREFERENCE=${config.redis.enabled ? 'redis' : 'filesystem'} # filesystem or redis

# --- Router Enabling/Disabling ---
# Set to true to enable routes, false to disable
ENABLE_MODELS_ROUTES=${config.enableModelsRoutes}
ENABLE_ADMIN_ROUTES=${config.enableAdminRoutes}
ENABLE_OPENAI_ROUTES=${config.enableOpenAIRoutes}
ENABLE_ANTHROPIC_ROUTES=${config.enableAnthropicRoutes}
ENABLE_GEMINI_ROUTES=${config.enableGeminiRoutes}
ENABLE_GROQ_ROUTES=${config.enableGroqRoutes}
ENABLE_OPENROUTER_ROUTES=${config.enableOpenRouterRoutes}
ENABLE_OLLAMA_ROUTES=${config.enableOllamaRoutes}

# --- Redis Configuration ---
${config.redis.enabled ? `REDIS_URL=${config.redis.url}
REDIS_USERNAME=${config.redis.username}
REDIS_PASSWORD=${config.redis.password}
REDIS_DB=${config.redis.db}
REDIS_TLS=${config.redis.tls}
ERROR_LOG_TO_REDIS=${config.redis.errorLogging}
REDIS_ERROR_LOG_KEY=api_errors
REDIS_ERROR_LOG_MAX_ENTRIES=1000` : `# REDIS_URL=
# REDIS_USERNAME=
# REDIS_PASSWORD=
# REDIS_DB=0
# REDIS_TLS=false
# ERROR_LOG_TO_REDIS=false
# REDIS_ERROR_LOG_KEY=api_errors
# REDIS_ERROR_LOG_MAX_ENTRIES=1000`}

# --- Logging Configuration ---
LOG_LEVEL=${config.logLevel}

# --- OpenRouter Configuration (required by OpenRouter) ---
OPENROUTER_REFERRER=${config.openRouter.referrer}
OPENROUTER_TITLE=${config.openRouter.title}

# --- Testing Configuration (uncomment for testing) ---
# TEST_API_KEY=test-key-for-mock-provider
# WS_URL=ws://localhost:3000/ws

# --- Mock Provider Configuration (for development/testing) ---
# MOCK_BASE_DELAY=50
# MOCK_DELAY_VARIANCE=20
# MOCK_ERROR_RATE=0.1
# MOCK_TIMEOUT_RATE=0.05
# MOCK_SLOW_RATE=0.1
# MOCK_SLOW_DELAY=2000
# MOCK_TOKEN_SPEED=50
# MOCK_ENABLE_LOGS=false

# --- Optional: Default Admin User ---
${config.adminUser.enabled ? `DEFAULT_ADMIN_USER_ID=${config.adminUser.id}
DEFAULT_ADMIN_API_KEY=${config.adminUser.apiKey}` : `# DEFAULT_ADMIN_USER_ID=admin
# DEFAULT_ADMIN_API_KEY=your-admin-api-key`}
`

  return envTemplate
}

async function main() {
  console.log(chalk.blue.bold('\n🚀 Welcome to AnyGPT Setup!\n'))
  console.log(chalk.gray('This script will help you configure your environment for first-time use.\n'))

  const envPath = join(__dirname, '.env')
  if (existsSync(envPath)) {
    console.log(chalk.yellow('⚠️  .env file already exists!'))
    const overwrite = await question(chalk.yellow('Do you want to overwrite it? (y/N): '))
    if (overwrite.toLowerCase() !== 'y' && overwrite.toLowerCase() !== 'yes') {
      console.log(chalk.gray('Setup cancelled.'))
      rl.close()
      return
    }
  }

  console.log(chalk.green("Let's configure your environment!\n"))

  const config = {
    port: 3000,
    enableModelsRoutes: true,
    enableAdminRoutes: true,
    enableOpenAIRoutes: true,
    enableAnthropicRoutes: true,
    enableGeminiRoutes: true,
    enableGroqRoutes: true,
    enableOpenRouterRoutes: false,
    enableOllamaRoutes: false,
    redis: {
      enabled: false,
      url: '',
      username: 'default',
      password: '',
      db: 0,
      tls: false,
      errorLogging: false,
    },
    logLevel: 'info',
    adminUser: {
      enabled: false,
      id: 'admin',
      apiKey: '',
    },
    openRouter: {
      referrer: 'https://gpt.anyvm.tech',
      title: 'AnyGPT',
    },
  }

  console.log(chalk.cyan('🔧 Setup Options:'))
  console.log('1. Quick setup with defaults (recommended for testing)')
  console.log('2. Custom setup (configure everything)')

  const setupChoice = await question(chalk.cyan('\nChoose setup type (1 or 2): '))

  if (setupChoice === '2') {
    console.log(chalk.blue('\n📋 Custom Setup\n'))

    const portInput = await question(chalk.white(`API Port (default: ${config.port}): `))
    if (portInput) config.port = parseInt(portInput, 10) || config.port

    console.log(chalk.blue('\n🛣️  Route Configuration:'))

    const routes = [
      { key: 'enableModelsRoutes', name: 'Models Routes', default: true },
      { key: 'enableAdminRoutes', name: 'Admin Routes', default: true },
      { key: 'enableOpenAIRoutes', name: 'OpenAI Routes', default: true },
      { key: 'enableAnthropicRoutes', name: 'Anthropic Routes', default: true },
      { key: 'enableGeminiRoutes', name: 'Gemini Routes', default: true },
      { key: 'enableGroqRoutes', name: 'Groq Routes', default: true },
      { key: 'enableOpenRouterRoutes', name: 'OpenRouter Routes', default: false },
      { key: 'enableOllamaRoutes', name: 'Ollama Routes', default: false },
    ]

    for (const route of routes) {
      const defaultText = route.default ? 'Y/n' : 'y/N'
      const answer = await question(chalk.white(`Enable ${route.name}? (${defaultText}): `))

      if (route.default) {
        config[route.key] = answer.toLowerCase() !== 'n' && answer.toLowerCase() !== 'no'
      } else {
        config[route.key] = answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes'
      }
    }

    console.log(chalk.blue('\n🔴 Redis Configuration:'))
    const useRedis = await question(chalk.white('Do you want to configure Redis? (y/N): '))

    if (useRedis.toLowerCase() === 'y' || useRedis.toLowerCase() === 'yes') {
      config.redis.enabled = true

      console.log(chalk.yellow('\n⚠️  Redis Cloud vs Self-Hosted:'))
      console.log(chalk.gray('- If using Redis Cloud: Paste your redis-cli connection command'))
      console.log(chalk.gray('- If self-hosting: Choose manual configuration\n'))

      const redisSetupType = await question(chalk.white('1. Parse Redis Cloud connection string\n2. Manual configuration\nChoose (1 or 2): '))

      if (redisSetupType === '1') {
        console.log(chalk.yellow('\n📋 Paste your Redis Cloud connection command:'))
        console.log(chalk.gray('Example: redis-cli -u redis://default:password@host:port'))

        const connectionString = await question(chalk.white('Connection string: '))

        try {
          const redisConfig = parseRedisCloudConnection(connectionString)
          config.redis = { ...config.redis, ...redisConfig, enabled: true }

          console.log(chalk.green('✅ Redis Cloud connection parsed successfully!'))
          console.log(chalk.gray(`   Host: ${redisConfig.url}`))
          console.log(chalk.gray(`   Username: ${redisConfig.username}`))
          console.log(chalk.gray(`   TLS: ${redisConfig.tls}`))
        } catch (error) {
          console.log(chalk.red(`❌ Error parsing connection: ${error.message}`))
          console.log(chalk.yellow('Falling back to manual configuration...'))

          config.redis.url = await question(chalk.white('Redis URL (host:port): '))
          config.redis.username = (await question(chalk.white('Redis Username (default): '))) || 'default'
          config.redis.password = await question(chalk.white('Redis Password: '))
          const tlsFallbackInput = await question(chalk.white('Use TLS? (y/N): '))
          config.redis.tls = tlsFallbackInput.toLowerCase() === 'y' || tlsFallbackInput.toLowerCase() === 'yes'
        }
      } else {
        console.log(chalk.yellow('\n⚠️  Warning: Manual configuration is recommended for self-hosted Redis only.'))
        console.log(chalk.yellow('For Redis Cloud, use option 1 for automatic parsing.\n'))

        config.redis.url = await question(chalk.white('Redis URL (host:port): '))
        config.redis.username = (await question(chalk.white('Redis Username (default): '))) || 'default'
        config.redis.password = await question(chalk.white('Redis Password: '))
        const tlsInput = await question(chalk.white('Use TLS? (y/N): '))
        config.redis.tls = tlsInput.toLowerCase() === 'y' || tlsInput.toLowerCase() === 'yes'
      }

      const dbInput = await question(chalk.white(`Redis DB index (default: ${config.redis.db}): `))
      if (dbInput) config.redis.db = parseInt(dbInput, 10) || config.redis.db

      const errorLogging = await question(chalk.white('Enable error logging to Redis? (y/N): '))
      config.redis.errorLogging = errorLogging.toLowerCase() === 'y' || errorLogging.toLowerCase() === 'yes'
    }

    console.log(chalk.blue('\n📝 Logging Configuration:'))
    const logLevels = ['debug', 'info', 'warn', 'error']
    console.log(chalk.gray(`Available levels: ${logLevels.join(', ')}`))
    const logLevelInput = await question(chalk.white(`Log level (default: ${config.logLevel}): `))
    if (logLevelInput && logLevels.includes(logLevelInput)) {
      config.logLevel = logLevelInput
    }

    console.log(chalk.blue('\n👤 Admin User Configuration:'))
    const createAdmin = await question(chalk.white('Create default admin user? (y/N): '))

    if (createAdmin.toLowerCase() === 'y' || createAdmin.toLowerCase() === 'yes') {
      config.adminUser.enabled = true

      const adminId = await question(chalk.white(`Admin User ID (default: ${config.adminUser.id}): `))
      if (adminId) config.adminUser.id = adminId

      const adminKey = await question(chalk.white('Admin API Key (leave empty for auto-generation): '))
      config.adminUser.apiKey = adminKey || `admin-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    }

    console.log(chalk.blue('\n🌐 OpenRouter Headers (required by OpenRouter)'))
    const referrerInput = await question(chalk.white(`OPENROUTER_REFERRER (default: ${config.openRouter.referrer}): `))
    if (referrerInput) config.openRouter.referrer = referrerInput.trim()
    const titleInput = await question(chalk.white(`OPENROUTER_TITLE (default: ${config.openRouter.title}): `))
    if (titleInput) config.openRouter.title = titleInput.trim()
  } else {
    console.log(chalk.green('\n✅ Using quick setup with defaults (filesystem storage, all routes enabled)'))
  }

  console.log(chalk.blue('\n📝 Generating .env file...'))

  const envContent = generateEnvContent(config)
  writeFileSync(envPath, envContent)

  console.log(chalk.green('✅ .env file created successfully!'))

  console.log(chalk.blue('\n📋 Configuration Summary:'))
  console.log(chalk.gray(`   Port: ${config.port}`))
  console.log(chalk.gray(`   Redis: ${config.redis.enabled ? '✅ Enabled' : '❌ Disabled'}`))
  if (config.redis.enabled) {
    console.log(chalk.gray(`   Redis URL: ${config.redis.url}`))
    console.log(chalk.gray(`   Redis TLS: ${config.redis.tls}`))
  }
  console.log(chalk.gray(`   Log Level: ${config.logLevel}`))
  console.log(chalk.gray(`   Admin User: ${config.adminUser.enabled ? '✅ Enabled' : '❌ Disabled'}`))

  console.log(chalk.green('\n🎉 Setup complete!'))
  console.log(chalk.blue('\nNext steps:'))
  console.log(chalk.gray('1. cd apps/api'))
  console.log(chalk.gray('2. pnpm install'))
  console.log(chalk.gray('3. pnpm dev'))

  if (config.redis.enabled) {
    console.log(chalk.yellow('\n⚠️  Important: Make sure your Redis instance is accessible and credentials are correct.'))
  }

  rl.close()
}

main().catch((error) => {
  console.error(chalk.red('❌ Setup failed:'), error.message)
  rl.close()
  process.exit(1)
})
