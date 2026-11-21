// Accept a local content ID or a repository reference pinned by manifest digest.
// Docker remains responsible for validating repository naming and availability.
export const IMMUTABLE_CONTAINER_IMAGE = /^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9._/:-]{0,420}@sha256:[a-f0-9]{64})$/;
