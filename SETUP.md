# AnyGPT Setup Guide

## First-Time Setup

AnyGPT includes an interactive setup script to help you configure your environment quickly and easily.

### Running the Setup Script

```bash
# Clone the repository
git clone <your-repo-url>
cd AnyGPT-experimental

# Install dependencies
pnpm install

# Run the interactive setup
pnpm setup
```

### Setup Options

The setup script offers two modes:

#### 1. Quick Setup (Recommended for Testing)
- Uses sensible defaults
- Enables all core routes
- Uses filesystem storage (no Redis required)
- Perfect for getting started quickly

#### 2. Custom Setup
Configure every aspect of your installation:

##### Server Configuration
- **Port**: API server port (default: 3000)
- **Routes**: Enable/disable specific API routes:
  - Models Routes (recommended: enabled)
  - Admin Routes (recommended: enabled)  
  - OpenAI Routes
  - Anthropic Routes
  - Gemini Routes
  - Groq Routes
  - OpenRouter Routes
  - Ollama Routes

##### Redis Configuration
Choose between three options:

1. **No Redis** (Default)
   - Uses filesystem storage
   - No external dependencies
   - Good for development and testing

2. **Redis Cloud** (Recommended for Production)
   - Paste your Redis Cloud connection string
   - Automatic parsing and configuration
   - Includes TLS setup

3. **Self-Hosted Redis**
   - Manual configuration
   - For custom Redis installations

##### Redis Cloud Setup

If you're using Redis Cloud, you can simply paste your connection command:

```bash
# Example Redis Cloud connection command:
redis-cli -u redis://default:your-password@your-host.redis-cloud.com:port
```

The setup script will automatically:
- Parse the connection string
- Extract host, port, username, and password
- Enable TLS (required for Redis Cloud)
- Configure error logging

⚠️ **Important**: Only use the Redis Cloud option for cloud-hosted Redis. For self-hosted instances, use manual configuration.

##### Other Configuration Options
- **Log Level**: debug, info, warn, error (default: info)
- **Admin User**: Create a default admin user with API key

### After Setup

Once setup is complete:

1. Navigate to the API directory:
   ```bash
   cd apps/api
   ```

2. Start the development server:
   ```bash
   pnpm dev
   ```

3. (Optional) Start the UI (LibreChat):
   ```bash
   cd ../ui
   pnpm dev
   ```

### Environment File

The setup script creates a `.env` file in `apps/api/.env` with your chosen configuration. You can manually edit this file later if needed.

For OpenRouter support, ensure these are set (defaults provided by the setup script):

- OPENROUTER_REFERRER=https://gpt.anyvm.tech
- OPENROUTER_TITLE=AnyGPT

### Redis Cloud Connection String Format

The setup script can parse Redis Cloud connection strings in these formats:

```bash
# Full redis-cli command
redis-cli -u redis://username:password@host:port

# Direct Redis URL
redis://username:password@host:port
```

### Troubleshooting

#### Redis Connection Issues
- Verify your Redis Cloud credentials in the dashboard
- Ensure your IP is whitelisted (if using Redis Cloud)
- Check that TLS is enabled for cloud connections

#### Port Already in Use
- Change the PORT in your `.env` file
- Or kill the process using the port: `npx kill-port 3000`

#### Missing Dependencies
- Run `pnpm install` in the root directory
- Run `pnpm install` in `apps/api`
- LibreChat runs via Docker; see `apps/ui/README.md` for setup

### Re-running Setup

You can re-run the setup script at any time:

```bash
pnpm setup
```

The script will ask if you want to overwrite your existing `.env` file.

### Manual Configuration

If you prefer to configure manually, copy the example file:

```bash
cp apps/api/.env.example apps/api/.env
```

Then edit `apps/api/.env` with your preferred settings.
