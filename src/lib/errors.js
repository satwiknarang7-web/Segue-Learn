/** Error carrying an HTTP status code, so routes can throw instead of branching. */
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, message, details);
export const notFound = (message = 'Not found') => new HttpError(404, message);
export const conflict = (message) => new HttpError(409, message);
export const gone = (message) => new HttpError(410, message);
export const payloadTooLarge = (message) => new HttpError(413, message);
