export class HidError extends Error {
  constructor(code, message, { cause, details } = {}) {
    super(message, { cause });
    this.name = 'HidError';
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details) {
  throw new HidError(code, message, { details });
}
