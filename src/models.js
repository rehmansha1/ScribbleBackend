import { randomInt } from 'node:crypto';

// Unambiguous characters only (no 0/O, 1/I)
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const makeCode = () =>
  Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
