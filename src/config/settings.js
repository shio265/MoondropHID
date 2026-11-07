// Protocol method names shared by metadata and device-bound settings wrappers.
export const settingMethods = {
  micGain: ['readMicGain', 'setMicGain'],
  denoise: ['readDenoiseEnabled', 'setDenoiseEnabled'],
  dacFilter: ['readDacFilter', 'setDacFilter'],
  dacBalance: [null, 'setDacBalance'],
  dacWorkMode: ['readDacWorkMode', 'setDacWorkMode'],
  gainMode: ['readGainMode', 'setGainMode'],
  battery: ['readBattery', null],
  eqEnabled: ['readEqEnabled', 'setEqEnabled'],
  outputGain: [null, 'setOutputGain']
};
