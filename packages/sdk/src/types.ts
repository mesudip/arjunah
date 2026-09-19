/**
 * Types for the अर्जुनः (Arjunah) page API, `window.ai.arjunah`.
 * Normative contract: SPEC.md in the repository.
 */

export interface Arjunah {
  readonly version: "1.2.0";
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
    generate(request: AIGenerateRequest): Promise<AIGenerateResult>;
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
  vendor: string;
  kind: "api-key" | "subscription";
  models: string[];
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
export interface AIModel {
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
/** Supported bounded schema subset; unsupported assertion keywords are rejected. */
export interface AIJSONSchema {
  type?:
    | "object"
    | "array"
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "null";
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
  tools?: AIToolDefinition[];
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
export interface AIGenerateRequest {
  messages: AIMessage[];
  /** A model id from `models.list()`, or "default" for the site model. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: AIToolDefinition[];
  reasoning?: AIReasoningEffort | { effort: AIReasoningEffort };
}
export interface AIGenerateResult {
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
}

/** Error codes a rejected page API promise carries (SPEC section 9). */
export type AIErrorCode =
  | "INVALID_REQUEST"
  | "NOT_SUPPORTED"
  | "NOT_CONFIGURED"
  | "PERMISSION_REQUIRED"
  | "USER_DENIED"
  | "PROVIDER_ERROR"
  | "TOOL_ERROR"
  | "TIMEOUT"
  | "INTERNAL_ERROR";
