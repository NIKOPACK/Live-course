# Changelog

Notable LiveCourse changes will be recorded here from the repository's first independent release.

## Unreleased

- Established the LiveCourse package namespace, runtime identifiers, documentation, and deployment configuration.
- Added the A6 multi-scope memory layer (`lib/livecourse/memory/`): three isolated scopes — classroom working memory (`classroomSessionId`), course learning memory (`learnerId + courseId`), and cross-course learner memory (`learnerId`, strict whitelist) — with typed RuntimeStore-backed repositories, a deterministic whitelist policy for learner-profile candidates, and a bounded fixed-priority teacher-context assembler (docs/spec/04 §6, 05 A6).
