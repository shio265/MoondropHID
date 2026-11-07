// Moondrop-only USB device configuration.
// Shared chipset vendor IDs are not proof that a device is made by Moondrop.
// The connector therefore requires an explicit productName match in this registry.

import {
  nativeProtocol, walkplayProtocol, legacyProtocol, conexantProtocol, registerProtocol
} from '../handlers/index.js';

export const usbHidDeviceHandlerConfig = [
  {
    vendorIds: [0x0104, 0x011B, 0x011D, 0x0661, 0x0663, 0x0666, 0x0762, 0x0D8C, 0x2FC6, 0x3302, 0x34BE, 0x35D8, 0x36A7, 0x373B, 0x60C1, 0x60E1, 0xB445, 0xB44D],
    manufacturer: 'Moondrop',
    handler: walkplayProtocol,
    defaultModelConfig: {
      peqConstraintsRef: 'walkplayPeq8Band10dBPkOnly',
      schemeNo: 10,
      firstWritableEQSlot: 101,
      maxWritableEQSlots: 1,
      disconnectOnSave: false,
      defaultResetFiltersValues: [{ gain: 0, freq: 100, q: 1, filterType: 'PK' }],
      deviceHandlesPregain: false,
      experimental: false,
      availableSlots: [{ id: 101, name: 'Custom' }],
      dacWorkMode: { modes: [0, 1], modeLabels: ['Class H', 'Class AB'] }
    },
    // Only entries explicitly labelled manufacturer: "Moondrop" upstream.
    // Some USB names are OEM/alias names rather than retail Moondrop model names.
    devices: {
      'Old Fashioned': {
        manufacturer: 'Moondrop',
        handler: legacyProtocol,
        modelConfig: {
          peqConstraintsRef: 'peq5Band3dBCeilingPkOnly',
          firstWritableEQSlot: -1,
          maxWritableEQSlots: 0,
          disconnectOnSave: false,
          disabledPresetId: -1,
          experimental: false,
          defaultResetFiltersValues: [{ gain: 0, freq: 100, q: 1, filterType: 'PK' }],
          availableSlots: [{ id: 0, name: 'Custom' }]
        }
      },
      'Rays': {
        manufacturer: 'Moondrop',
        handler: nativeProtocol,
        modelConfig: {
          peqConstraintsRef: 'peq8Band12dBFullShelves',
          peqConstraintsOverride: { deviceHandlesPregain: true, supportsLSFilter: false, supportsHSFilter: false }
        }
      },
      'Marigold': {
        manufacturer: 'Moondrop',
        handler: nativeProtocol,
        modelConfig: { peqConstraintsRef: 'peq8Band6dBPkOnly' }
      },
      'MOONDROP Marigold': {
        manufacturer: 'Moondrop',
        handler: nativeProtocol,
        modelConfig: { peqConstraintsRef: 'peq8Band6dBPkOnly' }
      },
      'FreeDSP Pro': {
        manufacturer: 'Moondrop',
        handler: nativeProtocol,
        modelConfig: {
          peqConstraintsRef: 'peq8Band12dBFullShelves',
          peqConstraintsOverride: { deviceHandlesPregain: true }
        }
      },
      'MOONRIVER 3': {
        manufacturer: 'Moondrop',
        handler: nativeProtocol,
        modelConfig: {
          peqConstraintsRef: 'peq8Band12dBFullShelves',
          peqConstraintsOverride: { deviceHandlesPregain: true }
        }
      },
      'FreeDSP Mini': {
        manufacturer: 'Moondrop',
        handler: nativeProtocol,
        modelConfig: { peqConstraintsRef: 'peq8Band12dBFullShelves' }
      },
      'FreeDSP': {
        manufacturer: 'Moondrop',
        handler: conexantProtocol,
        modelConfig: {
          peqConstraintsRef: 'peq9Band12dBFullShelves',
          supportsLSFilter: true,
          supportsHSFilter: true,
          deviceHandlesPregain: false,
          maxFilters: 9
        }
      },
      'DAWN PRO2': {
        manufacturer: 'Moondrop',
        handler: nativeProtocol,
        modelConfig: { peqConstraintsRef: 'peq8Band12dBFullShelves' }
      },
      'Echo A': {
        manufacturer: 'Moondrop',
        handler: nativeProtocol,
        modelConfig: {
          peqConstraintsRef: 'peq8Band12dBFullShelves',
          peqConstraintsOverride: { supportsLSFilter: false, supportsHSFilter: false }
        }
      },
      'ECHO-B': {
        manufacturer: 'Moondrop',
        handler: conexantProtocol,
        modelConfig: {
          peqConstraintsRef: 'peq9Band12dBFullShelves',
          supportsLSFilter: true,
          supportsHSFilter: true,
          deviceHandlesPregain: false,
          maxFilters: 9
        }
      },
      'AG Rays': {
        manufacturer: 'Moondrop',
        handler: nativeProtocol,
        modelConfig: {
          peqConstraintsRef: 'peq8Band12dBFullShelves',
          peqConstraintsOverride: { supportsLSFilter: false, supportsHSFilter: false }
        }
      },
      'DHA15': {
        manufacturer: 'Moondrop',
        handler: nativeProtocol,
        modelConfig: { peqConstraintsRef: 'peq8Band12dBFullShelves' }
      },
      'Deco Audio System': {
        manufacturer: 'Moondrop',
        handler: nativeProtocol,
        modelConfig: { peqConstraintsRef: 'peq8Band12dBFullShelves' }
      },
      'INN Deco75-DH Audio': {
        manufacturer: 'Moondrop',
        handler: nativeProtocol,
        modelConfig: { peqConstraintsRef: 'peq8Band12dBFullShelves' }
      },
      'ddHiFi DSP IEM - Memory': {
        manufacturer: 'Moondrop',
        handler: nativeProtocol
      },
      'MD-QT-042': {
        manufacturer: 'Moondrop',
        modelConfig: {
          peqConstraintsRef: 'walkplayPeq8Band10dBFullShelves',
          schemeNo: 15,
          experimental: true
        }
      },
      'MOONDROP HiFi with PD': {
        manufacturer: 'Moondrop',
        modelConfig: {
          peqConstraintsRef: 'walkplayPeq8Band10dBFullShelves',
          schemeNo: 15,
          experimental: true
        }
      },
      'DAWN PRO 2': {
        manufacturer: 'Moondrop',
        modelConfig: {
          peqConstraintsRef: 'walkplayPeq8Band10dBFullShelves',
          schemeNo: 15,
          experimental: false
        }
      }
    }
  },
  {
    vendorIds: [0x31B2],
    manufacturer: 'Moondrop',
    handler: registerProtocol,
    defaultModelConfig: {
      peqConstraintsRef: 'peq5Band12dBFullShelvesNoPregain',
      firstWritableEQSlot: -1,
      maxWritableEQSlots: 0,
      compensate2X: true,
      disconnectOnSave: false,
      disabledPresetId: 0x02,
      experimental: false,
      defaultResetFiltersValues: [{ gain: 0, freq: 100, q: 1, filterType: 'PK' }],
      availableSlots: [{ id: 0x03, name: 'Custom' }]
    },
    devices: {
      'CDSP': {
        manufacturer: 'Moondrop',
        modelConfig: {
          peqConstraintsRef: 'peq5Band12dBFullShelvesNoPregain',
          compensate2X: false
        }
      },
      'Chu2 DSP': {
        manufacturer: 'Moondrop',
        modelConfig: {
          peqConstraintsRef: 'peq5Band12dBFullShelvesNoPregain',
          compensate2X: false
        }
      }
    }
  }
];
