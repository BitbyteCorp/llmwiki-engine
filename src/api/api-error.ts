export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export function notFound(message: string): never {
  throw new ApiError(404, 'not_found', message);
}
