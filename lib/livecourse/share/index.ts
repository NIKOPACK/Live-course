export { createCourseShare, CourseShareCreateError } from './create-client';
export {
  redeemCourseShare,
  fetchShareMetadata,
  CourseShareRedeemError,
  type ShareMetadata,
} from './redeem-client';
export {
  readShareRedeemRegistration,
  writeShareRedeemRegistration,
  clearShareRedeemRegistration,
} from './registration';
export { buildShareSnapshot } from './build-snapshot';
export { rewriteShareMaterials } from './rewrite';
export {
  bindShareMediaRefs,
  resolveShareMediaBytes,
  classifyShareMediaRef,
  collectShareDocumentRefs,
} from './media';
export { stripShareMaterials } from './strip';
export {
  COURSE_SHARE_SCHEMA_VERSION,
  SHARE_MEDIA_PREFIX,
  courseShareSnapshotSchema,
} from './schema';
