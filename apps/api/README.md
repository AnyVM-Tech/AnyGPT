execute below to generate admin api key (make sure you're in api directory)
npx tsx server/generateApiKey.ts 

routes

anthropic /v3/messages
groq /v4/chat/completions
gemini /v2/models/:modelId:generateContent
ollama /v5/api/chat
openai /v1/chat/completions /v1/models
openrouter /v6/chat/completions