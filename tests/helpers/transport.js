import { fakeDevice } from './device.js';

export function transport(model = 'MOONRIVER 3', { vendorId = 0x35D8, protocol = 'moondrop' } = {}) {
  const raw = fakeDevice(model, vendorId, protocol);
  const events = new EventTarget();
  return {
    raw, requests: 0, selected: [raw], devices: [raw],
    async requestDevice() { this.requests++; return this.selected; },
    async getDevices() { return this.devices; },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    unplug() {
      raw.opened = false;
      this.devices = [];
      const event = new Event('disconnect');
      Object.defineProperty(event, 'device', { value: raw });
      events.dispatchEvent(event);
    }
  };
}
