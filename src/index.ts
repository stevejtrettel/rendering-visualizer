/**
 * One import for everything a demo needs:
 *
 *   import { createStage, createUI, C, matte } from '@';
 *
 * Anything more specialised comes from its own module — '@/viz/lines',
 * '@/viz/text', '@/scenes/registry', '@/trace/replay' — so this stays the
 * short list rather than a re-export of the whole renderer.
 */

export * from './viz/style';
export * from './viz/stage';
export * from './viz/capture';
export * from './viz/ui';
