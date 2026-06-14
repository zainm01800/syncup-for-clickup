# SyncUp for ClickUp — Security Incident Response Policy

**Owner:** Zain (founder) — responsible for executing this policy.
**Last reviewed:** June 2026

## Purpose
Defines how SyncUp detects, responds to, and recovers from security incidents
involving merchant or customer personal data (e.g. data breaches, unauthorized
access, leaked credentials/tokens, or exploited vulnerabilities).

## 1. Detection & reporting
- Monitor Vercel logs, error alerts, and database activity for anomalies.
- Log every suspected incident with the date/time, what was observed, and the
  systems involved.

## 2. Containment
- Immediately rotate or revoke any affected credentials: Shopify access tokens,
  ClickUp OAuth tokens, the database connection string, and any API keys.
- Disable the affected integration, or take the app offline, if needed to stop
  ongoing exposure.

## 3. Assessment
- Determine what data was affected, how many merchants/customers are impacted,
  and the root cause.

## 4. Notification
- Notify affected merchants without undue delay.
- Notify Shopify within 24 hours of confirming an incident that affects
  protected customer data, per the Shopify Partner Program requirements.
- Meet any applicable breach-notification laws (e.g. the GDPR 72-hour rule).

## 5. Remediation & review
- Fix the root cause, deploy the patch, and verify the issue is resolved.
- Document the incident and update controls/processes to prevent recurrence.
