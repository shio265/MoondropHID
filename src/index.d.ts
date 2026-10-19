export type Protocol = 'native' | 'walkplay' | 'register' | 'legacy' | 'conexant';
export type FilterType = 'PK' | 'LSQ' | 'HSQ';
export type ErrorCode = 'UNSUPPORTED_ENVIRONMENT' | 'INSECURE_CONTEXT' | 'UNSUPPORTED_DEVICE' |
  'EXPERIMENTAL_DEVICE' | 'NOT_CONNECTED' | 'BUSY' | 'INVALID_CONFIG' | 'UNSUPPORTED_READ' |
  'UNSUPPORTED_OPERATION' | 'INCOMPLETE_READ' | 'CONNECTION_FAILED' | 'IO_ERROR' | 'DEVICE_DISCONNECTED';

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

export interface WriteResult {
  /** Includes flat padding bands sent to clear unused filters. */
  readonly filtersWritten: number;
  readonly slot: number;
  readonly globalGainApplied: boolean;
  readonly disconnected: boolean;
  /** Commands were sent; persistence has not been independently verified. */
  readonly verified: false;
}

export type ClientEvent =
  | { readonly type: 'connected'; readonly device: DeviceInfo }
  | { readonly type: 'disconnected'; readonly device: DeviceInfo;
      readonly reason: 'requested' | 'device-disconnected' | 'write-reset' };

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
  readonly collections?: readonly { readonly usagePage: number }[];
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
}

export interface Client {
  readonly connected: boolean;
  readonly device: DeviceInfo | null;
  /** Call directly from a user click. null means the picker was cancelled. */
  connect(): Promise<DeviceInfo | null>;
  /** Waits for queued work before closing the device. */
  disconnect(): Promise<void>;
  getCurrentSlot(): Promise<number>;
  /** Write-only devices and partial responses are rejected, not returned as backups. */
  readConfig(): Promise<EqConfig>;
  /** Writes the custom slot; omitted bands are reset to flat. Input is not mutated. */
  writeConfig(config: EqConfigInput, options?: { slot?: number }): Promise<WriteResult>;
  setEqEnabled(enabled: boolean, options?: { slot?: number }): Promise<void>;
  readSetting<K extends ReadableSetting>(name: K): Promise<SettingValues[K]>;
  writeSetting<K extends WritableSetting>(name: K, value: SettingValues[K]): Promise<void>;
  subscribe(listener: (event: ClientEvent) => void): () => void;
}

export function createClient(options?: ClientOptions): Client;
export function isSupported(hid?: HidAccess): boolean;
/** Returns immutable metadata; never prompts for USB permission. */
export function getSupportedDevices(): readonly SupportedDevice[];
/** Module-wide opt-in diagnostics. Pass null to disable. Observer errors are ignored. */
export function setDebugLogger(logger: ((...values: unknown[]) => void) | null): void;
