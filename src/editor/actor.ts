const DEFAULT_ACTOR = 'human:user';

let currentActor = DEFAULT_ACTOR;

export function normalizeActor(actor?: string): string {
  if (!actor) return DEFAULT_ACTOR;
  const trimmed = actor.trim();
  if (!trimmed) return DEFAULT_ACTOR;
  if (trimmed.startsWith('human:') || trimmed.startsWith('ai:')) return trimmed;
  return `human:${trimmed}`;
}

export function setCurrentActor(actor?: string): string {
  currentActor = normalizeActor(actor);
  return currentActor;
}

export function getCurrentActor(): string {
  return currentActor;
}

/** "pat.example@example.com" -> "Pat Example" (presence display only). */
export function deriveDisplayNameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? '';
  const words = local.split(/[._\-+]+/).filter((word) => word.length > 0);
  if (words.length === 0) return email;
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
