// Only stable, content-free codes may cross the sandbox/worker/public API seams.
export const browserFailureCodes = new Set([
 'SITE_AUTHENTICATION_REQUIRED','SITE_CAPTCHA_REQUIRED','SITE_MFA_REQUIRED','SITE_LOGIN_UNSUPPORTED',
 'BROWSER_NAVIGATION_TIMEOUT','BROWSER_NAVIGATION_FAILED',
 'BROWSER_GATEWAY_TIMEOUT','BROWSER_GATEWAY_UNAVAILABLE','BROWSER_GATEWAY_REVOKED',
 'BROWSER_GATEWAY_REGISTRATION_REQUIRED','BROWSER_GATEWAY_REGISTRATION_TIMEOUT',
 'BROWSER_SERVICE_EXITED','REMOTE_CLI_FAILED','REMOTE_REQUEST_MISMATCH','REMOTE_RESPONSE_MISMATCH',
]);
export function browserFailureCode(error) {
 const code=/^([A-Z_]+)(?=:|$)/.exec(error?.message || '')?.[1];
 return browserFailureCodes.has(code) ? code : undefined;
}
export function remoteBrowserFailure(result) {
 let code='REMOTE_CLI_FAILED';
 try {const candidate=JSON.parse(result?.stderr?.trim()).error?.code;if(browserFailureCodes.has(candidate))code=candidate;}catch{}
 return new Error(`${code}: browser action failed`);
}
