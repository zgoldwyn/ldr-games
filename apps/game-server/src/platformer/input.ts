import { schema, t, type SchemaType } from '@colyseus/schema';

export const PlatformerInput = schema(
  {
    moveX: t.int8<-1 | 0 | 1>(),
    jump: t.boolean(),
    interact: t.boolean(),
  },
  'PlatformerInput',
);

export type PlatformerInput = SchemaType<typeof PlatformerInput>;

export const IDLE_PLATFORMER_INPUT = new PlatformerInput({
  moveX: 0,
  jump: false,
  interact: false,
});
