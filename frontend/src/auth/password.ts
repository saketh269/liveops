// Password rules from ADR 0008 (at least 10 characters, not the email) and a UI-only strength meter.

export const MIN_PASSWORD = 10;

/** The rule the API enforces, in plain words; null when the password is acceptable. */
export function passwordProblem(password: string, email?: string): string | null {
  if (!password) return "Enter a password.";
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (email && password.trim().toLowerCase() === email.trim().toLowerCase()) return "Don't use your email address as the password.";
  return null;
}

export type Strength = { score: 0 | 1 | 2 | 3 | 4; label: string };

const COMMON = /^(password|passw0rd|qwerty|letmein|welcome|admin|iloveyou|123456|abc123|liveops)/i;

/**
 * A rough guide only: length and variety, with penalties for repeats, sequences and
 * common starts. Never stricter than the API's rule, never sent to the server.
 */
export function passwordStrength(password: string, email?: string): Strength {
  if (!password) return { score: 0, label: "" };
  if (passwordProblem(password, email)) return { score: 1, label: "Too short or easy to guess" };
  let points = 0;
  if (password.length >= 12) points++;
  if (password.length >= 16) points++;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (classes >= 3) points++;
  if (classes === 4 || (classes >= 2 && password.length >= 20)) points++;
  if (/(.)\1{2,}/.test(password)) points--;
  if (/(0123|1234|2345|3456|4567|5678|6789|abcd|bcde|cdef|qwer|asdf)/i.test(password)) points--;
  if (COMMON.test(password)) points -= 2;
  const local = email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 3 && password.toLowerCase().includes(local)) points--;
  if (points <= 0) return { score: 1, label: "Weak" };
  if (points === 1) return { score: 2, label: "Fair" };
  if (points === 2) return { score: 3, label: "Good" };
  return { score: 4, label: "Strong" };
}

export function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}
