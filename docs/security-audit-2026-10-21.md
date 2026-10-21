# ToolHound security audit and production release checklist

Reviewed 21 October 2026. **Release decision: not ready to send to customers yet.** The shared customer/admin codebase is acceptable: access must be enforced by Supabase rather than by hiding the admin link. The application has meaningful server-side controls, but its deployed authorization and production configuration need the changes below.

Scope: branch `steve/arc-dev` at baseline `bbe1073`, the public Vercel deployment, Supabase project `ayqcteloqdrlemehozzk`, deployed `order-requests` function version 23, database privileges, RLS, RPCs, triggers, Auth settings, storage inventory, dependency advisories, and local security/regression tests. Production inspection was read-only. No customer order, email, or Linear ticket was created during this audit. Local fixes and the new migration have **not** been deployed or pushed.

Follow-up: Google sign-in has been removed from the local admin and preparation pages at the owner’s request. Email magic links are now the sole displayed login method; production SMTP configuration remains outstanding.

## Findings that block release

| Finding | Impact and evidence | Resolution and status |
| --- | --- | --- |
| High: inconsistent staff authorization | Deployed Edge Function `staff()` accepts every confirmed `toolhound.com` account. The live database permits Beacon addresses and only `graham.cooper@toolhound.com`. A different ToolHound employee could call the service-role-backed request API to access customer requests, quotes, links and order PDFs even though table RLS denies them. A working account on that domain is required; this is not anonymous access. | Local fix uses a caller-authenticated RPC backed by the same database authorization rule as RLS. The migration validates the current confirmed, non-anonymous, non-deleted, non-banned user. Frontend wording and tests match Beacon plus Graham. Confirm the intended audience, then deploy migration and function together. |
| High: customer data forwarded to staging | An enabled AFTER INSERT trigger named `arc-staging-orders-submitted` forwards the label-order record to `arc-hooks.beaconsoft-staging.tools`. That record includes contact/shipping information, signature and any uploaded artwork. This destination is separate from Linear. | Decide whether to disable this trigger or replace it with an approved production integration. It remains unchanged pending that decision. Its inline webhook credential appeared in the database metadata returned during inspection; rotate it through the owning integration before production and avoid recording it in reports or source. |
| Release blocker: backend only permits localhost | Live OPTIONS request from `https://tool-hound-label-order-form.vercel.app` returned 403; `http://127.0.0.1:4175` returned 200 and that exact allowed origin. Generated links use the same setting. | Set `ORDER_APP_URL` to the approved HTTPS production origin, without a trailing slash. Verify preflight and newly generated links afterwards. Leave local development on a separate environment. No setting changed in this audit. |
| Release blocker: staff sign-in is not production-ready | Public Auth settings report Google disabled, email enabled, confirmation required, signup enabled and anonymous sign-in disabled. The dashboard still displays Google sign-in. Supabase's email UI reports custom SMTP is not configured. The Auth Site URL points to the older project-specific Vercel hostname. | Configure a working production login method: Google OAuth for Beacon and a supported login for Graham, or reliable custom SMTP for magic links. Align Site URL and exact callback URLs. Verify real staff login, rejected non-staff login, logout and session expiry. The current visible Google button cannot complete its advertised flow. |

## Hardening prepared in this branch

- `20261021204456_security_review_hardening.sql` establishes one staff rule. Its privileged helper is in the non-API `private` schema with an empty search path; the public RPC is an invoker wrapper. It trusts the verified JWT subject to look up the current account, never user-editable metadata or the old JWT email. Public/anonymous execution is denied. The unused public execute grant on the OAuth trigger function is also revoked. Apply this migration before deploying the updated Edge Function.
- `order-requests/index.ts` now asks that rule using the caller's JWT before every staff action, including PDF retrieval, list, creation, recovery, rotation and synchronization. Authorization lookup failures deny access. Public load/submit still use their separate bearer-link checks.
- The Edge Function now limits the streamed JSON body to 14,500,000 bytes before parsing, even without Content-Length, and rejects non-object JSON. This accommodates the existing 10 MB quote upload. It bounds per-request parsing; it is not a distributed rate limiter.
- All six Supabase browser script imports are pinned to version 2.118.0 with SHA-384 integrity and anonymous CORS. The previous mutable `@2` import could change without an application release.
- The Vercel script policy permits the exact hashes of the existing bootstrap scripts instead of arbitrary inline scripts. It restricts the CDN source to the pinned SDK path, adds `object-src 'none'`, sets `no-referrer`, and disables unnecessary camera, microphone and geolocation permissions. Private document/preparation routes also receive no-index and no-store headers.

These changes are local. A push of the static site alone does not apply the SQL migration or deploy the Edge Function.

## Controls verified

- Both public tables have RLS enabled. Anonymous users cannot select either table. `order_requests` has no browser-role grants or policies: that is intentional because the service backend mediates it, not a missing-policy vulnerability.
- Anonymous legacy order inserts are revoked in the live database. Staff have no direct order INSERT grant. Privileged request creation, submission, revocation, rotation and integration RPCs are not executable by `anon` or `authenticated`.
- Nine unauthenticated calls to live admin operations were rejected. A fabricated customer token was rejected. These were rejection tests without real customer credentials or writes.
- Links use a 256-bit HMAC-derived bearer token; only its SHA-256 hash is stored for validation. Tokens are carried in the URL fragment, which is not sent in the page request or Referer header. Expiry, revocation and rotation are checked by the backend/database.
- Submission is locked and transactional. Replays return the existing receipt; the database ignores supplied internal IDs/status/symbology. Local tests verify expiry, invalid tokens, regeneration, idempotency and rollback on invalid input. Linked authorizations cannot be deleted to reopen a used link.
- Customer responses expose only their prefill or receipt, not quotes, internal notes or integration credentials. Staff sessions and customer clients use separate storage behavior.
- Customer text is rendered using textContent or escaping. Uploaded vector artwork is downloaded rather than inserted as active HTML. SQL constraints bound text, image data and allowed field values. Quotes and signatures are not publicly stored: this project currently has no Supabase Storage buckets.
- Only a publishable Supabase key is present in frontend configuration. A targeted scan of tracked text files found no Linear API keys, Supabase secret keys, private keys or live payment keys. This was not a full historical credential scan.
- The six inspected deployed routes had TLS/HSTS, nosniff, frame denial and CSP headers. Their inspected HTML/config files matched the baseline working tree before fixes.
- `npm audit` reported zero known vulnerabilities in the installed dependency tree. This does not cover every Deno/npm runtime package or eliminate unknown vulnerabilities.

## Test results

- 33 backend tests pass, including local PostgreSQL migration execution, database-role permission tests, stale/forged-email rejection, disabled/unconfirmed/deleted accounts, every staff API action, bounded body parsing and integration retry behavior.
- The full browser run passed 150 tests and failed one stale error-message assertion. After updating that assertion, all 24 intake tests passed. Three additional security tests passed, including both customer forms with the new CSP and a deliberately injected inline script that the browser blocked. That is 154 unique browser tests passing across the runs.
- Edge Function bundling succeeds. `git diff --check` passes.
- Browser and backend integration suites use test doubles/local PostgreSQL, not production credentials. Production Auth, real PDF viewing under the deployed headers, and complete create → Linear → customer submit → immutable receipt still need a controlled production smoke test after configuration/deployment. Log-source inventory was inspected; this was not an incident investigation or an exhaustive log review.

## Remaining operational risks

1. The exposed Edge Function has no application-level distributed abuse limiter. Valid tokens are infeasible to guess, but repeated unauthenticated requests can consume resources. Add a limiter at the actual Supabase function endpoint or a protected gateway; a Vercel-only limit does not protect a direct Supabase URL. Verify 429 responses and avoid storing raw customer tokens or IP addresses in logs.
2. Auth redirects currently include a Vercel hostname wildcard and aliases. Restrict production redirects to the exact owned login routes; separate preview/local redirects into development configuration. Email confirmation is enabled and must remain so. Supabase also warns that leaked-password protection is disabled; enable it if password authentication remains available, and review administrative MFA.
3. Linear receives quotes, signed records and artwork. Confirm ToolHound workspace membership and attachment access with a signed-out browser before customer rollout. Key scope and signed-out attachment access were not established by this audit. Quote uploads currently request long-lived public cache control; review it against Linear's attachment access policy.
4. PNG/PDF checks validate type/size/header shapes, not malware or full content validity. Arbitrary customer SVG/PDF artwork remains downloadable by staff. Establish attachment handling/scanning appropriate to staff workflows. The server PDF renderer processes customer-controlled signature images; malformed images can fail document generation even when an order has been accepted.
5. External synchronization retries currently depend on dashboard activity or manual retry. Add monitoring/alerts and a scheduled worker if unattended delivery to Linear is required. A saved order is not proof that the downstream ticket/PDF update succeeded.
6. The dashboard identifies this Supabase organization as Free. Establish encrypted backups and test restoration, retention/deletion for customer signatures and quotes, monitoring, and availability requirements before treating it as a production system. No restore drill or load test was performed.

## Release sequence

1. Resolve staff audience, production hostname and the staging Arc webhook destination.
2. Review/apply only the new hardening migration, then deploy the rebuilt `order-requests` function. Keep `verify_jwt=false` because public bearer-link operations authenticate inside the handler; every staff action must retain caller authentication and the shared authorization RPC. Do not blindly replay all historical migrations: live version names differ from the older repository filenames.
3. Deploy the static site with the updated headers and pinned scripts. Configure `ORDER_APP_URL`, Auth Site URL, exact redirects and the selected login provider/email service.
4. Configure abuse controls, backup/recovery and integration monitoring; rotate the staging webhook credential if that integration is retained.
5. Run a controlled test using a clearly marked test customer/PDF: sign in as permitted staff, create a request, verify the correct ToolHound Linear ticket and PDF, open the customer link signed out, submit, verify one immutable order/receipt, retry submission, and verify non-staff/invalid/expired links remain denied. Test a PDF in the real browser and ensure no unintended staging system receives it.
6. Re-run Supabase Security Advisor and the unauthenticated API probes. Only then change this release decision to ready.

Reference guidance: [Supabase production checklist](https://supabase.com/docs/guides/deployment/going-into-prod), [database security advisories](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable), and [password security](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

## Environment-aware customer links — October 21 follow-up

Deployed order-requests version 25 and applied order_request_app_origin. New requests persist the validated browser Origin in app_origin; recovery and regeneration retain it. ORDER_APP_URL is now https://tool-hound-label-order-form.vercel.app, used for legacy/no-Origin requests and internal Linear links. Explicit additional origins are localhost and 127.0.0.1 on ports 4173 and 4175. The local-only button was removed. Production/local live preflights pass; an untrusted origin returns 403 and an invalid staff bearer is denied. All 36 backend tests pass, including persistence, cross-origin recovery/regeneration, idempotency and missing-Origin fallback. The separate security_review_hardening SQL migration remains unapplied; other audit findings remain open.
