export function validateTarget(value, { ci = Boolean(process.env.CI) } = {}) {
  if (!value || typeof value !== 'string') throw new Error('TARGET_REQUIRED: Set MAVEFORM_BASE_URL to an already deployed preview origin.');
  let url;
  try { url = new URL(value); } catch { throw new Error('TARGET_INVALID: The preview URL must be absolute.'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('TARGET_INVALID: Use an origin only, without credentials, path, query, or fragment.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && !ci)) {
    throw new Error('TARGET_INSECURE: CI requires HTTPS; local runs may use localhost HTTP.');
  }
  return url.origin;
}

export function validateExpectedBuildId(value, { ci = Boolean(process.env.CI) } = {}) {
  const id = value?.trim();
  if (!id) {
    if (ci) throw new Error('BUILD_ID_REQUIRED: CI requires MAVEFORM_EXPECTED_BUILD_ID for the exact preview build.');
    return null;
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) throw new Error('BUILD_ID_INVALID: Use a commit SHA or opaque identifier; no paths or branch metadata.');
  return id;
}

if (process.argv[1]?.endsWith('target.mjs')) {
  try {
    validateTarget(process.env.MAVEFORM_BASE_URL);
    const buildId = validateExpectedBuildId(process.env.MAVEFORM_EXPECTED_BUILD_ID);
    console.log(buildId ? 'Preview target and expected build ID accepted.' : 'Local target accepted. Build identity is not verified.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
