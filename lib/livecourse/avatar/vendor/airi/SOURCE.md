# AIRI Vendored VRM Runtime Sources

- Project: `moeru-ai/airi`
- Commit: `66d7ef207e8affa14f338ed89b170e989e6b31d6`
- License: MIT, included in `LICENSE`

Files vendored from `packages/stage-ui-three/` (Vue composables) and adapted to
framework-neutral classes (Vue refs/watch removed; algorithms verbatim):

| Vendored file | Upstream source |
| --- | --- |
| `lip-sync.ts` | `src/composables/vrm/lip-sync.ts` |
| `expression.ts` | `src/composables/vrm/expression.ts` |
| `interaction.ts` | `src/composables/vrm/interaction.ts` (plus `getVrmInteractionExpression`/cooldown from `stage-ui/src/components/scenes/Stage.vue`) |
| `eye-tracking.ts` | `src/composables/eye-tracking.ts` |
| `loader.ts` | `src/composables/vrm/loader.ts` |
| `eye-motions.ts` | `src/composables/vrm/utils/eye-motions.ts` |
| `lip-sync-profile.json` | `src/assets/lip-sync-profile.json` |

Blink/saccade/re-anchor logic in `../../airi-vrm-element.ts` mirrors
`src/composables/vrm/animation.ts` (same curves and constants).

Local adaptation: `lip-sync.ts` exposes its existing silence-detection result as
read-only `isSpeaking` for presentation-only arm gestures. Disconnected or
suspended audio is inactive; phoneme weights and mouth smoothing are unchanged.

Related vendored asset: `public/vendor/airi/idle_loop.vrma` (see
`public/vendor/airi/SOURCE.md`).
