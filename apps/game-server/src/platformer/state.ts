import { schema, t, type SchemaType } from '@colyseus/schema';

export const PlatformerPlayer = schema(
  {
    accountId: t.string(),
    role: t.string(),
    x: t.float32(),
    y: t.float32(),
    velocityX: t.float32(),
    velocityY: t.float32(),
    grounded: t.boolean(),
    connected: t.boolean(),
    deaths: t.uint16(),
  },
  'PlatformerPlayer',
);
export type PlatformerPlayer = SchemaType<typeof PlatformerPlayer>;

export const PlatformerState = schema(
  {
    gameSessionId: t.string(),
    tick: t.uint32(),
    elapsedTicks: t.uint32(),
    emberAtGate: t.boolean(),
    tideAtGate: t.boolean(),
    completed: t.boolean(),
    collectedCrystalMask: t.uint16(),
    currentLevel: t.uint8(),
    leverActivated: t.boolean(),
    buttonPressed: t.boolean(),
    crateX: t.float32(),
    players: t.map(PlatformerPlayer),
  },
  'PlatformerState',
);
export type PlatformerState = SchemaType<typeof PlatformerState>;
