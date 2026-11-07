import { en } from '@/i18n/en';

export function errorMessage(error: unknown) {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return en.errors.generic;
}
