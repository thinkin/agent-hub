import { timingSafeEqual } from 'node:crypto';

export function equalSecret(actual: string | undefined, expected: string) {
  return !!actual && Buffer.byteLength(actual) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
