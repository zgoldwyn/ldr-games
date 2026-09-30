import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Predict, type Room } from '@colyseus/sdk';
import {
  countCollectedElementalCrystals,
  ELEMENTAL_AUTHORED_LEVELS,
  ELEMENTAL_PLATFORMER_TICKS_PER_SECOND,
  elementalCrystalMaskForRole,
  elementalLevel,
  elementalRampSurfaceY,
  ELEMENTAL_GROVE_LEVEL,
  type ElementalLevel,
  type ElementalRole,
} from '@ldr/core';
import { Gesture, GestureDetector, type GestureType } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { useApp } from '../app-context';
import { readGameServerDevConfig } from '../config';
import {
  bestTicksForLevel,
  loadElementalBestTimes,
  recordElementalBestTime,
  type ElementalBestTimes,
} from '../games/elemental-best-times';
import {
  claimDevPlatformerSeat,
  connectToPlatformerRoom,
  isExpiredSeatReservationError,
} from '../games/elemental-online';
import {
  ELEMENTAL_FLOOR_Y,
  ELEMENTAL_GATES,
  ELEMENTAL_PLATFORMS,
  ELEMENTAL_PLAYER_SIZE,
  ELEMENTAL_VIEWPORT_WIDTH,
  ELEMENTAL_WORLD_HEIGHT,
  ELEMENTAL_WORLD_WIDTH,
  elementalCameraOffset,
  elementalSpectatorZoom,
  elementalStageScale,
  isElementalPlayerAtGate,
  isElementalPlayerOnPlatform,
  stepElementalPlayer,
  elementalVerticalCameraOffset,
} from '../games/elemental-platformer';
import { useGameKeyboardControls } from '../games/use-game-keyboard-controls';
import {
  ONLINE_LOCAL_CORRECTION_SMOOTH_MS,
  ONLINE_PLATFORMER_INPUT_RATE,
  ONLINE_PLATFORMER_PATCH_INTERVAL_MS,
  ONLINE_REMOTE_INTERPOLATION_DELAY_MS,
  elementalCrystalScreenPosition,
  landPredictedPlayerOnFloor,
  respawnPredictedPlayer,
} from '../games/elemental-online-prediction';
import type { RootStackParamList } from '../navigation';
import { bulkKv } from '../session/expo-kv';
import { AppButton } from '../ui/AppButton';
import { AppText } from '../ui/AppText';
import { Screen } from '../ui/Screen';
import { clayInsetStyle, clayPressedStyle, clayRaisedStyle } from '../ui/clay';
import { ClayElementalSprite } from '../ui/ClayElementalSprite';

const ONLINE_VIEWPORT_WIDTH = 38;
const ONLINE_WORLD_PIXEL_HEIGHT = 460;
const ONLINE_FLOOR_Y = 390;

type OnlinePlayer = {
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  grounded: boolean;
  connected: boolean;
  deaths: number;
};

type OnlineState = {
  elapsedTicks: number;
  emberAtGate: boolean;
  tideAtGate: boolean;
  completed: boolean;
  collectedCrystalMask: number;
  currentLevel: number;
  leverActivated: boolean;
  buttonPressed: boolean;
  crateX: number;
  players: { get(role: ElementalRole): OnlinePlayer | undefined };
};

function formatElementalTime(ticks: number): string {
  const totalTenths = Math.floor((ticks * 10) / ELEMENTAL_PLATFORMER_TICKS_PER_SECOND);
  const minutes = Math.floor(totalTenths / 600);
  const seconds = Math.floor((totalTenths % 600) / 10);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${totalTenths % 10}`;
}

type OnlineInput = { moveX: -1 | 0 | 1; jump: boolean; interact: boolean };

function onlineCrateSupportY(level: ElementalLevel, crateX: number): number {
  'worklet';
  if (!('mechanics' in level)) return 0;
  const crate = level.mechanics.pushable;
  const centerX = crateX + crate.width / 2;
  const ramp = (level.ramps ?? []).find(
    (candidate) => centerX >= candidate.x && centerX <= candidate.x + candidate.width,
  );
  if (ramp) {
    const progress = Math.max(0, Math.min(1, (centerX - ramp.x) / ramp.width));
    return ramp.y + (ramp.direction === 'up-right' ? progress : 1 - progress) * ramp.height;
  }
  for (const candidate of level.ramps ?? []) {
    const highX = candidate.direction === 'up-right' ? candidate.x + candidate.width : candidate.x;
    const highY = candidate.y + candidate.height;
    const surfaces = [
      ...level.solids.map((solid) => ({
        x: solid.x,
        width: solid.width,
        y: solid.y + solid.height,
      })),
      ...level.platforms.map((platform) => ({
        x: platform.x,
        width: platform.width,
        y: platform.y,
      })),
    ];
    const support = surfaces.find((surface) => {
      const joined =
        candidate.direction === 'up-right'
          ? Math.abs(surface.x - highX) <= 0.15
          : Math.abs(surface.x + surface.width - highX) <= 0.15;
      return (
        joined &&
        Math.abs(surface.y - highY) <= 0.15 &&
        centerX >= surface.x &&
        centerX <= surface.x + surface.width
      );
    });
    if (support) return support.y;
  }
  return crate.y;
}

function isActivatedPlatformActive(
  level: ElementalLevel,
  leverActivated: boolean,
  pressurePlatePressed: boolean,
): boolean {
  if (!('mechanics' in level)) return false;
  const leverControls = level.mechanics.lever.target === 'activatedPlatform';
  const plateControls = level.mechanics.pressurePlate.target === 'activatedPlatform';
  return (
    (leverControls || plateControls) &&
    (!leverControls || leverActivated) &&
    (!plateControls || pressurePlatePressed)
  );
}

function applyOnlineInput(
  context: { subSteps: number; subDt: number },
  player: OnlinePlayer,
  input: OnlineInput,
  role: ElementalRole,
  level: ElementalLevel,
  disabledHazardId?: string,
  cratePosition?: number,
  activatedPlatformActive = false,
): void {
  player.velocityX = input.moveX * level.moveSpeed;
  if (input.jump && player.grounded) {
    player.velocityY = level.jumpSpeed;
    player.grounded = false;
  }
  for (let index = 0; index < context.subSteps; index += 1) {
    player.velocityY += level.gravity * context.subDt;
    const previousX = player.x;
    const previousY = player.y;
    player.x = Math.max(
      0,
      Math.min(level.width - level.playerWidth, player.x + player.velocityX * context.subDt),
    );
    const horizontalSolid = level.solids.find((solid) => {
      const overlapsVertically =
        previousY < solid.y + solid.height && previousY + level.playerWidth > solid.y;
      if (!overlapsVertically) return false;
      return player.velocityX > 0
        ? previousX + level.playerWidth <= solid.x && player.x + level.playerWidth > solid.x
        : player.velocityX < 0
          ? previousX >= solid.x + solid.width && player.x < solid.x + solid.width
          : false;
    });
    if (horizontalSolid) {
      player.x =
        player.velocityX > 0
          ? horizontalSolid.x - level.playerWidth
          : horizontalSolid.x + horizontalSolid.width;
      player.velocityX = 0;
    }
    player.y += player.velocityY * context.subDt;
    if (previousY > 0) player.grounded = false;
    const solidLanding = level.solids.find(
      (solid) =>
        player.velocityY <= 0 &&
        previousY >= solid.y + solid.height &&
        player.y <= solid.y + solid.height &&
        player.x + level.playerWidth > solid.x &&
        player.x < solid.x + solid.width,
    );
    if (solidLanding) {
      player.y = solidLanding.y + solidLanding.height;
      player.velocityY = 0;
      player.grounded = true;
      continue;
    }
    const solidCeiling = level.solids.find(
      (solid) =>
        player.velocityY > 0 &&
        previousY + level.playerWidth <= solid.y &&
        player.y + level.playerWidth >= solid.y &&
        player.x + level.playerWidth > solid.x &&
        player.x < solid.x + solid.width,
    );
    if (solidCeiling) {
      player.y = solidCeiling.y - level.playerWidth;
      player.velocityY = 0;
    }
    const activePlatforms =
      'mechanics' in level && activatedPlatformActive
        ? [...level.platforms, level.mechanics.activatedPlatform]
        : level.platforms;
    const landedPlatform = activePlatforms.find(
      (platform) =>
        (platform.element === 'neutral' || platform.element === role) &&
        player.velocityY <= 0 &&
        previousY >= platform.y &&
        player.y <= platform.y &&
        player.x + level.playerWidth > platform.x &&
        player.x < platform.x + platform.width,
    );
    if (landedPlatform) {
      player.y = landedPlatform.y;
      player.velocityY = 0;
      player.grounded = true;
      continue;
    }
    const playerCenterX = player.x + level.playerWidth / 2;
    const previousCenterX = previousX + level.playerWidth / 2;
    const landedRamp = (level.ramps ?? []).find((ramp) => {
      if (ramp.element !== 'neutral' && ramp.element !== role) return false;
      if (playerCenterX < ramp.x || playerCenterX > ramp.x + ramp.width) return false;
      return (
        player.velocityY <= 0 &&
        previousY >= elementalRampSurfaceY(ramp, previousCenterX) - 0.12 &&
        player.y <= elementalRampSurfaceY(ramp, playerCenterX) + 0.12
      );
    });
    if (landedRamp) {
      player.y = elementalRampSurfaceY(landedRamp, playerCenterX);
      player.velocityY = 0;
      player.grounded = true;
      continue;
    }
    if ('mechanics' in level && cratePosition !== undefined) {
      const crate = level.mechanics.pushable;
      const crateY = onlineCrateSupportY(level, cratePosition);
      const overlapsCrate =
        player.x + level.playerWidth > cratePosition && player.x < cratePosition + crate.width;
      if (
        overlapsCrate &&
        player.velocityY <= 0 &&
        previousY >= crateY + crate.height &&
        player.y <= crateY + crate.height
      ) {
        player.y = crateY + crate.height;
        player.velocityY = 0;
        player.grounded = true;
        continue;
      }
    }
    if (player.y <= 0) {
      landPredictedPlayerOnFloor(player);
    }
    const centerX = player.x + level.playerWidth / 2;
    const wrongHazard = level.hazards.find(
      (hazard) =>
        hazard.id !== disabledHazardId &&
        role !== hazard.safeRole &&
        player.y <= 0.05 &&
        centerX >= hazard.x &&
        centerX <= hazard.x + hazard.width,
    );
    if (wrongHazard) {
      respawnPredictedPlayer(player, role, level);
      return;
    }
    if (
      'mechanics' in level &&
      cratePosition !== undefined &&
      player.y < onlineCrateSupportY(level, cratePosition) + level.mechanics.pushable.height - 0.05
    ) {
      const crate = level.mechanics.pushable;
      const crateY = onlineCrateSupportY(level, cratePosition);
      const previousCenter = player.x - player.velocityX * context.subDt + level.playerWidth / 2;
      const crateCenter = cratePosition + crate.width / 2;
      if (
        player.y + level.playerWidth > crateY &&
        previousCenter <= crateCenter &&
        player.x + level.playerWidth > cratePosition
      ) {
        player.x = cratePosition - level.playerWidth;
      } else if (
        player.y + level.playerWidth > crateY &&
        previousCenter > crateCenter &&
        player.x < cratePosition + crate.width
      ) {
        player.x = cratePosition + crate.width;
      }
    }
  }
}

export function ElementalDuetScreen() {
  const params = useRoute<RouteProp<RootStackParamList, 'ElementalDuet'>>().params;
  return params.access ? (
    <OnlineElementalDuetScreen assignedRole={params.role} access={params.access} />
  ) : (
    <SoloElementalDuetScreen assignedRole={params.role} />
  );
}

function OnlineElementalDuetScreen({
  assignedRole,
  access,
}: {
  readonly assignedRole: ElementalRole;
  readonly access: NonNullable<RootStackParamList['ElementalDuet']['access']>;
}) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { tokens, identity } = useApp();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const [boardWidth, setBoardWidth] = useState(ELEMENTAL_VIEWPORT_WIDTH);
  const [boardHeight, setBoardHeight] = useState(380);
  const [status, setStatus] = useState<
    'connecting' | 'waiting' | 'playing' | 'reconnecting' | 'error'
  >('connecting');
  const [errorMessage, setErrorMessage] = useState('');
  const [gates, setGates] = useState({
    ember: false,
    tide: false,
    completed: false,
    collectedCrystalMask: 0,
    currentLevel: 1,
    leverActivated: false,
    buttonPressed: false,
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [elapsedTicks, setElapsedTicks] = useState(0);
  const [bestTimes, setBestTimes] = useState<ElementalBestTimes>({});
  const [bestTimesUnavailable, setBestTimesUnavailable] = useState(false);
  const [completedRun, setCompletedRun] = useState<{ levelNumber: number; ticks: number } | null>(
    null,
  );
  const pairingId = identity.pairing?.id ?? access.gameSessionId;
  const [connectionAccess, setConnectionAccess] = useState(access);
  const automaticReservationRefreshes = useRef(0);
  const roomRef = useRef<Room | null>(null);
  const horizontalRef = useRef<-1 | 0 | 1>(0);
  const jumpRef = useRef(false);
  const interactRef = useRef(false);
  const gameplayPausedRef = useRef(true);
  const levelRef = useRef<ElementalLevel>(ELEMENTAL_GROVE_LEVEL);
  const leverActivatedRef = useRef(false);
  const buttonPressedRef = useRef(false);
  const cratePositionRef = useRef(0);
  const crateX = useSharedValue(0);
  const emberX = useSharedValue(3);
  const emberY = useSharedValue(0);
  const emberVx = useSharedValue(0);
  const emberVy = useSharedValue(0);
  const emberGrounded = useSharedValue(true);
  const tideX = useSharedValue(6);
  const tideY = useSharedValue(0);
  const tideVx = useSharedValue(0);
  const tideVy = useSharedValue(0);
  const tideGrounded = useSharedValue(true);
  const emberDeath = useSharedValue(0);
  const tideDeath = useSharedValue(0);
  const cameraZoom = useSharedValue(1);
  const reducedMotion = useReducedMotion();

  const setKeyboardHorizontal = useCallback((value: -1 | 0 | 1) => {
    horizontalRef.current = gameplayPausedRef.current ? 0 : value;
  }, []);
  const queueKeyboardJump = useCallback(() => {
    if (!gameplayPausedRef.current) jumpRef.current = true;
  }, []);
  const queueKeyboardInteract = useCallback(() => {
    if (!gameplayPausedRef.current) interactRef.current = true;
  }, []);
  useGameKeyboardControls({
    onHorizontalChange: setKeyboardHorizontal,
    onJump: queueKeyboardJump,
    onInteract: queueKeyboardInteract,
  });

  useEffect(() => {
    let active = true;
    void loadElementalBestTimes(bulkKv, pairingId)
      .then((records) => {
        if (active) setBestTimes(records);
      })
      .catch(() => {
        if (active) setBestTimesUnavailable(true);
      });
    return () => {
      active = false;
    };
  }, [pairingId]);

  useEffect(() => {
    if (!completedRun || completedRun.ticks <= 0) return;
    void recordElementalBestTime(
      bulkKv,
      pairingId,
      elementalLevel(completedRun.levelNumber),
      completedRun.ticks,
    )
      .then((records) => {
        setBestTimes(records);
        setBestTimesUnavailable(false);
      })
      .catch(() => setBestTimesUnavailable(true));
  }, [completedRun, pairingId]);

  useEffect(() => {
    gameplayPausedRef.current = status !== 'playing';
    if (status !== 'playing') {
      horizontalRef.current = 0;
      jumpRef.current = false;
      interactRef.current = false;
    }
  }, [status]);

  const requestFreshReservation = useCallback(async () => {
    const config = readGameServerDevConfig();
    const self = identity.session?.accountId;
    const pairing = identity.pairing;
    if (!config || !self || !pairing) {
      throw new Error('Local game-server configuration or pairing is unavailable.');
    }
    return claimDevPlatformerSeat(config, pairing.id, self);
  }, [identity.pairing, identity.session?.accountId]);

  useEffect(() => {
    const config = readGameServerDevConfig();
    if (!config) {
      setErrorMessage('The local game-server URL/key is missing or is not a local address.');
      setStatus('error');
      return;
    }

    let disposed = false;
    let frameId: number | undefined;
    let initialStateTimeout: ReturnType<typeof setTimeout> | undefined;
    let room: Room | undefined;
    let recoveringReservation = false;

    const recoverExpiredReservation = async (error: unknown): Promise<boolean> => {
      if (!isExpiredSeatReservationError(error) || automaticReservationRefreshes.current >= 1) {
        return false;
      }
      automaticReservationRefreshes.current += 1;
      recoveringReservation = true;
      setStatus('connecting');
      setErrorMessage('Refreshing your game seat…');
      try {
        const freshAccess = await requestFreshReservation();
        if (!disposed) setConnectionAccess(freshAccess);
      } catch (refreshError) {
        if (!disposed) {
          setErrorMessage(
            refreshError instanceof Error
              ? refreshError.message
              : 'Unable to refresh the game seat.',
          );
          setStatus('error');
        }
      }
      return true;
    };

    const connect = async () => {
      setStatus('connecting');
      try {
        room = await connectToPlatformerRoom(config, connectionAccess);
        if (disposed) {
          await room.leave();
          return;
        }
        roomRef.current = room;
        const input = room.input<OnlineInput>({ mode: 'reliable' });
        if (input.tickRate !== ONLINE_PLATFORMER_INPUT_RATE)
          throw new Error(
            `Game server did not advertise a ${ONLINE_PLATFORMER_INPUT_RATE} Hz input rate`,
          );
        const predict = Predict.get(room, {
          mode: 'lerp',
          delay: ONLINE_REMOTE_INTERPOLATION_DELAY_MS,
          tickInterval: ONLINE_PLATFORMER_PATCH_INTERVAL_MS,
        });
        let initialized = false;
        let lastPartnerConnected: boolean | undefined;
        let lastGateSignature = '';
        let lastCrateLevel: number | undefined;
        let lastEmberDeaths: number | undefined;
        let lastTideDeaths: number | undefined;
        let lastShownTicks = -1;
        let lastCompleted = false;
        let emberDeathActive = false;
        let tideDeathActive = false;
        let emberDeathUntil = 0;
        let tideDeathUntil = 0;
        let local: OnlinePlayer | undefined;
        let remote: OnlinePlayer | undefined;

        const onState = (rawState: unknown) => {
          const state = rawState as OnlineState;
          local = state.players.get(assignedRole);
          remote = state.players.get(assignedRole === 'ember' ? 'tide' : 'ember');
          if (!local || !remote) return;
          const emberPlayer = state.players.get('ember');
          const tidePlayer = state.players.get('tide');
          if (!emberPlayer || !tidePlayer) return;
          if (lastEmberDeaths !== undefined && emberPlayer.deaths !== lastEmberDeaths) {
            emberDeathActive = true;
            emberDeathUntil = Date.now() + (reducedMotion ? 110 : 190);
            emberDeath.set(
              withTiming(1, {
                duration: reducedMotion ? 90 : 170,
                easing: Easing.bezier(0.23, 1, 0.32, 1),
              }),
            );
          }
          if (lastTideDeaths !== undefined && tidePlayer.deaths !== lastTideDeaths) {
            tideDeathActive = true;
            tideDeathUntil = Date.now() + (reducedMotion ? 110 : 190);
            tideDeath.set(
              withTiming(1, {
                duration: reducedMotion ? 90 : 170,
                easing: Easing.bezier(0.23, 1, 0.32, 1),
              }),
            );
          }
          lastEmberDeaths = emberPlayer.deaths;
          lastTideDeaths = tidePlayer.deaths;
          levelRef.current = elementalLevel(state.currentLevel);
          leverActivatedRef.current = state.leverActivated;
          buttonPressedRef.current = state.buttonPressed;
          cratePositionRef.current = state.crateX;
          if (reducedMotion || lastCrateLevel !== state.currentLevel) {
            crateX.set(state.crateX);
          } else {
            crateX.set(withTiming(state.crateX, { duration: 70, easing: Easing.linear }));
          }
          lastCrateLevel = state.currentLevel;

          if (
            Math.floor(state.elapsedTicks / 3) !== Math.floor(lastShownTicks / 3) ||
            (state.completed && state.elapsedTicks !== lastShownTicks)
          ) {
            lastShownTicks = state.elapsedTicks;
            setElapsedTicks(state.elapsedTicks);
          }
          if (state.completed && !lastCompleted) {
            setCompletedRun({ levelNumber: state.currentLevel, ticks: state.elapsedTicks });
          }
          lastCompleted = state.completed;

          const gateSignature = `${state.emberAtGate}-${state.tideAtGate}-${state.completed}-${state.collectedCrystalMask}-${state.currentLevel}-${state.leverActivated}-${state.buttonPressed}`;
          if (gateSignature !== lastGateSignature) {
            lastGateSignature = gateSignature;
            setGates({
              ember: state.emberAtGate,
              tide: state.tideAtGate,
              completed: state.completed,
              collectedCrystalMask: state.collectedCrystalMask,
              currentLevel: state.currentLevel,
              leverActivated: state.leverActivated,
              buttonPressed: state.buttonPressed,
            });
          }

          if (!initialized) {
            initialized = true;
            automaticReservationRefreshes.current = 0;
            if (initialStateTimeout) clearTimeout(initialStateTimeout);
            predict.attachAll(
              'players' as never,
              {
                fields: ['x', 'y'],
                mode: 'lerp',
                delay: ONLINE_REMOTE_INTERPOLATION_DELAY_MS,
                tickInterval: ONLINE_PLATFORMER_PATCH_INTERVAL_MS,
              } as never,
            );
            predict.reconciler(local, {
              input,
              fields: ['x', 'y', 'velocityX', 'velocityY', 'grounded'],
              step: (context, player, inputData) =>
                applyOnlineInput(
                  context,
                  player,
                  inputData,
                  assignedRole,
                  levelRef.current,
                  isActivatedPlatformActive(
                    levelRef.current,
                    leverActivatedRef.current,
                    buttonPressedRef.current,
                  ) && 'mechanics' in levelRef.current
                    ? levelRef.current.mechanics.activatedPlatform.hazardId
                    : undefined,
                  cratePositionRef.current,
                  isActivatedPlatformActive(
                    levelRef.current,
                    leverActivatedRef.current,
                    buttonPressedRef.current,
                  ),
                ),
              smoothMs: ONLINE_LOCAL_CORRECTION_SMOOTH_MS,
            });
          }

          if (remote.connected !== lastPartnerConnected) {
            lastPartnerConnected = remote.connected;
            gameplayPausedRef.current = !remote.connected;
            setStatus(remote.connected ? 'playing' : 'waiting');
          }
        };
        room.onStateChange(onState);
        room.onDrop(() => {
          gameplayPausedRef.current = true;
          setStatus('reconnecting');
        });
        room.onReconnect(() => {
          gameplayPausedRef.current = !lastPartnerConnected;
          setStatus(lastPartnerConnected ? 'playing' : 'waiting');
        });
        room.onError((code, message) => {
          void (async () => {
            if (await recoverExpiredReservation(new Error(`${message} (${code})`))) return;
            if (!disposed) {
              setErrorMessage(message || 'The game connection failed.');
              setStatus('error');
            }
          })();
        });
        room.onLeave(() => {
          if (!disposed && !recoveringReservation) {
            setErrorMessage('The game room closed.');
            setStatus('error');
          }
        });

        initialStateTimeout = setTimeout(() => {
          if (!initialized) {
            setErrorMessage('Timed out waiting for the initial room state.');
            setStatus('error');
          }
        }, 6_000);

        const frame = (timestamp: number) => {
          if (disposed) return;
          const steps = predict.tick(timestamp);
          for (let index = 0; index < steps; index += 1) {
            input.data.moveX = gameplayPausedRef.current ? 0 : horizontalRef.current;
            input.data.jump = gameplayPausedRef.current ? false : jumpRef.current;
            input.data.interact = gameplayPausedRef.current ? false : interactRef.current;
            input.send();
            jumpRef.current = false;
            interactRef.current = false;
          }
          if (local && remote) {
            const now = Date.now();
            const localX = predict.value(local, 'x');
            const localY = predict.value(local, 'y');
            const remoteX = predict.value(remote, 'x');
            const remoteY = predict.value(remote, 'y');
            if (assignedRole === 'ember') {
              if (!emberDeathActive) {
                emberX.set(localX);
                emberY.set(localY);
              } else if (now >= emberDeathUntil) {
                emberDeathActive = false;
                emberDeath.set(0);
                emberX.set(localX);
                emberY.set(localY);
              }
              emberVx.set(predict.value(local, 'velocityX') * 16);
              emberVy.set(-predict.value(local, 'velocityY'));
              emberGrounded.set(local.grounded);
              if (!tideDeathActive) {
                tideX.set(remoteX);
                tideY.set(remoteY);
              } else if (now >= tideDeathUntil) {
                tideDeathActive = false;
                tideDeath.set(0);
                tideX.set(remoteX);
                tideY.set(remoteY);
              }
              tideVx.set(predict.value(remote, 'velocityX') * 16);
              tideVy.set(-predict.value(remote, 'velocityY'));
              tideGrounded.set(remote.grounded);
            } else {
              if (!tideDeathActive) {
                tideX.set(localX);
                tideY.set(localY);
              } else if (now >= tideDeathUntil) {
                tideDeathActive = false;
                tideDeath.set(0);
                tideX.set(localX);
                tideY.set(localY);
              }
              tideVx.set(predict.value(local, 'velocityX') * 16);
              tideVy.set(-predict.value(local, 'velocityY'));
              tideGrounded.set(local.grounded);
              if (!emberDeathActive) {
                emberX.set(remoteX);
                emberY.set(remoteY);
              } else if (now >= emberDeathUntil) {
                emberDeathActive = false;
                emberDeath.set(0);
                emberX.set(remoteX);
                emberY.set(remoteY);
              }
              emberVx.set(predict.value(remote, 'velocityX') * 16);
              emberVy.set(-predict.value(remote, 'velocityY'));
              emberGrounded.set(remote.grounded);
            }
          }
          frameId = requestAnimationFrame(frame);
        };
        frameId = requestAnimationFrame(frame);
      } catch (error) {
        if (await recoverExpiredReservation(error)) return;
        if (!disposed) {
          setErrorMessage(
            error instanceof Error ? error.message : 'Unable to connect to the game.',
          );
          setStatus('error');
        }
      }
    };

    void connect();
    return () => {
      disposed = true;
      if (frameId !== undefined) cancelAnimationFrame(frameId);
      if (initialStateTimeout) clearTimeout(initialStateTimeout);
      roomRef.current = null;
      void room?.leave();
    };
  }, [
    assignedRole,
    connectionAccess,
    crateX,
    emberDeath,
    emberX,
    emberY,
    reducedMotion,
    requestFreshReservation,
    tideX,
    tideDeath,
    tideY,
  ]);

  const scale = boardWidth / ONLINE_VIEWPORT_WIDTH;
  const verticalScale = scale * 1.35;
  const stageScale = elementalStageScale(boardWidth);
  const level = elementalLevel(gates.currentLevel);
  const bestTicks = bestTicksForLevel(bestTimes, level);
  const playerSize = 2.05 * scale;
  const onlineWorldWidth = level.width * scale;
  const onlineWorldHeight = ONLINE_WORLD_PIXEL_HEIGHT * stageScale;
  const onlineStageHeight = Math.max(
    380,
    Math.min(windowHeight - 215, Math.min(windowWidth - 28, 420) * 1.45),
  );
  const localAtGate = assignedRole === 'ember' ? gates.ember : gates.tide;
  const emberCrystalMask = elementalCrystalMaskForRole('ember', level);
  const tideCrystalMask = elementalCrystalMaskForRole('tide', level);
  const mechanicsReady =
    !('mechanics' in level) ||
    ((level.mechanics.lever.target !== 'gates' || gates.leverActivated) &&
      (level.mechanics.pressurePlate.target !== 'gates' || gates.buttonPressed));
  const activatedPlatformActive = isActivatedPlatformActive(
    level,
    gates.leverActivated,
    gates.buttonPressed,
  );
  const emberGateUnlocked =
    mechanicsReady && (gates.collectedCrystalMask & emberCrystalMask) === emberCrystalMask;
  const tideGateUnlocked =
    mechanicsReady && (gates.collectedCrystalMask & tideCrystalMask) === tideCrystalMask;
  const localGateUnlocked = assignedRole === 'ember' ? emberGateUnlocked : tideGateUnlocked;
  const localCrystalMask = assignedRole === 'ember' ? emberCrystalMask : tideCrystalMask;
  const localShardsComplete = (gates.collectedCrystalMask & localCrystalMask) === localCrystalMask;
  const cameraTargetX = assignedRole === 'ember' ? emberX : tideX;
  const cameraTargetY = assignedRole === 'ember' ? emberY : tideY;
  useEffect(() => {
    const target = localAtGate ? elementalSpectatorZoom(boardWidth, onlineWorldWidth) : 1;
    cameraZoom.set(
      withTiming(target, {
        duration: reducedMotion ? 0 : 280,
        easing: Easing.bezier(0.77, 0, 0.175, 1),
      }),
    );
  }, [boardWidth, cameraZoom, localAtGate, onlineWorldWidth, reducedMotion]);
  const onlineCameraPanStyle = useAnimatedStyle(() => {
    const zoom = cameraZoom.get();
    const camera = elementalCameraOffset(cameraTargetX.get(), scale, boardWidth, onlineWorldWidth);
    const wideZoom = elementalSpectatorZoom(boardWidth, onlineWorldWidth);
    const progress = Math.max(0, Math.min(1, (1 - zoom) / Math.max(0.001, 1 - wideZoom)));
    const centeredX = (boardWidth - onlineWorldWidth * zoom) / 2;
    const centeredY = (boardHeight - onlineWorldHeight * zoom) / 2;
    const playerTop =
      ONLINE_FLOOR_Y * stageScale - playerSize - cameraTargetY.get() * verticalScale;
    const verticalFollow = elementalVerticalCameraOffset(playerTop, boardHeight, onlineWorldHeight);
    return {
      transform: [
        { translateX: -camera * (1 - progress) + centeredX * progress },
        { translateY: verticalFollow * (1 - progress) + centeredY * progress },
      ],
    };
  });
  const onlineCameraZoomStyle = useAnimatedStyle(() => {
    return { transform: [{ scale: cameraZoom.get() }] };
  });
  const emberStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: emberX.get() * scale },
      {
        translateY: ONLINE_FLOOR_Y * stageScale - playerSize - emberY.get() * verticalScale,
      },
    ],
  }));
  const tideStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: tideX.get() * scale },
      {
        translateY: ONLINE_FLOOR_Y * stageScale - playerSize - tideY.get() * verticalScale,
      },
    ],
  }));
  const crateStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: crateX.get() * scale },
      {
        translateY:
          ONLINE_FLOOR_Y * stageScale -
          ('mechanics' in level
            ? onlineCrateSupportY(level, crateX.get()) + level.mechanics.pushable.height
            : 2) *
            verticalScale,
      },
    ],
  }));
  const emberDeathStyle = useAnimatedStyle(() => {
    const progress = emberDeath.get();
    return {
      opacity: 1 - progress,
      transform: [
        { translateY: reducedMotion ? 0 : progress * playerSize * 0.32 },
        { rotate: `${reducedMotion ? 0 : progress * -88}deg` },
      ],
    };
  });
  const tideDeathStyle = useAnimatedStyle(() => {
    const progress = tideDeath.get();
    return {
      opacity: 1 - progress,
      transform: [
        { translateY: reducedMotion ? 0 : progress * playerSize * 0.32 },
        { rotate: `${reducedMotion ? 0 : progress * 88}deg` },
      ],
    };
  });

  const retry = async () => {
    automaticReservationRefreshes.current = 0;
    setStatus('connecting');
    setErrorMessage('Refreshing your game seat…');
    try {
      setConnectionAccess(await requestFreshReservation());
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to refresh the game seat.');
      setStatus('error');
    }
  };

  return (
    <Screen tokens={tokens} topInset={false} horizontalPadding={false}>
      <View style={styles.onlineLayout}>
        <View style={styles.onlineHeader}>
          <View style={styles.onlineHeaderCopy}>
            <View style={[styles.prototypeBadge, { backgroundColor: tokens.primary }]}>
              <AppText kind="label" tokens={tokens}>
                {level.chapter.toUpperCase()} · ONLINE
              </AppText>
            </View>
            <AppText kind="muted" tokens={tokens} numberOfLines={1}>
              {level.name} · You are {assignedRole === 'ember' ? 'Ember' : 'Tide'}
            </AppText>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Online match settings"
            accessibilityState={{ expanded: settingsOpen }}
            onPress={() => setSettingsOpen((open) => !open)}
            style={({ pressed }) => [
              styles.onlineSettingsButton,
              pressed ? clayPressedStyle(tokens) : clayRaisedStyle(tokens),
              { backgroundColor: tokens.surface },
            ]}
          >
            <AppText kind="title" tokens={tokens} style={styles.settingsIcon}>
              ⚙︎
            </AppText>
          </Pressable>
        </View>

        <GateProgress
          emberAtGate={gates.ember}
          tideAtGate={gates.tide}
          completed={gates.completed}
          collectedCrystalMask={gates.collectedCrystalMask}
          emberGateUnlocked={emberGateUnlocked}
          tideGateUnlocked={tideGateUnlocked}
          level={level}
          leverActivated={gates.leverActivated}
          buttonPressed={gates.buttonPressed}
          tokens={tokens}
        />

        <View
          style={[
            styles.onlineTimeRow,
            clayRaisedStyle(tokens),
            { backgroundColor: tokens.surface },
          ]}
        >
          <AppText kind="label" tokens={tokens}>
            {`TIME  ${formatElementalTime(elapsedTicks)}`}
          </AppText>
          <AppText kind="label" tokens={tokens}>
            {`BEST  ${bestTimesUnavailable ? 'UNAVAILABLE' : bestTicks === null ? '—' : formatElementalTime(bestTicks)}`}
          </AppText>
        </View>

        <View
          style={[
            styles.stageShell,
            styles.onlineStageShell,
            clayRaisedStyle(tokens),
            { backgroundColor: tokens.surface, height: onlineStageHeight },
          ]}
        >
          <View
            accessibilityLabel="Online Ember and Tide platformer"
            style={[
              styles.stage,
              styles.onlineStage,
              clayInsetStyle(tokens),
              { backgroundColor: tokens.surfaceMuted },
            ]}
            onLayout={(event) => {
              setBoardWidth(event.nativeEvent.layout.width);
              setBoardHeight(event.nativeEvent.layout.height);
            }}
          >
            <Animated.View style={[styles.cameraPan, onlineCameraPanStyle]}>
              <Animated.View
                style={[
                  styles.world,
                  {
                    width: onlineWorldWidth,
                    height: onlineWorldHeight,
                  },
                  onlineCameraZoomStyle,
                ]}
              >
                <ElementalBackdrop tokens={tokens} width={onlineWorldWidth} scale={stageScale} />
                {(level.environmentZones ?? [])
                  .filter((zone) => zone.environment === 'underground')
                  .map((zone) => (
                    <View
                      key={zone.id}
                      pointerEvents="none"
                      style={[
                        styles.authoredUndergroundZone,
                        {
                          left: zone.x * scale,
                          top: ONLINE_FLOOR_Y * stageScale - (zone.y + zone.height) * verticalScale,
                          width: zone.width * scale,
                          height: zone.height * verticalScale,
                        },
                      ]}
                    >
                      {[0.18, 0.42, 0.66, 0.9].map((ratio) => (
                        <View
                          key={ratio}
                          style={[styles.authoredUndergroundCourse, { top: `${ratio * 100}%` }]}
                        />
                      ))}
                    </View>
                  ))}
                {(level.entrances ?? []).map((entrance) => (
                  <View
                    key={entrance.id}
                    pointerEvents="none"
                    accessibilityLabel={`${entrance.from} to ${entrance.to} passage`}
                    style={[
                      styles.authoredEnvironmentEntrance,
                      {
                        left: entrance.x * scale,
                        top:
                          ONLINE_FLOOR_Y * stageScale -
                          (entrance.y + entrance.height) * verticalScale,
                        width: entrance.width * scale,
                        height: entrance.height * verticalScale,
                      },
                    ]}
                  />
                ))}
                <Portal
                  role="ember"
                  locked={!emberGateUnlocked}
                  tokens={tokens}
                  scale={stageScale}
                  style={{
                    left: level.gates.ember.x * scale,
                    top:
                      ONLINE_FLOOR_Y * stageScale -
                      level.gates.ember.y * verticalScale -
                      ELEMENTAL_GATES.ember.height * stageScale,
                    width: level.gates.ember.width * scale,
                    height: ELEMENTAL_GATES.ember.height * stageScale,
                  }}
                />
                <Portal
                  role="tide"
                  locked={!tideGateUnlocked}
                  tokens={tokens}
                  scale={stageScale}
                  style={{
                    left: level.gates.tide.x * scale,
                    top:
                      ONLINE_FLOOR_Y * stageScale -
                      level.gates.tide.y * verticalScale -
                      ELEMENTAL_GATES.tide.height * stageScale,
                    width: level.gates.tide.width * scale,
                    height: ELEMENTAL_GATES.tide.height * stageScale,
                  }}
                />
                {level.solids.map((solid) => (
                  <View
                    key={solid.id}
                    accessible
                    accessibilityLabel="Solid dungeon wall"
                    style={[
                      styles.dungeonSolid,
                      {
                        left: solid.x * scale,
                        top: ONLINE_FLOOR_Y * stageScale - (solid.y + solid.height) * verticalScale,
                        width: solid.width * scale,
                        height: solid.height * verticalScale,
                        backgroundColor: solid.id === 'outside-approach' ? '#627A58' : '#4A4658',
                      },
                    ]}
                  >
                    <View style={styles.dungeonSolidHighlight} />
                  </View>
                ))}
                {level.platforms.map((platform) => (
                  <View
                    key={platform.id}
                    accessible
                    accessibilityLabel={`${platform.element} platform`}
                    style={[
                      styles.platform,
                      clayRaisedStyle(tokens, true),
                      {
                        left: platform.x * scale,
                        top: ONLINE_FLOOR_Y * stageScale - platform.y * verticalScale,
                        width: platform.width * scale,
                        height: (level.number === 3 ? 8 : 9) * stageScale,
                        borderRadius: level.number === 3 ? 3 * stageScale : 999,
                        backgroundColor:
                          platform.element === 'ember'
                            ? level.number === 3
                              ? '#9A493E'
                              : '#E9A75B'
                            : platform.element === 'tide'
                              ? level.number === 3
                                ? '#286882'
                                : '#67BBDD'
                              : level.number === 3
                                ? '#676174'
                                : '#B69BD4',
                      },
                    ]}
                  >
                    <AppText
                      kind="label"
                      tokens={tokens}
                      style={{
                        fontSize: 6 * stageScale,
                        lineHeight: 8 * stageScale,
                        opacity: 0.74,
                      }}
                    >
                      {platform.element === 'ember'
                        ? '✦  ✦  ✦'
                        : platform.element === 'tide'
                          ? '≈  ≈  ≈'
                          : '•  •  •'}
                    </AppText>
                  </View>
                ))}
                {(level.ramps ?? []).map((ramp) => {
                  const rampColor =
                    ramp.element === 'ember'
                      ? '#D96B4C'
                      : ramp.element === 'tide'
                        ? '#3A9BC4'
                        : '#686A72';
                  return (
                    <View
                      key={ramp.id}
                      accessible
                      accessibilityLabel={`${ramp.element} ramp rising ${ramp.direction === 'up-right' ? 'right' : 'left'}`}
                      style={{
                        position: 'absolute',
                        zIndex: 2,
                        left: ramp.x * scale,
                        top: ONLINE_FLOOR_Y * stageScale - (ramp.y + ramp.height) * verticalScale,
                        width: ramp.width * scale,
                        height: ramp.height * verticalScale,
                        overflow: 'hidden',
                      }}
                    >
                      <View
                        style={[
                          styles.rampFace,
                          {
                            width: ramp.width * scale,
                            height: ramp.height * verticalScale,
                            backgroundColor: rampColor,
                            transform: [
                              { translateY: (ramp.height * verticalScale) / 2 },
                              { skewY: ramp.direction === 'up-right' ? '-26deg' : '26deg' },
                            ],
                          },
                        ]}
                      />
                      <View
                        style={[
                          styles.rampHighlight,
                          ramp.direction === 'up-right' ? { right: 0 } : { left: 0 },
                        ]}
                      />
                    </View>
                  );
                })}
                {level.hazards.map((hazard) => (
                  <HazardPool
                    key={hazard.id}
                    hazard={hazard}
                    scale={scale}
                    stageScale={stageScale}
                  />
                ))}
                {level.crystals.map((crystal, index) => (
                  <LevelCrystal
                    key={crystal.id}
                    role={crystal.role}
                    collected={(gates.collectedCrystalMask & (1 << index)) !== 0}
                    scale={stageScale}
                    style={elementalCrystalScreenPosition({
                      x: crystal.x,
                      y: crystal.y,
                      horizontalScale: scale,
                      verticalScale,
                      stageScale,
                      floorY: ONLINE_FLOOR_Y * stageScale,
                    })}
                  />
                ))}
                {'mechanics' in level ? (
                  <>
                    <FloorButton
                      pressed={gates.buttonPressed}
                      scale={scale}
                      stageScale={stageScale}
                      x={level.mechanics.pressurePlate.x}
                      width={level.mechanics.pressurePlate.width}
                    />
                    <Lever
                      activated={gates.leverActivated}
                      scale={scale}
                      stageScale={stageScale}
                      x={level.mechanics.lever.x}
                      width={level.mechanics.lever.width}
                    />
                    <ClayBridge
                      active={activatedPlatformActive}
                      scale={scale}
                      stageScale={stageScale}
                      hazard={
                        level.hazards.find(
                          (hazard) => hazard.id === level.mechanics.activatedPlatform.hazardId,
                        ) ?? level.mechanics.activatedPlatform
                      }
                    />
                    <Animated.View
                      accessibilityLabel="Movable clay block"
                      style={[
                        styles.pushableCrate,
                        clayRaisedStyle(tokens, true),
                        {
                          width: level.mechanics.pushable.width * scale,
                          height: level.mechanics.pushable.height * verticalScale,
                          borderRadius: 0.45 * scale,
                          backgroundColor: '#7B858D',
                        },
                        crateStyle,
                      ]}
                    >
                      <View style={styles.blockHighlight} />
                      <View style={styles.blockFace} />
                    </Animated.View>
                  </>
                ) : null}
                <View
                  style={[
                    styles.floor,
                    {
                      top: ONLINE_FLOOR_Y * stageScale,
                      height: (ONLINE_WORLD_PIXEL_HEIGHT - ONLINE_FLOOR_Y) * stageScale,
                      backgroundColor: level.number === 3 ? '#292733' : '#8DC79B',
                    },
                  ]}
                />
                <Animated.View
                  accessibilityLabel="Ember"
                  style={[styles.player, { width: playerSize, height: playerSize }, emberStyle]}
                >
                  <Animated.View style={[styles.deathSprite, emberDeathStyle]}>
                    <ClayElementalSprite
                      role="ember"
                      tokens={tokens}
                      velocityX={emberVx}
                      velocityY={emberVy}
                      grounded={emberGrounded}
                    />
                  </Animated.View>
                </Animated.View>
                <Animated.View
                  accessibilityLabel="Tide"
                  style={[styles.player, { width: playerSize, height: playerSize }, tideStyle]}
                >
                  <Animated.View style={[styles.deathSprite, tideDeathStyle]}>
                    <ClayElementalSprite
                      role="tide"
                      tokens={tokens}
                      velocityX={tideVx}
                      velocityY={tideVy}
                      grounded={tideGrounded}
                    />
                  </Animated.View>
                </Animated.View>
              </Animated.View>
            </Animated.View>
            <GateBeacon
              role={assignedRole}
              locked={!localGateUnlocked}
              status={
                localGateUnlocked
                  ? 'OPEN'
                  : localShardsComplete
                    ? 'MECHANISM LOCK'
                    : 'SHARDS NEEDED'
              }
              atGate={localAtGate}
              tokens={tokens}
            />
            {gates.completed ? (
              <View
                style={[
                  styles.levelCompleteOverlay,
                  clayRaisedStyle(tokens),
                  { backgroundColor: tokens.success },
                ]}
              >
                <AppText kind="label" tokens={tokens}>
                  {level.number === 1
                    ? 'LEVEL 1 COMPLETE'
                    : level.number === 2
                      ? 'VAULT MASTERED'
                      : 'KEEP CONQUERED'}
                </AppText>
                <AppText kind="label" tokens={tokens}>
                  {`CLEAR TIME ${formatElementalTime(elapsedTicks)}`}
                </AppText>
                {level.number < 3 ? (
                  <AppButton
                    label={`Enter Level ${level.number + 1}`}
                    tokens={tokens}
                    onPress={() => roomRef.current?.send('advance-level')}
                  />
                ) : null}
              </View>
            ) : null}
            {localAtGate && !gates.completed ? (
              <View style={[styles.spectatorBadge, { backgroundColor: tokens.surface }]}>
                <AppText kind="label" tokens={tokens}>
                  GATE HELD · WATCHING {assignedRole === 'ember' ? 'TIDE' : 'EMBER'}
                </AppText>
              </View>
            ) : null}
          </View>
        </View>

        <ElementalControls
          tokens={tokens}
          onHorizontalChange={(value) => {
            horizontalRef.current = gameplayPausedRef.current ? 0 : value;
          }}
          onJump={() => {
            if (!gameplayPausedRef.current) jumpRef.current = true;
          }}
          onInteract={
            'mechanics' in level
              ? () => {
                  if (!gameplayPausedRef.current) interactRef.current = true;
                }
              : undefined
          }
        />
        {settingsOpen ? (
          <View
            style={[
              styles.settingsPanel,
              styles.onlineSettingsPanel,
              clayRaisedStyle(tokens),
              { backgroundColor: tokens.surface },
            ]}
          >
            <AppText kind="muted" tokens={tokens}>
              Online character assignments are locked. Only the game creator can restart the level.
            </AppText>
            <AppButton
              label="Restart level"
              variant="quiet"
              tokens={tokens}
              onPress={() => roomRef.current?.send('restart-level')}
            />
            {ELEMENTAL_AUTHORED_LEVELS.map((authoredLevel) => {
              const record = bestTicksForLevel(bestTimes, authoredLevel);
              return (
                <AppText key={authoredLevel.id} kind="muted" tokens={tokens}>
                  {`${authoredLevel.chapter} best: ${record === null ? '—' : formatElementalTime(record)}`}
                </AppText>
              );
            })}
          </View>
        ) : null}
        {status !== 'playing' ? (
          <View
            accessibilityViewIsModal
            style={[styles.partnerPauseOverlay, { backgroundColor: tokens.background }]}
          >
            <View
              style={[
                styles.partnerPauseCard,
                clayRaisedStyle(tokens),
                { backgroundColor: tokens.surface },
              ]}
            >
              <View
                style={[
                  styles.partnerPauseIcon,
                  clayInsetStyle(tokens),
                  { backgroundColor: tokens.surfaceMuted },
                ]}
              >
                <AppText kind="title" tokens={tokens} style={styles.partnerPauseGlyph}>
                  {status === 'error' ? '!' : '≈ ✦'}
                </AppText>
              </View>
              <AppText kind="title" tokens={tokens} style={styles.partnerPauseTitle}>
                {status === 'connecting'
                  ? 'Connecting to your game'
                  : status === 'waiting'
                    ? 'Waiting for your partner'
                    : status === 'reconnecting'
                      ? 'Reconnecting both players'
                      : 'Connection failed'}
              </AppText>
              <AppText kind="muted" tokens={tokens} style={styles.partnerPauseBody}>
                {status === 'waiting'
                  ? 'The level is paused. Movement resumes for both players when your partner joins.'
                  : status === 'error'
                    ? errorMessage
                    : 'The level is paused while the shared room becomes ready.'}
              </AppText>
              {status === 'error' ? (
                <AppButton label="Retry" tokens={tokens} onPress={() => void retry()} />
              ) : null}
              <AppButton
                label="Leave game"
                variant="quiet"
                tokens={tokens}
                onPress={() => navigation.goBack()}
              />
            </View>
          </View>
        ) : null}
      </View>
    </Screen>
  );
}

function SoloElementalDuetScreen({ assignedRole }: { readonly assignedRole: ElementalRole }) {
  const { tokens } = useApp();
  const [boardWidth, setBoardWidth] = useState(ELEMENTAL_VIEWPORT_WIDTH);
  const [activeRole, setActiveRole] = useState(assignedRole);
  const [tutorialStep, setTutorialStep] = useState<0 | 1 | 2 | 3 | 4 | 5>(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const role = useSharedValue<0 | 1>(assignedRole === 'ember' ? 0 : 1);
  const horizontal = useSharedValue<-1 | 0 | 1>(0);
  const jumpQueued = useSharedValue(false);

  const emberX = useSharedValue(54);
  const emberY = useSharedValue(ELEMENTAL_FLOOR_Y - ELEMENTAL_PLAYER_SIZE);
  const emberVx = useSharedValue(0);
  const emberVy = useSharedValue(0);
  const emberGrounded = useSharedValue(true);
  const tideX = useSharedValue(270);
  const tideY = useSharedValue(ELEMENTAL_FLOOR_Y - ELEMENTAL_PLAYER_SIZE);
  const tideVx = useSharedValue(0);
  const tideVy = useSharedValue(0);
  const tideGrounded = useSharedValue(true);
  const cameraZoom = useSharedValue(1);
  const reducedMotion = useReducedMotion();

  const setKeyboardHorizontal = useCallback(
    (value: -1 | 0 | 1) => {
      horizontal.set(value);
      if (value !== 0) setTutorialStep((step) => (step === 0 ? 1 : step));
    },
    [horizontal],
  );
  const queueKeyboardJump = useCallback(() => {
    jumpQueued.set(true);
  }, [jumpQueued]);
  useGameKeyboardControls({
    onHorizontalChange: setKeyboardHorizontal,
    onJump: queueKeyboardJump,
  });

  const frame = useFrameCallback(({ timeSincePreviousFrame }) => {
    'worklet';
    if (timeSincePreviousFrame === null) return;
    const input = { horizontal: horizontal.get(), jumpPressed: jumpQueued.get() };
    const idleInput = { horizontal: 0 as const, jumpPressed: false };
    const activeRole = role.get();
    jumpQueued.set(false);

    const nextEmber = stepElementalPlayer(
      {
        x: emberX.get(),
        y: emberY.get(),
        vx: emberVx.get(),
        vy: emberVy.get(),
        grounded: emberGrounded.get(),
      },
      activeRole === 0 ? input : idleInput,
      timeSincePreviousFrame / 1000,
    );
    emberX.set(nextEmber.x);
    emberY.set(nextEmber.y);
    emberVx.set(nextEmber.vx);
    emberVy.set(nextEmber.vy);
    emberGrounded.set(nextEmber.grounded);

    const nextTide = stepElementalPlayer(
      {
        x: tideX.get(),
        y: tideY.get(),
        vx: tideVx.get(),
        vy: tideVy.get(),
        grounded: tideGrounded.get(),
      },
      activeRole === 1 ? input : idleInput,
      timeSincePreviousFrame / 1000,
    );
    tideX.set(nextTide.x);
    tideY.set(nextTide.y);
    tideVx.set(nextTide.vx);
    tideVy.set(nextTide.vy);
    tideGrounded.set(nextTide.grounded);
  });

  useFocusEffect(
    useCallback(() => {
      frame.setActive(true);
      return () => frame.setActive(false);
    }, [frame]),
  );

  const scale = elementalStageScale(boardWidth);
  const renderedWorldWidth = ELEMENTAL_WORLD_WIDTH * scale;
  const soloCameraPanStyle = useAnimatedStyle(() => {
    const zoom = cameraZoom.get();
    const worldHeight = ELEMENTAL_WORLD_HEIGHT * scale;
    const activeX = role.get() === 0 ? emberX.get() : tideX.get();
    const camera = elementalCameraOffset(activeX, scale, boardWidth, renderedWorldWidth);
    const wideZoom = elementalSpectatorZoom(boardWidth, renderedWorldWidth);
    const progress = Math.max(0, Math.min(1, (1 - zoom) / Math.max(0.001, 1 - wideZoom)));
    const centeredX = (boardWidth - renderedWorldWidth * zoom) / 2;
    const centeredY = (worldHeight - worldHeight * zoom) / 2;
    return {
      transform: [
        { translateX: -camera * (1 - progress) + centeredX * progress },
        { translateY: centeredY * progress },
      ],
    };
  });
  const soloCameraZoomStyle = useAnimatedStyle(() => {
    return { transform: [{ scale: cameraZoom.get() }] };
  });
  const emberStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: emberX.get() * scale }, { translateY: emberY.get() * scale }],
  }));
  const tideStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tideX.get() * scale }, { translateY: tideY.get() * scale }],
  }));

  const reset = () => {
    horizontal.set(0);
    jumpQueued.set(false);
    emberX.set(54);
    emberY.set(ELEMENTAL_FLOOR_Y - ELEMENTAL_PLAYER_SIZE);
    emberVx.set(0);
    emberVy.set(0);
    emberGrounded.set(true);
    tideX.set(270);
    tideY.set(ELEMENTAL_FLOOR_Y - ELEMENTAL_PLAYER_SIZE);
    tideVx.set(0);
    tideVy.set(0);
    tideGrounded.set(true);
    cameraZoom.set(1);
  };

  const switchPreviewRole = () => {
    const nextRole = activeRole === 'ember' ? 'tide' : 'ember';
    horizontal.set(0);
    role.set(nextRole === 'ember' ? 0 : 1);
    setActiveRole(nextRole);
    setTutorialStep((step) => (step === 3 ? 4 : step));
  };

  const completeTutorial = useCallback(() => {
    setTutorialStep((step) => (step === 4 ? 5 : step));
  }, []);

  const completePlatformLesson = useCallback(() => {
    setTutorialStep((step) => (step === 1 ? 2 : step));
  }, []);

  const completeFirstGateLesson = useCallback(() => {
    setTutorialStep((step) => (step === 2 ? 3 : step));
  }, []);

  useAnimatedReaction(
    () => {
      return role.get() === 0
        ? isElementalPlayerOnPlatform({
            x: emberX.get(),
            y: emberY.get(),
            vx: emberVx.get(),
            vy: emberVy.get(),
            grounded: emberGrounded.get(),
          })
        : isElementalPlayerOnPlatform({
            x: tideX.get(),
            y: tideY.get(),
            vx: tideVx.get(),
            vy: tideVy.get(),
            grounded: tideGrounded.get(),
          });
    },
    (landedOnPlatform, wasOnPlatform) => {
      if (landedOnPlatform && !wasOnPlatform) scheduleOnRN(completePlatformLesson);
    },
    [completePlatformLesson],
  );

  useAnimatedReaction(
    () => {
      const activeRole = role.get();
      return activeRole === 0
        ? isElementalPlayerAtGate('ember', { x: emberX.get(), y: emberY.get() })
        : isElementalPlayerAtGate('tide', { x: tideX.get(), y: tideY.get() });
    },
    (reachedGate, wasAtGate) => {
      cameraZoom.set(
        withTiming(reachedGate ? elementalSpectatorZoom(boardWidth, renderedWorldWidth) : 1, {
          duration: reducedMotion ? 0 : 280,
          easing: Easing.bezier(0.77, 0, 0.175, 1),
        }),
      );
      if (reachedGate && !wasAtGate) scheduleOnRN(completeFirstGateLesson);
    },
    [boardWidth, completeFirstGateLesson, reducedMotion, renderedWorldWidth],
  );

  useAnimatedReaction(
    () =>
      isElementalPlayerAtGate('ember', { x: emberX.get(), y: emberY.get() }) &&
      isElementalPlayerAtGate('tide', { x: tideX.get(), y: tideY.get() }),
    (bothAtGates, wereBothAtGates) => {
      if (bothAtGates && !wereBothAtGates) scheduleOnRN(completeTutorial);
    },
    [completeTutorial],
  );

  const replayTutorial = () => {
    reset();
    role.set(assignedRole === 'ember' ? 0 : 1);
    setActiveRole(assignedRole);
    setTutorialStep(0);
  };

  const playerSize = ELEMENTAL_PLAYER_SIZE * scale;

  return (
    <Screen tokens={tokens} topInset={false} horizontalPadding={false}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.intro}>
          <View style={[styles.prototypeBadge, { backgroundColor: tokens.warning }]}>
            <AppText kind="label" tokens={tokens}>
              TRAINING GROVE
            </AppText>
          </View>
          <AppText kind="muted" tokens={tokens}>
            Guide {activeRole === 'ember' ? 'Ember' : 'Tide'} through the grove. Fire welcomes
            Ember, water welcomes Tide, and both spirits belong at their matching gates.
          </AppText>
        </View>

        <TutorialCoach
          step={tutorialStep}
          activeRole={activeRole}
          tokens={tokens}
          onSwitchRole={switchPreviewRole}
          onReplay={replayTutorial}
        />

        <View
          style={[styles.stageShell, clayRaisedStyle(tokens), { backgroundColor: tokens.surface }]}
        >
          <View
            accessibilityLabel="Ember and Tide training grove"
            style={[styles.stage, clayInsetStyle(tokens), { backgroundColor: tokens.surfaceMuted }]}
            onLayout={(event) => setBoardWidth(event.nativeEvent.layout.width)}
          >
            <Animated.View style={[styles.cameraPan, soloCameraPanStyle]}>
              <Animated.View
                style={[
                  styles.world,
                  {
                    width: renderedWorldWidth,
                    height: ELEMENTAL_WORLD_HEIGHT * scale,
                  },
                  soloCameraZoomStyle,
                ]}
              >
                <ElementalBackdrop tokens={tokens} width={renderedWorldWidth} scale={scale} />
                <Portal
                  role="ember"
                  tokens={tokens}
                  scale={scale}
                  style={{
                    left: ELEMENTAL_GATES.ember.x * scale,
                    top: ELEMENTAL_GATES.ember.y * scale,
                    width: ELEMENTAL_GATES.ember.width * scale,
                    height: ELEMENTAL_GATES.ember.height * scale,
                  }}
                />
                <Portal
                  role="tide"
                  tokens={tokens}
                  scale={scale}
                  style={{
                    left: ELEMENTAL_GATES.tide.x * scale,
                    top: ELEMENTAL_GATES.tide.y * scale,
                    width: ELEMENTAL_GATES.tide.width * scale,
                    height: ELEMENTAL_GATES.tide.height * scale,
                  }}
                />
                {ELEMENTAL_PLATFORMS.map((platform, index) => (
                  <View
                    key={platform.x}
                    style={[
                      styles.platform,
                      clayRaisedStyle(tokens, true),
                      {
                        left: platform.x * scale,
                        top: platform.y * scale,
                        width: platform.width * scale,
                        height: platform.height * scale,
                        backgroundColor: index === 1 ? '#B99BDA' : '#E6BC72',
                      },
                    ]}
                  />
                ))}
                <View
                  style={[
                    styles.hazard,
                    {
                      left: 286 * scale,
                      top: ELEMENTAL_FLOOR_Y * scale,
                      width: 42 * scale,
                      height: 9 * scale,
                      borderTopLeftRadius: 8 * scale,
                      borderTopRightRadius: 8 * scale,
                      backgroundColor: '#EE886F',
                    },
                  ]}
                />
                <View
                  style={[
                    styles.hazard,
                    {
                      left: 454 * scale,
                      top: ELEMENTAL_FLOOR_Y * scale,
                      width: 42 * scale,
                      height: 9 * scale,
                      borderTopLeftRadius: 8 * scale,
                      borderTopRightRadius: 8 * scale,
                      backgroundColor: '#63BCE0',
                    },
                  ]}
                />
                <View
                  style={[
                    styles.floor,
                    {
                      top: ELEMENTAL_FLOOR_Y * scale,
                      height: (ELEMENTAL_WORLD_HEIGHT - ELEMENTAL_FLOOR_Y) * scale,
                      backgroundColor: '#8DC79B',
                    },
                  ]}
                />
                <Animated.View
                  accessibilityLabel="Ember"
                  style={[styles.player, { width: playerSize, height: playerSize }, emberStyle]}
                >
                  <ClayElementalSprite
                    role="ember"
                    tokens={tokens}
                    velocityX={emberVx}
                    velocityY={emberVy}
                    grounded={emberGrounded}
                  />
                </Animated.View>
                <Animated.View
                  accessibilityLabel="Tide"
                  style={[styles.player, { width: playerSize, height: playerSize }, tideStyle]}
                >
                  <ClayElementalSprite
                    role="tide"
                    tokens={tokens}
                    velocityX={tideVx}
                    velocityY={tideVy}
                    grounded={tideGrounded}
                  />
                </Animated.View>
              </Animated.View>
            </Animated.View>
          </View>
        </View>

        <View style={styles.assignmentRow}>
          <View style={[styles.assignment, { backgroundColor: tokens.surface }]}>
            <AppText kind="label" tokens={tokens}>
              PREVIEW CHARACTER
            </AppText>
            <AppText kind="body" tokens={tokens} style={styles.controlLabel}>
              {activeRole === 'ember' ? 'Ember' : 'Tide'}
            </AppText>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Preview settings"
            accessibilityState={{ expanded: settingsOpen }}
            onPress={() => setSettingsOpen((open) => !open)}
            style={({ pressed }) => [
              styles.settingsButton,
              pressed ? clayPressedStyle(tokens) : clayRaisedStyle(tokens),
              { backgroundColor: tokens.surface },
            ]}
          >
            <AppText kind="title" tokens={tokens} style={styles.settingsIcon}>
              ⚙︎
            </AppText>
          </Pressable>
        </View>

        {settingsOpen ? (
          <View
            style={[
              styles.settingsPanel,
              clayRaisedStyle(tokens),
              { backgroundColor: tokens.surface },
            ]}
          >
            <View style={styles.settingsCopy}>
              <AppText kind="label" tokens={tokens}>
                PLAYGROUND SETTINGS
              </AppText>
              <AppText kind="muted" tokens={tokens}>
                Character switching is available only in this local preview.
              </AppText>
            </View>
            <AppButton label="Restart level" variant="quiet" tokens={tokens} onPress={reset} />
            <AppButton
              label={`Switch preview to ${activeRole === 'ember' ? 'Tide' : 'Ember'}`}
              variant="quiet"
              tokens={tokens}
              onPress={switchPreviewRole}
            />
          </View>
        ) : null}

        <ElementalControls
          tokens={tokens}
          onHorizontalChange={(value) => {
            horizontal.set(value);
            if (value !== 0) setTutorialStep((step) => (step === 0 ? 1 : step));
          }}
          onJump={() => {
            jumpQueued.set(true);
          }}
        />
      </ScrollView>
    </Screen>
  );
}

function TutorialCoach({
  step,
  activeRole,
  tokens,
  onSwitchRole,
  onReplay,
}: {
  readonly step: 0 | 1 | 2 | 3 | 4 | 5;
  readonly activeRole: ElementalRole;
  readonly tokens: ReturnType<typeof useApp>['tokens'];
  readonly onSwitchRole: () => void;
  readonly onReplay: () => void;
}) {
  const lessons = [
    {
      icon: '↔',
      eyebrow: 'STEP 1 OF 5',
      title: 'Move through the grove',
      body: 'Hold either arrow to walk.',
    },
    {
      icon: '↑',
      eyebrow: 'STEP 2 OF 5',
      title: 'Land on the center ledge',
      body: 'Move toward the low platform and tap up. The lesson advances when you land.',
    },
    {
      icon: activeRole === 'ember' ? '✦' : '≈',
      eyebrow: 'STEP 3 OF 5',
      title: `Park ${activeRole === 'ember' ? 'Ember' : 'Tide'} at their gate`,
      body: `Guide ${activeRole === 'ember' ? 'Ember left' : 'Tide right'} into the matching ground-level portal. Leave them there for your partner.`,
    },
    {
      icon: '⇄',
      eyebrow: 'STEP 4 OF 5',
      title: 'Hand control to your partner',
      body: `Switch to ${activeRole === 'ember' ? 'Tide' : 'Ember'}. In a real match, your partner controls that spirit on their phone.`,
    },
    {
      icon: activeRole === 'ember' ? '✦' : '≈',
      eyebrow: 'STEP 5 OF 5',
      title: `Bring ${activeRole === 'ember' ? 'Ember' : 'Tide'} home too`,
      body: `Reach the remaining gate without moving the spirit already parked. The level clears only when both gates are occupied together.`,
    },
  ] as const;
  const lesson = lessons[step === 5 ? 4 : step] ?? lessons[0]!;
  const complete = step === 5;

  return (
    <View
      accessibilityLiveRegion="polite"
      style={[
        styles.tutorialCard,
        clayRaisedStyle(tokens),
        { backgroundColor: complete ? tokens.success : tokens.surface },
      ]}
    >
      <View
        style={[
          styles.tutorialIcon,
          { backgroundColor: complete ? tokens.surface : tokens.primary },
        ]}
      >
        <AppText kind="title" tokens={tokens} style={styles.tutorialIconText}>
          {complete ? '✓' : lesson.icon}
        </AppText>
      </View>
      <View style={styles.tutorialCopy}>
        <AppText kind="label" tokens={tokens}>
          {complete ? 'TUTORIAL COMPLETE' : lesson.eyebrow}
        </AppText>
        <AppText kind="title" tokens={tokens} style={styles.tutorialTitle}>
          {complete ? 'The grove is open' : lesson.title}
        </AppText>
        <AppText kind="muted" tokens={tokens}>
          {complete
            ? 'Ember and Tide are both home. Online, each partner controls one spirit and the server clears the level only when both gates are occupied.'
            : lesson.body}
        </AppText>
        <View style={styles.tutorialProgress} accessibilityLabel={`${Math.min(step + 1, 5)} of 5`}>
          {[0, 1, 2, 3, 4].map((index) => (
            <View
              key={index}
              style={[
                styles.tutorialDot,
                { backgroundColor: index <= step ? tokens.primaryStrong : tokens.border },
              ]}
            />
          ))}
        </View>
        {step === 3 ? (
          <AppButton
            label={`Switch to ${activeRole === 'ember' ? 'Tide' : 'Ember'}`}
            tokens={tokens}
            onPress={onSwitchRole}
          />
        ) : null}
        {complete ? (
          <AppButton
            label="Play the tutorial again"
            variant="quiet"
            tokens={tokens}
            onPress={onReplay}
          />
        ) : null}
      </View>
    </View>
  );
}

function GateProgress({
  emberAtGate,
  tideAtGate,
  completed,
  collectedCrystalMask,
  emberGateUnlocked,
  tideGateUnlocked,
  level,
  leverActivated,
  buttonPressed,
  tokens,
}: {
  readonly emberAtGate: boolean;
  readonly tideAtGate: boolean;
  readonly completed: boolean;
  readonly collectedCrystalMask: number;
  readonly emberGateUnlocked: boolean;
  readonly tideGateUnlocked: boolean;
  readonly level: ElementalLevel;
  readonly leverActivated: boolean;
  readonly buttonPressed: boolean;
  readonly tokens: ReturnType<typeof useApp>['tokens'];
}) {
  const emberMask = elementalCrystalMaskForRole('ember', level);
  const tideMask = elementalCrystalMaskForRole('tide', level);
  const emberCrystals = countCollectedElementalCrystals(collectedCrystalMask & emberMask);
  const tideCrystals = countCollectedElementalCrystals(collectedCrystalMask & tideMask);
  const emberCrystalTotal = level.crystals.filter((crystal) => crystal.role === 'ember').length;
  const tideCrystalTotal = level.crystals.filter((crystal) => crystal.role === 'tide').length;
  const shardsComplete = emberCrystals === emberCrystalTotal && tideCrystals === tideCrystalTotal;
  const objective = completed
    ? 'Level complete'
    : !shardsComplete
      ? 'Collect the remaining shards'
      : 'mechanics' in level && !leverActivated
        ? 'Pull the vault lever'
        : 'mechanics' in level && !buttonPressed
          ? 'Hold the floor switch'
          : 'Bring both spirits home';
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[
        styles.gateProgress,
        clayRaisedStyle(tokens),
        { backgroundColor: completed ? tokens.success : tokens.surface },
      ]}
    >
      <View style={styles.gateProgressCopy}>
        <AppText kind="label" tokens={tokens}>
          {completed ? 'LEVEL COMPLETE' : 'LIVE CO-OP GOAL'}
        </AppText>
        <AppText kind="title" tokens={tokens} style={styles.gateProgressTitle} numberOfLines={1}>
          {objective}
        </AppText>
      </View>
      <View style={styles.gateChips}>
        <View
          style={[
            styles.gateChip,
            {
              backgroundColor:
                emberAtGate || completed || emberGateUnlocked
                  ? tokens.warning
                  : tokens.surfaceMuted,
            },
          ]}
        >
          <AppText kind="label" tokens={tokens}>
            {`✦ EMBER ${emberCrystals}/${emberCrystalTotal} · ${
              emberAtGate || completed ? 'HOME' : emberGateUnlocked ? 'OPEN' : 'LOCKED'
            }`}
          </AppText>
        </View>
        <View
          style={[
            styles.gateChip,
            {
              backgroundColor:
                tideAtGate || completed || tideGateUnlocked ? tokens.primary : tokens.surfaceMuted,
            },
          ]}
        >
          <AppText kind="label" tokens={tokens}>
            {`≈ TIDE ${tideCrystals}/${tideCrystalTotal} · ${
              tideAtGate || completed ? 'HOME' : tideGateUnlocked ? 'OPEN' : 'LOCKED'
            }`}
          </AppText>
        </View>
      </View>
    </View>
  );
}

function GateBeacon({
  role,
  locked,
  status,
  atGate,
  tokens,
}: {
  readonly role: ElementalRole;
  readonly locked: boolean;
  readonly status: string;
  readonly atGate: boolean;
  readonly tokens: ReturnType<typeof useApp>['tokens'];
}) {
  if (atGate) return null;
  const ember = role === 'ember';
  return (
    <View
      pointerEvents="none"
      accessible
      accessibilityLabel={`${role} gate is ${ember ? 'to the left' : 'to the right'} and ${locked ? 'locked' : 'open'}`}
      style={[
        styles.gateBeacon,
        ember ? styles.gateBeaconLeft : styles.gateBeaconRight,
        clayRaisedStyle(tokens, true),
        { backgroundColor: ember ? '#F7CB8E' : '#9CD9EA' },
      ]}
    >
      <AppText kind="label" tokens={tokens} style={styles.gateBeaconText}>
        {ember ? '←  ✦ GATE' : 'GATE ≈  →'}
      </AppText>
      <AppText kind="label" tokens={tokens} style={styles.gateBeaconState}>
        {status}
      </AppText>
    </View>
  );
}

function ElementalControls({
  tokens,
  onHorizontalChange,
  onJump,
  onInteract,
}: {
  readonly tokens: ReturnType<typeof useApp>['tokens'];
  readonly onHorizontalChange: (value: -1 | 0 | 1) => void;
  readonly onJump: () => void;
  readonly onInteract?: () => void;
}) {
  const leftHeld = useRef(false);
  const rightHeld = useRef(false);
  const leftScale = useSharedValue(1);
  const rightScale = useSharedValue(1);
  const jumpScale = useSharedValue(1);
  const interactScale = useSharedValue(1);
  const reducedMotion = useReducedMotion();

  const beginDirection = useCallback(
    (direction: -1 | 1) => {
      if (direction === -1) leftHeld.current = true;
      else rightHeld.current = true;
      onHorizontalChange(direction);
    },
    [onHorizontalChange],
  );
  const endDirection = useCallback(
    (direction: -1 | 1) => {
      if (direction === -1) leftHeld.current = false;
      else rightHeld.current = false;
      onHorizontalChange(leftHeld.current ? -1 : rightHeld.current ? 1 : 0);
    },
    [onHorizontalChange],
  );
  const triggerInteract = useCallback(() => onInteract?.(), [onInteract]);

  const gestures = useMemo(() => {
    const duration = reducedMotion ? 0 : 120;
    const left = Gesture.LongPress()
      .minDuration(0)
      .maxDistance(48)
      .shouldCancelWhenOutside(false)
      .onStart(() => {
        leftScale.set(withTiming(0.97, { duration }));
        scheduleOnRN(beginDirection, -1);
      })
      .onFinalize(() => {
        leftScale.set(withTiming(1, { duration }));
        scheduleOnRN(endDirection, -1);
      });
    const right = Gesture.LongPress()
      .minDuration(0)
      .maxDistance(48)
      .shouldCancelWhenOutside(false)
      .onStart(() => {
        rightScale.set(withTiming(0.97, { duration }));
        scheduleOnRN(beginDirection, 1);
      })
      .onFinalize(() => {
        rightScale.set(withTiming(1, { duration }));
        scheduleOnRN(endDirection, 1);
      });
    const jump = Gesture.LongPress()
      .minDuration(0)
      .maxDistance(48)
      .shouldCancelWhenOutside(false)
      .onStart(() => {
        jumpScale.set(withTiming(0.97, { duration }));
        scheduleOnRN(onJump);
      })
      .onFinalize(() => {
        jumpScale.set(withTiming(1, { duration }));
      });
    const interact = Gesture.LongPress()
      .minDuration(0)
      .maxDistance(48)
      .shouldCancelWhenOutside(false)
      .onStart(() => {
        interactScale.set(withTiming(0.97, { duration }));
        scheduleOnRN(triggerInteract);
      })
      .onFinalize(() => {
        interactScale.set(withTiming(1, { duration }));
      });

    left.simultaneousWithExternalGesture(right, jump, interact);
    right.simultaneousWithExternalGesture(left, jump, interact);
    jump.simultaneousWithExternalGesture(left, right, interact);
    interact.simultaneousWithExternalGesture(left, right, jump);
    return { left, right, jump, interact };
  }, [
    beginDirection,
    endDirection,
    interactScale,
    jumpScale,
    leftScale,
    onJump,
    reducedMotion,
    rightScale,
    triggerInteract,
  ]);

  return (
    <View style={[styles.controls, clayRaisedStyle(tokens), { backgroundColor: tokens.surface }]}>
      <View style={styles.directionControls}>
        <ControlButton
          label="←"
          accessibilityLabel="Move left"
          tokens={tokens}
          gesture={gestures.left}
          scale={leftScale}
        />
        <ControlButton
          label="→"
          accessibilityLabel="Move right"
          tokens={tokens}
          gesture={gestures.right}
          scale={rightScale}
        />
      </View>
      <View style={styles.actionControls}>
        {onInteract ? (
          <ControlButton
            label="✦"
            accessibilityLabel="Use lever"
            tokens={tokens}
            gesture={gestures.interact}
            scale={interactScale}
          />
        ) : null}
        <ControlButton
          label="↑"
          accessibilityLabel="Jump"
          tokens={tokens}
          gesture={gestures.jump}
          scale={jumpScale}
        />
      </View>
    </View>
  );
}

function ControlButton({
  label,
  accessibilityLabel,
  tokens,
  gesture,
  scale,
}: {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly tokens: ReturnType<typeof useApp>['tokens'];
  readonly gesture: GestureType;
  readonly scale: SharedValue<number>;
}) {
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.get() }],
  }));
  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        accessible
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={[
          styles.control,
          clayRaisedStyle(tokens),
          { backgroundColor: tokens.primary },
          animatedStyle,
        ]}
      >
        <AppText kind="title" tokens={tokens} style={styles.controlLabel}>
          {label}
        </AppText>
      </Animated.View>
    </GestureDetector>
  );
}

function ElementalBackdrop({
  tokens,
  width,
  scale,
}: {
  readonly tokens: ReturnType<typeof useApp>['tokens'];
  readonly width: number;
  readonly scale: number;
}) {
  return (
    <View
      accessible={false}
      style={[styles.backdrop, { width, backgroundColor: tokens.surfaceMuted }]}
    >
      <View
        style={[
          styles.sun,
          {
            left: 252 * scale,
            top: 22 * scale,
            width: 42 * scale,
            height: 42 * scale,
            borderRadius: 21 * scale,
          },
        ]}
      />
      {[70, 350, 650, 930, 1160].map((x, index) => (
        <View
          key={x}
          style={[
            styles.cloud,
            {
              left: x * scale,
              top: (38 + (index % 2) * 26) * scale,
              width: 74 * scale,
              height: 20 * scale,
              borderRadius: 12 * scale,
            },
          ]}
        >
          <View
            style={[
              styles.cloudPuff,
              {
                width: 30 * scale,
                height: 30 * scale,
                left: 13 * scale,
                top: -12 * scale,
                borderRadius: 16 * scale,
              },
            ]}
          />
          <View
            style={[
              styles.cloudPuff,
              {
                width: 24 * scale,
                height: 24 * scale,
                right: 10 * scale,
                top: -7 * scale,
                borderRadius: 13 * scale,
              },
            ]}
          />
        </View>
      ))}
      {[0, 190, 380, 570, 760, 950, 1140].map((x, index) => (
        <View
          key={x}
          style={[
            styles.distantHill,
            {
              left: x * scale,
              bottom: 20 * scale,
              width: 245 * scale,
              height: (74 + (index % 2) * 18) * scale,
              borderTopLeftRadius: 125 * scale,
              borderTopRightRadius: 125 * scale,
              backgroundColor: index % 2 ? '#B7DCC5' : '#C8E6D1',
            },
          ]}
        />
      ))}
      {[112, 402, 676, 914, 1180].map((x) => (
        <View
          key={x}
          style={[
            styles.clayTree,
            {
              left: x * scale,
              bottom: 27 * scale,
              width: 13 * scale,
              height: 55 * scale,
              borderRadius: 8 * scale,
            },
          ]}
        >
          <View
            style={[
              styles.treeCrown,
              {
                left: -17 * scale,
                top: -28 * scale,
                width: 48 * scale,
                height: 48 * scale,
                borderRadius: 24 * scale,
              },
            ]}
          />
        </View>
      ))}
    </View>
  );
}

function HazardPool({
  hazard,
  scale,
  stageScale,
}: {
  readonly hazard: {
    readonly x: number;
    readonly width: number;
    readonly safeRole: ElementalRole | 'none';
  };
  readonly scale: number;
  readonly stageScale: number;
}) {
  const { tokens } = useApp();
  const reducedMotion = useReducedMotion();
  const drift = useSharedValue(0);
  useEffect(() => {
    drift.set(
      reducedMotion
        ? 0
        : withRepeat(
            withTiming(1, {
              duration: 1_300,
              easing: Easing.bezier(0.77, 0, 0.175, 1),
            }),
            -1,
            true,
          ),
    );
    return () => drift.set(0);
  }, [drift, reducedMotion]);
  const surfaceStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: (drift.get() - 0.5) * 1.6 * stageScale },
      { translateY: (drift.get() - 0.5) * 0.45 * stageScale },
    ],
  }));
  const poolColor =
    hazard.safeRole === 'tide' ? '#083E61' : hazard.safeRole === 'ember' ? '#7A171E' : '#160D20';
  const surfaceColor =
    hazard.safeRole === 'tide' ? '#176A91' : hazard.safeRole === 'ember' ? '#A52B32' : '#7D318B';
  const symbol = hazard.safeRole === 'ember' ? '✦' : hazard.safeRole === 'tide' ? '≈' : '×  ×';
  return (
    <View
      pointerEvents="none"
      accessible
      accessibilityLabel={`${hazard.safeRole === 'none' ? 'lethal' : hazard.safeRole} poison pool`}
      style={[
        styles.elementPool,
        {
          left: hazard.x * scale,
          top: ONLINE_FLOOR_Y * stageScale - 0.5 * stageScale,
          width: hazard.width * scale,
          height: 7.5 * stageScale,
          borderBottomLeftRadius: 2 * stageScale,
          borderBottomRightRadius: 2 * stageScale,
          backgroundColor: poolColor,
          borderColor: '#291319',
        },
      ]}
    >
      <Animated.View
        style={[
          styles.poisonSurface,
          {
            height: 1.5 * stageScale,
            backgroundColor: surfaceColor,
          },
          surfaceStyle,
        ]}
      />
      <View style={styles.poisonMark}>
        <AppText
          kind="label"
          tokens={tokens}
          style={{ color: '#F7D9D7', fontSize: 8 * stageScale, lineHeight: 9 * stageScale }}
        >
          {symbol}
        </AppText>
      </View>
    </View>
  );
}

function FloorButton({
  pressed,
  scale,
  stageScale,
  x,
  width,
}: {
  readonly pressed: boolean;
  readonly scale: number;
  readonly stageScale: number;
  readonly x: number;
  readonly width: number;
}) {
  return (
    <View
      pointerEvents="none"
      accessible
      accessibilityLabel={`Floor switch ${pressed ? 'held' : 'released'}`}
      style={[
        styles.floorButton,
        {
          left: x * scale,
          top: ONLINE_FLOOR_Y * stageScale - (pressed ? 0.25 : 0.55) * scale,
          width: width * scale,
          height: (pressed ? 0.25 : 0.55) * scale,
          backgroundColor: pressed ? '#78C99A' : '#E7B95F',
        },
      ]}
    >
      <View style={[styles.floorButtonLight, { opacity: pressed ? 1 : 0.35 }]} />
    </View>
  );
}

function Lever({
  activated,
  scale,
  stageScale,
  x,
  width,
}: {
  readonly activated: boolean;
  readonly scale: number;
  readonly stageScale: number;
  readonly x: number;
  readonly width: number;
}) {
  const { tokens } = useApp();
  const progress = useSharedValue(activated ? 1 : 0);
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    progress.set(
      reducedMotion
        ? activated
          ? 1
          : 0
        : withTiming(activated ? 1 : 0, {
            duration: 180,
            easing: Easing.bezier(0.23, 1, 0.32, 1),
          }),
    );
  }, [activated, progress, reducedMotion]);
  const armStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -0.72 * scale }, { rotate: `${-42 + progress.get() * 84}deg` }],
  }));
  return (
    <View
      pointerEvents="none"
      accessible
      accessibilityLabel={`Bridge lever ${activated ? 'activated, bridge deployed' : 'ready'}`}
      style={[
        styles.leverBase,
        {
          left: x * scale,
          top: ONLINE_FLOOR_Y * stageScale - 3.6 * scale,
          width: width * scale,
          height: 3.6 * scale,
        },
      ]}
    >
      <View
        style={[
          styles.leverPedestal,
          {
            height: 1.05 * scale,
            borderRadius: 0.28 * scale,
            backgroundColor: activated ? '#73C897' : '#806C92',
          },
        ]}
      >
        <View
          style={[styles.leverStatus, { backgroundColor: activated ? '#ECFFF4' : '#D7C7E5' }]}
        />
        <AppText kind="label" tokens={tokens} style={styles.leverLabel}>
          {activated ? 'ON' : 'PULL'}
        </AppText>
      </View>
      <View style={[styles.leverSocket, { width: 1.15 * scale, height: 1.15 * scale }]} />
      <Animated.View
        style={[
          styles.leverArm,
          {
            width: 0.42 * scale,
            height: 2.15 * scale,
            borderRadius: 0.24 * scale,
          },
          armStyle,
        ]}
      >
        <View
          style={[
            styles.leverKnob,
            {
              width: 1.05 * scale,
              height: 1.05 * scale,
              borderRadius: 0.53 * scale,
              top: -0.38 * scale,
              left: -0.31 * scale,
            },
          ]}
        />
      </Animated.View>
    </View>
  );
}

function ClayBridge({
  active,
  scale,
  stageScale,
  hazard,
}: {
  readonly active: boolean;
  readonly scale: number;
  readonly stageScale: number;
  readonly hazard: { readonly x: number; readonly width: number };
}) {
  const progress = useSharedValue(active ? 1 : 0);
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    progress.set(
      reducedMotion
        ? active
          ? 1
          : 0
        : withTiming(active ? 1 : 0, {
            duration: 220,
            easing: Easing.bezier(0.77, 0, 0.175, 1),
          }),
    );
  }, [active, progress, reducedMotion]);
  const bridgeStyle = useAnimatedStyle(() => ({
    opacity: progress.get(),
    transform: [{ scaleX: 0.08 + progress.get() * 0.92 }],
  }));
  return (
    <Animated.View
      pointerEvents="none"
      accessible
      accessibilityLabel={`Void bridge ${active ? 'deployed' : 'retracted'}`}
      style={[
        styles.clayBridge,
        {
          left: hazard.x * scale,
          top: ONLINE_FLOOR_Y * stageScale - 0.48 * scale,
          width: hazard.width * scale,
          height: 0.48 * scale,
        },
        bridgeStyle,
      ]}
    >
      <View style={styles.bridgeHighlight} />
    </Animated.View>
  );
}

function LevelCrystal({
  role,
  collected,
  scale,
  style,
}: {
  readonly role: ElementalRole;
  readonly collected: boolean;
  readonly scale: number;
  readonly style: object;
}) {
  const color = role === 'ember' ? '#F06F55' : '#4CB9E7';
  const visibility = useSharedValue(collected ? 0 : 1);
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    visibility.set(
      withTiming(collected ? 0 : 1, {
        duration: reducedMotion ? 0 : 180,
        easing: Easing.bezier(0.23, 1, 0.32, 1),
      }),
    );
  }, [collected, reducedMotion, visibility]);
  const animatedStyle = useAnimatedStyle(() => {
    const visible = visibility.get();
    return {
      opacity: visible,
      transform: [{ rotate: '45deg' }, { scale: 0.95 + visible * 0.05 }],
    };
  });
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      style={[
        styles.levelCrystalAnchor,
        {
          width: 12 * scale,
          height: 12 * scale,
        },
        style,
      ]}
    >
      <Animated.View
        style={[
          styles.levelCrystal,
          {
            width: 12 * scale,
            height: 12 * scale,
            borderRadius: 3 * scale,
            backgroundColor: color,
            borderWidth: Math.max(1, 1.4 * scale),
          },
          animatedStyle,
        ]}
      >
        <View
          style={{
            width: 3 * scale,
            height: 3 * scale,
            borderRadius: 2 * scale,
            backgroundColor: 'rgba(255,255,255,0.78)',
          }}
        />
      </Animated.View>
    </View>
  );
}

function Portal({
  role,
  locked = false,
  tokens,
  scale,
  style,
}: {
  readonly role: ElementalRole;
  readonly locked?: boolean;
  readonly tokens: ReturnType<typeof useApp>['tokens'];
  readonly scale: number;
  readonly style: object;
}) {
  const color = locked ? '#AAB6B1' : role === 'ember' ? '#F2A85E' : '#55B9DF';
  const wellColor = locked ? '#74827D' : role === 'ember' ? '#803E32' : '#286D88';
  const unlockProgress = useSharedValue(locked ? 0 : 1);
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    unlockProgress.set(
      withTiming(locked ? 0 : 1, {
        duration: reducedMotion ? 0 : 200,
        easing: Easing.bezier(0.23, 1, 0.32, 1),
      }),
    );
  }, [locked, reducedMotion, unlockProgress]);
  const glowStyle = useAnimatedStyle(() => {
    const progress = unlockProgress.get();
    return {
      opacity: 0.18 + progress * 0.68,
      transform: [{ scale: 0.95 + progress * 0.05 }],
    };
  });
  return (
    <View
      pointerEvents="none"
      accessible
      accessibilityLabel={`${role} gate, ${locked ? 'locked' : 'open'}`}
      style={[
        styles.portal,
        clayRaisedStyle(tokens, true),
        {
          backgroundColor: color,
          borderTopLeftRadius: 18 * scale,
          borderTopRightRadius: 18 * scale,
          borderBottomLeftRadius: 8 * scale,
          borderBottomRightRadius: 8 * scale,
          padding: 5 * scale,
        },
        style,
      ]}
    >
      <View
        style={[
          styles.portalCrest,
          clayRaisedStyle(tokens, true),
          {
            width: 19 * scale,
            height: 19 * scale,
            borderRadius: 10 * scale,
            top: -7 * scale,
            backgroundColor: color,
          },
        ]}
      >
        <AppText
          kind="label"
          tokens={tokens}
          style={{ fontSize: 10 * scale, lineHeight: 12 * scale }}
        >
          {role === 'ember' ? '✦' : '≈'}
        </AppText>
      </View>
      <View
        style={[
          styles.portalWell,
          clayInsetStyle(tokens),
          {
            backgroundColor: wellColor,
            borderTopLeftRadius: 13 * scale,
            borderTopRightRadius: 13 * scale,
            borderBottomLeftRadius: 5 * scale,
            borderBottomRightRadius: 5 * scale,
          },
        ]}
      >
        <Animated.View
          style={[
            styles.portalGlow,
            {
              width: 18 * scale,
              height: 28 * scale,
              borderRadius: 10 * scale,
              backgroundColor: role === 'ember' ? '#FFD27A' : '#A6E8FA',
            },
            glowStyle,
          ]}
        />
        <View style={styles.portalStatusRow}>
          {[0, 1, 2].map((dot) => (
            <View
              key={dot}
              style={{
                width: 3 * scale,
                height: 3 * scale,
                borderRadius: 2 * scale,
                backgroundColor: locked ? '#C6D0CC' : '#FFFFFF',
              }}
            />
          ))}
        </View>
      </View>
      <View
        style={[
          styles.portalFoot,
          {
            left: -3 * scale,
            right: -3 * scale,
            bottom: -4 * scale,
            height: 7 * scale,
            borderRadius: 4 * scale,
            backgroundColor: color,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: 24, paddingBottom: 40, gap: 20 },
  intro: { gap: 10 },
  onlineLayout: { flex: 1, paddingHorizontal: 14, gap: 10 },
  onlineTimeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 14,
  },
  onlineHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, zIndex: 12 },
  onlineHeaderCopy: { flex: 1, gap: 3 },
  onlineSettingsButton: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  onlineSettingsPanel: {
    position: 'absolute',
    zIndex: 20,
    top: 54,
    right: 24,
    width: 286,
  },
  prototypeBadge: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  tutorialCard: { borderRadius: 26, padding: 16, flexDirection: 'row', gap: 14 },
  tutorialIcon: {
    width: 48,
    height: 48,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tutorialIconText: { fontSize: 24, lineHeight: 28, fontWeight: '900' },
  tutorialCopy: { flex: 1, gap: 5 },
  tutorialTitle: { fontSize: 20, lineHeight: 25 },
  gateProgressTitle: { fontSize: 16, lineHeight: 20 },
  tutorialProgress: { flexDirection: 'row', gap: 6, marginTop: 5 },
  tutorialDot: { height: 6, flex: 1, borderRadius: 999 },
  gateProgress: {
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
    borderRadius: 22,
    padding: 10,
    gap: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  gateProgressCopy: { flex: 1, gap: 2 },
  gateChips: { flex: 1, gap: 7 },
  gateChip: { borderRadius: 12, paddingHorizontal: 9, paddingVertical: 6 },
  gateBeacon: {
    position: 'absolute',
    top: 10,
    zIndex: 8,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 7,
    gap: 1,
  },
  gateBeaconLeft: { left: 10, alignItems: 'flex-start' },
  gateBeaconRight: { right: 10, alignItems: 'flex-end' },
  gateBeaconText: { fontSize: 11, lineHeight: 13, fontWeight: '900' },
  gateBeaconState: { fontSize: 7, lineHeight: 9, opacity: 0.72 },
  stage: {
    width: '100%',
    aspectRatio: ELEMENTAL_VIEWPORT_WIDTH / ELEMENTAL_WORLD_HEIGHT,
    borderRadius: 23,
    overflow: 'hidden',
  },
  onlineStage: { flex: 1, aspectRatio: undefined },
  stageShell: { width: '100%', maxWidth: 420, alignSelf: 'center', borderRadius: 31, padding: 8 },
  onlineStageShell: { flexShrink: 1 },
  cameraPan: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  world: { position: 'absolute', left: 0, top: 0, transformOrigin: 'left top' },
  spectatorBadge: {
    position: 'absolute',
    top: 10,
    alignSelf: 'center',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    boxShadow: [{ offsetX: 2, offsetY: 4, blurRadius: 9, color: 'rgba(47,62,72,0.18)' }],
  },
  backdrop: { position: 'absolute', left: 0, top: 0, bottom: 0, overflow: 'hidden' },
  sun: {
    position: 'absolute',
    backgroundColor: '#F8D58A',
    boxShadow: [{ offsetX: 4, offsetY: 6, blurRadius: 12, color: 'rgba(214,159,62,0.24)' }],
  },
  cloud: { position: 'absolute', backgroundColor: 'rgba(255,255,255,0.82)' },
  cloudPuff: { position: 'absolute', backgroundColor: 'rgba(255,255,255,0.88)' },
  distantHill: { position: 'absolute' },
  authoredUndergroundZone: {
    position: 'absolute',
    overflow: 'hidden',
    backgroundColor: '#211F2B',
    borderColor: '#514B60',
    borderWidth: 2,
  },
  authoredUndergroundCourse: {
    position: 'absolute',
    left: 10,
    right: 10,
    height: 1,
    backgroundColor: 'rgba(174,163,192,0.18)',
  },
  authoredEnvironmentEntrance: {
    position: 'absolute',
    borderWidth: 4,
    borderBottomWidth: 0,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderColor: '#5A5368',
    backgroundColor: 'rgba(20,18,28,0.2)',
  },
  dungeonOutside: { position: 'absolute', left: 0, top: 0, overflow: 'hidden' },
  dungeonMoon: {
    position: 'absolute',
    width: 54,
    height: 54,
    borderRadius: 27,
    top: 38,
    left: 34,
    backgroundColor: '#EBD9A2',
    opacity: 0.84,
  },
  dungeonOutsideHill: {
    position: 'absolute',
    width: '130%',
    height: 120,
    borderTopLeftRadius: 90,
    borderTopRightRadius: 90,
    bottom: 0,
    left: '-15%',
    backgroundColor: '#516B53',
  },
  dungeonInterior: {
    position: 'absolute',
    top: 0,
    overflow: 'hidden',
    backgroundColor: '#211F2B',
    borderLeftWidth: 5,
    borderLeftColor: '#393544',
  },
  dungeonBrickCourse: {
    position: 'absolute',
    height: 1,
    backgroundColor: 'rgba(153,143,170,0.14)',
  },
  dungeonTorch: {
    position: 'absolute',
    top: 96,
    width: 5,
    height: 28,
    borderRadius: 2,
    backgroundColor: '#6E5541',
  },
  dungeonTorchFlame: {
    position: 'absolute',
    width: 13,
    height: 18,
    borderRadius: 9,
    left: -4,
    top: -12,
    backgroundColor: '#D36C3E',
    boxShadow: [{ offsetX: 0, offsetY: 2, blurRadius: 12, color: 'rgba(218,87,43,0.5)' }],
  },
  dungeonEntranceLip: {
    position: 'absolute',
    width: 12,
    backgroundColor: '#393544',
    borderTopLeftRadius: 6,
  },
  clayTree: {
    position: 'absolute',
    backgroundColor: '#997451',
    boxShadow: [{ offsetX: 3, offsetY: 4, blurRadius: 7, color: 'rgba(77,52,32,0.2)' }],
  },
  treeCrown: {
    position: 'absolute',
    backgroundColor: '#79B990',
    boxShadow: [
      { offsetX: 3, offsetY: 5, blurRadius: 9, color: 'rgba(53,116,76,0.26)' },
      {
        inset: true,
        offsetX: 4,
        offsetY: 4,
        blurRadius: 7,
        color: 'rgba(255,255,255,0.34)',
      },
    ],
  },
  floor: { position: 'absolute', left: 0, right: 0 },
  platform: {
    position: 'absolute',
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  dungeonSolid: {
    position: 'absolute',
    zIndex: 1,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(25,23,32,0.72)',
  },
  dungeonSolidHighlight: {
    position: 'absolute',
    left: 2,
    top: 2,
    right: 2,
    height: 2,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  hazard: {
    position: 'absolute',
    zIndex: 1,
  },
  elementPool: {
    position: 'absolute',
    zIndex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderBottomWidth: 1,
  },
  poisonSurface: {
    position: 'absolute',
    top: 0,
    left: '-10%',
    width: '120%',
  },
  poisonMark: {
    position: 'absolute',
    top: '28%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  floorButton: {
    position: 'absolute',
    zIndex: 3,
    borderTopLeftRadius: 999,
    borderTopRightRadius: 999,
    alignItems: 'center',
  },
  floorButtonLight: {
    width: '42%',
    height: 3,
    borderRadius: 999,
    backgroundColor: '#F9FFF8',
  },
  leverBase: {
    position: 'absolute',
    zIndex: 3,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  leverPedestal: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'flex-end',
    boxShadow: [
      { offsetX: 3, offsetY: 5, blurRadius: 8, color: 'rgba(74,52,91,0.28)' },
      { inset: true, offsetX: 2, offsetY: 2, blurRadius: 3, color: 'rgba(255,255,255,0.48)' },
      { inset: true, offsetX: -2, offsetY: -2, blurRadius: 4, color: 'rgba(78,51,92,0.2)' },
    ],
  },
  leverSocket: {
    position: 'absolute',
    bottom: '18%',
    borderRadius: 999,
    backgroundColor: '#67566F',
    boxShadow: [{ inset: true, offsetX: 2, offsetY: 2, blurRadius: 3, color: '#3F3445' }],
  },
  leverStatus: {
    position: 'absolute',
    width: 5,
    height: 5,
    top: 3,
    right: 4,
    borderRadius: 999,
  },
  leverArm: {
    position: 'absolute',
    top: '18%',
    backgroundColor: '#5E5364',
  },
  leverKnob: {
    position: 'absolute',
    backgroundColor: '#F0C66C',
    boxShadow: [{ offsetX: 1, offsetY: 2, blurRadius: 3, color: 'rgba(105,72,26,0.3)' }],
  },
  leverLabel: { fontSize: 6, lineHeight: 8, marginBottom: 1, fontWeight: '900' },
  rampFace: {
    position: 'absolute',
    left: 0,
    top: 0,
    boxShadow: [
      { inset: true, offsetX: 2, offsetY: 2, blurRadius: 4, color: 'rgba(255,255,255,0.3)' },
      { inset: true, offsetX: -2, offsetY: -2, blurRadius: 5, color: 'rgba(31,31,38,0.22)' },
    ],
  },
  rampHighlight: {
    position: 'absolute',
    top: 0,
    width: '72%',
    height: 2,
    backgroundColor: 'rgba(255,255,255,0.58)',
  },
  clayBridge: {
    position: 'absolute',
    zIndex: 1,
    borderRadius: 999,
    backgroundColor: '#B9A0D7',
    boxShadow: [
      { offsetX: 2, offsetY: 3, blurRadius: 5, color: 'rgba(76,51,94,0.32)' },
      { inset: true, offsetX: 1, offsetY: 1, blurRadius: 2, color: 'rgba(255,255,255,0.58)' },
    ],
  },
  bridgeHighlight: {
    width: '65%',
    height: 2,
    marginTop: 2,
    alignSelf: 'center',
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.65)',
  },
  pushableCrate: {
    position: 'absolute',
    left: 0,
    top: 0,
    zIndex: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  blockHighlight: {
    position: 'absolute',
    left: '12%',
    right: '12%',
    top: '10%',
    height: '18%',
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.34)',
  },
  blockFace: {
    width: '58%',
    height: '48%',
    borderRadius: 5,
    borderWidth: 2,
    borderColor: 'rgba(56,65,72,0.28)',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  levelCrystalAnchor: {
    position: 'absolute',
    zIndex: 2,
  },
  levelCrystal: {
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: 'rgba(255,255,255,0.74)',
    boxShadow: [{ offsetX: 2, offsetY: 4, blurRadius: 8, color: 'rgba(47,62,72,0.2)' }],
  },
  portal: {
    position: 'absolute',
    zIndex: 1,
  },
  portalCrest: {
    position: 'absolute',
    zIndex: 3,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
  },
  portalWell: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  portalGlow: { position: 'absolute' },
  portalStatusRow: { position: 'absolute', bottom: '12%', flexDirection: 'row', gap: 2 },
  portalFoot: { position: 'absolute', zIndex: -1 },
  player: {
    position: 'absolute',
    left: 0,
    top: 0,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  deathSprite: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' },
  partnerPauseOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 100,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  partnerPauseCard: {
    width: '100%',
    maxWidth: 380,
    borderRadius: 30,
    padding: 24,
    gap: 14,
    alignItems: 'center',
  },
  partnerPauseIcon: {
    width: 78,
    height: 78,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  partnerPauseGlyph: { fontSize: 24, lineHeight: 30 },
  partnerPauseTitle: { textAlign: 'center', fontSize: 24, lineHeight: 30 },
  partnerPauseBody: { textAlign: 'center', maxWidth: 300 },
  levelCompleteOverlay: {
    position: 'absolute',
    zIndex: 15,
    alignSelf: 'center',
    top: '34%',
    minWidth: 190,
    borderRadius: 22,
    padding: 14,
    gap: 9,
    alignItems: 'center',
  },
  assignmentRow: { flexDirection: 'row', alignItems: 'stretch', gap: 12 },
  assignment: { flex: 1, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 12, gap: 2 },
  settingsButton: { width: 58, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  settingsIcon: { fontSize: 24, lineHeight: 28 },
  settingsPanel: { borderRadius: 22, padding: 16, gap: 12 },
  settingsCopy: { gap: 3 },
  controls: {
    width: '100%',
    maxWidth: 360,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 28,
    padding: 8,
  },
  directionControls: { flexDirection: 'row', gap: 10 },
  actionControls: { flexDirection: 'row', gap: 10 },
  control: {
    width: 68,
    height: 68,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlLabel: { textAlign: 'center', fontWeight: '700' },
});
