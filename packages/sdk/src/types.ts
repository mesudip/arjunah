/**
 * Types for the अर्जुनः (Arjunah) page API, `window.ai.arjunah`.
 * Normative contract: SPEC.md in the repository.
 */

export interface Arjunah {
  readonly version: "1.0.0";
  /** True when this origin holds a grant at level 1 or 2. */
  isEnabled(): Promise<boolean>;
  /**
   * Asks the user for access (level 1 `completion` when the request is
   * omitted) and resolves to the session that carries the granted APIs.
   * Resolves without a prompt when the origin already holds the access.
   */
  enable(request?: AIAccessRequest): Promise<AISession>;
  /** Removes this origin's whole grant, including a hosted-chat grant. */
  disable(): Promise<true>;
  /**
   * Opens the extension's own view of this site (the toolbar popup, or the
   * settings page where the popup cannot be opened). Call it from a click or
   * key handler: without a user gesture it rejects with `PERMISSION_REQUIRED`.
   */
  openSettings(): Promise<true>;
  /** Level 0: publish the assistant contract. Needs no grant. */
  readonly site: {
    register(
      manifest: AISiteManifest,
    ): Promise<{ id: string; unregister(): Promise<boolean> }>;
  };
  readonly chat: {
    open(): Promise<true>;
    close(): Promise<true>;
    getControls(): Promise<AIControlValues>;
    setControls(values: AIControlValues): Promise<AIControlValues>;
  };
}

/** What `enable()` resolves to; its methods need the capabilities in the grant. */
export interface AISession {
  /** The grant as it stood when `enable()` resolved. */
  readonly grant: AIGrant;
  readonly permissions: {
    /** The origin's current grant, or null after `disable()`. */
    query(): Promise<AIGrant | null>;
  };
  /** Requires `models.catalog` (access level 2). */
  readonly providers: {
    list(): Promise<AIProvider[]>;
  };
  readonly models: {
    list(): Promise<AIModel[]>;
    /**
     * A one-off completion. Aborting `options.signal` rejects at once with
     * `ABORTED` and stops the provider request (SPEC 10). For a tool loop,
     * generate through a conversation instead.
     */
    generate(
      request: AIGenerateRequest,
      options?: AIGenerateOptions,
    ): Promise<AIGenerateResult>;
    /**
     * The same one-off completion, streamed (SPEC 5.3): the round's answer
     * and reasoning deltas as they arrive, then its result. Breaking out of
     * the loop cancels the round as aborting `options.signal` does.
     */
    stream(
      request: AIGenerateRequest,
      options?: AIGenerateOptions,
    ): AIRoundStream;
  };
  /** Requires `models.generate` (SPEC 5.4). */
  readonly conversations: {
    /** A new conversation the extension mints for this origin. */
    create(): Promise<AIConversation>;
    /**
     * A conversation this origin was given earlier, for example after a
     * reload. Rejects with `INVALID_REQUEST` for an id the extension did not
     * mint for this origin.
     */
    open(id: string): Promise<AIConversation>;
  };
  readonly context: {
    get(request: {
      fields: AIContextField[];
    }): Promise<Partial<Record<AIContextField, string>>>;
  };
}

/** Access levels are named capability bundles (SPEC section 4). */
export type AIAccessLevel = "assistant" | "completion" | "catalog";
export type AICapability =
  | "models.list"
  | "models.generate"
  | "models.catalog"
  | "context.read"
  | "chat.hosted"
  | "tools.site"
  | "tools.mcp";
export type AIContextField = "title" | "url" | "selection" | "text";
export type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONValue[]
  | { [key: string]: JSONValue };

export interface AIAccessRequest {
  /** `completion` (level 1, the default) or `catalog` (level 2); expands to capabilities. */
  level?: "completion" | "catalog";
  capabilities?: AICapability[];
  context?: AIContextField[];
  reason?: string;
  /**
   * Which of the visitor's models may answer this site (SPEC 4). Consent
   * offers only models that qualify; `{}` removes an earlier constraint.
   */
  require?: AIModelRequirement;
  /**
   * Who writes this page's level 1 or 2 prompts (SPEC 15.3): `"webapp"`, the
   * default, or `"server"` when the site's backend composes them through the
   * page. It changes only what consent says, grants nothing, and a different
   * value than the grant holds asks the visitor again.
   */
  composer?: AIComposer;
}
/** Who composes a site's rounds (SPEC 15); the extension is never named. */
export type AIComposer = "webapp" | "server";
/** Every member present must hold for a model to qualify. */
export interface AIModelRequirement {
  /** The provider kinds accepted. */
  kinds?: AIProviderKind[];
  /** Only models that keep prompts on the visitor's computer or network. */
  local?: true;
  /** Only models whose answering agent runs no tools of its own. */
  builtinTools?: false;
}
export type AIProviderKind = "api-key" | "subscription" | "self-hosted";
/** `detail` of the `arjunah:grantchange` window event (SPEC 3). */
export interface AIGrantChange {
  /** The level now held, or null when the grant is gone. */
  level: AIAccessLevel | null;
  /** The site model now answering, or null. */
  model: string | null;
  revoked: boolean;
}
export interface AIGrant {
  origin: string;
  level: AIAccessLevel;
  capabilities: AICapability[];
  context: AIContextField[];
  /** The model the user chose for this site; null without model access. */
  model: string | null;
  grantedAt: string;
}
export interface AIProvider {
  id: string;
  name: string;
  /** Null when the extension cannot know it (a custom address, a self-hosted server, OpenCode). */
  vendor: string | null;
  kind: AIProviderKind;
  models: string[];
}
/** Where a model runs, on every model entry and generate result (SPEC 5.2). */
export interface AIModelTraits {
  kind: AIProviderKind;
  /** True only for a model running on the visitor's own computer or network. */
  local: boolean;
  /** True when the answering agent can run tools of its own (Codex today). */
  builtinTools: boolean;
}
export interface AIModelCapabilities {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  [flag: string]: boolean;
}
export type AIReasoningEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export interface AIModel extends AIModelTraits {
  /** Opaque `<provider-id>/<model>` identifier. */
  id: string;
  provider: string;
  displayName: string;
  /** True for the model the user selected for this site. */
  default: boolean;
  capabilities: AIModelCapabilities;
  /** Context size in tokens when the provider reports it. */
  contextWindow: number | null;
  /** Effort names the model accepts; empty when thinking cannot be steered. */
  reasoningLevels: AIReasoningEffort[];
  /** The `models.generate` bounds this model is held to (SPEC 5.3). */
  limits: AIModelLimits;
}
/**
 * Exactly what the extension enforces on a `models.generate` request for one
 * model. `Units` are UTF-16 code units (JavaScript string length), `Bytes`
 * UTF-8 bytes.
 */
export interface AIModelLimits {
  /** Messages per request. */
  messages: number;
  /** Text of one message: a string `content`, or its text parts together. */
  messageUnits: number;
  /** Tool definitions per request. */
  tools: number;
  toolDescriptionUnits: number;
  /** `toolCalls` on one assistant message. */
  toolCallsPerMessage: number;
  /** One tool call's `function.arguments`. */
  toolArgumentUnits: number;
  /** One tool's `inputSchema` serialized as JSON. */
  schemaBytes: number;
  /** Schema nesting below the root (SPEC 7.1). */
  schemaDepth: number;
  /** The serialized request as a whole. */
  requestBytes: number;
  /** Largest accepted `maxTokens`. */
  maxTokens: number;
  /** How long the page API waits for the answer. */
  timeoutMs: number;
}
export type AIImageMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif";
export interface AIImagePart {
  type: "image";
  mediaType: AIImageMediaType;
  /** Base64 payload, at most 2,000,000 characters. */
  data: string;
}
export interface AITextPart {
  type: "text";
  text: string;
}
export type AIContentPart = AITextPart | AIImagePart;
export interface AIMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** Parts (with images) are accepted for user messages only. */
  content: string | AIContentPart[];
  name?: string;
  toolCallId?: string;
  toolCalls?: AIWireToolCall[];
}
export interface AIWireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export type AIJSONSchemaType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null";
/** Supported bounded schema subset; unsupported assertion keywords are rejected. */
export interface AIJSONSchema {
  /** A list of distinct names is read as an `anyOf` of single types. */
  type?: AIJSONSchemaType | AIJSONSchemaType[];
  properties?: Record<string, AIJSONSchema>;
  required?: string[];
  additionalProperties?: boolean | AIJSONSchema;
  items?: AIJSONSchema;
  enum?: JSONValue[];
  const?: JSONValue;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  anyOf?: AIJSONSchema[];
  oneOf?: AIJSONSchema[];
  allOf?: AIJSONSchema[];
  title?: string;
  description?: string;
  default?: JSONValue;
  examples?: JSONValue[];
  $schema?: string;
  $comment?: string;
  /** Annotations only: never enforced and not sent to providers. */
  format?: string;
  contentMediaType?: string;
  contentEncoding?: string;
  readOnly?: boolean;
  writeOnly?: boolean;
  deprecated?: boolean;
}
export interface AIToolDefinition {
  name: string;
  description?: string;
  inputSchema?: AIJSONSchema & { type?: "object" };
}
export type AIToolOutputKind = "text" | "image" | "card";
export interface AICardPart {
  type: "card";
  card: AICard;
}
export interface AISiteToolContentResult {
  kind: "content";
  /** Images and cards require a text fallback; the model sees only the text. */
  content: Array<AITextPart | AIImagePart | AICardPart>;
}

/**
 * Transcript cards (SPEC 7.4): bounded site-authored UI drawn inside the
 * hosted chat. No HTML, Markdown, links or images; at most 200 nodes, 6 levels,
 * 16 buttons and 16 form fields, within the 64 KiB tool-result limit.
 */
export interface AICard {
  type: "card";
  /** Lowercase identifier used to update this card in place. */
  id?: string;
  title?: string;
  children: AICardNode[];
}
export type AICardNode =
  | { type: "text"; text: string; style?: "body" | "muted" | "heading" }
  | { type: "list"; items: AICardListItem[] }
  | {
      type: "button";
      label: string;
      action: AICardAction;
      style?: "primary" | "secondary" | "danger";
    }
  | {
      type: "form";
      id: string;
      submitLabel?: string;
      action: AICardAction;
      fields: AICardField[];
    };
export interface AICardListItem {
  title: string;
  description?: string;
  action?: AICardAction;
}
export type AICardField =
  | {
      type: "input";
      id: string;
      label: string;
      placeholder?: string;
      required?: boolean;
      default?: string;
    }
  | {
      type: "select";
      id: string;
      label: string;
      options: Array<{ value: string; label?: string }>;
      default?: string;
    }
  | { type: "checkbox"; id: string; label: string; default?: boolean };
/**
 * A `message` action sends its exact text as a visible user turn, so the model
 * never receives something the user did not see. A `local` action reaches only
 * `onCardAction` and never becomes a model message or a tool argument.
 */
export type AICardAction =
  | { type: "message"; text: string }
  | { type: "local"; name: string; payload?: JSONValue };
export interface AICardActionEvent {
  /** The card the action came from, when it declared an id. */
  cardId: string | null;
  name: string;
  payload?: JSONValue;
  /** Validated field values when the action came from a form. */
  values: Record<string, string | boolean> | null;
}
export interface AIToolUserInput {
  /** Lowercase identifier that is deliberately absent from the model schema. */
  id: string;
  label: string;
  description?: string;
  /** Scalar schema validated by the extension before resolving requestInput(). */
  schema: AIJSONSchema & {
    type: "string" | "number" | "integer" | "boolean";
  };
  /** Render a masked input and avoid browser autofill/history. */
  secret?: boolean;
}
export type AIControlValues = Record<string, boolean | string>;
export interface AISiteTool extends AIToolDefinition {
  /** Rich result kinds this tool may return; omitted for legacy JSON results. */
  outputContent?: AIToolOutputKind[];
  /** Inputs collected by extension UI and never included in a provider request. */
  userInputs?: AIToolUserInput[];
  /**
   * The visitor approves each call in the extension's prompt before the
   * handler runs (SPEC 7.8); a denial reaches the model as a tool error.
   */
  requiresApproval?: boolean;
  handler(
    args: Record<string, JSONValue>,
    invocation: {
      id: string;
      name: string;
      controls: AIControlValues;
      requestInput(id: string): Promise<JSONValue>;
      /**
       * Ephemeral status for a slow tool (SPEC 7.5): at most 200 characters,
       * 50 reports per invocation. Never enters model messages, chat history
       * or a stored transcript.
       */
      reportProgress(text: string): void;
    },
  ):
    | JSONValue
    | AISiteToolContentResult
    | Promise<JSONValue | AISiteToolContentResult>;
}
export interface AIMcpServer {
  id: string;
  name?: string;
  url: string;
  headers?: Record<string, string>;
  /**
   * Declared tools (SPEC 7.7). When present the extension never calls
   * `tools/list` for this server, the definitions join the fingerprinted
   * contract, and consent is single-stage like site tools. This is how a site
   * runs first-party tools on its own backend without the page holding the
   * secret; `tools/call` carries the conversation id in `params._meta`.
   */
  tools?: AIDeclaredRemoteTool[];
}
/** A declared remote tool (SPEC 7.7, 7.8). */
export interface AIDeclaredRemoteTool extends AIToolDefinition {
  /**
   * Collected by the extension before the call and sent only to this server
   * in `params._meta.arjunah.inputs`, keyed by id; never in `arguments`.
   */
  userInputs?: AIToolUserInput[];
  /** The visitor approves each call before it is sent. */
  requiresApproval?: boolean;
}
/** What `loop.fetch` receives for one section 14.4 route (SPEC 15.1). */
export interface AILoopFetchInit {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  headers: Record<string, string>;
  /** JSON text, for POST and PATCH. */
  body?: string;
  /** Aborted when the extension stops reading or the turn ends. */
  signal: AbortSignal;
}
/**
 * A hosted external loop (SPEC 15.1): the extension hosts the panel and
 * answers `model.client` from the visitor's model, while this page function
 * answers the section 14 routes, from page code (`"webapp"`, mode 3) or by
 * forwarding them to the site's server (`"server"`, mode 2). The extension
 * never contacts the server itself.
 */
export interface AISiteLoop {
  composer: AIComposer;
  /** A relative section 14.4 path, as `fetch` takes a URL; resolve a `Response`. */
  fetch(path: string, init: AILoopFetchInit): Promise<Response>;
  /** The grant the first message asks for: 1 (default) or 2. */
  level?: 1 | 2;
}
/** One of the site's own models (SPEC 15.2); only what is given is shown. */
export interface AISiteModelEntry {
  /** `^[A-Za-z0-9_.:-]{1,100}$`, unique in the list. */
  id: string;
  /** Defaults to the site's name. */
  displayName?: string;
  /** `tools` defaults to true and `vision` to false. */
  capabilities?: Partial<AIModelCapabilities>;
  contextWindow?: number;
  reasoningLevels?: AIReasoningEffort[];
}
/** What the site's `generate` resolves to: a section 5.3 result, loosely. */
export interface AISiteModelResult {
  id?: string;
  message: {
    content?: string | null;
    /** Only to tools the round offered, or the round fails. */
    toolCalls?: Array<{ id: string; name: string; arguments: string }>;
    attachments?: AIImagePart[];
    reasoning?: string | null;
  };
  finishReason?: string;
  /** Omit it and the panel shows no usage for the round. */
  usage?: Partial<AIGenerateResult["usage"]>;
}
/** The site's own models (SPEC 15.2), listed in the picker beside the visitor's. */
export interface AISiteModels {
  /** 1 to 8 entries. */
  list: AISiteModelEntry[];
  /**
   * Answers a round the extension composed (mode 1). Required without a
   * `loop` and absent with one, because a loop answers its own models.
   */
  generate?(
    request: AIGenerateRequest,
    options: { signal: AbortSignal },
  ): Promise<AISiteModelResult>;
}

/** One conversation the site stores on the assistant's behalf (SPEC 7.6). */
export interface AIThreadSummary {
  id: string;
  title: string;
  /** ISO-8601. */
  updatedAt: string;
}
export type AITranscriptEntry =
  | {
      type: "message";
      id: string;
      role: "user" | "assistant";
      content: string | Array<AITextPart | AIImagePart>;
      reasoning?: string;
      createdAt: string;
    }
  | {
      type: "activity";
      id: string;
      turnId: string;
      steps: AITranscriptStep[];
    };
export interface AITranscriptStep {
  id: string;
  name: string;
  source: "site" | "mcp" | "backend" | "agent";
  status: "ok" | "error";
  /** Bounded previews, at most 2,000 characters each. */
  arguments?: string;
  result?: string;
  card?: AICard;
}
/**
 * Local functions that make the site the owner of its conversations. Declaring
 * them is part of the fingerprinted contract and consent says the site stores
 * the conversation; loaded messages reach the model marked as untrusted.
 */
export interface AIThreadStore {
  list(): Promise<AIThreadSummary[]>;
  create(): Promise<AIThreadSummary>;
  load(id: string): Promise<AITranscriptEntry[]>;
  append(id: string, entries: AITranscriptEntry[]): Promise<void>;
  rename?(id: string, title: string): Promise<void>;
  delete(id: string): Promise<void>;
}
/** A user-facing option in the hosted widget's Options drawer (SPEC 7.2). */
export type AIWidgetControl =
  | {
      id: string;
      type: "toggle";
      label: string;
      description?: string;
      default?: boolean;
      /** Disclose the value to the model (default true). */
      model?: boolean;
    }
  | {
      id: string;
      type: "select";
      label: string;
      description?: string;
      options: Array<{ value: string; label?: string }>;
      default?: string;
      model?: boolean;
    }
  | {
      id: string;
      type: "button";
      label: string;
      description?: string;
    };
export interface AIWidgetOptions {
  autoShow?: boolean;
  /** Tool activity presentation. Details remain user-expandable in both modes. */
  toolCallView?: "compact" | "detailed";
  greeting?: string;
  placeholder?: string;
  suggestions?: string[];
  theme?: { accent?: string; mode?: "light" | "dark" | "auto" };
  controls?: AIWidgetControl[];
}
export interface AISiteManifest {
  name: string;
  description?: string;
  systemPrompt?: string;
  widget?: AIWidgetOptions;
  tools?: AISiteTool[];
  mcpServers?: AIMcpServer[];
  /** Conversations stored by the site instead of the extension (SPEC 7.6). */
  threads?: AIThreadStore;
  /** A loop outside the extension composes the conversation (SPEC 15.1). Exclusive with `systemPrompt`; `mcpServers` is ignored with it. */
  loop?: AISiteLoop;
  /** The site's own models beside the visitor's (SPEC 15.2). */
  models?: AISiteModels;
  onControlChange?(
    id: string,
    value: boolean | string,
    values: AIControlValues,
  ): void;
  /**
   * A card's `local` action (SPEC 7.4). Returning a card replaces the one the
   * action came from; anything else leaves it unchanged. The model is not
   * involved either way.
   */
  onCardAction?(
    event: AICardActionEvent,
  ): AICard | void | Promise<AICard | void>;
}
export interface AIGenerateOptions {
  /** Aborts the call; the promise rejects with code `ABORTED`. */
  signal?: AbortSignal;
}
export interface AIGenerateRequest {
  messages: AIMessage[];
  /** A model id from `models.list()`, or "default" for the site model. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: AIToolDefinition[];
  /** How the model may use `tools`; absent means the provider's default (SPEC 5.3). */
  toolChoice?: AIToolChoice;
  reasoning?: AIReasoningEffort | { effort: AIReasoningEffort };
}
/**
 * `{ name }` must name one of the request's tools. Only `"auto"` reaches
 * Ollama and desktop agents; anything else is `NOT_SUPPORTED` there.
 */
export type AIToolChoice = "auto" | "none" | "required" | { name: string };
/**
 * One conversation (SPEC 5.4), minted by the extension for this origin. Its
 * rounds get back the provider state their tool steps need (signed thinking,
 * thought signatures, encrypted reasoning), which the page never sees.
 */
export interface AIConversation {
  /** Opaque. Store it beside your thread to `open()` it again later. */
  readonly id: string;
  /** `models.generate` within this conversation. */
  generate(
    request: AIGenerateRequest,
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResult>;
  /** `models.stream` within this conversation (SPEC 5.3). */
  stream(
    request: AIGenerateRequest,
    options?: AIGenerateOptions,
  ): AIRoundStream;
  /** Ends the conversation and deletes what the extension kept for it. */
  release(): Promise<true>;
}
/**
 * One event of a streamed round (SPEC 5.3). Deltas are provisional and
 * bounded by the result's own answer and reasoning bounds; tool calls arrive
 * only in the result. `stalled` says the provider has been silent for 20
 * seconds and is still being waited on; it repeats while the silence lasts.
 * `result` comes last and is exactly what `generate` resolves to for the same
 * request: it is authoritative over the deltas.
 */
export type AIRoundEvent =
  | { type: "output.delta"; text: string }
  | { type: "reasoning.delta"; text: string }
  | { type: "stalled" }
  | { type: "result"; result: AIGenerateResult };
/**
 * A streamed round: iterate it with `for await`. A failure rejects `next()`
 * with the `AIError` generate would reject with; `return()` (leaving the loop
 * early) cancels the round.
 */
export interface AIRoundStream extends AsyncIterableIterator<AIRoundEvent> {
  return(): Promise<IteratorReturnResult<undefined>>;
}
export interface AIGenerateResult extends AIModelTraits {
  id: string;
  model: string;
  message: {
    role: "assistant";
    content: string;
    toolCalls: Array<{ id: string; name: string; arguments: string }>;
    attachments: AIImagePart[];
    reasoning: string | null;
  };
  finishReason: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
    reasoningTokens: number;
  };
  contextWindow: number | null;
  /**
   * Whether the extension reattached provider state it kept from an earlier
   * round of this turn (SPEC 5.4). The state itself is never in a result.
   */
  providerState: "reused" | "none";
}

/**
 * Error codes a rejected page API promise carries (SPEC section 9). The list
 * may grow: treat a code you do not know as `INTERNAL_ERROR`.
 */
export type AIErrorCode =
  | "INVALID_REQUEST"
  | "NOT_SUPPORTED"
  | "NOT_CONFIGURED"
  | "PERMISSION_REQUIRED"
  | "USER_DENIED"
  | "PROVIDER_ERROR"
  | "TOOL_ERROR"
  | "TIMEOUT"
  | "INTERNAL_ERROR"
  | "ABORTED"
  | "CONTEXT_TOO_LONG"
  | "RATE_LIMITED"
  | "MODEL_UNAVAILABLE";
/** `details` on every error the extension rejects with (SPEC section 9). */
export interface AIErrorDetails {
  /** The page bridge id of the request, also in the extension's log. */
  requestId?: string | null;
  /** True when sending the same request again later may succeed unchanged. */
  retryable?: boolean;
  /** With `RATE_LIMITED`, when the provider said how long to wait. */
  retryAfterMs?: number;
  /** With `INVALID_REQUEST`, the field that was refused. */
  field?: string;
  /** With `PERMISSION_REQUIRED`, the capabilities the grant lacks. */
  capabilities?: AICapability[];
  [member: string]: JSONValue | undefined;
}
