/** 域二：会话管理 */
export interface SessionBinding { userId: string; personaId: string; }

const bindings = new Map<string, string>();

export function bindUser(userId: string, personaId: string): void {
  bindings.set(userId, personaId);
}

export function getPersonaForUser(userId: string): string | undefined {
  return bindings.get(userId);
}
