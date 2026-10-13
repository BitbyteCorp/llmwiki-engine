import { ApiError } from '@/lib/api'

const passwordErrors: Record<string, string> = {
  invalid_credentials: '이메일 또는 비밀번호가 올바르지 않습니다.',
  login_denied: '이 계정은 로그인할 수 없습니다. 관리자에게 문의하세요.',
  login_request_not_found: '로그인 요청이 만료되었습니다. 클라이언트에서 다시 연결해 주세요.',
  weak_password: '비밀번호는 8자 이상 128자 이하여야 합니다.',
  invalid_current_password: '현재 비밀번호가 올바르지 않습니다.',
  rate_limited: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
}

export function passwordErrorMessage(error: unknown): string {
  const code = error instanceof ApiError ? error.code : typeof error === 'string' ? error : undefined
  return (code && passwordErrors[code]) || (error instanceof Error ? error.message : String(error))
}

export function validateNewPassword(password: string, confirmation?: string): string | null {
  const normalized = password.normalize('NFKC')
  const length = Array.from(password).length
  const normalizedLength = Array.from(normalized).length
  if (length < 8 || length > 128 || normalizedLength < 8 || normalizedLength > 128) return passwordErrors.weak_password!
  if (confirmation !== undefined && normalized !== confirmation.normalize('NFKC')) return '새 비밀번호가 일치하지 않습니다.'
  return null
}
