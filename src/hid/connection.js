// Unknown product names are rejected even when they share a supported chipset VID.

import { usbHidDeviceHandlerConfig } from '../config/registry.js';
import { resolveConstraints, loadPeqConstraintsConfig } from '../config/constraints.js';
import { handlerNameFor } from '../handlers/index.js';
import { buildExtras } from '../devices/settings.js';
import { prepareFilters } from '../devices/filters.js';

export function createConnector({ hid, throwErrors = false, allowExperimental = true,
  logger = globalThis.console, onSelected } = {}) {
    let currentDevice = null;
    const console = logger;
    const getHid = () => hid ?? globalThis.navigator?.hid;

    const getDeviceConnected = async () => {
        try {
            // Close the previous device before selecting a different one.
            if (currentDevice != null) {
              try { await currentDevice.rawDevice.close(); } catch (_) {}
              currentDevice = null;
            }

            const vendorToManufacturer = usbHidDeviceHandlerConfig.flatMap(entry =>
              entry.vendorIds.map(vendorId => ({
                vendorId,
                ...(entry.hidUsagePage ? { usagePage: entry.hidUsagePage } : {})
              }))
            );
            // Request devices matching the filters
            const selectedDevices = await getHid().requestDevice({ filters: vendorToManufacturer });

            if (selectedDevices.length > 0) {
                let rawDevice = selectedDevices[0];

                // Some devices expose multiple HID interfaces with
                // identical names. The picker may return the consumer-control interface
                // (usagePage=0x0C) instead of the vendor PEQ interface (usagePage≥0xFF00).
                // If that happens, look through previously-granted devices for a sibling
                // with the same vendorId/productId that has vendor HID collections.
                const hasVendorHID = rawDevice.collections?.some(c => c.usagePage >= 0xFF00);
                if (!hasVendorHID) {
                  const granted = await getHid().getDevices();
                  const sibling = granted.find(d =>
                    d !== rawDevice &&
                    d.vendorId  === rawDevice.vendorId &&
                    d.productId === rawDevice.productId &&
                    d.collections?.some(c => c.usagePage >= 0xFF00)
                  );
                  if (sibling) {
                    console.log(`[connector] Swapping to vendor HID interface for "${rawDevice.productName}"`);
                    rawDevice = sibling;
                  }
                }
                // Descriptor-only diagnostics may also describe unsupported devices.
                onSelected?.(rawDevice);
                // Find the vendor configuration matching the selected device
              const vendorConfig = usbHidDeviceHandlerConfig.find(entry =>
                entry.vendorIds.includes(rawDevice.vendorId)
              );

                if (!vendorConfig) {
                  console.error("No configuration found for vendor:", rawDevice.vendorId);
                  return { unsupported: true };
                }

                const model = rawDevice.productName;

                // Chipset VIDs are shared by other manufacturers. Do not fall back
                // to a generic handler for a product absent from the Moondrop list.
                const deviceDetails = Object.hasOwn(vendorConfig.devices || {}, model)
                  ? vendorConfig.devices[model]
                  : null;
                if (!deviceDetails || deviceDetails.manufacturer !== 'Moondrop') {
                  console.warn('Not in the Moondrop device registry:', model);
                  return { unsupported: true };
                }

                let modelConfig = Object.assign(
                  {},
                  vendorConfig.defaultModelConfig || {},
                  deviceDetails.modelConfig || {}
                );

                // Resolve peqConstraints and merge into modelConfig so handlers
                // can read maxFilters, supportsLSFilter etc. from deviceDetails.modelConfig.
                await loadPeqConstraintsConfig().catch(() => {});
                const resolvedConstraints = resolveConstraints(modelConfig);
                if (resolvedConstraints) Object.assign(modelConfig, resolvedConstraints);

                if (modelConfig.experimental && !allowExperimental) {
                  throw Object.assign(new Error(`Experimental device: ${model}`), { code: 'EXPERIMENTAL_DEVICE' });
                }

                const manufacturer = deviceDetails.manufacturer || vendorConfig.manufacturer;
                let handler = deviceDetails.handler ||  vendorConfig.handler;

                // Always-on (not gated behind debugLogs) - printed immediately at resolution
                // time, before any handler method runs, so it's available even if the device
                // never responds and a handler call later hangs/times out.
                console.log(
                  `[usbHidConnector] resolved "${model}" -> manufacturer=${manufacturer} ` +
                  `vendorId=0x${rawDevice.vendorId.toString(16).toUpperCase().padStart(4,'0')} ` +
                  `productId=0x${rawDevice.productId.toString(16).toUpperCase().padStart(4,'0')}`
                );

                // Open the device if not already open
                if (!rawDevice.opened) {
                    await rawDevice.open();
                }
                currentDevice = {
                    rawDevice: rawDevice,
                    manufacturer: manufacturer,
                    model: model,
                    modelConfig: modelConfig,
                    handler: handler,
                    // Keep the selected protocol implementation with the device.
                    handlerName: handlerNameFor(handler),
                    deviceGroup: null,
                };
                currentDevice.extras = buildExtras(handler, currentDevice);

                return currentDevice;
            } else {
                // User cancelled the chooser dialog
                console.log("USB HID chooser cancelled by user.");
                return { cancelled: true };
            }
        } catch (error) {
            if (throwErrors) throw error;
            console.error("Failed to connect to HID device:", error);
            return null;
        }
    };

    const disconnectDevice = async () => {
        if (currentDevice && currentDevice.rawDevice) {
            try {
                await currentDevice.rawDevice.close();
                console.log("Device disconnected:", currentDevice.model);
                currentDevice = null;
            } catch (error) {
                if (throwErrors) throw error;
                console.error("Failed to disconnect device:", error);
            }
        }
    };
    const checkDeviceConnected = async (device, operation) => {
        operation?.throwIfAborted();
        var rawDevice = device.rawDevice;
        const rawDevices = await getHid().getDevices();
        operation?.throwIfAborted();
        // When multiple interfaces share vendorId+productId,
        // prefer the one whose collections match the currently-held device so we
        // don't accidentally swap back to the consumer-control interface.
        const sameCollectionSig = (a, b) =>
          (a.collections||[]).map(c=>c.usagePage).sort().join() ===
          (b.collections||[]).map(c=>c.usagePage).sort().join();
        // HIDDevice identity matters: another physical DAC can have the same IDs.
        var matchingRawDevice = rawDevices.find(d => d === rawDevice && sameCollectionSig(d, rawDevice));
        if (typeof matchingRawDevice == 'undefined' || matchingRawDevice == null ) {
            // NOT alert(). alert() blocks the main thread until it is dismissed,
            // which freezes the whole tab — and if the dialog opens behind
            // another window, or the tab is not focused, it looks exactly like a
            // crash: unresponsive page, 0% CPU, normal memory. That is fatal for
            // an unattended run, where this path can be hit on any of dozens of
            // pushes. Report it and let the caller fail the operation instead.
            console.error("Device disconnected? Not found among granted HID devices.");
            return false;
        }
        // But lets check if we are still open otherwise we need to open the device again
        if (!matchingRawDevice.opened) {
          if (operation) await operation.native(() => matchingRawDevice.open());
          else await matchingRawDevice.open();
          device.rawDevice = matchingRawDevice; // Swap the device over
        }
        return true;
    };

    const pushToDevice = async (device, phoneObj, slot, preamp, filters, operation) => {
        if (!await checkDeviceConnected(device, operation)) {
            throw Object.assign(new Error('Device disconnected.'), { code: 'DEVICE_DISCONNECTED' });
        }
        if (device && device.handler) {

          const filtersToWrite = prepareFilters(filters, device.modelConfig, preamp, { logger: console });
          return await device.handler.pushToDevice(operation?.wrapDevice(device) ?? device, phoneObj, slot, preamp, filtersToWrite);
      } else {
          console.error("No device handler available for pushing.");
      }
      return true;   // Disconnect anyway
    };

    // Helper Function to Get Available 'Custom' Slots Based on the Device that we can write too
    const  getAvailableSlots = async (device) => {
        return device.modelConfig.availableSlots;
    };

    const getCurrentSlot = async (device, operation) => {
        operation?.throwIfAborted();
        if (device && device.handler) {
            return await device.handler.getCurrentSlot(operation?.wrapDevice(device) ?? device)
        }{
            console.error("No device handler available for querying");
            return -2;
        }
    };

    const pullFromDevice = async (device, slot, operation) => {
        if (!await checkDeviceConnected(device, operation)) {
            throw Object.assign(new Error('Device disconnected.'), { code: 'DEVICE_DISCONNECTED' });
        }
        if (device && device.handler) {
            return await device.handler.pullFromDevice(operation?.wrapDevice(device) ?? device, slot);
        } else {
            console.error("No device handler available for pulling.");
            return { filters: [] }; // Empty filters
        }
    };

    const enablePEQ = async (device, enabled, slotId, operation) => {
        operation?.throwIfAborted();
        if (device && device.handler) {
            return await device.handler.enablePEQ(operation?.wrapDevice(device) ?? device, enabled, slotId);
        } else {
            console.error("No device handler available for enabling.");
        }
    };

    const getCurrentDevice = () => currentDevice;
    const forgetDevice = () => { currentDevice = null; };

    // Returns the extras object for a device (capabilities beyond core PEQ).
    // The same object is already attached as device.extras when the device connects.
    const getExtras = (device) => device?.extras ?? buildExtras(device?.handler, device);

    return {
        getDeviceConnected,
        getAvailableSlots,
        disconnectDevice,
        pushToDevice,
        pullFromDevice,
        getCurrentDevice,
        forgetDevice,
        getCurrentSlot,
        enablePEQ,
        getExtras,
    };
}

// Compatibility entry for the original reference smoke/contract tests.
export const UsbHIDConnector = Promise.resolve(createConnector());
