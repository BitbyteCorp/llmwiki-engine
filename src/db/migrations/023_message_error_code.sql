ALTER TABLE messages ADD COLUMN error_code TEXT
  CHECK (error_code IN ('rate_limited', 'invalid_request', 'auth', 'provider_error', 'timeout', 'context_too_large', 'turn_limit', 'cancelled', 'unknown'));
