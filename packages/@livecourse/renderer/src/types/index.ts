// The slide object model is the canonical contract from @livecourse/dsl. The renderer
// no longer vendors its own copy; it re-exports the DSL types here so the public
// `@livecourse/renderer/types` surface stays intact.
export * from '@livecourse/dsl';
export * from './effects';
