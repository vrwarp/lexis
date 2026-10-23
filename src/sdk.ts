import { query, type Options, type Query, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';

export interface QueryParams {
  prompt: Parameters<typeof query>[0]['prompt'];
  options?: Options;
}

/** What the app hands a query besides the SDK's own parameters: the in-process lexis tools. */
export interface QueryContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: SdkMcpToolDefinition<any>[];
}

export type QueryFn = (params: QueryParams, context: QueryContext) => Query;

/**
 * The one door to the Agent SDK. Tests swap `sdk.query` for a scripted fake
 * that plays back SDK messages and calls the lexis tools directly, so the
 * whole app runs without Claude Code or a credential.
 */
export const sdk: { query: QueryFn } = {
  query: (params) => query(params),
};
