/**
 * Types for the अर्जुनः standalone widget (SPEC section 14).
 * The normative contract is SPEC.md in the repository.
 */

export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };

export interface WidgetTheme {
  accent?: string;
  mode?: "light" | "dark" | "auto";
}

export interface WidgetControl {
  id: string;
  type: "toggle" | "select" | "button";
  label: string;
  description?: string;
  default?: boolean | string;
  options?: Array<{ value: string; label?: string }>;
}

/** A section 5.2 model entry. The picker that draws it is the renderer's. */
export interface ModelOption {
  id: string;
  /** Group heading in the menu; `providerName` is accepted as an alias. */
  provider?: string;
  providerName?: string;
  displayName?: string;
  contextWindow?: number | null;
  reasoningLevels?: string[];
  /** Named in the "Thinking: default (…)" option when the level is unset. */
  defaultReasoning?: string | null;
  default?: boolean;
}

/** Something the visitor can mention with `@` (SPEC 8.3). */
export interface Entity {
  id: string;
  title: string;
  group?: string;
  description?: string;
}

export interface EntitiesConfig {
  /** Omit to let the widget call `GET entities?q=` on the backend instead. */
  search?(query: string): Entity[] | Promise<Entity[]>;
  /** A click on a transcript chip. Omit and chips stay inert. */
  onActivate?(entity: Entity): void;
}

export interface WidgetOptions {
  name?: string;
  subtitle?: string;
  greeting?: string;
  placeholder?: string;
  suggestions?: string[];
  theme?: WidgetTheme;
  toolCallView?: "compact" | "detailed";
  controls?: WidgetControl[];
  /** Non-empty shows the model picker; each turn then carries the choice. */
  models?: ModelOption[];
  defaultModel?: string;
}

/** A server answers the SPEC 14.4 routes. */
export interface ServerBackendOptions {
  /** Same-origin or HTTPS. Routes in SPEC 14.4 are resolved against it. */
  baseUrl: string;
  headers?: Record<string, string>;
  credentials?: RequestCredentials;
  fetch?: never;
}

/** What the widget passes to `backend.fetch`. */
export interface PageBackendInit {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** `{ "Content-Type": "application/json" }` when there is a body. */
  headers: Record<string, string>;
  /** A JSON string, on routes that carry one. */
  body?: string;
  /** Present on the turn POST; aborted when the visitor stops the turn. */
  signal?: AbortSignal;
}

/**
 * The page answers the SPEC 14.4 routes itself (SPEC 14.1, SPEC 15 mode 5),
 * and the widget makes no network request. `path` is relative to the routes,
 * such as `"threads"` or `"threads/t1/turns/u1/tool-results"`. Non-2xx is a
 * rejection; a turn answers with a `text/event-stream` body (see
 * `eventStreamResponse`). Every SPEC 14.6 bound applies to the answer: a
 * stream read incrementally up to 2,000,000 bytes, JSON up to 1,000,000,
 * body chunks that must be bytes, and malformed data rejected.
 */
export interface PageBackendOptions {
  fetch(path: string, init: PageBackendInit): Promise<Response> | Response;
  baseUrl?: never;
  headers?: never;
  credentials?: never;
}

/** Exactly one of `baseUrl` and `fetch`. */
export type BackendOptions = ServerBackendOptions | PageBackendOptions;

/** One SPEC 14.3 event: `type` is the SSE event name, the rest its data. */
export interface TurnStreamEvent {
  type: string;
  [field: string]: unknown;
}

/** A value the model must not supply or see (SPEC 7.3). */
export interface ToolUserInput {
  id: string;
  label: string;
  description?: string;
  schema: {
    type: "string" | "number" | "integer" | "boolean";
    enum?: JSONValue[];
    const?: JSONValue;
    minimum?: number;
    maximum?: number;
    minLength?: number;
    maxLength?: number;
  };
  /** Masked, non-autofill control. Strings without `enum`/`const` only. */
  secret?: boolean;
}

export interface ClientToolInvocation {
  id: string;
  name: string;
  controls: Record<string, boolean | string>;
  /** Ephemeral status shown under this tool's step; never model input. */
  reportProgress(text: string): void;
  /** Prompt for one declared `userInputs` value, at most four per call. */
  requestInput(id: string): Promise<JSONValue>;
}

export interface ClientTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** Declared apart from `inputSchema`, so the model cannot fill them. */
  userInputs?: ToolUserInput[];
  handler(
    args: Record<string, JSONValue>,
    invocation: ClientToolInvocation,
  ): unknown;
}

/** A section 5.3 request, as the backend composed it. Passed on unchanged. */
export type GenerateRequest = Record<string, JSONValue>;
/** A section 5.3 result. */
export type GenerateResult = Record<string, JSONValue>;

/** What `enable()` is asked for in bridged mode (SPEC section 4). */
export interface BridgeAccessRequest {
  level?: "completion" | "catalog";
  context?: Array<"title" | "url" | "selection" | "text">;
  reason?: string;
  /**
   * Who writes the prompts, for the extension's consent wording. Defaults to
   * "server" with `backend.baseUrl` and "webapp" with `backend.fetch`; pass
   * "server" when that function forwards to your server.
   */
  composer?: "server" | "webapp";
}

/**
 * Bridged mode (SPEC 14.7): the backend runs the loop and the page answers
 * each `model.client` completion. With `arjunah` the widget holds a level 1
 * or 2 session on the visitor's extension, asked for on the first send;
 * `generate` answers completions some other way and wins when both are given.
 */
export interface BridgeOptions {
  arjunah?: true | BridgeAccessRequest;
  generate?(
    request: GenerateRequest,
    options: { signal: AbortSignal },
  ): Promise<GenerateResult>;
}

export interface TurnEvent {
  threadId: string | null;
  turnId: string | null;
}

export interface TurnEndEvent extends TurnEvent {
  usage: Record<string, number> | null;
}

export interface MountConfig {
  /** The element the widget's shadow root is attached to. */
  mount: Element;
  backend: BackendOptions;
  widget?: WidgetOptions;
  /** Tools the backend may ask the page to run (`tool.client`, SPEC 14.3). */
  tools?: ClientTool[];
  /** Present enables `@` mentions in the composer (SPEC 8.3). */
  entities?: EntitiesConfig;
  /** Relay the backend's completions through the page (SPEC 14.7). */
  bridge?: BridgeOptions;
  /** Show the image attach control. Default false. */
  vision?: boolean;
  /** Set false when the backend has no PATCH route for thread titles. */
  allowRename?: boolean;
  onClose?(): void;
  onControlChange?(
    id: string,
    value: boolean | string,
    values: Record<string, boolean | string>,
  ): void;
  onModelChange?(selection: {
    model: string | null;
    reasoning: string | null;
  }): void;
  onThreadChange?(event: { threadId: string | null }): void;
  onTurnStart?(event: TurnEvent): void;
  onTurnEnd?(event: TurnEndEvent): void;
  onError?(error: { code: string; message: string }): void;
}

export interface MountedAssistant {
  readonly panel: HTMLElement;
  readonly view: unknown;
  open(): void;
  close(): void;
  /** Restore the conversation the visitor last had. */
  openThread(id: string): Promise<void>;
  newThread(): Promise<{ id: string; title: string; updatedAt: string } | null>;
  getControls(): Record<string, boolean | string>;
  setControls(
    values: Record<string, boolean | string>,
  ): Record<string, boolean | string>;
  /**
   * Replace the catalog, for example once the site has loaded it. Ignored
   * with `bridge.arjunah`, where the catalog is the visitor's.
   */
  setModels(models: ModelOption[], selected?: string): string | null;
  /** Aborts the running turn, its relayed completions and open prompts. */
  destroy(): void;
}

export function mountAssistant(config: MountConfig): MountedAssistant;
/**
 * A `text/event-stream` `Response` for `backend.fetch`, one SSE event per
 * item. Pulled one event at a time; the iterator's `return()` runs when the
 * widget stops reading.
 */
export function eventStreamResponse(
  events: AsyncIterable<TurnStreamEvent> | Iterable<TurnStreamEvent>,
): Response;
export function validateCard(card: unknown, name?: string): unknown;
export const ArjunahRenderer: unknown;
export const PROTOCOL_VERSION: string;
