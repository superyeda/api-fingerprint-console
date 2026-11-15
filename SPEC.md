# API Fingerprint Console — v1.1 interfaces

Standalone Node.js 22+ / Python 3 desktop-local application. Chinese UI, localhost only. macOS launchd and Windows Task Scheduler adapters; Windows implementation/mock tests are not real-machine validation. Neither detection summaries nor HTTP notification channels require DSH or an Agent.

## Data and protection

`CONSOLE_DATA_DIR` overrides the default data directory. macOS uses `~/Library/Application Support/API Fingerprint Console/data`; Windows uses `%LOCALAPPDATA%/API Fingerprint Console/data`. The launcher installs immutable public runtime copies alongside `data`, not inside the release archive or Desktop/Documents.

Private vault combines config and model/notification credentials in one atomic file. macOS uses directory700/file600 plaintext protection. Windows serialization replaces `secrets` / `notificationSecrets` with current-user DPAPI ciphertext; static PowerShell script and stdin IPC, never plaintext command arguments. Public config and export never return actual secrets. Full Webhook URL is secret, including path/query.

## HTTP security

Bind127.0.0.1 only; Host must be localhost/127.0.0.1 and actual bound port. Exact same-origin and SameSite HttpOnly session cookie; all mutations additionally require `X-CSRF-Token`. JSON body max256KB, CSP, no directory serving/request-body logs. Error `{error:'safe static Chinese message'}`; no raw exceptions, remote responses, credentials or submitted values.

* `GET /api/session` creates session cookie and returns `{csrfToken}`.
* `GET /api/state` returns `{version,platform,config,scheduler,run,results,history,notificationAvailable,lastNotification,lastTestNotification}`.
* `platform`: `{id,name,scheduler,nativeSchedulingSupported,secretsProtection,windowsValidation}`. Windows verification caveat always honest.
* `scheduler`: `{installed,enabled,running,message,nextRunAt,runtimeOutdated?}`. Runtime mismatch is a warning, never an automatic task rewrite.
* `notificationAvailable` means credentials/capability appear configured; NOT a network/auth/delivery test.

## Model configuration and execution

* `POST /api/endpoints` / `PUT /api/endpoints/:id`: `{name,baseUrl,model,api,effort,expectedCandidateIds?,expectedCandidateNames?,enabled?}`. API URL HTTP(S), no URL credentials/query/fragment. APIs responses/chat_completions/messages; efforts low/medium/high/max.
* `DELETE /api/endpoints/:id` removes its keys and credentials.
* `POST /api/endpoints/:id/keys`: `{alias,secret?,enabled?}`. Empty credential creates disabled placeholder. `PUT /api/keys/:id` updates alias/status/secret; blank preserves. `DELETE /api/keys/:id` deletes. No retrieval endpoint; public entries include `hasSecret` only.
* `POST /api/run`: `{confirmed:true,endpointId?,keyId?}`. Confirmed paid execution only;202 accepted,409 busy,400 no valid Key. Never run detection on startup/save/import/notification test/task registration.
* Each Key has exactly3 parallel samples, Keys sequential, no automatic retries. Reference-cache failure does not request model.420s round/120s first SSE data/2h wrapper timeout. Per-Key scheduled interval dedup and OS-level whole-batch lock.
* `GET /api/reports/:reportId`: redacted summary/analysis, no raw prompts/replies.

Default target IDs gpt-6-astra and gpt-6.1-sol share the merged reference class gpt-6-astra/6.1-sol. Bank confidence is not authenticity or ability probability. Suspect alert needs two adjacent comparable suspect rounds, same candidate/config/reference version; technical failures reset. Fingerprints cannot independently prove degradation.

## Notification configuration

Public `config.notifications`:
```
{
 enabled:false,
 channel:'bark'|'webhook'|'local_command',
 allowInsecure:false,
 bark:{serverUrl:'https://api.day.app',group:'API 指纹巡检',sound:''},
 webhook:{format:'json'|'slack'|'wecom'|'dingtalk'},
 hasBarkKey:false,hasWebhookUrl:false,hasWebhookToken:false
}
```
Fresh install Bark disabled. Existing v1 `{enabled:true}` retains local_command compatibility. That channel is macOS-only and uses the preconfigured external tool; Bark/Webhook never require it.

* `POST /api/notifications`: public preferences plus `credentials:{barkDeviceKey?,webhookUrl?,webhookToken?}`, optional `clearSecrets:['barkDeviceKey'|'webhookUrl'|'webhookToken']`. Blank/omitted preserves. Clear is explicit. Return `{notifications:publicPreferences}`. Does NOT send anything. If an enabled system task uses old runtime,409 requires explicit upgrade/disable before changing notification routing.
* Bark server must be origin only, never complete keyed push link. Backend POSTs `/push`, `device_key` only in JSON. HTTPS default; HTTP only with explicit `allowInsecure:true`.
* Webhook URL remains private even if it looks harmless. Optional Bearer token header. Generic JSON includes event/title/body/text; Slack text; WeCom/DingTalk msgtype:text/text.content. No dynamic signing/timestamp implementation.
* `POST /api/notifications/test`: `{confirmed:true}`. Sends one fixed real test message through SAVED configuration, even when automatic detection notifications disabled. No model calls or report mutation. One pending test,30s process cooldown,10s HTTP deadline,no retries,no redirects. Stores separate `lastTestNotification`; never overwrite detection notification record.401/403 → authentication; other safe reason codes configuration/http_error/redirect_blocked/remote_rejected/invalid_response/network/timeout/unsupported_platform/unavailable. No raw remote error text.
* `accepted` means service accepted submission, NEVER proof of phone display. Bark success code200; WeCom/DingTalk errcode0; other Webhook2xx is submission acceptance only.
* Automatic notification formatter is bounded (~590 Unicode codepoints), per alias time/model/effort/samples/candidate/bank confidence/conclusion, with limitation. Only strict alerttrue produces continuous-anomaly alert title.

In-page route `#notification-help` contains Bark steps, placeholder-only examples, save-vs-test explanation, Webhook payload formats, privacy/migration and cross-platform details,401/403/network/TLS/timeout/redirect/accepted-but-not-displayed troubleshooting, and task-runtime update workflow. Do not put real credentials into tutorial examples, clipboard examples, DOM preload, browser storage or logs.

## Scheduling and migration

* `POST /api/settings`: `{schedule:{intervalHours,minute}}`; backwards-compatible optional `notifications:{enabled:bool}`. New notification form is separate, so schedule save never overwrites notification drafts. Intervals1/2/3/4/6/8/12/24,minute0–59.
* `POST /api/schedule/enable`: `{intervalHours,minute,legacyAcknowledged?:true}`. If external legacy marker present, acknowledgment required. Current-user native task only, no detector kickstart; task calendar may naturally fire near a scheduled instant. Used only on explicit user confirmation, including runtime update button which reuses saved schedule, not draft.
* `POST /api/schedule/disable`: `{}`; persistent disable of own task only. No DSH task access.
* Versioned runtime update never silently modifies enabled task. `runtimeOutdated` means explicit apply-current-version or disable needed; tests/tutorial remain available.
* `GET /api/export`: non-secret formatversion1; notify enabledfalse, no credential flags/values. `POST /api/import`: replaces configuration, new Key IDs, clears ALL credentials, disables Keys and notifications. Reject while native scheduling enabled or detection running. Import never sends/tests.

## Core module contracts and verification

* Store handles schema/atomic private vault/config/credential changes/results/history.
* `platform.mjs`: defaultDataDir / async pythonExecutable / platformInfo.
* Scheduler public exports LABEL/buildPlist/scheduleStatus/enableSchedule/disableSchedule; platform dispatcher preserves Mac API.
* Python wrapper supports POSIX flock and Windows nonblocking byte lock, no stale-lock deletion. Non-secret Node/data-dir paths may be explicit args; model or notification secrets never command arguments.
* `sendNotification(batch,{config,secrets,enabled,test?,message?,fetchFn?})`; production HTTP sender exact configured destination, bounded response and safe statuses. Legacy spawn injection remains for regression compatibility.
* Offline tests use temporary data, synthetic credentials and injected SDK/HTTP/system children. No real model calls, push notifications or native task installation in validation. Browser preview fixture is explicitly synthetic and excluded from release.
