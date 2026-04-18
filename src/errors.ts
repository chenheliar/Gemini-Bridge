export class AppError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string, statusCode = 500, code = "app_error") {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class AuthError extends AppError {
  constructor(message: string) {
    super(message, 401, "auth_error");
  }
}

export class GeminiApiError extends AppError {
  constructor(message: string, statusCode = 502, code = "gemini_api_error") {
    super(message, statusCode, code);
  }
}

export class InvalidRequestError extends AppError {
  constructor(message: string, code = "invalid_request") {
    super(message, 400, code);
  }
}

export class ModelInvalidError extends AppError {
  constructor(message: string) {
    super(message, 400, "model_invalid");
  }
}

export class UsageLimitExceededError extends AppError {
  constructor(message: string) {
    super(message, 429, "usage_limit_exceeded");
  }
}

export class TemporarilyBlockedError extends AppError {
  constructor(message: string) {
    super(message, 403, "temporarily_blocked");
  }
}
