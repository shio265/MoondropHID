import { getSupportedDevices } from './metadata.js';
import { immutable } from '../utils/object.js';

function collections(items, depth = 0) {
  if (!Array.isArray(items) || depth > 8) return [];
  return items.slice(0, 64).map(item => ({
    usagePage: item.usagePage,
    ...(item.usage !== undefined ? { usage: item.usage } : {}),
    inputReportIds: (item.inputReports ?? []).slice(0, 256).map(report => report.reportId),
    outputReportIds: (item.outputReports ?? []).slice(0, 256).map(report => report.reportId),
    featureReportIds: (item.featureReports ?? []).slice(0, 256).map(report => report.reportId),
    children: collections(item.children, depth + 1)
  }));
}

// Copy only HID descriptors: no native handles, serial numbers, browser storage or environment secrets.
export function describeHidDevice(raw) {
  const device = getSupportedDevices().find(entry => entry.model === raw.productName && entry.vendorIds.includes(raw.vendorId)) ?? null;
  return immutable({ productName: raw.productName, vendorId: raw.vendorId, productId: raw.productId,
    opened: raw.opened === true, collections: collections(raw.collections), supported: device !== null, device });
}
