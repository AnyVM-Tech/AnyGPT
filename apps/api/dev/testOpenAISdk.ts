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
    return normalizeResponseText('Hi! What would you like help with?');
  }
  return `This is a mock responses reply to: "${userInput}".`;
}

function getExpectedMockResponsesReasoning(hasTools: boolean): string {
  return hasTools
    ? 'Selecting the best tool and preparing its arguments.'
    : 'Planning the response before generating the final answer.';
}

function isSdkResponseReasoningVisible(item: any): boolean {
  return item?.type === 'reasoning' || item?.type === 'reasoning_summary';
}

function extractSdkResponseReasoningText(responseObject: any): string | undefined {
  if (Array.isArray(responseObject?.output)) {
    const reasoningItem = responseObject.output.find((item: any) => isSdkResponseReasoningVisible(item));
    if (reasoningItem) {
      const summaryText = getReasoningSummaryText(reasoningItem);
      if (summaryText) return summaryText;
      if (typeof reasoningItem.text === 'string' && reasoningItem.text.trim()) {
        return reasoningItem.text;
      }
    }
  }

  const reasoningSummary = Array.isArray(responseObject?.reasoning)
    ? responseObject.reasoning
    : Array.isArray(responseObject?.reasoning_summary)
      ? responseObject.reasoning_summary
      : [];
  const firstSummaryText = reasoningSummary.find(
    (part: any) => typeof part?.text === 'string' && part.text.length > 0
  );
  return typeof firstSummaryText?.text === 'string' ? firstSummaryText.text : undefined;
}

function normalizeResponseText(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function collapseDuplicatedConcatenation(value: unknown): string {
  const normalized = normalizeResponseText(value);
  if (!normalized) return normalized;
  const midpoint = normalized.length / 2;
  if (Number.isInteger(midpoint)) {
    const firstHalf = normalized.slice(0, midpoint);
    const secondHalf = normalized.slice(midpoint);
    if (firstHalf === secondHalf) {
      return firstHalf;
    }
  }
  return normalized;
}

function getReasoningSummaryText(item: any): string | undefined {
  const summaryParts = Array.isArray(item?.summary) ? item.summary : [];
  const firstSummaryText = summaryParts.find((part: any) => typeof part?.text === 'string' && part.text.length > 0);
  return typeof firstSummaryText?.text === 'string' ? firstSummaryText.text : undefined;
}

type OpenAiRequestOptions = NonNullable<ConstructorParameters<typeof OpenAI>[0]>;

class NativeSdkTestClient {
  private readonly client: OpenAI;
  private readonly baseOptions: OpenAiRequestOptions;
  private readonly baseHeaders: Record<string, string>;

  constructor(baseOptions: OpenAiRequestOptions) {
    this.baseOptions = baseOptions;
    this.baseHeaders = { ...((baseOptions.defaultHeaders as Record<string, string> | undefined) || {}) };
    this.client = new OpenAI(baseOptions);
  }

  get chat() {
    return {
      completions: {
        create: async (body: Record<string, any>) => {
          const stream = body?.stream === true;
          const headers = stream
            ? { ...this.baseHeaders, Accept: 'text/event-stream' }
            : this.baseHeaders;
          const client = stream
            ? new OpenAI({ ...this.baseOptions, defaultHeaders: headers })
            : this.client;
          return client.chat.completions.create(body as any);
        },
      },
    };
  }

  get responses() {
    return this.client.responses;
  }
}

function createNativeClient(baseURL: string, providerKey?: string): NativeSdkTestClient {
  const headers: Record<string, string> = {};
  if (providerKey) {
    headers['x-mock-provider-id'] = providerKey;
  }
  return new NativeSdkTestClient({
    apiKey: providerKey || 'test-key-for-mock-provider',
    baseURL,
    defaultHeaders: headers,
  });
}

async function runNativeProviderHistoryRoutingTest(baseURL: string) {
  const nativeOpenAiBaseUrl = baseURL.replace(/\/v1$/, '/native/openai/v1');
  const nativeAutoBaseUrl = baseURL.replace(/\/v1$/, '/native/auto/v1');
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

  const nativeOpenAiClient = createNativeClient(nativeOpenAiBaseUrl, 'provider-a');
  const nativeAutoClient = createNativeClient(nativeAutoBaseUrl, 'provider-b');

  const initialResponse = await nativeOpenAiClient.responses.create({
    model: 'gpt-5.4',
    input: 'Call get_time for NYC.',
    reasoning: { effort: 'medium' },
    tools: responseTools,
    tool_choice: 'auto',
  });

  const initialFunctionCall = Array.isArray(initialResponse.output)
    ? initialResponse.output.find((item: any) => item?.type === 'function_call')
    : undefined;
  assert.ok(initialFunctionCall);

  const sameProviderContinuation = await nativeOpenAiClient.responses.create({
    model: 'gpt-5.4',
    previous_response_id: initialResponse.id,
    reasoning: { effort: 'medium' },
    tools: responseTools,
    input: [
      {
        type: 'function_call_output',
        call_id: (initialFunctionCall as any)?.call_id,
        output: JSON.stringify({ city: 'NYC', time: '10:00 AM' }),
      },
    ],
  });
  assert.equal(
    sameProviderContinuation.output_text,
    'Native upstream continuation stayed on the original provider.'
  );

  const crossProviderReplay = await nativeAutoClient.responses.create({
    model: 'gpt-5.4',
    previous_response_id: initialResponse.id,
    reasoning: { effort: 'medium' },
    input: [
      {
        type: 'function_call_output',
        call_id: (initialFunctionCall as any)?.call_id,
        output: JSON.stringify({ city: 'NYC', time: '10:00 AM' }),
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'Summarize the previous reasoning context in one sentence.' }],
      },
    ],
  });

  const crossProviderReasoningItems = Array.isArray(crossProviderReplay.output)
    ? crossProviderReplay.output.filter((item: any) => item?.type === 'reasoning')
    : [];
  assert.equal(
    crossProviderReplay.output_text,
    'The prior tool call reasoning and result were replayed successfully across providers.'
  );
  assert.ok(crossProviderReasoningItems.length >= 1);
}

async function runSdkCompatibilityTest() {
  const manageSetup = process.env.TEST_SETUP_MODE !== 'external';
  const usingManagedMockSetup = manageSetup;
  const isNativeStrictBase = /\/native\/openai(?:\/|$)/.test(resolveClientBaseUrl());
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

    if (isNativeStrictBase) {
      console.log('[SDK-TEST] Skipping streaming chat completion assertion for strict native/openai passthrough because it requires transport-level Accept negotiation that the SDK path does not preserve here.');
    } else {
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
    }

    if (usingManagedMockSetup) {
      const jsonCompletion = await client.chat.completions.create({
        model: responsesModel,
        messages: [{ role: 'user', content: 'Say hello from the JSON mode check.' }],
        response_format: { type: 'json_object' },
      });

      const jsonContent = jsonCompletion.choices[0]?.message?.content;
      assert.equal(typeof jsonContent, 'string');
      const parsedJson = JSON.parse(String(jsonContent));
      assert.ok(typeof parsedJson?.reply === 'string' && parsedJson.reply.length > 0);
      console.log('[SDK-TEST] ✅ GPT-5.4 chat response_format survives AnyGPT Responses translation.');
    } else {
      console.log('[SDK-TEST] Skipping mock-specific GPT-5.4 chat json_object assertion because test setup is external and may target a non-mock runtime.');
    }

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

    if (isNativeStrictBase) {
      console.log('[SDK-TEST] Skipping streaming tool-call chat assertion for strict native/openai passthrough because it requires transport-level Accept negotiation that the SDK path does not preserve here.');
    } else {
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
    }

    const responseObject = await client.responses.create({
      model: responsesModel,
      input: 'Say hello from the responses API.',
      reasoning: { effort: 'medium' },
    });

    const expectedHelloResponseText = getExpectedMockResponsesText('Say hello from the responses API.');
    const expectedPlainReasoning = getExpectedMockResponsesReasoning(false);
    const responseReasoningItems = Array.isArray(responseObject.output)
      ? responseObject.output.filter((item: any) => isSdkResponseReasoningVisible(item))
      : [];
    const responseReasoningText = extractSdkResponseReasoningText(responseObject);

    assert.equal(responseObject.object, 'response');
    assert.equal(responseObject.status, 'completed');
    assert.ok(normalizeResponseText(responseObject.output_text).length > 0);
    assert.ok(typeof responseObject.usage?.total_tokens === 'number');
    if (usingManagedMockSetup) {
      assert.ok(responseReasoningItems.length >= 1 || typeof responseReasoningText === 'string');
      assert.equal(responseReasoningText, expectedPlainReasoning);
    } else {
      console.log('[SDK-TEST] Skipping mock-specific non-stream reasoning assertion because test setup is external and may target a non-mock runtime.');
    }
    console.log('[SDK-TEST] ✅ Non-stream responses.create is accepted by the OpenAI SDK.');

    const streamingResponsesInput = 'Write a short haiku about APIs.';
    const expectedStreamedResponseText = getExpectedMockResponsesText(streamingResponsesInput);
    const expectedStreamedReasoning = getExpectedMockResponsesReasoning(false);
    const responseStream = await client.responses.create({
      model: responsesModel,
      input: streamingResponsesInput,
      reasoning: { effort: 'medium' },
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
          assert.equal(collapseDuplicatedConcatenation(event.text), expectedStreamedReasoning);
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
    if (usingManagedMockSetup) {
      assert.ok(sawReasoningSummaryDelta);
      assert.ok(sawReasoningSummaryDone);
      assert.equal(collapseDuplicatedConcatenation(streamedReasoningText), expectedStreamedReasoning);
    } else {
      console.log('[SDK-TEST] Skipping mock-specific streaming reasoning assertions because test setup is external and may target a non-mock runtime.');
    }
    if (usingManagedMockSetup) {
      assert.equal(streamedResponseText, expectedStreamedResponseText);
      assert.equal(completedResponseObject?.output_text, expectedStreamedResponseText);
    } else {
      assert.ok(normalizeResponseText(streamedResponseText).length > 0);
      assert.ok(normalizeResponseText(completedResponseObject?.output_text).length > 0);
    }
    if (usingManagedMockSetup) {
      assert.equal(completedResponseReasoningItems.length, 1);
      assert.equal(getReasoningSummaryText(completedResponseReasoningItems[0]), expectedStreamedReasoning);
    }
    console.log('[SDK-TEST] ✅ Streaming responses.create is accepted by the OpenAI SDK.');

    const responseToolObject = await client.responses.create({
      model: responsesModel,
      input: 'Call get_time for NYC.',
      reasoning: { effort: 'medium' },
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
    if (usingManagedMockSetup) {
      assert.equal(responseToolReasoningItems.length, 1);
      assert.equal(getReasoningSummaryText(responseToolReasoningItems[0]), expectedToolReasoning);
    } else {
      console.log('[SDK-TEST] Skipping mock-specific tool reasoning assertion because test setup is external and may target a non-mock runtime.');
    }
    assert.equal(responseFunctionCallItems.length, 1);
    console.log('[SDK-TEST] ✅ Non-stream responses.create tool calls include an assistant message.');

    if (usingManagedMockSetup) {
      const firstResponseFunctionCall = responseFunctionCallItems[0] as any;
      const continuedResponse = await client.responses.create({
        model: responsesModel,
        previous_response_id: responseToolObject.id,
        reasoning: { effort: 'medium' },
        tools: responseTools,
        input: [
          {
            type: 'function_call_output',
            call_id: firstResponseFunctionCall?.call_id,
            output: JSON.stringify({ city: 'NYC', time: '10:00 AM' }),
          },
        ],
      });

      const historyReplayProbe = await client.responses.create({
        model: responsesModel,
        previous_response_id: responseToolObject.id,
        reasoning: { effort: 'medium' },
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: 'Summarize the previous reasoning context in one sentence.' }],
          },
        ],
      });

      const continuedResponseFunctionCalls = Array.isArray(continuedResponse.output)
        ? continuedResponse.output.filter((item: any) => item?.type === 'function_call')
        : [];
      const continuedResponseReasoningItems = Array.isArray(continuedResponse.output)
        ? continuedResponse.output.filter((item: any) => item?.type === 'reasoning')
        : [];
      const historyReplayProbeReasoningItems = Array.isArray(historyReplayProbe.output)
        ? historyReplayProbe.output.filter((item: any) => item?.type === 'reasoning')
        : [];
      assert.equal(continuedResponse.output_text, 'The local time in NYC is 10:00 AM.');
      assert.equal(continuedResponseFunctionCalls.length, 0);
      assert.equal(continuedResponseReasoningItems.length, 1);
      assert.equal(
        getReasoningSummaryText(continuedResponseReasoningItems[0]),
        'Using the returned tool result to complete the answer.'
      );
      assert.equal(historyReplayProbeReasoningItems.length, 1);
      assert.equal(
        getReasoningSummaryText(historyReplayProbeReasoningItems[0]),
        expectedToolReasoning
      );
      console.log('[SDK-TEST] ✅ Responses previous_response_id retains prior reasoning items for continued turns.');
      console.log('[SDK-TEST] ✅ Responses previous_response_id carries reasoning items across tool turns.');
      await runNativeProviderHistoryRoutingTest(baseURL);
      console.log('[SDK-TEST] ✅ Native responses history survives provider switches and preserves same-provider continuation.');
    } else {
      console.log('[SDK-TEST] Skipping mock-specific previous_response_id reasoning replay assertions because test setup is external and may target a non-mock runtime.');
    }

    const responseToolStream = await client.responses.create({
      model: responsesModel,
      input: 'Call get_time for NYC.',
      reasoning: { effort: 'medium' },
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
    if (usingManagedMockSetup) {
      assert.equal(streamedToolReasoningText, expectedToolReasoning);
      assert.equal(completedToolReasoningItems.length, 1);
      assert.equal(getReasoningSummaryText(completedToolReasoningItems[0]), expectedToolReasoning);
    } else {
      assert.ok(streamedToolReasoningText.length > 0 || completedToolReasoningItems.length > 0);
      if (completedToolReasoningItems.length > 0) {
        assert.ok(typeof getReasoningSummaryText(completedToolReasoningItems[0]) === 'string');
      }
    }
    assert.equal(streamedToolOutputText, '');
    assert.equal(completedToolResponse?.output_text ?? '', '');
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
