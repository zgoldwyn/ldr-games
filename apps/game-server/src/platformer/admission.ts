import type { ElementalRole, ElementalRoleAssignment } from '@ldr/core';

export interface PlatformerAdmission {
  readonly userId: string;
  readonly gameSessionId: string;
  readonly pairingId: string;
  readonly role: ElementalRole;
  readonly catalogFingerprint: string;
  readonly source: 'dev-seat-reservation' | 'supabase-ticket';
}

export interface PlatformerRoomOptions {
  readonly provisioningNonce: string;
  readonly gameSessionId: string;
  readonly pairingId: string;
  readonly assignment: ElementalRoleAssignment;
  readonly catalogFingerprint: string;
  readonly startLevel: number;
}

/** Future seam for the 60-second, single-use Supabase admission ticket. */
export interface PlatformerAdmissionVerifier {
  verify(options: unknown): Promise<PlatformerAdmission>;
}

export class RejectDirectAdmissionVerifier implements PlatformerAdmissionVerifier {
  async verify(_options: unknown): Promise<PlatformerAdmission> {
    throw new Error(
      'Direct joins are disabled. Use a trusted seat reservation; Supabase ticket admission is not wired yet.',
    );
  }
}

export function assertAdmissionMatchesRoom(
  admission: PlatformerAdmission,
  options: PlatformerRoomOptions,
): void {
  const expectedUser = options.assignment[admission.role];
  if (
    admission.gameSessionId !== options.gameSessionId ||
    admission.pairingId !== options.pairingId ||
    admission.userId !== expectedUser ||
    admission.catalogFingerprint !== options.catalogFingerprint
  ) {
    throw new Error('Admission does not match this room or its immutable role assignment');
  }
}
