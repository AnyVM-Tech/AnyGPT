import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import path from 'path';
import OpenAI from 'openai';

import { setupMockProviderConfig, restoreProviderConfig } from './testSetup.js';

const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
dotenv.config({ path: path.resolve(process.cwd(), envFile) });

function resolveClientBaseUrl(): string {
  const port = process.env.PORT || '3000';
  const rawBaseUrl = process.env.TEST_API_BASE_URL || `http://localhost:${port}`;
  const normalized = rawBaseUrl.replace(/\/$/, '');
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
}

function getExpectedMockResponsesText(userInput: string): string {
  const normalized = userInput.toLowerCase();
  if (normalized.includes('haiku')) {
    return 'APIs connect bright,\nRequests flow through one clear gateway,\nSDKs rest easy.';
  }
  if (normalized.includes('hello')) {
    return 'Hello from the mock Responses API.';
  }
  return `This is a mock responses reply to: "${userInput}".`;
}

function getExpectedMockResponsesReasoning(hasTools: boolean): string {
  return hasTools
    ? 'Selecting the best tool and preparing its arguments.'
    : 'Planning the response before generating the final answer.';
}

function getReasoningSummaryText(item: any): string | undefined {
  const summaryParts = Array.isArray(item?.summary) ? item.summary : [];
  const firstSummaryText = summaryParts.find((part: any) => typeof part?.text === 'string' && part.text.length > 0);
  return typeof firstSummaryText?.text === 'string' ? firstSummaryText.text : undefined;
}

async function runSdkCompatibilityTest() {
  const manageSetup = process.env.TEST_SETUP_MODE !== 'external';
  if (manageSetup) {
    setupMockProviderConfig();
  }

  const apiKey = process.env.TEST_API_KEY || 'test-key-for-mock-provider';
  const model = 'gpt-3.5-turbo';
  const responsesModel = 'gpt-5.4';
  const baseURL = resolveClientBaseUrl();
  const client = new OpenAI({ apiKey, baseURL });

  console.log(`[SDK-TEST] Testing OpenAI Node SDK compatibility against ${baseURL}`);

  try {
    const completion = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'Write a short haiku about APIs.' }],
    });

    assert.equal(completion.object, 'chat.completion');
    assert.ok(typeof completion.id === 'string' && completion.id.length > 0);
    assert.ok(Array.isArray(completion.choices) && completion.choices.length > 0);
    assert.equal(completion.choices[0]?.message?.role, 'assistant');
    assert.ok(typeof completion.choices[0]?.message?.content === 'string' && completion.choices[0].message.content.length > 0);
    assert.ok(typeof completion.usage?.total_tokens === 'number');
    console.log('[SDK-TEST] ✅ Non-stream chat completion is accepted by the OpenAI SDK.');

    const stream = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'Write a short haiku about APIs.' }],
      stream: true,
    });

    let streamedText = '';
    let streamedChunks = 0;
    for await (const chunk of stream) {
      streamedChunks += 1;
      const delta = chunk.choices[0]?.delta?.content;
      if (typeof delta === 'string') streamedText += delta;
    }

    assert.ok(streamedChunks > 0);
    assert.ok(streamedText.trim().length > 0);
    console.log('[SDK-TEST] ✅ Streaming chat completion is accepted by the OpenAI SDK.');

    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'get_time',
          description: 'Get the local time for a city',
          parameters: {
            type: 'object',
            properties: {
              city: { type: 'string' },
            },
            required: ['city'],
          },
        },
      },
    ];

    const responseTools = [
      {
        type: 'function' as const,
        name: 'get_time',
        description: 'Get the local time for a city',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string' },
          },
          required: ['city'],
        },
        strict: false,
      },
    ];

    const toolCompletion = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'Call get_time for NYC.' }],
      tools,
      tool_choice: 'auto',
    });

    assert.equal(toolCompletion.choices[0]?.finish_reason, 'tool_calls');
    assert.ok(Array.isArray(toolCompletion.choices[0]?.message?.tool_calls) && toolCompletion.choices[0].message.tool_calls.length > 0);
    assert.equal(toolCompletion.choices[0]?.message?.tool_calls?.[0]?.function?.name, 'get_time');
    assert.doesNotThrow(() => JSON.parse(toolCompletion.choices[0]?.message?.tool_calls?.[0]?.function?.arguments || '{}'));
    console.log('[SDK-TEST] ✅ Non-stream tool calls are accepted by the OpenAI SDK.');

    const toolStream = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'Call get_time for NYC.' }],
      tools,
      tool_choice: 'auto',
      stream: true,
    });

    let sawToolCallDelta = false;
    let sawToolCallFinish = false;
    for await (const chunk of toolStream) {
      const deltaToolCalls = chunk.choices[0]?.delta?.tool_calls;
      if (Array.isArray(deltaToolCalls) && deltaToolCalls.length > 0) {
        sawToolCallDelta = true;
        assert.ok(typeof deltaToolCalls[0]?.index === 'number');
      }
      if (chunk.choices[0]?.finish_reason === 'tool_calls') {
        sawToolCallFinish = true;
      }
    }

    assert.ok(sawToolCallDelta);
    assert.ok(sawToolCallFinish);
    console.log('[SDK-TEST] ✅ Streaming tool calls are accepted by the OpenAI SDK.');

    const responseObject = await client.responses.create({
      model: responsesModel,
      input: 'Say hello from the responses API.',
    });

    const expectedHelloResponseText = getExpectedMockResponsesText('Say hello from the responses API.');
    const expectedPlainReasoning = getExpectedMockResponsesReasoning(false);
    const responseReasoningItems = Array.isArray(responseObject.output)
      ? responseObject.output.filter((item: any) => item?.type === 'reasoning')
      : [];

    assert.equal(responseObject.object, 'response');
    assert.equal(responseObject.status, 'completed');
    assert.equal(responseObject.output_text, expectedHelloResponseText);
    assert.ok(typeof responseObject.usage?.total_tokens === 'number');
    assert.equal(responseReasoningItems.length, 1);
    assert.equal(getReasoningSummaryText(responseReasoningItems[0]), expectedPlainReasoning);
    console.log('[SDK-TEST] ✅ Non-stream responses.create is accepted by the OpenAI SDK.');

    const streamingResponsesInput = 'Write a short haiku about APIs.';
    const expectedStreamedResponseText = getExpectedMockResponsesText(streamingResponsesInput);
    const expectedStreamedReasoning = getExpectedMockResponsesReasoning(false);
    const responseStream = await client.responses.create({
      model: responsesModel,
      input: streamingResponsesInput,
      stream: true,
    });

    let sawResponseCreated = false;
    let sawResponseCompleted = false;
    let streamedResponseText = '';
    let sawReasoningSummaryDelta = false;
    let sawReasoningSummaryDone = false;
    let streamedReasoningText = '';
    let completedResponseObject: any;

    for await (const event of responseStream as AsyncIterable<any>) {
      if (event?.type === 'response.created') {
        sawResponseCreated = true;
      }
      if (event?.type === 'response.reasoning_summary_text.delta' && typeof event?.delta === 'string') {
        sawReasoningSummaryDelta = true;
        streamedReasoningText += event.delta;
      }
      if (event?.type === 'response.reasoning_summary_text.done') {
        sawReasoningSummaryDone = true;
        if (typeof event?.text === 'string') {
          assert.equal(event.text, expectedStreamedReasoning);
        }
      }
      if (event?.type === 'response.output_text.delta' && typeof event?.delta === 'string') {
        streamedResponseText += event.delta;
      }
      if (event?.type === 'response.completed') {
        sawResponseCompleted = true;
        completedResponseObject = event.response;
        if (!streamedResponseText && typeof event?.response?.output_text === 'string') {
          streamedResponseText = event.response.output_text;
        }
      }
    }

    const completedResponseReasoningItems = Array.isArray(completedResponseObject?.output)
      ? completedResponseObject.output.filter((item: any) => item?.type === 'reasoning')
      : [];
    assert.ok(sawResponseCreated);
    assert.ok(sawResponseCompleted);
    assert.ok(sawReasoningSummaryDelta);
    assert.ok(sawReasoningSummaryDone);
    assert.equal(streamedReasoningText, expectedStreamedReasoning);
    assert.equal(streamedResponseText, expectedStreamedResponseText);
    assert.equal(completedResponseObject?.output_text, expectedStreamedResponseText);
    assert.equal(completedResponseReasoningItems.length, 1);
    assert.equal(getReasoningSummaryText(completedResponseReasoningItems[0]), expectedStreamedReasoning);
    console.log('[SDK-TEST] ✅ Streaming responses.create is accepted by the OpenAI SDK.');

    const responseToolObject = await client.responses.create({
      model: responsesModel,
      input: 'Call get_time for NYC.',
      tools: responseTools,
      tool_choice: 'auto',
    });

    const expectedToolReasoning = getExpectedMockResponsesReasoning(true);
    const responseAssistantMessages = Array.isArray(responseToolObject.output)
      ? responseToolObject.output.filter((item: any) => item?.type === 'message' && item?.role === 'assistant')
      : [];
    const responseToolReasoningItems = Array.isArray(responseToolObject.output)
      ? responseToolObject.output.filter((item: any) => item?.type === 'reasoning')
      : [];
    const responseFunctionCallItems = Array.isArray(responseToolObject.output)
      ? responseToolObject.output.filter((item: any) => item?.type === 'function_call')
      : [];
    assert.ok(responseAssistantMessages.length > 0);
    const assistantContent = (responseAssistantMessages[0] as any)?.content;
    assert.ok(Array.isArray(assistantContent));
    assert.ok(assistantContent.some((part: any) => part?.type === 'tool_calls'));
    assert.equal(responseToolObject.output_text, '');
    assert.equal(responseToolReasoningItems.length, 1);
    assert.equal(getReasoningSummaryText(responseToolReasoningItems[0]), expectedToolReasoning);
    assert.equal(responseFunctionCallItems.length, 1);
    console.log('[SDK-TEST] ✅ Non-stream responses.create tool calls include an assistant message.');

    const responseToolStream = await client.responses.create({
      model: responsesModel,
      input: 'Call get_time for NYC.',
      tools: responseTools,
      tool_choice: 'auto',
      stream: true,
    });

    let sawToolResponseCompleted = false;
    let sawAssistantMessageInCompletedResponse = false;
    let sawFunctionCallArgumentsDone = false;
    let streamedToolReasoningText = '';
    let streamedToolOutputText = '';
    let completedToolResponse: any;
    for await (const event of responseToolStream as AsyncIterable<any>) {
      if (event?.type === 'response.reasoning_summary_text.delta' && typeof event?.delta === 'string') {
        streamedToolReasoningText += event.delta;
      }
      if (event?.type === 'response.output_text.delta' && typeof event?.delta === 'string') {
        streamedToolOutputText += event.delta;
      }
      if (event?.type === 'response.function_call_arguments.done') {
        sawFunctionCallArgumentsDone = true;
      }
      if (event?.type === 'response.completed') {
        sawToolResponseCompleted = true;
        completedToolResponse = event.response;
        const output = Array.isArray(event?.response?.output) ? event.response.output : [];
        sawAssistantMessageInCompletedResponse = output.some((item: any) => item?.type === 'message' && item?.role === 'assistant');
      }
    }

    const completedToolOutput = Array.isArray(completedToolResponse?.output) ? completedToolResponse.output : [];
    const completedToolReasoningItems = completedToolOutput.filter((item: any) => item?.type === 'reasoning');
    const completedToolFunctionCalls = completedToolOutput.filter((item: any) => item?.type === 'function_call');
    const completedToolAssistantMessages = completedToolOutput.filter((item: any) => item?.type === 'message' && item?.role === 'assistant');
    assert.ok(sawToolResponseCompleted);
    assert.ok(sawAssistantMessageInCompletedResponse);
    assert.ok(sawFunctionCallArgumentsDone);
    assert.equal(streamedToolReasoningText, expectedToolReasoning);
    assert.equal(streamedToolOutputText, '');
    assert.equal(completedToolResponse?.output_text ?? '', '');
    assert.equal(completedToolReasoningItems.length, 1);
    assert.equal(getReasoningSummaryText(completedToolReasoningItems[0]), expectedToolReasoning);
    assert.equal(completedToolFunctionCalls.length, 1);
    assert.ok(completedToolAssistantMessages.length > 0);
    assert.ok(Array.isArray(completedToolAssistantMessages[0]?.content));
    assert.ok(completedToolAssistantMessages[0].content.some((part: any) => part?.type === 'tool_calls'));
    console.log('[SDK-TEST] ✅ Streaming responses.create tool calls include an assistant message in the completed response.');
  } finally {
    if (manageSetup) {
      restoreProviderConfig();
    }
  }
}

runSdkCompatibilityTest().catch((error) => {
  console.error('[SDK-TEST] ❌ OpenAI SDK compatibility test failed.');
  if (error instanceof Error) {
    console.error('[SDK-TEST]', error.message);
    if (error.stack) console.error(error.stack);
  } else {
    console.error('[SDK-TEST]', error);
  }
  process.exit(1);
});
