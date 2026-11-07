export type Protocol = 'native' | 'walkplay' | 'register' | 'legacy' | 'conexant';
export type FilterType = 'PK' | 'LSQ' | 'HSQ';
export type ErrorCode = 'UNSUPPORTED_ENVIRONMENT' | 'INSECURE_CONTEXT' | 'UNSUPPORTED_DEVICE' |
  'EXPERIMENTAL_DEVICE' | 'NOT_CONNECTED' | 'BUSY' | 'INVALID_CONFIG' | 'UNSUPPORTED_READ' |
  'UNSUPPORTED_OPERATION' | 'INCOMPLETE_READ' | 'CONNECTION_FAILED' | 'IO_ERROR' | 'DEVICE_DISCONNECTED' |
  'ABORTED' | 'TIMEOUT' | 'VERIFICATION_FAILED';

export class HidError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;
  constructor(code: ErrorCode, message: string, options?: { cause?: unknown; details?: unknown });
}

export interface EqFilter {
  type: FilterType;
  /** Integer frequency in Hz, 20–20000 for enabled bands. */
  freq: number;
  gain: number;
  q: number;
  disabled?: boolean;
}

export interface EqConfigInput {
  readonly filters: readonly EqFilter[];
  /** -128..127 dB. Device-managed pregain is not applied a second time. */
  readonly globalGain?: number;
}

export interface EqConfig {
  filters: EqFilter[];
  globalGain: number;
  slot: number;
  complete: true;
}

export interface Slot {
  readonly id: number;
  readonly name: string;
}

export interface Limits {
  readonly maxFilters: number;
  readonly minGain: number;
  readonly maxGain: number;
  readonly minQ: number;
  readonly maxQ: number;
  readonly filterTypes: readonly FilterType[];
  readonly deviceHandlesPregain: boolean;
  readonly supportsManualGlobalGain: boolean;
}

export interface SettingValues {
  micGain: number;
  denoise: boolean;
  dacFilter: 'FAST-LL' | 'FAST-PC' | 'SLOW-LL' | 'SLOW-PC' | 'NON-OS';
  dacBalance: { left: number; right: number };
  dacWorkMode: number;
  gainMode: boolean;
  battery: number;
  eqEnabled: boolean;
  outputGain: number;
}

export type SettingName = keyof SettingValues;
export type ReadableSetting = Exclude<SettingName, 'dacBalance' | 'outputGain'>;
export type WritableSetting = Exclude<SettingName, 'battery'>;

export interface SettingCapability {
  readonly readable: boolean;
  readonly writable: boolean;
  readonly options?: readonly string[];
  readonly modes?: readonly number[];
  readonly min?: number;
  readonly max?: number;
}

export interface Capabilities {
  readonly supportsRead: boolean;
  readonly supportsEqToggle: boolean;
  readonly settings: Readonly<Partial<Record<SettingName, SettingCapability>>>;
}

export interface DeviceDescription {
  readonly model: string;
  readonly protocol: Protocol;
  readonly experimental: boolean;
  readonly slots: readonly Slot[];
  readonly limits: Limits;
  readonly capabilities: Capabilities;
}

export interface SupportedDevice extends DeviceDescription {
  readonly vendorIds: readonly number[];
}

export interface DeviceInfo extends DeviceDescription {
  readonly vendorId: number;
  readonly productId: number;
}

export type OperationName = 'getCurrentSlot' | 'readConfig' | 'writeConfig' |
  'setEqEnabled' | 'readSetting' | 'writeSetting';
export type ProgressPhase = 'queued' | 'read' | 'write' | 'commit' | 'verify' | 'setting' | 'slot' | 'complete';
export type ProgressStatus = 'running' | 'completed' | 'cancelled' | 'failed';

/** Compatible with AbortController.signal without requiring DOM-specific WebHID types. */
export interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export interface OperationProgress {
  readonly type: 'progress';
  readonly operationId: number;
  readonly operation: OperationName;
  readonly phase: ProgressPhase;
  readonly completed: number;
  readonly total: number;
  readonly status: ProgressStatus;
  readonly errorCode?: ErrorCode;
}

export interface OperationOptions {
  readonly signal?: AbortSignalLike;
  /** Total deadline in milliseconds, including time spent queued. Does not extend protocol response timeouts. */
  readonly timeoutMs?: number;
  /** Also emitted through subscribe(). Observer exceptions are ignored. */
  readonly onProgress?: (event: OperationProgress) => void;
}

export interface WriteOptions extends OperationOptions {
  readonly slot?: number;
  /** Opt-in immediate read-back comparison. Does not verify persistence across power cycles. */
  readonly verify?: boolean;
}

export interface WriteVerification {
  readonly scope: 'read-back';
  readonly status: 'not-requested' | 'unsupported-read' | 'device-reset' | 'verified';
}

export interface VerificationDifference {
  readonly field: string;
  readonly expected: number | string | boolean;
  readonly actual: number | string | boolean | null;
  readonly tolerance?: number;
}

export interface WriteResult {
  /** Includes flat padding bands sent to clear unused filters. */
  readonly filtersWritten: number;
  readonly slot: number;
  readonly globalGainApplied: boolean;
  readonly disconnected: boolean;
  /** True only when opt-in read-back matched. This is not a flash-durability guarantee. */
  readonly verified: boolean;
  readonly verification: WriteVerification;
}

export interface UnverifiedWriteResult extends WriteResult {
  readonly verified: false;
}

export type ClientEvent =
  | { readonly type: 'connected'; readonly device: DeviceInfo }
  | { readonly type: 'disconnected'; readonly device: DeviceInfo;
      readonly reason: 'requested' | 'device-disconnected' | 'write-reset' }
  | OperationProgress;

export interface HidCollection {
  readonly usagePage: number;
  readonly usage?: number;
  readonly inputReports?: readonly { readonly reportId: number }[];
  readonly outputReports?: readonly { readonly reportId: number }[];
  readonly featureReports?: readonly { readonly reportId: number }[];
  readonly children?: readonly HidCollection[];
}

export interface CollectionDiagnostics {
  readonly usagePage: number;
  readonly usage?: number;
  readonly inputReportIds: readonly number[];
  readonly outputReportIds: readonly number[];
  readonly featureReportIds: readonly number[];
  readonly children: readonly CollectionDiagnostics[];
}

/** Descriptor metadata only; inspecting an unknown device never opens HID or sends commands. */
export interface DeviceInspection {
  readonly productName: string;
  readonly vendorId: number;
  readonly productId: number;
  readonly opened: boolean;
  readonly collections: readonly CollectionDiagnostics[];
  readonly supported: boolean;
  readonly device: SupportedDevice | null;
}

export interface HidLogEntry {
  readonly timestamp: number;
  readonly direction: 'tx' | 'rx';
  readonly reportId: number;
  readonly operationId: number;
  readonly operation: OperationName;
  readonly byteLength: number;
  readonly bytes: readonly number[];
  readonly truncated: boolean;
}

export interface DiagnosticsReport {
  readonly schemaVersion: 1;
  readonly environment: { readonly webHidSupported: boolean; readonly secureContext: boolean | null };
  readonly connected: boolean;
  readonly device: DeviceInfo | null;
  readonly lastDevice: DeviceInspection | null;
  readonly pendingOperations: number;
  readonly activeOperation: {
    readonly operationId: number; readonly operation: OperationName;
    readonly phase: ProgressPhase; readonly status: ProgressStatus;
  } | null;
  readonly lastError: {
    readonly timestamp: number; readonly code: ErrorCode; readonly message: string;
    readonly operation: OperationName | 'connect' | 'disconnect'; readonly operationId?: number;
  } | null;
  readonly logging: {
    readonly enabled: boolean; readonly maxEntries: number;
    readonly retainedEntries: number; readonly maxReportBytes: number;
  };
  /** Empty unless includeLogs is true and diagnostics capture was enabled on the client. */
  readonly logs: readonly HidLogEntry[];
}

/** Structural WebHID types; no @types/w3c-web-hid dependency is required. */
export interface InputReport {
  readonly data: DataView;
  readonly reportId: number;
}

export interface HidDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly opened: boolean;
  readonly collections?: readonly HidCollection[];
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: Uint8Array): Promise<void>;
  addEventListener(type: 'inputreport', listener: (event: InputReport) => void): void;
  removeEventListener(type: 'inputreport', listener: (event: InputReport) => void): void;
}

export interface HidAccess {
  requestDevice(options: { filters: Array<{ vendorId: number; usagePage?: number }> }): Promise<HidDevice[]>;
  getDevices(): Promise<HidDevice[]>;
  addEventListener?(type: 'disconnect', listener: (event: { readonly device: HidDevice }) => void): void;
  removeEventListener?(type: 'disconnect', listener: (event: { readonly device: HidDevice }) => void): void;
}

export interface ClientOptions {
  /** Optional transport injection for tests; normally uses navigator.hid. */
  hid?: HidAccess;
  /** Experimental models are rejected before opening HID unless enabled. */
  allowExperimental?: boolean;
  /** Opt-in per-client bounded wire capture (default false, 100 entries, maximum 500). */
  diagnostics?: boolean | { readonly maxEntries?: number };
}

export interface Client {
  readonly connected: boolean;
  readonly device: DeviceInfo | null;
  /** Call directly from a user click. null means the picker was cancelled. */
  connect(): Promise<DeviceInfo | null>;
  /** Waits for queued work before closing the device. */
  disconnect(): Promise<void>;
  getCurrentSlot(options?: OperationOptions): Promise<number>;
  /** Write-only devices and partial responses are rejected, not returned as backups. */
  readConfig(options?: OperationOptions): Promise<EqConfig>;
  /** Writes the custom slot; omitted bands are reset to flat. Input is not mutated. */
  writeConfig(config: EqConfigInput, options?: WriteOptions & { readonly verify?: false }): Promise<UnverifiedWriteResult>;
  writeConfig(config: EqConfigInput, options: WriteOptions): Promise<WriteResult>;
  setEqEnabled(enabled: boolean, options?: OperationOptions & { readonly slot?: number }): Promise<void>;
  readSetting<K extends ReadableSetting>(name: K, options?: OperationOptions): Promise<SettingValues[K]>;
  writeSetting<K extends WritableSetting>(name: K, value: SettingValues[K], options?: OperationOptions): Promise<void>;
  /** Synchronous JSON-serializable snapshot; never prompts for USB access or sends commands. */
  getDiagnostics(options?: { readonly includeLogs?: boolean }): DiagnosticsReport;
  subscribe(listener: (event: ClientEvent) => void): () => void;
}

export function createClient(options?: ClientOptions): Client;
export function isSupported(hid?: HidAccess): boolean;
/** Call directly from a user click. Returns null if the chooser is cancelled. Never opens or writes HID. */
export function inspectDevice(options?: { hid?: HidAccess }): Promise<DeviceInspection | null>;
/** Returns immutable metadata; never prompts for USB permission. */
export function getSupportedDevices(): readonly SupportedDevice[];
/** Module-wide opt-in diagnostics. Pass null to disable. Observer errors are ignored. */
export function setDebugLogger(logger: ((...values: unknown[]) => void) | null): void;
