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

export interface BackendOptions {
  /** Same-origin or HTTPS. Routes in SPEC 14.4 are resolved against it. */
  baseUrl: string;
  headers?: Record<string, string>;
  credentials?: RequestCredentials;
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
  /** Replace the catalog, for example once the site has loaded it. */
  setModels(models: ModelOption[], selected?: string): string | null;
  destroy(): void;
}

export function mountAssistant(config: MountConfig): MountedAssistant;
export function validateCard(card: unknown, name?: string): unknown;
export const ArjunahRenderer: unknown;
export const PROTOCOL_VERSION: string;
