export function toHex(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data?.buffer ?? data ?? []);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
}

export function convertToByteArray(value, length) {
  const arr = [];
  for (let i = 0; i < length; i++) arr.push((value >> (8 * i)) & 0xFF);
  return arr;
}
