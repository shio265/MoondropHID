//
// Moondrop HID by shio265.
//
// Moondrop-only USB HID connections.
// Unknown product names are rejected even when they share a supported chipset VID.

import { usbHidDeviceHandlerConfig, handlerNameFor,
  resolveConstraints, resolveExtras, loadPeqConstraintsConfig } from './config.js';

export function createConnector({ hid, throwErrors = false, allowExperimental = true,
  logger = globalThis.console } = {}) {
    let currentDevice = null;
    const console = logger;
    const getHid = () => hid ?? globalThis.navigator?.hid;

    // Capability wrappers live with the connection that exposes them.
    function notImplemented(name) {
      return () => Promise.reject(
        Object.assign(new Error(`NOT_IMPLEMENTED: ${name}`), { code: 'NOT_IMPLEMENTED' })
      );
    }

    function capable(cfg, handler, device, capKey, getMethod, setMethod) {
      const capCfg = cfg?.[capKey] ?? {};
      const devCfg = device?.modelConfig?.[capKey] ?? {};
      const isSupported = (devCfg.supported !== undefined ? devCfg.supported : capCfg.supported) === true;
      const result = { supported: isSupported, ...capCfg, ...devCfg };
      delete result.handler;
      delete result.readHandler;
      delete result.note;
      if (getMethod) {
        result.get = isSupported && typeof handler?.[getMethod] === 'function'
          ? () => handler[getMethod](device)
          : notImplemented(`${capKey}.get`);
      }
      if (setMethod) {
        result.set = isSupported && typeof handler?.[setMethod] === 'function'
          ? (...args) => handler[setMethod](device, ...args)
          : notImplemented(`${capKey}.set`);
      }
      return result;
    }

    function buildExtras(handler, device) {
      const cfg = resolveExtras(device?.modelConfig) ?? {};
      const h = handler ?? {};
      return {
        micGain: capable(cfg, h, device, 'micGain', 'readMicGain', 'setMicGain'),
        denoise: capable(cfg, h, device, 'denoise', 'readDenoiseEnabled', 'setDenoiseEnabled'),
        dacFilter: capable(cfg, h, device, 'dacFilter', 'readDacFilter', 'setDacFilter'),
        dacBalance: capable(cfg, h, device, 'dacBalance', null, 'setDacBalance'),
        dacWorkMode: capable(cfg, h, device, 'dacWorkMode', 'readDacWorkMode', 'setDacWorkMode'),
        gainMode: capable(cfg, h, device, 'gainMode', 'readGainMode', 'setGainMode'),
        battery: capable(cfg, h, device, 'battery', 'readBattery', null),
        eqEnabled: capable(cfg, h, device, 'eqEnabled', 'readEqEnabled', 'setEqEnabled'),
        outputGain: {
          supported: typeof h.setOutputGain === 'function',
          set: typeof h.setOutputGain === 'function'
            ? (gainDb) => h.setOutputGain(device, gainDb)
            : notImplemented('outputGain.set'),
        },
      };
    }

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
    const checkDeviceConnected = async (device) => {
        var rawDevice = device.rawDevice;
        const rawDevices = await getHid().getDevices();
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
          await matchingRawDevice.open();
          device.rawDevice = matchingRawDevice; // Swap the device over
        }
        return true;
    };

    const pushToDevice = async (device, phoneObj, slot, preamp, filters) => {
        if (!await checkDeviceConnected(device)) {
            throw Object.assign(new Error('Device disconnected.'), { code: 'DEVICE_DISCONNECTED' });
        }
        if (device && device.handler) {

          // Create a copy of the filters array to avoid modifying the original
          let filtersToWrite = [...filters];

          // Ensure array is at most the maxFilters
          if (filtersToWrite.length > device.modelConfig.maxFilters) {
            console.warn(`USB Device PEQ: Truncating ${filtersToWrite.length} filters to ${device.modelConfig.maxFilters} (device limit)`);

            const enabledFilters = filtersToWrite.filter(f => !f.disabled);
            filtersToWrite = enabledFilters.length >= device.modelConfig.maxFilters
              ? enabledFilters.slice(0, device.modelConfig.maxFilters)
              : [
                  ...enabledFilters,
                  ...filtersToWrite.filter(f => f.disabled).slice(0, device.modelConfig.maxFilters - enabledFilters.length)
                ];
          }

          // And do an upfront sanity check on the values
          for (let i = 0 ; i < filtersToWrite.length; i++) {
            // A quick sanity check on the filters
            if (filtersToWrite[i].freq < 20 || filtersToWrite[i].freq > 20000) {
              filtersToWrite[i].freq = 100;
            }
            if (filtersToWrite[i].q < 0.01 || filtersToWrite[i].q > 100) {
              filtersToWrite[i].q = 1;
            }
          }

          // Determine per-type support from granular flags
          const supportsLS = device.modelConfig.supportsLSFilter === true;
          const supportsHS = device.modelConfig.supportsHSFilter === true;
          const supportsLPHP = device.modelConfig.supportsLPHPFilters === true;

          const hasUnsupportedLS = filtersToWrite.some(f => f.type === "LSQ" && f.gain !== 0) && !supportsLS;
          const hasUnsupportedHS = filtersToWrite.some(f => f.type === "HSQ" && f.gain !== 0) && !supportsHS;
          const hasUnsupportedLPHP = filtersToWrite.some(f => (f.type === "LP" || f.type === "HP")) && !supportsLPHP;

          // Second, determine if we need pregain (only if globalGain is positive)
          const needsPreGain = preamp < 0;

          // Convert unsupported filter types to PK with gain=0
          for (let i = 0; i < filtersToWrite.length; i++) {
            const f = filtersToWrite[i];
            if ((f.type === "LSQ" && !supportsLS) ||
                (f.type === "HSQ" && !supportsHS) ||
                ((f.type === "LP" || f.type === "HP") && !supportsLPHP)) {
              console.log(`USB Device PEQ: converting unsupported ${f.type} filter to PK with gain=0`);
              filtersToWrite[i] = {...f, type: "PK", gain: 0};
            }
          }

          // Warn about unsupported filter types
          const hasUnsupportedShelfFilters = hasUnsupportedLS || hasUnsupportedHS;
          if (hasUnsupportedShelfFilters && needsPreGain && device.modelConfig.deviceHandlesPregain === true) {
            console.warn("Device handles pregain internally — host-computed pregain and unsupported shelf filters will be ignored");
          } else if (hasUnsupportedLS && hasUnsupportedHS) {
            console.warn("Device does not support LS or HS filters - ignoring");
          } else if (hasUnsupportedLS) {
            console.warn("Device does not support Low Shelf filters - ignoring");
          } else if (hasUnsupportedHS) {
            console.warn("Device does not support High Shelf filters - ignoring");
          } else if (needsPreGain && device.modelConfig.deviceHandlesPregain === true) {
            console.warn("Device handles pregain internally — host-computed pregain will not be written");
          }
          if (hasUnsupportedLPHP) {
            console.warn("Device does not support LP/HP filters - ignoring");
          }

          // If we have fewer filters than maxFilters, fill the rest with defaultResetFiltersValues
          if (filtersToWrite.length < device.modelConfig.maxFilters && device.modelConfig.defaultResetFiltersValues) {
            const defaultFilter = device.modelConfig.defaultResetFiltersValues[0];
            console.log(`USB Device PEQ: filling missing filters with defaults:`, defaultFilter);

            for (let i = filtersToWrite.length; i < device.modelConfig.maxFilters; i++) {

              filtersToWrite.push({...defaultFilter});
            }
          }

          return await device.handler.pushToDevice(device, phoneObj, slot, preamp, filtersToWrite);
      } else {
          console.error("No device handler available for pushing.");
      }
      return true;   // Disconnect anyway
    };

    // Helper Function to Get Available 'Custom' Slots Based on the Device that we can write too
    const  getAvailableSlots = async (device) => {
        return device.modelConfig.availableSlots;
    };

    const getCurrentSlot = async (device) => {
        if (device && device.handler) {
            return await device.handler.getCurrentSlot(device)
        }{
            console.error("No device handler available for querying");
            return -2;
        }
    };

    const pullFromDevice = async (device, slot) => {
        if (!await checkDeviceConnected(device)) {
            throw Object.assign(new Error('Device disconnected.'), { code: 'DEVICE_DISCONNECTED' });
        }
        if (device && device.handler) {
            return await device.handler.pullFromDevice(device, slot);
        } else {
            console.error("No device handler available for pulling.");
            return { filters: [] }; // Empty filters
        }
    };

    const enablePEQ = async (device, enabled, slotId) => {
        if (device && device.handler) {
            return await device.handler.enablePEQ(device, enabled, slotId);
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
