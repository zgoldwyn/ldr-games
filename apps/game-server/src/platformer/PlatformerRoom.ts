import { Room, type Client } from 'colyseus';
import {
  ELEMENTAL_AUTHORED_LEVELS,
  elementalCrystalMaskForRole,
  elementalLevel,
  type ElementalLevel,
  type ElementalRole,
  type ElementalRoleAssignment,
} from '@ldr/core';

import {
  assertAdmissionMatchesRoom,
  RejectDirectAdmissionVerifier,
  type PlatformerAdmission,
  type PlatformerRoomOptions,
} from './admission.js';
import {
  PLATFORMER_CATALOG_FINGERPRINT,
  PLATFORMER_CATALOG_MISMATCH_MESSAGE,
  PLATFORMER_MAX_CLIENTS,
  PLATFORMER_PATCH_RATE_MS,
  PLATFORMER_PHYSICS_SUBSTEPS,
  PLATFORMER_TICK_RATE,
} from './constants.js';
import { IDLE_PLATFORMER_INPUT, PlatformerInput } from './input.js';
import {
  collectPlatformerCrystals,
  evaluatePlatformerGates,
  nextPlatformerLeverActivated,
  nextPlatformerElapsedTicks,
  platformerCrateSupportY,
  resetPlatformerCrystalsForRole,
  stepPlatformerCrate,
  stepPlatformerPlayer,
} from './simulation.js';
import { PlatformerPlayer, PlatformerState } from './state.js';
import { PROCESS_PROVISIONING_NONCE } from './provisioning.js';
import { LEVEL_RELOAD_TOKEN } from './level-reload-token.js';
import { savePairingProgress } from './progress.js';

void LEVEL_RELOAD_TOKEN;

type PlatformerClient = Client<{ auth: PlatformerAdmission }>;

export class PlatformerRoom extends Room<{
  state: PlatformerState;
  input: PlatformerInput;
  client: PlatformerClient;
}> {
  override state = new PlatformerState();
  override inputs = this.defineInput(PlatformerInput, {
    bufferMaxSize: 64,
    idle: () => IDLE_PLATFORMER_INPUT,
  });

  private readonly directAdmissionVerifier = new RejectDirectAdmissionVerifier();
  private readonly rolesBySessionId = new Map<string, ElementalRole>();
  private readonly leverInputHeldByRole = new Map<ElementalRole, boolean>();
  private roomOptions: PlatformerRoomOptions | null = null;

  override onCreate(options: PlatformerRoomOptions): void {
    if (options.provisioningNonce !== PROCESS_PROVISIONING_NONCE) {
      throw new Error('Platformer rooms must be created by the trusted provisioning flow');
    }
    if (options.catalogFingerprint !== PLATFORMER_CATALOG_FINGERPRINT) {
      throw new Error(PLATFORMER_CATALOG_MISMATCH_MESSAGE);
    }
    if (
      !Number.isInteger(options.startLevel) ||
      options.startLevel < 1 ||
      options.startLevel > ELEMENTAL_AUTHORED_LEVELS.length
    ) {
      throw new Error('The saved platformer level is invalid for this catalog');
    }

    this.roomOptions = options;
    const startingLevel = elementalLevel(options.startLevel);
    this.state = new PlatformerState({
      gameSessionId: options.gameSessionId,
      tick: 0,
      elapsedTicks: 0,
      emberAtGate: false,
      tideAtGate: false,
      completed: false,
      collectedCrystalMask: 0,
      currentLevel: options.startLevel,
      leverActivated: false,
      buttonPressed: false,
      crateX: 'mechanics' in startingLevel ? startingLevel.mechanics.pushable.x : 0,
    });
    this.maxClients = PLATFORMER_MAX_CLIENTS;
    this.patchRate = PLATFORMER_PATCH_RATE_MS;
    this.setPrivate();
    void this.setMatchmaking({ unlisted: true });

    this.addAssignedPlayer(options.assignment, 'ember', startingLevel);
    this.addAssignedPlayer(options.assignment, 'tide', startingLevel);
    this.onMessage('restart-level', (client) => {
      if (this.rolesBySessionId.get(client.sessionId) === options.assignment.creatorRole) {
        this.resetPlayers();
      }
    });
    this.onMessage('advance-level', (client) => {
      if (
        this.rolesBySessionId.get(client.sessionId) === options.assignment.creatorRole &&
        this.state.currentLevel < ELEMENTAL_AUTHORED_LEVELS.length &&
        this.state.completed
      ) {
        const nextLevel = this.state.currentLevel + 1;
        this.state.currentLevel = nextLevel;
        void savePairingProgress(options.pairingId, nextLevel).catch((error: unknown) => {
          console.error('Unable to persist Ember & Tide progress', error);
        });
        this.resetPlayers();
      }
    });

    this.setFixedTimestep(
      (context) => {
        const level = this.level();
        const bothConnected = (['ember', 'tide'] as const).every(
          (role) => this.state.players.get(role)?.connected,
        );
        if (!bothConnected) {
          for (const [sessionId] of this.rolesBySessionId) this.inputs.get(sessionId).next();
          for (const role of ['ember', 'tide'] as const) {
            const player = this.state.players.get(role);
            if (player) {
              player.velocityX = 0;
              player.velocityY = 0;
            }
          }
          this.state.tick = context.tick;
          return;
        }
        if (this.state.completed) {
          for (const [sessionId] of this.rolesBySessionId) this.inputs.get(sessionId).next();
          this.state.tick = context.tick;
          return;
        }
        this.state.elapsedTicks = nextPlatformerElapsedTicks(
          this.state.elapsedTicks,
          bothConnected,
          this.state.completed,
        );
        const tickInputs = new Map<ElementalRole, PlatformerInput>();
        for (const [sessionId, role] of this.rolesBySessionId) {
          const player = this.state.players.get(role);
          const input = this.inputs.get(sessionId).next();
          if (player && input) {
            tickInputs.set(role, input);
            const activatedPlatformActive = this.activatedPlatformIsActive(level);
            const disabledHazardId =
              'mechanics' in level && activatedPlatformActive
                ? level.mechanics.activatedPlatform.hazardId
                : undefined;
            const died = stepPlatformerPlayer(
              player,
              input,
              context,
              role,
              level,
              disabledHazardId,
              'mechanics' in level ? this.state.crateX : undefined,
              activatedPlatformActive,
            );
            if (died) {
              player.deaths += 1;
              this.state.collectedCrystalMask = resetPlatformerCrystalsForRole(
                this.state.collectedCrystalMask,
                role,
                level,
              );
            }
            this.updateLeverForPlayer(player, input, level);
          }
        }
        if ('mechanics' in level) {
          const pushers = (['ember', 'tide'] as const).flatMap((role) => {
            const player = this.state.players.get(role);
            const input = tickInputs.get(role);
            return player && input ? [{ player, input }] : [];
          });
          this.state.crateX = stepPlatformerCrate(
            this.state.crateX,
            pushers,
            context.dt,
            level,
            this.activatedPlatformIsActive(level),
          );
        }
        this.updateHeldButton(level);
        this.state.collectedCrystalMask = collectPlatformerCrystals(
          this.state.players.get('ember'),
          this.state.players.get('tide'),
          this.state.collectedCrystalMask,
          level,
        );
        this.updateGateState(level);
        this.state.tick = context.tick;
      },
      PLATFORMER_TICK_RATE,
      { subSteps: PLATFORMER_PHYSICS_SUBSTEPS },
    );
  }

  override async onAuth(client: PlatformerClient, options: unknown): Promise<PlatformerAdmission> {
    // Server-created reservations arrive with auth data already attached. A
    // direct client join has none and falls through to the future ticket seam.
    if (client.auth) {
      assertAdmissionMatchesRoom(client.auth, this.requireRoomOptions());
      return client.auth;
    }
    return this.directAdmissionVerifier.verify(options);
  }

  override onJoin(client: PlatformerClient, _options: unknown, auth?: PlatformerAdmission): void {
    const admission = auth ?? client.auth;
    if (!admission) throw new Error('A trusted platformer admission is required');
    const roomOptions = this.requireRoomOptions();
    assertAdmissionMatchesRoom(admission, roomOptions);

    const player = this.state.players.get(admission.role);
    if (!player || player.connected) {
      throw new Error('The assigned platformer seat is unavailable');
    }
    player.connected = true;
    this.rolesBySessionId.set(client.sessionId, admission.role);
  }

  override async onDrop(client: PlatformerClient): Promise<void> {
    this.setConnected(client.sessionId, false);
    try {
      await this.allowReconnection(client, 20);
      this.setConnected(client.sessionId, true);
    } catch {
      this.rolesBySessionId.delete(client.sessionId);
    }
  }

  override onLeave(client: PlatformerClient): void {
    this.setConnected(client.sessionId, false);
    this.rolesBySessionId.delete(client.sessionId);
  }

  private addAssignedPlayer(
    assignment: ElementalRoleAssignment,
    role: ElementalRole,
    level: ElementalLevel,
  ): void {
    this.state.players.set(
      role,
      new PlatformerPlayer({
        accountId: assignment[role],
        role,
        x: level.spawns[role],
        y: level.spawnY[role],
        velocityX: 0,
        velocityY: 0,
        grounded: true,
        connected: false,
        deaths: 0,
      }),
    );
  }

  private setConnected(sessionId: string, connected: boolean): void {
    const role = this.rolesBySessionId.get(sessionId);
    const player = role ? this.state.players.get(role) : undefined;
    if (player) player.connected = connected;
  }

  private resetPlayers(): void {
    const level = this.level();
    const ember = this.state.players.get('ember');
    const tide = this.state.players.get('tide');
    if (ember)
      Object.assign(ember, {
        x: level.spawns.ember,
        y: level.spawnY.ember,
        velocityX: 0,
        velocityY: 0,
        grounded: true,
      });
    if (tide)
      Object.assign(tide, {
        x: level.spawns.tide,
        y: level.spawnY.tide,
        velocityX: 0,
        velocityY: 0,
        grounded: true,
      });
    this.state.emberAtGate = false;
    this.state.tideAtGate = false;
    this.state.completed = false;
    this.state.elapsedTicks = 0;
    this.state.collectedCrystalMask = 0;
    this.state.leverActivated = false;
    this.state.buttonPressed = false;
    this.state.crateX = 'mechanics' in level ? level.mechanics.pushable.x : 0;
    this.leverInputHeldByRole.clear();
  }

  private updateGateState(level: ElementalLevel): void {
    const mechanicsReady =
      !('mechanics' in level) ||
      ((level.mechanics.lever.target !== 'gates' || this.state.leverActivated) &&
        (level.mechanics.pressurePlate.target !== 'gates' || this.state.buttonPressed));
    const emberMask = elementalCrystalMaskForRole('ember', level);
    const tideMask = elementalCrystalMaskForRole('tide', level);
    const gates = evaluatePlatformerGates(
      this.state.players.get('ember'),
      this.state.players.get('tide'),
      {
        ember: mechanicsReady && (this.state.collectedCrystalMask & emberMask) === emberMask,
        tide: mechanicsReady && (this.state.collectedCrystalMask & tideMask) === tideMask,
      },
      level,
    );
    this.state.emberAtGate = gates.emberAtGate;
    this.state.tideAtGate = gates.tideAtGate;
    this.state.completed = gates.completed;
  }

  private updateLeverForPlayer(
    player: PlatformerPlayer,
    input: PlatformerInput,
    level: ElementalLevel,
  ): void {
    if (!('mechanics' in level)) return;
    const wasHeld = this.leverInputHeldByRole.get(player.role as ElementalRole) ?? false;
    this.leverInputHeldByRole.set(player.role as ElementalRole, input.interact);
    const playerCenter = player.x + level.playerWidth / 2;
    const inReach =
      Math.abs(player.y - level.mechanics.lever.y) <= 0.25 &&
      Math.abs(playerCenter - (level.mechanics.lever.x + level.mechanics.lever.width / 2)) <=
        level.mechanics.lever.reach;
    this.state.leverActivated = nextPlatformerLeverActivated(
      this.state.leverActivated,
      input.interact,
      wasHeld,
      inReach,
    );
  }

  private updateHeldButton(level: ElementalLevel): void {
    if (!('mechanics' in level)) {
      this.state.buttonPressed = false;
      return;
    }
    const button = level.mechanics.pressurePlate;
    const pushable = level.mechanics.pushable;
    const crateY = platformerCrateSupportY(this.state.crateX, level);
    const cratePressed =
      this.state.crateX + pushable.width > button.x &&
      this.state.crateX < button.x + button.width &&
      Math.abs(crateY - button.y) <= 0.25;
    const playerPressed = (['ember', 'tide'] as const).some((role) => {
      const player = this.state.players.get(role);
      if (!player || Math.abs(player.y - button.y) > 0.25) return false;
      const center = player.x + level.playerWidth / 2;
      return center >= button.x && center <= button.x + button.width;
    });
    this.state.buttonPressed = cratePressed || playerPressed;
  }

  private activatedPlatformIsActive(level: ElementalLevel): boolean {
    if (!('mechanics' in level)) return false;
    const leverControlsPlatform = level.mechanics.lever.target === 'activatedPlatform';
    const plateControlsPlatform = level.mechanics.pressurePlate.target === 'activatedPlatform';
    if (!leverControlsPlatform && !plateControlsPlatform) return false;
    return (
      (!leverControlsPlatform || this.state.leverActivated) &&
      (!plateControlsPlatform || this.state.buttonPressed)
    );
  }

  private level(): ElementalLevel {
    return elementalLevel(this.state.currentLevel);
  }

  private requireRoomOptions(): PlatformerRoomOptions {
    if (!this.roomOptions) throw new Error('Platformer room has not been initialized');
    return this.roomOptions;
  }
}
